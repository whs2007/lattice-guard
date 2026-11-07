import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CFG } from './config.ts';
import { ModelError, StateError, ToolError } from './errors.ts';
import { appendJsonl, ensureDir, nowIso, readText, sha256File, writeJsonAtomic, writeTextAtomic } from './util.ts';
import { runTestCmd, testStat } from './testrun.ts';
import { assertDeliverable, compareUrl, git, mergeInto } from './git.ts';
import type { Ledger, ShipStepRec, TaskSpec } from './types.ts';

export interface ShipResult {
  ok: boolean;
  steps: ShipStepRec[];
  failedStep?: string;
  detail?: string;
  commit: string;
}

interface StepDef {
  name: string;
  key: (commit: string) => string;
  run: () => void;
}

/**
 * 提测七步：合并 → ref 校验 → 回归 → 评论 → 回填字段 → 停环境 → 转状态。
 * 每一步都有幂等键；任一步失败立即停，账本进 PARTIAL_SHIP，绝不改任务状态。
 */
export async function ship(
  ws: string,
  l: Ledger,
  task: TaskSpec,
  repo: string,
  branch: string,
  commit: string,
): Promise<ShipResult> {
  const base = l.baseline_branch;
  const steps: ShipStepRec[] = l.ship_steps.length > 0
    ? l.ship_steps.map((s) => ({ ...s }))
    : [];

  const summary = readText(join(ws, CFG.WORKSPACE_SUBDIR, 'ship-summary.md'));
  const compare = compareUrl(repo, base, branch);

  const defs: StepDef[] = [
    {
      name: 'merge',
      key: (c) => `merge:${task.key}:${c}`,
      run: () => {
        // 合并前的最后一道闸：分支上必须有超出基线的提交，否则 merge 是空操作，
        // 任务会带着「已提测」的状态却什么都没交付。
        const d = assertDeliverable(repo, base);
        if (!d.ok) throw new ToolError('没有可合并的提交，拒绝提测', d.reason);
        const r = mergeInto(repo, branch, base);
        if (!r.ok) {
          throw new ToolError(
            `合并到 ${base} 失败${r.aborted ? '（已 merge --abort 回滚，仓库干净可重试）' : '（回滚失败，需人工检查仓库状态）'}`,
            r.stderr.slice(-800),
          );
        }
      },
    },
    {
      name: 'ref_verify',
      key: (c) => `ref:${task.key}:${c}`,
      run: () => {
        const merged = git(repo, ['branch', '--merged', base]);
        if (!merged.ok || !merged.stdout.includes(branch)) {
          throw new ToolError(`${branch} 未被 ${base} 合并`);
        }
      },
    },
    {
      name: 'retest',
      key: (c) => `retest:${task.key}:${c}`,
      run: () => {
        const r = runTestCmd(repo, task.test_cmd);
        if (!r.ok) throw new ToolError(`合并后回归失败（退出码 ${r.code}）`, r.output.slice(-800));
      },
    },
    {
      name: 'comment',
      key: () => `comment:${task.key}:ship`,
      run: () => {
        const body = [
          '## 提测完成',
          '',
          `分支：\`${branch}\` → \`${base}\`（${commit}）`,
          compare ? `对比：${compare}` : '对比：（仓库无可识别的 Web 远端，仅记录分支名）',
          '',
          summary || '（提测包摘要缺失）',
        ].join('\n');
        appendJsonl(join(ws, CFG.WORKSPACE_SUBDIR, 'comments.jsonl'), {
          task: task.key,
          at: nowIso(),
          source: 'ship',
          body,
          compare_url: compare,
        });
      },
    },
    {
      name: 'backfill',
      key: (c) => `backfill:${task.key}:${sha256File(join(ws, CFG.WORKSPACE_SUBDIR, 'ship-summary.md')).slice(0, 10)}:${c}`,
      run: () => {
        const sections = parseSummary(summary);
        writeAgentField(ws, task, '实现结果', sections['改动'] ?? '');
        writeAgentField(ws, task, '测试要点', sections['实测'] ?? '');
        writeAgentField(ws, task, '人工测试要求', 'L1：低风险（单一改动面小改、证据完整）');
      },
    },
    {
      name: 'env_stop',
      key: () => `envstop:${task.key}`,
      run: () => {
        task.env = { running: false, port: null };
        writeJsonAtomic(join(ws, 'env.json'), task.env);
      },
    },
    {
      name: 'status',
      key: () => `status:${task.key}:待测试`,
      run: () => {
        if (task.status === '待测试') return;
        task.status = '待测试';
      },
    },
  ];

  for (let i = 0; i < defs.length; i++) {
    const def = defs[i];
    const seq = i + 1;
    const idem = def.key(commit);
    let rec = steps.find((s) => s.seq === seq && s.name === def.name);

    if (rec && rec.status === 'ok') {
      if (rec.idem_key === idem) {
        // 真正的幂等：同一个键、同一个结果，跳过
        continue;
      }
      // 键变了 ⇒ 这一步的输入变了（通常是 commit 变了）⇒ 旧结果不再代表当前输入，必须重跑
      rec.status = 'pending';
      rec.detail = `幂等键变更，重跑（${rec.idem_key} → ${idem}）`;
    }
    if (!rec) {
      rec = { seq, name: def.name, status: 'pending', idem_key: idem };
      steps.push(rec);
    }
    rec.name = def.name;
    rec.idem_key = idem;

    try {
      def.run();
      rec.status = 'ok';
      rec.at = nowIso();
      rec.detail = undefined;
    } catch (e) {
      rec.status = 'failed';
      rec.at = nowIso();
      rec.detail = (e as Error).message;
      const detail = e instanceof ToolError ? `${e.message}｜${e.detail}` : (e as Error).message;
      steps.sort((a, b) => a.seq - b.seq);
      return { ok: false, steps, failedStep: def.name, detail, commit };
    }
  }

  steps.sort((a, b) => a.seq - b.seq);
  return { ok: true, steps, commit };
}

/* ------------------------------ 内部工具 ------------------------------ */

function parseSummary(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const parts = text.split(/^## /m).slice(1);
  for (const p of parts) {
    const nl = p.indexOf('\n');
    if (nl < 0) continue;
    out[p.slice(0, nl).trim()] = p.slice(nl + 1).trim();
  }
  return out;
}

/**
 * Agent 段落写入协议（真实生产规则）：
 * 以 `### Agent 记录` 开头，人写的内容保留在上方，已有 Agent 段只整段替换。
 */
export function writeAgentField(ws: string, task: TaskSpec, field: string, body: string): void {
  const MARK = '### Agent 记录';
  const NOTE = '> 本节由 Agent 维护，每次整段覆盖；人工内容请写在本节之上。';
  const current = task.custom_fields[field] ?? '';
  const idx = current.indexOf(MARK);
  const human = idx >= 0 ? current.slice(0, idx).trim() : current.trim();
  const next = [human, MARK, NOTE, '', body.trim()].filter((s, i) => i === 0 || s !== '').join('\n').trim();
  task.custom_fields[field] = next;
  writeJsonAtomic(join(ws, 'task.json'), task);
}

export function recordShipLog(ws: string, result: ShipResult): void {
  ensureDir(join(ws, CFG.WORKSPACE_SUBDIR));
  const lines = result.steps.map((s) => `${s.seq}. ${s.name} → ${s.status}${s.detail ? '：' + s.detail : ''}`);
  writeTextAtomic(join(ws, CFG.WORKSPACE_SUBDIR, 'ship-steps.log'), lines.join('\n') + '\n');
}

export function assertShipPreconditions(ws: string): void {
  const need = ['ship-summary.md', 'verification/manifest.md'];
  for (const n of need) {
    if (!existsSync(join(ws, CFG.WORKSPACE_SUBDIR, n))) {
      throw new StateError(`提测前置产物缺失：${n}`, 'SHIP_PRECONDITION');
    }
  }
}

export type { ModelError };
