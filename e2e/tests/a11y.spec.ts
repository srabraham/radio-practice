import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { test, expect, CH, Radio, Console, PARTICIPANT_PW } from '../lib/fixtures';

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function expectNoAxeViolations(page: Page) {
  const { violations } = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  const found = violations.flatMap((v) => v.nodes.map((n) => `${v.id} ${n.target.join(' ')} (${v.impact}): ${v.help}`));
  expect(found, 'axe violations').toEqual([]);
}

// Logs in on the test's own page, so test.use({ colorScheme }) applies.
async function powerOn(page: Page, callsign: string) {
  const r = new Radio(page, callsign);
  await r.powerOn();
  return r;
}

async function openConsole(page: Page, callsign: string) {
  const c = new Console(page, callsign);
  await c.open();
  return c;
}

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`axe, ${scheme} mode`, () => {
    test.use({ colorScheme: scheme });

    test('radio login', async ({ page }) => {
      await page.goto('/');
      await expect(page.getByRole('button', { name: 'Power on' })).toBeVisible();
      await expectNoAxeViolations(page);
    });

    test('radio login with an error', async ({ page }) => {
      await page.goto('/');
      await page.getByLabel('Callsign').fill('BADPW');
      await page.getByLabel('Password').fill('wrong');
      await page.getByRole('button', { name: 'Power on' }).click();
      await expect(page.locator('#login-error')).not.toBeEmpty();
      await expectNoAxeViolations(page);
    });

    test('radio, idle', async ({ page }) => {
      await powerOn(page, `AX${scheme}1`);
      await expectNoAxeViolations(page);
    });

    test('radio, transmitting, with a prompt and both warnings showing', async ({ page, openConsole: openCtl }) => {
      await page.goto('/');
      await page.evaluate(() => (window as any).__mic.set({ fail: 'NotAllowedError' }));
      const r = new Radio(page, `AX${scheme}2`);
      await page.getByLabel('Callsign').fill(r.callsign);
      await page.getByLabel('Password').fill(PARTICIPANT_PW);
      await page.getByRole('button', { name: 'Power on' }).click();
      await r.waitOnline();
      await expect(page.locator('#mic-warn')).toBeVisible();
      const ctl = await openCtl();
      await ctl.page.locator('#prompt-text').fill('Radio check, please.');
      await ctl.page.getByRole('button', { name: 'Send prompt' }).click();
      await expect(page.locator('#prompts .prompt')).toBeVisible();
      await page.getByLabel('Tap to talk / tap to stop').check();
      await r.ptt.click();
      await expect(r.status).toHaveText(/^TX/);
      await page.evaluate(() => (window as any).__tap.ctx().suspend());
      await expect(page.locator('#spk-warn')).toBeVisible();
      await expectNoAxeViolations(page);
    });

    test('console with radios on the air', async ({ page, openRadio }) => {
      await openConsole(page, `AXC${scheme}`);
      const a = await openRadio({ ch: CH.tac1 });
      await openRadio({ ch: CH.control1 });
      await a.page.getByLabel('Tap to talk / tap to stop').check();
      await a.ptt.click();
      await expect(page.locator('#roster')).toContainText(a.callsign);
      await expect(page.locator('#ch-act-5')).toContainText(a.callsign);
      await expectNoAxeViolations(page);
    });
  });
}

test.describe('keyboard only', () => {
  test('power on and talk without a pointer', async ({ page, openRadio }) => {
    const rx = await openRadio({ ch: CH.control1 });
    await page.goto('/');
    await page.keyboard.press('Tab');
    await expect(page.getByLabel('Callsign')).toBeFocused();
    await page.keyboard.type('KBONLY');
    await page.keyboard.press('Tab');
    await expect(page.getByLabel('Password')).toBeFocused();
    await page.keyboard.type(PARTICIPANT_PW);
    await page.keyboard.press('Enter');
    const r = new Radio(page, 'KBONLY');
    await r.waitOnline();
    // Enter is a user gesture, so sound and the mic start.
    await expect.poll(() => r.audioState()).toBe('running');

    await page.keyboard.down('Space');
    await expect(r.status).toHaveText(/^TX/);
    await expect(rx.status).toHaveText('RX KBONLY');
    await page.keyboard.up('Space');
    await expect(r.status).toHaveText('READY');
  });

  test('every radio control is reachable with Tab, with a visible focus ring', async ({ page, browserName }) => {
    // Safari's Tab skips buttons and links unless the user turns on "Press Tab
    // to highlight each item"; Option-Tab is how its keyboard users get there.
    const tab = browserName === 'webkit' ? 'Alt+Tab' : 'Tab';
    await powerOn(page, 'KBTAB');
    const want = ['Channel down', 'Channel up', 'SCAN', 'PUSH TO TALK', 'Volume', 'Microphone', 'Tap to talk / tap to stop', 'Log out'];
    const seen: string[] = [];
    await page.locator('body').focus();
    for (let i = 0; i < 25; i++) {
      await page.keyboard.press(tab);
      const info = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement;
        if (!el || el === document.body) return { name: '', ring: false };
        const cs = getComputedStyle(el);
        // The label's own words, without the text of the control inside it.
        const label = el.closest('label');
        const labelText = label ? [...label.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent).join('').trim() : '';
        return {
          name: el.getAttribute('aria-label') || labelText || el.textContent?.trim() || '',
          ring: (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || cs.boxShadow !== 'none',
        };
      });
      if (!info.name) continue;
      expect(info.ring, `focus ring on "${info.name}"`).toBe(true);
      seen.push(info.name);
    }
    for (const name of want) expect(seen, `Tab reaches "${name}"`).toContain(name);
  });

  test('tap to talk works from the keyboard too', async ({ page }) => {
    // Latch mode is for people who can't hold a button down.
    const r = await powerOn(page, 'KBLATCH');
    await page.getByLabel('Tap to talk / tap to stop').check();
    await r.ptt.focus();
    await page.keyboard.press('Enter');
    await expect(r.status).toHaveText(/^TX/);
    await page.waitForTimeout(300);
    await expect(r.status).toHaveText(/^TX/);
    await page.keyboard.press('Enter');
    await expect(r.status).toHaveText('READY');

    await page.locator('body').focus();
    await page.keyboard.press('Space');
    await expect(r.status).toHaveText(/^TX/);
    await page.waitForTimeout(300);
    await expect(r.status).toHaveText(/^TX/);
    await page.keyboard.press('Space');
    await expect(r.status).toHaveText('READY');
  });

  test('Enter on the PTT button is momentary when not latched', async ({ page }) => {
    const r = await powerOn(page, 'KBENTER');
    await r.ptt.focus();
    await page.keyboard.down('Enter');
    await expect(r.status).toHaveText(/^TX/);
    await page.keyboard.up('Enter');
    await expect(r.status).toHaveText('READY');
  });
});

test.describe('screen readers', () => {
  test('controls have accessible names', async ({ page }) => {
    await powerOn(page, 'SRNAMES');
    await expect(page.getByRole('button', { name: 'Channel down' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Channel up' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'PUSH TO TALK' })).toBeVisible();
    await expect(page.getByRole('slider', { name: 'Volume' })).toBeVisible();
    await expect(page.getByRole('combobox', { name: /^Microphone/ })).toBeVisible();
    await expect(page.getByRole('checkbox', { name: 'Tap to talk / tap to stop' })).toBeVisible();
  });

  test('prompts from Control are announced', async ({ page, openConsole: openCtl }) => {
    await powerOn(page, 'SRPROMPT');
    await expect(page.locator('#prompts')).toHaveAttribute('aria-live', 'polite');
    const ctl = await openCtl();
    await ctl.page.locator('#prompt-text').fill('Switch to TAC 1.');
    await ctl.page.getByRole('button', { name: 'Send prompt' }).click();
    await expect(page.locator('#prompts')).toContainText('Switch to TAC 1.');
  });

  // The status line is the visual equivalent of the alert tones, and the only
  // cue a deaf or hard-of-hearing user gets, so it must reach a screen reader.
  test('busy, transmitting and receiving are announced', async ({ page, openRadio }) => {
    const r = await powerOn(page, 'SRSTATUS');
    const holder = await openRadio({ ch: CH.control1 });
    await holder.hold();
    await holder.wire.waitFor('tx_ok');
    await expect(page.locator('#status-live')).toHaveText(`RX ${holder.callsign}`);

    await page.keyboard.down('Space');
    await expect(page.getByRole('status').filter({ hasText: 'CHANNEL BUSY' })).toBeAttached();
    await page.keyboard.up('Space');
    await holder.release();
    await expect(page.locator('#status-live')).toHaveText('READY');

    await page.keyboard.down('Space');
    await expect(r.status).toHaveText(/^TX 0:0\d$/);
    // The visible timer ticks; the announcement doesn't.
    await expect(page.locator('#status-live')).toHaveText(/^(TX…|Transmitting)$/);
    await page.waitForTimeout(1200);
    await expect(page.locator('#status-live')).toHaveText('Transmitting');
    await page.keyboard.up('Space');
  });

  test('being cut by Control is announced', async ({ openRadio, openConsole: openCtl }) => {
    const r = await openRadio({ ch: CH.tac1 });
    const ctl = await openCtl();
    await r.page.getByLabel('Tap to talk / tap to stop').check();
    await r.ptt.click();
    await expect(r.status).toHaveText(/^TX/);
    await ctl.page.locator('#roster tr', { hasText: r.callsign }).getByRole('button', { name: 'Cut' }).click();
    await expect(r.page.getByRole('status').filter({ hasText: 'CUT BY CONTROL' })).toBeAttached();
  });

  test('transmitting and scanning are exposed as pressed states', async ({ page }) => {
    const r = await powerOn(page, 'SRPRESS');
    const ptt = page.getByRole('button', { name: 'PUSH TO TALK' });
    const scan = page.getByRole('button', { name: 'SCAN' });
    await expect(ptt).toHaveAttribute('aria-pressed', 'false');
    await expect(scan).toHaveAttribute('aria-pressed', 'false');
    await page.getByLabel('Tap to talk / tap to stop').check();
    await r.ptt.click();
    await expect(r.status).toHaveText(/^TX/);
    await expect(ptt).toHaveAttribute('aria-pressed', 'true');
    await r.ptt.click();
    await expect(ptt).toHaveAttribute('aria-pressed', 'false');
    await scan.click();
    await expect(scan).toHaveAttribute('aria-pressed', 'true');
  });

  test('the console PTT exposes its pressed state', async ({ openConsole: openCtl }) => {
    const ctl = await openCtl();
    await ctl.page.getByLabel('Tap to talk / tap to stop').check();
    await ctl.ptt.click();
    await expect(ctl.txStatus).toHaveText('Transmitting');
    await expect(ctl.ptt).toHaveAttribute('aria-pressed', 'true');
    await expect(ctl.page.getByRole('status').filter({ hasText: 'Transmitting' })).toBeAttached();
    await ctl.ptt.click();
    await expect(ctl.ptt).toHaveAttribute('aria-pressed', 'false');
  });

  test('mic and sound warnings are announced when they appear', async ({ openRadio }) => {
    const r = await openRadio({ mic: { fail: 'NotAllowedError' } });
    await expect(r.page.getByRole('status').filter({ hasText: 'Microphone access is blocked' })).toBeAttached();
    await r.page.evaluate(() => (window as any).__tap.ctx().suspend());
    await expect(r.page.getByRole('status').filter({ hasText: 'Sound is blocked by the browser.' })).toBeAttached();
  });

  test('the mic level meter has an accessible value', async ({ page }) => {
    const r = await powerOn(page, 'SRMETER');
    const meter = page.getByRole('meter', { name: 'Mic level' });
    await expect(meter).toBeVisible();
    await expect.poll(async () => Number(await meter.getAttribute('aria-valuenow'))).toBeGreaterThan(-20);
    await r.mic({ level: 0.0005 });
    await expect.poll(async () => Number(await meter.getAttribute('aria-valuenow'))).toBeLessThan(-55);
    await expect(meter).toHaveAttribute('aria-valuetext', /^-\d+ dB$/);
  });
});

test.describe('small screens', () => {
  test('the radio reflows at 320 px wide without sideways scrolling', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await powerOn(page, 'NARROW');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await expect(page.getByRole('button', { name: 'PUSH TO TALK' })).toBeInViewport();
  });
});
