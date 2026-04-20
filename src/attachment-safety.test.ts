import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// validateAttachment calls resolveGroupFolderPath which reads GROUPS_DIR from
// config. We swap in a temp GROUPS_DIR per test via a hoisted mock.
const testRoots = vi.hoisted(() => {
  const tmpFs = require('node:fs') as typeof import('node:fs');
  const tmpPath = require('node:path') as typeof import('node:path');
  const tmpOs = require('node:os') as typeof import('node:os');
  return {
    groupsDir: tmpFs.mkdtempSync(
      tmpPath.join(tmpOs.tmpdir(), 'nanoclaw-att-safety-'),
    ),
  };
});

vi.mock('./config.js', () => ({
  GROUPS_DIR: testRoots.groupsDir,
  DATA_DIR: path.join(testRoots.groupsDir, '..', 'data'),
}));

import {
  AttachmentValidationError,
  CONTAINER_GROUP_PREFIX,
  MAX_ATTACHMENT_BYTES,
  validateAttachment,
} from './attachment-safety.js';

describe('validateAttachment', () => {
  const folder = 'main';
  let groupDir: string;

  beforeEach(() => {
    groupDir = path.join(testRoots.groupsDir, folder);
    fs.mkdirSync(groupDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(groupDir, { recursive: true, force: true });
  });

  function write(rel: string, bytes: Buffer | string): string {
    const full = path.join(groupDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, bytes);
    return full;
  }

  it('resolves a valid path inside /workspace/group/', () => {
    write('outbox/photo.jpg', Buffer.from('hello'));
    const result = validateAttachment(
      `${CONTAINER_GROUP_PREFIX}outbox/photo.jpg`,
      folder,
    );
    expect(result.size).toBe(5);
    expect(result.hostPath.endsWith('/outbox/photo.jpg')).toBe(true);
  });

  it('rejects empty path', () => {
    expect(() => validateAttachment('', folder)).toThrow(
      AttachmentValidationError,
    );
  });

  it('rejects paths outside /workspace/group/', () => {
    const err = () => validateAttachment('/etc/passwd', folder);
    expect(err).toThrow(AttachmentValidationError);
    try {
      err();
    } catch (e) {
      expect((e as AttachmentValidationError).reason).toBe('path_escape');
    }
  });

  it('rejects traversal via ..', () => {
    write('outbox/photo.jpg', 'x');
    // ..: /workspace/group/../project/foo.jpg would be fine as a container path
    // string, but normalize makes it escape the group root.
    expect(() =>
      validateAttachment(`${CONTAINER_GROUP_PREFIX}../outside.jpg`, folder),
    ).toThrow(AttachmentValidationError);
  });

  it('rejects missing file', () => {
    try {
      validateAttachment(`${CONTAINER_GROUP_PREFIX}missing.jpg`, folder);
      expect.fail('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(AttachmentValidationError);
      expect((e as AttachmentValidationError).reason).toBe('not_found');
    }
  });

  it('rejects symlinks that escape the group folder', () => {
    const outside = path.join(testRoots.groupsDir, 'outside.txt');
    fs.writeFileSync(outside, 'secret');
    const linkPath = path.join(groupDir, 'escape.txt');
    fs.symlinkSync(outside, linkPath);

    try {
      validateAttachment(`${CONTAINER_GROUP_PREFIX}escape.txt`, folder);
      expect.fail('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(AttachmentValidationError);
      expect((e as AttachmentValidationError).reason).toBe('path_escape');
    }

    fs.unlinkSync(outside);
  });

  it('accepts symlinks that stay within the group folder', () => {
    write('inner/target.txt', 'ok');
    const linkPath = path.join(groupDir, 'alias.txt');
    fs.symlinkSync(path.join(groupDir, 'inner/target.txt'), linkPath);

    const result = validateAttachment(
      `${CONTAINER_GROUP_PREFIX}alias.txt`,
      folder,
    );
    expect(result.size).toBe(2);
  });

  it('rejects directories (not regular files)', () => {
    fs.mkdirSync(path.join(groupDir, 'subdir'));
    try {
      validateAttachment(`${CONTAINER_GROUP_PREFIX}subdir`, folder);
      expect.fail('expected throw');
    } catch (e) {
      expect((e as AttachmentValidationError).reason).toBe('not_regular_file');
    }
  });

  it('rejects files over MAX_ATTACHMENT_BYTES', () => {
    // Don't actually write 100MB; we mock statSync instead
    write('big.bin', 'x');
    const statSpy = vi.spyOn(fs, 'statSync');
    statSpy.mockReturnValueOnce({
      isFile: () => true,
      size: MAX_ATTACHMENT_BYTES + 1,
    } as unknown as fs.Stats);
    try {
      validateAttachment(`${CONTAINER_GROUP_PREFIX}big.bin`, folder);
      expect.fail('expected throw');
    } catch (e) {
      expect((e as AttachmentValidationError).reason).toBe('too_large');
    }
    statSpy.mockRestore();
  });
});
