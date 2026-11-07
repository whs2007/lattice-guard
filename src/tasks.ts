import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { STAGE_LABELS } from './stages.ts';
import { projectRunToTask, stageToHandoff, stageToRun, stageToTaskStatusCn } from './stateAxes.ts';
import { loadLedger, hasLedger, readTaskSpec } from './ledger.ts';
import { lockOwner } from './workspace.ts';
import type { Stage } from './types.ts';
import type { HandoffStatus, RunStatus, TaskStatus } from './stateAxes.ts';

/**
 * 多任务视图：规格书里「几十个任务并行」的最小可观测面。
 * 没有它，人只能靠 `--ws` 一个个问，无法回答「现在哪个任务卡住了」。
 */
export interface TaskSummary {
  key: string;
  title: string;
  ws: string;
  /** 引擎阶段（唯一真相源是 state.json） */
  stage: Stage;
  stage_label: string;
  /** 由阶段投影出来的运行状态轴（不写回任何地方） */
  run_status: RunStatus;
  /** 任务系统状态轴：只有 SHIP 末步能改 */
  task_status: TaskStatus;
  task_status_cn: string;
  handoff: HandoffStatus;
  waiting: string | null;
  expected_token: string | null;
  review_iteration: number;
  paused: boolean;
  pause_reason: string | null;
  /** 需要人处理：等令牌 / 暂停 / 提测部分完成 */
  needs_human: boolean;
  updated_at: string;
  /** 有进程持锁 = 正在被 driver 跑 */
  driver_pid: number | null;
}

const HUMAN_STAGES: ReadonlyArray<Stage> = ['WAIT_DEV', 'WAIT_SHIP', 'PAUSED', 'PARTIAL_SHIP'];

export function summarizeTask(ws: string): TaskSummary | null {
  if (!hasLedger(ws)) return null;
  let l;
  let task;
  try {
    l = loadLedger(ws);
    task = readTaskSpec(ws);
  } catch {
    return null;
  }

  const paused = l.stage === 'PAUSED' || l.stage === 'PARTIAL_SHIP';
  const run = stageToRun(l.stage, paused);
  const projected = projectRunToTask(run) ?? task.status;
  const last = l.history[l.history.length - 1];

  return {
    key: l.task_id,
    title: task.title,
    ws,
    stage: l.stage,
    stage_label: STAGE_LABELS[l.stage],
    run_status: run,
    task_status: task.status,
    task_status_cn: stageToTaskStatusCn(l.stage) ?? task.status,
    handoff: stageToHandoff(l.stage),
    waiting: l.waiting,
    expected_token: l.expected_token,
    review_iteration: l.review_iteration,
    paused,
    pause_reason: l.pause_reason ?? null,
    needs_human: HUMAN_STAGES.includes(l.stage),
    updated_at: last?.at ?? l.started_at,
    driver_pid: lockOwner(ws),
  };
}

/** 扫描任务根目录下所有工作区 */
export function listTasks(root: string): TaskSummary[] {
  const base = join(root, 'tasks');
  if (!existsSync(base)) return [];
  const out: TaskSummary[] = [];
  for (const name of readdirSync(base)) {
    const ws = join(base, name);
    const s = summarizeTask(ws);
    if (s) out.push(s);
  }
  return out.sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
}

/** 给人看的一行 */
export function formatSummary(s: TaskSummary): string {
  const flag = s.needs_human ? '⏸' : s.driver_pid ? '▶' : '·';
  const wait = s.expected_token ? ` 等 ${s.expected_token}` : '';
  const iter = s.review_iteration > 0 ? ` 迭代 ${s.review_iteration}` : '';
  const lock = s.driver_pid ? ` pid ${s.driver_pid}` : '';
  return `${flag} ${s.key}  ${s.stage_label}${wait}${iter}  [任务状态 ${s.task_status_cn}]${lock}  ${s.title}`;
}

