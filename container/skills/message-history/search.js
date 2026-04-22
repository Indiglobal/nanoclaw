#!/usr/bin/env node
// message-history — query the all_messages audit store.
// Reads /workspace/project/store/messages.db in read-only mode via node:sqlite
// (built into Node 22+). Subcommands: search | show | list.
//
// Helpers are exported so tests can exercise arg parsing, query building, and
// output formatting without touching SQLite.

import { fileURLToPath } from 'node:url';

export const LIMITS = {
  search: { default: 50, max: 200 },
  show: { default: 100, max: 500 },
  list: { default: 50, max: 500 },
};

export const DEFAULT_DB_PATH = '/workspace/project/store/messages.db';

export function usage() {
  return [
    'Usage:',
    '  message-history search --query <text> [--chat <jid>] [--channel signal|whatsapp]',
    '                         [--since ISO] [--until ISO] [--limit N]',
    '  message-history show --chat <jid> [--before ISO] [--after ISO] [--limit N]',
    '  message-history list [--channel signal|whatsapp] [--groups-only | --dms-only]',
    '                       [--limit N]',
    '',
    'Defaults/maxes:',
    `  search: default ${LIMITS.search.default}, max ${LIMITS.search.max}`,
    `  show:   default ${LIMITS.show.default},  max ${LIMITS.show.max}`,
    `  list:   default ${LIMITS.list.default},  max ${LIMITS.list.max}`,
  ].join('\n');
}

export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        out[key] = true;
      } else {
        out[key] = next;
        i++;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

export function clampLimit(kind, raw) {
  const { default: d, max } = LIMITS[kind];
  if (raw === undefined || raw === true) return d;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return d;
  return Math.min(n, max);
}

export function buildSearchQuery(args) {
  if (!args.query) {
    return { error: 'search requires --query <text>' };
  }
  const clauses = ['content LIKE ?'];
  const params = [`%${args.query}%`];

  if (args.chat) {
    clauses.push('chat_jid = ?');
    params.push(args.chat);
  }
  if (args.channel) {
    clauses.push('channel = ?');
    params.push(args.channel);
  }
  if (args.since) {
    clauses.push('timestamp >= ?');
    params.push(args.since);
  }
  if (args.until) {
    clauses.push('timestamp <= ?');
    params.push(args.until);
  }

  const limit = clampLimit('search', args.limit);
  params.push(limit);
  const sql = `SELECT * FROM all_messages WHERE ${clauses.join(' AND ')} ORDER BY timestamp DESC LIMIT ?`;
  return { sql, params, limit };
}

export function buildShowQuery(args) {
  if (!args.chat) {
    return { error: 'show requires --chat <jid>' };
  }
  const clauses = ['chat_jid = ?'];
  const params = [args.chat];

  if (args.before) {
    clauses.push('timestamp < ?');
    params.push(args.before);
  }
  if (args.after) {
    clauses.push('timestamp > ?');
    params.push(args.after);
  }

  const limit = clampLimit('show', args.limit);
  params.push(limit);
  const sql = `SELECT * FROM all_messages WHERE ${clauses.join(' AND ')} ORDER BY timestamp DESC LIMIT ?`;
  return { sql, params, limit };
}

export function buildListQuery(args) {
  const clauses = [];
  const params = [];

  if (args.channel) {
    clauses.push('channel = ?');
    params.push(args.channel);
  }
  if (args['groups-only']) {
    clauses.push('is_group = 1');
  } else if (args['dms-only']) {
    clauses.push('is_group = 0');
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = clampLimit('list', args.limit);
  params.push(limit);

  const sql = `
    SELECT m1.chat_jid, m1.chat_name, m1.channel, m1.is_group,
           (SELECT content FROM all_messages m2
            WHERE m2.chat_jid = m1.chat_jid ORDER BY timestamp DESC LIMIT 1) AS last_content,
           (SELECT sender_name FROM all_messages m2
            WHERE m2.chat_jid = m1.chat_jid ORDER BY timestamp DESC LIMIT 1) AS last_sender,
           (SELECT timestamp FROM all_messages m2
            WHERE m2.chat_jid = m1.chat_jid ORDER BY timestamp DESC LIMIT 1) AS last_time,
           COUNT(*) AS msg_count
    FROM all_messages m1
    ${where}
    GROUP BY m1.chat_jid
    ORDER BY last_time DESC
    LIMIT ?
  `;
  return { sql, params, limit };
}

export function formatTimestamp(iso) {
  if (!iso) return '(no time)';
  return iso
    .replace('T', ' ')
    .replace(/\.\d+Z$/, 'Z')
    .replace(/Z$/, ' UTC');
}

export function truncate(s, n = 200) {
  if (!s) return '';
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > n ? oneLine.slice(0, n - 1) + '…' : oneLine;
}

export function chatLabel(row) {
  if (row.is_group) {
    return `[group] ${row.chat_name || row.chat_jid}`;
  }
  return `[dm] ${row.chat_name || row.sender_name || row.chat_jid}`;
}

export function formatMessageLine(row) {
  const who = row.is_from_me
    ? 'me'
    : row.sender_name || row.sender || 'unknown';
  const ch = row.channel || '?';
  const scope = row.is_group ? 'group' : 'dm';
  const chatBit = row.chat_name ? ` [${row.chat_name}]` : '';
  return `${formatTimestamp(row.timestamp)}  (${ch}/${scope})${chatBit}  ${who}: ${truncate(row.content, 400)}`;
}

export function formatSearchResult(rows, query) {
  if (rows.length === 0) {
    return `No messages matched "${query}".`;
  }
  const header = `${rows.length} match${rows.length === 1 ? '' : 'es'} for "${query}" (newest first):`;
  return [header, '', ...rows.map(formatMessageLine)].join('\n');
}

export function formatShowResult(rows, chatJid) {
  if (rows.length === 0) {
    return `No messages found in chat ${chatJid}.`;
  }
  const head = rows[0];
  const label = head.chat_name ? `${head.chat_name} (${chatJid})` : chatJid;
  const header = `Chat: ${label} — ${rows.length} message${rows.length === 1 ? '' : 's'} (oldest first):`;
  return [header, '', ...rows.map(formatMessageLine)].join('\n');
}

export function formatListResult(rows) {
  if (rows.length === 0) {
    return 'No observed chats yet.';
  }
  const header = `${rows.length} chat${rows.length === 1 ? '' : 's'} (most recent activity first):`;
  const lines = [header, ''];
  for (const row of rows) {
    const label = chatLabel(row);
    const when = formatTimestamp(row.last_time);
    const who = row.last_sender || 'unknown';
    const preview = truncate(row.last_content, 120);
    lines.push(`${label}  (${row.channel}, ${row.msg_count} msg)`);
    lines.push(`  jid: ${row.chat_jid}`);
    lines.push(`  last: ${when} — ${who}: ${preview}`);
    lines.push('');
  }
  return lines.join('\n');
}

async function openDb(dbPath) {
  const { existsSync } = await import('node:fs');
  if (!existsSync(dbPath)) {
    console.error(`Database not found at ${dbPath}.`);
    console.error('The all_messages table is populated by observer daemons.');
    console.error(
      'If observers have never been linked, there is nothing yet to query.',
    );
    process.exit(2);
  }
  const { DatabaseSync } = await import('node:sqlite');
  return new DatabaseSync(dbPath, { readOnly: true });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sub = args._[0];

  if (!sub || args.help || args.h) {
    console.log(usage());
    process.exit(sub ? 0 : 1);
  }

  const dbPath = process.env.MESSAGE_HISTORY_DB || DEFAULT_DB_PATH;
  const db = await openDb(dbPath);

  try {
    if (sub === 'search') {
      const q = buildSearchQuery(args);
      if (q.error) {
        console.error(q.error);
        console.error(usage());
        process.exit(1);
      }
      const rows = db.prepare(q.sql).all(...q.params);
      console.log(formatSearchResult(rows, args.query));
    } else if (sub === 'show') {
      const q = buildShowQuery(args);
      if (q.error) {
        console.error(q.error);
        console.error(usage());
        process.exit(1);
      }
      // DB returns newest first; reverse so output is chronological.
      const rows = db
        .prepare(q.sql)
        .all(...q.params)
        .reverse();
      console.log(formatShowResult(rows, args.chat));
    } else if (sub === 'list') {
      const q = buildListQuery(args);
      const rows = db.prepare(q.sql).all(...q.params);
      console.log(formatListResult(rows));
    } else {
      console.error(`Unknown subcommand: ${sub}`);
      console.error(usage());
      process.exit(1);
    }
  } finally {
    db.close();
  }
}

// Only run main() when executed directly (not when imported for tests).
const entryPath = fileURLToPath(import.meta.url);
if (process.argv[1] === entryPath) {
  main().catch((err) => {
    console.error(err?.stack || err?.message || String(err));
    process.exit(1);
  });
}
