import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, renameSync,
  appendFileSync, readdirSync, statSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export function ensureDir(p: string): void {
  mkdirSync(p, { recursive: true });
}

export function readJson<T>(p: string, fallback: T): T {
  if (!existsSync(p)) return fallback;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/** 原子写：先落 .tmp 再 rename，保证 kill -9 不会留下半截 JSON */
export function writeJsonAtomic(p: string, data: unknown): void {
  ensureDir(dirname(p));
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  renameSync(tmp, p);
}

export function writeTextAtomic(p: string, text: string): void {
  ensureDir(dirname(p));
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, p);
}

export function readText(p: string): string {
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
}

export function appendJsonl(p: string, obj: unknown): void {
  ensureDir(dirname(p));
  appendFileSync(p, JSON.stringify(obj) + '\n', 'utf8');
}

export function readJsonl<T>(p: string): T[] {
  const raw = readText(p);
  if (!raw.trim()) return [];
  const out: T[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      /* 坏行忽略：append-only 文件不允许因为一行损坏就读不出全部 */
    }
  }
  return out;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function sha256File(p: string): string {
  return sha256(readText(p));
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out;
}

export function rel(ws: string, p: string): string {
  return p.replace(resolve(ws) + '\\', '').replace(resolve(ws) + '/', '').replace(/\\/g, '/');
}

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  return `${m} 分 ${s % 60} 秒`;
}
