// 全量重建索引层（词→天）和卡片层（日/周/月）。
// 改了切词规则、卡片格式，或者怀疑哪层对不上时跑这个。

import { openDb } from './lib/store.mjs';
import { rebuildTermDays } from './lib/terms.mjs';
import { rebuildCards } from './lib/cards.mjs';

const db = openDb();
const t0 = Date.now();

const dates = db
  .prepare('SELECT date FROM days WHERE n_events > 0 ORDER BY date')
  .all()
  .map((r) => r.date);

console.log(`重建 ${dates.length} 天：${dates[0] ?? '—'} ~ ${dates[dates.length - 1] ?? '—'}`);

const rows = rebuildTermDays(db, dates);
const c = rebuildCards(db, dates);

const t = db.prepare('SELECT COUNT(*) n FROM term_days').get().n;
const cards = db.prepare('SELECT level, COUNT(*) n FROM cards GROUP BY level').all();
db.close();

console.log(`索引 ${rows} 条（库内 ${t} 条）  卡片 日${c.days} 周${c.weeks} 月${c.months}`);
console.log(`卡片分布：${cards.map((x) => `${x.level}:${x.n}`).join('  ')}  用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
