import { execFileSync } from 'node:child_process';
import { CFG } from './config.ts';

export interface TestRun {
  ok: boolean;
  code: number;
  output: string;
  cmd: string;
}

/** 跑仓库约定的测试命令；失败不抛错，把退出码与输出带回去 */
export function runTestCmd(cwd: string, cmd = 'node --test'): TestRun {
  const [bin, ...args] = cmd.split(/\s+/);
  try {
    const out = execFileSync(bin, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: CFG.TOOL_TIMEOUT_SEC * 1000,
    });
    return { ok: true, code: 0, output: out, cmd };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      code: err.status ?? 1,
      output: `${err.stdout ?? ''}\n${err.stderr ?? err.message ?? ''}`.trim(),
      cmd,
    };
  }
}

export function testStat(output: string): string {
  const pass = output.match(/# pass (\d+)/)?.[1];
  const fail = output.match(/# fail (\d+)/)?.[1];
  if (pass || fail) return `pass ${pass ?? 0} / fail ${fail ?? 0}`;
  return '见输出';
}
