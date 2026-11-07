#!/usr/bin/env node
/**
 * 把 lattice-guard 的 stdin 上下文转给 Gemini CLI 的 headless 模式。
 *
 *   GEMINI_API_KEY=xxx \
 *   HIFOX_RUNTIME_CMD="node scripts/runtime-gemini.mjs" \
 *   node src/main.ts run --ws tasks/HF-14690 --runtime cli
 *
 * 为什么需要这层薄适配器（都是实测踩出来的）：
 * - Gemini CLI 的 -p 要一个字符串参数，但它会把 stdin 的内容追加到该参数后。
 *   于是长上下文走 stdin，绕开 Windows 命令行 8191 字符上限。
 * - 引擎把子进程 cwd 设成 <ws>/repo（git 要在仓库里跑），而产物在
 *   <ws>/.xwing-task/lattice。必须把 <ws> 用 --include-directories 挂进去，
 *   否则模型会把产物写进 repo 根目录，产物校验器永远找不到。
 * - --yolo 自动批准写文件与 git；不加的话 headless 会卡在确认提示上。
 * - 不要用 Google 账号 OAuth（GOOGLE_GENAI_USE_GCA）：它会打印
 *   "Do you want to continue? [Y/n]" 并从 stdin 读回答，把我们的 prompt 吃掉，
 *   认证直接被判为取消。API Key 模式没有这个交互。
 *
 * 可选环境变量：
 *   HIFOX_GEMINI_MODEL   指定模型（默认由 Gemini CLI 自己选）
 *   HIFOX_GEMINI_BIN     覆盖启动命令（默认 npx -y @google/gemini-cli）
 */
import { spawn, spawnSync } from 'node:child_process';

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const prompt = Buffer.concat(chunks).toString('utf8');

const win = process.platform === 'win32';
const bin = (process.env.HIFOX_GEMINI_BIN ?? 'npx -y @google/gemini-cli').split(/\s+/).filter(Boolean);
const exe = win && bin[0] === 'npx' ? 'npx.cmd' : bin[0];
const args = [
  ...bin.slice(1),
  '-p',
  '严格按以下上下文执行',
  '--yolo',
  '--skip-trust',
];

const ws = process.env.HIFOX_WS;
if (ws) args.push('--include-directories', ws);
if (process.env.HIFOX_GEMINI_MODEL) args.push('-m', process.env.HIFOX_GEMINI_MODEL);

// shell=true 只用于让 cmd.exe 解析 Windows 的 .cmd 垫片；带空格的路径手动加引号
const argv = win ? args.map((a) => (/\s/.test(a) ? `"${a}"` : a)) : args;

const child = spawn(exe, argv, {
  cwd: process.cwd(),
  stdio: ['pipe', 'inherit', 'pipe'],
  shell: win,
  env: process.env,
});

// 实测两类坑：
// ① Gemini CLI 在「API key 无效 / 额度耗尽」时报错一大段却仍以 0 退出，
//    引擎只看退出码，会把「模型根本没跑」误读成「产物没写」。
// ② 网络不通时它打印 `fetch failed sending request` 后无限退避重试，
//    进程一直不退出 → 上面那类检查永远没机会执行，白等引擎的 900 秒超时。
// 所以：边读边判定，遇到不可恢复的错误立刻收进程；再加一道硬超时兜底。
let stderr = '';
let fatalReason = '';
let hardTimer;
const FATAL_INSTANT = /API key not valid|API_KEY_INVALID|RESOURCE_EXHAUSTED|quota exceeded|fetch failed sending request|ECONNREFUSED|ENOTFOUND|ECONNRESET|ETIMEDOUT/i;
const LIMIT_SEC = Number(process.env.HIFOX_ADAPTER_TIMEOUT_SEC ?? '180');

// 注意：Windows 上用了 shell:true，`child.kill()` 只杀 cmd.exe，
// Gemini 子进程会留下来继续重试，管道不关 → `close` 永不触发 → 适配器又挂死。
// 所以放弃等待 close，直接杀整棵进程树并立刻退出。
const giveUp = (why) => {
  if (fatalReason) return;
  fatalReason = why;
  clearTimeout(hardTimer);
  console.error(`[runtime-gemini] ${why}；按非零退出码上报`);
  try {
    if (win && child.pid) {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      child.kill('SIGKILL');
    }
  } catch { /* 进程已经退出 */ }
  process.exit(1);
};

hardTimer = setTimeout(
  () => giveUp(`适配器 ${LIMIT_SEC}s 内没有得到有效响应（网络或额度问题）`),
  LIMIT_SEC * 1000,
);

child.stderr.on('data', (d) => {
  const s = String(d);
  stderr += s;
  process.stderr.write(s);
  if (FATAL_INSTANT.test(stderr)) giveUp('检测到不可恢复的鉴权 / 配额 / 网络错误，停止无意义重试');
});

child.stdin.end(prompt);
child.on('error', (e) => {
  clearTimeout(hardTimer);
  console.error(`[runtime-gemini] 启动失败：${e.message}`);
  process.exitCode = 127;
});
child.on('close', (code) => {
  clearTimeout(hardTimer);
  if (fatalReason) process.exit(1);
  // 进程以 0 退出但 stderr 里有 401/402/429，同样翻成失败
  const silentFatal = code === 0 && /\b401\b|\b402\b|\b429\b|credential|rate.?limit/i.test(stderr);
  if (silentFatal) console.error('[runtime-gemini] 鉴权/配额失败却退出码 0，按非零上报');
  process.exit(silentFatal ? 1 : (code ?? 1));
});
