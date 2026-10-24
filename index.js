/**
 * dsh-memory-tree — Host half.
 *
 * It owns three things:
 *   1. the data directory (default `~/.dsh/memory`), seeded with default configs;
 *   2. one HTTP route that serves the generated page;
 *   3. the refresh timer that collects DSH session logs and rebuilds the page.
 *
 * The pipeline itself lives in `src/` and runs as child processes on the same
 * Node binary, so a refresh never blocks the Host event loop.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const inject = ['webServer'];

const CODE_DIR = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.join(CODE_DIR, 'src');
const DEFAULTS_DIR = path.join(SRC_DIR, 'defaults');
const ROUTE = '/memory-tree';
const REFRESH_ROUTE = '/memory-tree/refresh';
/** 手动刷新必须带这个头：同源页面才拿得到这个值，跨站请求带不上自定义头。 */
const REFRESH_HEADER = 'x-dsh-memory-tree';
const DEFAULT_DATA_DIR = path.join(os.homedir(), '.dsh', 'memory');

const PENDING_PAGE = `<!doctype html><meta charset="utf-8">
<title>记忆之树 · 正在生成</title>
<style>body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
background:#07090a;color:#8e99a8;font:14px/1.7 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
div{max-width:560px;padding:0 24px}code{color:#c2ccd9}</style>
<div><p>记忆之树还没有生成。</p>
<p>插件会在后台首次采集 DSH 的会话日志并建库，几秒后刷新这一页即可。</p>
<p id="msg"></p></div>
<script>setTimeout(function(){location.reload()},5000)</script>`;

const ERROR_PAGE = (text) => `<!doctype html><meta charset="utf-8">
<title>记忆之树 · 生成失败</title>
<style>body{margin:0;padding:32px;background:#07090a;color:#c8d2df;
font:13px/1.7 ui-monospace,Consolas,monospace;white-space:pre-wrap}</style>
<div>生成记忆之树失败：\n\n${escapeHtml(text)}</div>`;

function escapeHtml(text) {
  return String(text).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
}

/** `~` 展开、相对路径补全。 */
function resolveDir(input) {
  if (!input) return DEFAULT_DATA_DIR;
  const raw = String(input);
  const expanded = raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')
    ? path.join(os.homedir(), raw.slice(1))
    : raw;
  return path.resolve(expanded);
}

/** 第一次运行时把默认配置放进去，已有的绝不覆盖。 */
function seedDefaults(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  for (const name of ['profile.json', 'decay.json', 'sources.json']) {
    const target = path.join(dataDir, name);
    if (fs.existsSync(target)) continue;
    try {
      fs.copyFileSync(path.join(DEFAULTS_DIR, name), target);
    } catch (error) {
      console.warn('[dsh-memory-tree] cannot seed %s: %s', name, error?.message ?? error);
    }
  }
}

/** 跑一个脚本；永远 resolve，把失败原因带出来。 */
function run(script, args, env) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ['--no-warnings', path.join(SRC_DIR, script), ...args],
      { env, timeout: 180_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({ ok: !error, stdout: String(stdout ?? ''), error: error ? String(stderr || error.message) : '' });
      },
    );
  });
}

/**
 * @param ctx - Host plugin context with `webServer`.
 * @param config - `memoryDir`, `refreshMinutes`, `digest`, `sessionsDir`.
 */
export function apply(ctx, config = {}) {
  const options = config ?? {};
  const dataDir = resolveDir(options.memoryDir);
  const minutes = Number.isFinite(options.refreshMinutes) ? Number(options.refreshMinutes) : 15;
  const digest = options.digest !== false;

  try {
    seedDefaults(dataDir);
  } catch (error) {
    console.warn('[dsh-memory-tree] cannot prepare %s: %s', dataDir, error?.message ?? error);
  }

  const env = {
    ...process.env,
    DSH_MEMORY_DIR: dataDir,
    DSH_MEMORY_DIGEST: digest ? '1' : '0',
  };
  if (options.sessionsDir) env.DSH_SESSIONS_DIR = resolveDir(options.sessionsDir);

  const reportFile = path.join(dataDir, 'report.html');
  const dbFile = path.join(dataDir, 'memory.db');

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE,
    handler: async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('GET only');
        return;
      }
      const send = (status, type, body) => {
        res.writeHead(status, {
          'content-type': type,
          'content-length': Buffer.byteLength(body),
          'cache-control': 'no-store',
        });
        res.end(req.method === 'HEAD' ? undefined : body);
      };

      try {
        const html = await fsp.readFile(reportFile, 'utf8');
        send(200, 'text/html; charset=utf-8', html);
        return;
      } catch {
        // 还没有页面：现场生成一次再答
        const result = await run('report.mjs', [], env);
        try {
          const html = await fsp.readFile(reportFile, 'utf8');
          send(200, 'text/html; charset=utf-8', html);
          return;
        } catch {
          send(200, 'text/html; charset=utf-8', result.ok ? PENDING_PAGE : ERROR_PAGE(result.error));
        }
      }
    },
  }), 'dsh-memory-tree: page route');

  // 手动刷新：面板上的按钮走这条。带一个守卫头，别的页面不能跨站触发。
  let refreshing = false;
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: REFRESH_ROUTE,
    handler: async (req, res) => {
      const sendJson = (status, payload) => {
        const body = JSON.stringify(payload);
        res.writeHead(status, {
          'content-type': 'application/json; charset=utf-8',
          'content-length': Buffer.byteLength(body),
          'cache-control': 'no-store',
        });
        res.end(body);
      };
      if (req.method !== 'POST') return sendJson(405, { ok: false, error: 'POST only' });
      if (req.headers[REFRESH_HEADER] !== '1') return sendJson(403, { ok: false, error: 'missing header' });
      if (refreshing) return sendJson(429, { ok: false, error: 'a refresh is already running' });

      refreshing = true;
      try {
        const result = await run('refresh.mjs', [], env);
        if (!result.ok) return sendJson(500, { ok: false, error: result.error.trim().slice(-1500) });
        sendJson(200, { ok: true, output: result.stdout.trim() });
      } finally {
        refreshing = false;
      }
    },
  }), 'dsh-memory-tree: refresh route');

  // 首次启动：库还不存在就后台跑一次完整刷新
  ctx.effect(() => {
    let alive = true;
    (async () => {
      if (fs.existsSync(dbFile)) return;
      const result = await run('refresh.mjs', [], env);
      if (alive && !result.ok) console.warn('[dsh-memory-tree] first refresh failed: %s', result.error);
    })();
    return () => { alive = false; };
  }, 'dsh-memory-tree: first run');

  if (minutes > 0) {
    ctx.effect(() => {
      const timer = setInterval(() => {
        run('refresh.mjs', [], env).then((result) => {
          if (!result.ok) console.warn('[dsh-memory-tree] refresh failed: %s', result.error);
        });
      }, minutes * 60_000);
      return () => clearInterval(timer);
    }, 'dsh-memory-tree: refresh timer');
  }
}
