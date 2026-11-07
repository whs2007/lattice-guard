/**
 * 全局配置 —— 全部默认值集中在此，猜错时只改这里。
 * 令牌字面量来自锚点，属于硬约束，不得改动。
 */
export const CFG = {
  /** 任务工作区内的账本与产物根目录（A32 页脚路径） */
  WORKSPACE_SUBDIR: '.xwing-task/lattice',

  /** 门 1：修改产品代码前的授权令牌（A22 / A113 / A114） */
  TOKEN_DEV: '【进入开发】',
  /** 门 2：提测前的授权令牌（A23 / A114 / A115） */
  TOKEN_SHIP: '【提测】',

  /** 令牌必须位于消息末尾才算授权（A24「自然语言不算授权」的最严解释） */
  GATE_STRICT_TAIL: true,

  /** 评审/返工回路上限（A15 / A113 六轮） */
  MAX_LOOP: 6,

  /** 分支基线兜底（A41 / A119） */
  DEFAULT_BASE_BRANCH: 'develop',
  /** 优先级 → 基线分支（A44 / A118） */
  PRIORITY_BRANCH: { 紧急: 'main', 高优: 'staging' } as Record<string, string>,
  /** 工作分支命名（A105 官方例：hifox-agent/thor/HF-3341） */
  BRANCH_PATTERN: (agentSlug: string, taskKey: string) => `hifox-agent/${agentSlug}/${taskKey}`,

  /** 单阶段上限（秒）。资料零记载，取案例最长段 37 分 3 秒 × 1.5 */
  STAGE_TIMEOUT_SEC: 5400,
  /** 单次模型调用上限（秒）。资料零记载 */
  MODEL_TIMEOUT_SEC: 900,
  /** 单条命令（测试/构建）上限（秒）。资料零记载 */
  TOOL_TIMEOUT_SEC: 1800,

  /** 零自动重试（A57「自动重试是状态机干扰项」） */
  RETRY_TRANSPORT: 0,

  /**
   * 单轮上下文总预算（字符）。资料零记载，按「单块预算之和的一半」估：
   * 单块全顶满是 ~30 万字符，实际很难全满；60 万是留足余量、又能挡住
   * 「上下文里塞了整个仓库」这种明显失控的值。
   */
  MAX_CONTEXT_CHARS: 600000,

  /** Agent 身份（用于分支名与提交作者，A105/A106） */
  AGENT_NAME: '狄仁杰',
  AGENT_SLUG: 'direnjie',

  /** 页脚展示的运行时标识，仅用于 UI 复刻（A07） */
  RUNTIME_LABEL: 'hifox/GLM-5.3 · Max',

  /** 轨道默认值（A32） */
  DEFAULT_TRACK: '普通',
} as const;

export const TOKENS: readonly string[] = [CFG.TOKEN_DEV, CFG.TOKEN_SHIP];

/** 每个阶段默认加载的 Skill 名（对应 prompts/skills/<name>/SKILL.md） */
export const STAGE_SKILL: Record<string, string> = {
  INIT: '',
  DIAGNOSE: 'lattice-diagnose',
  WAIT_DEV: 'lattice-idea',
  IMPLEMENT: 'lattice-implement',
  REBASE: 'lattice-implement',
  REVIEW: 'lattice-review',
  PATCH: 'lattice-implement',
  VERIFY: 'lattice-verify',
  WAIT_SHIP: 'lattice-deliver',
  SHIP: 'lattice-deliver',
  /** [图中] 终态页脚写的是 lattice-deliver，不是另设的收尾技能 */
  DONE: 'lattice-deliver',
};

/**
 * 同阶段附带的技能。[原文] 七个技能里「探索」与「实现」是两个阶段、两个技能；
 * 本复现把两步合并进 IMPLEMENT，因此探索技能随实现技能一起注入上下文。
 * 页脚「技能加载」仍只显示主技能（lattice-implement），与门禁无关。
 */
export const STAGE_AUX_SKILL: Record<string, string[]> = {
  IMPLEMENT: ['lattice-explore'],
};
