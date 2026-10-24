// 会话文件解码器：把 DSH 的 session.v4.jsonl.zstd 还原成记录数组。
// 文件是「多个 zstd 帧首尾相接」的追加式结构，直接解压只会得到第一帧，
// 所以要按魔数 28 b5 2f fd 切帧，逐帧解压。

import fs from 'node:fs';
import zlib from 'node:zlib';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 把整个文件解成 Buffer 文本（多帧拼接）。 */
function decompressAll(buf) {
  const offs = [];
  let i = 0;
  while ((i = buf.indexOf(MAGIC, i)) !== -1) {
    offs.push(i);
    i += 1;
  }
  // 没有魔数：当作未压缩文本
  if (offs.length === 0) return buf.toString('utf8');

  const chunks = [];
  let idx = 0;
  let failures = 0;
  while (idx < offs.length) {
    const start = offs[idx];
    let ok = false;
    // 正常情况：帧边界就是下一个魔数。偶发误判时向后并一帧再试。
    for (let j = idx + 1; j <= offs.length; j++) {
      const end = j < offs.length ? offs[j] : buf.length;
      try {
        const out = zlib.zstdDecompressSync(buf.subarray(start, end));
        chunks.push(out);
        idx = j;
        ok = true;
        break;
      } catch {
        // 继续尝试更长的跨度
      }
    }
    if (!ok) {
      failures += 1;
      idx += 1;
    }
  }
  if (failures) {
    process.stderr.write(`  [warn] ${failures} 个帧解压失败（尾部截断或误判，已跳过）\n`);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** 解析一个会话文件，返回记录数组。 */
export function decodeSessionFile(file) {
  const buf = fs.readFileSync(file);
  const text = decompressAll(buf);
  const records = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // 半行/坏行跳过
    }
  }
  return records;
}

/** 从 content 数组里抽纯文本（丢掉 reasoning 等）。 */
function contentText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n')
    .trim();
}

const MAX_TEXT = 8000;
const INJECTED_RE = /^<system-reminder>|<compacted-summary>|^【当前时间】|^Current runtime context\.|^Time sampled while preparing turn|^You are repeating the exact same tool call/;

function clip(s) {
  if (s.length <= MAX_TEXT) return s;
  return s.slice(0, MAX_TEXT) + `\n…[截断，原长 ${s.length}]`;
}

/**
 * 把原始记录映射成 events。
 * 只保留有信息量的类型：用户发言、助手发言、工具调用、压缩摘要、目标变更、标题。
 */
export function recordsToEvents(records) {
  let session = null;
  let title = null;
  const events = [];

  for (const r of records) {
    if (!r || typeof r.type !== 'string') continue;
    const t = r.time ?? null;

    switch (r.type) {
      case 'session':
        session = {
          id: r.id ?? null,
          cwd: r.cwd ?? null,
          createdAt: r.createdAt ?? null,
          preset: r.agentPreset ?? null,
        };
        break;

      case 'session/title':
        title = r.data?.title ?? title;
        break;

      case 'user/message': {
        const text = contentText(r.data?.content);
        if (!text) break;
        // source.kind 是最准的判据：真实用户输入是 'user'，
        // 其余的 runtime-context / time-context / tool-jobs / skill-catalog / honcho
        // 都是系统往对话里塞的通知，不是人说的话。
        const srcKind = r.data?.source?.kind ?? '';
        const injected = (srcKind && srcKind !== 'user') || (!srcKind && INJECTED_RE.test(text)) ? 1 : 0;
        events.push({
          seq: r.seq,
          ts: t,
          kind: 'user',
          role: 'user',
          text: clip(text),
          injected,
        });
        break;
      }

      case 'assistant/message': {
        const text = contentText(r.data?.message?.content);
        if (!text) break;
        events.push({
          seq: r.seq,
          ts: t,
          kind: 'assistant',
          role: 'assistant',
          text: clip(text),
          injected: 0,
        });
        break;
      }

      case 'tool/call': {
        const name = r.data?.name ?? '?';
        const args = typeof r.data?.arguments === 'string' ? r.data.arguments : JSON.stringify(r.data?.arguments ?? {});
        events.push({
          seq: r.seq,
          ts: t,
          kind: 'tool_call',
          role: 'tool',
          text: clip(`${name} ${args}`),
          injected: 0,
        });
        break;
      }

      case 'compaction/summary': {
        const text = contentText(r.data?.summary);
        if (!text) break;
        events.push({
          seq: r.seq,
          ts: t,
          kind: 'summary',
          role: 'system',
          text: clip(text),
          injected: 0,
        });
        break;
      }

      case 'goal/change': {
        const objective = r.data?.goal?.objective;
        if (!objective) break;
        events.push({
          seq: r.seq,
          ts: t,
          kind: 'goal',
          role: 'system',
          text: clip(`[${r.data.operation}] ${objective}`),
          injected: 0,
        });
        break;
      }

      default:
        break;
    }
  }

  return { session, title, events };
}
