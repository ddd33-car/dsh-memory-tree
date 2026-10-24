// 事实：你亲口让我记住的事。
//
// 原则跟其他层一样——只追加。改主意时把旧的那条关掉，再记新的，
// 这样以后还能回答「你当时是怎么说的」。

export function addFact(db, value, { subject = null, source = 'user' } = {}) {
  const now = Date.now();
  const text = String(value).trim();
  if (!text) throw new Error('内容为空');
  const r = db
    .prepare('INSERT INTO facts (subject, value, status, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(subject, text, 'active', source, now, now);
  return Number(r.lastInsertRowid);
}

export function listFacts(db, { status = 'active', limit = 50 } = {}) {
  return db
    .prepare('SELECT id, subject, value, status, created_at FROM facts WHERE status = ? ORDER BY id DESC LIMIT ?')
    .all(status, limit);
}

export function closeFact(db, id) {
  const r = db.prepare("UPDATE facts SET status='closed', updated_at=? WHERE id=? AND status='active'").run(Date.now(), id);
  return r.changes > 0;
}

export function searchFacts(db, q, limit = 5) {
  return db
    .prepare("SELECT id, subject, value FROM facts WHERE status='active' AND value LIKE ? ORDER BY id DESC LIMIT ?")
    .all(`%${q}%`, limit);
}

/** 最近记住的几条，给速览用。 */
export function recentFacts(db, limit = 3) {
  return listFacts(db, { status: 'active', limit });
}
