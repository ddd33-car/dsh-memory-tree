// 路径：代码在哪、数据在哪，分成两件事。
//
//   CODE_DIR  插件安装目录里的 src/，只读
//   DATA_DIR  记忆库所在地，默认 ~/.dsh/memory，可用环境变量 DSH_MEMORY_DIR 覆盖
//
// 插件运行时会把 DSH_MEMORY_DIR 设成配置里的 memoryDir，代码本身不动。

import os from 'node:os';
import path from 'node:path';

/** 本文件在 src/lib/ 下，往上是 src/。 */
export const CODE_DIR = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')));

/** 数据目录：库、卡片、网页、日志都在这里。 */
export const DATA_DIR = process.env.DSH_MEMORY_DIR
  ? path.resolve(process.env.DSH_MEMORY_DIR)
  : path.join(os.homedir(), '.dsh', 'memory');

export const DB_PATH = path.join(DATA_DIR, 'memory.db');
export const REPORT_PATH = path.join(DATA_DIR, 'report.html');
export const VIEWER_PATH = path.join(CODE_DIR, 'viewer.html');
export const PROFILE_PATH = path.join(DATA_DIR, 'profile.json');
export const DECAY_PATH = path.join(DATA_DIR, 'decay.json');
export const SOURCES_PATH = path.join(DATA_DIR, 'sources.json');
export const LOG_PATH = path.join(DATA_DIR, 'refresh.log');
export const LOCK_PATH = path.join(DATA_DIR, '.lock');

/** DSH 的会话日志根目录，采集从这里读。 */
export const SESSIONS_ROOT = process.env.DSH_SESSIONS_DIR
  ? path.resolve(process.env.DSH_SESSIONS_DIR)
  : path.join(os.homedir(), '.dsh', 'sessions');

/** DSH 每个新会话都会加载这个文件；速览写进它的 MEMORY:AUTO 块。 */
export const AGENTS_PATH = path.join(os.homedir(), '.dsh', 'AGENTS.md');
