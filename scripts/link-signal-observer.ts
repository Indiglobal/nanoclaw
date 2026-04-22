#!/usr/bin/env npx tsx
/**
 * Link the Signal observer as a secondary device on the user's Signal account.
 *
 * Usage: npx tsx scripts/link-signal-observer.ts
 *
 * Prints a `sgnl://linkdevice?...` URI. Open Signal on your phone →
 * Settings → Linked devices → Link new device, scan/paste the URI.
 */

import { execFileSync, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import qrcodeTerminal from 'qrcode-terminal';

import { readEnvFile } from '../src/env.js';

function main(): void {
  const env = readEnvFile(['SIGNAL_OBSERVER_DATA_DIR', 'SIGNAL_CLI_PATH']);
  const cliPath =
    process.env.SIGNAL_CLI_PATH || env.SIGNAL_CLI_PATH || 'signal-cli';
  const dataDir =
    process.env.SIGNAL_OBSERVER_DATA_DIR ||
    env.SIGNAL_OBSERVER_DATA_DIR ||
    path.join(os.homedir(), '.local', 'share', 'signal-cli-observer');

  try {
    execFileSync('which', [cliPath], { stdio: 'ignore' });
  } catch {
    console.error(
      `signal-cli not found at "${cliPath}". Install it or set SIGNAL_CLI_PATH.`,
    );
    process.exit(1);
  }

  fs.mkdirSync(dataDir, { recursive: true });

  console.log(`Linking Signal observer (data dir: ${dataDir})`);
  console.log(
    '\nThis prints a sgnl:// URI. On your phone: Signal → Settings → Linked devices → Link new device → scan QR (or tap the URI in an email to yourself).\n',
  );

  const child = spawn(
    cliPath,
    ['--config', dataDir, 'link', '-n', 'NanoClaw Observer'],
    { stdio: ['inherit', 'pipe', 'inherit'] },
  );

  let uriRendered = false;
  child.stdout.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    process.stdout.write(text);
    if (!uriRendered) {
      const match = text.match(/sgnl:\/\/linkdevice\?[^\s]+/);
      if (match) {
        uriRendered = true;
        console.log('\nScan this QR from your phone camera:');
        qrcodeTerminal.generate(match[0], { small: true });
        console.log('(If the QR is garbled, resize your terminal wider.)\n');
      }
    }
  });

  child.on('exit', (code) => {
    if (code === 0) {
      console.log(
        '\nLinked. Set SIGNAL_OBSERVER_ENABLED=true and SIGNAL_OBSERVER_ACCOUNT=<your number> in .env, then restart.',
      );
    } else {
      console.error(`signal-cli link exited with code ${code}`);
      process.exit(code ?? 1);
    }
  });
}

main();
