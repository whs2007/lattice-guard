#!/usr/bin/env node
/**
 * 阶段 1 验收：19 条可执行断言。
 * 全部离线运行，不需要模型、不需要网络、不需要 HiFox 账号。
 *
 *   node scripts/verify-day1.mjs
 */
process.env.HIFOX_TICK_MS = process.env.HIFOX_TICK_MS ?? '5';

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const { runEngine } = await import('../src/engine.ts');
const { MockRuntime } = await import('../src/runtime/mock.ts');
const { createLedger, loadLedger, saveLedger, validateLedger, appendMessage, nextHumanMessage, markConsumed, consumedIds, writeOperatorCommand } = await import('../src/ledger.ts');
const { bootstrapTask } = await import('../src/workspace.ts');
const { renderFooter, parseFooter, assertFooterMatchesLedger } = await import('../src/footer.ts');
const { readText } = await import('../src/util.ts');
const { readEvents } = await import('../src/events.ts');

const FIXTURE = JSON.parse(readFileSync(join(ROOT, 'examples/demo-task.json'), 'utf8'));
const results = [];

function ok(name, note = '') {
  results.push({ name, pass: true, note });
  console.log(`  ✓ ${name}${note ? `　（${note}）` : ''}`);
}
function bad(name, err) {
  results.push({ name, pass: false, note: err });
  console.log(`  ✗ ${name}\n      ${err}`);
}

async function step(name, fn) {
  try {
    const note = await fn();
    ok(name, typeof note === 'string' ? note : '');
  } catch (e) {
    bad(name, e.message);
  }
}

function makeWs(id, patch = {}) {
  // HIFOX_VERIFY_NOCLEAN=1：完全不删任何目录（沙箱/权限环境里删目录会被拦，拦住就等于验收失败）
  let ws = process.env.HIFOX_VERIFY_NOCLEAN
    ? join(ROOT, 'tmp', `${id}-${Date.now().toString(36)}`)
    : join(ROOT, 'tmp', id);
  if (!process.env.HIFOX_VERIFY_NOCLEAN) {
    try {
      rmSync(ws, { recursive: true, force: true });
    } catch {
      // 清理被环境拦截（例如回收站不可用）时换一个全新目录，
      // 绝不因为「删不掉旧目录」把被测逻辑判成失败
      ws = `${ws}-${Date.now().toString(36)}`;
    }
  }
  mkdirSync(ws, { recursive: true });
  // 走真实引导路径：示例仓库是普通目录，bootstrapTask 负责复制 + 自建基线分支
  const task = { ...FIXTURE, key: 'HF-14690', ...patch };
  bootstrapTask({ ws, task, repoSource: join(ROOT, 'examples/demo-repo') });
  return { ws, task };
}

async function run(ws, { wait = 150, maxSteps = 30, failStage, failMode, noCommit } = {}) {
  const rt = new MockRuntime();
  if (failStage) rt.failStage = failStage;
  if (failMode) rt.failMode = failMode;
  if (noCommit) rt.skipCommitOn = noCommit;
  return runEngine({ ws, runtime: rt, waitMs: wait, maxSteps, log: () => {} });
}

const say = (ws, text) => appendMessage(ws, { id: Math.random().toString(36).slice(2), role: 'human', text, at: new Date().toISOString() });
const drain = (ws) => { for (;;) { const m = nextHumanMessage(ws); if (!m) return; markConsumed(ws, m.id); } };
const lastAgent = (ws) => {
  const lines = readText(join(ws, '.xwing-task/lattice/messages.jsonl')).trim().split('\n').filter(Boolean);
  const msgs = lines.map((l) => JSON.parse(l)).filter((m) => m.role === 'agent');
  return msgs[msgs.length - 1];
};

console.log('\n阶段 1 验收 · 19 条断言\n');

/* ---------------- 场景 A：门禁主链 ---------------- */
console.log('场景 A · 门禁与产物');
const A = makeWs('verify-A');

await step('① 初始化完成：INIT → DIAGNOSE，账本合法', async () => {
  const r = await run(A.ws);
  if (r.stage !== 'WAIT_DEV') throw new Error(`期望停在 WAIT_DEV，实际 ${r.stage}`);
  const l = loadLedger(A.ws);
  validateLedger(l);
  if (l.history[0]?.from !== 'INIT' || l.history[0]?.to !== 'DIAGNOSE') throw new Error('首条历史不是 INIT → DIAGNOSE');
  return `history ${l.history.length} 条`;
});

await step('② 页脚 11 键可解析，且等待=【进入开发】', async () => {
  const l = loadLedger(A.ws);
  const f = parseFooter(renderFooter(l));
  const keys = new Set(Object.keys(f).map((k) => (k === '待批决策' ? '待此决策' : k)));
  if (keys.size !== 11) throw new Error(`页脚键数 ${keys.size}，应为 11`);
  if (f['等待'] !== '【进入开发】') throw new Error(`等待字段是 ${f['等待']}`);
  if (f['阶段'] !== '等待进入开发') throw new Error(`阶段显示名是 ${f['阶段']}`);
  return '键数 11，顺序稳定';
});

await step('③ 只回「继续」不解锁，且不写迁移历史', async () => {
  const before = loadLedger(A.ws).history.length;
  say(A.ws, '继续');
  const r = await run(A.ws);
  const l = loadLedger(A.ws);
  if (r.stage !== 'WAIT_DEV') throw new Error(`被误解锁，跑到 ${r.stage}`);
  if (l.history.length !== before) throw new Error('拒绝路径不应写 history');
  if (!lastAgent(A.ws).text.includes('不算授权')) throw new Error('回复里没有说清「不算授权」');
  return '仍停在门 1';
});

await step('④ 令牌不在末尾不解锁（严格结尾）', async () => {
  say(A.ws, '【进入开发】帮我看下');
  const r = await run(A.ws);
  if (r.stage !== 'WAIT_DEV') throw new Error(`句中令牌竟被当成授权，跑到 ${r.stage}`);
  return '句中令牌无效';
});

await step('⑤ 上游产物缺失时，令牌也过不去', async () => {
  const p = join(A.ws, '.xwing-task/lattice/diagnosis.md');
  const bak = readText(p);
  unlinkSync(p);
  say(A.ws, '1A 2A 3A【进入开发】');
  const r = await run(A.ws);
  if (r.stage !== 'WAIT_DEV') throw new Error(`产物缺失仍前进到 ${r.stage}`);
  // 两种合法拦截：门禁拒绝（点名缺哪个产物），或账本 I7 直接停引擎
  const replied = lastAgent(A.ws)?.text?.includes('上游产物不齐') ?? false;
  const halted = r.outcome === 'error' && String(r.message).includes('产物缺失');
  if (!replied && !halted) throw new Error(`既没拒绝也没停引擎（outcome=${r.outcome}）`);
  writeFileSync(p, bak);
  drain(A.ws); // 这条被拦下的令牌消息不再参与后续用例
  return replied ? '门禁点名缺失产物' : '账本 I7 直接停机';
});

await step('⑥ 令牌 + 1A 2A 3A：进入实现，决策落账本', async () => {
  say(A.ws, '1A 2A 3A【进入开发】');
  const r = await run(A.ws, { wait: 4000 });
  const l = loadLedger(A.ws);
  const d = l.approved_decisions;
  if (!(d['1'] === 'A' && d['2'] === 'A' && d['3'] === 'A')) throw new Error(`决策未记录：${JSON.stringify(d)}`);
  const rec = l.history.find((h) => h.from === 'WAIT_DEV' && h.to === 'IMPLEMENT');
  if (!rec || rec.token !== '【进入开发】') throw new Error('迁移历史缺少令牌');
  if (r.stage !== 'WAIT_SHIP') throw new Error(`期望推进到 WAIT_SHIP，实际 ${r.stage}`);
  return `迭代 ${l.review_iteration}，产物 ${l.artifacts.length}`;
});

await step('⑦ 页脚与账本逐字段等值', async () => {
  const l = loadLedger(A.ws);
  assertFooterMatchesLedger(renderFooter(l), l);
  return '11 字段一致';
});

await step('⑧ 全程零手改：history 连续且每条有原因与时间', async () => {
  const l = loadLedger(A.ws);
  for (let i = 0; i < l.history.length; i++) {
    const h = l.history[i];
    if (!h.reason || !h.at) throw new Error(`第 ${i} 条历史缺 reason/at`);
    if (i > 0 && h.from !== l.history[i - 1].to) throw new Error(`第 ${i} 条 from 与上一条 to 不连续`);
  }
  return `${l.history.length} 条连续`;
});

/* ---------------- 场景 B：异常与暂停出口 ---------------- */
console.log('\n场景 B · 异常与暂停出口');
const B = makeWs('verify-B');

await step('⑨ 同一条消息重复投递只消费一次', async () => {
  const id = 'fixed-msg-id';
  appendMessage(B.ws, { id, role: 'human', text: '重复消息', at: new Date().toISOString() });
  appendMessage(B.ws, { id, role: 'human', text: '重复消息', at: new Date().toISOString() });
  const first = nextHumanMessage(B.ws);
  if (!first || first.id !== id) throw new Error('首条未被取到');
  markConsumed(B.ws, id);
  if (nextHumanMessage(B.ws) !== null) throw new Error('重复 id 被当成新消息');
  if (consumedIds(B.ws).filter((x) => x === id).length !== 1) throw new Error('消费游标重复写入');
  return 'id 幂等';
});

await step('⑩ 模型超时 → PAUSED，且不自动重试', async () => {
  await run(B.ws, { wait: 100 });
  say(B.ws, '【进入开发】');
  const r = await run(B.ws, { wait: 2000, failStage: 'IMPLEMENT', failMode: 'timeout' });
  const l = loadLedger(B.ws);
  if (r.stage !== 'PAUSED') throw new Error(`超时后应暂停，实际 ${r.stage}`);
  if (!String(l.pause_reason).includes('超时')) throw new Error(`暂停原因里没有「超时」：${l.pause_reason}`);
  const log = readText(join(B.ws, '.xwing-task/lattice/run.log'));
  if (/retry|重试/.test(log)) throw new Error('日志里出现重试痕迹');
  return `pause_reason=${l.pause_reason}`;
});

await step('⑪ PAUSED 时聊天令牌无效，操作员命令才恢复', async () => {
  say(B.ws, '【进入开发】');
  const r1 = await run(B.ws, { wait: 300 });
  if (r1.stage !== 'PAUSED') throw new Error(`聊天令牌竟解锁到 ${r1.stage}`);
  writeOperatorCommand(B.ws, { kind: 'resume', reason: '人工核对后恢复', at: new Date().toISOString() });
  await run(B.ws, { wait: 100, maxSteps: 2 });
  const l = loadLedger(B.ws);
  const rec = l.history.find((h) => h.from === 'PAUSED' && h.to === 'IMPLEMENT');
  if (!rec) throw new Error('恢复后没有回到暂停前阶段');
  if (!rec.reason.includes('人工恢复')) throw new Error('恢复原因未入账');
  return '回到 IMPLEMENT';
});

/* ---------------- 场景 C：返工回路 ---------------- */
console.log('\n场景 C · 返工回路');
const C = makeWs('verify-C', { review_blocking_rounds: 1 });

await step('⑫ 无令牌意见 = 返工；连续返工到上限 → PAUSED', async () => {
  await run(C.ws, { wait: 100 });
  say(C.ws, '【进入开发】');
  await run(C.ws, { wait: 500 });
  let l = loadLedger(C.ws);
  if (l.stage !== 'WAIT_SHIP') throw new Error(`未到 WAIT_SHIP，实际 ${l.stage}`);

  const before = l.review_iteration;
  for (let i = 0; i < 8 && loadLedger(C.ws).stage === 'WAIT_SHIP'; i++) {
    say(C.ws, '边界那条再写清楚一些');
    await run(C.ws, { wait: 500 });
  }
  l = loadLedger(C.ws);
  if (l.stage !== 'PAUSED') throw new Error(`返工 8 次仍未暂停，停在 ${l.stage}`);
  const reworks = l.history.filter((h) => h.to === 'REBASE' && h.reason.startsWith('返工')).length;
  if (l.review_iteration > 6) throw new Error(`迭代计数 ${l.review_iteration} 超过上限 6`);
  if (l.review_iteration !== before + reworks) throw new Error(`迭代计数与返工次数不一致：${l.review_iteration} vs ${before}+${reworks}`);
  if (reworks < 1) throw new Error('一次返工都没发生');
  return `${reworks} 次返工后封顶暂停（迭代 ${l.review_iteration}/6）`;
});

/* ---------------- 场景 D：本轮补的闭合项（F1/F2/F3/F4/F7/F8） ---------------- */

console.log('\n场景 D · 一致性与证据（本轮新增 6 条）');

await step('⑬ 模型说「无阻断」但报告写着阻断 → 以报告为准', async () => {
  const { runEngine } = await import('../src/engine.ts');
  const { MockRuntime } = await import('../src/runtime/mock.ts');
  const D = makeWs('verify-D', { review_blocking_rounds: 0 });
  const rt = new MockRuntime();
  rt.lieOnReview = true; // 事件报 CLEAN，报告里写满【阻断】

  const first = await runEngine({ ws: D.ws, runtime: rt, waitMs: 150, maxSteps: 30, log: () => {} });
  say(D.ws, '【进入开发】');
  const second = await runEngine({ ws: D.ws, runtime: rt, waitMs: 800, maxSteps: 40, log: () => {} });

  const l = loadLedger(D.ws);
  const patchHappened = l.history.some((h) => h.to === 'PATCH');
  if (!patchHappened) throw new Error(`报告有阻断却没进修补（停在 ${l.stage}，outcome ${second.outcome}）`);

  const ev = readEvents(D.ws).find((e) => e.kind === 'review_mismatch');
  if (!ev) throw new Error('没有记 review_mismatch 事件');
  return `按报告进 PATCH，事件已记（${ev.reason.slice(0, 28)}）`;
});

await step('⑭ 阶段超时（Runtime 永久挂住）→ PAUSED，不假成功', async () => {
  const { CFG } = await import('../src/config.ts');
  const D = makeWs('verify-E');
  const before = CFG.STAGE_TIMEOUT_SEC;
  CFG.STAGE_TIMEOUT_SEC = 0.15;

  class Hanging {
    name = 'hanging';
    runStage() {
      return new Promise(() => {}); // 永不返回
    }
  }

  let res;
  try {
    res = await runEngine({ ws: D.ws, runtime: new Hanging(), waitMs: 100, maxSteps: 5, log: () => {} });
  } finally {
    CFG.STAGE_TIMEOUT_SEC = before;
  }

  const l = loadLedger(D.ws);
  if (l.stage !== 'PAUSED') throw new Error(`超时后应 PAUSED，实际 ${l.stage}`);
  if (l.status === '已完成') throw new Error('超时被记成了已完成');
  const ev = readEvents(D.ws).find((e) => e.kind === 'stage_timeout');
  if (!ev) throw new Error('没有记 stage_timeout 事件');
  return `PAUSED，reason=${l.pause_reason?.slice(0, 20)}`;
});

await step('⑮ 提测幂等键：commit 变了 → 该步必须重跑，不能沿用旧结果', async () => {
  const { ship } = await import('../src/ship.ts');
  const { currentBranch } = await import('../src/git.ts');
  const repo = join(C.ws, 'repo');
  const l = loadLedger(C.ws);
  const t = JSON.parse(readText(join(C.ws, 'task.json')));
  const branch = currentBranch(repo);

  const r1 = await ship(C.ws, l, t, repo, branch, 'aaaaaaa');
  l.ship_steps = r1.steps;

  // 同一个 commit 再来一次：全部跳过，不产生失败
  const r2 = await ship(C.ws, l, t, repo, branch, 'aaaaaaa');
  if (!r2.ok) throw new Error(`同键重跑不该失败：${r2.failedStep}`);

  // commit 变了 + 分支不存在：merge 必须重跑并失败（旧逻辑会用旧 ok 跳过，落到 ref_verify）
  const r3 = await ship(C.ws, l, t, repo, 'no-such-branch', 'bbbbbbb');
  if (r3.failedStep !== 'merge') {
    throw new Error(`commit 变了却没重跑 merge，失败在 ${r3.failedStep ?? '无'}`);
  }
  const merged = r3.steps.find((s) => s.name === 'merge');
  if (!merged || merged.status !== 'failed') throw new Error('merge 步未标 failed');
  return '同键跳过、异键重跑';
});

await step('⑯ 合并失败后仓库必须干净（已 merge --abort），能直接重试', async () => {
  const { mergeInto } = await import('../src/git.ts');
  const { execFileSync } = await import('node:child_process');
  const repo = join(C.ws, 'repo');
  const r = mergeInto(repo, 'no-such-branch', 'develop');
  if (r.ok) throw new Error('合并不存在的分支竟然成功了');

  const status = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim();
  if (status) throw new Error(`仓库有残留改动：${status.slice(0, 120)}`);

  let mergeHead = '';
  try {
    mergeHead = execFileSync('git', ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], {
      cwd: repo,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    mergeHead = ''; // 退出码 1 = 没有 MERGE_HEAD，正是期望结果
  }
  if (mergeHead) throw new Error('仓库仍停在 MERGING 状态');
  return '无残留改动、无 MERGE_HEAD';
});

await step('⑰ 证据链按真实 diff 判定：渲染层改动没截图就拦下', async () => {
  const { checkEvidence, needsScreenshot } = await import('../src/artifacts.ts');
  const D = makeWs('verify-F');

  if (needsScreenshot(['src/virtualList.js'])) throw new Error('纯计算模块被误判成渲染层');
  if (!needsScreenshot(['src/components/List.tsx'])) throw new Error('tsx 组件没被判成渲染层');

  const bad = checkEvidence(D.ws, ['src/components/List.tsx']);
  if (bad.ok) throw new Error('渲染层改动无截图却通过了证据校验');

  mkdirSync(join(D.ws, '.xwing-task/lattice/verification/screenshots'), { recursive: true });
  writeFileSync(join(D.ws, '.xwing-task/lattice/verification/screenshots/after.png'), 'png');
  const good = checkEvidence(D.ws, ['src/components/List.tsx']);
  if (!good.ok) throw new Error(`补了截图仍不通过：${good.reason}`);

  const plain = checkEvidence(D.ws, ['src/virtualList.js']);
  if (!plain.ok) throw new Error('纯逻辑改动不该要求截图');
  return 'tsx 无图→拦；补图→过；.js→不要求';
});

await step('⑱ 多任务视图能回答「哪个任务卡住了」', async () => {
  const { summarizeTask, listTasks } = await import('../src/tasks.ts');
  const c = summarizeTask(C.ws);
  if (!c) throw new Error('无法汇总已完成任务');
  if (c.stage !== 'PAUSED') throw new Error(`C 应处于 PAUSED，实际 ${c.stage}`);
  if (!c.needs_human) throw new Error('PAUSED 没被标成需要人处理');
  if (c.run_status !== 'failed') throw new Error(`PAUSED 的运行状态应为 failed，实际 ${c.run_status}`);

  const G = makeWs('verify-G', { review_blocking_rounds: 0 });
  const g = summarizeTask(G.ws);
  if (!g) throw new Error('无法汇总未开始任务');
  if (g.needs_human) throw new Error('未开始的任务被误标成需要人处理');
  if (g.stage !== 'INIT') throw new Error(`新工作区应在 INIT，实际 ${g.stage}`);

  const all = listTasks(ROOT);
  if (!Array.isArray(all)) throw new Error('listTasks 返回值不对');
  const cAgain = all.find((x) => x.key === c.key);
  if (all.length > 0 && !cAgain) throw new Error('listTasks 没扫到 tasks/ 下的任务');
  return `${all.length} 个常驻任务；PAUSED 标卡点、INIT 不标`;
});

await step('⑲ 改了但没提交 → 判为不可交付，不出「已提测」的假完成', async () => {
  const { mustGit } = await import('../src/git.ts');
  const H = makeWs('verify-H', { review_blocking_rounds: 0 });
  await run(H.ws); // 先走到门 1
  const headBefore = mustGit(join(H.ws, 'repo'), ['rev-parse', 'HEAD']).trim();

  say(H.ws, '1A 2A 3A【进入开发】');
  // 复现真实 CLI 的行为：代码改了、产物写了、就是没提交
  await run(H.ws, { noCommit: 'IMPLEMENT' });

  const l = loadLedger(H.ws);
  if (l.stage !== 'PAUSED') throw new Error(`应停在 PAUSED，实际 ${l.stage}`);
  const last = (l.history ?? [])[(l.history ?? []).length - 1];
  if (!/不可交付/.test(last?.reason ?? '')) throw new Error(`暂停原因没说明「不可交付」：${last?.reason ?? '（空）'}`);

  const headAfter = mustGit(join(H.ws, 'repo'), ['rev-parse', 'HEAD']).trim();
  if (headAfter !== headBefore) throw new Error('故障注入没生效：居然产生了提交');
  return 'PAUSED + 原因含「不可交付」+ 仓库无新提交';
});

/* ---------------- 汇总 ---------------- */const pass = results.filter((r) => r.pass).length;
const fail = results.length - pass;
console.log(`\n结果：${pass} 通过 / ${fail} 未通过（共 ${results.length} 条）`);
if (fail > 0) {
  console.log('\n未通过：');
  for (const r of results.filter((x) => !x.pass)) console.log(`  - ${r.name}：${r.note}`);
}
process.exitCode = fail === 0 ? 0 : 1;
