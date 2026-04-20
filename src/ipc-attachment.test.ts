import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const testRoots = vi.hoisted(() => {
  const tmpFs = require('node:fs') as typeof import('node:fs');
  const tmpPath = require('node:path') as typeof import('node:path');
  const tmpOs = require('node:os') as typeof import('node:os');
  return {
    groupsDir: tmpFs.mkdtempSync(
      tmpPath.join(tmpOs.tmpdir(), 'nanoclaw-ipc-att-'),
    ),
  };
});

vi.mock('./config.js', () => ({
  GROUPS_DIR: testRoots.groupsDir,
  DATA_DIR: path.join(testRoots.groupsDir, '..', 'data'),
  IPC_POLL_INTERVAL: 1000,
  TIMEZONE: 'UTC',
}));

import { processAttachmentRequest, type IpcDeps } from './ipc.js';
import type { RegisteredGroup } from './types.js';

function makeDeps(overrides: Partial<IpcDeps> = {}): IpcDeps {
  return {
    sendMessage: vi.fn(async () => {}),
    sendAttachments: vi.fn(async () => {}),
    injectSystemNotice: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'signal:+15555550123': {
        name: 'Main DM',
        folder: 'main',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
        isMain: true,
      },
      'signal:+15555550888': {
        name: 'Friend',
        folder: 'friend',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })) as () => Record<string, RegisteredGroup>,
    registerGroup: vi.fn(),
    syncGroups: vi.fn(async () => {}),
    getAvailableGroups: vi.fn(() => []),
    writeGroupsSnapshot: vi.fn(),
    onTasksChanged: vi.fn(),
    ...overrides,
  };
}

describe('processAttachmentRequest', () => {
  let mainDir: string;

  beforeEach(() => {
    mainDir = path.join(testRoots.groupsDir, 'main');
    fs.mkdirSync(mainDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(mainDir, { recursive: true, force: true });
    fs.rmSync(path.join(testRoots.groupsDir, 'friend'), {
      recursive: true,
      force: true,
    });
  });

  function stagePhoto(rel: string): void {
    const full = path.join(mainDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, Buffer.from('pretend-jpeg'));
  }

  it('routes a valid single-file request to sendAttachments', async () => {
    stagePhoto('outbox/photo.jpg');
    const deps = makeDeps();

    await processAttachmentRequest(
      {
        type: 'send_attachments',
        requestId: 'r1',
        chatJid: 'signal:+15555550123',
        filePaths: ['/workspace/group/outbox/photo.jpg'],
        caption: 'here',
      },
      'main',
      true,
      deps,
    );

    expect(deps.sendAttachments).toHaveBeenCalledTimes(1);
    const [jid, paths, caption] = (
      deps.sendAttachments as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    expect(jid).toBe('signal:+15555550123');
    expect(paths).toHaveLength(1);
    expect(paths[0].endsWith('/outbox/photo.jpg')).toBe(true);
    expect(caption).toBe('here');
    expect(deps.injectSystemNotice).not.toHaveBeenCalled();
  });

  it('fails the batch on any invalid path and posts a system-notice', async () => {
    stagePhoto('outbox/photo.jpg');
    const deps = makeDeps();

    await processAttachmentRequest(
      {
        type: 'send_attachments',
        requestId: 'r2',
        chatJid: 'signal:+15555550123',
        filePaths: [
          '/workspace/group/outbox/photo.jpg',
          '/workspace/group/missing.jpg',
        ],
      },
      'main',
      true,
      deps,
    );

    expect(deps.sendAttachments).not.toHaveBeenCalled();
    expect(deps.injectSystemNotice).toHaveBeenCalledTimes(1);
    const [folder, payload] = (
      deps.injectSystemNotice as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    expect(folder).toBe('main');
    expect(payload).toContain('system-notice');
    expect(payload).toContain('reason="not_found"');
    expect(payload).toContain('request_id="r2"');
  });

  it('rejects cross-chat send from non-main group', async () => {
    stagePhoto('outbox/photo.jpg');
    const deps = makeDeps();

    await processAttachmentRequest(
      {
        type: 'send_attachments',
        requestId: 'r3',
        chatJid: 'signal:+15555550888', // different chat
        filePaths: ['/workspace/group/outbox/photo.jpg'],
      },
      'main',
      false, // not main
      deps,
    );

    expect(deps.sendAttachments).not.toHaveBeenCalled();
    expect(deps.injectSystemNotice).toHaveBeenCalledTimes(1);
    const [, payload] = (deps.injectSystemNotice as ReturnType<typeof vi.fn>)
      .mock.calls[0];
    expect(payload).toContain('reason="unauthorized"');
  });

  it('wraps channel sendAttachments failure in a system-notice', async () => {
    stagePhoto('outbox/photo.jpg');
    const deps = makeDeps({
      sendAttachments: vi.fn(async () => {
        throw new Error('signal-cli unreachable');
      }),
    });

    await processAttachmentRequest(
      {
        type: 'send_attachments',
        requestId: 'r4',
        chatJid: 'signal:+15555550123',
        filePaths: ['/workspace/group/outbox/photo.jpg'],
      },
      'main',
      true,
      deps,
    );

    expect(deps.injectSystemNotice).toHaveBeenCalledTimes(1);
    const [, payload] = (deps.injectSystemNotice as ReturnType<typeof vi.fn>)
      .mock.calls[0];
    expect(payload).toContain('reason="rpc_failed"');
    expect(payload).toContain('signal-cli unreachable');
  });

  it('reports channel_unsupported when channel lacks sendAttachments', async () => {
    stagePhoto('outbox/photo.jpg');
    const err = Object.assign(new Error('no'), {
      name: 'ChannelUnsupportedError',
    });
    const deps = makeDeps({
      sendAttachments: vi.fn(async () => {
        throw err;
      }),
    });

    await processAttachmentRequest(
      {
        type: 'send_attachments',
        requestId: 'r5',
        chatJid: 'signal:+15555550123',
        filePaths: ['/workspace/group/outbox/photo.jpg'],
      },
      'main',
      true,
      deps,
    );

    const [, payload] = (deps.injectSystemNotice as ReturnType<typeof vi.fn>)
      .mock.calls[0];
    expect(payload).toContain('reason="channel_unsupported"');
  });

  it('rejects request with no files', async () => {
    const deps = makeDeps();
    await processAttachmentRequest(
      {
        type: 'send_attachments',
        requestId: 'r6',
        chatJid: 'signal:+15555550123',
        filePaths: [],
      },
      'main',
      true,
      deps,
    );
    expect(deps.sendAttachments).not.toHaveBeenCalled();
    expect(deps.injectSystemNotice).toHaveBeenCalled();
  });
});
