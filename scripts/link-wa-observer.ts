#!/usr/bin/env npx tsx
/**
 * Link the WhatsApp observer as a secondary device on the user's WhatsApp.
 *
 * Usage: npx tsx scripts/link-wa-observer.ts
 *
 * Prints a QR code (terminal). On your phone: WhatsApp → Settings →
 * Linked devices → Link a device → scan.
 */

import fs from 'fs';
import path from 'path';

import {
  makeWASocket,
  Browsers,
  DisconnectReason,
  fetchLatestWaWebVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import pino from 'pino';

import { readEnvFile } from '../src/env.js';

async function main(): Promise<void> {
  const env = readEnvFile(['WHATSAPP_OBSERVER_AUTH_DIR']);
  const authDir =
    process.env.WHATSAPP_OBSERVER_AUTH_DIR ||
    env.WHATSAPP_OBSERVER_AUTH_DIR ||
    path.resolve(process.cwd(), 'store', 'observer-wa-auth');

  fs.mkdirSync(authDir, { recursive: true });
  console.log(`Pairing WhatsApp observer (auth dir: ${authDir})`);

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  if (state.creds.registered) {
    console.log(
      'Already paired. Delete the auth dir first if you want to re-link.',
    );
    process.exit(0);
  }

  const { version } = await fetchLatestWaWebVersion({}).catch(() => ({
    version: undefined,
  }));
  const silent = pino({ level: 'silent' });
  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, silent),
    },
    printQRInTerminal: false,
    logger: silent,
    browser: Browsers.macOS('NanoClaw Observer'),
  });

  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', (update) => {
    const { connection, qr, lastDisconnect } = update;
    if (qr) {
      console.log(
        '\nScan this QR in WhatsApp → Settings → Linked devices → Link a device:\n',
      );
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'open') {
      console.log(
        '\nPaired. Set WHATSAPP_OBSERVER_ENABLED=true in .env, then restart.',
      );
      setTimeout(() => process.exit(0), 1000);
    }
    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
      if (statusCode === DisconnectReason.loggedOut) {
        console.error('Logged out during pairing.');
        process.exit(1);
      }
    }
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
