import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CFG } from './config.ts';
import { defaultTask, bootstrapTask, resetWorkspace } from './workspace.ts';
import { appendMessage, hasLedger, loadLedger, readMessages, readTaskSpec, writeOperatorCommand, markConsumed, validateLedger } from './ledger.ts';
import { renderFooter, assertFooterMatchesLedger } from './footer.ts';
import { runEngine } from './engine.ts';
import { MockRuntime } from './runtime/mock.ts';
import { CliRuntime } from './runtime/cli.ts';
import { STAGE_LABELS } from './stages.ts';
import { nowIso, readJson } from './util.ts';
import { shortId, parseHumanMessage } from './message.ts';
import type { PatchOp, Stage, TaskSpec } from './types.ts';

const ROOT = resolve(import.meta.dirname, '..');

interface Args {
  _: string[];
  [k: string]: string | boolean | string[];
}

function parseArgs(argv: string[]): Args {
  const out: Args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const raw = a.slice(2);
      const eq = raw.indexOf('=');
      if (eq > 0) {
        // --key=value 形式（与 --key value 等价）
        out[raw.slice(0, eq)] = raw.slice(eq + 1);
        continue;
      }
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) out[raw] = true;
      else {
        out[raw] = next;
        i++;
      }
    } else out._.push(a);
  }
  return out;
}

function str(a: Args, k: string, fallback = ''): string {
  const v = a[k];
  return typeof v === 'string' ? v : fallback;
}

function resolveWs(a: Args): string {
  const explicit = str(a, 'ws') || process.env.HIFOX_WS || '';
  if (explicit) return resolve(explicit);
  const dir = join(ROOT, 'tasks');
  if (existsSync(dir)) {
    const dirs = readdirSync(dir).filter((d) => hasLedger(join(dir, d)));
    if (dirs.length === 1) return join(dir, dirs[0]);
    if (dirs.length > 1) {
      throw new Error(`有多个任务工作区，请用 --ws 指定：${dirs.join(', ')}`);
    }
  }
  throw new Error('找不到任务工作区，请先 init 或传 --ws');
}

function log(line: string): void {
  console.log(line);
}

/* ------------------------------ init ------------------------------ */

function cmdInit(a: Args): void {
  const key = str(a, 'task');
  if (!key) throw new Error('缺少 --task（任务编号，如 HF-14690）');

  const fixture = str(a, 'fixture');
  const fromFixture = fixture
    ? readJson<Partial<TaskSpec>>(resolve(fixture), {})
    : {};

  const task = defaultTask({
    ...fromFixture,
    key,
    title: str(a, 'title') || fromFixture.title || key,
    description: str(a, 'desc') || fromFixture.description || '',
    priority: str(a, 'priority') || fromFixture.priority || '普通',
    base_branch: str(a, 'base') || fromFixture.base_branch || CFG.DEFAULT_BASE_BRANCH,
    test_cmd: str(a, 'test') || fromFixture.test_cmd || 'node --test',
    review_blocking_rounds: a.blocking !== undefined
      ? Number(str(a, 'blocking', '0'))
      : (fromFixture.review_blocking_rounds ?? 0),
    patch_ops: (fromFixture.patch_ops ?? []) as PatchOp[],
  });

  const repoSource = str(a, 'repo') || fromFixture.repo || join(ROOT, 'examples/demo-repo');
  const ws = resolve(str(a, 'ws') || join(ROOT, 'tasks', key));

  // 已有账本时绝不静默重建：重建会覆盖任务单（标题/描述/状态）并让工作区与账本互相矛盾
  if (hasLedger(ws) && !a.force) {
    throw new Error(
      `工作区已存在且已有账本：${ws}\n` +
      `  重建会覆盖任务单与全部产物记录。确认要重建请加 --force。`,
    );
  }
  if (existsSync(ws) && a.force) resetWorkspace(ws, key);

  const out = bootstrapTask({ ws, task, repoSource });
  log(`工作区：${out.ws}`);
  log(`仓库：${out.repo}（分支基线 ${out.ledger.baseline_branch}）`);
  log(`任务：${task.key} ${task.title}`);
  log(`下一步：node src/main.ts run --ws "${out.ws}" --wait 60`);
}

/* ------------------------------ run ------------------------------ */

async function cmdRun(a: Args): Promise<number> {
  const ws = resolveWs(a);
  const useCli = str(a, 'runtime') === 'cli';
  const runtime = useCli ? new CliRuntime() : new MockRuntime();

  if (!useCli) {
    const failStage = str(a, 'fail-stage');
    if (failStage) (runtime as MockRuntime).failStage = failStage as Stage;
    const mode = str(a, 'fail-mode');
    if (mode === 'garbage') (runtime as MockRuntime).failMode = 'garbage';
    // 复现真实 CLI 的常见行为：代码改了、产物写了、但没提交
    // 形如 `--no-commit`（裸开关）默认作用于 IMPLEMENT，`--no-commit PATCH` 可指定阶段
    const noCommit = a['no-commit'];
    if (noCommit) {
      const stage = typeof noCommit === 'string' ? noCommit : 'IMPLEMENT';
      (runtime as MockRuntime).skipCommitOn = stage as Stage;
    }
  }

  const res = await runEngine({
    ws,
    runtime,
    // 不传 --wait 时不做等待（跑到门外就退出）；--wait 0 才是常驻等消息
    waitMs: a.wait !== undefined ? Number(str(a, 'wait', '0')) : (a.follow ? 0 : -1),
    maxSteps: a['max-steps'] !== undefined ? Number(str(a, 'max-steps', '200')) : 200,
    log,
  });

  console.log(`\n结果：${res.outcome}（阶段 ${res.stage} / ${STAGE_LABELS[res.stage]}，${res.steps} 步）`);
  if (res.message) console.log(`说明：${res.message}`);
  return res.outcome === 'error' ? 1 : 0;
}

/* ------------------------------ status ------------------------------ */

function cmdStatus(a: Args): void {
  const ws = resolveWs(a);
  const l = loadLedger(ws);
  const task = readTaskSpec(ws);
  console.log(`任务：${task.key} ${task.title}  状态：${task.status}`);
  console.log(`阶段：${l.stage}（${STAGE_LABELS[l.stage]}）  迭代：${l.review_iteration}  返工：${l.rework_count}`);
  console.log(`产物：${l.artifacts.join(' | ') || '无'}`);
  console.log(`\n${renderFooter(l)}\n`);
  if (l.ship_steps.length > 0) {
    console.log('提测七步：');
    for (const s of l.ship_steps) console.log(`  ${s.seq}. ${s.name} → ${s.status}${s.detail ? '：' + s.detail : ''}`);
  }
  const msgs = readMessages(ws);
  console.log('\n最近消息：');
  for (const m of msgs.slice(-6)) {
    const one = m.text.split('\n')[0].slice(0, 80);
    console.log(`  [${m.role}] ${one}`);
  }
}

/* ------------------------------ msg / resume ------------------------------ */

function cmdMsg(a: Args): void {
  const ws = resolveWs(a);
  const text = str(a, 'text') || a._.slice(1).join(' ');
  if (!text) throw new Error('缺少 --text');
  appendMessage(ws, { id: shortId(), role: 'human', text, at: nowIso() });
  console.log(`已投递人类消息：${text}`);

  // 投递后立刻告诉用户「这条会不会推进」——否则人只能靠猜和等
  const l = loadLedger(ws);
  if (l.stage === 'DONE') {
    console.log('注意：任务已结束（DONE），这条消息不会被任何阶段消费。');
    return;
  }
  if (l.stage === 'PAUSED') {
    console.log('注意：任务已暂停。聊天令牌对 PAUSED 无效，恢复请用：resume --reason "..."');
    return;
  }
  const parsed = parseHumanMessage(text);
  if (l.expected_token) {
    if (parsed.token === l.expected_token) {
      console.log(`这条消息末尾带 ${l.expected_token}，满足「${STAGE_LABELS[l.stage]}」的授权条件。`);
    } else {
      console.log(
        `注意：当前停在「${STAGE_LABELS[l.stage]}」，需要把 ${l.expected_token} 放在消息末尾才算授权。\n` +
        '这条消息会被记录，但不会推进阶段。',
      );
    }
  } else {
    console.log(`当前阶段「${STAGE_LABELS[l.stage]}」不在门外，消息会作为人类输入交给 driver（若已在跑）。`);
  }
}

function cmdResume(a: Args): void {
  const ws = resolveWs(a);
  const l = loadLedger(ws);
  if (l.stage !== 'PAUSED') {
    throw new Error(`当前阶段是「${STAGE_LABELS[l.stage]}」，只有 PAUSED 才能 resume；当前命令不会被消费。`);
  }
  const reason = str(a, 'reason') || '人工确认后恢复';
  writeOperatorCommand(ws, { kind: 'resume', reason, at: nowIso() });
  console.log(`已写入操作员命令：resume（${reason}）`);
  console.log(`下一步：node src/main.ts run --ws "${ws}" --wait 60`);
}

function cmdRetry(a: Args): void {
  const ws = resolveWs(a);
  const l = loadLedger(ws);
  if (l.stage !== 'PARTIAL_SHIP') {
    throw new Error(`当前阶段是「${STAGE_LABELS[l.stage]}」，只有 PARTIAL_SHIP 才能 retry；当前命令不会被消费。`);
  }
  const reason = str(a, 'reason') || '人工确认后继续提测';
  writeOperatorCommand(ws, { kind: 'ship_retry', reason, at: nowIso() });
  console.log(`已写入操作员命令：ship_retry（${reason}）`);
  console.log(`下一步：node src/main.ts run --ws "${ws}" --wait 60`);
}

/* ------------------------------ demo ------------------------------ */

async function cmdDemo(): Promise<number> {
  const ws = resolve(join(ROOT, 'tasks', 'HF-14690'));
  if (existsSync(ws)) resetWorkspace(ws, 'HF-14690');
  cmdInit({ _: ['init'], task: 'HF-14690', fixture: join(ROOT, 'examples/demo-task.json'), force: true } as Args);

  const runtime = new MockRuntime();
  const run = async (label: string, wait: number) => {
    console.log(`\n──────── ${label} ────────`);
    const r = await runEngine({ ws, runtime, waitMs: wait, log });
    console.log(`→ ${r.outcome} @ ${r.stage}`);
    return r;
  };

  await run('阶段一：初始化 → 诊断 → 等门 1', 800);

  // 故意先说一句「继续」，验证它不解锁
  appendMessage(ws, { id: shortId(), role: 'human', text: '继续', at: nowIso() });
  await run('阶段二：只回「继续」', 800);

  appendMessage(ws, { id: shortId(), role: 'human', text: '1A 2A 3A【进入开发】', at: nowIso() });
  await run('阶段三：令牌 + 决策 → 实现 → 变基 → 评审 → 修补 → 验证', 4000);

  appendMessage(ws, { id: shortId(), role: 'human', text: '【提测】', at: nowIso() });
  const last = await run('阶段四：令牌 → 提测七步 → 完成', 8000);

  console.log('\n──────── 产物清单 ────────');
  const l = loadLedger(ws);
  for (const p of l.artifacts) console.log(`  ${p}`);
  console.log(`\n最终页脚：\n${renderFooter(l)}`);
  console.log(`\n工作区：${ws}`);
  return last.outcome === 'done' ? 0 : 1;
}

/* ------------------------------ dev：一键本地跑 ------------------------------ */

async function cmdDev(a: Args): Promise<number> {
  const ws = resolve(join(ROOT, 'tasks', 'HF-14690'));
  if (a.reset || !hasLedger(ws)) {
    resetWorkspace(ws, 'HF-14690');
    cmdInit({ _: ['init'], task: 'HF-14690', fixture: join(ROOT, 'examples/demo-task.json'), force: true } as Args);
  }

  const { startServer } = await import('./server.ts');
  const port = Number(str(a, 'port', '4173'));
  startServer(port, ws);

  console.log('\n驱动已启动，停在门外等你发令牌。面板：http://127.0.0.1:%d\n', port);
  const res = await runEngine({ ws, runtime: new MockRuntime(), waitMs: 0, log });
  console.log(`\n驱动结束：${res.outcome} @ ${res.stage}`);
  return 0;
}

/* ------------------------------ main ------------------------------ */

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2));
  const cmd = a._[0];

  switch (cmd) {
    case 'init':
      cmdInit(a);
      break;
    case 'run':
      process.exitCode = await cmdRun(a);
      break;
    case 'status':
      cmdStatus(a);
      break;
    case 'msg':
      cmdMsg(a);
      break;
    case 'resume':
      cmdResume(a);
      break;
    case 'retry':
      cmdRetry(a);
      break;
    case 'demo':
      process.exitCode = await cmdDemo();
      break;
    case 'dev':
      process.exitCode = await cmdDev(a);
      break;
    case 'serve': {
      const { startServer } = await import('./server.ts');
      const port = Number(str(a, 'port', '4173'));
      startServer(port, resolveWs(a));
      break;
    }
    case 'verify': {
      const { spawnSync } = await import('node:child_process');
      const r = spawnSync(process.execPath, [join(ROOT, 'scripts/verify-day1.mjs')], { stdio: 'inherit' });
      process.exitCode = r.status ?? 1;
      break;
    }
    case 'doctor': {
      const ws = resolveWs(a);
      const l = loadLedger(ws);
      const task = readTaskSpec(ws);
      const problems: string[] = [];
      try {
        validateLedger(l);
      } catch (e) {
        problems.push(`账本不变量：${(e as Error).message}`);
      }
      try {
        assertFooterMatchesLedger(renderFooter(l), l);
      } catch (e) {
        problems.push(`页脚一致性：${(e as Error).message}`);
      }
      for (const p of l.artifacts) {
        if (!existsSync(join(ws, p))) problems.push(`产物缺失：${p}`);
      }
      if (a.json) {
        console.log(JSON.stringify({ ok: problems.length === 0, ws, problems, stage: l.stage, task: task.key, ledger: l }, null, 2));
      } else {
        console.log(`工作区：${ws}`);
        console.log(`任务：${task.key} ${task.title}  任务状态：${task.status}`);
        console.log(`阶段：${l.stage}（${STAGE_LABELS[l.stage]}）  账本状态：${l.status}  产物 ${l.artifacts.length} 个`);
        if (problems.length === 0) console.log('自检通过：账本不变量、页脚一致性、产物文件均正常。');
        else {
          console.log(`自检发现 ${problems.length} 项问题：`);
          for (const p of problems) console.log(`  · ${p}`);
        }
      }
      if (problems.length > 0) process.exitCode = 1;
      break;
    }
    case 'list': {
      const { listTasks, formatSummary } = await import('./tasks.ts');
      const all = listTasks(ROOT);
      if (all.length === 0) {
        console.log('还没有任务。先跑：node src/main.ts init --task HF-14690 --fixture examples/demo-task.json');
        break;
      }
      if (a.json) {
        console.log(JSON.stringify(all, null, 2));
        break;
      }
      console.log(`共 ${all.length} 个任务（⏸ 等人 / ▶ driver 在跑 / · 空闲）\n`);
      for (const s of all) console.log(formatSummary(s));
      break;
    }
    case 'intel': {
      const ws = resolveWs(a);
      const repo = join(ws, 'repo');
      const { collectIntel, extractKeywords, renderIntel } = await import('./repoIntel.ts');
      const task = readTaskSpec(ws);
      const kw = str(a, 'q')
        ? [str(a, 'q')]
        : extractKeywords(`${task.title}\n${task.description}`, 6);
      console.log(renderIntel(collectIntel(repo, kw)));
      break;
    }
    default:
      if (cmd !== undefined && cmd !== 'help' && cmd !== '--help' && cmd !== '-h') {
        console.error(`未知命令：${cmd}\n`);
        process.exitCode = 1;
      }
      printUsage();
  }
}

function printUsage(): void {
  console.log(`用法：node src/main.ts <命令> [选项]

快速开始
  demo                                  端到端跑一次：诊断 → 门1 → 实现 → 评审 → 修补 → 验证 → 门2 → 提测 → 完成
  verify                                跑 18 条验收断言（约 47 秒）
  dev [--reset] [--port 4173]           起工作台 + 驱动，停在门 1 等令牌

任务
  init --task HF-14690 [--fixture 文件] [--force]
                                        建工作区；已有账本时必须加 --force 才会重建
  list [--json]                         所有任务与卡点（⏸ 等人 / ▶ 在跑）
  status [--ws 路径]                    阶段、页脚、提测七步、最近消息
  doctor [--ws 路径] [--json]           自检：账本不变量 / 页脚一致性 / 产物是否还在

推进
  run [--ws 路径] [--wait 毫秒] [--follow] [--runtime mock|cli] [--fail-stage 阶段] [--fail-mode garbage]
                                       跑引擎。不传 --wait = 跑到门外就退出；--wait 60000 = 等 60 秒；
                                       --wait 0 或 --follow = 一直等（常驻 driver）
  msg --text "1A 2A 3A【进入开发】"      投递人类消息；会告诉你这条是否满足门的授权条件
  resume --reason "..."                 仅 PAUSED 可用
  retry  --reason "..."                 仅 PARTIAL_SHIP 可用

检索与界面
  intel [--ws 路径] [--q 关键词]        代码与历史检索（git log / 全文 / 热点）
  serve [--port 4173]                   只起工作台，不起驱动

选项
  --ws 也支持 --ws=路径 形式；省略时若 tasks/ 下只有一个任务则自动选中。`);
}

main().catch((e) => {
  console.error(`失败：${(e as Error).message}`);
  process.exitCode = 1;
});

export type { TaskSpec };
