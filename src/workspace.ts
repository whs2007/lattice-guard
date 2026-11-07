import { closeSync, cpSync, existsSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CFG } from './config.ts';
import { StateError } from './errors.ts';
import { createLedger, latticeDir, lockPath, saveLedger, writeTaskSpec, taskSpecPath } from './ledger.ts';
import { ensureDir, nowIso, readJson } from './util.ts';
import { branchExists, git, isGitRepo } from './git.ts';
import type { Ledger, TaskSpec } from './types.ts';

export interface BootstrapInput {
  ws: string;
  task: TaskSpec;
  /** 仓库来源：本地路径或 URL */
  repoSource: string;
}

export function defaultTask(patch: Partial<TaskSpec> & { key: string }): TaskSpec {
  return {
    key: patch.key,
    title: patch.title ?? patch.key,
    description: patch.description ?? '',
    space: patch.space ?? '产品空间',
    type: patch.type ?? '缺陷',
    priority: patch.priority ?? '普通',
    labels: patch.labels ?? ['bugfix'],
    status: patch.status ?? 'In Progress',
    repo: patch.repo ?? '',
    base_branch: patch.base_branch ?? CFG.DEFAULT_BASE_BRANCH,
    test_cmd: patch.test_cmd ?? 'node --test',
    patch_ops: patch.patch_ops ?? [],
    review_blocking_rounds: patch.review_blocking_rounds ?? 0,
    custom_fields: patch.custom_fields ?? {},
    env: patch.env ?? { running: false, port: null },
  };
}

/**
 * 建立任务工作区：<ws>/repo 是 git 工作副本，<ws>/task.json 是任务单，
 * <ws>/.xwing-task/lattice/ 放账本与产物。
 */
export function bootstrapTask(input: BootstrapInput): { ws: string; repo: string; ledger: Ledger; task: TaskSpec } {
  const { ws, task } = input;
  const repo = join(ws, 'repo');
  ensureDir(ws);
  ensureDir(latticeDir(ws));

  const base = CFG.PRIORITY_BRANCH[task.priority] ?? task.base_branch ?? CFG.DEFAULT_BASE_BRANCH;

  let freshInit = false;
  if (!existsSync(repo)) {
    if (isGitRepo(input.repoSource)) {
      const r = git(process.cwd(), ['clone', '--quiet', input.repoSource, repo]);
      if (!r.ok) throw new StateError(`仓库克隆失败：${r.stderr || r.stdout}`, 'CLONE_FAIL');
    } else {
      // 来源是普通目录（随仓库分发的示例仓库就是这种）：复制后自建基线分支。
      // 不要求用户先手工 git init —— 否则「换个文件夹当修复靶子」得先读一遍文档。
      if (!existsSync(input.repoSource)) {
        throw new StateError(`仓库来源不存在：${input.repoSource}`, 'NO_SOURCE');
      }
      cpSync(input.repoSource, repo, {
        recursive: true,
        filter: (src) => !/[\\/](\.git|node_modules)$/.test(src),
      });
      const init = git(repo, ['init', '--quiet', '-b', base]);
      if (!init.ok) throw new StateError(`仓库初始化失败：${init.stderr || init.stdout}`, 'INIT_FAIL');
      freshInit = true;
    }
  }
  if (!isGitRepo(repo)) throw new StateError(`${repo} 不是 git 仓库`, 'NOT_REPO');

  // committer 始终来自本机 git 配置（平台不覆盖 GIT_COMMITTER_*）。
  // 克隆出来的仓库没有本地配置时补一份，避免提交失败。
  if (!git(repo, ['config', 'user.name']).stdout) {
    git(repo, ['config', 'user.name', 'HiFox Demo']);
    git(repo, ['config', 'user.email', 'demo@hifox.local']);
  }
  if (freshInit) {
    git(repo, ['add', '-A']);
    const c = git(repo, ['commit', '--quiet', '-m', 'chore: 基线快照']);
    if (!c.ok) throw new StateError(`基线提交失败：${c.stderr || c.stdout}`, 'COMMIT_FAIL');
  }

  task.repo = repo;
  writeTaskSpec(ws, task);

  const existing = existsSync(taskSpecPath(ws)) && existsSync(join(latticeDir(ws), 'state.json'));
  const ledger = createLedger(task, ws, base);
  if (!existing) saveLedger(ws, ledger);

  return { ws, repo, ledger, task };
}

/** 进程锁：同一任务同时只允许一个 driver（E8） */
export function acquireLock(ws: string): string {
  const p = lockPath(ws);
  ensureDir(latticeDir(ws));
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(p, 'wx');
      writeFileSync(fd, JSON.stringify({ pid: process.pid, at: nowIso() }));
      closeSync(fd);
      return p;
    } catch {
      const info = readJson<{ pid?: number }>(p, {});
      const pid = info.pid ?? 0;
      if (pid && isAlive(pid)) {
        throw new StateError(`任务已被 pid ${pid} 的 driver 占用（锁竞争）`, 'E8');
      }
      try {
        unlinkSync(p);
      } catch {
        /* 已被别人清掉 */
      }
    }
  }
  throw new StateError('无法获取任务锁', 'E8');
}

export function releaseLock(ws: string): void {
  try {
    // 只删自己持有的锁：否则被 reset 后重建的新 driver 会被旧进程误删锁
    const info = readJson<{ pid?: number }>(lockPath(ws), {});
    if (info.pid === process.pid) unlinkSync(lockPath(ws));
  } catch {
    /* 已释放 */
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 当前锁的持有者 pid；没有锁返回 null */
export function lockOwner(ws: string): number | null {
  const p = lockPath(ws);
  if (!existsSync(p)) return null;
  return readJson<{ pid?: number }>(p, {}).pid ?? null;
}

/**
 * 锁归属校验（每轮循环都要做）。
 * 为什么需要：锁是「文件存在 + pid」实现的，一次 reset 会删掉锁文件，
 * 于是新 driver 能拿到锁，而旧 driver 还以为自己独占 —— 两个进程同时写 state.json。
 * 这条校验把「以为自己持锁」变成「确认自己持锁」。
 */
export function assertLockOwned(ws: string): void {
  const owner = lockOwner(ws);
  if (owner !== process.pid) {
    throw new StateError(
      `任务锁已不属于本进程（当前持有者 ${owner ?? '无'}），立即停止以免并发写坏账本`,
      'LOCK_LOST',
    );
  }
}

/** 重置前先确认没有别的 driver 在跑这个任务 */
export function assertNoLiveDriver(ws: string): void {
  const owner = lockOwner(ws);
  if (owner && owner !== process.pid && isAlive(owner)) {
    throw new StateError(
      `任务正在被 pid ${owner} 的 driver 使用（可能是一个没关掉的 dev 服务），拒绝重置`,
      'E8',
    );
  }
}

/**
 * 重置工作区：只删账本与任务单、把仓库退回基线、删掉工作分支。
 * 不整体删目录（避免批量删除触发安全阈值，也避免误删仓库）。
 */
export function resetWorkspace(ws: string, taskKey: string): void {
  // 重置会删掉锁文件，必须先确认没有别的 driver 正在用这个任务
  assertNoLiveDriver(ws);
  const repo = join(ws, 'repo');
  if (isGitRepo(repo)) {
    const base = CFG.DEFAULT_BASE_BRANCH;
    git(repo, ['checkout', '-f', base]);
    // 提测会把工作分支合并进本地基线，所以重置要回到 clone 时的远端基线，而不是本地基线
    const hasOrigin = git(repo, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${base}`]).ok;
    git(repo, ['reset', '--hard', hasOrigin ? `origin/${base}` : base]);
    git(repo, ['clean', '-fd']);
    const branch = CFG.BRANCH_PATTERN(CFG.AGENT_SLUG, taskKey);
    if (branchExists(repo, branch)) git(repo, ['branch', '-D', branch]);
  }
  try {
    rmSync(join(ws, CFG.WORKSPACE_SUBDIR), { recursive: true, force: true });
  } catch {
    /* 没有账本目录也无所谓 */
  }
  for (const f of ['task.json', 'env.json']) {
    try {
      rmSync(join(ws, f), { force: true });
    } catch {
      /* ignore */
    }
  }
}

export function ledgerRaw(ws: string): string {
  const p = join(latticeDir(ws), 'state.json');
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
}
