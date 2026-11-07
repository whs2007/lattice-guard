import { existsSync, readFileSync, statSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, resolve as resolvePath } from 'node:path';

/**
 * 把用户给的命令（如 `claude -p`）解析成「真的能 spawn 的东西」。
 *
 * 为什么需要这一层：Windows 上 npm 全局装的 CLI 是 .cmd 垫片，
 * `child_process.spawn('claude')` 不按 PATHEXT 找，直接 ENOENT；
 * 而 Node 又不允许无 shell 直接 spawn .cmd/.bat（EINVAL）。
 * 没有这一层时，整条链第一阶段就 TOOL 失败——与模型能力无关。
 */
export interface ResolvedTarget {
  exe: string;
  args: string[];
  /** 走了哪条解析路径；打印出来，别让人猜为什么换了个 exe */
  how: string;
}

const SHIM_EXT = ['.cmd', '.bat'];
const SCRIPT_EXT = ['.js', '.cjs', '.mjs'];

export function resolveCommand(argv: string[]): ResolvedTarget {
  if (argv.length === 0) throw new Error('空命令');
  const [cmd, ...rest] = argv;

  if (process.platform !== 'win32') return { exe: cmd, args: rest, how: '直接启动' };

  if (isAbsolute(cmd) || cmd.includes('/') || cmd.includes('\\')) {
    return resolvePathTarget(resolvePath(cmd), rest);
  }

  const dirs = (process.env.PATH ?? process.env.Path ?? '').split(delimiter).filter(Boolean);
  for (const d of dirs) {
    // 不试无扩展名的候选：npm 在 Windows 上同时放一个 sh 垫片 `claude`，
    // 它看着「存在」，但 CreateProcess 根本执行不了，选中它只会多绕一层错误。
    for (const ext of ['.exe', ...SHIM_EXT]) {
      const p = join(d, cmd + ext);
      if (!isFile(p)) continue;
      return resolvePathTarget(p, rest);
    }
  }
  return { exe: cmd, args: rest, how: 'PATH 中未找到，交给系统解析（通常仍会失败）' };
}

function resolvePathTarget(p: string, rest: string[]): ResolvedTarget {
  const lower = p.toLowerCase();
  if (lower.endsWith('.exe')) return { exe: p, args: rest, how: 'exe 直启' };
  if (SCRIPT_EXT.some((e) => lower.endsWith(e))) {
    return { exe: process.execPath, args: [p, ...rest], how: `经 node 启动 ${p}` };
  }
  const inner = extractFromShim(p);
  if (inner) return { exe: inner.exe, args: [...inner.args, ...rest], how: inner.how };
  // 兜底：过一层 cmd.exe。参数里的括号等元字符有被二次解析的风险，只在挖不到真实入口时用。
  return {
    exe: process.env.ComSpec ?? 'cmd.exe',
    args: ['/d', '/s', '/c', `"${p}"`, ...rest],
    how: 'shim 中未找到真实入口，经 cmd.exe 转交',
  };
}

/** npm 的 .cmd 垫片里有一行指向真实入口；挖出来比过一层 shell 稳 */
function extractFromShim(shim: string): ResolvedTarget | null {
  let text: string;
  try {
    text = readFileSync(shim, 'utf8');
  } catch {
    return null;
  }
  const base = dirname(shim);
  for (const m of text.matchAll(/["']?([^"'\r\n]*?\.(?:exe|cjs|mjs|js))["']?/gi)) {
    const raw = m[1].trim();
    if (!raw) continue;
    const expanded = raw.replace(/%~?dp0%/gi, base);
    if (/%[^%]+%/.test(expanded)) continue; // 还有未展开的垫片变量，放弃这条
    const full = isAbsolute(expanded) ? expanded : resolvePath(base, expanded);
    if (!isFile(full)) continue;
    const lower = full.toLowerCase();
    if (lower.endsWith('.exe')) return { exe: full, args: [], how: `shim 解析到 ${full}` };
    if (SCRIPT_EXT.some((e) => lower.endsWith(e))) {
      return { exe: process.execPath, args: [full], how: `shim 解析到 node 脚本 ${full}` };
    }
  }
  return null;
}

function isFile(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isFile();
  } catch {
    return false;
  }
}
