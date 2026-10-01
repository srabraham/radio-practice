import { defineConfig, devices, type Project } from '@playwright/test';
import { TONE_WAV } from './global-setup';

// Each browser's own fake capture device, for native-mic.spec.ts. Most specs
// replace getUserMedia with a synthetic mic (harness/page-audio.js) instead,
// so these only matter where the real getUserMedia runs.
const chromiumMic = {
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${TONE_WAV}`,
  ],
};
const firefoxMic = {
  firefoxUserPrefs: {
    'media.navigator.streams.fake': true,
    'media.navigator.permission.disabled': true,
  },
};

// Branded browsers use the copy installed on this machine, e.g.
// E2E_BRANDED=chrome,msedge npm test
const branded: Project[] = (process.env.E2E_BRANDED || '')
  .split(',')
  .filter(Boolean)
  .map((channel) => ({
    name: channel,
    use: { ...devices['Desktop Chrome'], channel, launchOptions: chromiumMic },
  }));

export default defineConfig({
  testDir: './tests',
  globalSetup: './global-setup.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // Audio timing is real time; a starved CI box can miss a 50 ms chirp.
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : 4,
  timeout: 45_000,
  expect: { timeout: 8_000 },
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list'], ['html', { open: 'never' }]],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], launchOptions: chromiumMic } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'], launchOptions: firefoxMic } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    { name: 'mobile-chrome', use: { ...devices['Pixel 7'], launchOptions: chromiumMic } },
    { name: 'mobile-safari', use: { ...devices['iPhone 15'] } },
    { name: 'tablet-safari', use: { ...devices['iPad (gen 11)'] } },
    ...branded,
  ],
});
