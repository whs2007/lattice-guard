import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { CFG } from './config.ts';
import { ToolError } from './errors.ts';

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export function git(cwd: string, args: string[], env: Record<string, string> = {}): GitResult {
  try {
    const stdout = execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
      timeout: CFG.TOOL_TIMEOUT_SEC * 1000,
    });
    return { ok: true, stdout: stdout.trim(), stderr: '' };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      stdout: (err.stdout ?? '').toString().trim(),
      stderr: (err.stderr ?? err.message ?? '').toString().trim(),
    };
  }
}

export function mustGit(cwd: string, args: string[], env: Record<string, string> = {}): string {
  const r = git(cwd, args, env);
  if (!r.ok) throw new ToolError(`git ${args.join(' ')} 失败`, r.stderr.slice(-2000));
  return r.stdout;
}

/**
 * 判断 dir 自身是不是仓库根。
 * 不能用 `rev-parse --git-dir`：它向上查找，会把「仓库里的某个普通子目录」误判成仓库。
 * 这个误判有真实后果——把示例仓库放进本仓库再提交后，新克隆者会以为
 * examples/demo-repo 自带 .git，于是走 clone 路径并失败。
 */
export function isGitRepo(dir: string): boolean {
  if (existsSync(`${dir}/.git`)) return true;
  const r = git(dir, ['rev-parse', '--show-toplevel']);
  if (!r.ok) return false;
  const norm = (p: string) => resolve(p).replace(/\\/g, '/').replace(/\/+$/, '');
  const a = norm(r.stdout.trim());
  const b = norm(dir);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function currentBranch(repo: string): string {
  return mustGit(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
}

export function branchExists(repo: string, branch: string): boolean {
  return git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).ok;
}

export function hasChanges(repo: string): boolean {
  return mustGit(repo, ['status', '--porcelain']).trim().length > 0;
}

/** 当前分支超出 base 的提交数（0 表示「一行都没提交」） */
export function commitsAhead(repo: string, base: string): number {
  const r = git(repo, ['rev-list', '--count', `${base}..HEAD`]);
  if (!r.ok) return 0;
  return Number(r.stdout.trim() || '0');
}

/**
 * 「这次改动能不能交付」的唯一判据。
 *
 * 为什么必须有这道判据：提测七步的第一步是 `merge <branch> → <base>`，
 * 而 merge 只认**提交**。工作树里躺着未提交的改动时，测试照样能绿、
 * 产物照样齐全、状态照样能推到「已提测」——但合进去的是空气。
 * 早期版本没有这道闸，真实 CLI 跑完一整条链，交付物是零。
 */
export function assertDeliverable(repo: string, base: string): { ok: boolean; reason?: string } {
  const dirty = git(repo, ['status', '--porcelain']).stdout.trim();
  if (dirty) {
    const files = dirty.split('\n').filter(Boolean);
    const shown = files.slice(0, 5).join(' / ');
    const more = files.length > 5 ? ` 等 ${files.length} 个` : '';
    return { ok: false, reason: `工作区还有未提交的改动：${shown}${more}` };
  }
  const n = commitsAhead(repo, base);
  if (n === 0) {
    return { ok: false, reason: `分支上没有超出 \`${base}\` 的提交，等于什么都没改` };
  }
  return { ok: true };
}

export function diffStat(repo: string, base = 'HEAD'): { files: number; insertions: number; deletions: number; text: string } {
  const text = mustGit(repo, ['diff', '--stat', base]);
  const files = (mustGit(repo, ['diff', '--name-only', base]).split('\n').filter(Boolean)).length;
  let insertions = 0;
  let deletions = 0;
  for (const m of text.matchAll(/(\d+) insertions?\(\+\)/g)) insertions += Number(m[1]);
  for (const m of text.matchAll(/(\d+) deletions?\(-\)/g)) deletions += Number(m[1]);
  return { files, insertions, deletions, text };
}

/** 提交作者写成「触发人 & Agent」（A106） */
export function commitAll(repo: string, message: string, trigger: string): string {
  mustGit(repo, ['add', '-A']);
  mustGit(repo, ['commit', '-m', message], {
    GIT_AUTHOR_NAME: `${trigger} & ${CFG.AGENT_NAME}`,
    GIT_AUTHOR_EMAIL: `${CFG.AGENT_SLUG}@hifox.local`,
  });
  return mustGit(repo, ['rev-parse', '--short', 'HEAD']);
}

/**
 * 合并 source → target，并保证**无论成败都回到原分支、工作树干净**。
 * 失败的合并必须先 `merge --abort`：否则仓库停在 MERGING 状态，
 * 下一次续跑（PARTIAL_SHIP → SHIP）的第一个 git 命令就会失败，重试永远救不回来。
 */
export function mergeInto(repo: string, source: string, target: string): GitResult & { aborted: boolean } {
  const back = currentBranch(repo);

  const co = git(repo, ['checkout', target]);
  if (!co.ok) {
    return { ok: false, stdout: '', stderr: `切到 ${target} 失败：${co.stderr}`, aborted: false };
  }

  const r = git(repo, ['merge', '--no-ff', source, '-m', `merge ${source} into ${target}`]);
  let aborted = false;

  if (!r.ok) {
    const ab = git(repo, ['merge', '--abort']);
    aborted = ab.ok;
    if (!aborted) {
      // 极端情况（合并到一半被杀）：退回到目标分支的 HEAD，至少不留脏树
      git(repo, ['reset', '--hard', 'HEAD']);
      aborted = git(repo, ['rev-parse', '--git-path', 'MERGE_HEAD']).ok === false;
    }
  }

  if (back && back !== target) git(repo, ['checkout', back]);
  return { ...r, aborted };
}

/** 两个 ref 之间改动的文件（三点 diff，不含 target 上独有的提交） */
export function changedFiles(repo: string, from: string, to = 'HEAD'): string[] {
  const r = git(repo, ['diff', '--name-only', `${from}...${to}`]);
  if (!r.ok) return [];
  return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}

/**
 * Compare 链接：S16/S18 的提测消息里都有「对比」链接。
 * 没有可识别的 Web 远端（本地路径 / file:// / 无 origin）时返回 null，
 * 由调用方降级成只写分支名 —— 不编造一个看起来合理的假链接。
 */
export function compareUrl(repo: string, base: string, branch: string): string | null {
  const r = git(repo, ['config', '--get', 'remote.origin.url']);
  const raw = r.ok ? r.stdout.trim() : '';
  if (!raw) return null;

  let url = raw.replace(/\.git$/, '');
  url = url.replace(/^git@([^:]+):/, 'https://$1/'); // git@host:owner/repo
  if (!/^https?:\/\//i.test(url)) return null;

  const q = (s: string) => s.split('/').map(encodeURIComponent).join('/');
  if (/github\.com/i.test(url)) return `${url}/compare/${q(base)}...${q(branch)}?expand=1`;
  if (/gitlab/i.test(url)) return `${url}/-/compare/${q(base)}...${q(branch)}`;
  return `${url}/compare/${q(base)}...${q(branch)}`;
}
