import { test as base, expect, type Browser, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import { REPO, SERVER_BIN } from '../global-setup';

export { expect };

export const PARTICIPANT_PW = 'practice';
export const INSTRUCTOR_PW = 'control';

// Indexes into defaultChannels() in channels.go.
export const CH = {
  brc911alt: 0, // FM simplex
  brc911: 1, // digital repeater
  rangerAdmin: 2,
  control1: 3, // the default channel
  tac1: 5, // FM simplex
  tac2: 6,
} as const;

const HARNESS = readFileSync(new URL('../harness/page-audio.js', import.meta.url), 'utf8');

export type MicOptions = {
  // false: leave the browser's real getUserMedia in place.
  fake?: boolean;
  freq?: number;
  level?: number;
  // A DOMException name getUserMedia rejects with, e.g. 'NotAllowedError'.
  fail?: string;
};

export type UserOptions = {
  callsign?: string;
  mic?: MicOptions;
  // Saved knob positions, as if this browser had used the radio before.
  ch?: number;
  scan?: boolean;
  grantMic?: boolean;
};

// n numbers frames in the order Playwright reported them. WebKit can report a
// binary frame a little after a text frame the server sent later, so treat it
// as approximate.
type Frame = { at: number; n: number; payload: Uint8Array };
type Json = { at: number; n: number; msg: any };

// Everything the page sent and received over its WebSocket.
export class Wire {
  sentAudio: Frame[] = [];
  rxAudio: (Frame & { ch: number; sid: number })[] = [];
  sentJson: Json[] = [];
  rxJson: Json[] = [];

  private n = 0;

  constructor(page: Page) {
    page.on('websocket', (ws) => {
      ws.on('framesent', ({ payload }) => {
        const at = Date.now(), n = this.n++;
        if (typeof payload === 'string') this.sentJson.push({ at, n, msg: JSON.parse(payload) });
        else this.sentAudio.push({ at, n, payload: new Uint8Array(payload.subarray(2)) });
      });
      ws.on('framereceived', ({ payload }) => {
        const at = Date.now(), n = this.n++;
        if (typeof payload === 'string') this.rxJson.push({ at, n, msg: JSON.parse(payload) });
        else this.rxAudio.push({ at, n, ch: payload[0], sid: (payload[1] << 8) | payload[2], payload: new Uint8Array(payload.subarray(5)) });
      });
    });
  }

  // The first received message of type t, with its arrival order.
  firstReceived(t: string) {
    return this.rxJson.find((j) => j.msg.t === t);
  }

  received(t: string) {
    return this.rxJson.filter((j) => j.msg.t === t).map((j) => j.msg);
  }

  async waitFor(t: string, match: (m: any) => boolean = () => true, { timeout }: { timeout?: number } = {}) {
    await expect.poll(() => this.received(t).some(match), { message: `waiting for "${t}" from the server`, timeout }).toBe(true);
    return this.received(t).find(match);
  }

  audioSentSince(at: number) {
    return this.sentAudio.filter((f) => f.at >= at).map((f) => f.payload);
  }

  audioReceivedSince(at: number) {
    return this.rxAudio.filter((f) => f.at >= at);
  }
}

abstract class User {
  readonly wire: Wire;
  constructor(readonly page: Page, readonly callsign: string) {
    this.wire = new Wire(page);
  }

  get ptt() { return this.page.locator('#ptt'); }

  private heldWith: 'mouse' | 'key' | null = null;

  // Press and hold with a real mouse, so pointerdown/pointerup and pointer
  // capture behave as they would for a person. Firefox shares one mouse
  // across every page in the browser, so while another page holds the button
  // down, pass via: 'key' (the space bar) instead.
  async hold({ via = 'mouse' }: { via?: 'mouse' | 'key' } = {}) {
    this.heldWith = via;
    if (via === 'key') {
      await this.page.locator('body').focus();
      await this.page.keyboard.down('Space');
      return;
    }
    const box = await this.ptt.boundingBox();
    if (!box) throw new Error('PTT button is not visible');
    await this.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await this.page.mouse.down();
  }

  async release() {
    if (this.heldWith === 'key') await this.page.keyboard.up('Space');
    else await this.page.mouse.up();
    this.heldWith = null;
  }

  async talk(ms: number) {
    await this.hold();
    await this.page.waitForTimeout(ms);
    await this.release();
  }

  mic(set: { freq?: number; level?: number; fail?: string | null }) {
    return this.page.evaluate((s) => (window as any).__mic.set(s), set);
  }

  audioState() {
    return this.page.evaluate(() => (window as any).__tap.state() as string);
  }
}

export class Radio extends User {
  get status() { return this.page.locator('#status'); }
  get chnum() { return this.page.locator('#chnum'); }
  get chname() { return this.page.locator('#chname'); }

  async powerOn(password = PARTICIPANT_PW) {
    await this.page.goto('/');
    await this.page.getByLabel('Callsign').fill(this.callsign);
    await this.page.getByLabel('Password').fill(password);
    await this.page.getByRole('button', { name: 'Power on' }).click();
    await this.waitOnline();
  }

  async waitOnline() {
    await expect(this.page.locator('#radio')).toBeVisible();
    await expect(this.page.locator('#net')).toHaveText('online');
    await expect(this.chname).not.toHaveText('—');
    // The tune/scan that restores our knobs is sent right after hello.
    await this.wire.waitFor('hello');
  }

  async waitReady() {
    await expect(this.status).toHaveText(/READY|SCANNING/);
  }
}

export class Console extends User {
  get txStatus() { return this.page.locator('#tx-status'); }
  get hearing() { return this.page.locator('#hearing'); }

  async open(password = INSTRUCTOR_PW) {
    await this.page.goto('/');
    await this.page.getByLabel('Callsign').fill(this.callsign);
    await this.page.getByLabel('Password').fill(password);
    await this.page.getByRole('button', { name: 'Power on' }).click();
    await expect(this.page.locator('#console')).toBeVisible();
    await expect(this.page.locator('#net')).toHaveText('online');
    await this.wire.waitFor('hello');
    await this.wire.waitFor('state');
  }

  async transmitOn(value: string) {
    await this.page.locator('#tx-ch').selectOption(value);
  }
}

type Server = { url: string; log: () => string };

type WorkerFixtures = {
  server: Server;
  // The server's -tot flag. test.use({ tot: '8s' }) gets a separate server.
  tot: string;
};

type TestFixtures = {
  newUser: (opts?: UserOptions) => Promise<Page>;
  openRadio: (opts?: UserOptions) => Promise<Radio>;
  openConsole: (opts?: UserOptions) => Promise<Console>;
};

let seq = 0;
const uniqueCallsign = (prefix: string) => `${prefix}${process.pid % 1000}${++seq}`;

export async function addHarness(ctx: BrowserContext, opts: UserOptions = {}) {
  const mic = opts.mic ?? {};
  const cfg = { fakeMic: mic.fake !== false, micFreq: mic.freq, micLevel: mic.level, micFail: mic.fail };
  await ctx.addInitScript({ content: `window.__E2E_AUDIO = ${JSON.stringify(cfg)};\n${HARNESS}` });
  if (opts.ch !== undefined || opts.scan !== undefined) {
    // Only on the first load, so a test can still check what the app saves.
    await ctx.addInitScript(([ch, scan]) => {
      if (sessionStorage.getItem('e2e.seeded')) return;
      sessionStorage.setItem('e2e.seeded', '1');
      if (ch !== null) localStorage.setItem('rp.ch', String(ch));
      if (scan !== null) localStorage.setItem('rp.scan', scan ? '1' : '0');
    }, [opts.ch ?? null, opts.scan ?? null] as const);
  }
}

// Firefox has no microphone permission to grant; its prefs (in the config) allow it.
export async function grantMic(ctx: BrowserContext, browserName: string, origin: string) {
  if (browserName === 'firefox') return;
  await ctx.grantPermissions(['microphone'], { origin });
}

// A fresh context with this project's device emulation (viewport, touch,
// user agent), as if a different person opened the app on their own device.
async function newContext(browser: Browser, testInfo: TestInfo, baseURL: string) {
  const u = testInfo.project.use;
  return browser.newContext({
    baseURL,
    viewport: u.viewport,
    userAgent: u.userAgent,
    deviceScaleFactor: u.deviceScaleFactor,
    isMobile: u.isMobile,
    hasTouch: u.hasTouch,
    colorScheme: u.colorScheme,
  });
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  tot: ['60s', { scope: 'worker', option: true }],

  // One server per worker: tests share channels, and a test must never hear
  // another test's traffic.
  server: [
    async ({ tot }, use) => {
      const port = await freePort();
      let out = '';
      const proc: ChildProcess = spawn(SERVER_BIN, ['-dev', '-addr', `127.0.0.1:${port}`, '-tot', tot], {
        cwd: REPO,
        env: { ...process.env, RADIO_PASSWORD: PARTICIPANT_PW, RADIO_INSTRUCTOR_PASSWORD: INSTRUCTOR_PW },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      proc.stdout!.on('data', (d) => (out += d));
      proc.stderr!.on('data', (d) => (out += d));
      const url = `http://127.0.0.1:${port}`;
      await waitForHttp(url, () => out);
      await use({ url, log: () => out });
      proc.kill();
    },
    { scope: 'worker' },
  ],

  baseURL: async ({ server }, use) => use(server.url),

  // The default page also gets the harness, for single-page tests.
  context: async ({ context, browserName, server }, use) => {
    await addHarness(context);
    await grantMic(context, browserName, server.url);
    await use(context);
  },

  newUser: async ({ browser, browserName, server }, use, testInfo) => {
    const contexts: BrowserContext[] = [];
    await use(async (opts = {}) => {
      const ctx = await newContext(browser, testInfo, server.url);
      contexts.push(ctx);
      await addHarness(ctx, opts);
      if (opts.grantMic !== false) await grantMic(ctx, browserName, server.url);
      return ctx.newPage();
    });
    await Promise.all(contexts.map((c) => c.close()));
  },

  openRadio: async ({ newUser }, use) => {
    await use(async (opts = {}) => {
      const r = new Radio(await newUser(opts), opts.callsign ?? uniqueCallsign('R'));
      await r.powerOn();
      return r;
    });
  },

  openConsole: async ({ newUser }, use) => {
    await use(async (opts = {}) => {
      const c = new Console(await newUser(opts), opts.callsign ?? uniqueCallsign('CTL'));
      await c.open();
      return c;
    });
  },
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

async function waitForHttp(url: string, log: () => string) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url + '/api/me');
      if (r.status === 401 || r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not start:\n${log()}`);
}
