// 采集器：扫 DSH 会话文件 → 解压 → 抽事件 → 入库（去重、增量）。
//
// 用法：
//   node collect.mjs           增量采集
//   node collect.mjs --full    忽略水位，全部重扫
//   node collect.mjs --quiet   只输出一行汇总（给定时任务用）

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { decodeSessionFile, recordsToEvents } from './lib/decode.mjs';
import { openDb, dayOf } from './lib/store.mjs';
import { rebuildTermDays } from './lib/terms.mjs';
import { rebuildCards } from './lib/cards.mjs';
import { SESSIONS_ROOT, SOURCES_PATH } from './lib/paths.mjs';

/** 读排除规则；改 sources.json 立即生效，不用改代码。 */
export function loadExcludes() {
  try {
    const j = JSON.parse(fs.readFileSync(SOURCES_PATH, 'utf8'));
    return (j.exclude?.patterns ?? []).filter(Boolean);
  } catch {
    return [];
  }
}

function isExcluded(patterns, ...fields) {
  if (!patterns.length) return false;
  const hay = fields.filter(Boolean).join(' ').toLowerCase();
  return patterns.some((p) => hay.includes(String(p).toLowerCase()));
}

export function listSessionFiles(root = SESSIONS_ROOT) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.zstd') || e.name.endsWith('.jsonl')) out.push(p);
    }
  };
  walk(root);
  return out;
}

export function collect({ full = false, quiet = false, root = SESSIONS_ROOT } = {}) {
  const db = openDb();
  const now = Date.now();

  const selFile = db.prepare('SELECT size, mtime FROM files WHERE path = ?');
  const upsertFile = db.prepare(`
    INSERT INTO files (path, size, mtime, records, events, ingested_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      size = excluded.size, mtime = excluded.mtime,
      records = excluded.records, events = excluded.events,
      ingested_at = excluded.ingested_at
  `);
  const upsertSession = db.prepare(`
    INSERT INTO sessions (id, workspace, cwd, preset, created_at, title, last_ts)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      cwd = COALESCE(excluded.cwd, sessions.cwd),
      preset = COALESCE(excluded.preset, sessions.preset),
      title = COALESCE(excluded.title, sessions.title),
      last_ts = MAX(COALESCE(sessions.last_ts, 0), COALESCE(excluded.last_ts, 0))
  `);
  const insEvent = db.prepare(`
    INSERT OR IGNORE INTO events (session_id, seq, ts, kind, role, text, injected)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const files = listSessionFiles(root);
  const excludes = loadExcludes();
  let scanned = 0;
  let skipped = 0;
  let excluded = 0;
  let newEvents = 0;
  let newRecords = 0;
  const touchedDays = new Set();

  for (const file of files) {
    const sessionDir = path.basename(path.dirname(file));
    const workspace = path.basename(path.dirname(path.dirname(file)));
    if (isExcluded(excludes, workspace)) {
      excluded += 1;
      continue;
    }

    const st = fs.statSync(file);
    const prev = selFile.get(file);
    if (!full && prev && prev.size === st.size && prev.mtime === Math.floor(st.mtimeMs)) {
      skipped += 1;
      continue;
    }

    let records;
    try {
      records = decodeSessionFile(file);
    } catch (err) {
      process.stderr.write(`  [skip] ${path.basename(file)}: ${err.message}\n`);
      continue;
    }
    scanned += 1;

    const { session, title, events } = recordsToEvents(records);
    const sessionId = session?.id ?? sessionDir;
    // 目录名可能看不出归属（比如临时目录），再用会话里的 cwd 判一次
    if (isExcluded(excludes, session?.cwd)) {
      excluded += 1;
      continue;
    }

    let ins = 0;
    db.exec('BEGIN');
    try {
      upsertSession.run(
        sessionId,
        workspace,
        session?.cwd ?? null,
        session?.preset ?? null,
        session?.createdAt ?? null,
        title ?? null,
        events.length ? events[events.length - 1].ts : null,
      );
      for (const ev of events) {
        if (!ev.ts) continue;
        const r = insEvent.run(sessionId, ev.seq, ev.ts, ev.kind, ev.role, ev.text, ev.injected);
        if (r.changes > 0) {
          ins += 1;
          touchedDays.add(dayOf(ev.ts));
        }
      }
      upsertFile.run(file, st.size, Math.floor(st.mtimeMs), records.length, ins, now);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      process.stderr.write(`  [fail] ${path.basename(file)}: ${err.message}\n`);
      continue;
    }
    if (!quiet && ins > 0) {
      process.stdout.write(`  + ${String(ins).padStart(5)}  ${workspace}/${sessionId.slice(0, 24)}\n`);
    }
    newEvents += ins;
    newRecords += records.length;
  }

  // 清掉库里已经存在的、现在被排除的会话（改了 sources.json 之后自动生效）
  let pruned = 0;
  if (excludes.length) {
    const conds = excludes.map(() => '(LOWER(workspace) LIKE ? OR LOWER(COALESCE(cwd,\'\')) LIKE ?)').join(' OR ');
    const params = excludes.flatMap((p) => [`%${p.toLowerCase()}%`, `%${p.toLowerCase()}%`]);
    const victims = db.prepare(`SELECT id FROM sessions WHERE ${conds}`).all(...params);
    if (victims.length) {
      const del = db.prepare('DELETE FROM events WHERE session_id = ?');
      const delS = db.prepare('DELETE FROM sessions WHERE id = ?');
      const daysAffected = db
        .prepare(`SELECT DISTINCT ts FROM events WHERE session_id IN (${victims.map(() => '?').join(',')})`)
        .all(...victims.map((v) => v.id));
      db.exec('BEGIN');
      try {
        for (const v of victims) {
          pruned += del.run(v.id).changes;
          delS.run(v.id);
        }
        db.exec('COMMIT');
      } catch {
        db.exec('ROLLBACK');
      }
      for (const r of daysAffected) touchedDays.add(dayOf(r.ts));
    }
    // 水位行一起删掉，否则以后取消排除时这些文件会因「大小没变」被跳过，永远补不回来
    const delF = db.prepare('DELETE FROM files WHERE LOWER(path) LIKE ?');
    for (const p of excludes) delF.run(`%${p.toLowerCase()}%`);
  }

  // 重算受影响日期的物化统计
  const rebuildDay = db.prepare(`
    INSERT INTO days (date, first_ts, last_ts, n_events, n_sessions, built_at)
    SELECT ?, MIN(ts), MAX(ts), COUNT(*), COUNT(DISTINCT session_id), ?
    FROM events WHERE ts >= ? AND ts < ?
    ON CONFLICT(date) DO UPDATE SET
      first_ts = excluded.first_ts, last_ts = excluded.last_ts,
      n_events = excluded.n_events, n_sessions = excluded.n_sessions,
      built_at = excluded.built_at
  `);
  for (const d of touchedDays) {
    const s = Date.parse(d + 'T00:00:00+08:00');
    rebuildDay.run(d, now, s, s + 86400000);
  }

  // 索引层与卡片层只跟着变动的日子走，没新东西的日子不重算
  let indexed = 0;
  let carded = { days: 0, weeks: 0, months: 0 };
  if (touchedDays.size) {
    const dates = [...touchedDays].sort();
    indexed = rebuildTermDays(db, dates);
    carded = rebuildCards(db, dates);
  }

  const total = db.prepare('SELECT COUNT(*) AS n FROM events').get().n;
  const span = db.prepare('SELECT MIN(ts) AS a, MAX(ts) AS b FROM events').get();
  db.close();

  return {
    files: files.length,
    scanned,
    skipped,
    excluded,
    pruned,
    newEvents,
    newRecords,
    indexed,
    carded,
    total,
    first: span.a,
    last: span.b,
  };
}

// CLI
if (process.argv[1] && process.argv[1].endsWith('collect.mjs')) {
  const full = process.argv.includes('--full');
  const quiet = process.argv.includes('--quiet');
  const t0 = Date.now();
  const r = collect({ full, quiet });
  const { fmtTime } = await import('./lib/store.mjs');
  const line =
    `文件 ${r.files}（扫描 ${r.scanned}／跳过 ${r.skipped}／排除 ${r.excluded}）` +
    ` 新增 ${r.newEvents} 条` +
    (r.pruned ? ` 清除 ${r.pruned} 条` : '') +
    `  库内共 ${r.total} 条` +
    (r.first ? `  覆盖 ${fmtTime(r.first)} ~ ${fmtTime(r.last)}` : '') +
    `  用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`;
  process.stdout.write((quiet ? '' : '\n') + line + '\n');
}
