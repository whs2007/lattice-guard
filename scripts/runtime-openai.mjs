#!/usr/bin/env node
/**
 * 零依赖的 OpenAI 兼容 Runtime：把 stdin 上下文交给任何 /chat/completions 端点。
 *
 *   HIFOX_OPENAI_KEY=xxx \
 *   HIFOX_RUNTIME_CMD="node scripts/runtime-openai.mjs" \
 *   node src/main.ts run --ws tasks/HF-14690 --runtime cli
 *
 * 为什么自己写这一层：本机实测 generativelanguage.googleapis.com 完全不通，
 * 而 open.bigmodel.cn / api.siliconflow.cn / openrouter.ai 都可达。这三家都是
 * OpenAI 格式，不需要装 Claude Code / Gemini CLI / Aider 之类的额外工具。
 *
 * 边界（刻意保持很小）：
 * - 只暴露 read_file / write_file / run_cmd 三个工具，够写产物、改代码、跑测试、提交。
 * - 文件写入只允许落在 cwd（仓库）或 HIFOX_WS（工作区）之内，防止模型把东西写到别处。
 * - 模型不再请求工具就结束。它「说完成了」不算数，产物校验器才是裁判。
 * - 任何鉴权/网络/配额错误立刻非零退出，不做静默重试，避免引擎白等 900 秒。
 *
 * 环境变量：
 *   HIFOX_OPENAI_BASE   默认 https://open.bigmodel.cn/api/paas/v4
 *   HIFOX_OPENAI_MODEL  默认 glm-4.5-flash（换厂商时必须一起换）
 *   HIFOX_OPENAI_KEY    必填
 *   HIFOX_MAX_TURNS     默认 20，硬上限 40
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

const KEY = process.env.HIFOX_OPENAI_KEY ?? '';
const BASE = (process.env.HIFOX_OPENAI_BASE ?? 'https://open.bigmodel.cn/api/paas/v4').replace(/\/+$/, '');
const MODEL = process.env.HIFOX_OPENAI_MODEL ?? 'glm-4.5-flash';
const WS = process.env.HIFOX_WS ?? '';
const CWD = process.cwd();
const MAX_TURNS = Math.min(40, Math.max(1, Number(process.env.HIFOX_MAX_TURNS ?? '20')));

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const prompt = Buffer.concat(chunks).toString('utf8');

function die(why) {
  console.error(`[runtime-openai] ${why}`);
  process.exit(1);
}

if (!KEY) die('缺少 HIFOX_OPENAI_KEY');
if (!prompt.trim()) die('stdin 没有收到上下文');

/** 只允许写进仓库或工作区，绝对路径与 ../ 逃逸都挡掉 */
function safePath(p) {
  if (!p || typeof p !== 'string') throw new Error('path 必须是字符串');
  const abs = isAbsolute(p) ? resolve(p) : resolve(CWD, p);
  const roots = [CWD, ...(WS ? [resolve(WS)] : [])];
  const ok = roots.some((root) => {
    const rel = relative(root, abs);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  });
  if (!ok) throw new Error(`路径越界（只允许 ${roots.join(' / ')} 之内）：${abs}`);
  return abs;
}

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读取一个文本文件的完整内容。',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: '把 content 原样写入 path（会创建父目录）。产物必须写到工作区的 .xwing-task/lattice/ 下。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_cmd',
      description: '在仓库目录执行一条 shell 命令，返回 stdout/stderr 尾部。用于跑测试、git status、git add/commit。',
      parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] },
    },
  },
];

function execTool(name, args) {
  if (name === 'read_file') {
    const p = safePath(args.path);
    if (!existsSync(p)) return `(文件不存在) ${p}`;
    return readFileSync(p, 'utf8').slice(0, 30000);
  }
  if (name === 'write_file') {
    const p = safePath(args.path);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, String(args.content ?? ''), 'utf8');
    return `已写入 ${p}（${String(args.content ?? '').length} 字符）`;
  }
  if (name === 'run_cmd') {
    const cmd = String(args.cmd ?? '');
    if (!cmd.trim()) return '(空命令)';
    const r = spawnSync(cmd, { cwd: CWD, shell: true, encoding: 'utf8', timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.slice(-12000);
    return `exit=${r.status ?? 'null'}${r.error ? ` error=${r.error.message}` : ''}\n${out}`;
  }
  return `(未知工具) ${name}`;
}

const system = [
  '你是一个在本地仓库里干活的编码 Agent。严格按用户消息里的上下文执行，不要反问、不要只给建议。',
  `仓库根目录（当前工作目录）：${CWD}`,
  WS ? `任务工作区：${resolve(WS)}。所有阶段产物必须写进 ${resolve(WS)}/.xwing-task/lattice/ 下，用绝对路径最稳妥。` : '',
  '可用工具只有 read_file / write_file / run_cmd。需要读代码、写文件、跑测试、提交代码时，一律调用工具，不要只在文字里描述。',
  '上下文要求你产出哪些文件、包含哪些小节，就逐字写全；缺失会被产物校验器判为不合格。',
  '代码改完必须执行 `git add -A && git commit -m "..."`，没有提交等于没有交付。',
  '不要修改与任务无关的文件，不要重写整个仓库。',
  '全部做完后，用一句话总结并停止（不要再调用工具）。你说「完成」不算完成，引擎会自己检查产物与提交。',
].filter(Boolean).join('\n');

const messages = [
  { role: 'system', content: system },
  { role: 'user', content: prompt },
];

async function call() {
  let r;
  try {
    r = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.timeout(180000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ model: MODEL, messages, tools: TOOLS, tool_choice: 'auto', temperature: 0.2 }),
    });
  } catch (e) {
    die(`请求失败（网络/代理/DNS）：${e.message}；BASE=${BASE}`);
  }
  if (!r.ok) {
    const body = (await r.text()).slice(0, 400);
    die(`HTTP ${r.status}（鉴权/额度/模型名）→ ${body}`);
  }
  let j;
  try { j = await r.json(); } catch { die('响应不是合法 JSON'); }
  const msg = j.choices?.[0]?.message;
  if (!msg) die(`响应缺少 choices[0].message：${JSON.stringify(j).slice(0, 300)}`);
  return msg;
}

console.error(`[runtime-openai] ${BASE} · ${MODEL} · 最多 ${MAX_TURNS} 轮`);

for (let turn = 1; turn <= MAX_TURNS; turn++) {
  const msg = await call();
  messages.push(msg);

  const calls = msg.tool_calls ?? [];
  if (calls.length === 0) {
    console.error(`[runtime-openai] 第 ${turn} 轮：模型结束（${String(msg.content ?? '').slice(0, 120)}）`);
    process.exit(0);
  }

  console.error(`[runtime-openai] 第 ${turn} 轮：${calls.length} 个工具调用`);
  for (const c of calls) {
    let args = {};
    try { args = JSON.parse(c.function?.arguments ?? '{}'); } catch { /* 参数坏了就当空对象 */ }
    let result;
    try { result = execTool(c.function?.name, args); }
    catch (e) { result = `工具执行失败：${e.message}`; }
    messages.push({ role: 'tool', tool_call_id: c.id, content: String(result).slice(0, 20000) });
  }
}

die(`超过 ${MAX_TURNS} 轮仍在调用工具，停止（避免失控循环）`);
