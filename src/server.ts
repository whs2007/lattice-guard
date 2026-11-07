import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CFG } from './config.ts';
import {
  appendMessage, hasLedger, loadLedger, markConsumed, readMessages, readTaskSpec,
  writeOperatorCommand,
} from './ledger.ts';
import { renderFooter, splitFooter } from './footer.ts';
import { STAGE_LABELS } from './stages.ts';
import { ARTIFACTS } from './artifacts.ts';
import { git } from './git.ts';
import { recentEvents } from './events.ts';
import { listTasks } from './tasks.ts';
import { nowIso } from './util.ts';
import { shortId } from './message.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const UI_PATH = join(HERE, '..', 'ui', 'index.html');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

function readBody(req: import('node:http').IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += String(c)));
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function json(res: import('node:http').ServerResponse, data: unknown, code = 200): void {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'content-type': MIME['.json'] });
  res.end(body);
}

export function startServer(port: number, ws: string): void {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);

    try {
      if (url.pathname === '/' || url.pathname === '/index.html') {
        const html = readFileSync(UI_PATH, 'utf8');
        res.writeHead(200, { 'content-type': MIME['.html'] });
        res.end(html);
        return;
      }

      if (url.pathname === '/api/state') {
        json(res, buildState(ws));
        return;
      }

      if (url.pathname.startsWith('/api/artifact')) {
        const p = url.searchParams.get('path') ?? '';
        if (!p.startsWith(CFG.WORKSPACE_SUBDIR)) return json(res, { ok: false }, 400);
        const full = join(ws, p);
        if (!existsSync(full)) return json(res, { ok: false, error: '不存在' }, 404);
        res.writeHead(200, { 'content-type': MIME['.md'] });
        res.end(readFileSync(full, 'utf8'));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/message') {
        const body = await readBody(req);
        const text = String(body.text ?? '').trim();
        if (!text) return json(res, { ok: false, error: '消息为空' }, 400);
        appendMessage(ws, { id: shortId(), role: 'human', text, at: nowIso() });
        json(res, { ok: true });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/resume') {
        const body = await readBody(req);
        writeOperatorCommand(ws, {
          kind: 'resume',
          reason: String(body.reason ?? '面板上人工确认恢复'),
          at: nowIso(),
        });
        json(res, { ok: true });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/retry') {
        const body = await readBody(req);
        writeOperatorCommand(ws, {
          kind: 'ship_retry',
          reason: String(body.reason ?? '面板上人工确认继续提测'),
          at: nowIso(),
        });
        json(res, { ok: true });
        return;
      }

      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('404');
    } catch (e) {
      json(res, { ok: false, error: (e as Error).message }, 500);
    }
  });

  server.on('error', (e: NodeJS.ErrnoException) => {
    const hint = e.code === 'EADDRINUSE'
      ? `端口 ${port} 已被占用，换一个：--port ${port + 1}`
      : e.code === 'EACCES'
        ? `端口 ${port} 需要管理员权限，换一个 1024 以上的端口`
        : e.message;
    console.error(`工作台启动失败：${hint}`);
    process.exit(1);
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`工作台已启动：http://127.0.0.1:${port}`);
    console.log(`工作区：${ws}`);
    console.log(`驱动进程另开一个终端：node src/main.ts run --ws "${ws}" --wait 0`);
  });
}

function buildState(ws: string): unknown {
  if (!hasLedger(ws)) return { ok: false, error: '该工作区还没有账本' };
  const l = loadLedger(ws);
  const t = readTaskSpec(ws);
  const repo = join(ws, 'repo');

  const messages = readMessages(ws).slice(-60).map((m) => {
    const { body, footer } = splitFooter(m.text);
    return { ...m, body, footer };
  });

  let gitInfo: Record<string, unknown> = {};
  if (existsSync(join(repo, '.git'))) {
    const branch = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout;
    const logRaw = git(repo, ['log', '--pretty=%h|%an|%s', '-6']).stdout;
    const commits = logRaw
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [sha, author, ...rest] = line.split('|');
        return { sha, author, msg: rest.join('|') };
      });
    gitInfo = { branch, commits };
  }

  return {
    ok: true,
    ws,
    task: t,
    ledger: {
      ...l,
      stage_label: STAGE_LABELS[l.stage],
      history: l.history.slice(-24),
    },
    footer: renderFooter(l),
    messages,
    artifacts: ARTIFACTS.map((a) => {
      const full = join(ws, a.path);
      return {
        name: a.name,
        path: a.path,
        stage: a.stage,
        owner: a.owner,
        exists: existsSync(full),
        size: existsSync(full) ? statSync(full).size : 0,
      };
    }),
    git: gitInfo,
    events: recentEvents(ws, 40),
    tasks: listTasks(join(ws, '..', '..')),
    tokens: { dev: CFG.TOKEN_DEV, ship: CFG.TOKEN_SHIP },
    config: { model: CFG.RUNTIME_LABEL, agent: CFG.AGENT_NAME, maxLoop: CFG.MAX_LOOP },
  };
}
