import { readText } from './util.ts';
import { join } from 'node:path';

export interface DecisionSheet {
  [q: string]: { options: string[]; recommended: string | null; titles: Record<string, string> };
}

/**
 * 解析 idea.md 里的决策表。
 *
 * 只约定「有一列写着 `1A`/`2B`（题号 + 选项）」，**不假设它是第几列、表有几列**：
 * 案例截图里是紧凑的 3 列表，真实模型往往写成 7 列（编号/决策点/选项/做法/影响/成本/建议）。
 * 早期版本按「第 2 列必须是 1A」写死，结果只认自己 mock 生成的那张表——
 * 真实模型一跑，Q1 就被判成「没有选项 A」。
 */
export function parseDecisionSheet(ws: string, ideaPath: string): DecisionSheet {
  const text = readText(join(ws, ideaPath));
  const sheet: DecisionSheet = {};

  for (const line of text.split('\n')) {
    const raw = line.trim();
    if (!raw.startsWith('|')) continue;
    const cells = raw.split('|').map((c) => c.trim());

    let idx = -1;
    let q = '';
    let key = '';
    for (let i = 1; i < cells.length; i++) {
      const m = cells[i].match(/^([1-9])([A-Z])$/);
      if (m) {
        idx = i;
        q = m[1];
        key = m[2];
        break;
      }
    }
    if (idx < 0) continue;

    // 标签取选项单元格之后的第一个非空单元格；没有就退回键本身
    let label = '';
    for (let i = idx + 1; i < cells.length; i++) {
      if (cells[i]) {
        label = cells[i].replace(/[✅⚠️📌]|（推荐）|\(推荐\)/g, '').trim();
        break;
      }
    }

    sheet[q] ??= { options: [], recommended: null, titles: {} };
    if (!sheet[q].options.includes(key)) sheet[q].options.push(key);
    if (label) sheet[q].titles[key] = label;

    // 推荐/高风险标记可能在任意一列（截图里跟在选项后，真实表里常在末尾「建议」列）
    if (/✅/.test(raw) || /（推荐）|\(推荐\)/.test(raw)) sheet[q].recommended = key;
  }

  return sheet;
}

export function recommendedMap(sheet: DecisionSheet): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [q, v] of Object.entries(sheet)) {
    if (v.recommended) out[q] = v.recommended;
  }
  return out;
}

export function optionsMap(sheet: DecisionSheet): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [q, v] of Object.entries(sheet)) out[q] = v.options;
  return out;
}

export function describeSheet(sheet: DecisionSheet): string {
  const lines: string[] = [];
  for (const q of Object.keys(sheet).sort()) {
    const v = sheet[q];
    const opts = v.options
      .map((k) => `${k}=${v.titles[k] ?? ''}${k === v.recommended ? '（推荐）' : ''}`)
      .join(' / ');
    lines.push(`Q${q}: ${opts}`);
  }
  return lines.join('；');
}
