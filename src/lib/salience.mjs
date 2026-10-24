// 显著度与遗忘曲线。
//
// 借用两个东西：
//   1. 艾宾浩斯遗忘曲线 —— 记忆强度随时间指数衰减
//   2. 间隔重复（FSRS 那套）—— 每被「想起」一次，稳定性就抬高一截
//
// 一天算一个「情景」。分数由四部分构成：
//   你说了多少（人的话比工具调用值钱）
//   主题复现（同一个词在前后 N 天里出现了几天 —— 反复提到 = 重要）
//   里程碑（完成 / 决定 / 买了 / 崩了 … 这类词）
//   是否留下了事实或目标

import { dayStartMs, dayOf } from './store.mjs';

const MILESTONE = /(搞定|修好|完成|做完|决定|确定|放弃|第一次|最后|买了|选了|换成|改用|失败|崩了|报错|通过|拿到|签了|开始做|不做了)/g;

const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));

export function featuresForDay(db, date) {
  const s = dayStartMs(date);
  const e = s + 86400000;

  const counts = db
    .prepare(
      `SELECT
         SUM(CASE WHEN kind='user'      AND injected=0 THEN 1 ELSE 0 END) AS user_msgs,
         SUM(CASE WHEN kind='assistant' AND injected=0 THEN 1 ELSE 0 END) AS ai_msgs,
         SUM(CASE WHEN kind='tool_call' THEN 1 ELSE 0 END)                  AS tool_calls,
         SUM(CASE WHEN kind='goal'      THEN 1 ELSE 0 END)                  AS goals,
         COUNT(*)                                                          AS total
       FROM events WHERE ts >= ? AND ts < ?`,
    )
    .get(s, e);

  // 里程碑：在你和我的话里数
  const text = db
    .prepare(
      `SELECT text FROM events
       WHERE ts >= ? AND ts < ? AND injected = 0 AND kind IN ('user','assistant')`,
    )
    .all(s, e)
    .map((r) => r.text)
    .join('\n');
  const milestones = (text.match(MILESTONE) ?? []).length;

  // 主题复现：本日权重最高的几个词，各自在前后 30 天里出现在多少天
  const top = db.prepare('SELECT term FROM term_days WHERE date = ? ORDER BY n DESC LIMIT 6').all(date);
  let recurrence = 0;
  for (const t of top) {
    const r = db
      .prepare(
        `SELECT COUNT(*) d FROM term_days
         WHERE term = ? AND date >= date(?, '-30 day') AND date <= date(?, '+30 day')`,
      )
      .get(t.term, date, date);
    recurrence += r.d ?? 0;
  }
  recurrence = top.length ? recurrence / top.length : 0;

  // 这天有没有亲手记下的事实
  const facts = db
    .prepare('SELECT COUNT(*) n FROM facts WHERE created_at >= ? AND created_at < ?')
    .get(s, e).n;

  return {
    user_msgs: counts.user_msgs ?? 0,
    ai_msgs: counts.ai_msgs ?? 0,
    tool_calls: counts.tool_calls ?? 0,
    goals: counts.goals ?? 0,
    total: counts.total ?? 0,
    milestones,
    recurrence: Math.round(recurrence * 10) / 10,
    facts,
  };
}

/** 0..1 的显著度。权重是拍出来的，后面可以按实际效果调。 */
export function salienceOf(f, touches = 0) {
  if (!f.total) return 0;

  const talk = clamp(Math.log1p(f.user_msgs) / Math.log1p(40));        // 说得多
  const recur = clamp(f.recurrence / 8);                               // 反复提到
  const mile = clamp(f.milestones / 8);                                // 有里程碑
  const bond = clamp((f.facts * 2 + f.goals) / 3);                     // 留了事实/目标
  const touch = clamp(Math.log1p(touches) / Math.log1p(12)) * 0.5;     // 被想起过

  // 纯工具日：人几乎没说话，压一压
  const hollow = f.user_msgs === 0 && f.ai_msgs > 0 ? 0.7 : 1;

  return clamp((0.30 * talk + 0.34 * recur + 0.22 * mile + 0.14 * bond + touch) * hollow);
}

export const TIERS = {
  core: '核心', // 你亲口让我记住的
  deep: '深刻',
  normal: '普通',
  faint: '淡忘',
};

export function tierOf(salience, cfg) {
  if (salience >= cfg.deepThreshold) return 'deep';
  if (salience >= cfg.normalThreshold) return 'normal';
  return 'faint';
}

/**
 * 当前可召回度：0..1。
 * 半衰期随等级拉长；deep 的一年才掉一半，faint 的十天就剩一半。
 */
export function retentionOf(salience, tier, ageDays, cfg) {
  const halfLife = cfg.halfLifeDays[tier] * (0.6 + 0.8 * salience);
  if (halfLife <= 0) return 0;
  return Math.pow(0.5, Math.max(0, ageDays) / halfLife);
}

export const DEFAULT_CFG = {
  deepThreshold: 0.55,
  normalThreshold: 0.28,
  // 半衰期（天）：多久掉到一半
  halfLifeDays: { deep: 365, normal: 45, faint: 10 },
  // 原文保留期（天）：过了就只留摘要，原文进冷存
  retentionDays: { deep: 3650, normal: 540, faint: 90 },
  // 被检索到一次，稳定性乘这个系数（间隔重复的「复习」）
  recallBoost: 1.15,
};

export { dayOf };
