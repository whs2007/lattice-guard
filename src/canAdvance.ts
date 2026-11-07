import { CFG } from './config.ts';
import { StateError } from './errors.ts';
import { artifactsOfStage, checkArtifacts } from './artifacts.ts';
import { parseDecisionSheet, recommendedMap, optionsMap, describeSheet } from './decisions.ts';
import { invalidPicks, parseHumanMessage, resolvePicks } from './message.ts';
import { sha256File } from './util.ts';
import { join } from 'node:path';
import type { Ledger } from './types.ts';

export type GateResult =
  | {
      kind: 'advance';
      token: string;
      decisions: Record<string, string>;
      planVersion: string;
      reason: string;
    }
  | { kind: 'refine'; reason: string }
  | { kind: 'rework'; reason: string }
  | { kind: 'reject'; reason: string };

/**
 * 门禁：只负责「这道门能不能过」。
 * 自动阶段的迁移一律交给 nextStage，本函数不处理。
 */
export function canAdvance(l: Ledger, rawText: string, ws: string): GateResult {
  const parsed = parseHumanMessage(rawText);

  if (l.stage === 'WAIT_DEV') {
    if (parsed.token !== CFG.TOKEN_DEV) {
      if (parsed.token) {
        return { kind: 'reject', reason: `这扇门等的是${CFG.TOKEN_DEV}，收到的是${parsed.token}，未解锁。` };
      }
      if (parsed.body.length === 0) {
        return { kind: 'reject', reason: `需要明确授权：发送 ${CFG.TOKEN_DEV} 才会进入实现。` };
      }
      // 「继续」「可以」这类自然语言不算授权（官方口径），也不该被当成方案补充
      if (isBareAck(parsed.body)) {
        return {
          kind: 'reject',
          reason: `「${parsed.body}」不算授权：修改产品代码需要固定说法 ${CFG.TOKEN_DEV}。`,
        };
      }
      return {
        kind: 'refine',
        reason: `已记下你的补充，方案已更新，仍未解锁。要进入开发请发送 ${CFG.TOKEN_DEV}。`,
      };
    }

    // 令牌有效 → 校验上游（DIAGNOSE）产物
    const check = checkArtifacts(ws, artifactsOfStage('DIAGNOSE'));
    if (!check.ok) {
      const list = [...check.missing, ...check.problems].join('；');
      return { kind: 'reject', reason: `令牌有效，但上游产物不齐，不能进入实现：${list}` };
    }

    const sheet = parseDecisionSheet(ws, `${CFG.WORKSPACE_SUBDIR}/idea.md`);
    const picks = resolvePicks(parsed.picks, recommendedMap(sheet));
    const bad = invalidPicks(parsed.picks, optionsMap(sheet));
    if (bad.length > 0) {
      const b = bad[0];
      const avail = b.available.length ? b.available.join('/') : '无';
      return { kind: 'reject', reason: `Q${b.q} 没有选项 ${b.key}，当前可选 ${avail}。` };
    }

    const decided = Object.entries(picks)
      .map(([q, k]) => `${q}${k}`)
      .join(' ');
    return {
      kind: 'advance',
      token: CFG.TOKEN_DEV,
      decisions: picks,
      planVersion: sha256File(join(ws, CFG.WORKSPACE_SUBDIR, 'idea.md')),
      reason: decided ? `${decided}` : '全部按推荐项',
    };
  }

  if (l.stage === 'WAIT_SHIP') {
    if (parsed.token === CFG.TOKEN_SHIP) {
      const check = checkArtifacts(ws, artifactsOfStage('VERIFY'));
      if (!check.ok) {
        const list = [...check.missing, ...check.problems].join('；');
        return { kind: 'reject', reason: `令牌有效，但提测包不齐：${list}` };
      }
      return {
        kind: 'advance',
        token: CFG.TOKEN_SHIP,
        decisions: {},
        planVersion: sha256File(join(ws, CFG.WORKSPACE_SUBDIR, 'idea.md')),
        reason: '开始提测七步',
      };
    }

    if (parsed.token) {
      return { kind: 'reject', reason: `这扇门等的是${CFG.TOKEN_SHIP}，收到的是${parsed.token}，未解锁。` };
    }

    if (parsed.body.trim().length > 0) {
      return { kind: 'rework', reason: parsed.body.trim().slice(0, 120) };
    }

    return { kind: 'reject', reason: `请给出具体意见，或发送 ${CFG.TOKEN_SHIP} 授权提测。` };
  }

  throw new StateError(`canAdvance 只处理两道门，当前阶段是 ${l.stage}`);
}

/** 「继续 / 可以 / 好 / ok」这类裸确认：既不算授权，也当不成方案补充 */
function isBareAck(body: string): boolean {
  const t = body.replace(/[\s，。、！!~～]/g, '');
  return /^(继续|可以|行|好|好的|嗯|OK|ok|Ok|同意|没问题|收到|开始吧|开工)$/.test(t);
}

/** 门拒绝时的完整回复文案（正文 + 契约说明，不含页脚） */
export function describeGate(l: Ledger, ws: string): string {
  if (l.stage === 'WAIT_DEV') {
    const sheet = parseDecisionSheet(ws, `${CFG.WORKSPACE_SUBDIR}/idea.md`);
    return [
      `方案已就绪，等你确认。当前决策项：${describeSheet(sheet) || '（无）'}`,
      `回复 ${CFG.TOKEN_DEV} 表示全部按推荐项；要改某几项就写成 1A 2A 3A ${CFG.TOKEN_DEV}。`,
      `只发「继续」「可以」这类话不会解锁。`,
    ].join('\n');
  }
  return [
    '提测包已就绪，等你授权。',
    `回复 ${CFG.TOKEN_SHIP} 我会合并到 ${l.baseline_branch}、跑回归、回填任务字段、把任务移到待测试；不部署。`,
    '有意见就直接写，我会改完重新出包，不消耗授权。',
  ].join('\n');
}
