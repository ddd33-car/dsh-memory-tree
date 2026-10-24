// 索引层：把「词」映射到「哪一天」。
//
// 为什么不是「词 → 每一条消息」：库里七千多条事件，逐条建倒排会膨胀几十倍，
// 而检索真正需要先回答的是「这事发生在哪几天」。所以索引停在「天」这一层，
// 选日子之后再在那一天几百条事件里 LIKE —— 代价极小，且永远不会漏词。
//
// 中文按二元切（没有分词器也能召回），英文按词切。

import { dayOf } from './store.mjs';

// 高频虚词，留着只会让每天的索引都长一样
const STOP = new Set(
  (
    '就是 然后 但是 因为 所以 可以 这个 那个 现在 已经 一个 什么 没有 不是 我们 你们 他们 ' +
    '自己 还是 这样 知道 觉得 应该 可能 真的 有点 一下 这里 那里 时候 东西 事情 问题 然后 ' +
    '如果 虽然 而且 或者 之后 之前 这些 那些 怎么 为什么 什么样 是不是 有没有 对不对 ' +
    '好的 嗯嗯 哈哈 谢谢 不用 需要 时候 一直 一起 出来 进去 过来 回去 下来 上去 不过 只是'
  ).split(/\s+/),
);

const CJK = /[\u4e00-\u9fff]/;

// 虚词单字：任何包含它们的二元组都不进索引。
// 二元切词最容易在「的/了/是」这些字上切出跨词垃圾（如「的组」「件还」）。
const PARTICLES = new Set('的了是在和就也都还不要有个这那我你他们能会吧呢啊吗着过把被给对从到'.split(''));

/** 抽词：中文二元组 + 英文单词。 */
export function termsOf(text) {
  if (!text) return [];
  const t = text.toLowerCase();
  const out = new Set();

  for (const m of t.matchAll(/[a-z][a-z0-9_.#+-]{1,}/g)) out.add(m[0]);

  for (const run of t.match(/[\u4e00-\u9fff]+/g) ?? []) {
    // 单字不进索引：量太大，且几乎都是「的/了/在」这类噪声
    if (run.length < 2) continue;
    for (let i = 0; i + 1 < run.length; i++) {
      const g = run.slice(i, i + 2);
      if (STOP.has(g)) continue;
      if (PARTICLES.has(g[0]) || PARTICLES.has(g[1])) continue;
      out.add(g);
    }
  }
  return [...out];
}

/** 查询串切词：跟索引同一套规则，保证对得上。 */
export function queryTerms(q) {
  const raw = termsOf(q);
  // 两字查询只取整词，别拆成单字；三字以上自然是二元组
  return raw.length ? raw : [q.toLowerCase()];
}

/** 重建某几天的索引。 */
export function rebuildTermDays(db, dates) {
  if (!dates.length) return 0;
  const del = db.prepare('DELETE FROM term_days WHERE date = ?');
  const ins = db.prepare('INSERT OR REPLACE INTO term_days (term, date, n) VALUES (?, ?, ?)');
  const pick = db.prepare(
    `SELECT kind, text FROM events
     WHERE ts >= ? AND ts < ? AND injected = 0 AND kind IN ('user','assistant')`,
  );

  let rows = 0;
  db.exec('BEGIN');
  try {
    for (const d of dates) {
      const s = Date.parse(d + 'T00:00:00+08:00');
      del.run(d);
      const counts = new Map();
      for (const ev of pick.all(s, s + 86400000)) {
        // 助手长回复只取前 400 字，避免一条顶别人十条
        const text = ev.kind === 'assistant' ? ev.text.slice(0, 400) : ev.text;
        for (const term of termsOf(text)) counts.set(term, (counts.get(term) ?? 0) + 1);
      }
      for (const [term, n] of counts) {
        ins.run(term, d, n);
        rows += 1;
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return rows;
}

/**
 * 按查询给「天」打分。
 * 命中词越多分越高，同时偏好被多个词共同命中的日子。
 */
export function scoreDays(db, terms, limit = 12) {
  if (!terms.length) return [];
  const ph = terms.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT date, COUNT(*) AS hit_terms, SUM(n) AS weight
       FROM term_days WHERE term IN (${ph})
       GROUP BY date ORDER BY hit_terms DESC, weight DESC LIMIT ?`,
    )
    .all(...terms, limit);
  return rows;
}

/**
 * 共现词：跟某个词经常出现在同一天的那些词。
 * 只在字面检索落空时用来「换个说法再试」，不参与正常排序——否则精度会被稀释。
 */
export function relatedTerms(db, term, limit = 6) {
  const dates = db.prepare('SELECT date FROM term_days WHERE term = ?').all(term).map((r) => r.date);
  if (!dates.length) return [];

  const totalDays = db.prepare('SELECT COUNT(DISTINCT date) n FROM term_days').get().n || 1;
  const ph = dates.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT term, COUNT(*) d, SUM(n) w FROM term_days
       WHERE date IN (${ph}) AND term <> ?
       GROUP BY term ORDER BY d DESC, w DESC LIMIT ?`,
    )
    .all(...dates, term, limit * 5);

  // 几乎每天都出现的词（文件、dsh）说明不了任何事，剔掉
  return rows
    .filter((r) => r.d / totalDays < 0.6 && !STOP.has(r.term) && r.term.length > 1)
    .slice(0, limit)
    .map((r) => r.term);
}

/** 一天里最突出的词（用来做卡片的一句话摘要）。 */export function topTermsOfDay(db, date, limit = 8) {
  const rows = db
    .prepare('SELECT term, n FROM term_days WHERE date = ? ORDER BY n DESC LIMIT ?')
    .all(date, limit * 3);
  // 二元组之间常有重叠（手柄/柄最），粗略去重
  const picked = [];
  for (const r of rows) {
    if (picked.some((p) => p.includes(r.term) || r.term.includes(p))) continue;
    picked.push(r.term);
    if (picked.length >= limit) break;
  }
  return picked;
}

export { dayOf, CJK };
