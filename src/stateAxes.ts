/**
 * 四套状态轴的隔离层（v3 A94~A98）。
 * 这套实现里最容易写错的就是把「运行状态」当「任务状态」用，
 * 所以只允许这一个函数做映射，其余地方禁止互推。
 */

export type TaskStatus =
  | 'Backlog' | 'Todo' | 'In Progress' | 'In Review' | 'Done' | 'Blocked' | 'Cancelled';

export type RunStatus = 'queued' | 'starting' | 'running' | 'completed' | 'failed' | 'cancelled';

export type AgentStatus = 'idle' | 'working' | 'blocked' | 'error' | 'offline';

export type HandoffStatus = 'waiting_reply' | 'waiting_review' | null;

/** 运行状态 → 任务状态；返回 null 表示「不改任务状态」 */
export function projectRunToTask(run: RunStatus): TaskStatus | null {
  switch (run) {
    case 'queued':
    case 'starting':
    case 'running':
      return null;
    case 'completed':
      // 完成一轮 ≠ 任务完成：交给人审阅（官方：Agent 已完成一轮，任务仍需要 review）
      return 'In Review';
    case 'failed':
    case 'cancelled':
      // 运行失败不代表任务失败：只进「对话」模块，不动任务状态
      return null;
  }
}

/** 引擎阶段 → 运行状态（供 UI 显示，不反向影响任务状态） */
export function stageToRun(stage: string, paused: boolean): RunStatus {
  if (paused) return 'failed';
  if (stage === 'DONE') return 'completed';
  if (stage === 'WAIT_DEV' || stage === 'WAIT_SHIP') return 'completed';
  return 'running';
}

/** 引擎阶段 → 交接状态：只有两道门会产生「等你回复」 */
export function stageToHandoff(stage: string): HandoffStatus {
  if (stage === 'WAIT_DEV') return 'waiting_reply';
  if (stage === 'WAIT_SHIP') return 'waiting_review';
  return null;
}

/** 引擎阶段 → 中文任务状态（提测完成才写「待测试」，与 A41 一致） */
export function stageToTaskStatusCn(stage: string): string | null {
  if (stage === 'DONE') return '待测试';
  return null;
}
