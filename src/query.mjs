// 查询：从记忆库里把东西捞出来。
//
//   node query.mjs today                今天发生了什么
//   node query.mjs day 2026-10-20       某一天
//   node query.mjs search "手柄"         全文搜（默认近 30 天）
//   node query.mjs search "手柄" --days 0 --kind user,assistant
//   node query.mjs status               库的状态与覆盖
//   node query.mjs sessions --limit 10  最近的会话
//   node query.mjs digest              打印要写进 AGENTS.md 的速览块
//
// 通用参数：--limit N  --chars N  --all（含工具调用）  --injected（含系统注入块）

import fs from 'node:fs';

import { openDb, dayOf, fmtTime, fmtClock, dayStartMs, DB_PATH } from './lib/store.mjs';
import { buildDigest } from './lib/digest.mjs';
import { queryTerms, scoreDays, relatedTerms } from './lib/terms.mjs';
import { addFact, listFacts, closeFact, searchFacts } from './lib/facts.mjs';
import { featuresForDay, salienceOf } from './lib/salience.mjs';

const args = process.argv.slice(2);
const cmd = args[0] ?? 'status';

function flag(name, fallback = null) {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
}
function has(name) {
  return args.includes(name);
}

const LIMIT = Number(flag('--limit', 40));
const CHARS = Number(flag('--chars', 220));
const WITH_ALL = has('--all');
const WITH_INJECTED = has('--injected');

const norm = (s) => (s ?? '').replace(/\s+/g, ' ').trim();
const cut = (s, n = CHARS) => (s.length <= n ? s : s.slice(0, n) + '…');

function sessionLabel(db, id) {
  const s = db.prepare('SELECT title, cwd, workspace FROM sessions WHERE id = ?').get(id);
  if (!s) return id.slice(0, 20);
  const junkTitle = !s.title || /^【|当前时间/.test(s.title);
  if (!junkTitle) return cut(s.title, 26);
  const base = s.cwd ? s.cwd.split(/[\\/]/).filter(Boolean).pop() : '';
  const ws = (s.workspace ?? '').replace(/^--|--$/g, '').replace(/-/g, ' ');
  return `${base || ws || id.slice(0, 8)}`;
}

function showDay(db, date) {
  const start = dayStartMs(date);
  const end = start + 86400000;
  const rows = db
    .prepare(
      `SELECT session_id, seq, ts, kind, text, injected FROM events
       WHERE ts >= ? AND ts < ?
       ORDER BY ts ASC`,
    )
    .all(start, end);

  const tomb = db.prepare('SELECT * FROM tombstones WHERE date = ?').get(date);
  const card = db.prepare("SELECT body FROM cards WHERE level='day' AND key=?").get(date);

  if (!rows.length) {
    if (card) {
      console.log(`\n（${date} 的原文已压缩${tomb ? `：${tomb.note}` : ''}，只剩摘要）`);
      console.log('\n' + card.body + '\n');
      return;
    }
    console.log(`${date}：库里没有记录。`);
    return;
  }

  const bySession = new Map();
  for (const r of rows) {
    if (!bySession.has(r.session_id)) bySession.set(r.session_id, []);
    bySession.get(r.session_id).push(r);
  }

  console.log(
    `\n== ${date}  ${fmtClock(rows[0].ts)}–${fmtClock(rows[rows.length - 1].ts)}  ` +
      `${rows.length} 条 / ${bySession.size} 个会话\n`,
  );

  const ordered = [...bySession.entries()].sort((a, b) => a[1][0].ts - b[1][0].ts);
  for (const [sid, evs] of ordered) {
    console.log(`-- ${sessionLabel(db, sid)}  (${evs.length} 条)`);
    let shown = 0;
    for (const e of evs) {
      if (!WITH_ALL && e.kind === 'tool_call') continue;
      if (!WITH_INJECTED && e.injected) continue;
      if (shown >= LIMIT) {
        console.log('   …（已省略，用 --limit 调整）');
        break;
      }
      const mark = e.kind === 'user' ? '你' : e.kind === 'assistant' ? '我' : e.kind === 'goal' ? '目标' : '摘要';
      const tag = e.injected ? '〔注入〕' : '';
      console.log(`   ${fmtClock(e.ts)} ${mark}${tag} ${cut(norm(e.text))}`);
      shown += 1;
    }
    console.log('');
  }
}

function showSearch(db, q) {
  const days = Number(flag('--days', 30));
  const kinds = flag('--kind', null);
  const since = days > 0 ? Date.now() - days * 86400000 : 0;

  let sql = `SELECT session_id, seq, ts, kind, text FROM events
             WHERE text LIKE ? AND ts >= ?`;
  const params = [`%${q}%`, since];
  if (!WITH_INJECTED) sql += ' AND injected = 0';
  if (kinds) {
    const list = kinds.split(',').map((k) => k.trim()).filter(Boolean);
    sql += ` AND kind IN (${list.map(() => '?').join(',')})`;
    params.push(...list);
  }
  sql += ' ORDER BY ts DESC LIMIT ?';
  params.push(LIMIT * 4);

  const rows = db.prepare(sql).all(...params);

  // 冷存里的原文默认不参与检索；明确加 --cold 才去翻
  let coldRows = [];
  if (has('--cold')) {
    let csql = `SELECT session_id, seq, ts, kind, text FROM events_cold WHERE text LIKE ? AND ts >= ?`;
    const cparams = [`%${q}%`, since];
    if (kinds) {
      const list = kinds.split(',').map((k) => k.trim()).filter(Boolean);
      csql += ` AND kind IN (${list.map(() => '?').join(',')})`;
      cparams.push(...list);
    }
    csql += ' ORDER BY ts DESC LIMIT ?';
    cparams.push(LIMIT * 2);
    coldRows = db.prepare(csql).all(...cparams).map((r) => ({ ...r, cold: true }));
  }

  const merged = [...rows, ...coldRows].sort((a, b) => b.ts - a.ts);

  // 同一段内容被反复注入/复读时只留一条
  const seen = new Set();
  const uniq = [];
  for (const r of merged) {
    const key = norm(r.text).slice(0, 120);
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(r);
    if (uniq.length >= LIMIT) break;
  }

  const scope = days > 0 ? `近 ${days} 天` : '全部时间';
  if (!uniq.length) {
    console.log(`没搜到「${q}」（${scope}）。可以放宽 --days 0 试全部。`);
    return;
  }
  console.log(`\n「${q}」${scope}命中 ${uniq.length} 条（最新在前）\n`);
  for (const r of uniq) {
    console.log(`${fmtTime(r.ts)}  ${r.kind.padEnd(9)}${r.cold ? '（冷存）' : ''} ${sessionLabel(db, r.session_id)}`);
    console.log(`   ${cut(norm(r.text), 300)}`);
  }
}

function showStatus(db) {
  const tot = db.prepare('SELECT COUNT(*) n FROM events').get().n;
  const span = db.prepare('SELECT MIN(ts) a, MAX(ts) b FROM events').get();
  const sess = db.prepare('SELECT COUNT(*) n FROM sessions').get().n;
  const kinds = db.prepare('SELECT kind, COUNT(*) n FROM events GROUP BY kind ORDER BY n DESC').all();
  const files = db.prepare('SELECT COUNT(*) n, MAX(ingested_at) t FROM files').get();
  const size = fs.existsSync(DB_PATH) ? fs.statSync(DB_PATH).size : 0;

  console.log('\n== 记忆库状态');
  console.log(`  事件 ${tot}   会话 ${sess}   文件 ${files.n}`);
  if (span.a) console.log(`  覆盖 ${fmtTime(span.a)} ~ ${fmtTime(span.b)}`);
  console.log(`  最后采集 ${files.t ? fmtTime(files.t) : '从未'}`);
  console.log(`  体积 ${(size / 1024 / 1024).toFixed(1)} MB`);
  console.log(`  构成 ${kinds.map((k) => `${k.kind}:${k.n}`).join('  ')}`);

  const today = dayOf(Date.now());
  const t = db.prepare('SELECT * FROM days WHERE date = ?').get(today);
  console.log(`  今天 ${t ? `${t.n_events} 条 / ${t.n_sessions} 会话` : '暂无'}`);

  const days = db.prepare('SELECT date, n_events, n_sessions FROM days ORDER BY date DESC LIMIT 10').all();
  if (days.length) {
    console.log('\n  最近十天：');
    for (const d of days) console.log(`    ${d.date}  ${String(d.n_events).padStart(5)} 条  ${d.n_sessions} 会话`);
  }
  console.log('');
}

function showSessions(db) {
  const rows = db
    .prepare('SELECT id, title, workspace, last_ts FROM sessions WHERE last_ts IS NOT NULL ORDER BY last_ts DESC LIMIT ?')
    .all(LIMIT);
  console.log('');
  for (const r of rows) {
    const ws = (r.workspace ?? '').replace(/^--|--$/g, '').replace(/-/g, ' ');
    console.log(`${fmtTime(r.last_ts)}  ${cut(r.title ?? r.id, 40).padEnd(42)} @${cut(ws, 24)}`);
  }
  console.log('');
}

// ── 下钻检索：词 → 天 → 片段 ──────────────────────────────────────────
function showFind(db, q) {
  let terms = queryTerms(q);
  let days = scoreDays(db, terms, Number(flag('--days-max', 4)));
  let expanded = false;

  console.log(`\n「${q}」→ 切词 ${terms.slice(0, 8).join(' / ')}${terms.length > 8 ? ' …' : ''}`);
  console.log('事实：', searchFacts(db, q).map((f) => `#${f.id} ${f.value}`).join('；') || '（没有）');

  if (!days.length) {
    // 字面落空：用共现词换个说法再试一次
    const rel = [...new Set(terms.flatMap((t) => relatedTerms(db, t, 4)))];
    if (rel.length) {
      terms = rel;
      days = scoreDays(db, terms, Number(flag('--days-max', 4)));
      expanded = true;
      console.log(`字面没命中，改用相关词：${rel.join(' / ')}`);
    }
  }

  if (!days.length) {
    console.log('仍然没有命中。可以试 query.mjs search 直接全文搜，或者换个说法。\n');
    return;
  }

  console.log(`候选天：${days.map((d) => `${d.date}(${d.hit_terms}词/${d.weight}次)`).join('  ')}`);

  // 被想起一次，就算复习了一次：显著度会因此更抗遗忘
  const bump = db.prepare('UPDATE day_scores SET touches = touches + 1 WHERE date = ?');
  for (const d of days) bump.run(d.date);

  const mc = db.prepare("SELECT body FROM cards WHERE level='month' AND key=?").get(days[0].date.slice(0, 7));
  if (mc) console.log(`\n${mc.body.split('\n')[0]}`);

  const top = db.prepare("SELECT body FROM cards WHERE level='day' AND key=?").get(days[0].date);
  if (top) console.log('\n' + top.body);

  if (expanded) {
    console.log('\n（相关词命中，没有字面证据，不再列片段）\n');
    return;
  }

  const ranges = days.map((d) => [dayStartMs(d.date), dayStartMs(d.date) + 86400000]);
  const cond = ranges.map(() => '(ts >= ? AND ts < ?)').join(' OR ');
  const rows = db
    .prepare(
      `SELECT ts, kind, text FROM events
       WHERE (${cond}) AND injected = 0 AND kind IN ('user','assistant') AND text LIKE ?
       ORDER BY ts ASC LIMIT ?`,
    )
    .all(...ranges.flat(), `%${q}%`, Number(flag('--limit', 10)));

  if (rows.length) {
    console.log(`\n── 原文片段（${rows.length} 条）`);
    for (const r of rows) {
      const mark = r.kind === 'user' ? '你' : '我';
      console.log(`${fmtTime(r.ts)} ${mark}  ${cut(norm(r.text), 150)}`);
    }
  } else {
    console.log('\n（候选天里没有字面命中，可能只是同义/相关）');
  }
  console.log('');
}

// ── 按需检索：给一句话，回一小段记忆（不相关就什么都不回）─────────────
// 门槛是启发式的：词得「有焦点」（只出现在少数几天）且不是寒暄词。
// 不追求全自动判断——查不查最终由我决定，这个命令只是让「查一下」很便宜。
const NOISE_TERMS = new Set([
  '今天', '现在', '什么', '怎么', '为什么', '可以', '不错', '好的', '谢谢', '哈哈',
  '这个', '那个', '然后', '还是', '就是', '一下', '这样', '那样', '有点', '真的',
  '天天', '个事', '事后', '后来', '事情', '东西', '时候', '一直', '一起', '感觉',
  '应该', '可能', '比较', '已经', '要不', '要不', '怎么', '多少', '几个', '一下',
]);

function showContext(db, msg) {
  // 结构化词汇：线程、事实、最近的会话标题。出现在这些地方的词一定是「正经话题」，
  // 不受下面「只出现在少数几天」的门槛限制。
  const entityText = [
    ...db.prepare('SELECT title FROM threads').all().map((r) => r.title),
    ...db.prepare('SELECT value FROM facts').all().map((r) => r.value),
    ...db.prepare('SELECT title FROM sessions WHERE title IS NOT NULL').all().map((r) => r.title),
  ]
    .join(' ')
    .toLowerCase();

  const scored = queryTerms(msg)
    .filter((t) => !NOISE_TERMS.has(t))
    .map((t) => {
      const r = db.prepare('SELECT COUNT(*) d, SUM(n) s FROM term_days WHERE term = ?').get(t);
      return { term: t, d: r.d ?? 0, s: r.s ?? 0, known: entityText.includes(t) };
    })
    // 有焦点的词（只在少数几天且反复出现），或者本身就在线程/事实/标题里
    .filter((x) => (x.d >= 1 && x.d <= 3 && x.s >= 3) || x.known)
    // 同一个词切出来的重叠二元组（记忆/忆系/系统），优先留更常用的那个
    .sort((a, b) => b.s - a.s);

  if (!scored.length) return; // 静默
  const terms = scored.slice(0, 3).map((x) => x.term);

  const days = scoreDays(db, terms, 3);
  const facts = [...new Set(terms.flatMap((t) => searchFacts(db, t, 2).map((f) => f.value)))];
  const GENERIC = new Set(['系统', '文件', '工具', '功能', '问题', '项目', '东西', '事情', '方法', '内容']);
  const threadTerms = terms.filter((t) => !GENERIC.has(t));
  const threads = db
    .prepare("SELECT title FROM threads WHERE status='open'")
    .all()
    .filter((t) => threadTerms.some((x) => t.title.includes(x)))
    .map((t) => t.title);

  const bits = [];
  if (days.length) bits.push(`提到过：${days.map((d) => `${d.date}(${d.weight}次)`).join('、')}`);
  if (facts.length) bits.push(`你交代过：${facts.slice(0, 2).join('；')}`);
  if (threads.length) bits.push(`还没结：${threads.slice(0, 2).join('；')}`);
  if (!bits.length) return;

  console.log(`[记忆] ${terms.slice(0, 3).join('/')} — ${bits.join('；')}`);
}

// ── 事实：写回与纠错 ──────────────────────────────────────────────────
function factCmd(db, sub) {
  if (sub === 'add' || sub === 'remember') {
    const value = args.slice(1).join(' ');
    if (!value) return console.log('用法：query.mjs remember "手柄最后买了北通盘古"');
    const id = addFact(db, value);
    console.log(`已记住 #${id}：${value}`);
    return;
  }
  if (sub === 'close' || sub === 'forget') {
    const id = Number(args[2]);
    if (!id) return console.log('用法：query.mjs forget <id>');
    console.log(closeFact(db, id) ? `已关闭 #${id}（不会删，只是不再算数）` : `#${id} 不存在或已关闭`);
    return;
  }
  const rows = listFacts(db, { status: 'active', limit: Number(flag('--limit', 30)) });
  if (!rows.length) return console.log('还没有记住任何事。');
  for (const r of rows) console.log(`#${r.id}  ${fmtTime(r.created_at).slice(5, 10)}  ${r.value}`);
}

function showCard(db, level, key) {
  const r = db.prepare('SELECT body, built_at FROM cards WHERE level = ? AND key = ?').get(level, key);
  if (!r) {
    console.log(`没有 ${level} ${key} 的卡片。可用：query.mjs cards 看现有列表。`);
    return;
  }
  console.log('\n' + r.body + '\n');
}

function showCards(db) {
  const rows = db.prepare('SELECT level, key FROM cards ORDER BY level, key DESC').all();
  for (const level of ['day', 'week', 'month']) {
    const ks = rows.filter((r) => r.level === level).map((r) => r.key);
    console.log(`${level.padEnd(5)} ${ks.length} 张：${ks.join('  ') || '—'}`);
  }
}

function threadCmd(db, sub) {
  const now = Date.now();
  if (sub === 'add') {
    const title = args[2];
    if (!title) return console.log('用法：query.mjs thread add "手柄还没定"');
    db.prepare('INSERT INTO threads (title, status, created_at, updated_at) VALUES (?, ?, ?, ?)').run(
      title,
      'open',
      now,
      now,
    );
    console.log(`已开线程：${title}`);
  } else if (sub === 'close') {
    const id = Number(args[2]);
    db.prepare("UPDATE threads SET status='closed', updated_at=? WHERE id=?").run(now, id);
    console.log(`已结线程 #${id}`);
  } else {
    const rows = db.prepare("SELECT id, title, created_at FROM threads WHERE status='open' ORDER BY id").all();
    if (!rows.length) console.log('没有未结线程。');
    else for (const r of rows) console.log(`#${r.id}  ${r.title}  （${fmtTime(r.created_at).slice(5, 10)} 开）`);
  }
}

function pinDay(db, date) {
  const row = db.prepare('SELECT date FROM day_scores WHERE date = ?').get(date);
  if (row) {
    db.prepare(
      "UPDATE day_scores SET tier='deep', pinned=1, salience=MAX(salience, 0.95), computed_at=? WHERE date=?",
    ).run(Date.now(), date);
  } else {
    const f = featuresForDay(db, date);
    db.prepare(
      'INSERT INTO day_scores (date, salience, tier, features, touches, pinned, computed_at) VALUES (?, ?, ?, ?, 0, 1, ?)',
    ).run(date, Math.max(salienceOf(f, 0), 0.95), 'deep', JSON.stringify(f), Date.now());
  }
  console.log(`${date} 标为「深刻」。这条压过统计，是我自己的判断，不会被重算或衰减掉。`);
}

function showTiers(db) {
  const rows = db
    .prepare("SELECT date, salience, tier, touches FROM day_scores ORDER BY date DESC LIMIT 40")
    .all();
  const NAME = { deep: '深刻', normal: '普通', faint: '淡忘' };
  for (const r of rows) {
    console.log(`${r.date}  ${(NAME[r.tier] ?? r.tier).padEnd(2)}  ${r.salience.toFixed(2)}  想起${r.touches}次`);
  }
}

const db = openDb();

switch (cmd) {
  case 'today':
    showDay(db, dayOf(Date.now()));
    break;

  case 'day':
    if (!args[1]) {
      console.log('用法：node query.mjs day 2026-10-20');
      break;
    }
    showDay(db, args[1]);
    break;

  case 'search':
    if (!args[1]) {
      console.log('用法：node query.mjs search "关键词" [--days 30]');
      break;
    }
    showSearch(db, args[1]);
    break;

  case 'status':
    showStatus(db);
    break;

  case 'sessions':
    showSessions(db);
    break;

  case 'digest':
    console.log(buildDigest(db));
    break;

  case 'find':
    if (!args[1]) {
      console.log('用法：node query.mjs find "手柄"');
      break;
    }
    showFind(db, args[1]);
    break;

  case 'card': {
    const a = args[1];
    const b = args[2];
    if (a === 'week' || a === 'month' || a === 'day') showCard(db, a, b);
    else if (a && /^\d{4}-\d{2}$/.test(a)) showCard(db, 'month', a);
    else if (a) showCard(db, 'day', a);
    else console.log('用法：query.mjs card 2026-10-20 | card week 2026-10-19 | card month 2026-10');
    break;
  }

  case 'cards':
    showCards(db);
    break;

  case 'thread':
    threadCmd(db, args[1] ?? 'list');
    break;

  case 'context':
    if (!args[1]) break;
    showContext(db, args.slice(1).join(' '));
    break;

  case 'remember':
    factCmd(db, 'add');
    break;

  case 'facts':
    factCmd(db, 'list');
    break;

  case 'forget':
    factCmd(db, 'close');
    break;

  case 'pin':
    if (!args[1]) console.log('用法：query.mjs pin 2026-10-20');
    else pinDay(db, args[1]);
    break;

  case 'tiers':
    showTiers(db);
    break;

  default:
    console.log('未知命令。可用：today / day / search / find / card / cards / thread / status / sessions / digest');
}

db.close();
