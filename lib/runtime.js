/**
 * Runtime acceptance: actually load the page and watch it work.
 *
 * Structure checks (`verify.js` style) passed while the page threw on load and a
 * button did nothing — a reviewer caught that later, by hand. This module exists
 * so "it runs" is machine-checked: console errors, exceptions, layout overflow,
 * and a click-through smoke test.
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

export function findBrowser() {
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

/** Start a headless browser and hand its first page to `run`, then clean up. */
export async function withBrowser(run) {
  const exe = findBrowser();
  if (!exe) throw new Error('找不到 Chrome/Edge，无法做运行时检查');
  const port = 9400 + Math.floor(Math.random() * 90);
  const profile = path.join(os.tmpdir(), `dsh-run-${Date.now()}`);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  const child = spawn(exe, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
    '--no-default-browser-check', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank',
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
      return await run(session);
    } finally {
      session.close();
    }
  } finally {
    try { child.kill(); } catch { /* already gone */ }
    await sleep(300);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* locked */ }
  }
}

export function toUrl(target) {
  return /^[a-z]+:\/\//i.test(target) ? target : pathToFileURL(path.resolve(target)).href;
}

/**
 * Load the page, record console errors, then optionally run a smoke snippet.
 *
 * @param {{target: string, widths?: number[], smoke?: string, gates?: string[], settleMs?: number}} options
 */
export async function check({ target, widths = [1440, 390], smoke = '', gates = [], settleMs = 1200 }) {
  const url = toUrl(target);
  return withBrowser(async (session) => {
    const problems = [];
    const errors = [];

    // Listen before navigating so load-time errors are captured.
    await session.call('Runtime.enable');
    await session.call('Log.enable');
    await session.call('Page.enable');
    session.on('Runtime.exceptionThrown', (params) => {
      errors.push(params.exceptionDetails?.exception?.description || params.exceptionDetails?.text || 'exception');
    });
    session.on('Runtime.consoleAPICalled', (params) => {
      if (params.type !== 'error') return;
      errors.push(params.args.map((a) => a.value ?? a.description ?? '').join(' '));
    });
    session.on('Log.entryAdded', (params) => {
      if (params.entry?.level === 'error') errors.push(params.entry.text);
    });

    const measured = [];
    for (const width of widths) {
      await session.call('Emulation.setDeviceMetricsOverride', {
        width,
        height: width <= 480 ? 844 : 900,
        deviceScaleFactor: width <= 480 ? 2 : 1,
        mobile: width <= 480,
      });
      await session.call('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
      });
      await session.call('Page.navigate', { url });
      await sleep(settleMs);
      const metrics = await session.call('Runtime.evaluate', {
        expression: '({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth })',
        returnByValue: true,
      });
      const scrollWidth = metrics.result.value?.scrollWidth ?? width;
      const innerWidth = metrics.result.value?.innerWidth ?? width;
      measured.push({ width, innerWidth, scrollWidth, overflow: scrollWidth > innerWidth + 1 });
      if (scrollWidth > innerWidth + 1) problems.push(`${width}px 有横向溢出（scrollWidth ${scrollWidth}）`);
    }

    let smokeResult;
    if (smoke) {
      await session.call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
      await session.call('Page.navigate', { url });
      await sleep(settleMs);
      try {
        const r = await session.call('Runtime.evaluate', { expression: smoke, returnByValue: true, awaitPromise: true });
        smokeResult = r.result?.value;
        if (r.exceptionDetails) problems.push(`冒烟脚本抛错：${r.exceptionDetails.text}`);
      } catch (error) {
        problems.push(`冒烟脚本失败：${error.message}`);
      }
    }

    // Gates: rules the knowledge base says are mechanical. A rule a machine can
    // verify should not be left to a reviewer's memory.
    const gateResults = [];
    if (gates.length) {
      const script = `(() => {
        const ids = ${JSON.stringify(gates)};
        const css = [...document.styleSheets].flatMap((sheet) => {
          try { return [...sheet.cssRules].map((rule) => rule.cssText); } catch { return []; }
        }).join('\\n');
        const out = [];
        for (const id of ids) {
          let ok = true;
          let detail = '';
          if (id === 'reduced-motion') {
            ok = /prefers-reduced-motion/.test(css);
            if (!ok) detail = 'CSS 里没有 prefers-reduced-motion 降级';
          } else if (id === 'focus-visible') {
            ok = /:focus-visible|:focus\\b/.test(css);
            if (!ok) detail = 'CSS 里没有可见的 focus 样式';
          } else if (id === 'viewport') {
            ok = !!document.querySelector('meta[name="viewport"]');
            if (!ok) detail = '缺少 viewport meta';
          } else if (id === 'img-alt') {
            const imgs = [...document.querySelectorAll('img')];
            ok = imgs.every((img) => img.hasAttribute('alt'));
            if (!ok) detail = imgs.filter((img) => !img.hasAttribute('alt')).length + ' 张图没有 alt';
          } else if (id === 'no-external') {
            const res = performance.getEntriesByType('resource').map((entry) => entry.name).filter((name) => /^https?:/i.test(name));
            const links = [...document.querySelectorAll('link[href],script[src],img[src]')]
              .map((el) => el.getAttribute('href') || el.getAttribute('src') || '')
              .filter((value) => /^https?:/i.test(value));
            ok = res.length === 0 && links.length === 0;
            if (!ok) detail = '运行时请求了外部资源：' + [...res, ...links].slice(0, 2).join(', ');
          } else if (id === 'no-div-click') {
            const bad = [...document.querySelectorAll('[onclick]')].filter((el) => !['BUTTON', 'A'].includes(el.tagName));
            ok = bad.length === 0;
            if (!ok) detail = bad.length + ' 个非按钮元素绑了 onclick';
          }
          out.push({ id, ok, detail });
        }
        return out;
      })()`;
      const result = await session.call('Runtime.evaluate', { expression: script, returnByValue: true });
      for (const item of result.result.value || []) {
        gateResults.push(item);
        if (!item.ok) problems.push(`闸门未通过（${item.id}）：${item.detail}`);
      }
    }

    if (errors.length) problems.push(`控制台报错 ${errors.length} 条`);
    return { problems, errors, smoke: smokeResult, widths: measured, gates: gateResults, url };
  });
}
