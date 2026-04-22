import fs from 'fs';
import { execFileSync } from 'child_process';

import { logger } from '../logger.js';
import { OnChatMetadata, OnObservedMessage } from '../types.js';
import {
  DaemonHandle,
  JID_PREFIX,
  SignalDataMessage,
  SignalEnvelope,
  SseEvent,
  computeBackoff,
  signalCheck,
  sleep,
  spawnSignalDaemon,
  streamSse,
} from './signal.js';

export interface SignalObserverOptions {
  account: string;
  dataDir: string;
  host: string;
  port: number;
  cliPath?: string;
  onObservedMessage: OnObservedMessage;
  onChatMetadata?: OnChatMetadata;
}

/**
 * Read-only Signal observer. Runs a second signal-cli daemon linked as a
 * secondary device on the user's account. Captures every dataMessage and
 * syncMessage the user's primary device would see and emits them via
 * `onObservedMessage`. Never sends.
 */
export class SignalObserver {
  private opts: SignalObserverOptions;
  private baseUrl: string;
  private daemon: DaemonHandle | null = null;
  private abortCtrl: AbortController | null = null;
  private connected = false;

  constructor(opts: SignalObserverOptions) {
    this.opts = opts;
    this.baseUrl = `http://${opts.host}:${opts.port}`;
  }

  async connect(): Promise<void> {
    if (!this.opts.account) {
      logger.warn('SignalObserver: no account configured, skipping');
      return;
    }
    if (!fs.existsSync(this.opts.dataDir)) {
      fs.mkdirSync(this.opts.dataDir, { recursive: true });
    }

    const cliPath = this.opts.cliPath || 'signal-cli';
    try {
      execFileSync('which', [cliPath], { stdio: 'ignore' });
    } catch {
      logger.error(
        { cliPath },
        'SignalObserver: signal-cli not found on PATH, skipping',
      );
      return;
    }

    this.daemon = spawnSignalDaemon(
      cliPath,
      this.opts.account,
      this.opts.host,
      this.opts.port,
      this.opts.dataDir,
    );

    // Wait for daemon to come up
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (this.daemon.isExited()) {
        logger.error(
          'SignalObserver: daemon exited before HTTP was ready — is the observer account linked?',
        );
        return;
      }
      if (await signalCheck(this.baseUrl)) {
        this.connected = true;
        break;
      }
      await sleep(500);
    }
    if (!this.connected) {
      logger.error('SignalObserver: daemon HTTP did not come up within 30s');
      this.daemon.stop();
      this.daemon = null;
      return;
    }

    logger.info(
      { account: this.opts.account, port: this.opts.port },
      'SignalObserver: daemon ready, starting SSE stream',
    );

    this.abortCtrl = new AbortController();
    this.runSseLoop(this.abortCtrl.signal);
  }

  async disconnect(): Promise<void> {
    this.abortCtrl?.abort();
    this.abortCtrl = null;
    this.daemon?.stop();
    if (this.daemon) {
      await this.daemon.exited;
      this.daemon = null;
    }
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  private runSseLoop(abortSignal: AbortSignal): void {
    const loop = async () => {
      let attempts = 0;
      while (!abortSignal.aborted) {
        try {
          const url = `${this.baseUrl}/api/v1/events?account=${encodeURIComponent(this.opts.account)}`;
          await streamSse(
            url,
            (event) => {
              attempts = 0;
              this.handleSseEvent(event).catch((err) =>
                logger.error(
                  { err },
                  'SignalObserver: error handling SSE event',
                ),
              );
            },
            abortSignal,
          );
          if (abortSignal.aborted) return;
          attempts++;
          await sleep(computeBackoff(attempts));
        } catch (err) {
          if (abortSignal.aborted) return;
          attempts++;
          const delay = computeBackoff(attempts);
          logger.warn(
            { err, delay },
            'SignalObserver: SSE error, reconnecting',
          );
          await sleep(delay);
        }
      }
    };
    loop().catch((err) => {
      if (!abortSignal.aborted) {
        logger.error({ err }, 'SignalObserver: SSE loop fatal error');
      }
    });
  }

  private async handleSseEvent(event: SseEvent): Promise<void> {
    if (!event.data) return;
    let envelope: SignalEnvelope;
    try {
      const parsed = JSON.parse(event.data);
      envelope = parsed.envelope ?? parsed;
    } catch {
      return;
    }

    // syncMessage.sentMessage = messages the user sent from another device.
    // From the observer's perspective these are "user's own outbound" — capture
    // with is_from_me=true so the agent sees both sides of conversations.
    const syncSent = envelope.syncMessage?.sentMessage;
    if (syncSent) {
      this.emit(
        syncSent,
        this.opts.account, // user is the sender
        'Me',
        true,
        syncSent.destinationNumber ?? syncSent.destination,
      );
      return;
    }

    // dataMessage = inbound to the user.
    const dataMessage = envelope.dataMessage;
    if (!dataMessage) return;
    const sender = (envelope.sourceNumber ?? envelope.source ?? '').trim();
    if (!sender) return;
    const senderName = (envelope.sourceName ?? sender).trim();
    this.emit(dataMessage, sender, senderName, false);
  }

  private emit(
    dm: SignalDataMessage,
    sender: string,
    senderName: string,
    isFromMe: boolean,
    syncDestination?: string,
  ): void {
    const text = (dm.message ?? '').trim();
    // v1: text-only capture in observer path (no attachment download).
    if (!text) return;

    const groupInfo = dm.groupInfo;
    const isGroup = Boolean(groupInfo?.groupId);
    const groupId = groupInfo?.groupId;

    let chatJid: string;
    if (isGroup) {
      chatJid = `${JID_PREFIX}group:${groupId}`;
    } else if (isFromMe && syncDestination) {
      // Outbound DM — chat is keyed on the recipient, not the sender
      chatJid = `${JID_PREFIX}${syncDestination.trim()}`;
    } else {
      chatJid = `${JID_PREFIX}${sender}`;
    }

    const timestamp = dm.timestamp
      ? new Date(dm.timestamp).toISOString()
      : new Date().toISOString();

    const chatName =
      groupInfo?.groupName ??
      (isGroup ? `Group ${groupId?.slice(0, 8)}` : senderName);

    if (this.opts.onChatMetadata) {
      this.opts.onChatMetadata(chatJid, timestamp, chatName, 'signal', isGroup);
    }

    this.opts.onObservedMessage({
      id: String(dm.timestamp ?? Date.now()),
      chat_jid: chatJid,
      sender,
      sender_name: senderName,
      content: text,
      timestamp,
      is_from_me: isFromMe,
      channel: 'signal',
      is_group: isGroup,
      chat_name: chatName,
    });
  }
}
