import fs from 'fs';
import path from 'path';

import { resolveGroupFolderPath } from './group-folder.js';

// Signal's outgoing attachment size cap is 100 MB. WhatsApp is lower (16 MB) but
// we'll apply a per-channel check at the channel layer if that becomes a real
// need. For the shared host-side validator, 100 MB is the outer limit.
export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;

// Agent-facing base path inside the container. groups/{folder}/ is mounted here.
export const CONTAINER_GROUP_PREFIX = '/workspace/group/';

export type AttachmentReason =
  | 'path_escape'
  | 'not_found'
  | 'not_readable'
  | 'not_regular_file'
  | 'too_large';

export class AttachmentValidationError extends Error {
  constructor(
    public readonly reason: AttachmentReason,
    public readonly containerPath: string,
    detail: string,
  ) {
    super(detail);
    this.name = 'AttachmentValidationError';
  }
}

export interface ValidatedAttachment {
  containerPath: string;
  hostPath: string;
  size: number;
}

/**
 * Resolve a container-visible attachment path to a safe host path.
 *
 * Rejects anything not under /workspace/group/, symlinks that escape the
 * group folder, non-regular files, and oversize payloads. Throws an
 * AttachmentValidationError with a structured reason that the IPC layer
 * forwards to the agent.
 */
export function validateAttachment(
  containerPath: string,
  groupFolder: string,
): ValidatedAttachment {
  if (typeof containerPath !== 'string' || containerPath.length === 0) {
    throw new AttachmentValidationError(
      'path_escape',
      containerPath,
      'Attachment path is empty',
    );
  }
  if (!containerPath.startsWith(CONTAINER_GROUP_PREFIX)) {
    throw new AttachmentValidationError(
      'path_escape',
      containerPath,
      `Attachment path must begin with ${CONTAINER_GROUP_PREFIX}`,
    );
  }

  const relative = containerPath.slice(CONTAINER_GROUP_PREFIX.length);
  if (relative.length === 0) {
    throw new AttachmentValidationError(
      'not_regular_file',
      containerPath,
      'Attachment path refers to the group folder itself, not a file',
    );
  }

  const groupRoot = resolveGroupFolderPath(groupFolder);
  // resolveGroupFolderPath already normalizes; join + resolve again so relative
  // path segments (. / ..) fold correctly before the real-path check.
  const candidateHostPath = path.resolve(groupRoot, relative);

  let realHostPath: string;
  try {
    realHostPath = fs.realpathSync(candidateHostPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new AttachmentValidationError(
        'not_found',
        containerPath,
        `File not found: ${containerPath}`,
      );
    }
    if (code === 'EACCES' || code === 'EPERM') {
      throw new AttachmentValidationError(
        'not_readable',
        containerPath,
        `File not readable: ${containerPath}`,
      );
    }
    throw err;
  }

  // Real-path must still be inside the group folder. This catches symlinks the
  // agent may have placed pointing outside its sandbox.
  const realGroupRoot = fs.realpathSync(groupRoot);
  const rel = path.relative(realGroupRoot, realHostPath);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new AttachmentValidationError(
      'path_escape',
      containerPath,
      `Resolved path escapes group folder: ${realHostPath}`,
    );
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(realHostPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new AttachmentValidationError(
        'not_found',
        containerPath,
        `File not found after realpath: ${realHostPath}`,
      );
    }
    throw err;
  }

  if (!stat.isFile()) {
    throw new AttachmentValidationError(
      'not_regular_file',
      containerPath,
      `Not a regular file: ${containerPath}`,
    );
  }
  if (stat.size > MAX_ATTACHMENT_BYTES) {
    throw new AttachmentValidationError(
      'too_large',
      containerPath,
      `File is ${stat.size} bytes; limit is ${MAX_ATTACHMENT_BYTES}`,
    );
  }

  return { containerPath, hostPath: realHostPath, size: stat.size };
}
