import { StateError } from './errors.ts';
import { STAGE_LABELS } from './stages.ts';
import { artifactsOfStage } from './artifacts.ts';
import type { Ledger, Stage } from './types.ts';

/**
 * 页脚文法（引擎独占生成权，模型不得自写）。
 * 形态来自三份逐字页脚：字段齐、顺序稳、值随阶段机械变化。
 */
export const FOOTER_KEYS = [
  '任务ID', '轨道', '阶段', '等待', '文案', '状态', '期望令牌',
  '评审迭代', '待此决策', '待批决策', '技能加载', '阶段产物',
] as const;

/**
 * 「待此决策」→「待批决策」的切换点在门 2 之后，不在门 2 之前。
 * [图中] WAIT_SHIP 页脚仍写「待此决策: 5」，DONE 页脚写「待批决策: 0」。
 * SHIP 段本身没有样本，按「门 2 已通过即进入待批语义」推断为同一组。
 */
const APPROVAL_STAGES = new Set<Stage>(['SHIP', 'DONE', 'PARTIAL_SHIP']);

export function footerKeyForDecision(stage: string): string {
  return APPROVAL_STAGES.has(stage as Stage) ? '待批决策' : '待此决策';
}

/**
 * 阶段产物 = 当前阶段（或当前门所对应的产出阶段）的产物，不是历史累计。
 * [图中] 三份逐字页脚：WAIT_DEV 列 diagnosis+idea、WAIT_SHIP 列 ship-summary+manifest、
 * DONE 与 WAIT_SHIP 相同 —— 说明它列的是「这一段的交付物」，不是全量。
 * 未在本账本登记过的路径不写进页脚，避免页脚宣称不存在的文件。
 */
const ARTIFACT_SOURCE: Record<Stage, Stage> = {
  INIT: 'INIT',
  DIAGNOSE: 'DIAGNOSE',
  WAIT_DEV: 'DIAGNOSE',
  IMPLEMENT: 'IMPLEMENT',
  REBASE: 'IMPLEMENT',
  REVIEW: 'REVIEW',
  PATCH: 'REVIEW',
  VERIFY: 'VERIFY',
  WAIT_SHIP: 'VERIFY',
  SHIP: 'VERIFY',
  DONE: 'VERIFY',
  PARTIAL_SHIP: 'VERIFY',
  PAUSED: 'INIT',
};

export function footerArtifacts(l: Ledger): string[] {
  const stage = l.stage === 'PAUSED' ? (l.paused_from ?? 'INIT') : l.stage;
  const registered = new Set(l.artifacts);
  return artifactsOfStage(ARTIFACT_SOURCE[stage] ?? 'INIT')
    .filter((s) => registered.has(s.path))
    .map((s) => s.path);
}

export function renderFooter(l: Ledger): string {
  const fmt = (v: string | null) => (v === null || v === '' ? '无' : v);
  const arts = footerArtifacts(l);
  const parts: string[] = [
    `任务ID: ${l.task_id}`,
    `轨道: ${l.track}`,
    `阶段: ${STAGE_LABELS[l.stage]}`,
    `等待: ${fmt(l.waiting)}`,
    `文案: ${l.copy_touched ? '已变更' : '未触碰'}`,
    `状态: ${l.status}`,
    `期望令牌: ${fmt(l.expected_token)}`,
    `评审迭代: ${l.review_iteration}`,
    `${footerKeyForDecision(l.stage)}: ${l.pending_decisions}`,
    `技能加载: ${l.skills[0] ?? '无'}`,
    `阶段产物: ${arts.length > 0 ? arts.join(', ') : '无'}`,
  ];
  return `---页脚开始--- ${parts.join(' ')} ---页脚结束---`;
}

const FOOTER_RE = /---页脚开始---([\s\S]*?)---页脚结束---/;
const KEY_SPLIT_RE = new RegExp(`\\s(?=(?:${FOOTER_KEYS.join('|')}): )`, 'g');

export function parseFooter(text: string): Record<string, string> {
  const m = text.match(FOOTER_RE);
  if (!m) throw new StateError('页脚缺失', 'NO_FOOTER');

  const out: Record<string, string> = {};
  const body = m[1].trim();
  for (const seg of body.split(KEY_SPLIT_RE)) {
    const i = seg.indexOf(': ');
    if (i < 0) throw new StateError(`页脚段非法：${seg.slice(0, 24)}`, 'BAD_FOOTER');
    out[seg.slice(0, i)] = seg.slice(i + 2).trim();
  }

  // 两个决策字段是同义键：归一后必须恰好 11 个不同键
  const uniq = new Set(Object.keys(out).map((k) => (k === '待批决策' ? '待此决策' : k)));
  if (uniq.size !== 11) {
    throw new StateError(`页脚键数应为 11（决策字段归一后），实为 ${uniq.size}`, 'BAD_FOOTER');
  }
  return out;
}

/** 页脚 ↔ 账本逐字段等值校验（A21：内容互相矛盾时停止） */
export function assertFooterMatchesLedger(text: string, l: Ledger): void {
  const f = parseFooter(text);
  const pairs: Array<[string, string]> = [
    ['任务ID', l.task_id],
    ['轨道', l.track],
    ['阶段', STAGE_LABELS[l.stage]],
    ['等待', l.waiting ?? '无'],
    ['文案', l.copy_touched ? '已变更' : '未触碰'],
    ['状态', l.status],
    ['期望令牌', l.expected_token ?? '无'],
    ['评审迭代', String(l.review_iteration)],
    ['技能加载', l.skills[0] ?? '无'],
  ];
  for (const [k, want] of pairs) {
    if (f[k] !== want) {
      throw new StateError(`页脚与账本不一致：${k} 页脚=${f[k]} 账本=${want}`, 'FOOTER_MISMATCH');
    }
  }
  const decisionKey = footerKeyForDecision(l.stage);
  if (f[decisionKey] !== String(l.pending_decisions)) {
    throw new StateError(
      `页脚与账本不一致：${decisionKey} 页脚=${f[decisionKey]} 账本=${l.pending_decisions}`,
      'FOOTER_MISMATCH',
    );
  }

  const arts = footerArtifacts(l);
  const wantArts = arts.length > 0 ? arts.join(', ') : '无';
  if (f['阶段产物'] !== wantArts) {
    throw new StateError(
      `页脚与账本不一致：阶段产物 页脚=${f['阶段产物']} 账本=${wantArts}`,
      'FOOTER_MISMATCH',
    );
  }
}

/** 从消息文本里剥掉页脚，供 UI 分块展示 */
export function splitFooter(text: string): { body: string; footer: string | null } {
  const m = text.match(FOOTER_RE);
  if (!m) return { body: text, footer: null };
  return { body: text.replace(FOOTER_RE, '').trim(), footer: m[0] };
}
