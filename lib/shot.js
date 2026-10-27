/**
 * Screenshot helper: one call, one PNG on disk, the path back.
 *
 * Two traps this exists to avoid:
 * 1. `--window-size=390,844` only resizes the window. The layout still uses the
 *    desktop viewport (~980px), so the shot shows a cropped desktop page and reads
 *    as "the layout overflows" — a false bug report that costs a rework round.
 *    Device emulation is the only honest mobile shot.
 * 2. Without a virtual clock, the capture lands mid fade-in and the page looks
 *    half-transparent. Reduced-motion emulation + a settle delay fixes it.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { CdpSession } from './cdp.js';

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '%LOCALAPPDATA%\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function findBrowser() {
  for (const candidate of CHROME_CANDIDATES) {
    const exe = candidate.replace(/%([^%]+)%/g, (_, name) => process.env[name] || '');
    if (fs.existsSync(exe)) return exe;
  }
  return '';
}

async function targets(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return undefined;
    return await response.json();
  } catch {
    return undefined;
  }
}

/**
 * @param {{target: string, out: string, width?: number, height?: number, mobile?: boolean, fullPage?: boolean}} options
 * @returns {Promise<{path: string, bytes: number, cssWidth: number, scrollWidth: number, overflow: boolean}>}
 */
export async function capture({
  target,
  out,
  width = 1440,
  height = 900,
  mobile = false,
  fullPage = true,
}) {
  const exe = findBrowser();
  if (!exe) throw new Error('找不到 Chrome/Edge，无法截图');

  const url = /^[a-z]+:\/\//i.test(target) ? target : pathToFileURL(path.resolve(target)).href;
  const port = 9400 + Math.floor(Math.random() * 90);
  const profile = path.join(os.tmpdir(), `dsh-shot-${Date.now()}`);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;

  const child = spawn(exe, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    'about:blank',
  ], { stdio: 'ignore', env });

  try {
    let list;
    for (let i = 0; i < 40; i += 1) {
      await sleep(250);
      list = await targets(port);
      if (list) break;
    }
    if (!list) throw new Error('无头浏览器启动超时');

    const page = list.find((item) => item.type === 'page');
    if (!page) throw new Error('没有可用的页面目标');

    const session = new CdpSession(page.webSocketDebuggerUrl);
    await session.open();
    try {
      await session.call('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: mobile ? 2 : 1,
        mobile,
      });
      await session.call('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
      });
      await session.call('Page.navigate', { url });
      await sleep(1200);

      const metrics = await session.call('Runtime.evaluate', {
        expression: '({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth })',
        returnByValue: true,
      });
      const scrollWidth = metrics.result.value?.scrollWidth ?? width;
      const innerWidth = metrics.result.value?.innerWidth ?? width;

      const shot = await session.call('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: fullPage,
      });
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
      return {
        path: out,
        bytes: fs.statSync(out).size,
        cssWidth: innerWidth,
        scrollWidth,
        overflow: scrollWidth > innerWidth + 1,
      };
    } finally {
      session.close();
    }
  } finally {
    try { child.kill(); } catch { /* already gone */ }
    await sleep(300);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* locked, ignore */ }
  }
}
