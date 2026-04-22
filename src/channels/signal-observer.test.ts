import { describe, expect, it, vi } from 'vitest';
import { SignalObserver } from './signal-observer.js';
import { ObservedMessage } from '../types.js';

function makeObserver(account: string, captured: ObservedMessage[]) {
  return new SignalObserver({
    account,
    dataDir: '/tmp/test-observer',
    host: '127.0.0.1',
    port: 9999,
    onObservedMessage: (m) => captured.push(m),
  });
}

// Exercise the private handleSseEvent via type assertion. This avoids spinning
// up a real daemon and tests the envelope→ObservedMessage mapping.
async function feed(obs: SignalObserver, envelope: unknown): Promise<void> {
  const data = JSON.stringify(envelope);
  await (
    obs as unknown as {
      handleSseEvent: (e: { data: string }) => Promise<void>;
    }
  ).handleSseEvent({ data });
}

describe('SignalObserver.handleSseEvent', () => {
  it('emits inbound DM as observed message', async () => {
    const captured: ObservedMessage[] = [];
    const obs = makeObserver('+1user', captured);
    await feed(obs, {
      sourceNumber: '+1friend',
      sourceName: 'Friend',
      dataMessage: {
        timestamp: 1700000000000,
        message: 'hey there',
      },
    });
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      channel: 'signal',
      is_group: false,
      is_from_me: false,
      sender: '+1friend',
      sender_name: 'Friend',
      content: 'hey there',
      chat_jid: 'signal:+1friend',
    });
  });

  it('emits inbound group message with group JID', async () => {
    const captured: ObservedMessage[] = [];
    const obs = makeObserver('+1user', captured);
    await feed(obs, {
      sourceNumber: '+1friend',
      sourceName: 'Friend',
      dataMessage: {
        timestamp: 1700000000000,
        message: 'hi group',
        groupInfo: { groupId: 'abc123', groupName: 'Book Club' },
      },
    });
    expect(captured).toHaveLength(1);
    expect(captured[0].is_group).toBe(true);
    expect(captured[0].chat_jid).toBe('signal:group:abc123');
    expect(captured[0].chat_name).toBe('Book Club');
  });

  it('emits syncMessage (user sent from another device) with is_from_me', async () => {
    const captured: ObservedMessage[] = [];
    const obs = makeObserver('+1user', captured);
    await feed(obs, {
      sourceNumber: '+1user',
      syncMessage: {
        sentMessage: {
          timestamp: 1700000000000,
          message: 'reply from phone',
          destinationNumber: '+1friend',
        },
      },
    });
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      is_from_me: true,
      sender: '+1user',
      sender_name: 'Me',
      content: 'reply from phone',
      chat_jid: 'signal:+1friend', // keyed on recipient, not sender
    });
  });

  it('drops empty-text messages in v1 (no attachment capture)', async () => {
    const captured: ObservedMessage[] = [];
    const obs = makeObserver('+1user', captured);
    await feed(obs, {
      sourceNumber: '+1friend',
      dataMessage: {
        timestamp: 1700000000000,
        message: '',
        attachments: [{ id: 'x', contentType: 'image/jpeg' }],
      },
    });
    expect(captured).toHaveLength(0);
  });

  it('ignores malformed payloads gracefully', async () => {
    const captured: ObservedMessage[] = [];
    const obs = makeObserver('+1user', captured);
    await feed(obs, {}); // no dataMessage, no syncMessage
    await (
      obs as unknown as {
        handleSseEvent: (e: { data?: string }) => Promise<void>;
      }
    ).handleSseEvent({ data: 'not-json' });
    expect(captured).toHaveLength(0);
  });

  it('does not expose sendMessage / sendAttachments', () => {
    const obs = makeObserver('+1user', []);
    expect(
      (obs as unknown as Record<string, unknown>).sendMessage,
    ).toBeUndefined();
    expect(
      (obs as unknown as Record<string, unknown>).sendAttachments,
    ).toBeUndefined();
  });
});
