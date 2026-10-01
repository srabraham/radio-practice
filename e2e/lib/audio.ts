import { expect, type Page } from '@playwright/test';

// Frequencies the harness tracks (see BANDS in harness/page-audio.js).
export const HZ = {
  voice: 700, // the default synthetic mic
  voice2: 600, // a second talker, to tell two voices apart
  busyHi: 440,
  busyLo: 330,
  prompt: 880,
  tot: 1000, // TOT warning beep and the time-out / cut alarm
  permitLo: 1400,
  permitHi: 1900,
  hiss: 2200,
} as const;

// A band counts as "heard" when it is both loud and stands well clear of the
// voice-band median, so broadband hiss doesn't read as a tone.
const TONE_DB = -60;
const TONE_ABOVE_FLOOR = 20;
// Nothing is playing: the WaveShaper's DC offset aside, every band is far down.
const SILENT_DB = -120;

export type TapEntry = {
  t: number;
  state: string;
  rms: number;
  peakHz: number;
  peakDb: number;
  floor: number;
  bands: Record<string, number>;
};

export const now = (page: Page) => page.evaluate(() => (window as any).__tap.now() as number);

export function tapLog(page: Page, since = 0, until = Infinity): Promise<TapEntry[]> {
  return page.evaluate(
    ([since, until]) => (window as any).__tap.log.filter((e: TapEntry) => e.t >= since && e.t <= until),
    [since, until === Infinity ? Number.MAX_VALUE : until],
  );
}

const isTone = (e: TapEntry, hz: number) => e.bands[hz] > TONE_DB && e.bands[hz] - e.floor > TONE_ABOVE_FLOOR;

// When the page's output first carried hz after `since`, or null.
export async function firstTone(page: Page, hz: number, since = 0, until = Infinity) {
  const hit = (await tapLog(page, since, until)).find((e) => isTone(e, hz));
  return hit ? hit.t : null;
}

export async function lastTone(page: Page, hz: number, since = 0, until = Infinity) {
  const hits = (await tapLog(page, since, until)).filter((e) => isTone(e, hz));
  return hits.length ? hits[hits.length - 1].t : null;
}

export async function expectTone(page: Page, hz: number, { since = 0, timeout = 8000, message = '' } = {}) {
  await expect
    .poll(() => firstTone(page, hz, since), { timeout, message: message || `expected to hear ${hz} Hz` })
    .not.toBeNull();
}

export async function loudest(page: Page, hz: number, since = 0, until = Infinity) {
  const log = await tapLog(page, since, until);
  return log.reduce((m, e) => Math.max(m, e.bands[hz]), -Infinity);
}

// A buffer underrun on a loaded machine clicks, and a click splashes energy
// across every band for a sample or two. Real audio lasts far longer.
const GLITCH_SAMPLES = 2;

export async function expectNoTone(page: Page, hz: number, since: number, until = Infinity, message = '') {
  const log = await tapLog(page, since, until);
  expect(log.length, 'the audio tap should have sampled this window').toBeGreaterThan(0);
  expect(log.filter((e) => isTone(e, hz)).length, message || `expected no ${hz} Hz`).toBeLessThanOrEqual(GLITCH_SAMPLES);
}

export async function expectSilent(page: Page, since: number, until = Infinity, message = '') {
  const log = await tapLog(page, since, until);
  expect(log.length, 'the audio tap should have sampled this window').toBeGreaterThan(0);
  const loudest = log.reduce((m, e) => Math.max(m, e.floor, ...Object.values(e.bands)), -Infinity);
  expect(loudest, message || 'expected silence').toBeLessThan(SILENT_DB);
}

// How many 20 ms tap samples in the window carried hz.
export async function toneSamples(page: Page, hz: number, since: number, until = Infinity) {
  return (await tapLog(page, since, until)).filter((e) => isTone(e, hz)).length;
}

// Tap samples in the window that carry broadband noise (hiss, squelch tail)
// rather than silence or a clean tone.
export async function noiseSamples(page: Page, since: number, until = Infinity, aboveDb = -80) {
  return (await tapLog(page, since, until)).filter((e) => e.floor > aboveDb).length;
}

// Median voice-band level: rises with hiss and noise bursts.
export async function maxFloor(page: Page, since: number, until = Infinity) {
  return (await tapLog(page, since, until)).reduce((m, e) => Math.max(m, e.floor), -Infinity);
}

// ---- the wire: 8 kHz μ-law, 160-byte frames ----

const ULAW = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const u = ~i & 0xff;
  const exp = (u >> 4) & 7;
  const mag = ((((u & 0x0f) << 3) + 0x84) << exp) - 0x84;
  ULAW[i] = (u & 0x80 ? -mag : mag) / 32768;
}

export function decodeUlaw(bytes: Uint8Array): Float32Array {
  const out = new Float32Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = ULAW[bytes[i]];
  return out;
}

export function rmsDb(pcm: Float32Array): number {
  let s = 0;
  for (const v of pcm) s += v * v;
  return 10 * Math.log10(s / Math.max(1, pcm.length) + 1e-12);
}

// Share of the signal's energy at hz (Goertzel), 0..1.
export function toneShare(pcm: Float32Array, hz: number, rate = 8000): number {
  const w = (2 * Math.PI * hz) / rate;
  const c = 2 * Math.cos(w);
  let s1 = 0, s2 = 0, energy = 0;
  for (const x of pcm) {
    const s0 = x + c * s1 - s2;
    s2 = s1;
    s1 = s0;
    energy += x * x;
  }
  const power = s1 * s1 + s2 * s2 - c * s1 * s2;
  return energy > 0 ? (2 * power) / (pcm.length * energy) : 0;
}

export function concat(frames: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(frames.reduce((n, f) => n + f.length, 0));
  let o = 0;
  for (const f of frames) {
    out.set(f, o);
    o += f.length;
  }
  return out;
}
