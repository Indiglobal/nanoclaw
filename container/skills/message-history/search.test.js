// Tests for the pure helpers in search.js — arg parsing, query building,
// output formatting. DB access (node:sqlite) is exercised in the container,
// not here, so these tests run on any Node version that supports ESM.

import { describe, it, expect } from 'vitest';
import {
  parseArgs,
  clampLimit,
  LIMITS,
  buildSearchQuery,
  buildShowQuery,
  buildListQuery,
  formatTimestamp,
  truncate,
  chatLabel,
  formatMessageLine,
  formatSearchResult,
  formatShowResult,
  formatListResult,
  usage,
} from './search.js';

describe('parseArgs', () => {
  it('collects positional args under _', () => {
    const a = parseArgs(['search', 'extra']);
    expect(a._).toEqual(['search', 'extra']);
  });

  it('parses --key value pairs', () => {
    const a = parseArgs(['search', '--query', 'hello', '--limit', '20']);
    expect(a._).toEqual(['search']);
    expect(a.query).toBe('hello');
    expect(a.limit).toBe('20');
  });

  it('parses boolean flags with no value', () => {
    const a = parseArgs(['list', '--groups-only']);
    expect(a['groups-only']).toBe(true);
  });

  it('treats --foo followed by --bar as a boolean --foo', () => {
    const a = parseArgs(['list', '--groups-only', '--channel', 'signal']);
    expect(a['groups-only']).toBe(true);
    expect(a.channel).toBe('signal');
  });
});

describe('clampLimit', () => {
  it('returns default when unset', () => {
    expect(clampLimit('search', undefined)).toBe(LIMITS.search.default);
  });

  it('returns default when passed true (flag with no value)', () => {
    expect(clampLimit('search', true)).toBe(LIMITS.search.default);
  });

  it('caps at max', () => {
    expect(clampLimit('show', '99999')).toBe(LIMITS.show.max);
  });

  it('returns default on non-numeric input', () => {
    expect(clampLimit('list', 'banana')).toBe(LIMITS.list.default);
  });

  it('returns default on zero or negative', () => {
    expect(clampLimit('search', '0')).toBe(LIMITS.search.default);
    expect(clampLimit('search', '-5')).toBe(LIMITS.search.default);
  });

  it('passes through valid values', () => {
    expect(clampLimit('search', '25')).toBe(25);
  });
});

describe('buildSearchQuery', () => {
  it('errors without --query', () => {
    expect(buildSearchQuery({}).error).toMatch(/requires --query/);
  });

  it('builds minimal query with LIKE wildcarded', () => {
    const q = buildSearchQuery({ query: 'dinner' });
    expect(q.sql).toContain('content LIKE ?');
    expect(q.sql).toContain('ORDER BY timestamp DESC');
    expect(q.params[0]).toBe('%dinner%');
    expect(q.params.at(-1)).toBe(LIMITS.search.default);
  });

  it('adds filters and appends limit last', () => {
    const q = buildSearchQuery({
      query: 'x',
      chat: 'abc@g.us',
      channel: 'signal',
      since: '2026-04-01',
      until: '2026-04-30',
      limit: '10',
    });
    expect(q.sql).toContain('chat_jid = ?');
    expect(q.sql).toContain('channel = ?');
    expect(q.sql).toContain('timestamp >= ?');
    expect(q.sql).toContain('timestamp <= ?');
    expect(q.params).toEqual([
      '%x%',
      'abc@g.us',
      'signal',
      '2026-04-01',
      '2026-04-30',
      10,
    ]);
  });
});

describe('buildShowQuery', () => {
  it('errors without --chat', () => {
    expect(buildShowQuery({}).error).toMatch(/requires --chat/);
  });

  it('orders newest first (caller reverses)', () => {
    const q = buildShowQuery({ chat: '+1555' });
    expect(q.sql).toContain('ORDER BY timestamp DESC');
    expect(q.params).toEqual(['+1555', LIMITS.show.default]);
  });

  it('respects --before/--after windows', () => {
    const q = buildShowQuery({
      chat: 'c',
      before: '2026-04-20',
      after: '2026-04-10',
      limit: '5',
    });
    expect(q.sql).toContain('timestamp < ?');
    expect(q.sql).toContain('timestamp > ?');
    expect(q.params).toEqual(['c', '2026-04-20', '2026-04-10', 5]);
  });
});

describe('buildListQuery', () => {
  it('produces a single-row-per-chat query with no filters', () => {
    const q = buildListQuery({});
    expect(q.sql).toContain('GROUP BY m1.chat_jid');
    expect(q.sql).toContain('ORDER BY last_time DESC');
    // No outer WHERE when no filters — subqueries still have inner WHEREs.
    expect(q.sql).not.toMatch(/FROM all_messages m1\s+WHERE/);
    expect(q.params).toEqual([LIMITS.list.default]);
  });

  it('applies --channel + --groups-only', () => {
    const q = buildListQuery({
      channel: 'whatsapp',
      'groups-only': true,
      limit: '10',
    });
    expect(q.sql).toContain('channel = ?');
    expect(q.sql).toContain('is_group = 1');
    expect(q.params).toEqual(['whatsapp', 10]);
  });

  it('applies --dms-only', () => {
    const q = buildListQuery({ 'dms-only': true });
    expect(q.sql).toContain('is_group = 0');
  });

  it('prefers --groups-only when both flags are set', () => {
    const q = buildListQuery({ 'groups-only': true, 'dms-only': true });
    expect(q.sql).toContain('is_group = 1');
    expect(q.sql).not.toContain('is_group = 0');
  });
});

describe('formatTimestamp', () => {
  it('handles null', () => {
    expect(formatTimestamp(undefined)).toBe('(no time)');
  });

  it('reformats ISO to human-readable UTC', () => {
    expect(formatTimestamp('2026-04-22T10:30:15.123Z')).toBe(
      '2026-04-22 10:30:15 UTC',
    );
  });
});

describe('truncate', () => {
  it('returns empty string for falsy input', () => {
    expect(truncate('')).toBe('');
    expect(truncate(undefined)).toBe('');
  });

  it('collapses whitespace', () => {
    expect(truncate('hello   world\n\nfoo')).toBe('hello world foo');
  });

  it('truncates with ellipsis', () => {
    const long = 'x'.repeat(300);
    const out = truncate(long, 50);
    expect(out.length).toBe(50);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('chatLabel', () => {
  it('labels groups', () => {
    expect(chatLabel({ is_group: 1, chat_name: 'Family' })).toBe(
      '[group] Family',
    );
  });

  it('labels DMs using chat_name, falling back to sender_name then jid', () => {
    expect(chatLabel({ is_group: 0, chat_name: 'Alice' })).toBe('[dm] Alice');
    expect(chatLabel({ is_group: 0, sender_name: 'Bob' })).toBe('[dm] Bob');
    expect(chatLabel({ is_group: 0, chat_jid: '+1555' })).toBe('[dm] +1555');
  });
});

describe('formatMessageLine', () => {
  it('renders an incoming DM cleanly', () => {
    const line = formatMessageLine({
      timestamp: '2026-04-22T10:00:00Z',
      channel: 'signal',
      is_group: 0,
      sender_name: 'Alice',
      content: 'hey there',
    });
    expect(line).toContain('2026-04-22 10:00:00 UTC');
    expect(line).toContain('(signal/dm)');
    expect(line).toContain('Alice: hey there');
  });

  it('marks user-sent messages as me', () => {
    const line = formatMessageLine({
      timestamp: '2026-04-22T10:00:00Z',
      channel: 'whatsapp',
      is_group: 1,
      chat_name: 'Work',
      is_from_me: 1,
      content: 'on it',
    });
    expect(line).toContain('[Work]');
    expect(line).toMatch(/\bme: on it\b/);
    expect(line).toContain('(whatsapp/group)');
  });
});

describe('format*Result', () => {
  it('search returns empty-state message when no rows', () => {
    expect(formatSearchResult([], 'needle')).toBe(
      'No messages matched "needle".',
    );
  });

  it('search renders count + rows', () => {
    const out = formatSearchResult(
      [
        {
          timestamp: '2026-04-22T10:00:00Z',
          channel: 'signal',
          is_group: 0,
          sender_name: 'Alice',
          content: 'hi',
        },
      ],
      'hi',
    );
    expect(out).toContain('1 match for "hi"');
    expect(out).toContain('Alice: hi');
  });

  it('show renders empty state then chronological header', () => {
    expect(formatShowResult([], 'x')).toBe('No messages found in chat x.');
    const out = formatShowResult(
      [
        {
          timestamp: '2026-04-22T09:00:00Z',
          channel: 'signal',
          is_group: 0,
          chat_name: 'Alice',
          sender_name: 'Alice',
          content: 'one',
        },
      ],
      '+1555',
    );
    expect(out).toContain('Chat: Alice (+1555)');
    expect(out).toContain('1 message');
    expect(out).toContain('oldest first');
  });

  it('list renders directory with preview', () => {
    expect(formatListResult([])).toBe('No observed chats yet.');
    const out = formatListResult([
      {
        chat_jid: 'g@g.us',
        chat_name: 'Family',
        channel: 'whatsapp',
        is_group: 1,
        last_content: 'pizza tonight?',
        last_sender: 'Alice',
        last_time: '2026-04-22T12:00:00Z',
        msg_count: 42,
      },
    ]);
    expect(out).toContain('[group] Family');
    expect(out).toContain('(whatsapp, 42 msg)');
    expect(out).toContain('jid: g@g.us');
    expect(out).toContain('Alice: pizza tonight?');
  });
});

describe('usage', () => {
  it('mentions every subcommand', () => {
    const u = usage();
    expect(u).toContain('search');
    expect(u).toContain('show');
    expect(u).toContain('list');
  });
});
