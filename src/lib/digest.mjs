// 速览块：生成会写进 ~/.dsh/AGENTS.md 的那段文字，以及安全替换它的逻辑。

import fs from 'node:fs';
import path from 'node:path';

import { dayOf, fmtTime } from './store.mjs';
import { AGENTS_PATH, PROFILE_PATH } from './paths.mjs';

export { AGENTS_PATH, PROFILE_PATH };

const BEGIN = '<!-- MEMORY:AUTO:BEGIN -->';
const END = '<!-- MEMORY:AUTO:END -->';

const cut = (s, n) => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : t.slice(0, n) + '…';
};

/** 生成速览块（不含前后手写内容）。 */
export function buildDigest(db) {
  const profile = JSON.parse(fs.readFileSync(PROFILE_PATH, 'utf8'));
  const now = Date.now();

  const tot = db.prepare('SELECT COUNT(*) n FROM events').get().n;
  const last = db.prepare('SELECT MAX(ts) t FROM events').get().t;
  const today = dayOf(now);
  const t = db.prepare('SELECT * FROM days WHERE date = ?').get(today);

  const recent = db
    .prepare(
      `SELECT s.title, s.cwd, s.workspace, MAX(e.ts) AS last_ts
       FROM events e JOIN sessions s ON s.id = e.session_id
       WHERE s.workspace NOT LIKE '--C-Users%Temp%'
       GROUP BY e.session_id
       ORDER BY last_ts DESC LIMIT 24`,
    )
    .all();

  // 会话标题通常比目录名有信息量，但自动标题里混着「问候」「【当前时间】…」这类噪声
  const JUNK = /^【|当前时间|^问候$|^Side:|^New thread$|^hi$|^测试$/i;
  const seenLabel = new Set();
  const projects = [];
  for (const r of recent) {
    const t = (r.title ?? '').replace(/\s+/g, ' ').trim();
    const base = r.cwd ? path.basename(r.cwd) : '';
    const label = t && !JUNK.test(t) && t.length >= 3 ? t : base && !/^Temp$/i.test(base) ? base : null;
    if (!label || seenLabel.has(label)) continue;
    seenLabel.add(label);
    projects.push(`${cut(label, 16)}（${fmtTime(r.last_ts).slice(5, 10)}）`);
    if (projects.length >= 4) break;
  }

  const recentLine = projects.join('、');

  const collected = Number(
    db.prepare("SELECT value FROM meta WHERE key='last_refresh'").get()?.value ??
      db.prepare('SELECT MAX(ingested_at) t FROM files').get().t ??
      0,
  );
  const staleMin = collected ? Math.round((now - collected) / 60000) : null;
  const stale = staleMin !== null && staleMin > 120 ? ` ｜ 刷新停在 ${Math.floor(staleMin / 60)} 小时前` : '';

  const threads = db.prepare("SELECT title FROM threads WHERE status='open' ORDER BY updated_at DESC LIMIT 3").all();
  const threadLine = threads.length ? `未结：${threads.map((t) => cut(t.title, 18)).join('；')}` : '';

  const facts = db.prepare("SELECT value FROM facts WHERE status='active' ORDER BY id DESC LIMIT 3").all();
  const factLine = facts.length ? `记住：${facts.map((f) => cut(f.value, 24)).join('；')}` : '';

  return [
    BEGIN,
    '## 记忆速览（自动生成，勿手改；要改去改 memory/profile.json）',
    `更新 ${fmtTime(now)} ｜ 库内 ${tot} 条 ｜ 最后一条 ${last ? fmtTime(last) : '—'}${stale}`,
    `${profile.name}：${profile.identity}`,
    recentLine ? `最近在做：${recentLine}` : '',
    threadLine,
    factLine,
    `今天：${t ? `${t.n_events} 条 / ${t.n_sessions} 个会话` : '还没有记录'}`,
    `规矩：${profile.rules.join('；')}`,
    '要细节就查库，别猜：node F:\\DSH\\memory\\query.mjs find "关键词"（先定位到天，再给原文）',
    '开场不要复述本块；只有和当前话头相关时才自然引用。',
    END,
  ]
    .filter(Boolean)
    .join('\n');
}

const FILE_HEADER = `# 全局指令

这个文件由 DSH 在每个新会话第一次请求时自动加载。
下面的 MEMORY 块是机器生成的，每次刷新会整块替换；
要改内容请改 \`F:\\DSH\\memory\\profile.json\`，或者把想让我长期记住的话写在块外面。
`;

/** 把块写进目标文件；标记块之外的内容原样保留。返回 {created, replaced}。 */
export function upsertBlock(file, block) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let existing = '';
  try {
    existing = fs.readFileSync(file, 'utf8');
  } catch {
    existing = '';
  }

  if (!existing.includes(BEGIN)) {
    const base = existing.trim() ? existing.trimEnd() + '\n\n' : FILE_HEADER + '\n';
    fs.writeFileSync(file, base + block + '\n', 'utf8');
    return { created: true, replaced: false };
  }

  const i = existing.indexOf(BEGIN);
  const j = existing.indexOf(END);
  if (j === -1) {
    fs.writeFileSync(file, existing.trimEnd() + '\n\n' + block + '\n', 'utf8');
    return { created: false, replaced: false };
  }
  const next = existing.slice(0, i) + block + existing.slice(j + END.length);
  fs.writeFileSync(file, next, 'utf8');
  return { created: false, replaced: true };
}
