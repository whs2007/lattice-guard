import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 代码与历史检索（规格书功能地图 P0 第 15 项）。
 *
 * 为什么单独一个模块：诊断阶段最容易「凭感觉说根因」。作者的做法是让 Agent 真的去
 * 定位文件、翻历史工单、统计既有先例。这些能力必须由引擎提供，否则模型只能编。
 *
 * 全部只读：不 checkout、不 stash、不改 index。
 */

function run(repo: string, args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd: repo,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    return '';
  }
}

/** 最近的提交（含作者与日期），用于「这个模块最近被谁改过」 */
export function recentCommits(repo: string, n = 20): string {
  return run(repo, ['log', `-n${n}`, '--pretty=format:%h %ad %an %s', '--date=short']).trim();
}

/** 提交信息里出现过的历史工单号（HF-14690 这种），按出现次数排序 */
export function ticketRefs(repo: string, limit = 200, top = 15): Array<{ key: string; count: number }> {
  const log = run(repo, ['log', `-n${limit}`, '--pretty=format:%s']);
  const map = new Map<string, number>();
  for (const m of log.matchAll(/\b([A-Z][A-Z0-9]{1,9}-\d{1,7})\b/g)) {
    map.set(m[1], (map.get(m[1]) ?? 0) + 1);
  }
  return [...map.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, top);
}

/** 改动最频繁的文件（既有先例统计），用于判断「这类改动一般动几个文件」 */
export function hotspots(repo: string, limit = 200, top = 12): Array<{ file: string; count: number }> {
  const log = run(repo, ['log', `-n${limit}`, '--name-only', '--pretty=format:']);
  const map = new Map<string, number>();
  for (const line of log.split('\n')) {
    const f = line.trim();
    if (!f) continue;
    map.set(f, (map.get(f) ?? 0) + 1);
  }
  return [...map.entries()]
    .map(([file, count]) => ({ file, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, top);
}

/** 某文件的历史（谁在什么时候因为什么改过它） */
export function fileHistory(repo: string, file: string, n = 10): string {
  return run(repo, ['log', `-n${n}`, '--pretty=format:%h %ad %an %s', '--date=short', '--', file]).trim();
}

/**
 * 全文检索。优先用 `git grep`（只搜已跟踪文件，与「仓库既有内容」的语义一致）；
 * 仓库为空或无匹配时返回空，不抛错。
 */
export function searchCode(
  repo: string,
  keyword: string,
  opts: { maxHits?: number; glob?: string } = {},
): Array<{ file: string; line: number; text: string }> {
  if (!keyword.trim()) return [];
  const maxHits = opts.maxHits ?? 60;
  const args = ['grep', '-n', '-I', '--no-color', '-F', '-e', keyword];
  if (opts.glob) args.push('--', opts.glob);
  const out = run(repo, args);
  if (!out) return [];
  return out
    .split('\n')
    .filter(Boolean)
    .slice(0, maxHits)
    .map((line) => {
      const m = line.match(/^([^:]+):(\d+):(.*)$/);
      return m ? { file: m[1], line: Number(m[2]), text: m[3].trim() } : { file: '', line: 0, text: line };
    })
    .filter((h) => h.file);
}

/** 从任务描述里抠出可能的关键词（标识符、文件名、引号内短语、中文短语） */
export function extractKeywords(text: string, max = 6): string[] {
  const out: string[] = [];
  const push = (s: string) => {
    const t = s.trim();
    if (t.length >= 2 && !out.includes(t)) out.push(t);
  };
  for (const m of text.matchAll(/`([^`]{2,40})`/g)) push(m[1]);
  for (const m of text.matchAll(/[\w./-]+\.(?:tsx?|jsx?|vue|py|go|java|rs|css|scss|json|md)\b/g)) push(m[0]);
  for (const m of text.matchAll(/\b[a-z][a-zA-Z0-9]{3,}(?:[A-Z][a-zA-Z0-9]+)+\b/g)) push(m[0]);
  for (const m of text.matchAll(/[\u4e00-\u9fa5]{4,12}/g)) push(m[0]);
  return out.slice(0, max);
}

export interface RepoIntel {
  repo: string;
  keywords: string[];
  commits: string;
  tickets: Array<{ key: string; count: number }>;
  hotspots: Array<{ file: string; count: number }>;
  searches: Array<{ keyword: string; hits: Array<{ file: string; line: number; text: string }> }>;
}

/** 一次汇总，供上下文组装与 CLI 使用 */
export function collectIntel(
  repo: string,
  keywords: string[],
  opts: { maxHitsPerKeyword?: number } = {},
): RepoIntel {
  return {
    repo,
    keywords,
    commits: recentCommits(repo, 20),
    tickets: ticketRefs(repo),
    hotspots: hotspots(repo),
    searches: keywords.map((k) => ({
      keyword: k,
      hits: searchCode(repo, k, { maxHits: opts.maxHitsPerKeyword ?? 12 }),
    })),
  };
}

/** 渲染成给模型看的 Markdown 块（不放 JSON，模型读 markdown 更稳） */
export function renderIntel(intel: RepoIntel): string {
  const lines: string[] = [];

  lines.push(`### 最近提交（仓库 ${intel.repo}）`);
  lines.push(intel.commits || '（无历史）');

  lines.push('', '### 历史工单引用');
  lines.push(
    intel.tickets.length > 0
      ? intel.tickets.map((t) => `- ${t.key}（出现 ${t.count} 次）`).join('\n')
      : '（提交信息里没有形如 XX-123 的工单号）',
  );

  lines.push('', '### 改动热点（既有先例）');
  lines.push(
    intel.hotspots.length > 0
      ? intel.hotspots.map((h) => `- ${h.file}：${h.count} 次`).join('\n')
      : '（无历史）',
  );

  lines.push('', '### 关键词检索');
  for (const s of intel.searches) {
    lines.push(`#### \`${s.keyword}\``);
    if (s.hits.length === 0) {
      lines.push('- 无匹配（**这不等于不存在相关逻辑**，只说明该关键词没有字面命中）');
      continue;
    }
    for (const h of s.hits) lines.push(`- ${h.file}:${h.line} — ${h.text.slice(0, 180)}`);
  }

  lines.push(
    '',
    '> 以上是引擎跑出来的真实检索结果，可以直接引用。',
    '> 不要在产物里写「全仓未发现」这类结论，除非检索结果真的为空，并且写清检索词。',
  );
  return lines.join('\n');
}

/** 文件是否在仓库里（用于校验模型引用的路径是否编造） */
export function fileExistsInRepo(repo: string, rel: string): boolean {
  return existsSync(join(repo, rel));
}

/** 读取仓库某文件的片段（诊断时给模型看实现，避免它凭空猜） */
export function readRepoFile(repo: string, rel: string, maxChars = 8000): string {
  try {
    const text = readFileSync(join(repo, rel), 'utf8');
    return text.length > maxChars ? text.slice(0, maxChars) + '\n…（已截断）' : text;
  } catch {
    return '';
  }
}
