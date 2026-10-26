/**
 * CDP driver: attach to an Electron/Chromium app, type a prompt, read the answer.
 *
 * Two facts this file exists to encode:
 * 1. DSH's own process carries `ELECTRON_RUN_AS_NODE=1`, so every Electron app it
 *    spawns would start as a bare Node process and exit instantly. The launch
 *    environment must drop that variable (and friends) or nothing works.
 * 2. The window never needs to be visible: offscreen + occluded-window throttling
 *    disabled keeps the page rendering while CDP reads and types.
 */
import { spawn, execFileSync } from 'node:child_process';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Environment for launching a GUI Electron app from inside DSH. */
function guiEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  // Inherited Electron/Node switches make the child run as a headless Node script.
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  delete env.ELECTRON_ENABLE_LOGGING;
  delete env.ELECTRON_ENABLE_STACK_DUMPING;
  delete env.NODE_OPTIONS;
  return env;
}

const BASE_ARGS = [
  '--remote-allow-origins=*',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--disable-features=CalculateNativeWinOcclusion',
];

export class CdpSession {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.nextId = 0;
    this.pending = new Map();
  }

  async open() {
    this.ws = new WebSocket(this.wsUrl);
    this.ws.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(msg.error.message || 'CDP error'));
      else entry.resolve(msg.result);
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP websocket open timeout')), 8000);
      this.ws.addEventListener('open', () => { clearTimeout(timer); resolve(); });
      this.ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP websocket error')); });
    });
  }

  call(method, params = {}, timeoutMs = 30000) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timeout`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.call('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || 'evaluate failed');
    }
    return result.result.value;
  }

  close() {
    try { this.ws?.close(); } catch { /* already closed */ }
  }
}

/** Ask a CDP HTTP endpoint for its target list; undefined when the port is closed. */
export async function targets(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return undefined;
    return await response.json();
  } catch {
    return undefined;
  }
}

export async function attach(port, match) {
  const list = await targets(port);
  if (!list) return undefined;
  const needle = (match || '').toLowerCase();
  const page = list.find((t) => t.type === 'page' && `${t.title} ${t.url}`.toLowerCase().includes(needle))
    || list.find((t) => t.type === 'page');
  if (!page) return undefined;
  const session = new CdpSession(page.webSocketDebuggerUrl);
  await session.open();
  await session.call('Runtime.enable', {}, 10000);
  return session;
}

/** True when a process with this image name is running. */
export function processRunning(exe) {
  const name = exe.split(/[\\/]/).pop().replace(/\.exe$/i, '');
  try {
    const out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${name}.exe`, '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
    });
    return out.toLowerCase().includes(`${name.toLowerCase()}.exe`);
  } catch {
    return false;
  }
}

/** Launch the app with a debugging port, detached, no visible window requirement. */
export function launch(exe, port, extraArgs = []) {
  const args = [`--remote-debugging-port=${port}`, ...BASE_ARGS, ...extraArgs];
  const child = spawn(exe, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    env: guiEnv(),
  });
  child.unref();
  return child.pid;
}

/** Kill every process of this image (used only by an explicit restart request). */
export function killApp(exe) {
  const name = exe.split(/[\\/]/).pop();
  try {
    execFileSync('taskkill', ['/IM', name, '/T', '/F'], { windowsHide: true, timeout: 15000 });
    return true;
  } catch {
    return false;
  }
}

/** Wait until the debugging port answers, launching the app first when needed. */
export async function ensureWorker(spec, { timeoutMs = 40000, onNote } = {}) {
  const note = (text) => { if (onNote) onNote(text); };
  let list = await targets(spec.port);
  if (list) return { launched: false, list };

  if (processRunning(spec.exe)) {
    // Running without a debugging port: nothing can attach. Say so instead of guessing.
    throw new Error(`${spec.name} 正在运行但没有开启调试端口（${spec.port}）。请先退出该软件，或调用 team_workers 的 restart 动作由插件重启它。`);
  }

  note(`启动 ${spec.name}（端口 ${spec.port}）`);
  launch(spec.exe, spec.port, spec.args || []);
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    await sleep(1000);
    list = await targets(spec.port);
    if (list) return { launched: true, list };
  }
  throw new Error(`${spec.name} 启动后 ${Math.round(timeoutMs / 1000)} 秒内调试端口 ${spec.port} 仍不可用。`);
}

const FOCUS_COMPOSER = (composer) => `(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const nodes = [...document.querySelectorAll(${JSON.stringify(composer)})].filter(vis);
  const el = nodes[nodes.length - 1];
  if (!el) return { ok: false, reason: 'composer not found' };
  el.focus();
  return { ok: true, text: (el.innerText || el.value || '').length, ce: el.isContentEditable };
})()`;

const COMPOSER_TEXT = (composer) => `(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const nodes = [...document.querySelectorAll(${JSON.stringify(composer)})].filter(vis);
  const el = nodes[nodes.length - 1];
  return el ? (el.innerText || el.value || '') : '';
})()`;

const READ_ANSWER = (answer) => `(() => {
  const nodes = [...document.querySelectorAll(${JSON.stringify(answer)})];
  const el = nodes[nodes.length - 1];
  if (!el) return { text: '', count: 0 };
  return { text: (el.innerText || '').trim(), count: nodes.length };
})()`;

/**
 * Does the last status block announce a finished run?
 *
 * WorkBuddy prints "已处理 12m9s" while its agent runs and flips to
 * "已完成 3m27s" when the run settles. That badge is the only signal that
 * survives the quiet stretches between its tool calls.
 */
const STATUS_MARKER = (sel, marker) => `(() => {
  const nodes = [...document.querySelectorAll(${JSON.stringify(sel)})];
  const el = nodes[nodes.length - 1];
  if (!el) return false;
  return (el.innerText || '').trim().startsWith(${JSON.stringify(marker)});
})()`;

const IS_STREAMING = (sel, textPattern) => `(() => {
  if (${JSON.stringify(sel || '')}) {
    if (document.querySelector(${JSON.stringify(sel || '')})) return true;
  }
  const pattern = ${JSON.stringify(textPattern || '')};
  if (pattern) {
    // Progress chrome ("生成中", "正在写入文件", "思考中") stays on screen while an
    // agent runs a tool even though no tokens stream. Text stability alone would
    // then report a half-finished task as complete.
    const tail = document.body.innerText.slice(-500);
    if (new RegExp(pattern).test(tail)) return true;
  }
  return false;
})()`;

const CLICK_SEND = (sel) => `(() => {
  const btn = [...document.querySelectorAll(${JSON.stringify(sel)})]
    .filter((b) => b.getBoundingClientRect().width > 0)[0];
  if (!btn) return 'missing';
  if (btn.disabled) return 'disabled';
  btn.click();
  return 'clicked';
})()`;

/**
 * Type one prompt into a worker app and press send.
 * @returns {{baseline: string, sentVia: string}}
 */
export async function ask(spec, text) {
  await ensureWorker(spec);
  const session = await attach(spec.port, spec.match);
  if (!session) throw new Error(`无法连接 ${spec.name} 的页面目标`);
  try {
    const focus = await session.evaluate(FOCUS_COMPOSER(spec.composer));
    if (!focus.ok) throw new Error(`${spec.name}: 找不到输入框（${spec.composer}）`);

    const existing = await session.evaluate(COMPOSER_TEXT(spec.composer));
    if (existing && existing.trim()) {
      await session.call('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 65, key: 'a', code: 'KeyA', modifiers: 2 });
      await session.call('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 65, key: 'a', code: 'KeyA', modifiers: 2 });
      await session.call('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 8, key: 'Backspace', code: 'Backspace' });
      await session.call('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 8, key: 'Backspace', code: 'Backspace' });
      await sleep(200);
    }

    const before = await session.evaluate(READ_ANSWER(spec.answer));
    await session.call('Input.insertText', { text });
    await sleep(400);

    let sentVia = 'enter';
    if (spec.send) {
      const clicked = await session.evaluate(CLICK_SEND(spec.send));
      if (clicked === 'clicked') sentVia = 'button';
    }
    if (sentVia !== 'button') {
      await session.call('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter' });
      await session.call('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter' });
    }

    // Re-baseline AFTER sending. In chat apps the newest answer node is briefly the
    // user's own message; keeping the pre-send baseline would make that echo look
    // like a finished answer (it is stable and differs from the old one).
    let baseline = before.text || '';
    for (let i = 0; i < 8; i += 1) {
      await sleep(400);
      const current = await session.evaluate(READ_ANSWER(spec.answer));
      if (current?.text && current.text !== baseline) {
        baseline = current.text;
        break;
      }
    }
    return { baseline, sentVia };
  } finally {
    session.close();
  }
}

/**
 * Check the app's own preconditions (mode / workspace / approval policy).
 *
 * A chat-mode app can still answer, but it cannot open the screenshots or read
 * the project folder — exactly the silent failure that makes a review useless.
 * Reporting it before dispatch is cheaper than discovering it in the answer.
 */
export async function checkReady(spec, projectName) {
  if (!spec.ready) return { ok: true, checked: false };
  const session = await attach(spec.port, spec.match);
  if (!session) {
    return { ok: false, checked: true, reason: `${spec.name} 没连上（端口 ${spec.port}）`, hint: spec.readyHint };
  }
  try {
    const ok = await session.evaluate(`(() => ${spec.ready})()`);
    if (!ok) return { ok: false, checked: true, hint: spec.readyHint };

    // Workspace check: most apps render the selected folder name somewhere. If it
    // is not on screen, the app is almost certainly still pointed at the previous
    // project — the single most common cause of "it edited the wrong folder".
    if (spec.workspaceName && projectName) {
      const named = await session.evaluate(
        `(() => document.body.innerText.toLowerCase().includes(${JSON.stringify(projectName.toLowerCase())}))()`,
      );
      if (!named) {
        return {
          ok: false,
          checked: true,
          reason: `工作区看起来不是 ${projectName}`,
          hint: `把 ${spec.name} 的工作区切到 ${projectName} 目录（现在界面上看不到这个文件夹名）`,
        };
      }
    }
    return { ok: true, checked: true, hint: spec.readyHint };
  } catch (error) {
    return { ok: false, checked: true, reason: error.message, hint: spec.readyHint };
  } finally {
    session.close();
  }
}

/** Read the current last-answer text of a worker. */
export async function readAnswer(spec) {
  const session = await attach(spec.port, spec.match);
  if (!session) return { text: '', count: 0, streaming: false, finished: undefined, offline: true };
  try {
    const answer = await session.evaluate(READ_ANSWER(spec.answer));
    const streaming = await session.evaluate(IS_STREAMING(spec.streaming, spec.busyText));
    const finished = spec.status && spec.doneText
      ? await session.evaluate(STATUS_MARKER(spec.status, spec.doneText))
      : (spec.answerDoneText ? (answer.text || '').includes(spec.answerDoneText) : undefined);
    return { ...answer, streaming: !!streaming, finished };
  } finally {
    session.close();
  }
}

/**
 * Poll one worker for up to `timeoutMs`, then report instead of throwing.
 *
 * The caller decides what a timeout means: a chat worker that is still answering
 * is just "not done yet", not a failure. Returning `{ done: false }` keeps the
 * dispatcher free to hand other work to other workers meanwhile.
 *
 * Completion requires the worker to look idle (`streaming` false for
 * `idleTicks` consecutive polls) *and* an answer text that stayed unchanged for
 * `stableMs`. Agent-style apps print progress sentences and then go quiet while
 * they run tools, so the idle signal — not the text — is what matters most.
 */
export async function waitAnswer(spec, baseline, {
  timeoutMs = 300000,
  stableMs = 8000,
  idleTicks = 5,
  signal,
} = {}) {
  const started = Date.now();
  let last = null;
  let lastChange = 0;
  let sawChange = false;
  let idle = 0;
  let busy = true;
  let partial = '';
  let offlineTicks = 0;

  while (Date.now() - started < timeoutMs) {
    if (signal?.aborted) throw new Error('已取消');
    let current;
    try {
      current = await readAnswer(spec);
    } catch {
      await sleep(1000);
      continue;
    }
    if (current.offline) {
      offlineTicks += 1;
      // Three misses in a row means the app is gone (closed, crashed, port dropped),
      // not "still thinking". Fail fast with a fixable message.
      if (offlineTicks >= 3) {
        return {
          done: false,
          text: partial,
          partial,
          elapsedMs: Date.now() - started,
          busy: false,
          offline: true,
          reason: `${spec.name} 连不上了（端口 ${spec.port} 无响应）。可能被关闭或崩溃，用 team_workers {"action":"restart","worker":"${spec.id}"} 拉起。`,
        };
      }
      await sleep(1000);
      continue;
    }
    offlineTicks = 0;
    busy = !!current.streaming;
    if (current.text && current.text !== baseline) {
      partial = current.text;
      if (current.text !== last) {
        last = current.text;
        lastChange = Date.now();
        sawChange = true;
      }
    }
    idle = busy ? 0 : idle + 1;
    const stableFor = Date.now() - lastChange;
    // `finished === false` means the app has a terminal signal (badge or sentinel)
    // and it is still negative: never call that done, however quiet the text looks.
    const settled = current.finished !== false;
    const hasSignal = current.finished !== undefined;
    if (sawChange && !busy && settled && idle >= idleTicks && stableFor >= stableMs) {
      return { done: true, text: last, partial: last, elapsedMs: Date.now() - started, busy: false };
    }
    // Grace fallback only for apps with NO terminal signal at all: the model forgot
    // the convention and the screen has been static for 30s. When a signal exists,
    // a long silent stretch is usually a tool running, not a finished answer.
    if (sawChange && !busy && !settled && !hasSignal && idle >= idleTicks && stableFor >= 30000) {
      return { done: true, text: last, partial: last, elapsedMs: Date.now() - started, busy: false, degraded: true };
    }
    await sleep(1000);
  }
  return {
    done: false,
    text: partial,
    partial,
    elapsedMs: Date.now() - started,
    busy,
  };
}

/**
 * Watch several in-flight tasks at once and return as soon as ONE of them settles.
 *
 * This exists because polling one task per model step burns steps — and steps are
 * the dominant cost of an orchestration run. One call now covers a whole fan-out,
 * and whoever finishes first comes back immediately instead of waiting its turn.
 *
 * @param {Array<{key: string, spec: object, baseline: string}>} entries
 * @returns {Promise<{key: string, result: object} | null>} null when nothing settled in time.
 */
export async function waitAnyAnswer(entries, {
  timeoutMs = 120000,
  stableMs = 8000,
  idleTicks = 5,
} = {}) {
  const started = Date.now();
  const state = entries.map((entry) => ({
    ...entry,
    last: null,
    lastChange: 0,
    sawChange: false,
    idle: 0,
    offlineTicks: 0,
    partial: '',
  }));

  while (Date.now() - started < timeoutMs) {
    for (const item of state) {
      let current;
      try {
        current = await readAnswer(item.spec);
      } catch {
        item.offlineTicks += 1;
        if (item.offlineTicks >= 3) {
          return {
            key: item.key,
            result: {
              done: false,
              offline: true,
              text: item.partial,
              partial: item.partial,
              elapsedMs: Date.now() - started,
              reason: `${item.spec.name} 连不上了（端口 ${item.spec.port} 无响应）。`,
            },
          };
        }
        continue;
      }
      item.offlineTicks = 0;
      const busy = !!current.streaming;
      if (current.text && current.text !== item.baseline) {
        item.partial = current.text;
        if (current.text !== item.last) {
          item.last = current.text;
          item.lastChange = Date.now();
          item.sawChange = true;
        }
      }
      item.idle = busy ? 0 : item.idle + 1;
      const stableFor = Date.now() - item.lastChange;
      const settled = current.finished !== false;
      const hasSignal = current.finished !== undefined;
      if (item.sawChange && !busy && settled && item.idle >= idleTicks && stableFor >= stableMs) {
        return {
          key: item.key,
          result: { done: true, text: item.last, partial: item.last, elapsedMs: Date.now() - started, busy: false },
        };
      }
      if (item.sawChange && !busy && !settled && !hasSignal && item.idle >= idleTicks && stableFor >= 30000) {
        return {
          key: item.key,
          result: { done: true, text: item.last, partial: item.last, elapsedMs: Date.now() - started, busy: false, degraded: true },
        };
      }
    }
    await sleep(1000);
  }
  return null;
}
