import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CFG, STAGE_SKILL, STAGE_AUX_SKILL } from './config.ts';
import { STAGE_LABELS } from './stages.ts';
import { renderFooter } from './footer.ts';
import { readMessages } from './ledger.ts';
import { sha256File, readText, writeTextAtomic } from './util.ts';
import { diffStat } from './git.ts';
import { collectIntel, extractKeywords, renderIntel } from './repoIntel.ts';
import { appendEvent } from './events.ts';
import type { Ledger, Stage, TaskSpec } from './types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = join(HERE, '..');
export const PROMPTS_DIR = join(PROJECT_ROOT, 'prompts');

/** 13 块上下文的预算（字符）。顺序即优先级，trim=true 的才会被裁。 */
const BUDGET: Record<string, { max: number; trim: boolean }> = {
  主指令: { max: 9000, trim: false },
  阶段技能: { max: 12000, trim: false },
  账本快照: { max: 4000, trim: false },
  任务元数据: { max: 3000, trim: false },
  仓库规范: { max: 15000, trim: true },
  已批准方案: { max: 6000, trim: false },
  前序产物: { max: 20000, trim: true },
  代码与历史检索: { max: 24000, trim: true },
  代码改动: { max: 120000, trim: true },
  运行证据: { max: 40000, trim: true },
  人类消息: { max: 4000, trim: false },
  工作路径: { max: 2000, trim: false },
  页脚规则: { max: 2000, trim: false },
  会话历史: { max: 6000, trim: true },
};

/**
 * 总预算超限时的压缩顺序：从最不重要的一块开始。
 * 主指令/技能/账本/任务元数据/令牌/页脚永不压缩。
 */
const COMPRESS_ORDER = ['会话历史', '运行证据', '代码改动', '前序产物', '代码与历史检索', '仓库规范'];

/** 需要检索代码的阶段：诊断看现状、实现找落点、修补对报告、评审核调用方 */
const INTEL_STAGES: readonly Stage[] = ['DIAGNOSE', 'IMPLEMENT', 'PATCH', 'REVIEW'];

function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = s.slice(0, Math.floor(max * 0.72));
  const tail = s.slice(-Math.floor(max * 0.22));
  const out = `${head}\n…（此处裁剪 ${s.length - max} 字符）…\n${tail}`;
  // 兜底：裁剪说明本身也有长度，极小的 max 下裁剪结果可能反而更长
  return out.length < s.length ? out : s.slice(0, max);
}

/**
 * 上下文组装：每轮送给 Runtime 的完整内容。
 * 固定 12 块、固定顺序、固定预算；裁剪从低优先级开始，主指令/技能/账本/令牌永不裁。
 */
export function assembleContext(
  ws: string,
  l: Ledger,
  task: TaskSpec,
  stage: Stage,
  repo: string,
): { text: string; path: string } {
  const skill = STAGE_SKILL[stage] ?? '';
  const instruction = readText(join(PROMPTS_DIR, 'instructions.md'));
  const aux = STAGE_AUX_SKILL[stage] ?? [];
  const skillBody = skill
    ? [skill, ...aux]
        .map((n) => `<!-- skill: ${n} -->\n${readText(join(PROMPTS_DIR, 'skills', n, 'SKILL.md'))}`)
        .join('\n\n')
    : '（初始化阶段由引擎执行，不加载技能）';

  const ledgerView = {
    task_id: l.task_id,
    stage: l.stage,
    stage_label: STAGE_LABELS[l.stage],
    waiting: l.waiting,
    expected_token: l.expected_token,
    status: l.status,
    review_iteration: l.review_iteration,
    pending_decisions: l.pending_decisions,
    approved_decisions: l.approved_decisions,
    skills: l.skills,
    artifacts: l.artifacts,
    baseline_branch: l.baseline_branch,
  };

  const taskMeta = [
    `任务编号：${task.key}`,
    `标题：${task.title}`,
    `空间：${task.space}｜类型：${task.type}｜优先级：${task.priority}｜标签：${task.labels.join(', ')}`,
    `描述（人写的原始需求，任何时候不得修改）：`,
    task.description,
  ].join('\n');

  const conventions = [
    readText(join(repo, 'AGENTS.md')),
    readText(join(repo, 'README.md')).slice(0, 1200),
  ].filter(Boolean).join('\n\n');

  const ideaPath = join(ws, CFG.WORKSPACE_SUBDIR, 'idea.md');
  const idea = readText(ideaPath);
  const prior = ['diagnosis.md', 'findings.md', 'plan.md', 'plan-delta.md', 'review-report.md']
    .map((n) => {
      const p = join(ws, CFG.WORKSPACE_SUBDIR, n);
      return existsSync(p) ? `### ${n}\n${readText(p)}` : '';
    })
    .filter(Boolean)
    .join('\n\n');

  let diff = '（尚未产生代码改动）';
  try {
    const d = diffStat(repo, 'HEAD~1');
    diff = `${d.text}\n\n合计 ${d.files} 文件 +${d.insertions} -${d.deletions}`;
  } catch {
    /* 只有一个提交时没有 diff */
  }

  const humans = readMessages(ws)
    .filter((m) => m.role === 'human')
    .slice(-10)
    .map((m) => `- [${m.at}] ${m.text}`)
    .join('\n');

  // 代码与历史检索：只在需要看代码的阶段做，避免每轮都跑 git
  let intel = '（本阶段不需要代码检索）';
  if (INTEL_STAGES.includes(stage)) {
    try {
      const kw = extractKeywords(`${task.title}\n${task.description}`, 6);
      const collected = collectIntel(repo, kw);
      intel = renderIntel(collected);
    } catch (e) {
      intel = `（检索失败：${(e as Error).message}；不要因此断言「不存在相关代码」）`;
    }
  }

  const blocks: Array<{ key: string; body: string }> = [
    { key: '主指令', body: instruction },
    { key: '阶段技能', body: skillBody },
    { key: '账本快照', body: '```json\n' + JSON.stringify(ledgerView, null, 2) + '\n```' },
    { key: '任务元数据', body: taskMeta },
    { key: '仓库规范', body: conventions || '（无 AGENTS.md）' },
    { key: '已批准方案', body: idea || '（尚未生成方案）' },
    { key: '前序产物', body: prior || '（无）' },
    { key: '代码与历史检索', body: intel },
    { key: '代码改动', body: diff },
    { key: '运行证据', body: `测试命令：${task.test_cmd}` },
    { key: '人类消息', body: humans || '（无）' },
    {
      // 真实 CLI 的 cwd 是仓库，产物却要写到工作区；不给绝对路径，模型就会把
      // diagnosis.md / idea.md 写进仓库根目录（实测发生过，且被 commit 污染了提交）。
      key: '工作路径',
      body: [
        `- 任务工作区（产物写这里）：${ws}`,
        `- 产物目录：${join(ws, '.xwing-task', 'lattice')}`,
        `- 修复仓库（改代码、git 提交都在这里）：${repo}`,
        '以上是绝对路径。不要用相对路径猜位置；产物不要写进仓库目录。',
      ].join('\n'),
    },
    {
      key: '页脚规则',
      body: [
        '页脚由引擎生成，你不要自己拼。当前页脚：',
        renderFooter(l),
        `idea.md 哈希：${existsSync(ideaPath) ? sha256File(ideaPath).slice(0, 12) : 'NA'}`,
      ].join('\n'),
    },
    {
      key: '会话历史',
      body: l.history.slice(-10).map((h) => `- ${h.at} ${h.from ?? '∅'} → ${h.to}：${h.reason}`).join('\n') || '（无）',
    },
  ];

  const parts = blocks.map((b) => {
    const bud = BUDGET[b.key];
    const body = bud?.trim ? clip(b.body, bud.max) : b.body;
    return `<!-- block:${b.key} -->\n${body}`;
  });

  // 总预算：单块不超自身预算，不代表总和可控。
  // 超 MAX_CONTEXT_CHARS 时按 COMPRESS_ORDER 依次压缩，并留 context_trim 事件供归因。
  let total = parts.reduce((n, p) => n + p.length, 0);
  const compressed: string[] = [];
  for (const key of COMPRESS_ORDER) {
    if (total <= CFG.MAX_CONTEXT_CHARS) break;
    const i = parts.findIndex((p) => p.startsWith(`<!-- block:${key} -->`));
    if (i < 0) continue;
    const before = parts[i].length;
    const keep = Math.max(1200, Math.floor(BUDGET[key].max * 0.3));
    // 本来就比目标还短，压它只会加一行说明、反而变长
    if (before <= keep) continue;
    const shrunk =
      `<!-- block:${key} -->\n（总上下文超 ${CFG.MAX_CONTEXT_CHARS} 字符，本块压到 ${keep} 字符）\n` +
      clip(parts[i], keep);
    if (shrunk.length >= before) continue;
    parts[i] = shrunk;
    total -= before - shrunk.length;
    compressed.push(`${key}:${before}→${shrunk.length}`);
  }
  if (compressed.length > 0) {
    appendEvent(ws, {
      kind: 'context_trim',
      stage,
      actor: 'engine',
      reason: `总长超 ${CFG.MAX_CONTEXT_CHARS}，压缩 ${compressed.length} 块`,
      detail: { compressed, total },
    });
  }

  const text = `# 本轮上下文（阶段 ${stage} / ${STAGE_LABELS[stage]}）\n\n${parts.join('\n\n---\n\n')}\n`;
  const path = join(ws, CFG.WORKSPACE_SUBDIR, `prompt-${stage}.md`);
  writeTextAtomic(path, text);
  return { text, path };
}
