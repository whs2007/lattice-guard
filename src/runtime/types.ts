import type { Ledger, Stage, StageEvent, TaskSpec } from '../types.ts';

export interface RuntimeCtx {
  /** 任务工作区根 */
  ws: string;
  /** 被修复的仓库（git 工作副本） */
  repo: string;
  task: TaskSpec;
  ledger: Ledger;
  /** 触发这次运行的人（A109/A110） */
  trigger: string;
  /** 上下文组装结果文件（真实 Runtime 会读它或读 stdin） */
  promptPath: string;
  log: (line: string) => void;
  /**
   * 阶段级超时信号。引擎在 STAGE_TIMEOUT_SEC 后 abort。
   * Runtime **必须**响应它并终止子进程，否则只是「引擎不再等」，子进程会变孤儿。
   */
  signal?: AbortSignal;
}

/**
 * Runtime 抽象：平台只要求「启动一个 AI 编程工具、给它上下文、收它的产出」。
 * mock 与 cli 两种实现可整体互换。
 */
export interface Runtime {
  name: string;
  runStage(ctx: RuntimeCtx, stage: Stage): Promise<StageEvent>;
}
