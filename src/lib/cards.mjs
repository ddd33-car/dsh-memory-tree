// 卡片层：日 / 周 / 月三种概览，机械生成，不调用模型。
//
// 这一层的职责是「让人一眼看懂那段时间」，不是「替代原文」。
// 所以每张卡都留了关键词和原始发言，往下还能钻到事件。

import { dayOf, fmtClock, dayStartMs } from './store.mjs';
import { topTermsOfDay } from './terms.mjs';

const cut = (s, n) => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : t.slice(0, n) + '…';
};

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const weekdayOf = (d) => WEEKDAYS[new Date(d + 'T00:00:00+08:00').getDay()];

/** 该日期所在周的周一（用周一的日期当周 key，避免 ISO 周号的边界歧义）。 */
export function weekStartOf(date) {
  const t = new Date(date + 'T00:00:00+08:00');
  const dow = (t.getDay() + 6) % 7; // 周一=0
  t.setDate(t.getDate() - dow);
  return dayOf(t.getTime());
}

function daysBetween(a, b) {
  const out = [];
  let t = Date.parse(a + 'T00:00:00+08:00');
  const end = Date.parse(b + 'T00:00:00+08:00');
  while (t <= end) {
    out.push(dayOf(t));
    t += 86400000;
  }
  return out;
}

function dayRows(db, date) {
  const s = dayStartMs(date);
  return {
    events: db.prepare('SELECT COUNT(*) n FROM events WHERE ts >= ? AND ts < ?').get(s, s + 86400000).n,
    sessions: db
      .prepare(
        `SELECT e.session_id, COUNT(*) n, MIN(e.ts) a, MAX(e.ts) b, s.title, s.cwd
         FROM events e LEFT JOIN sessions s ON s.id = e.session_id
         WHERE e.ts >= ? AND e.ts < ? GROUP BY e.session_id ORDER BY n DESC`,
      )
      .all(s, s + 86400000),
    userLines: db
      .prepare(
        `SELECT ts, text FROM events
         WHERE ts >= ? AND ts < ? AND kind='user' AND injected=0 ORDER BY ts ASC`,
      )
      .all(s, s + 86400000),
  };
}

export function buildDayCard(db, date) {
  const { events, sessions, userLines } = dayRows(db, date);
  if (!events) return null;

  const lines = [`## ${date} ${weekdayOf(date)} · ${events} 条 / ${sessions.length} 会话`];

  const terms = topTermsOfDay(db, date, 6);
  if (terms.length) lines.push(`关键词：${terms.join('、')}`);

  const sess = sessions
    .slice(0, 4)
    .map((r) => {
      const name = r.title && !/^【|当前时间/.test(r.title) ? cut(r.title, 14) : cut(r.cwd?.split(/[\\/]/).pop() ?? '', 14);
      return `${name || r.session_id.slice(0, 8)}（${fmtClock(r.a)}–${fmtClock(r.b)}，${r.n} 条）`;
    })
    .join('、');
  lines.push(`会话：${sess}`);

  const said = userLines.slice(0, 8);
  if (said.length) {
    lines.push('你说了：');
    for (const u of said) lines.push(`- ${fmtClock(u.ts)} ${cut(u.text, 52)}`);
    if (userLines.length > said.length) lines.push(`- …另有 ${userLines.length - said.length} 条`);
  }

  return lines.join('\n');
}

export function buildWeekCard(db, weekStart) {
  const days = daysBetween(weekStart, dayOf(Date.parse(weekStart + 'T00:00:00+08:00') + 6 * 86400000));
  const rows = days.map((d) => ({ d, ...dayRows(db, d) })).filter((r) => r.events > 0);
  if (!rows.length) return null;

  const total = rows.reduce((a, r) => a + r.events, 0);
  const lines = [`## 周 ${rows[0].d} ~ ${rows[rows.length - 1].d} · ${total} 条 / ${rows.length} 天`];

  for (const r of rows) {
    const terms = topTermsOfDay(db, r.d, 3).join('、');
    const firstUser = r.userLines.find((u) => u.text.length > 6);
    const head = firstUser ? cut(firstUser.text, 34) : '';
    lines.push(`- ${r.d.slice(5)} ${weekdayOf(r.d)} ${String(r.events).padStart(4)} 条${terms ? ` ｜ ${terms}` : ''}${head ? ` ｜ ${head}` : ''}`);
  }
  return lines.join('\n');
}

export function buildMonthCard(db, month) {
  const rows = db
    .prepare(`SELECT date, n_events FROM days WHERE date LIKE ? ORDER BY date`)
    .all(`${month}-%`)
    .filter((r) => r.n_events > 0);
  if (!rows.length) return null;

  const total = rows.reduce((a, r) => a + r.n_events, 0);
  const lines = [`## ${month} · ${total} 条 / ${rows.length} 天`];
  for (const r of rows) {
    const terms = topTermsOfDay(db, r.date, 2).join('、');
    lines.push(`- ${r.date.slice(5)} ${String(r.n_events).padStart(4)} 条${terms ? ` ｜ ${terms}` : ''}`);
  }
  return lines.join('\n');
}

/** 重建这些日期涉及的日/周/月卡。 */
export function rebuildCards(db, dates) {
  const weeks = new Set();
  const months = new Set();
  const ins = db.prepare(
    `INSERT INTO cards (level, key, body, built_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(level, key) DO UPDATE SET body = excluded.body, built_at = excluded.built_at`,
  );

  db.exec('BEGIN');
  try {
    for (const d of dates) {
      const body = buildDayCard(db, d);
      if (body) ins.run('day', d, body, Date.now());
      else db.prepare("DELETE FROM cards WHERE level='day' AND key=?").run(d);
      weeks.add(weekStartOf(d));
      months.add(d.slice(0, 7));
    }
    for (const w of weeks) {
      const body = buildWeekCard(db, w);
      if (body) ins.run('week', w, body, Date.now());
      else db.prepare("DELETE FROM cards WHERE level='week' AND key=?").run(w);
    }
    for (const m of months) {
      const body = buildMonthCard(db, m);
      if (body) ins.run('month', m, body, Date.now());
      else db.prepare("DELETE FROM cards WHERE level='month' AND key=?").run(m);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  return { days: dates.length, weeks: weeks.size, months: months.size };
}
