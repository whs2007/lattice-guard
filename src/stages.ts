import { CFG } from './config.ts';
import { StateError } from './errors.ts';
import type { HistoryRec, Ledger, Stage, StageEvent } from './types.ts';

/** 阶段 → 页脚显示名（0.5 节冻结的对照表） */
export const STAGE_LABELS: Record<Stage, string> = {
  INIT: '初始化',
  DIAGNOSE: '诊断与方案准备',
  WAIT_DEV: '等待进入开发',
  IMPLEMENT: '实现探索与实现',
  REBASE: '评审前变基',
  REVIEW: '净室评审',
  PATCH: '按报告修补',
  VERIFY: '验证',
  WAIT_SHIP: '等待提测',
  SHIP: '提测执行',
  DONE: '完成',
  PAUSED: '已暂停',
  PARTIAL_SHIP: '提测部分完成',
};

export interface Transition {
  to: Stage | '__RESUME__';
  /** 守卫；省略即恒真 */
  guard?: (l: Ledger, ev: StageEvent) => boolean;
  reason: (l: Ledger, ev: StageEvent) => string;
}

const MAX = CFG.MAX_LOOP;

/**
 * 迁移表：`<from>::<event>` → 候选迁移（按顺序取第一个守卫通过的）。
 * 这张表是行为的唯一真相源，改它即改行为。
 */
export const TRANSITIONS: Record<string, Transition[]> = {
  'INIT::TASK_ASSIGNED': [
    {
      to: 'DIAGNOSE',
      guard: (_l, ev) => ev.initOk !== false,
      reason: (l) => `初始化完成，基线 ${l.baseline_branch}`,
    },
    {
      to: 'PAUSED',
      guard: (_l, ev) => ev.initOk === false,
      reason: (_l, ev) => `初始化失败：${ev.reason}`,
    },
  ],

  'DIAGNOSE::DIAG_DONE': [
    { to: 'WAIT_DEV', reason: () => '诊断与方案就绪，等待人工' },
  ],

  'WAIT_DEV::HUMAN_MSG': [
    {
      to: 'IMPLEMENT',
      guard: (_l, ev) => ev.token === CFG.TOKEN_DEV,
      reason: (_l, ev) => `人工令牌${CFG.TOKEN_DEV}授权：${ev.reason}`,
    },
  ],

  'WAIT_DEV::IDEA_REFINED': [
    { to: 'WAIT_DEV', reason: (_l, ev) => `方案精化：${ev.reason}（不解锁）` },
  ],

  'IMPLEMENT::CODE_DONE': [
    { to: 'REBASE', reason: () => '实现完成，进入变基' },
  ],

  'REBASE::REBASE_OK': [
    { to: 'REVIEW', reason: (l) => `已对齐 ${l.baseline_branch}` },
  ],
  'REBASE::REBASE_CONFLICT': [
    { to: 'PAUSED', reason: (_l, ev) => `变基冲突，需人工：${ev.reason}` },
  ],

  'REVIEW::REVIEW_CLEAN': [
    { to: 'VERIFY', reason: () => '净室评审通过，0 阻断' },
  ],
  'REVIEW::REVIEW_BLOCKING': [
    {
      to: 'PATCH',
      guard: (l) => l.review_iteration < MAX,
      reason: (l, ev) => `第 ${l.review_iteration + 1} 轮评审发现 ${ev.blocking ?? 1} 项阻断`,
    },
    {
      to: 'PAUSED',
      guard: (l) => l.review_iteration >= MAX,
      reason: () => `评审回路达上限（六轮），停下请人处理`,
    },
  ],

  'PATCH::PATCH_DONE': [
    { to: 'REBASE', reason: () => '按报告修补完成' },
  ],

  'VERIFY::VERIFY_PASS': [
    { to: 'WAIT_SHIP', reason: () => '验证通过，提测包就绪' },
  ],
  'VERIFY::VERIFY_FAIL': [
    { to: 'PAUSED', reason: (_l, ev) => `验证未通过：${ev.reason}` },
  ],

  'WAIT_SHIP::HUMAN_MSG': [
    {
      to: 'SHIP',
      guard: (_l, ev) => ev.token === CFG.TOKEN_SHIP,
      reason: (_l, ev) => `人工令牌${CFG.TOKEN_SHIP}授权，${ev.reason}`,
    },
  ],
  'WAIT_SHIP::REWORK': [
    {
      to: 'REBASE',
      guard: (l) => l.review_iteration < MAX,
      reason: (_l, ev) => `返工：${ev.reason}`,
    },
    {
      to: 'PAUSED',
      guard: (l) => l.review_iteration >= MAX,
      reason: () => '返工回路达上限（六轮），停下请人处理',
    },
  ],

  'SHIP::SHIP_DONE': [
    { to: 'DONE', reason: () => '提测完成' },
  ],
  'SHIP::SHIP_STEP_FAIL': [
    { to: 'PARTIAL_SHIP', reason: (_l, ev) => `提测部分完成：${ev.reason}` },
  ],

  'PARTIAL_SHIP::SHIP_RETRY': [
    { to: 'SHIP', reason: () => '续跑提测（跳过已完成步）' },
  ],

  'PAUSED::OPERATOR_RESUME': [
    { to: '__RESUME__', reason: (_l, ev) => `人工恢复：${ev.reason}` },
  ],
};

/** PAUSED 的出口：回到暂停前所处阶段（从 history 倒推，不硬编码） */
export function resolveResumeStage(l: Ledger): Stage {
  const last = l.history[l.history.length - 1];
  if (last?.from) return last.from;
  return 'INIT';
}

export interface NextResult {
  to: Stage;
  transition: Transition;
}

export function nextStage(l: Ledger, ev: StageEvent): NextResult {
  const key = `${l.stage}::${ev.type}`;
  const candidates = TRANSITIONS[key] ?? [];

  for (const t of candidates) {
    if (!t.guard || t.guard(l, ev)) {
      const to = t.to === '__RESUME__' ? resolveResumeStage(l) : t.to;
      return { to, transition: t };
    }
  }

  // 任意阶段的异常都收敛到 PAUSED —— 状态闭合的兜底出口，绝不会「进得去出不来」
  if (ev.type === 'STAGE_ERROR' && l.stage !== 'PAUSED') {
    return {
      to: 'PAUSED',
      transition: { to: 'PAUSED', reason: () => `阶段异常暂停：${ev.reason}` },
    };
  }

  throw new StateError(`迁移表缺口：${l.stage} 收到 ${ev.type} 无可用出边`);
}

/**
 * 迁移副作用：只改账本数据，不碰文件系统。
 * 所有「阶段变了以后账本长什么样」都在这里定义。
 */
export function applyStageEffects(l: Ledger, to: Stage, ev: StageEvent, now: string): void {
  const from = l.stage;

  // 门字段默认清空，由具体分支重新置位（保证 waiting / expected_token / status 三者始终同生同灭）
  const clearGate = () => {
    l.waiting = null;
    l.expected_token = null;
  };

  switch (to) {
    case 'DIAGNOSE':
      l.status = '进行中';
      l.skills = ['lattice-diagnose'];
      break;

    case 'WAIT_DEV':
      l.waiting = CFG.TOKEN_DEV;
      l.expected_token = CFG.TOKEN_DEV;
      l.status = '等待确认';
      l.skills = ['lattice-idea'];
      if (typeof ev.pendingDecisions === 'number') l.pending_decisions = ev.pendingDecisions;
      break;

    case 'IMPLEMENT':
      clearGate();
      l.status = '进行中';
      l.skills = ['lattice-implement'];
      break;

    case 'REBASE':
      clearGate();
      l.status = '进行中';
      l.skills = ['lattice-implement'];
      if (from === 'WAIT_SHIP') {
        l.rework_count += 1;
        // 返工与评审修补共用同一个计数器：否则 WAIT_SHIP 可以无限返工，六轮上限形同虚设
        l.review_iteration += 1;
      }
      break;

    case 'REVIEW':
      clearGate();
      l.status = '进行中';
      l.skills = ['lattice-review'];
      break;

    case 'PATCH':
      clearGate();
      l.status = '进行中';
      l.skills = ['lattice-implement'];
      l.review_iteration += 1;
      break;

    case 'VERIFY':
      clearGate();
      l.status = '进行中';
      l.skills = ['lattice-verify'];
      break;

    case 'WAIT_SHIP':
      l.waiting = CFG.TOKEN_SHIP;
      l.expected_token = CFG.TOKEN_SHIP;
      l.status = '等待确认';
      l.skills = ['lattice-deliver'];
      l.pending_decisions = l.pending_approval.filter((a) => a.needs_review).length;
      break;

    case 'SHIP':
      clearGate();
      l.status = '进行中';
      l.skills = ['lattice-deliver'];
      break;

    case 'DONE':
      clearGate();
      l.status = '已完成';
      // [图中] 终态页脚：技能加载 lattice-deliver、待批决策 0 —— 提测已完成，不残留待批项
      l.skills = ['lattice-deliver'];
      l.pending_decisions = 0;
      l.finished_at = now;
      break;

    case 'PAUSED':
      clearGate();
      // 暂停也是「会话在进行中」：保证 I2（waiting/期望令牌/等待确认 三者同生同灭）
      l.status = '进行中';
      l.paused_from = from;
      l.pause_reason = ev.reason;
      break;

    case 'PARTIAL_SHIP':
      clearGate();
      l.status = '进行中';
      l.paused_from = from;
      l.pause_reason = ev.reason;
      break;

    case 'INIT':
      break;
  }
}

export function makeHistory(
  l: Ledger,
  to: Stage,
  reason: string,
  now: string,
  extra: Partial<HistoryRec> = {},
): HistoryRec {
  return {
    from: l.stage,
    to,
    reason,
    at: now,
    ...extra,
  };
}
