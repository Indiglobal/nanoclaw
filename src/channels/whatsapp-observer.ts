import fs from 'fs';

import {
  makeWASocket,
  Browsers,
  DisconnectReason,
  fetchLatestWaWebVersion,
  makeCacheableSignalKeyStore,
  normalizeMessageContent,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import type { WASocket } from '@whiskeysockets/baileys';
import pino from 'pino';

import { logger } from '../logger.js';
import { OnChatMetadata, OnObservedMessage } from '../types.js';

const baileysLogger = pino({ level: 'silent' });

export interface WhatsAppObserverOptions {
  authDir: string;
  onObservedMessage: OnObservedMessage;
  onChatMetadata?: OnChatMetadata;
}

/**
 * Read-only WhatsApp observer. Runs a Baileys socket against its own auth
 * directory — paired (via QR) as a secondary device on the user's account.
 * Captures every inbound and outbound (fromMe via linked-device) message and
 * emits `onObservedMessage`. Never sends.
 */
export class WhatsAppObserver {
  private opts: WhatsAppObserverOptions;
  private sock: WASocket | null = null;
  private connected = false;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(opts: WhatsAppObserverOptions) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    fs.mkdirSync(this.opts.authDir, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(this.opts.authDir);

    if (!state.creds.registered) {
      logger.warn(
        { authDir: this.opts.authDir },
        'WhatsAppObserver: auth dir not registered. Run `npm run link-wa-observer` to pair.',
      );
      return;
    }

    const { version } = await fetchLatestWaWebVersion({}).catch(() => ({
      version: undefined,
    }));

    this.sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
      },
      printQRInTerminal: false,
      logger: baileysLogger,
      browser: Browsers.macOS('NanoClaw Observer'),
    });

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect } = update;
      if (connection === 'open') {
        this.connected = true;
        logger.info('WhatsAppObserver: connected');
      } else if (connection === 'close') {
        this.connected = false;
        const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        logger.warn(
          { statusCode, shouldReconnect },
          'WhatsAppObserver: disconnected',
        );
        if (shouldReconnect) {
          this.scheduleReconnect();
        }
      }
    });

    this.sock.ev.on('messages.upsert', async ({ messages }) => {
      for (const msg of messages) {
        try {
          if (!msg.message) continue;
          const normalized = normalizeMessageContent(msg.message);
          if (!normalized) continue;

          const chatJid = msg.key.remoteJid;
          if (!chatJid || chatJid === 'status@broadcast') continue;

          const content =
            normalized.conversation ||
            normalized.extendedTextMessage?.text ||
            normalized.imageMessage?.caption ||
            normalized.videoMessage?.caption ||
            '';
          if (!content) continue;

          const timestamp = new Date(
            Number(msg.messageTimestamp) * 1000,
          ).toISOString();
          const isGroup = chatJid.endsWith('@g.us');
          const sender = msg.key.participant || msg.key.remoteJid || '';
          const senderName = msg.pushName || sender.split('@')[0];
          const isFromMe = msg.key.fromMe || false;

          const chatName = isGroup ? undefined : senderName;
          if (this.opts.onChatMetadata) {
            this.opts.onChatMetadata(
              chatJid,
              timestamp,
              chatName,
              'whatsapp',
              isGroup,
            );
          }

          this.opts.onObservedMessage({
            id: msg.key.id || `${Date.now()}`,
            chat_jid: chatJid,
            sender,
            sender_name: senderName,
            content,
            timestamp,
            is_from_me: isFromMe,
            channel: 'whatsapp',
            is_group: isGroup,
            chat_name: chatName,
          });
        } catch (err) {
          logger.error(
            { err, jid: msg.key?.remoteJid },
            'WhatsAppObserver: error processing message',
          );
        }
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch((err) =>
        logger.error({ err }, 'WhatsAppObserver: reconnect failed'),
      );
    }, 5000);
  }

  async disconnect(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.sock) {
      try {
        this.sock.end(undefined);
      } catch {
        // ignore
      }
      this.sock = null;
    }
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }
}
