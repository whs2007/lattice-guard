import { CFG, TOKENS } from './config.ts';

export interface ParsedMessage {
  /** 末位令牌；没有则 null */
  token: string | null;
  /** 令牌后面的裸文本（去掉令牌） */
  body: string;
  /** 形如 1A 2A 3A 的选择 */
  picks: Record<string, string>;
  raw: string;
}

/**
 * 令牌解析。
 * 铁律：令牌必须位于消息末尾才算授权（A24/A113 的最严解释）。
 * 「【进入开发】帮我看一下」不算；「帮我看一下【进入开发】」算。
 */
export function parseHumanMessage(raw: string, strictTail = CFG.GATE_STRICT_TAIL): ParsedMessage {
  const s = raw.replace(/\s+$/, '');
  const m = s.match(/(【[^】]{1,12}】)\s*$/);

  let token: string | null = null;
  let body = s;

  if (m) {
    const candidate = m[1];
    const isKnown = TOKENS.includes(candidate);
    const atEnd = !strictTail || (m.index ?? 0) + m[0].length === s.length;
    if (isKnown && atEnd) {
      token = candidate;
      body = s.slice(0, m.index).trim();
    } else if (isKnown) {
      // 令牌出现在句中：不算授权，但保留原文供拒绝说明
      body = s;
    }
  }

  const picks: Record<string, string> = {};
  for (const hit of body.matchAll(/([1-9])\s*([A-Z])(?![A-Za-z0-9])/g)) {
    picks[hit[1]] = hit[2];
  }

  return { token, body, picks, raw: s };
}

/** 「只发【进入开发】表示全部按推荐项」——把 picks 补齐为全推荐 */
export function resolvePicks(
  picks: Record<string, string>,
  recommended: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [q, rec] of Object.entries(recommended)) {
    out[q] = picks[q] ?? rec;
  }
  return out;
}

/** 人类回复是否指向了不存在的选项（用于回「Q1 没有选项 D」） */
export function invalidPicks(
  picks: Record<string, string>,
  options: Record<string, string[]>,
): Array<{ q: string; key: string; available: string[] }> {
  const bad: Array<{ q: string; key: string; available: string[] }> = [];
  for (const [q, key] of Object.entries(picks)) {
    const avail = options[q];
    if (!avail) bad.push({ q, key, available: [] });
    else if (!avail.includes(key)) bad.push({ q, key, available: avail });
  }
  return bad;
}

export function shortId(): string {
  return Math.random().toString(36).slice(2, 10);
}
