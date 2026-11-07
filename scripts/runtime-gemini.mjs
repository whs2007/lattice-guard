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
import { spawn } from 'node:child_process';

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

// 实测：Gemini CLI 在「API key 无效 / 额度耗尽」时会报一大段错误但退出码仍是 0。
// 引擎只看退出码，于是这类失败会被误读成「模型正常跑完、只是产物没写」。
// 这里把可识别的致命鉴权/配额错误翻成非零退出码，让 PAUSED 的原因说人话。
let stderr = '';
const FATAL = /API key not valid|RESOURCE_EXHAUSTED|quota exceeded|rate.?limit|\b429\b|\b401\b|\b402\b|credential/i;
child.stderr.on('data', (d) => {
  const s = String(d);
  stderr += s;
  process.stderr.write(s);
});

child.stdin.end(prompt);
child.on('error', (e) => {
  console.error(`[runtime-gemini] 启动失败：${e.message}`);
  process.exitCode = 127;
});
child.on('close', (code) => {
  const fatal = code === 0 && FATAL.test(stderr);
  if (fatal) console.error('[runtime-gemini] 检测到鉴权/配额失败，按非零退出码上报');
  process.exit(fatal ? 1 : (code ?? 1));
});
