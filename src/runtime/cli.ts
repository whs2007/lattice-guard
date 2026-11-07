import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveCommand } from './exe.ts';
import type { ResolvedTarget } from './exe.ts';
import { parseDecisionSheet } from '../decisions.ts';
import { readText } from '../util.ts';
import { ModelError, ToolError } from '../errors.ts';
import { CFG } from '../config.ts';
import { artifactsOfStage, checkArtifacts, readReviewVerdict } from '../artifacts.ts';
import { assertDeliverable } from '../git.ts';
import { runTestCmd } from '../testrun.ts';
import type { Stage, StageEvent } from '../types.ts';
import type { Runtime, RuntimeCtx } from './types.ts';

/**
 * CLI Runtime：把组装好的上下文喂给任意 AI 编程 CLI（Claude Code / Codex / 自写脚本）。
 * 用法：HIFOX_RUNTIME_CMD="claude -p" node src/main.ts run --runtime cli
 * 它只负责启动与收产出，判断「阶段是否完成」仍由引擎的产物校验器决定。
 *
 * 与 mock 的差别（都是真实模型逼出来的）：
 * - 产物不合格时允许**同阶段内一次**补齐。这不是重试阶段，是把同一个交付物做完；
 *   上限 1 次，补齐后仍不合格就照旧 BAD_OUTPUT → PAUSED，纪律没有被放宽。
 * - 实现/修补阶段还要求改动**已提交**：提测第一步 merge 只认提交。
 */
export class CliRuntime implements Runtime {
  name: string;
  private target: ResolvedTarget;
  /** 同阶段补齐次数上限。默认 1；设 0 可关闭，用于对照实验。 */
  repairRounds = Number(process.env.HIFOX_REPAIR_ROUNDS ?? '1');

  constructor(cmd = process.env.HIFOX_RUNTIME_CMD ?? '') {
    const argv = cmd.split(/\s+/).filter(Boolean);
    if (argv.length === 0) {
      throw new ToolError('未配置 HIFOX_RUNTIME_CMD，无法使用 cli runtime', '例如 HIFOX_RUNTIME_CMD="claude -p"');
    }
    this.name = argv[0];
    // 解析成真能 spawn 的 exe：Windows 上 npm 垫片（.cmd）不能直接 spawn
    this.target = resolveCommand(argv);
  }

  async runStage(ctx: RuntimeCtx, stage: Stage): Promise<StageEvent> {
    const prompt = readText(ctx.promptPath);
    ctx.log(`runtime ${this.name}：${this.target.how}`);

    await this.invoke(ctx, prompt);

    let defects = this.stageDefects(ctx, stage);
    let last: { code: number; err: string } = { code: 0, err: '' };
    for (let round = 1; round <= this.repairRounds && defects.length > 0; round++) {
      ctx.log(`产物不合格（${defects.join('；')}）→ 同阶段内补齐第 ${round} 次`);
      last = await this.invoke(ctx, `${prompt}\n\n${repairBlock(defects)}`);
      defects = this.stageDefects(ctx, stage);
    }
    if (defects.length > 0) {
      // 非零退出码往往是「模型根本没跑起来」（额度用尽、鉴权失败、网络断），
      // 只报「产物不齐」会让人去查产物，白跑一趟。把 stderr 尾部一起带出来。
      const tail = last.code !== 0 && last.err.trim()
        ? `；最后一次模型进程退出码 ${last.code}：${last.err.trim().slice(-300)}`
        : '';
      throw new ModelError(
        `产物不齐${this.repairRounds > 0 ? `（补齐 ${this.repairRounds} 轮后仍不合格）` : ''}：${defects.join('；')}${tail}`,
        'BAD_OUTPUT',
      );
    }

    return this.eventFor(ctx, stage);
  }

  /** 起一次模型进程；超时/启动失败照旧抛错，不做任何「重试」 */
  private async invoke(ctx: RuntimeCtx, prompt: string): Promise<{ code: number; err: string }> {
    const r = await new Promise<{ code: number; out: string; err: string }>((resolve) => {
      const child = spawn(this.target.exe, this.target.args, {
        cwd: ctx.repo,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: `${ctx.trigger} & ${CFG.AGENT_NAME}`,
          GIT_AUTHOR_EMAIL: `${CFG.AGENT_SLUG}@hifox.local`,
          // 子进程的 cwd 是仓库，而产物在工作区。把工作区绝对路径显式传下去，
          // 适配器才知道要把哪个目录挂给 CLI（Claude Code 用 --add-dir，
          // Gemini CLI 用 --include-directories）。不传就只能靠模型猜路径。
          HIFOX_WS: ctx.ws,
        },
      });
      let out = '';
      let err = '';
      let killedByAbort = false;
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve({ code: 124, out, err: 'timeout' });
      }, CFG.MODEL_TIMEOUT_SEC * 1000);

      // 引擎的阶段级超时：必须真的杀掉子进程，否则只是「引擎不等了」，进程变孤儿
      const onAbort = () => {
        killedByAbort = true;
        clearTimeout(timer);
        child.kill('SIGKILL');
      };
      ctx.signal?.addEventListener('abort', onAbort, { once: true });

      child.stdout.on('data', (d) => (out += String(d)));
      child.stderr.on('data', (d) => (err += String(d)));
      child.on('error', (e) => {
        clearTimeout(timer);
        ctx.signal?.removeEventListener('abort', onAbort);
        resolve({ code: 127, out, err: String(e) });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        ctx.signal?.removeEventListener('abort', onAbort);
        resolve({ code: killedByAbort ? 124 : (code ?? 1), out, err: killedByAbort ? 'aborted' : err });
      });
      child.stdin.write(prompt);
      child.stdin.end();
    });

    if (r.code === 124) throw new ModelError('模型调用超时（>MODEL_TIMEOUT_SEC）', 'TIMEOUT');
    if (r.code === 127) throw new ToolError('Runtime 启动失败', r.err.slice(-500));
    ctx.log(
      r.code === 0
        ? `runtime ${this.name} 退出码 0`
        : `runtime ${this.name} 退出码 ${r.code}（非 0：可能鉴权/额度/网络问题，仍按产物判定）${
          r.err.trim() ? `：${r.err.trim().slice(-200)}` : ''
        }`,
    );
    return { code: r.code, err: r.err };
  }

  /**
   * 本阶段的产物缺陷清单（空数组 = 合格）。
   * 只查 owner=runtime 的产物：verification/manifest.md 由引擎在本阶段成功后才生成，
   * 在这里一并要求，会让任何真实 CLI 都必然 BAD_OUTPUT（mock 不走这条检查，所以以前没暴露）。
   */
  private stageDefects(ctx: RuntimeCtx, stage: Stage): string[] {
    const specs = artifactsOfStage(stage).filter((a) => a.owner === 'runtime');
    const check = checkArtifacts(ctx.ws, specs);
    const out = [
      ...check.missing.map((p) => `缺文件 ${p}`),
      ...check.problems,
    ];
    if (stage === 'IMPLEMENT' || stage === 'PATCH') {
      const d = assertDeliverable(ctx.repo, ctx.ledger.baseline_branch);
      if (!d.ok) out.push(`改动没有落进提交：${d.reason}`);
    }
    return out;
  }

  private eventFor(ctx: RuntimeCtx, stage: Stage): StageEvent {
    switch (stage) {
      case 'DIAGNOSE':
        return { type: 'DIAG_DONE', reason: '诊断与方案产物落盘', pendingDecisions: countDecisions(ctx) };
      case 'IMPLEMENT':
        return { type: 'CODE_DONE', reason: '代码改动已落盘（已提交）' };
      case 'REBASE':
        return { type: 'REBASE_OK', reason: '已对齐基线' };
      case 'REVIEW': {
        // 与引擎用同一套判读规则：报告是凭据，不看模型在 stdout 里怎么自称
        const v = readReviewVerdict(ctx.ws, `${CFG.WORKSPACE_SUBDIR}/review-report.md`);
        if (v.clean) return { type: 'REVIEW_CLEAN', reason: '0 阻断' };
        return { type: 'REVIEW_BLOCKING', reason: v.detail, blocking: Math.max(v.blocking, 1) };
      }
      case 'PATCH':
        return { type: 'PATCH_DONE', reason: '按报告修补完成（已提交）' };
      case 'VERIFY': {
        const r = runTestCmd(ctx.repo, ctx.task.test_cmd);
        if (!r.ok) return { type: 'VERIFY_FAIL', reason: `测试失败：退出码 ${r.code}` };
        return { type: 'VERIFY_PASS', reason: `${r.cmd} 全绿` };
      }
      default:
        throw new ModelError(`cli runtime 不支持阶段 ${stage}`);
    }
  }
}

/** 补齐提示：只针对具体缺陷，不许顺手改别处 */
function repairBlock(defects: string[]): string {
  return [
    '---',
    '',
    '# 追加：本轮产物不合格',
    '',
    '引擎按产物校验器判定下列问题，请**只**修正它们，其余内容不要改动：',
    '',
    ...defects.map((d) => `- ${d}`),
    '',
    '说明：',
    '- 「缺文件」= 该路径下没有这个文件，按模板写出来。',
    '- 「缺少必备段落」= 文件里没有这一行小节标题，按模板原样补上标题（内容可保留你已有的表述）。',
    '- 「改动没有落进提交」= 代码改了但没 commit，执行 `git add -A && git commit -m "<做了什么>"`。',
  ].join('\n');
}

/** 决策题数必须和门禁用同一个解析器，否则页脚上的「待此决策」会和门对不上 */
function countDecisions(ctx: RuntimeCtx): number {
  const p = join(ctx.ws, CFG.WORKSPACE_SUBDIR, 'idea.md');
  if (!existsSync(p)) return 0;
  return Object.keys(parseDecisionSheet(ctx.ws, `${CFG.WORKSPACE_SUBDIR}/idea.md`)).length;
}
