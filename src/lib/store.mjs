// 记忆库：一个 SQLite 文件，四张表。
//   events   —— 原始事件（只追加，不删）
//   sessions —— 会话元信息
//   days     —— 按天汇总的物化统计（P0 用，后面给日摘要用）
//   files    —— 采集水位（增量用）

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR, DB_PATH } from './paths.mjs';

export { DATA_DIR, DB_PATH };

export function openDb(file = DB_PATH) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL;');
  db.exec('PRAGMA synchronous=NORMAL;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id          TEXT PRIMARY KEY,
      workspace   TEXT,
      cwd         TEXT,
      preset      TEXT,
      created_at  INTEGER,
      title       TEXT,
      last_ts     INTEGER
    );

    CREATE TABLE IF NOT EXISTS events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  TEXT NOT NULL,
      seq         INTEGER NOT NULL,
      ts          INTEGER NOT NULL,
      kind        TEXT NOT NULL,
      role        TEXT,
      text        TEXT NOT NULL,
      injected    INTEGER NOT NULL DEFAULT 0,
      UNIQUE(session_id, seq, kind)
    );

    CREATE INDEX IF NOT EXISTS idx_events_ts     ON events(ts);
    CREATE INDEX IF NOT EXISTS idx_events_sess   ON events(session_id, seq);
    CREATE INDEX IF NOT EXISTS idx_events_kind   ON events(kind);

    CREATE TABLE IF NOT EXISTS files (
      path        TEXT PRIMARY KEY,
      size        INTEGER,
      mtime       INTEGER,
      records     INTEGER,
      events      INTEGER,
      ingested_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS days (
      date        TEXT PRIMARY KEY,
      first_ts    INTEGER,
      last_ts     INTEGER,
      n_events    INTEGER,
      n_sessions  INTEGER,
      built_at    INTEGER
    );

    -- 索引层：词 → 哪一天（检索先定位到天，再在那天里 LIKE）
    CREATE TABLE IF NOT EXISTS term_days (
      term        TEXT NOT NULL,
      date        TEXT NOT NULL,
      n           INTEGER NOT NULL,
      PRIMARY KEY (term, date)
    );
    CREATE INDEX IF NOT EXISTS idx_term_days_date ON term_days(date);

    -- 卡片层：日 / 周 / 月，三层同一张表
    CREATE TABLE IF NOT EXISTS cards (
      level       TEXT NOT NULL,
      key         TEXT NOT NULL,
      body        TEXT NOT NULL,
      built_at    INTEGER,
      PRIMARY KEY (level, key)
    );

    -- 未结线程：跨天的事，不靠摘要串
    CREATE TABLE IF NOT EXISTS threads (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      title       TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'open',
      note        TEXT,
      created_at  INTEGER,
      updated_at  INTEGER
    );

    -- 你亲口让我记住的事。只追加，改主意就关掉旧的那条
    CREATE TABLE IF NOT EXISTS facts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      subject     TEXT,
      value       TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'active',
      source      TEXT,
      created_at  INTEGER,
      updated_at  INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_facts_status ON facts(status);

    -- 每天一个「情景」的显著度，以及它被召回过的次数（间隔重复的复习次数）
    CREATE TABLE IF NOT EXISTS day_scores (
      date        TEXT PRIMARY KEY,
      salience    REAL NOT NULL,
      tier        TEXT NOT NULL,
      features    TEXT,
      touches     INTEGER NOT NULL DEFAULT 0,
      pinned      INTEGER NOT NULL DEFAULT 0,
      computed_at INTEGER
    );

    -- 冷存：原文从热表搬到这里，检索默认不查，但没丢
    CREATE TABLE IF NOT EXISTS events_cold (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  TEXT NOT NULL,
      seq         INTEGER NOT NULL,
      ts          INTEGER NOT NULL,
      kind        TEXT NOT NULL,
      role        TEXT,
      text        TEXT NOT NULL,
      injected    INTEGER NOT NULL DEFAULT 0,
      moved_at    INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_cold_ts ON events_cold(ts);

    -- 墓碑：哪天被压缩了、留了多少、删了多少。记忆可以模糊，但不能无声无息
    CREATE TABLE IF NOT EXISTS tombstones (
      date        TEXT PRIMARY KEY,
      tier        TEXT,
      kept        INTEGER,
      dropped     INTEGER,
      note        TEXT,
      at          INTEGER
    );

    -- 杂项状态：目前只存「上次刷新时间」，用来区分「没新东西」和「任务死了」
    CREATE TABLE IF NOT EXISTS meta (
      key         TEXT PRIMARY KEY,
      value       TEXT
    );
  `);
  // 老库补列（新库建表时已有，这里失败无所谓）
  try {
    db.exec('ALTER TABLE day_scores ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0');
  } catch {}
  return db;
}

// ── 时间：全部按 Asia/Shanghai（UTC+8）切日 ───────────────────────────
const TZ_OFFSET = 8 * 3600 * 1000;

export function dayOf(ts) {
  return new Date(ts + TZ_OFFSET).toISOString().slice(0, 10);
}

export function fmtTime(ts) {
  return new Date(ts + TZ_OFFSET).toISOString().slice(0, 16).replace('T', ' ');
}

export function fmtClock(ts) {
  return new Date(ts + TZ_OFFSET).toISOString().slice(11, 16);
}

export function dayStartMs(dateStr) {
  return Date.parse(dateStr + 'T00:00:00+08:00');
}
