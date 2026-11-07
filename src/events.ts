import { join } from 'node:path';
import { CFG } from './config.ts';
import { appendJsonl, nowIso, readJsonl } from './util.ts';

/**
 * 事件流：与 state.json（状态快照）互补的「发生了什么」流水。
 * - state.json 回答「现在在哪一步」，events.jsonl 回答「怎么走到这里、谁推的」
 * - 只追加，不可改；断点恢复与面板「动态」都读它
 * - 不含模型原文（那是 messages.jsonl 的事），只记引擎侧动作与判定
 */
export type EventKind =
  | 'stage_enter'
  | 'stage_exit'
  | 'stage_error'
  | 'stage_timeout'
  | 'gate_wait'
  | 'gate_reject'
  | 'gate_accept'
  | 'gate_refine'
  | 'rework'
  | 'review_mismatch'
  | 'pause'
  | 'resume'
  | 'ship_step'
  | 'context_trim'
  | 'footer_forgery'
  | 'ledger_error'
  | 'lock_denied';

export type EventActor = 'engine' | 'runtime' | 'human' | 'operator';

export interface EngineEvent {
  at: string;
  kind: EventKind;
  stage?: string;
  actor?: EventActor;
  reason?: string;
  detail?: Record<string, unknown>;
}

export function eventsPath(ws: string): string {
  return join(ws, CFG.WORKSPACE_SUBDIR, 'events.jsonl');
}

/** 事件写失败不影响主流程：它是旁路证据，不是状态真相源 */
export function appendEvent(ws: string, e: Omit<EngineEvent, 'at'> & { at?: string }): void {
  try {
    appendJsonl(eventsPath(ws), { at: e.at ?? nowIso(), ...e });
  } catch {
    /* 旁路证据，写不了就算了 */
  }
}

export function readEvents(ws: string): EngineEvent[] {
  try {
    return readJsonl<EngineEvent>(eventsPath(ws));
  } catch {
    return [];
  }
}

/** 面板「动态」用：按时间倒序取最近 n 条 */
export function recentEvents(ws: string, n = 30): EngineEvent[] {
  return readEvents(ws).slice(-n).reverse();
}
