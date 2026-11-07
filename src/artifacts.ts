import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { CFG } from './config.ts';
import { readText, sha256File, ensureDir, writeTextAtomic } from './util.ts';
import type { Stage } from './types.ts';

export interface ArtifactSpec {
  name: string;
  /** 相对任务工作区根的路径 */
  path: string;
  /** 离开该阶段前必须存在 */
  stage: Stage;
  /** 必备段落（缺一即判不合格） */
  sections: string[];
  /** 谁写：runtime = 模型侧产物，engine = 引擎生成 */
  owner: 'runtime' | 'engine';
  /** 条件必填 */
  conditional?: boolean;
}

const P = (n: string) => `${CFG.WORKSPACE_SUBDIR}/${n}`;

export const ARTIFACTS: ArtifactSpec[] = [
  {
    name: 'diagnosis.md', path: P('diagnosis.md'), stage: 'DIAGNOSE', owner: 'runtime',
    sections: ['问题如何复现', '根因在哪', '证据来自何处'],
  },
  {
    name: 'idea.md', path: P('idea.md'), stage: 'DIAGNOSE', owner: 'runtime',
    sections: ['改什么', '哪些行为保持不变', '哪些需要用户选择'],
  },
  {
    name: 'findings.md', path: P('findings.md'), stage: 'IMPLEMENT', owner: 'runtime',
    sections: ['读过的文件'],
  },
  {
    name: 'plan.md', path: P('plan.md'), stage: 'IMPLEMENT', owner: 'runtime',
    sections: ['改哪些位置', '如何验证'],
  },
  {
    name: 'plan-delta.md', path: P('plan-delta.md'), stage: 'IMPLEMENT', owner: 'runtime',
    sections: ['原计划', '实际', '为何偏离'], conditional: true,
  },
  {
    name: 'review-report.md', path: P('review-report.md'), stage: 'REVIEW', owner: 'runtime',
    sections: ['根因', '调用方', '测试覆盖', '旧路径残留', '阻断项'],
  },
  {
    name: 'ship-summary.md', path: P('ship-summary.md'), stage: 'VERIFY', owner: 'runtime',
    sections: ['改动', '实测', '检查', '人工优先看', '待批决策'],
  },
  {
    name: 'verification/manifest.md', path: P('verification/manifest.md'), stage: 'VERIFY',
    owner: 'engine', sections: ['测试命令', '退出码'],
  },
];

export function artifactSpec(name: string): ArtifactSpec | undefined {
  return ARTIFACTS.find((a) => a.name === name);
}

/**
 * 必备段落的同义写法。
 *
 * 这不是放宽标准，而是承认「小节标题」是代理指标：真实模型会写
 * 「需要人类拍板」而不是「哪些需要用户选择」，内容全在，只是措辞不同。
 * 表里只收**真实跑出来过**的写法，不收「我觉得可能这么写」的猜测。
 */
const SECTION_ALIASES: Record<string, string[]> = {
  哪些行为保持不变: ['行为保持不变', '保持不变', '哪些不变', '不变量', '不能变的部分', '对外不变', '不变', '不改'],
  哪些需要用户选择: ['需要用户选择', '用户选择', '需要人类拍板', '需要拍板', '待人类决定', '需要你决定'],
  人工优先看: ['优先看', '先看哪里', '人工复核要点'],
  待批决策: ['待追认', '需要追认的决策', '自主决定'],
};

function normalizeSection(s: string): string {
  return s.replace(/[\s#*`>：:。，,、（）()「」【】\[\]\-_]/g, '');
}

/** 段落是否存在：按已知同义写法归一化后做包含匹配（不按行首 `##` 死抠） */
export function hasSection(text: string, section: string): boolean {
  const t = normalizeSection(text);
  for (const cand of [section, ...(SECTION_ALIASES[section] ?? [])]) {
    if (t.includes(normalizeSection(cand))) return true;
  }
  return false;
}

export function artifactsOfStage(stage: Stage): ArtifactSpec[] {
  return ARTIFACTS.filter((a) => a.stage === stage && !a.conditional);
}

export interface ArtifactCheck {
  ok: boolean;
  missing: string[];
  problems: string[];
  hashes: Record<string, string>;
}

/** 产物校验：存在 + 非空 + 必备段落齐 + 哈希可算 */
export function checkArtifacts(ws: string, specs: ArtifactSpec[]): ArtifactCheck {
  const missing: string[] = [];
  const problems: string[] = [];
  const hashes: Record<string, string> = {};

  for (const s of specs) {
    const full = join(ws, s.path);
    if (!existsSync(full)) {
      if (!s.conditional) missing.push(s.path);
      continue;
    }
    const text = readText(full);
    if (text.trim().length < 20) {
      problems.push(`${s.path} 内容过短（空结果）`);
      continue;
    }
    for (const sec of s.sections) {
      if (!hasSection(text, sec)) problems.push(`${s.path} 缺少必备段落「${sec}」`);
    }
    hashes[s.path] = sha256File(full);
  }

  return { ok: missing.length === 0 && problems.length === 0, missing, problems, hashes };
}

export interface ReviewVerdict {
  clean: boolean;
  blocking: number;
  /** section = 有小节且可判读；missing-section = 缺小节（视为不合格）；empty = 文件为空 */
  source: 'section' | 'missing-section' | 'empty';
  detail: string;
}

/**
 * 评审结论的唯一判定源。
 * 规则：**以报告为凭据**，不是以模型那句「评审通过」为凭据。
 * - 没有「阻断项」小节 → 不合格（缺证据），blocking 至少按 1 计
 * - 小节正文只有「无 / 无阻断发现」→ clean
 * - 其余情况按【阻断】标记数与条目数取大
 */
export function readReviewVerdict(ws: string, path: string): ReviewVerdict {
  const text = readText(join(ws, path));
  if (!text.trim()) {
    return { clean: false, blocking: 1, source: 'empty', detail: '评审报告为空' };
  }
  const sec = sectionBody(text, '阻断项');
  if (sec === null) {
    return { clean: false, blocking: 1, source: 'missing-section', detail: '评审报告缺少「阻断项」小节' };
  }
  const body = sec.trim();
  const stripped = body.replace(/[*_`\s]/g, '');
  if (/^(无|无阻断|无阻断发现|none|None)[。.！!]?$/.test(stripped) || body.includes('无阻断发现')) {
    return { clean: true, blocking: 0, source: 'section', detail: '无阻断' };
  }
  const marks = (body.match(/【阻断】/g) ?? []).length;
  const items = body.split('\n').filter((l) => /^\s*(?:\d+[.、)]|[-*])\s+\S/.test(l)).length;
  const n = Math.max(marks, items, 1);
  return { clean: false, blocking: n, source: 'section', detail: `${n} 项阻断` };
}

/** 兼容旧调用点：是否无阻断（判读规则见 readReviewVerdict） */
export function reviewIsClean(ws: string, path: string): boolean {
  return readReviewVerdict(ws, path).clean;
}

/** 取 `## 名称` 小节的正文；没有该小节返回 null */
export function sectionBody(text: string, name: string): string | null {
  const lines = text.split('\n');
  const re = new RegExp(`^#{1,6}\\s*${name}`);
  const start = lines.findIndex((l) => re.test(l.trim()));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,6}\s+\S/.test(lines[i].trim())) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join('\n');
}

/* --------------------------- 证据链 --------------------------- */

/**
 * 哪些改动算「渲染层」—— 也就是必须给出页面证据的改动。
 * 故意只认渲染层：纯计算模块（如 virtualList.js）改的是逻辑，截图证明不了正确性，
 * 过度要求截图只会让人敷衍截一张。
 */
const RENDER_RE =
  /\.(tsx|jsx|vue|svelte|css|scss|less|sass|html?)$|(^|\/)(components|pages|views|ui|layouts)\//i;

export function needsScreenshot(changedFiles: string[]): boolean {
  return changedFiles.some((f) => RENDER_RE.test(f));
}

export interface EvidenceCheck {
  ok: boolean;
  needsScreenshot: boolean;
  screenshots: string[];
  reason: string;
}

/** 在 verification/screenshots/ 下找图片证据 */
export function findScreenshots(ws: string): string[] {
  const dir = join(ws, `${CFG.WORKSPACE_SUBDIR}/verification/screenshots`);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => /\.(png|jpe?g|webp|gif)$/i.test(f))
      .map((f) => `verification/screenshots/${f}`);
  } catch {
    return [];
  }
}

/**
 * 证据是否足够 —— 按**真实 diff** 判定，不写死结论。
 * 渲染层改动没有截图 = 证据不足 = 不能进入提测（这条以前是假通过的）。
 */
export function checkEvidence(ws: string, changedFiles: string[]): EvidenceCheck {
  const shots = findScreenshots(ws);
  const need = needsScreenshot(changedFiles);
  if (need && shots.length === 0) {
    return {
      ok: false,
      needsScreenshot: true,
      screenshots: shots,
      reason: `改动涉及渲染层文件（${changedFiles.filter((f) => RENDER_RE.test(f)).join(', ')}），但 verification/screenshots/ 下没有截图证据`,
    };
  }
  return {
    ok: true,
    needsScreenshot: need,
    screenshots: shots,
    reason: need ? '渲染层改动已附截图' : '改动未涉及渲染层，无需截图',
  };
}

/**
 * 验证证据索引由引擎生成，不交给模型（与页脚同一原则）。
 * 证据本身是模型跑出来的，引擎只做登记与哈希。
 */
export function writeVerificationManifest(
  ws: string,
  info: {
    taskKey: string;
    cmd: string;
    code: number;
    summary: string;
    at: string;
    changedFiles?: string[];
    evidence?: EvidenceCheck;
  },
): string {
  const p = join(ws, `${CFG.WORKSPACE_SUBDIR}/verification/manifest.md`);
  const files = info.changedFiles ?? [];
  const ev = info.evidence ?? checkEvidence(ws, files);
  const body = [
    `# 验证证据 · ${info.taskKey}`,
    '',
    '## 测试命令',
    `\`${info.cmd}\``,
    '',
    '## 退出码',
    String(info.code),
    '',
    '## 关键输出',
    info.summary,
    '',
    '## 改动文件',
    files.length > 0 ? files.map((f) => `- ${f}`).join('\n') : '- （无 diff：仓库只有一次提交）',
    '',
    '## 截图证据',
    ev.needsScreenshot
      ? ev.screenshots.length > 0
        ? ev.screenshots.map((s) => `- ${s}`).join('\n')
        : '- 缺失（渲染层改动必须有截图，本次已因此拦下）'
      : `- 无需截图：${ev.reason}`,
    '',
    '## 生成方式',
    `引擎生成于 ${info.at}，不交给模型，避免证据索引漂移。`,
  ].join('\n');
  ensureDir(join(ws, `${CFG.WORKSPACE_SUBDIR}/verification`));
  writeTextAtomic(p, body + '\n');
  return p;
}
