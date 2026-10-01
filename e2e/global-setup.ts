import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(here, '..');
export const BIN_DIR = path.join(here, '.bin');
export const SERVER_BIN = path.join(BIN_DIR, process.platform === 'win32' ? 'radio.exe' : 'radio');
// Chromium's fake capture device plays this instead of its default beeps.
export const TONE_WAV = path.join(BIN_DIR, 'tone-700.wav');
export const TONE_WAV_HZ = 700;

export default function globalSetup() {
  mkdirSync(BIN_DIR, { recursive: true });
  execFileSync('go', ['build', '-o', SERVER_BIN, '.'], { cwd: REPO, stdio: 'inherit' });
  writeFileSync(TONE_WAV, sineWav(TONE_WAV_HZ, 10, 48000));
}

// 16-bit mono PCM; Chromium loops it.
function sineWav(hz: number, secs: number, rate: number): Buffer {
  const n = secs * rate;
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + n * 2, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    b.writeInt16LE(Math.round(0.5 * 32767 * Math.sin((2 * Math.PI * hz * i) / rate)), 44 + i * 2);
  }
  return b;
}
