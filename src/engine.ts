import { appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { CFG } from './config.ts';
import { ARTIFACTS, checkEvidence, readReviewVerdict, writeVerificationManifest } from './artifacts.ts';
import { canAdvance, describeGate } from './canAdvance.ts';
import { assembleContext } from './context.ts';
import {
  appendMessage, hashArtifacts, loadLedger, markConsumed, nextHumanMessage, readTaskSpec,
  saveLedger, takeOperatorCommand, validateLedger, writeTaskSpec,
} from './ledger.ts';
import { renderFooter } from './footer.ts';
import { applyStageEffects, nextStage } from './stages.ts';
import { assertShipPreconditions, recordShipLog, ship } from './ship.ts';
import { assertDeliverable, branchExists, changedFiles, compareUrl, currentBranch, isGitRepo, mustGit } from './git.ts';
import { acquireLock, assertLockOwned, releaseLock } from './workspace.ts';
import { ensureDir, nowIso, readText, sleep, writeTextAtomic } from './util.ts';
import { shortId } from './message.ts';
import { appendEvent } from './events.ts';
import { ModelError } from './errors.ts';
import type { Ledger, Stage, StageEvent, TaskSpec } from './types.ts';
import type { Runtime, RuntimeCtx } from './runtime/types.ts';

export type EngineOutcome = 'done' | 'waiting_human' | 'paused' | 'partial_ship' | 'max_steps' | 'error';

export interface EngineOpts {
  ws: string;
  runtime: Runtime;
  trigger?: string;
  /** 门外等待时长；0 表示一直等（drive 模式） */
  waitMs?: number;
  maxSteps?: number;
  log?: (line: string) => void;
}

export interface EngineRun {
  outcome: EngineOutcome;
  stage: Stage;
  steps: number;
  ledger: Ledger;
  message?: string;
}

/* --------------------------- 迁移与产物登记 --------------------------- */

/**
 * 产物登记：只要文件真的存在就登记（条件产物如 plan-delta.md 只在偏离时才有），
 * 阶段归属只用于「离开该阶段前必须存在」的校验，不用于登记过滤。
 */
export function registerArtifacts(l: Ledger, ws: string, _finishedStage: Stage): void {
  for (const spec of ARTIFACTS) {
    const full = join(ws, spec.path);
    if (existsSync(full) && !l.artifacts.includes(spec.path)) l.artifacts.push(spec.path);
  }
}

/** 唯一的状态迁移入口：守卫 → 副作用 → 产物登记 → 历史追加 → 落盘 */
export function transition(l: Ledger, ev: StageEvent, ws: string): { from: Stage; to: Stage; reason: string } {
  const from = l.stage;
  const { to, transition: t } = nextStage(l, ev);
  const now = nowIso();
  const reason = t.reason(l, ev);

  applyStageEffects(l, to, ev, now);
  l.stage = to;
  registerArtifacts(l, ws, from);

  if (ev.approvals && ev.approvals.length > 0) {
    l.pending_approval.push(...ev.approvals);
    if (to === 'WAIT_SHIP') l.pending_decisions = l.pending_approval.filter((a) => a.needs_review).length;
  }

  l.history.push({
    from,
    to,
    reason,
    at: now,
    file_hashes: hashArtifacts(ws, l.artifacts),
    token: ev.token ?? null,
    approved_plan_version: ev.planVersion ?? null,
  });

  return { from, to, reason };
}

/* ------------------------------ 初始化 ------------------------------ */

export function initStage(ws: string, task: TaskSpec, l: Ledger): StageEvent {
  const repo = join(ws, 'repo');
  try {
    if (!isGitRepo(repo)) {
      return { type: 'TASK_ASSIGNED', initOk: false, reason: '工作区不是 git 仓库' };
    }
    const preferred = CFG.PRIORITY_BRANCH[task.priority] ?? task.base_branch ?? CFG.DEFAULT_BASE_BRANCH;
    const base = branchExists(repo, preferred) ? preferred : currentBranch(repo);
    const branch = CFG.BRANCH_PATTERN(CFG.AGENT_SLUG, task.key);

    if (branchExists(repo, branch)) mustGit(repo, ['checkout', branch]);
    else mustGit(repo, ['checkout', '-B', branch, base]);

    l.baseline_branch = base;
    ensureDir(join(ws, CFG.WORKSPACE_SUBDIR));
    return { type: 'TASK_ASSIGNED', initOk: true, reason: `基线 ${base}，工作分支 ${branch}` };
  } catch (e) {
    return { type: 'TASK_ASSIGNED', initOk: false, reason: (e as Error).message };
  }
}

/* ------------------------------ 消息与播报 ------------------------------ */

function announce(ws: string, l: Ledger, body: string, kind: 'normal' | 'gate_reject' | 'rework_ack' | 'final' = 'normal'): void {
  const footer = renderFooter(l);
  appendMessage(ws, {
    id: shortId(),
    role: 'agent',
    text: `${body}\n\n${footer}`,
    at: nowIso(),
    stage: l.stage,
    kind,
    footer,
    elapsed_ms: Date.now() - Date.parse(l.started_at),
  });
}

async function waitForHuman(ws: string, waitMs: number): Promise<{ id: string; text: string } | null> {
  // waitMs < 0：不等待，看一眼队列就走；= 0：一直等（常驻 driver）；> 0：等这么多毫秒
  const deadline = waitMs > 0 ? Date.now() + waitMs : (waitMs < 0 ? Date.now() : Number.POSITIVE_INFINITY);
  for (;;) {
    const m = nextHumanMessage(ws);
    if (m) return { id: m.id, text: m.text };
    if (Date.now() >= deadline) return null;
    await sleep(120);
  }
}

/* ------------------------------ 阶段超时 ------------------------------ */

/**
 * 阶段级超时：STAGE_TIMEOUT_SEC 不是摆设。
 * 超时后 abort 信号交给 Runtime 终止子进程；引擎本身不再等结果。
 * 「不再等」与「已停下」是两件事，因此超时一律落 PAUSED，交操作员确认。
 */
async function runStageWithTimeout(
  runtime: Runtime,
  ctx: RuntimeCtx,
  stage: Stage,
  trace: (s: string) => void,
): Promise<StageEvent> {
  const ms = CFG.STAGE_TIMEOUT_SEC * 1000;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  const aborted = new Promise<never>((_, reject) => {
    ac.signal.addEventListener(
      'abort',
      () => reject(new ModelError(`阶段 ${stage} 超过 ${CFG.STAGE_TIMEOUT_SEC}s 未结束`, 'STAGE_TIMEOUT')),
      { once: true },
    );
  });
  try {
    return await Promise.race([
      runtime.runStage({ ...ctx, signal: ac.signal }, stage),
      aborted,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/* --------------------------- 评审核对 --------------------------- */

/**
 * 评审结论交叉核对：**报告是凭据，模型那句话只是主张**。
 * 两者矛盾时不私自调和、也不静默选边，按报告执行并留 review_mismatch 事件。
 */
function reconcileReview(ws: string, ev: StageEvent, trace: (s: string) => void): StageEvent {
  if (ev.type !== 'REVIEW_CLEAN' && ev.type !== 'REVIEW_BLOCKING') return ev;

  const v = readReviewVerdict(ws, `${CFG.WORKSPACE_SUBDIR}/review-report.md`);

  if (ev.type === 'REVIEW_CLEAN' && !v.clean) {
    const n = Math.max(v.blocking, 1);
    trace(`评审结论与报告矛盾：runtime 报「无阻断」，报告为「${v.detail}」→ 按报告计 ${n} 项阻断`);
    appendEvent(ws, {
      kind: 'review_mismatch',
      stage: 'REVIEW',
      actor: 'engine',
      reason: `runtime=REVIEW_CLEAN，报告=${v.detail}，以报告为准`,
      detail: { reported: 'clean', report_source: v.source, blocking: n },
    });
    return {
      type: 'REVIEW_BLOCKING',
      reason: `报告有 ${n} 项阻断（结论与报告矛盾，以报告为准）`,
      blocking: n,
    };
  }

  if (ev.type === 'REVIEW_BLOCKING' && v.clean) {
    trace('评审结论与报告矛盾：runtime 报「有阻断」，报告为「无阻断」→ 按报告放行');
    appendEvent(ws, {
      kind: 'review_mismatch',
      stage: 'REVIEW',
      actor: 'engine',
      reason: `runtime=REVIEW_BLOCKING，报告=无阻断，以报告为准`,
      detail: { reported: 'blocking', report_source: v.source, claimed_blocking: ev.blocking ?? null },
    });
    return { type: 'REVIEW_CLEAN', reason: '报告无阻断（结论与报告矛盾，以报告为准）' };
  }

  return ev;
}

/* ------------------------------ 主循环 ------------------------------ */

export async function runEngine(opts: EngineOpts): Promise<EngineRun> {
  const { ws, runtime } = opts;
  const waitMs = opts.waitMs ?? 0;
  const maxSteps = opts.maxSteps ?? 200;
  const trigger = opts.trigger ?? process.env.HIFOX_TRIGGER ?? '张三';
  const log = opts.log ?? (() => {});
  const logPath = join(ws, CFG.WORKSPACE_SUBDIR, 'run.log');

  const trace = (line: string) => {
    const text = `[${new Date().toISOString()}] ${line}`;
    log(text);
    try {
      ensureDir(join(ws, CFG.WORKSPACE_SUBDIR));
      appendFileSync(logPath, text + '\n', 'utf8');
    } catch {
      /* 日志写不了不影响主流程 */
    }
  };

  acquireLock(ws);
  let steps = 0;
  try {
    let l = loadLedger(ws);
    let task = readTaskSpec(ws);
    const repo = join(ws, 'repo');

    while (true) {
      steps += 1;
      // 每轮确认锁仍属于自己：reset / 手工删除锁文件都会让「以为自己持锁」变成假象
      assertLockOwned(ws);
      if (steps > maxSteps) {
        trace(`达到 maxSteps=${maxSteps}，停在 ${l.stage}`);
        return { outcome: 'max_steps', stage: l.stage, steps, ledger: l };
      }
      saveLedger(ws, l);
      validateSafe(l, trace);

      if (l.stage === 'DONE') {
        trace('任务已处于终态 DONE');
        return { outcome: 'done', stage: l.stage, steps, ledger: l };
      }

      /* ---------- 暂停态：只接受操作员命令，不接受聊天令牌 ---------- */
      if (l.stage === 'PAUSED' || l.stage === 'PARTIAL_SHIP') {
        const cmd = takeOperatorCommand(ws);
        const want = l.stage === 'PAUSED' ? 'resume' : 'ship_retry';
        if (!cmd || cmd.kind !== want) {
          trace(`停在 ${l.stage}：${l.pause_reason ?? '等待操作员'}`);
          return {
            outcome: l.stage === 'PAUSED' ? 'paused' : 'partial_ship',
            stage: l.stage,
            steps,
            ledger: l,
            message: l.pause_reason ?? undefined,
          };
        }
        const ev: StageEvent = {
          type: want === 'resume' ? 'OPERATOR_RESUME' : 'SHIP_RETRY',
          reason: cmd.reason,
        };
        appendEvent(ws, {
          kind: 'resume',
          stage: l.stage,
          actor: 'operator',
          reason: cmd.reason,
        });
        const r = transition(l, ev, ws);
        saveLedger(ws, l);
        trace(`${r.from} → ${r.to}（${r.reason}）`);
        continue;
      }

      /* ---------- 两道门 ---------- */
      if (l.stage === 'WAIT_DEV' || l.stage === 'WAIT_SHIP') {
        const msg = await waitForHuman(ws, waitMs);
        if (!msg) {
          trace(`停在 ${l.stage}，等待人类令牌 ${l.expected_token}`);
          return { outcome: 'waiting_human', stage: l.stage, steps, ledger: l };
        }

        const decision = canAdvance(l, msg.text, ws);
        markConsumed(ws, msg.id);
        l.last_consumed_message_id = msg.id;
        trace(`收到人类消息（${msg.id}）：${msg.text.slice(0, 60)} → ${decision.kind}`);

        if (decision.kind === 'reject') {
          appendEvent(ws, {
            kind: 'gate_reject',
            stage: l.stage,
            actor: 'human',
            reason: decision.reason,
            detail: { text: msg.text.slice(0, 200) },
          });
          announce(ws, l, `${decision.reason}\n\n${describeGate(l, ws)}`, 'gate_reject');
          saveLedger(ws, l);
          continue;
        }

        if (decision.kind === 'refine') {
          appendEvent(ws, {
            kind: 'gate_refine',
            stage: l.stage,
            actor: 'human',
            reason: msg.text.slice(0, 200),
          });
          appendIdeaNote(ws, msg.text);
          const r = transition(l, { type: 'IDEA_REFINED', reason: decision.reason }, ws);
          saveLedger(ws, l);
          trace(`${r.from} → ${r.to}（${r.reason}）`);
          announce(ws, l, decision.reason);
          continue;
        }

        if (decision.kind === 'rework') {
          appendEvent(ws, {
            kind: 'rework',
            stage: l.stage,
            actor: 'human',
            reason: decision.reason,
            detail: { review_iteration: l.review_iteration },
          });
          const r = transition(l, { type: 'REWORK', reason: decision.reason }, ws);
          saveLedger(ws, l);
          trace(`${r.from} → ${r.to}（${r.reason}）`);
          announce(
            ws,
            l,
            `收到意见，不带令牌我也会改完重新出包再等你：\n> ${decision.reason}\n\n这一轮不计入授权，改完仍然是「等待提测」。`,
            'rework_ack',
          );
          continue;
        }

        // advance
        if (Object.keys(decision.decisions).length > 0) {
          l.approved_decisions = { ...l.approved_decisions, ...decision.decisions };
        }
        appendEvent(ws, {
          kind: 'gate_accept',
          stage: l.stage,
          actor: 'human',
          reason: decision.reason,
          detail: { token: decision.token, decisions: decision.decisions },
        });
        const r = transition(
          l,
          { type: 'HUMAN_MSG', reason: decision.reason, token: decision.token, planVersion: decision.planVersion },
          ws,
        );
        saveLedger(ws, l);
        trace(`${r.from} → ${r.to}（${r.reason}）`);
        continue;
      }

      /* ---------- 提测执行 ---------- */
      if (l.stage === 'SHIP') {
        assertShipPreconditions(ws);
        const branch = currentBranch(repo);
        const commit = mustGit(repo, ['rev-parse', '--short', 'HEAD']);
        const res = await ship(ws, l, task, repo, branch, commit);
        l.ship_steps = res.steps;
        writeTaskSpec(ws, task);
        task = readTaskSpec(ws);
        recordShipLog(ws, res);
        const ev: StageEvent = res.ok
          ? { type: 'SHIP_DONE', reason: `合并 ${branch} → ${l.baseline_branch}（${commit}）` }
          : { type: 'SHIP_STEP_FAIL', reason: `${res.failedStep} 失败：${res.detail ?? ''}` };
        const r = transition(l, ev, ws);
        saveLedger(ws, l);
        trace(`${r.from} → ${r.to}（${r.reason}）`);
        l.ship_steps.forEach((s) =>
          appendEvent(ws, {
            kind: 'ship_step',
            stage: 'SHIP',
            actor: 'engine',
            reason: `${s.seq}. ${s.name} → ${s.status}${s.detail ? '：' + s.detail : ''}`,
            detail: { idem_key: s.idem_key },
          }),
        );
        appendEvent(ws, {
          kind: 'stage_exit',
          stage: r.to,
          actor: 'engine',
          reason: r.reason,
          detail: { from: r.from, to: r.to },
        });
        if (res.ok) {
          const compare = compareUrl(repo, l.baseline_branch, branch);
          announce(
            ws,
            l,
            [
              `提测完成。${branch} 已合入 \`${l.baseline_branch}\`（${commit}），任务已转「待测试」。`,
              '',
              compare ? `- 对比：${compare}` : `- 对比：仓库无可识别的 Web 远端，仅记录分支名 \`${branch}\``,
              `- 回归：${task.test_cmd} 通过`,
              `- 回填：实现结果 / 测试要点 / 人工测试要求 L1`,
              `- 环境：已停`,
              `- 未部署，未关闭任务`,
            ].join('\n'),
            'final',
          );
        } else {
          announce(ws, l, `提测只完成了一部分，停在第 ${res.failedStep} 步：${res.detail ?? ''}\n任务状态未变，环境保留，可修好后重试。`);
        }
        continue;
      }

      /* ---------- 自动阶段 ---------- */
      if (l.stage === 'INIT') {
        const ev = initStage(ws, task, l);
        const r = transition(l, ev, ws);
        saveLedger(ws, l);
        trace(`${r.from} → ${r.to}（${r.reason}）`);
        continue;
      }

      const ctxPath = assembleContext(ws, l, task, l.stage, repo);
      const stageNow = l.stage;
      appendEvent(ws, { kind: 'stage_enter', stage: stageNow, actor: 'engine', detail: { skills: l.skills } });
      let ev: StageEvent;
      try {
        ev = await runStageWithTimeout(
          runtime,
          { ws, repo, task, ledger: l, trigger, promptPath: ctxPath.path, log: trace },
          stageNow,
          trace,
        );
      } catch (e) {
        const err = e as Error;
        const code = (err as { code?: string }).code ?? 'UNKNOWN';
        const isTimeout = code === 'TIMEOUT' || code === 'STAGE_TIMEOUT';
        const detail = (err as { detail?: string }).detail;
        // detail 里才是真正可操作的那句（例如 spawn ENOENT / 退出码 1 的 stderr 尾部），不许吞掉
        const full = detail ? `${err.message}（${detail}）` : err.message;
        trace(`阶段 ${stageNow} 出错：${code} ${full}`);
        appendEvent(ws, {
          kind: isTimeout ? 'stage_timeout' : 'stage_error',
          stage: stageNow,
          actor: 'runtime',
          reason: full,
          detail: { code },
        });
        ev = {
          type: 'STAGE_ERROR',
          reason: isTimeout ? `模型超时：${full}` : full,
          timeout: isTimeout,
        };
      }

      // 评审结论必须与 review-report.md 对得上，否则以报告为准
      if (stageNow === 'REVIEW') ev = reconcileReview(ws, ev, trace);

      // 「实现/修补完成」的凭据是**提交**，不是工作树里的改动：
      // 提测第一步 merge 只认提交，改动没提交时整条链会一路绿到「已提测」而实际交付零代码。
      if (
        (stageNow === 'IMPLEMENT' || stageNow === 'PATCH') &&
        (ev.type === 'CODE_DONE' || ev.type === 'PATCH_DONE')
      ) {
        const d = assertDeliverable(repo, l.baseline_branch);
        if (!d.ok) {
          trace(`阶段 ${stageNow} 判为不可交付：${d.reason}`);
          appendEvent(ws, {
            kind: 'stage_error',
            stage: stageNow,
            actor: 'engine',
            reason: d.reason,
            detail: { code: 'NOT_COMMITTED' },
          });
          ev = { type: 'STAGE_ERROR', reason: `改动不可交付：${d.reason}` };
        }
      }

      if (stageNow === 'VERIFY' && ev.type === 'VERIFY_PASS') {
        const files = changedFiles(repo, l.baseline_branch);
        const evidence = checkEvidence(ws, files);
        writeVerificationManifest(ws, {
          taskKey: task.key,
          cmd: task.test_cmd,
          code: ev.exitCode ?? 0,
          summary: ev.testSummary ?? '（见运行日志）',
          at: nowIso(),
          changedFiles: files,
          evidence,
        });
        // 测试绿了不等于证据齐：渲染层改动没截图 = 证据不足，不能进提测
        if (!evidence.ok) {
          trace(`证据不足，拦下 VERIFY_PASS：${evidence.reason}`);
          appendEvent(ws, {
            kind: 'stage_error',
            stage: 'VERIFY',
            actor: 'engine',
            reason: evidence.reason,
            detail: { code: 'EVIDENCE_MISSING', changed: files },
          });
          ev = { type: 'VERIFY_FAIL', reason: `证据不足：${evidence.reason}` };
        }
      }

      const r = transition(l, ev, ws);
      saveLedger(ws, l);
      trace(`${r.from} → ${r.to}（${r.reason}）`);
      appendEvent(ws, {
        kind: 'stage_exit',
        stage: r.to,
        actor: 'engine',
        reason: r.reason,
        detail: { from: r.from, to: r.to, review_iteration: l.review_iteration },
      });
      if (r.to === 'PAUSED' || r.to === 'PARTIAL_SHIP') {
        appendEvent(ws, { kind: 'pause', stage: r.to, actor: 'engine', reason: l.pause_reason });
      }

      if (r.to === 'WAIT_DEV' || r.to === 'WAIT_SHIP') {
        appendEvent(ws, {
          kind: 'gate_wait',
          stage: r.to,
          actor: 'engine',
          reason: `等待 ${l.expected_token}`,
        });
        announce(ws, l, `**${l.stage === 'WAIT_DEV' ? '方案就绪' : '提测包就绪'}**\n\n${describeGate(l, ws)}`);
      }
      if (r.to === 'PAUSED') {
        announce(ws, l, `已暂停：${l.pause_reason}\n\n状态不会被改成完成，等你处理后由操作员恢复。`);
      }
    }
  } catch (e) {
    const err = e as Error;
    trace(`引擎异常终止：${err.name} ${err.message}`);
    try {
      const l = loadLedger(ws);
      return { outcome: 'error', stage: l.stage, steps, ledger: l, message: err.message };
    } catch {
      return {
        outcome: 'error',
        stage: 'INIT',
        steps,
        ledger: {} as Ledger,
        message: err.message,
      };
    }
  } finally {
    releaseLock(ws);
  }
}

function validateSafe(l: Ledger, trace: (s: string) => void): void {
  try {
    validateLedger(l);
  } catch (e) {
    trace(`账本校验失败：${(e as Error).message}`);
    throw e;
  }
}

/** 方案精化：把人类补充写进 idea.md 的末尾，不动决策表本身 */
function appendIdeaNote(ws: string, note: string): void {
  const p = join(ws, CFG.WORKSPACE_SUBDIR, 'idea.md');
  if (!existsSync(p)) return;
  const prev = readText(p).trimEnd();
  const block = `\n\n## 人类补充（${nowIso()}）\n${note.trim()}\n`;
  writeTextAtomic(p, prev + block);
}
