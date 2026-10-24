// 刷新入口：采集 → 重新生成速览 → 写进 ~/.dsh/AGENTS.md。
// 定时任务和「会话结束前手动跑一次」都走这里。
//
//   node refresh.mjs              采集 + 更新速览
//   node refresh.mjs --dry        只打印速览，不写文件
//   node refresh.mjs --full       忽略水位全量重扫

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { collect } from './collect.mjs';
import { openDb, fmtTime } from './lib/store.mjs';
import { buildDigest, upsertBlock, AGENTS_PATH } from './lib/digest.mjs';
import { CODE_DIR, DATA_DIR, LOCK_PATH, LOG_PATH } from './lib/paths.mjs';

const LOG = LOG_PATH;
const writeDigest = process.env.DSH_MEMORY_DIGEST !== '0';

function log(line) {
  fs.appendFileSync(LOG, `${fmtTime(Date.now())}  ${line}\n`, 'utf8');
  // 只保留最近 500 行，别让日志自己变成负担
  try {
    const lines = fs.readFileSync(LOG, 'utf8').split('\n');
    if (lines.length > 500) fs.writeFileSync(LOG, lines.slice(-500).join('\n'), 'utf8');
  } catch {}
}

const dry = process.argv.includes('--dry');
const full = process.argv.includes('--full');

// 防重入：两分钟内的第二次启动直接退出；锁超过 10 分钟视为崩溃残留，强行接管
const LOCK = LOCK_PATH;
try {
  const st = fs.statSync(LOCK);
  if (Date.now() - st.mtimeMs < 10 * 60 * 1000) {
    console.log('上一次刷新还在跑，跳过。');
    process.exit(0);
  }
} catch {}
fs.writeFileSync(LOCK, String(process.pid));

try {
  const t0 = Date.now();
  const r = collect({ full, quiet: true });
  const db = openDb();
  const block = buildDigest(db);
  db.close();

  if (dry) {
    console.log(block);
    fs.unlinkSync(LOCK);
    process.exit(0);
  }

  const res = writeDigest ? upsertBlock(AGENTS_PATH, block) : { created: false, replaced: false };

  // 记一次「刷新跑过了」。没有这一笔，速览只能看到「最后一条新数据」，
  // 会误报成「采集停了」——其实只是这段时间没新内容。
  {
    const db2 = openDb();
    db2.prepare("INSERT INTO meta (key, value) VALUES ('last_refresh', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(String(Date.now()));
    db2.close();
  }

  // 巩固与遗忘：给新的一天算显著度，并按保留期压缩过老的原文
  try {
    execFileSync(process.execPath, ['--no-warnings', path.join(CODE_DIR, 'consolidate.mjs'), '--apply'], {
      cwd: DATA_DIR,
      stdio: 'ignore',
    });
  } catch (e) {
    log(`consolidate 失败：${e.message}`);
  }

  // 顺手重建网页版概览，让它跟速览同一时刻更新
  try {
    execFileSync(process.execPath, ['--no-warnings', path.join(CODE_DIR, 'report.mjs')], { cwd: DATA_DIR, stdio: 'ignore' });
  } catch (e) {
    log(`report 失败：${e.message}`);
  }

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const msg =
    `采集 ${r.scanned} 个文件 / 新增 ${r.newEvents} 条 / 库内 ${r.total} 条` +
    ` ｜ 速览${res.created ? '新建' : res.replaced ? '已更新' : '已写入'} ${AGENTS_PATH} ｜ ${secs}s`;
  console.log(msg);
  log(msg);
} catch (err) {
  log(`失败：${err.stack ?? err.message}`);
  console.error(`刷新失败：${err.message}`);
  process.exitCode = 1;
} finally {
  try {
    fs.unlinkSync(LOCK);
  } catch {}
}
