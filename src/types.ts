export const STAGES = [
  'INIT',
  'DIAGNOSE',
  'WAIT_DEV',
  'IMPLEMENT',
  'REBASE',
  'REVIEW',
  'PATCH',
  'VERIFY',
  'WAIT_SHIP',
  'SHIP',
  'DONE',
  'PAUSED',
  'PARTIAL_SHIP',
] as const;

export type Stage = (typeof STAGES)[number];

/** 唯一的两个门（A25：只允许两道令牌门） */
export const GATE_STAGES: readonly Stage[] = ['WAIT_DEV', 'WAIT_SHIP'];

/** 自动阶段：不需要人类消息即可推进 */
export const AUTO_STAGES: readonly Stage[] = [
  'INIT', 'DIAGNOSE', 'IMPLEMENT', 'REBASE', 'REVIEW', 'PATCH', 'VERIFY', 'SHIP',
];

export type Track = string;

export type LedgerStatus = '等待确认' | '进行中' | '已完成';

export type EventType =
  | 'TASK_ASSIGNED'
  | 'DIAG_DONE'
  | 'IDEA_REFINED'
  | 'HUMAN_MSG'
  | 'CODE_DONE'
  | 'REBASE_OK'
  | 'REBASE_CONFLICT'
  | 'REVIEW_CLEAN'
  | 'REVIEW_BLOCKING'
  | 'PATCH_DONE'
  | 'VERIFY_PASS'
  | 'VERIFY_FAIL'
  | 'REWORK'
  | 'SHIP_DONE'
  | 'SHIP_STEP_FAIL'
  | 'SHIP_RETRY'
  | 'OPERATOR_RESUME'
  | 'STAGE_ERROR';

export interface StageEvent {
  type: EventType;
  reason: string;
  /** 评审发现阻断项数量 */
  blocking?: number;
  /** 触发事件的令牌（若有） */
  token?: string | null;
  /** idea.md 的 sha256，用于「批准的是哪一版方案」 */
  planVersion?: string | null;
  /** 初始化是否通过 */
  initOk?: boolean;
  /** 是否属于超时类失败（E1） */
  timeout?: boolean;
  /** 本阶段产出的待决决策数 */
  pendingDecisions?: number;
  /** 本阶段产出的自动决策与待批项 */
  approvals?: ApprovalItem[];
  /** 验证阶段的测试退出码（引擎写 manifest 用） */
  exitCode?: number;
  /** 验证阶段的测试摘要 */
  testSummary?: string;
}

export interface HistoryRec {
  from: Stage | null;
  to: Stage;
  reason: string;
  at: string;
  file_hashes?: Record<string, string>;
  token?: string | null;
  approved_plan_version?: string | null;
}

export interface ShipStepRec {
  seq: number;
  name: string;
  status: 'pending' | 'ok' | 'failed' | 'skipped';
  idem_key: string;
  detail?: string;
  at?: string;
}

export interface Ledger {
  schema_version: 1;
  task_id: string;
  track: Track;
  stage: Stage;
  waiting: string | null;
  copy_touched: boolean;
  status: LedgerStatus;
  expected_token: string | null;
  review_iteration: number;
  pending_decisions: number;
  skills: string[];
  artifacts: string[];
  approved_decisions: Record<string, string>;
  pending_approval: ApprovalItem[];
  verification_status: Record<string, unknown>;
  baseline_branch: string;
  agent_slug: string;
  workspace_path: string;
  last_consumed_message_id: string | null;
  ship_steps: ShipStepRec[];
  rework_count: number;
  started_at: string;
  finished_at: string | null;
  paused_from: Stage | null;
  pause_reason: string | null;
  history: HistoryRec[];
}

export interface ApprovalItem {
  id: string;
  title: string;
  decision: string;
  basis: string;
  rule: string;
  needs_review: boolean;
  at: string;
}

/** 人类消息（写在 messages.jsonl，append-only） */
export interface HumanMessage {
  id: string;
  role: 'human' | 'agent';
  text: string;
  at: string;
  /** agent 消息额外字段 */
  stage?: Stage;
  kind?: 'normal' | 'gate_reject' | 'rework_ack' | 'final';
  footer?: string;
  elapsed_ms?: number;
}

/** 任务单（模拟平台侧任务，真实平台会由 HiFox 注入） */
export interface TaskSpec {
  key: string;
  title: string;
  description: string;
  space: string;
  type: string;
  priority: string;
  labels: string[];
  status: string;
  repo: string;
  base_branch: string;
  test_cmd: string;
  /** mock runtime 用来「改代码」的操作表；真实模式不用 */
  patch_ops: PatchOp[];
  /** mock runtime 在第 n 轮之前一直报阻断，用于演示六轮上限 */
  review_blocking_rounds: number;
  custom_fields: Record<string, string>;
  env: { running: boolean; port: number | null };
}

export interface PatchOp {
  file: string;
  find: string;
  replace: string;
  note?: string;
  /** implement = 实现阶段落的改动；patch = 评审发现阻断后补的改动 */
  phase?: 'implement' | 'patch';
}
