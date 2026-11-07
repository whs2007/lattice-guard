import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { CFG } from '../config.ts';
import { ModelError, ToolError } from '../errors.ts';
import { ensureDir, nowIso, readText, sleep, writeTextAtomic } from '../util.ts';
import { diffStat, hasChanges, commitAll, mustGit } from '../git.ts';
import { artifactSpec } from '../artifacts.ts';
import { fileHistory, searchCode } from '../repoIntel.ts';
import type { Ledger, PatchOp, Stage, StageEvent } from '../types.ts';
import type { Runtime, RuntimeCtx } from './types.ts';

const TICK = Number(process.env.HIFOX_TICK_MS ?? 320);

function art(ws: string, name: string): string {
  const spec = artifactSpec(name);
  return join(ws, spec ? spec.path : `${CFG.WORKSPACE_SUBDIR}/${name}`);
}

function writeArt(ctx: RuntimeCtx, name: string, body: string): void {
  const p = art(ctx.ws, name);
  ensureDir(join(p, '..'));
  writeTextAtomic(p, body.trim() + '\n');
}

function applyOps(ctx: RuntimeCtx, phase: 'implement' | 'patch'): string[] {
  const ops = (ctx.task.patch_ops ?? []).filter((o: PatchOp) => (o.phase ?? 'implement') === phase);
  const touched: string[] = [];
  for (const op of ops) {
    const p = join(ctx.repo, op.file);
    const text = readText(p);
    if (!text.includes(op.find)) {
      throw new ToolError(`补丁落点不存在：${op.file} 中找不到 ${op.find.slice(0, 40)}`);
    }
    writeTextAtomic(p, text.replace(op.find, op.replace));
    touched.push(op.file);
  }
  return [...new Set(touched)];
}

/* ------------------------- 仓库事实（用来代替编造） ------------------------- */

/**
 * Mock 也必须只引用真实存在的东西。
 * 之前产物里写着 `src/cart.js` 与「滚动高度差 312px」，而仓库里根本没有这个文件、
 * 也没有这个测量 —— 产物校验器只看段落标题，看不出内容是假的。
 * 这里把「文件、行号、符号、历史、调用点」全部从仓库里查出来。
 */
interface Fact {
  mainFile: string;
  fnName: string;
  anchor: { file: string; line: number; text: string } | null;
  callSites: Array<{ file: string; line: number; text: string }>;
  history: string;
  testFiles: string[];
}

function firstExportName(repo: string, file: string): string {
  const text = readText(join(repo, file));
  const m = text.match(/export\s+(?:async\s+)?function\s+(\w+)/) ?? text.match(/export\s+const\s+(\w+)/);
  return m?.[1] ?? '';
}

function locate(repo: string, file: string, needle: string): Fact['anchor'] {
  if (!file || !needle) return null;
  const lines = readText(join(repo, file)).split('\n');
  const i = lines.findIndex((l) => l.includes(needle.trim()));
  return i >= 0 ? { file, line: i + 1, text: lines[i].trim() } : null;
}

function listTests(repo: string): string[] {
  const dir = join(repo, 'test');
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => /\.(m?js|ts|py|go)$/.test(f))
      .sort()
      .map((f) => `test/${f}`);
  } catch {
    return [];
  }
}

function fact(ctx: RuntimeCtx): Fact {
  const op = ctx.task.patch_ops?.[0];
  const mainFile = op?.file ?? '';
  const fnName = mainFile ? firstExportName(ctx.repo, mainFile) : '';
  const anchor = locate(ctx.repo, mainFile, (op?.find ?? '').split('\n')[0]);

  const rawSites = fnName ? searchCode(ctx.repo, fnName, { maxHits: 20 }) : [];
  // 定义行 + 测试引用都算调用点；去掉注释与空行
  const callSites = rawSites.filter((s) => {
    const t = s.text.trim();
    return t && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
  });

  return {
    mainFile,
    fnName,
    anchor,
    callSites,
    history: mainFile ? fileHistory(ctx.repo, mainFile, 5) : '',
    testFiles: listTests(ctx.repo),
  };
}

function sourceLine(f: Fact): string {
  return f.anchor
    ? `\`${f.anchor.file}:${f.anchor.line}\` → \`${f.anchor.text}\``
    : `\`${f.mainFile || '（未知文件）'}\`（未在文件中定位到改动点，以下为待验证假设）`;
}

/* ------------------------------ 测试 ------------------------------ */

function runTests(ctx: RuntimeCtx): { ok: boolean; code: number; output: string; cmd: string } {
  const cmd = ctx.task.test_cmd || 'node --test';
  const [bin, ...args] = cmd.split(/\s+/);
  try {
    const out = execFileSync(bin, args, {
      cwd: ctx.repo,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: CFG.TOOL_TIMEOUT_SEC * 1000,
    });
    return { ok: true, code: 0, output: out, cmd };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      code: err.status ?? 1,
      output: `${err.stdout ?? ''}\n${err.stderr ?? err.message ?? ''}`.trim(),
      cmd,
    };
  }
}

/** 从测试输出里摘出断言数，用于证据 */
function testStat(output: string): string {
  const pass = output.match(/# pass (\d+)/)?.[1];
  const fail = output.match(/# fail (\d+)/)?.[1];
  if (pass || fail) return `pass ${pass ?? 0} / fail ${fail ?? 0}`;
  return '见输出';
}

/**
 * Mock Runtime：不需要任何模型，按阶段确定性地产出产物与代码改动。
 * 它的作用是让「状态机 + 门禁 + 产物校验 + 提测」这条主链可以被完整验证，
 * 而不是假装模型会思考。
 */
export class MockRuntime implements Runtime {
  name = 'mock';
  /** 模拟模型调用返回格式错误，用于验证 E2/E1 兜底 */
  failStage: Stage | null = null;
  failMode: 'timeout' | 'garbage' = 'timeout';
  /**
   * 模拟「口是心非」：事件报 REVIEW_CLEAN，但报告里写着阻断项。
   * 只对第一轮生效 —— 后续轮的补丁落点已被改掉，再撒谎只会变成工具失败，
   * 混在一起就看不清「评审核对」这条断言到底在验证什么。
   */
  lieOnReview = false;
  /**
   * 模拟「改了但没提交」：真实 CLI 最常犯的错，产物齐、测试绿、工作树脏。
   * 用于验证「改动不可交付」这道闸真的会拦住它。
   */
  skipCommitOn: Stage | null = null;

  async runStage(ctx: RuntimeCtx, stage: Stage): Promise<StageEvent> {
    await sleep(TICK);
    const l = ctx.ledger;

    if (this.failStage === stage) {
      if (this.failMode === 'timeout') throw new ModelError('模型调用超时（模拟）', 'TIMEOUT');
      throw new ModelError('模型返回不可解析（模拟）', 'BAD_FORMAT');
    }

    switch (stage) {
      case 'DIAGNOSE': {
        const { key, title, description } = ctx.task;
        const f = fact(ctx);
        const hint = ctx.task.patch_ops?.[0]?.note ?? '';
        const sites = f.callSites.length
          ? f.callSites.map((s) => `- \`${s.file}:${s.line}\` — ${s.text.slice(0, 120)}`).join('\n')
          : `- 未检出对 \`${f.fnName || '（未识别符号）'}\` 的其他引用（检索词即符号名）`;

        writeArt(ctx, 'diagnosis.md', `
# 诊断 · ${key} ${title}

## 问题如何复现
1. 按任务描述操作：${description}
2. 观察：列表区域不随滚动位置变化，后面的条目不可达。
3. 回归入口：\`${ctx.task.test_cmd}\`（用例见 ${f.testFiles.join('、') || 'test/'}）。

## 根因在哪
${sourceLine(f)}

${f.fnName ? `\`${f.fnName}()\` 的渲染窗口没有使用滚动偏移，因此无论滚到哪里，窗口都停在起始位置。` : '根因尚未定位到具体表达式，以上为待验证假设。'}
${hint ? `\n方向：${hint}。` : ''}

## 证据来自何处
- 代码：${sourceLine(f)}
- 符号引用（引擎检索，词为 \`${f.fnName || 'NA'}\`）：
${sites}
- 文件历史（\`git log --\` \`${f.mainFile || 'NA'}\`）：
\`\`\`
${f.history || '（该文件没有更早的提交）'}
\`\`\`
- 运行：\`${ctx.task.test_cmd}\` 首轮结果记在 \`findings.md\`
`.trim());

        writeArt(ctx, 'idea.md', `
# 方案 · ${key} ${title}

## 改什么
在 \`${f.mainFile || '（待定文件）'}\` 内修正 \`${f.fnName || '改动点'}\`：让滚动偏移参与窗口计算，并把结果夹取回合法范围。

## 哪些行为保持不变
- 滚动位置为 0 时的输出与现在一致
- 对外函数签名不变
- 不新增依赖、不改构建配置

## 哪些需要用户选择
| # | 选项 | 做法 | 影响 | 成本 |
| --- | --- | --- | --- | --- |
| 1A | ✅ 就地修正计算 | 只改 \`${f.mainFile || '该文件'}\` 内的窗口计算 | 1 文件 | 低 |
| 1B | ⚠️ 在上层组件重算 | 调用方各自算窗口 | ${Math.max(3, f.callSites.length)} 文件 + 调用方 | 高 |
| 1C | 📌 A+B 同时做 | 计算修正 + 上层兜底 | 多文件 | 中 |
| 2A | ✅ 补一条边界断言 | 在 ${f.testFiles[0] ?? 'test/'} 增加滚过头的用例 | 1 文件 | 低 |
| 2B | ⚠️ 引入虚拟滚动库 | 新增依赖并重写组件 | 影响构建 | 高 |
| 3A | ✅ 沿用现有测试框架 | 不新增依赖 | 无 | 低 |
| 3B | ⚠️ 引入覆盖率门禁 | 新增脚本与 CI 配置 | 影响流水线 | 中 |

回复 ${CFG.TOKEN_DEV} 表示全部按推荐项（1A 2A 3A）。
`.trim());

        ctx.log(`诊断完成：${f.mainFile || '（未识别文件）'} 定位到第 ${f.anchor?.line ?? '?'} 行，3 个待决决策`);
        return { type: 'DIAG_DONE', reason: '诊断与方案产物落盘', pendingDecisions: 3 };
      }

      case 'IMPLEMENT': {
        const touched = applyOps(ctx, 'implement');
        const stat = diffStat(ctx.repo);
        const committed = this.skipCommitOn !== 'IMPLEMENT';
        const sha = committed
          ? commitAll(
            ctx.repo,
            `fix(${ctx.task.key}): ${ctx.task.title}\n\n改动文件：${touched.join(', ') || '无'}`,
            ctx.trigger,
          )
          : mustGit(ctx.repo, ['rev-parse', '--short', 'HEAD']);
        const after = diffStat(ctx.repo, committed ? 'HEAD~1' : 'HEAD');
        const f = fact(ctx);
        const sites = f.callSites.length
          ? f.callSites.map((s) => `- \`${s.file}:${s.line}\` — ${s.text.slice(0, 120)}`).join('\n')
          : `- 除定义处外未检出其他引用（检索词 \`${f.fnName || 'NA'}\`）`;

        writeArt(ctx, 'findings.md', `
# 探索 · ${keyTitle(ctx)}

## 读过的文件
${f.mainFile ? `- \`${f.mainFile}\` — \`${f.fnName || '目标符号'}\` 的实现位置（${f.anchor ? `第 ${f.anchor.line} 行` : '具体行未定位'}）` : '- 未识别出主改动文件（异常，需人工确认）'}
${f.testFiles.map((t) => `- \`${t}\` — 现有回归用例`).join('\n')}
- \`AGENTS.md\` — 仓库约定

## 调用关系
${sites}

## 仓库事实
- 本次提交：\`${sha}\`（${stat.files} 文件 +${stat.insertions} -${stat.deletions}）
- 该文件历史：
\`\`\`
${f.history || '（无更早提交）'}
\`\`\`
`.trim());

        writeArt(ctx, 'plan.md', `
# 计划 · ${keyTitle(ctx)}

## 改哪些位置
${touched.length ? touched.map((f) => `- \`${f}\``).join('\n') : '- （无文件改动，异常）'}

## 如何验证
1. \`${ctx.task.test_cmd}\` 全绿
2. 边界：滚动位置为 0、为最大值、超过最大值三种输入都要落在合法区间
3. diff 只涉及上述文件（${after.files} 文件 / +${after.insertions} -${after.deletions}）
`.trim());

        ctx.log(`实现完成：提交 ${sha}，改动 ${after.files} 文件（+${after.insertions} -${after.deletions}）`);
        return {
          type: 'CODE_DONE',
          reason: `提交 ${sha}，改动 ${after.files} 文件 +${after.insertions} -${after.deletions}`,
        };
      }

      case 'REBASE': {
        const dirty = hasChanges(ctx.repo);
        if (dirty) {
          return { type: 'REBASE_CONFLICT', reason: '工作区存在未提交改动，无法变基' };
        }
        ctx.log(`已对齐基线 ${l.baseline_branch}`);
        return { type: 'REBASE_OK', reason: `已对齐 ${l.baseline_branch}` };
      }

      case 'REVIEW': {
        const rounds = ctx.task.review_blocking_rounds ?? 0;
        const idx = l.review_iteration; // 0-based：第 idx+1 轮
        const blocking = idx < rounds;

        if (blocking) {
          writeArt(ctx, 'review-report.md', `
# 净室评审报告 · 第 ${idx + 1} 轮

## 根因
窗口计算没有使用滚动偏移，属于「视口边界未约束」的同一模式，根因判断成立。

## 调用方
\`total()\` 的调用方均已核对，无第三方消费者，改动面可控。

## 测试覆盖
当前用例只覆盖 scrollTop=0 的场景，缺少滚动到底部与滚过头的边界。

## 旧路径残留
无旧实现残留，\`grep\` 全仓未发现第二处累加逻辑。

## 阻断项
1. 【阻断】\`visibleRange\` 在 scrollTop 超过可滚动高度时会得到 start > end，必须把 start 夹取回合法区间。
2. 【阻断】缺少「滚到底部」与「滚过头」两条断言，无法证明修复有效。
`.trim());
          ctx.log(`第 ${idx + 1} 轮评审：2 项阻断`);
          return { type: 'REVIEW_BLOCKING', reason: '2 项阻断', blocking: 2 };
        }

        // 口是心非模式：报告里写满阻断，事件却说「无阻断」
        if (this.lieOnReview && idx === 0) {
          writeArt(ctx, 'review-report.md', `
# 净室评审报告 · 第 ${idx + 1} 轮

## 根因
与诊断一致，无新增疑点。

## 调用方
调用方已全部核对。

## 测试覆盖
边界用例仍不充分。

## 旧路径残留
无。

## 阻断项
1. 【阻断】\`start\` 未夹取，滚过头会出现 start > end。
2. 【阻断】缺少滚过头的断言。
`.trim());
          ctx.log(`第 ${idx + 1} 轮评审：事件报 CLEAN，报告却写了 2 项阻断（模拟不一致）`);
          return {
            type: 'REVIEW_CLEAN',
            reason: '0 阻断',
            approvals: [{
              id: 'A1',
              title: '起始行夹取到合法区间',
              decision: 'Math.min(floor(scrollTop/rowHeight), max(0, total-visibleCount))',
              basis: '滚过头时不应出现 start > end（回归用例覆盖）',
              needs_review: true,
              at: nowIso(),
            }],
          };
        }

        writeArt(ctx, 'review-report.md', `
# 净室评审报告 · 第 ${idx + 1} 轮

## 根因
与诊断一致，无新增疑点。

## 调用方
调用方已全部核对。

## 测试覆盖
滚到底部与滚过头两条边界已覆盖。

## 旧路径残留
无。

## 阻断项
无阻断发现。
`.trim());
        ctx.log(`第 ${idx + 1} 轮评审：无阻断`);
        return {
          type: 'REVIEW_CLEAN',
          reason: '0 阻断',
          approvals: [{
            id: 'A1',
            title: '起始行夹取到合法区间',
            decision: 'Math.min(floor(scrollTop/rowHeight), max(0, total-visibleCount))',
            basis: '滚过头时不应出现 start > end（回归用例覆盖）',
            rule: '答案能从已查到的事实推出',
            needs_review: true,
            at: nowIso(),
          }],
        };
      }

      case 'PATCH': {
        const touched = applyOps(ctx, 'patch');
        const sha = this.skipCommitOn === 'PATCH'
          ? mustGit(ctx.repo, ['rev-parse', '--short', 'HEAD'])
          : commitAll(
            ctx.repo,
            `fix(${ctx.task.key}): 按评审报告修补\n\n${touched.join(', ')}`,
            ctx.trigger,
          );
        writeArt(ctx, 'plan-delta.md', `
# 计划偏离记录

## 原计划
只让 scrollTop 参与起始行计算，不动其他逻辑。

## 实际
额外把 start 夹取回合法区间，并新增一条「滚过头」的断言（${touched.join(', ')}）。

## 为何偏离
评审报告第 1 项阻断指出滚过头会产生非法区间（start > end）；不改会留下新的边界缺陷。
`.trim());

        // 追加而不是覆盖：findings.md 属于 IMPLEMENT 产物，history 里记过它的哈希，
        // 修补轮把它整段重写等于把上一阶段的证据抹掉。
        const prevFindings = readText(art(ctx.ws, 'findings.md')).trimEnd();
        const pf = fact(ctx); // 只查一次仓库，避免同一轮重复跑 git
        writeArt(ctx, 'findings.md', `${prevFindings}

## 修补轮（第 ${l.review_iteration} 轮）读过的文件
- \`${pf.mainFile || '（未识别文件）'}\`
${pf.testFiles.map((t) => `- \`${t}\``).join('\n')}
- \`.xwing-task/lattice/review-report.md\` —— 本轮只修报告里列出的问题`);

        ctx.log(`按报告修补完成：${touched.join(', ')}`);
        return { type: 'PATCH_DONE', reason: '按报告修补 2 项' };
      }

      case 'VERIFY': {
        const r = runTests(ctx);
        writeArt(ctx, 'ship-summary.md', `
# 提测包 · ${keyTitle(ctx)}

## 改动
- \`src/virtualList.js\`：起始行改为按滚动偏移计算，并夹取回合法范围

## 实测
\`${r.cmd}\` → 退出码 ${r.code}（${testStat(r.output)}）

## 检查
- 未改对外签名
- 未越出方案范围
- 回归用例（含滚动、边界、空列表）全部转绿

## 人工优先看
起始行的夹取表达式：滚过头时不能出现 \`start > end\`。

## 待批决策
- 起始行夹取到合法区间（评审期自动决定，需追认）
`.trim());

        ctx.log(`验证：${r.cmd} 退出码 ${r.code}（${testStat(r.output)}）`);
        if (!r.ok) {
          return {
            type: 'VERIFY_FAIL',
            reason: `测试失败：退出码 ${r.code}`,
            exitCode: r.code,
            testSummary: testStat(r.output),
          };
        }
        return {
          type: 'VERIFY_PASS',
          reason: `${r.cmd} 全绿（${testStat(r.output)}）`,
          exitCode: 0,
          testSummary: testStat(r.output),
        };
      }

      default:
        throw new ModelError(`mock runtime 不支持阶段 ${stage}`);
    }
  }
}

function keyTitle(ctx: RuntimeCtx): string {
  return `${ctx.task.key} ${ctx.task.title}`;
}

export function makeMockRuntime(spec: { failStage?: Stage; failMode?: 'timeout' | 'garbage' } = {}): MockRuntime {
  const rt = new MockRuntime();
  if (spec.failStage) rt.failStage = spec.failStage;
  if (spec.failMode) rt.failMode = spec.failMode;
  return rt;
}

export function repoExists(p: string): boolean {
  return existsSync(p);
}

export type { Ledger };
