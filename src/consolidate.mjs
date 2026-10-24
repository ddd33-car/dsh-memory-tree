// 巩固与遗忘：给每天算「显著度」，按遗忘曲线决定哪些留原文、哪些只剩摘要。
//
//   node consolidate.mjs            只看结果，不动数据（默认）
//   node consolidate.mjs --apply    真的执行压缩
//   node consolidate.mjs --rebuild  重算所有天的显著度，再按规则处理
//
// 压缩不是删除：原文搬进 events_cold，卡片和墓碑都留着。
// 只有「淡忘」且超过保留期的，才会真正从冷存里清掉。

import fs from 'node:fs';
import path from 'node:path';

import { openDb, dayOf, dayStartMs, fmtTime } from './lib/store.mjs';
import { featuresForDay, salienceOf, tierOf, retentionOf, DEFAULT_CFG, TIERS } from './lib/salience.mjs';
import { DECAY_PATH } from './lib/paths.mjs';

const CFG_PATH = DECAY_PATH;

function loadCfg() {
  try {
    const j = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
    return {
      ...DEFAULT_CFG,
      ...j,
      halfLifeDays: { ...DEFAULT_CFG.halfLifeDays, ...(j.halfLifeDays ?? {}) },
      retentionDays: { ...DEFAULT_CFG.retentionDays, ...(j.retentionDays ?? {}) },
    };
  } catch {
    return DEFAULT_CFG;
  }
}

const apply = process.argv.includes('--apply');
const rebuild = process.argv.includes('--rebuild');
const cfg = loadCfg();

const db = openDb();
const today = dayOf(Date.now());

const upsertScore = db.prepare(`
  INSERT INTO day_scores (date, salience, tier, features, touches, computed_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(date) DO UPDATE SET
    salience = excluded.salience, tier = excluded.tier,
    features = excluded.features, computed_at = excluded.computed_at
`);

// ── 1. 算显著度 ────────────────────────────────────────────────────────
const days = db.prepare('SELECT date FROM days WHERE n_events > 0 ORDER BY date DESC').all();
const touched = [];

for (const { date } of days) {
  const prev = db.prepare('SELECT touches, pinned FROM day_scores WHERE date = ?').get(date);
  if (prev && !rebuild) continue; // 算过一次就不重算，除非 --rebuild
  const f = featuresForDay(db, date);
  const touches = prev?.touches ?? 0;
  touched.push({ date, sal: salienceOf(f, touches), f, touches, pinned: prev?.pinned ?? 0 });
}

// 等级用分位数切，不用写死的绝对值——否则数据一多，所有日子都会「深刻」。
// 海马体也是相对编码的：不是绝对重要，而是比别的更重要。
let deepCut;
let normalCut;
if ((cfg.thresholdMode ?? 'percentile') === 'fixed') {
  deepCut = cfg.deepThreshold;
  normalCut = cfg.normalThreshold;
} else {
  const pool = db.prepare('SELECT salience FROM day_scores').all().map((r) => r.salience);
  const all = [...pool, ...touched.map((t) => t.sal)].sort((a, b) => b - a);
  const at = (p) => all[Math.min(all.length - 1, Math.floor(all.length * p))] ?? 0;
  deepCut = at(cfg.deepPct ?? 0.2);
  normalCut = at((cfg.deepPct ?? 0.2) + (cfg.normalPct ?? 0.45));
}

for (const t of touched) {
  // 我亲手钉住的，别让统计把它冲掉
  const tier = t.pinned ? 'deep' : t.sal >= deepCut ? 'deep' : t.sal >= normalCut ? 'normal' : 'faint';
  upsertScore.run(t.date, t.sal, tier, JSON.stringify(t.f), t.touches, Date.now());
}

// ── 2. 按遗忘曲线决定命运 ─────────────────────────────────────────────
const scores = db.prepare('SELECT * FROM day_scores ORDER BY date DESC').all();
const plan = [];

for (const s of scores) {
  const ageDays = Math.floor((Date.parse(today + 'T00:00:00+08:00') - Date.parse(s.date + 'T00:00:00+08:00')) / 86400000);
  const keep = retentionOf(s.salience, s.tier, ageDays, cfg);
  const limit = cfg.retentionDays[s.tier];
  const stillHasRaw = db.prepare('SELECT COUNT(*) n FROM events WHERE ts >= ? AND ts < ?').get(
    dayStartMs(s.date),
    dayStartMs(s.date) + 86400000,
  ).n;

  if (stillHasRaw > 0 && ageDays > limit) {
    plan.push({ ...s, ageDays, keep, action: 'compress', raw: stillHasRaw });
  } else if (s.tier === 'faint' && ageDays > limit * 3 && !stillHasRaw) {
    plan.push({ ...s, ageDays, keep, action: 'purge', raw: 0 });
  }
}

// ── 3. 执行 ───────────────────────────────────────────────────────────
const stats = { compressed: 0, purged: 0, eventsMoved: 0, eventsDropped: 0 };

if (apply) {
  const moveToCold = db.prepare(`
    INSERT INTO events_cold (session_id, seq, ts, kind, role, text, injected, moved_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const delEvents = db.prepare('DELETE FROM events WHERE ts >= ? AND ts < ?');
  const putTomb = db.prepare(`
    INSERT INTO tombstones (date, tier, kept, dropped, note, at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET kept = excluded.kept, dropped = excluded.dropped,
      note = excluded.note, at = excluded.at
  `);

  db.exec('BEGIN');
  try {
    for (const p of plan) {
      const s = dayStartMs(p.date);
      const e = s + 86400000;

      if (p.action === 'compress') {
        const rows = db.prepare('SELECT * FROM events WHERE ts >= ? AND ts < ?').all(s, e);
        for (const r of rows) moveToCold.run(r.session_id, r.seq, r.ts, r.kind, r.role, r.text, r.injected, Date.now());
        delEvents.run(s, e);
        putTomb.run(
          p.date,
          p.tier,
          db.prepare("SELECT COUNT(*) n FROM cards WHERE level='day' AND key=?").get(p.date).n,
          rows.length,
          `超过${TIERS[p.tier]}保留期 ${cfg.retentionDays[p.tier]} 天，原文转入冷存`,
          Date.now(),
        );
        stats.compressed += 1;
        stats.eventsMoved += rows.length;
      } else if (p.action === 'purge') {
        const n = db.prepare('DELETE FROM events_cold WHERE ts >= ? AND ts < ?').run(s, e).changes;
        putTomb.run(p.date, p.tier, 1, n, '冷存也过了期，只留摘要', Date.now());
        stats.purged += 1;
        stats.eventsDropped += n;
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    console.error('执行失败：', err.message);
    process.exit(1);
  }
}

// ── 4. 汇报 ───────────────────────────────────────────────────────────
const byTier = db.prepare('SELECT tier, COUNT(*) n FROM day_scores GROUP BY tier').all();
const tierStr = byTier.map((r) => `${TIERS[r.tier] ?? r.tier}:${r.n}`).join('  ');

console.log(`\n显著度（${touched.length} 天${rebuild ? '，全量重算' : '，增量'}）　${tierStr}`);
console.log(`今天 ${today}　模式 ${apply ? '执行' : '预演（加 --apply 才动数据）'}\n`);

const shown = scores.slice(0, 12);
for (const s of shown) {
  const age = Math.floor((Date.parse(today + 'T00:00:00+08:00') - Date.parse(s.date + 'T00:00:00+08:00')) / 86400000);
  const keep = retentionOf(s.salience, s.tier, age, cfg);
  const bar = '█'.repeat(Math.max(1, Math.round(keep * 10)));
  console.log(
    `  ${s.date}  ${TIERS[s.tier] ?? s.tier}  ${s.salience.toFixed(2)}  保留 ${bar.padEnd(10)} ${(keep * 100).toFixed(0).padStart(3)}%  ` +
      `${String(age).padStart(3)}天前  想起${s.touches}次`,
  );
}

if (plan.length) {
  console.log(`\n将处理 ${plan.length} 天：`);
  for (const p of plan.slice(0, 10)) {
    console.log(`  ${p.date}  ${p.action === 'compress' ? '压缩' : '清冷存'}（${TIERS[p.tier]}，${p.ageDays} 天前，${p.raw} 条原文）`);
  }
  if (plan.length > 10) console.log(`  …另有 ${plan.length - 10} 天`);
  if (apply) {
    console.log(`\n已压缩 ${stats.compressed} 天（${stats.eventsMoved} 条转入冷存），清掉 ${stats.purged} 天冷存（${stats.eventsDropped} 条）`);
  }
} else {
  console.log('\n没有需要处理的（都在保留期内）。');
}
console.log('');

db.close();
