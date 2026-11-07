import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CFG } from './config.ts';
import { StateError } from './errors.ts';
import {
  ensureDir, nowIso, readJson, readJsonl, appendJsonl, sha256File,
  writeJsonAtomic, readText,
} from './util.ts';
import { GATE_STAGES } from './types.ts';
import type { HumanMessage, Ledger, TaskSpec } from './types.ts';

export function latticeDir(ws: string): string {
  return join(ws, CFG.WORKSPACE_SUBDIR);
}
export function statePath(ws: string): string {
  return join(latticeDir(ws), 'state.json');
}
export function messagesPath(ws: string): string {
  return join(latticeDir(ws), 'messages.jsonl');
}
export function consumedPath(ws: string): string {
  return join(latticeDir(ws), 'consumed.json');
}
export function operatorPath(ws: string): string {
  return join(latticeDir(ws), 'operator.json');
}
export function lockPath(ws: string): string {
  return join(latticeDir(ws), '.lock');
}
export function taskSpecPath(ws: string): string {
  return join(ws, 'task.json');
}

export function createLedger(task: TaskSpec, ws: string, baseline: string): Ledger {
  const now = nowIso();
  return {
    schema_version: 1,
    task_id: task.key,
    track: CFG.DEFAULT_TRACK,
    stage: 'INIT',
    waiting: null,
    copy_touched: false,
    // INIT 不是门，账本一建立就处在「进行中」；门字段与等待态只在 WAIT_* 同时出现
    status: '进行中',
    expected_token: null,
    review_iteration: 0,
    pending_decisions: 0,
    skills: [],
    artifacts: [],
    approved_decisions: {},
    pending_approval: [],
    verification_status: {},
    baseline_branch: baseline,
    agent_slug: CFG.AGENT_SLUG,
    workspace_path: ws,
    last_consumed_message_id: null,
    ship_steps: [],
    rework_count: 0,
    started_at: now,
    finished_at: null,
    paused_from: null,
    pause_reason: null,
    history: [],
  };
}

export function loadLedger(ws: string): Ledger {
  const p = statePath(ws);
  if (!existsSync(p)) throw new StateError(`账本不存在：${p}`, 'NO_LEDGER');
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    throw new StateError(`账本不是合法 JSON：${(e as Error).message}`, 'BAD_JSON');
  }
  return raw as Ledger;
}

export function hasLedger(ws: string): boolean {
  return existsSync(statePath(ws));
}

export function saveLedger(ws: string, l: Ledger): void {
  ensureDir(latticeDir(ws));
  writeJsonAtomic(statePath(ws), l);
}

/** 产物哈希：只对账本里登记过的产物求值，缺失的记为 MISSING */
export function hashArtifacts(ws: string, paths: string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of paths) {
    const full = join(ws, p);
    out[p] = existsSync(full) ? sha256File(full) : 'MISSING';
  }
  return out;
}

/**
 * 不变量 I1~I8。违反任意一条即 StateError，引擎立刻停止并拒绝写入。
 */
export function validateLedger(l: Ledger): void {
  if (l.schema_version !== 1) throw new StateError(`schema_version 应为 1，实为 ${l.schema_version}`, 'I0');

  // I1 history 末条的 to 等于 stage
  if (l.history.length > 0) {
    const last = l.history[l.history.length - 1];
    if (last.to !== l.stage) {
      throw new StateError(`I1 违例：history 末条指向 ${last.to}，账本却是 ${l.stage}`, 'I1');
    }
  }

  // I2 waiting / expected_token / status 三者同生同灭
  const waiting = l.waiting !== null && l.waiting !== '';
  const expects = l.expected_token !== null && l.expected_token !== '';
  const isWaiting = l.status === '等待确认';
  if (!(waiting === expects && expects === isWaiting)) {
    throw new StateError(
      `I2 违例：waiting=${String(l.waiting)} expected=${String(l.expected_token)} status=${l.status}`,
      'I2',
    );
  }

  // I3 只有门阶段允许 waiting 非空
  if (waiting && !GATE_STAGES.includes(l.stage)) {
    throw new StateError(`I3 违例：${l.stage} 不是门阶段却带着等待令牌`, 'I3');
  }

  // I4 轨道不得为空串
  if (typeof l.track !== 'string' || l.track.trim() === '') {
    throw new StateError('I4 违例：轨道为空', 'I4');
  }

  // I5 迭代计数在 0..6
  const patches = l.history.filter((h) => h.to === 'PATCH').length;
  if (l.review_iteration < 0 || l.review_iteration > CFG.MAX_LOOP) {
    throw new StateError(`I5 违例：评审迭代 ${l.review_iteration} 越界`, 'I5');
  }
  if (l.review_iteration < patches) {
    throw new StateError(`I5 违例：评审迭代 ${l.review_iteration} 小于历史修补次数 ${patches}`, 'I5');
  }

  // I6 待决决策数非负
  if (l.pending_decisions < 0) throw new StateError('I6 违例：待决决策为负', 'I6');

  // I7 登记过的产物必须存在，且与最近一次记录的哈希一致
  const lastHashes = l.history.length > 0 ? l.history[l.history.length - 1].file_hashes : undefined;
  for (const p of l.artifacts) {
    const full = join(l.workspace_path, p);
    if (!existsSync(full)) throw new StateError(`I7 违例：产物缺失 ${p}`, 'I7');
    if (lastHashes && lastHashes[p] && lastHashes[p] !== 'MISSING') {
      const cur = sha256File(full);
      if (cur !== lastHashes[p]) {
        throw new StateError(`I7 违例：产物被外部修改 ${p}（哈希不符）`, 'I7');
      }
    }
  }

  // I8 终态必须干净
  if (l.stage === 'DONE') {
    if (l.waiting !== null || l.expected_token !== null || l.status !== '已完成') {
      throw new StateError('I8 违例：DONE 阶段仍带门字段或状态不是已完成', 'I8');
    }
  }
}

/* ------------------------------ 消息存储 ------------------------------ */

export function appendMessage(ws: string, msg: HumanMessage): void {
  appendJsonl(messagesPath(ws), msg);
}

export function readMessages(ws: string): HumanMessage[] {
  return readJsonl<HumanMessage>(messagesPath(ws));
}

export function consumedIds(ws: string): string[] {
  return readJson<{ ids: string[] }>(consumedPath(ws), { ids: [] }).ids;
}

export function markConsumed(ws: string, id: string): void {
  const cur = readJson<{ ids: string[] }>(consumedPath(ws), { ids: [] });
  if (!cur.ids.includes(id)) cur.ids.push(id);
  writeJsonAtomic(consumedPath(ws), cur);
}

export function isConsumed(ws: string, id: string): boolean {
  return consumedIds(ws).includes(id);
}

/** 取下一条未被消费的人类消息（引擎只消费 role=human） */
export function nextHumanMessage(ws: string): HumanMessage | null {
  const consumed = new Set(consumedIds(ws));
  for (const m of readMessages(ws)) {
    if (m.role !== 'human') continue;
    if (consumed.has(m.id)) continue;
    return m;
  }
  return null;
}

/* ------------------------------ 任务单 ------------------------------ */

export function readTaskSpec(ws: string): TaskSpec {
  const t = readJson<TaskSpec | null>(taskSpecPath(ws), null);
  if (!t) throw new StateError(`任务单不存在：${taskSpecPath(ws)}`, 'NO_TASK');
  return t;
}

export function writeTaskSpec(ws: string, t: TaskSpec): void {
  writeJsonAtomic(taskSpecPath(ws), t);
}

/** 操作员命令（非聊天令牌，用于 PAUSED / PARTIAL_SHIP 的出口） */
export interface OperatorCommand {
  kind: 'resume' | 'ship_retry';
  reason: string;
  at: string;
  consumed?: boolean;
}

export function writeOperatorCommand(ws: string, cmd: OperatorCommand): void {
  writeJsonAtomic(operatorPath(ws), cmd);
}

export function takeOperatorCommand(ws: string): OperatorCommand | null {
  const p = operatorPath(ws);
  if (!existsSync(p)) return null;
  const cmd = readJson<OperatorCommand | null>(p, null);
  if (!cmd) return null;
  writeFileSync(p, JSON.stringify({ ...cmd, consumed: true }, null, 2) + '\n', 'utf8');
  return cmd.consumed ? null : cmd;
}

export function readRawState(ws: string): string {
  return readText(statePath(ws));
}
