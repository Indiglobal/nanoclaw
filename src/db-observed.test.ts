import { describe, it, expect, beforeEach } from 'vitest';

import {
  _initTestDatabase,
  getObservedChatHistory,
  listObservedChats,
  searchObservedMessages,
  storeObservedMessage,
} from './db.js';
import { ObservedMessage } from './types.js';

beforeEach(() => {
  _initTestDatabase();
});

function make(overrides: Partial<ObservedMessage> = {}): ObservedMessage {
  return {
    id: overrides.id ?? 'm1',
    chat_jid: overrides.chat_jid ?? 'signal:+15551234',
    sender: overrides.sender ?? '+15551234',
    sender_name: overrides.sender_name ?? 'Alice',
    content: overrides.content ?? 'hello',
    timestamp: overrides.timestamp ?? '2026-04-20T10:00:00.000Z',
    is_from_me: overrides.is_from_me ?? false,
    channel: overrides.channel ?? 'signal',
    is_group: overrides.is_group ?? false,
    chat_name: overrides.chat_name ?? 'Alice',
  };
}

describe('storeObservedMessage', () => {
  it('stores and returns a message', () => {
    storeObservedMessage(make());
    const rows = searchObservedMessages({ limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe('hello');
    expect(rows[0].channel).toBe('signal');
    expect(rows[0].is_from_me).toBe(false);
  });

  it('dedups on (id, chat_jid) via INSERT OR IGNORE', () => {
    storeObservedMessage(make({ content: 'first' }));
    storeObservedMessage(make({ content: 'second' }));
    const rows = searchObservedMessages({ limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe('first'); // first write wins
  });

  it('does not dedup when chat_jid differs', () => {
    storeObservedMessage(make({ id: 'm1', chat_jid: 'signal:A' }));
    storeObservedMessage(make({ id: 'm1', chat_jid: 'signal:B' }));
    const rows = searchObservedMessages({ limit: 10 });
    expect(rows).toHaveLength(2);
  });
});

describe('searchObservedMessages', () => {
  beforeEach(() => {
    storeObservedMessage(
      make({
        id: '1',
        content: 'meeting at 3pm',
        timestamp: '2026-04-20T09:00:00.000Z',
        chat_jid: 'signal:A',
      }),
    );
    storeObservedMessage(
      make({
        id: '2',
        content: 'lunch plans',
        timestamp: '2026-04-20T12:00:00.000Z',
        chat_jid: 'signal:B',
        channel: 'signal',
      }),
    );
    storeObservedMessage(
      make({
        id: '3',
        content: 'meeting notes',
        timestamp: '2026-04-20T15:00:00.000Z',
        chat_jid: '555@s.whatsapp.net',
        channel: 'whatsapp',
      }),
    );
  });

  it('filters by query text', () => {
    const rows = searchObservedMessages({ query: 'meeting' });
    expect(rows).toHaveLength(2);
  });

  it('filters by chat_jid', () => {
    const rows = searchObservedMessages({ chatJid: 'signal:B' });
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe('lunch plans');
  });

  it('filters by channel', () => {
    const rows = searchObservedMessages({ channel: 'whatsapp' });
    expect(rows).toHaveLength(1);
    expect(rows[0].channel).toBe('whatsapp');
  });

  it('filters by time range', () => {
    const rows = searchObservedMessages({
      since: '2026-04-20T11:00:00.000Z',
      until: '2026-04-20T13:00:00.000Z',
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('2');
  });

  it('orders newest first and respects limit', () => {
    const rows = searchObservedMessages({ limit: 2 });
    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe('3');
    expect(rows[1].id).toBe('2');
  });

  it('clamps limit to [1, 200]', () => {
    for (let i = 0; i < 5; i++) {
      storeObservedMessage(
        make({ id: `extra-${i}`, chat_jid: `signal:X-${i}` }),
      );
    }
    expect(searchObservedMessages({ limit: 0 })).toHaveLength(1);
    expect(searchObservedMessages({ limit: 999 }).length).toBeGreaterThan(1);
  });
});

describe('getObservedChatHistory', () => {
  beforeEach(() => {
    for (let i = 0; i < 5; i++) {
      storeObservedMessage(
        make({
          id: `m${i}`,
          chat_jid: 'signal:chat1',
          timestamp: `2026-04-20T10:0${i}:00.000Z`,
          content: `msg ${i}`,
        }),
      );
    }
  });

  it('returns only the specified chat', () => {
    storeObservedMessage(make({ id: 'other', chat_jid: 'signal:chat2' }));
    const rows = getObservedChatHistory('signal:chat1', { limit: 50 });
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.chat_jid === 'signal:chat1')).toBe(true);
  });

  it('paginates with before', () => {
    const rows = getObservedChatHistory('signal:chat1', {
      before: '2026-04-20T10:03:00.000Z',
      limit: 10,
    });
    expect(rows).toHaveLength(3); // m0, m1, m2
  });
});

describe('listObservedChats', () => {
  it('aggregates to one row per chat with last-message preview', () => {
    storeObservedMessage(
      make({
        id: '1',
        chat_jid: 'signal:A',
        timestamp: '2026-04-20T10:00:00.000Z',
        content: 'older',
        chat_name: 'Alice',
      }),
    );
    storeObservedMessage(
      make({
        id: '2',
        chat_jid: 'signal:A',
        timestamp: '2026-04-20T11:00:00.000Z',
        content: 'newer',
        chat_name: 'Alice',
      }),
    );
    storeObservedMessage(
      make({
        id: '3',
        chat_jid: '555@g.us',
        timestamp: '2026-04-20T09:00:00.000Z',
        content: 'group chat',
        channel: 'whatsapp',
        is_group: true,
        chat_name: 'Group',
      }),
    );

    const rows = listObservedChats({ limit: 10 });
    expect(rows).toHaveLength(2);
    // Newest first
    expect(rows[0].chat_jid).toBe('signal:A');
    expect(rows[0].last_content).toBe('newer');
    expect(rows[0].last_timestamp).toBe('2026-04-20T11:00:00.000Z');
    expect(rows[1].chat_jid).toBe('555@g.us');
    expect(rows[1].is_group).toBe(true);
  });

  it('filters by channel and is_group', () => {
    storeObservedMessage(make({ chat_jid: 'signal:A', channel: 'signal' }));
    storeObservedMessage(
      make({
        id: 'wa',
        chat_jid: '555@s.whatsapp.net',
        channel: 'whatsapp',
        is_group: false,
      }),
    );
    expect(listObservedChats({ channel: 'signal' })).toHaveLength(1);
    expect(listObservedChats({ channel: 'whatsapp' })).toHaveLength(1);
    expect(listObservedChats({ isGroup: false })).toHaveLength(2);
  });
});
