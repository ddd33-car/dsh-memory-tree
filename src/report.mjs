// 生成「记忆之树」网页：把库里的数据烤成 JSON，注入 viewer.html 模板。
//
//   node report.mjs
//
// 结构：年 → 月 → 周 → 日。前端负责画根、动画、下钻。
//
// 页面里同时带两份数据：真实库和 12 个月的演示库（`demo.db` 存在才算），
// 前端用 `?demo=1` 切换，不需要第二张页面。

import fs from 'node:fs';
import path from 'node:path';

import { openDb, fmtTime, fmtClock, dayOf, dayStartMs } from './lib/store.mjs';
import { weekStartOf } from './lib/cards.mjs';
import { DATA_DIR, DB_PATH, REPORT_PATH, VIEWER_PATH } from './lib/paths.mjs';

const ARGS = process.argv.slice(2);
const argOf = (k, d) => (ARGS.indexOf(k) === -1 ? d : ARGS[ARGS.indexOf(k) + 1]);
const OUT = argOf('--out', REPORT_PATH);
const TPL = VIEWER_PATH;
const DB_FILE = argOf('--db', null);
const DEMO_FILE = path.join(DATA_DIR, 'demo.db');
const DEMO_CACHE = path.join(DATA_DIR, 'demo-tree.json');
const REBUILD_DEMO = ARGS.includes('--rebuild-demo');

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const dayName = (d) => WEEKDAYS[new Date(d + 'T00:00:00+08:00').getDay()];
const cut = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : t.slice(0, n) + '…';
};

/**
 * 把一份库烤成前端要的树。
 * @param {string | null} dbFile 库文件；null 表示默认库
 * @param {{light?: boolean}} opts light 时正文更短，用来控住页面体积
 */
function buildTree(dbFile, opts = {}) {
  const db = openDb(dbFile ?? undefined);
  const now = Date.now();

  const userLimit = opts.light ? 26 : 60;
  const aiLimit = opts.light ? 14 : 30;
  const userCut = opts.light ? 150 : 240;
  const aiCut = opts.light ? 120 : 200;

  const total = db.prepare('SELECT COUNT(*) n FROM events').get().n;
  const span = db.prepare('SELECT MIN(ts) a, MAX(ts) b FROM events').get();
  const lastIngest = db.prepare('SELECT MAX(ingested_at) t FROM files').get().t;
  const facts = db.prepare("SELECT id, value FROM facts WHERE status='active' ORDER BY id DESC LIMIT 5").all();
  const threads = db.prepare("SELECT id, title FROM threads WHERE status='open' ORDER BY id").all();
  const tiers = new Map(db.prepare('SELECT date, tier, salience, touches FROM day_scores').all().map((r) => [r.date, r]));
  const monthCards = new Map(db.prepare("SELECT key, body FROM cards WHERE level='month'").all().map((r) => [r.key, r.body]));
  const weekCards = new Map(db.prepare("SELECT key, body FROM cards WHERE level='week'").all().map((r) => [r.key, r.body]));

  const dayRows = db.prepare('SELECT date, n_events, n_sessions FROM days WHERE n_events > 0 ORDER BY date').all();

  const qUsers = db.prepare(
    `SELECT ts, text FROM events WHERE ts >= ? AND ts < ? AND kind='user' AND injected=0 ORDER BY ts ASC LIMIT ${userLimit}`,
  );
  const qAsst = db.prepare(
    `SELECT ts, text FROM events WHERE ts >= ? AND ts < ? AND kind='assistant' AND injected=0 ORDER BY ts ASC LIMIT ${aiLimit}`,
  );
  const qTerms = db.prepare('SELECT term FROM term_days WHERE date = ? ORDER BY n DESC LIMIT 6');
  const qSess = db.prepare(
    `SELECT e.session_id, COUNT(*) n, s.title, s.cwd
     FROM events e LEFT JOIN sessions s ON s.id = e.session_id
     WHERE e.ts >= ? AND e.ts < ? GROUP BY e.session_id ORDER BY n DESC LIMIT 5`,
  );

  // 年 → 月 → 周 → 日
  const months = new Map();
  for (const r of dayRows) {
    const mk = r.date.slice(0, 7);
    const wk = weekStartOf(r.date);
    const s = dayStartMs(r.date);
    const e = s + 86400000;

    const users = qUsers.all(s, e).map((x) => ({ t: fmtClock(x.ts), x: cut(x.text, userCut) }));
    const ai = qAsst.all(s, e).map((x) => ({ t: fmtClock(x.ts), x: cut(x.text, aiCut) }));
    const sess = qSess.all(s, e).map((x) => ({
      n: x.n,
      name: cut(x.title && !/^【|当前时间/.test(x.title) ? x.title : (x.cwd ?? '').split(/[\\/]/).pop() || '会话', 20),
    }));

    if (!months.has(mk)) months.set(mk, new Map());
    const wm = months.get(mk);
    if (!wm.has(wk)) wm.set(wk, []);
    wm.get(wk).push({
      key: r.date,
      day: Number(r.date.slice(8)),
      wd: dayName(r.date),
      events: r.n_events,
      sessions: r.n_sessions,
      tier: tiers.get(r.date)?.tier ?? 'normal',
      terms: qTerms.all(r.date).map((t) => t.term),
      users,
      ai,
      sess,
    });
  }

  const year = (dayRows[0]?.date ?? String(new Date().getFullYear())).slice(0, 4);
  const tree = {
    year,
    generatedAt: fmtTime(now),
    total,
    days: dayRows.length,
    lastIngest: lastIngest ? fmtTime(lastIngest) : null,
    first: span.a ? fmtTime(span.a).slice(0, 10) : null,
    last: span.b ? fmtTime(span.b).slice(0, 10) : null,
    today: dayOf(now),
    facts: facts.map((f) => ({ id: f.id, value: f.value })),
    threads: threads.map((t) => ({ id: t.id, title: t.title })),
    months: [...months.keys()].sort().map((mk) => {
      const wm = months.get(mk);
      const all = [...wm.values()].flat();
      return {
        key: mk,
        label: `${Number(mk.slice(5, 7))}月`,
        events: all.reduce((a, d) => a + d.events, 0),
        summary: monthCards.get(mk) ?? '',
        weeks: [...wm.keys()].sort().map((wk) => ({
          key: wk,
          label: `${wk.slice(5)}~${dayOf(Date.parse(wk + 'T00:00:00+08:00') + 6 * 86400000).slice(5)}`,
          events: wm.get(wk).reduce((a, d) => a + d.events, 0),
          summary: weekCards.get(wk) ?? '',
          days: wm.get(wk).sort((a, b) => a.key.localeCompare(b.key)),
        })),
      };
    }),
  };

  db.close();
  return tree;
}

const real = buildTree(DB_FILE);

// 演示数据是冻结的样本：第一次从 demo.db 烤出来存成 demo-tree.json，
// 之后每次刷新都读这份缓存，不再碰 demo.db——它长什么样就永远长什么样。
// 真要更新，跑 `node report.mjs --rebuild-demo`。
let demo = null;
if (DB_FILE === null) {
  try {
    if (fs.existsSync(DEMO_CACHE) && !REBUILD_DEMO) {
      demo = JSON.parse(fs.readFileSync(DEMO_CACHE, 'utf8'));
    } else if (fs.existsSync(DEMO_FILE)) {
      demo = buildTree(DEMO_FILE, { light: true });
      fs.writeFileSync(DEMO_CACHE, JSON.stringify(demo), 'utf8');
      console.log('演示数据已冻结到 ' + DEMO_CACHE);
    }
  } catch (error) {
    console.error('演示数据读取失败，跳过：' + error.message);
  }
}

const payload = JSON.stringify({ real, demo }).replace(/</g, '\\u003c');
const tpl = fs.readFileSync(TPL, 'utf8');
const html = tpl.replace('const DATA = window.__MEMORY__;', `const DATA = ${payload};`);

if (html === tpl) {
  console.error('模板里的占位符没找到，检查 viewer.html 是否被改过');
  process.exit(1);
}

fs.writeFileSync(OUT, html, 'utf8');
console.log(
  `已生成 ${OUT}（${(html.length / 1024).toFixed(0)} KB，` +
    `${real.months.length} 月根 / ${real.months.reduce((a, m) => a + m.weeks.length, 0)} 周根 / ${real.days} 日根` +
    `${demo ? `，另带演示库 ${demo.days} 天` : ''}）`,
);
