import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderFooter, parseFooter, assertFooterMatchesLedger, splitFooter } from '../src/footer.ts';
import { createLedger } from '../src/ledger.ts';
import { parseHumanMessage, resolvePicks } from '../src/message.ts';
import { nextStage, STAGE_LABELS, applyStageEffects } from '../src/stages.ts';
import { projectRunToTask, stageToHandoff } from '../src/stateAxes.ts';

const task = {
  key: 'HF-14690', title: 't', description: 'd', space: 's', type: '缺陷', priority: '普通',
  labels: [], status: 'In Progress', repo: '', base_branch: 'develop', test_cmd: 'node --test',
  patch_ops: [], review_blocking_rounds: 0, custom_fields: {}, env: { running: false, port: null },
};
const l0 = createLedger(task, '/tmp/ws', 'develop');

test('页脚可往返：生成后能解析回全部 11 个字段', () => {
  const f = parseFooter(renderFooter({ ...l0, stage: 'WAIT_DEV', waiting: '【进入开发】', expected_token: '【进入开发】', status: '等待确认', pending_decisions: 3, skills: ['lattice-idea'], artifacts: ['a.md', 'b.md'] }));
  assert.equal(f['任务ID'], 'HF-14690');
  assert.equal(f['等待'], '【进入开发】');
  assert.equal(f['阶段'], '等待进入开发');
  assert.equal(f['待此决策'], '3');
});

test('WALT_SHIP 之后的阶段用「待批决策」这个显示名', () => {
  const s = renderFooter({ ...l0, stage: 'DONE', status: '已完成', expected_token: null, waiting: null });
  assert.ok(s.includes('待批决策:'));
  assert.ok(!s.includes('待此决策:'));
});

test('门 2 之前（含 WAIT_SHIP）仍是「待此决策」——照原文逐字页脚', () => {
  const s = renderFooter({ ...l0, stage: 'WAIT_SHIP', waiting: '【提测】', expected_token: '【提测】', status: '等待确认' });
  assert.ok(s.includes('待此决策:'));
  assert.ok(!s.includes('待批决策:'));
});

test('阶段产物只列本阶段交付物，不累计历史', () => {
  const l = {
    ...l0,
    stage: 'WAIT_SHIP',
    artifacts: [
      '.xwing-task/lattice/diagnosis.md',
      '.xwing-task/lattice/idea.md',
      '.xwing-task/lattice/plan.md',
      '.xwing-task/lattice/review-report.md',
      '.xwing-task/lattice/ship-summary.md',
      '.xwing-task/lattice/verification/manifest.md',
    ],
  };
  const s = renderFooter(l);
  assert.ok(s.includes('阶段产物: .xwing-task/lattice/ship-summary.md, .xwing-task/lattice/verification/manifest.md ---页脚结束---'));
  assert.ok(!s.includes('阶段产物: .xwing-task/lattice/diagnosis.md'));
});

test('终态：技能加载 lattice-deliver，待批决策清零', () => {
  const l = { ...l0, stage: 'WAIT_SHIP', pending_decisions: 5, status: '等待确认' };
  applyStageEffects(l, 'DONE', { type: 'SHIP_DONE' }, '2026-11-07T00:00:00Z');
  l.stage = 'DONE';
  assert.equal(l.pending_decisions, 0);
  assert.deepEqual(l.skills, ['lattice-deliver']);
  const s = renderFooter(l);
  assert.ok(s.includes('待批决策: 0'));
  assert.ok(s.includes('技能加载: lattice-deliver'));
});

test('页脚与账本不一致时必须报错', () => {
  const l = { ...l0, stage: 'WAIT_DEV', waiting: '【进入开发】', expected_token: '【进入开发】', status: '等待确认' };
  const bad = renderFooter(l).replace('任务ID: HF-14690', '任务ID: HF-99999');
  assert.throws(() => assertFooterMatchesLedger(bad, l), /不一致/);
});

test('splitFooter 把正文与页脚分开', () => {
  const { body, footer } = splitFooter('结论\n\n' + renderFooter(l0));
  assert.equal(body, '结论');
  assert.ok(footer.startsWith('---页脚开始---'));
});

test('令牌必须在末尾才算授权', () => {
  assert.equal(parseHumanMessage('1A 2A 3A【进入开发】').token, '【进入开发】');
  assert.equal(parseHumanMessage('【进入开发】帮我看下').token, null);
  assert.equal(parseHumanMessage('继续').token, null);
});

test('1A 2A 3A 解析成决策选择', () => {
  const p = parseHumanMessage('1B 2A 3C【进入开发】');
  assert.deepEqual(p.picks, { 1: 'B', 2: 'A', 3: 'C' });
});

test('只发令牌时全部按推荐项补齐', () => {
  const picks = resolvePicks({}, { 1: 'A', 2: 'A', 3: 'A' });
  assert.deepEqual(picks, { 1: 'A', 2: 'A', 3: 'A' });
});

test('六轮上限：第 7 次阻断落到 PAUSED', () => {
  const l = { ...l0, stage: 'REVIEW', review_iteration: 6 };
  const r = nextStage(l, { type: 'REVIEW_BLOCKING', reason: 'x', blocking: 1 });
  assert.equal(r.to, 'PAUSED');
  const ok = nextStage({ ...l, review_iteration: 5 }, { type: 'REVIEW_BLOCKING', reason: 'x', blocking: 1 });
  assert.equal(ok.to, 'PATCH');
});

test('PAUSED 有出口：回到暂停前阶段', () => {
  const l = { ...l0, stage: 'PAUSED', history: [{ from: 'VERIFY', to: 'PAUSED', reason: 'x', at: 'now' }] };
  assert.equal(nextStage(l, { type: 'OPERATOR_RESUME', reason: 'r' }).to, 'VERIFY');
});

test('运行失败不改任务状态（四套状态轴隔离）', () => {
  assert.equal(projectRunToTask('failed'), null);
  assert.equal(projectRunToTask('completed'), 'In Review');
  assert.equal(stageToHandoff('WAIT_DEV'), 'waiting_reply');
  assert.equal(stageToHandoff('IMPLEMENT'), null);
});

test('每个阶段都有中文显示名', () => {
  for (const s of Object.keys(STAGE_LABELS)) assert.ok(STAGE_LABELS[s].length > 0);
});

test('决策表有 7 列（编号/决策点/选项/…）时也能解析出 1A/1B', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { parseDecisionSheet } = await import('../src/decisions.ts');
  const ws = mkdtempSync(join(tmpdir(), 'hifox-dec-'));
  mkdirSync(join(ws, '.xwing-task/lattice'), { recursive: true });
  writeFileSync(join(ws, '.xwing-task/lattice/idea.md'), [
    '## 决策表',
    '',
    '| 编号 | 决策点 | 选项 | 做法 | 影响 | 成本 | 建议 |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    '| 1 | 起点计算 | 1A | clamp 后夹取 | 满足用例 | 1 行 | ✅ 推荐 |',
    '| 1 | 起点计算 | 1B | 不夹取 | 区间非法 | 1 行 | ❌ 否决 |',
    '| 2 | 语义 | 2A | 保持 | 无副作用 | 0 行 | ✅ 推荐 |',
    '',
  ].join('\n'));
  const sheet = parseDecisionSheet(ws, '.xwing-task/lattice/idea.md');
  assert.deepEqual(sheet['1'].options, ['A', 'B']);
  assert.equal(sheet['1'].recommended, 'A');
  assert.equal(sheet['2'].recommended, 'A');
});

test('「改动可交付」判据：有提交且干净才算数', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const { assertDeliverable, commitsAhead } = await import('../src/git.ts');

  const repo = mkdtempSync(join(tmpdir(), 'hifox-git-'));
  const g = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
  g('init', '-q', '-b', 'develop');
  g('config', 'user.email', 't@t');
  g('config', 'user.name', 't');
  writeFileSync(join(repo, 'a.js'), 'export const a = 1;\n');
  g('add', '-A');
  g('commit', '-q', '-m', 'init');

  // ① 只有初始提交，没有任何超出基线的改动 → 不可交付
  const none = assertDeliverable(repo, 'develop');
  assert.equal(none.ok, false, '没有新提交时必须判不可交付');
  assert.match(none.reason, /没有超出/);

  // 切到任务分支（真实流程里改动发生在任务分支上，不是为了给 develop 自己加提交）
  g('checkout', '-q', '-b', 'task');

  // ② 改了但没提交 → 不可交付，且原因要点出未提交的文件
  writeFileSync(join(repo, 'a.js'), 'export const a = 2;\n');
  const dirty = assertDeliverable(repo, 'develop');
  assert.equal(dirty.ok, false, '工作树脏时必须判不可交付');
  assert.match(dirty.reason, /未提交/);
  assert.match(dirty.reason, /a\.js/);

  // ③ 真提交了 → 可交付
  g('add', '-A');
  g('commit', '-q', '-m', 'fix');
  assert.equal(commitsAhead(repo, 'develop'), 1);
  assert.equal(assertDeliverable(repo, 'develop').ok, true);
});
