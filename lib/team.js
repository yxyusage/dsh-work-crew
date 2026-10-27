/**
 * The team board: workers, tasks, resource locks and the shared `.dsh-team/` folder.
 *
 * The board is the single source of truth the model reads before acting, and the
 * only place lock conflicts are decided. Files stay human-readable on purpose:
 * a new session, or you, can pick the project up from the folder alone.
 */
import fs from 'node:fs';
import path from 'node:path';
import { targets, processRunning } from './cdp.js';

const PROTOCOL_FIELDS = [
  'port', 'match', 'composer', 'send', 'answer', 'streaming',
  'busyText', 'status', 'doneText', 'answerDoneText',
];

const DEFAULT_WORKERS = [
  {
    id: 'workbuddy',
    spec: 2,
    name: 'WorkBuddy',
    role: '实施者：在项目目录里写代码、跑命令、改文件',
    caps: ['implement', 'verify', 'screenshot'],
    exe: '',
    port: 9332,
    match: 'renderer/index',
    composer: '[data-slate-editor="true"]',
    send: '.cr-send-button',
    answer: '.cr-agent__content .cr-markdown',
    streaming: '.cr-stop-button',
    // WorkBuddy keeps no stop button while it runs a tool, but it does print one of
    // these status lines. Without them a pause between steps reads as "finished".
    busyText: '生成中|正在写入|正在处理|处理中|思考中|准备中|已处理',
    // ...and its per-run badge flips from "已处理 12m9s" to "已完成 3m27s" when the
    // run really settles. That badge is the tie-breaker.
    status: '.cr-agent__content',
    doneText: '已完成',
    // Preconditions: without a workspace it cannot touch the project, and the
    // permission chip decides whether it stops to ask at every edit.
    ready: "!document.body.innerText.includes('选择工作空间')",
    readyHint: '输入框下方要选中工作空间（例如 test1），并确认权限是「允许完全访问」',
    workspaceName: true,
  },
  {
    id: 'doubao',
    spec: 2,
    name: '豆包',
    role: '评审 / 创意：挑问题、提创新点、看设计合理性',
    caps: ['review', 'screenshot'],
    exe: '',
    port: 9331,
    match: 'doubao-chat/chat',
    composer: '[contenteditable="true"]',
    send: '[data-testid="chat_input_send_button"]',
    answer: '[data-testid="message_text_content"]',
    streaming: '[data-testid*="stop"]',
    busyText: '正在思考|正在生成|生成中|停止生成',
    // Doubao keeps its "已处理 2m34s" timer after finishing, so elapsed time says
    // nothing. The sentinel from the brief is the only reliable terminal signal.
    answerDoneText: '@@END@@',
    // Chat mode has no local-computer access: it cannot open a PNG or read files.
    ready: "document.body.innerText.includes('本地电脑')",
    readyHint: '要切到「工作」模式，并在输入框下方选中「本地电脑」+ 项目目录，否则读不到本地文件/截图',
    workspaceName: true,
  },
  {
    id: 'zcode',
    spec: 2,
    name: 'ZCode',
    role: '第三人：实现或评审，GLM 系模型',
    caps: ['implement', 'review'],
    exe: '',
    port: 9334,
    match: 'renderer/index',
    composer: '[data-testid="v4-composer-input"]',
    send: '[data-testid="v4-composer-send"]',
    answer: 'div[class*="assistant-row"] div[class*="space-y-4"]',
    busyText: '停止生成|生成中|思考中|工作中|处理中',
    // Its markdown renderer eats "<<" as an HTML tag, so the sentinel must not use
    // angle brackets. "@@END@@" survives rendering in all three apps.
    answerDoneText: '@@END@@',
    // "变更前确认" stops the agent before every write; automation needs auto-run.
    ready: "!document.body.innerText.includes('变更前确认')",
    readyHint: '权限要改成自动执行（现在显示「变更前确认」，每步都会停下来等你点）',
    workspaceName: true,
  },
  {
    id: 'qoder',
    spec: 3,
    name: 'Qoder',
    role: '第四人：实现 / 评审（VS Code 系 IDE，MiniMax 等模型）',
    caps: ['implement', 'review', 'audit'],
    exe: '',
    port: 9335,
    match: 'qoder-app://',
    composer: '.loop-rich-editor',
    send: 'button[data-e2e="chat.send"]',
    answer: '.markdown-presentation',
    busyText: '停止|生成中|思考中|处理中|运行中',
    answerDoneText: '@@END@@',
    // The workspace empty state carries this sentence; it is the only reliable
    // "no workspace yet" marker in the DOM (a selected path is not rendered as text).
    ready: "!document.body.innerText.includes('工作区就是 Agent 动手的地方')",
    readyHint: '要在「工作区」里选中项目目录，并确认审批模式是「自动审批」',
  },
];

const EXE_CANDIDATES = {
  workbuddy: [
    'E:\\workbody\\WorkBuddy\\WorkBuddy.exe',
    '%LOCALAPPDATA%\\Programs\\WorkBuddy\\WorkBuddy.exe',
    '%PROGRAMFILES%\\WorkBuddy\\WorkBuddy.exe',
  ],
  doubao: [
    '%LOCALAPPDATA%\\Doubao\\Application\\app\\Doubao.exe',
    '%LOCALAPPDATA%\\Doubao\\Application\\Doubao.exe',
    '%PROGRAMFILES%\\Doubao\\Doubao.exe',
  ],
  zcode: [
    'E:\\Zcode\\ZCode.exe',
    '%LOCALAPPDATA%\\Programs\\ZCode\\ZCode.exe',
    '%PROGRAMFILES%\\ZCode\\ZCode.exe',
  ],
  qoder: [
    'E:\\Qoder\\Qoder.exe',
    '%LOCALAPPDATA%\\Programs\\Qoder\\Qoder.exe',
    '%PROGRAMFILES%\\Qoder\\Qoder.exe',
  ],
};

const expand = (value) => value.replace(/%([^%]+)%/g, (_, name) => process.env[name] || '');

function findExe(worker) {
  if (worker.exe) {
    const exe = expand(worker.exe);
    if (fs.existsSync(exe)) return exe;
  }
  for (const candidate of EXE_CANDIDATES[worker.id] || []) {
    const exe = expand(candidate);
    if (fs.existsSync(exe)) return exe;
  }
  return '';
}

const nowIso = () => new Date().toISOString();

/**
 * Two resource namespaces collide when they are equal, or when one owns the other.
 * `landing` covers `landing:hero`; `landing:hero` does not cover `landing:meta`.
 */
function locksCollide(a, b) {
  if (a === b) return true;
  return a.startsWith(`${b}:`) || b.startsWith(`${a}:`);
}

/**
 * Remember the project the team is working on.
 *
 * The anchor cannot live only in memory: a plugin reload (or a DSH restart)
 * creates a new instance, and every later tool call would silently fall back to
 * the session cwd — writing tasks and outbox files into the wrong project.
 */
const ACTIVE_FILE = path.join(process.env.DSH_HOME || path.join(process.env.USERPROFILE || '', '.dsh'), 'team', 'active.json');

function readActive() {
  try {
    const saved = JSON.parse(fs.readFileSync(ACTIVE_FILE, 'utf8'));
    return typeof saved.dir === 'string' ? saved.dir : '';
  } catch {
    return '';
  }
}

function writeActive(dir) {
  try {
    fs.mkdirSync(path.dirname(ACTIVE_FILE), { recursive: true });
    fs.writeFileSync(ACTIVE_FILE, JSON.stringify({ dir, at: nowIso() }, null, 2), 'utf8');
  } catch { /* the anchor is an optimization, never a hard dependency */ }
}

/**
 * Machine-wide channel lock: one desktop app can only be typed into by one task
 * at a time, no matter how many projects are open in parallel.
 *
 * Task locks are per project, so two projects would otherwise both dispatch to
 * Doubao and interleave their typing into the same window.
 */
const CHANNEL_FILE = path.join(path.dirname(ACTIVE_FILE), 'channels.json');
const CHANNEL_TTL_MS = 30 * 60 * 1000;

function readChannels() {
  try {
    const saved = JSON.parse(fs.readFileSync(CHANNEL_FILE, 'utf8'));
    return saved && typeof saved === 'object' ? saved : {};
  } catch {
    return {};
  }
}

function writeChannels(map) {
  try {
    fs.mkdirSync(path.dirname(CHANNEL_FILE), { recursive: true });
    fs.writeFileSync(CHANNEL_FILE, JSON.stringify(map, null, 2), 'utf8');
  } catch { /* best effort */ }
}

export class Team {
  constructor(ctx) {
    this.ctx = ctx;
    this.dirs = new Map();
  }

  /** Claim the machine-wide channel for one worker. Returns the holder when busy. */
  acquireChannel(worker, project, taskId) {
    const map = readChannels();
    const now = Date.now();
    for (const [key, entry] of Object.entries(map)) {
      if (now - Date.parse(entry.since || 0) > CHANNEL_TTL_MS) delete map[key];
    }
    const current = map[worker];
    if (current && !(current.project === project && current.taskId === taskId)) return current;
    map[worker] = { project, taskId, since: new Date(now).toISOString() };
    writeChannels(map);
    return null;
  }

  releaseChannel(worker, taskId) {
    const map = readChannels();
    const current = map[worker];
    if (!current) return;
    if (taskId && current.taskId !== taskId) return;
    delete map[worker];
    writeChannels(map);
  }

  channels() {
    return readChannels();
  }

  /** Resolve the project directory for the calling agent. */
  async resolveDir(agent) {
    if (this.explicitDir) return this.explicitDir;
    let cwd = process.cwd();
    try {
      const wd = this.ctx.get('workingDirectory');
      if (wd && agent?.session) cwd = wd.get(agent.session) || cwd;
    } catch { /* fall through */ }
    const hasBoard = (dir) => !!dir && fs.existsSync(path.join(dir, '.dsh-team', 'board.json'));
    // The remembered project wins: a session's cwd often has its own board too
    // (this repo does), and silently switching projects on reload lost two outbox
    // writes in practice. Switching projects is explicit: call team_init again.
    const active = readActive();
    if (hasBoard(active)) return active;
    if (hasBoard(cwd)) return cwd;
    return cwd;
  }

  board(dir) {
    const key = path.resolve(dir);
    let board = this.dirs.get(key);
    if (board) return board;

    board = {
      version: 1,
      dir: key,
      project: path.basename(key),
      createdAt: nowIso(),
      updatedAt: nowIso(),
      workers: {},
      tasks: [],
      locks: [],
      events: [],
    };
    const file = path.join(key, '.dsh-team', 'board.json');
    if (fs.existsSync(file)) {
      try {
        const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
        board = { ...board, ...saved, dir: key };
      } catch { /* keep a fresh board when the file is unreadable */ }
    }
    for (const preset of DEFAULT_WORKERS) {
      const savedWorker = board.workers[preset.id] || {};
      const merged = { ...preset, ...savedWorker };
      // Protocol fields (selectors, ports, completion markers) belong to the code,
      // not to an old board file. Keep the user's exe/role, but refresh the spec
      // whenever the preset version moves on — otherwise a stale sentinel or
      // selector in board.json silently disables the new completion rule.
      if ((savedWorker.spec || 1) < (preset.spec || 1)) {
        for (const field of PROTOCOL_FIELDS) merged[field] = preset[field];
        merged.spec = preset.spec;
      }
      board.workers[preset.id] = merged;
      const exe = findExe(board.workers[preset.id]);
      if (exe) board.workers[preset.id].exe = exe;
    }
    this.dirs.set(key, board);
    return board;
  }

  save(board) {
    board.updatedAt = nowIso();
    const dir = path.join(board.dir, '.dsh-team');
    fs.mkdirSync(path.join(dir, 'briefs'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'outbox'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'log'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'board.json'), JSON.stringify(board, null, 2), 'utf8');
    writeActive(board.dir);
    return board;
  }

  event(board, type, message, extra = {}) {
    board.events.push({ t: nowIso(), type, message, ...extra });
    if (board.events.length > 300) board.events.splice(0, board.events.length - 300);
    const file = path.join(board.dir, '.dsh-team', 'log', `${nowIso().slice(0, 10)}.jsonl`);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, JSON.stringify({ t: nowIso(), type, message, ...extra }) + '\n', 'utf8');
    } catch { /* a log write must never fail the task */ }
  }

  toJSON(board) {
    return {
      project: board.project,
      dir: board.dir,
      updatedAt: board.updatedAt,
      workers: Object.values(board.workers).map((w) => ({
        id: w.id,
        name: w.name,
        role: w.role,
        caps: w.caps || [],
        port: w.port,
        exe: w.exe,
        online: w.online === true,
      })),
      tasks: board.tasks.map((t) => ({
        id: t.id,
        title: t.title,
        worker: t.worker,
        status: t.status,
        dependsOn: t.dependsOn,
        locks: [...(t.write || []).map((r) => `write:${r}`), ...(t.read || []).map((r) => `read:${r}`)],
        error: t.error,
        outbox: t.outbox,
        stalled: t.stalled === true,
        ageMin: t.startedAt ? Math.round((Date.now() - Date.parse(t.startedAt)) / 60000) : 0,
        deadlineMin: t.deadlineMin ?? 45,
      })),
      locks: board.locks.map((l) => ({ resource: l.resource, mode: l.mode, taskId: l.taskId, worker: l.worker, since: l.since })),
      events: board.events.slice(-40),
    };
  }

  /** Timestamp of the newest event that mentions this task. */
  lastActivity(board, taskId) {
    for (let i = board.events.length - 1; i >= 0; i -= 1) {
      if (board.events[i].taskId === taskId) return board.events[i].t;
    }
    return '';
  }

  statusText(board) {
    const by = (status) => board.tasks.filter((t) => t.status === status);
    const lines = [];
    lines.push(`项目 ${board.project} · ${board.dir}`);
    lines.push(`任务：${by('running').length} 进行中 / ${by('queued').length} 排队 / ${by('ready').length} 待派 / ${by('done').length} 完成 / ${by('blocked').length} 阻塞`);

    // Who is doing what right now — a queued task that looks "running" is exactly
    // the confusion that made a 10-minute stall look like a hang.
    for (const worker of Object.values(board.workers)) {
      const running = board.tasks.find((t) => t.worker === worker.id && t.status === 'running');
      const queued = board.tasks.filter((t) => t.worker === worker.id && t.status === 'queued');
      if (!running && !queued.length) continue;
      const parts = [];
      if (running) {
        const mins = running.startedAt ? Math.round((Date.now() - Date.parse(running.startedAt)) / 60000) : 0;
        const last = this.lastActivity(board, running.id);
        const lastMins = last ? Math.round((Date.now() - Date.parse(last)) / 60000) : null;
        parts.push(`跑 ${running.id}（${mins}m${lastMins != null ? `，最后活动 ${lastMins}m 前` : ''}）`);
      } else {
        parts.push('空闲');
      }
      if (queued.length) parts.push(`队列 ${queued.length}：${queued.map((item) => item.id).join(',')}`);
      if (worker.online === false) parts.push('离线');
      lines.push(`· ${worker.name}：${parts.join(' ｜ ')}`);
    }

    for (const task of board.tasks) {
      const worker = board.workers[task.worker]?.name || task.worker;
      const deps = task.dependsOn?.length ? ` ← ${task.dependsOn.join(',')}` : '';
      const locks = [...(task.write || []).map((r) => `W:${r}`), ...(task.read || []).map((r) => `R:${r}`)].join(' ');
      const age = task.status === 'running' && task.startedAt
        ? ` ⏱${Math.round((Date.now() - Date.parse(task.startedAt)) / 60000)}m/${task.deadlineMin || 45}m`
        : '';
      const stalled = task.stalled ? ' ⚠️停滞' : '';
      const riskBadge = task.risk === 'high' ? ' 🔴高风险' : '';
      const reviewBadge = task.review ? ` 🔍评审${task.reviewRound ? `R${task.reviewRound}` : ''}` : '';
      lines.push(`- ${task.id} [${task.status}] ${task.title} → ${worker}${deps}${locks ? ` {${locks}}` : ''}${age}${stalled}${riskBadge}${reviewBadge}${task.error ? ` !! ${task.error}` : ''}`);
    }
    if (board.locks.length) {
      lines.push(`锁：${board.locks.map((l) => `${l.mode}:${l.resource}(${l.taskId})`).join(' ')}`);
    }
    const channels = this.channels();
    const held = Object.entries(channels).map(([worker, entry]) => `${worker}(${path.basename(entry.project)}/${entry.taskId})`);
    lines.push(`全局通道：${held.length ? held.join(' ') : '空闲'}`);
    lines.push(`看板：${path.join(board.dir, '.dsh-team', 'board.json')}`);
    return lines.join('\n');
  }

  addTask(board, input) {
    const worker = board.workers[input.worker];
    if (!worker) {
      throw new Error(`未知 worker "${input.worker}"；可用：${Object.keys(board.workers).join(', ')}`);
    }
    // Ids must never be reused: a failed add used to leave the counter behind and
    // the next task silently took an id someone had already referenced.
    const maxSeq = board.tasks.reduce((max, item) => {
      const match = /^T(\d+)$/.exec(item.id);
      return match ? Math.max(max, Number(match[1])) : max;
    }, 0);
    const explicit = typeof input.id === 'string' && input.id.trim() ? input.id.trim() : '';
    if (explicit && board.tasks.some((item) => item.id.toLowerCase() === explicit.toLowerCase())) {
      throw new Error(`任务 id ${explicit} 已存在`);
    }
    const task = {
      id: explicit || `T${maxSeq + 1}`,
      title: input.title,
      worker: input.worker,
      status: 'ready',
      dependsOn: input.dependsOn || [],
      write: (input.write || []).map((r) => r.replace(/^write:/, '')),
      read: (input.read || []).map((r) => r.replace(/^read:/, '')),
      note: input.note || '',
      image: input.image || '',
      seeUi: !!input.seeUi,
      seePath: input.seePath || 'index.html',
      // File handoff is the default: the worker writes its answer to outbox/<id>.md
      // and only says "DONE" in chat, so the body never enters the caller's context.
      deliver: input.deliver === 'chat' ? 'chat' : 'file',
      // Soft budget: after `deadlineMin` the task is flagged stalled, after twice
      // that it is auto-blocked. A 4-hour zombie task is worse than a failed one.
      deadlineMin: Number.isFinite(input.deadlineMin) ? input.deadlineMin : 45,
      expect: Array.isArray(input.expect) ? input.expect : [],
      referenceDirs: Array.isArray(input.referenceDirs) ? input.referenceDirs : [],
      requiredDocs: Array.isArray(input.requiredDocs) ? input.requiredDocs : [],
      // Independent review: the reviewer gets requirement + diff + rubric only,
      // never the implementer's own report (that is how self-review slips through).
      review: !!input.review,
      // Snapshot review: copy the changed files aside so the review does not hold a
      // read lock that would block the next implementation. Default on for reviews.
      snapshot: input.snapshot !== false,
      // Cross-check: after this review, ask another reviewer to confirm each issue.
      crossCheck: !!input.crossCheck,
      // Evidence-based acceptance: run this command before the task may be done.
      verify: typeof input.verify === 'string' ? input.verify.trim() : '',
      // Risk grade: high-risk work (auth, payments, CI, secrets) needs an explicit
      // human confirmation, mirroring "AI review never replaces required approval".
      risk: ['low', 'medium', 'high'].includes(input.risk) ? input.risk : 'medium',
      stalled: false,
      stalledNotified: false,
      createdAt: nowIso(),
      baseline: '',
      outbox: '',
      error: '',
    };
    for (const dep of task.dependsOn) {
      if (!board.tasks.some((t) => t.id === dep)) throw new Error(`依赖的任务不存在：${dep}`);
    }
    board.tasks.push(task);
    this.event(board, 'task/add', `${task.id} ${task.title} → ${worker.name}`, { taskId: task.id });
    this.save(board);
    return task;
  }

  /** Move a task to another worker, keeping its brief, deps, locks and history. */
  reassign(board, task, workerId, note) {
    const worker = board.workers[workerId];
    if (!worker) throw new Error(`未知 worker "${workerId}"；可用：${Object.keys(board.workers).join(', ')}`);
    const previous = task.worker;
    if (previous === workerId) throw new Error(`${task.id} 本来就在 ${worker.name} 上`);
    this.releaseLocks(board, task);
    this.releaseChannel(previous, task.id);
    task.worker = workerId;
    task.status = 'ready';
    task.error = '';
    task.stalled = false;
    task.stalledNotified = false;
    task.baseline = '';
    task.reassignedFrom = previous;
    task.reassignNote = note || '';
    this.event(board, 'task/reassign', `${task.id} ${previous} → ${workerId}${note ? `：${note}` : ''}`, { taskId: task.id });
    this.save(board);
    return task;
  }

  /** Next queued task of this worker, in creation order. */
  nextQueued(board, workerId) {
    return board.tasks.find((item) => item.worker === workerId && item.status === 'queued');
  }

  /** The task this worker is currently typing into. */
  workerBusyTask(board, workerId) {
    return board.tasks.find((item) => item.worker === workerId && item.status === 'running');
  }

  findTask(board, taskId) {
    const task = board.tasks.find((t) => t.id === taskId || t.id.toLowerCase() === String(taskId).toLowerCase());
    if (!task) throw new Error(`任务不存在：${taskId}`);
    return task;
  }

  assertDispatchable(board, task) {
    if (task.status === 'running') {
      throw new Error(`${task.id} 已在运行中（${task.worker}）。先 team_collect。`);
    }
    if (task.status === 'done') throw new Error(`${task.id} 已完成。`);
    const pending = task.dependsOn.filter((id) => this.findTask(board, id).status !== 'done');
    if (pending.length) {
      throw new Error(`${task.id} 的前置任务未完成：${pending.join(', ')}。先后顺序不能跳过。`);
    }
    const busy = board.tasks.find((t) => t.id !== task.id && t.worker === task.worker && t.status === 'running');
    if (busy) {
      throw new Error(`${task.worker} 正在执行 ${busy.id}（同一 worker 同时只能有一个在途任务）。`);
    }
    for (const [mode, list] of [['write', task.write], ['read', task.read]]) {
      // A snapshot review reads an immutable copy, so it neither takes nor respects
      // read locks: the next implementation can start immediately.
      if (mode === 'read' && task.readAdvisory) continue;
      for (const resource of list) {
        // Hierarchical resources: "landing" covers "landing:hero", but
        // "landing:hero" and "landing:meta" are independent. This lets a review
        // take a narrow lock instead of freezing the whole page.
        const holder = board.locks.find((l) => {
          if (!locksCollide(l.resource, resource)) return false;
          return l.mode === 'write' || mode === 'write';
        });
        if (holder) {
          throw new Error(
            `资源冲突：${mode}:${resource} 与 ${holder.mode}:${holder.resource} 被 ${holder.taskId}(${holder.worker}) 占用。`
            + '写任务与读任务不能同时进行——先完成占用方，或把产物拆成更细的命名空间（如 landing:hero / landing:meta）。',
          );
        }
      }
    }
  }

  acquireLocks(board, task) {
    for (const resource of task.write) {
      board.locks.push({ resource, mode: 'write', taskId: task.id, worker: task.worker, since: nowIso() });
    }
    for (const resource of task.read) {
      if (task.readAdvisory) continue;
      board.locks.push({ resource, mode: 'read', taskId: task.id, worker: task.worker, since: nowIso() });
    }
  }

  releaseLocks(board, task) {
    board.locks = board.locks.filter((l) => l.taskId !== task.id);
  }

  brief(board, task, extra = {}) {
    const worker = board.workers[task.worker];
    const missionFile = path.join(board.dir, '.dsh-team', 'mission.md');
    const mission = fs.existsSync(missionFile) ? fs.readFileSync(missionFile, 'utf8').trim() : '';
    const rubricFile = path.join(board.dir, '.dsh-team', 'rubric.md');
    const rubric = fs.existsSync(rubricFile) ? fs.readFileSync(rubricFile, 'utf8').trim() : '';
    const parts = [
      `# 任务 ${task.id} · ${task.title}`,
      '',
      `你是本次协作中的「${worker.name}」，角色：${worker.role}。`,
      '',
      '## 项目目标',
      mission || '（未填写 mission.md）',
      '',
      `## 项目目录`,
      board.dir,
      '',
      '## 你要做的',
      task.note || task.title,
      '',
    ];

    if (task.review) {
      // Independent review context. Deliberately withhold the implementer's report:
      // a reviewer that reads the author's narrative inherits its blind spots.
      parts.push(
        '## 评审模式（严格照做）',
        '- 你只依据三样东西判断：**需求**、**本次 diff**、**验收标准**。',
        '- **不要**去读 `.dsh-team/outbox/` 里实现者的报告，也不要参考任何"已完成/已验证"的说法。',
        '- 每条问题必须能指到 `文件:行号` 或具体区块；指不到的不要写。',
        '- 只报「会导致错误、不可用、不一致、难维护」的问题；风格偏好、重命名建议一律不写。',
        '- 按 P0（阻断）/ P1（明显缺陷）/ P2（可改可不改）分级；同类问题合并成一条。',
        '',
      );
      if (typeof extra.reviewRound === 'number' && extra.reviewRound > 3) {
        parts.push(
          `⚠️ 这是同一产物的第 ${extra.reviewRound} 轮评审。先回答一个问题：**是不是方案本身有问题**，`,
          '而不是继续在细节上打补丁。如果确实是方案问题，直接建议推翻重做，不要凑修改清单。',
          '',
        );
      }
      if (extra.snapshotDir) {
        parts.push(
          '## 评审对象（快照，以它为准）',
          `快照目录：${extra.snapshotDir}`,
          '里面是本次改动文件的副本。工作区里的同名文件可能正在被另一个人改，**不要以工作区为准**。',
          '',
        );
      }
    } else if (task.dependsOn.length) {
      parts.push('## 上游已完成', task.dependsOn.map((id) => {
        const dep = this.findTask(board, id);
        return `- ${dep.id} ${dep.title}${dep.outbox ? ` → ${dep.outbox}` : ''}`;
      }).join('\n'), '');
    }

    if (extra.diff) {
      parts.push(
        '## 本次改动（git diff）',
        '```diff',
        extra.diff,
        '```',
        '',
      );
    }

    if (task.review && rubric) {
      parts.push('## 验收标准（项目 rubric）', rubric, '');
    }

    if (task.image) {
      const imagePath = path.isAbsolute(task.image) ? task.image : path.join(board.dir, task.image);
      parts.push(
        '## 看图（截图已经截好，自己打开）',
        `图片：${imagePath}`,
        '直接打开这张图片，基于图中真实内容判断；回答里注明「依据：图中位置」。',
        '不要让我描述界面，也不要用记忆里的页面代替这张图。',
        '',
      );
    } else if (task.seeUi) {
      parts.push(
        '## 看界面（自己截图）',
        `目标页面：${path.join(board.dir, task.seePath)}`,
        `步骤：用浏览器打开 → 窗口最大化 → 自己截图保存为 ${path.join(board.dir, 'shots', `${task.id}.png`)} → 基于这张图判断。`,
        '如果截图拍不到目标窗口（例如浏览器没到前台），直接说明，不要用桌面截图冒充。',
        '',
      );
    }
    if (task.deliver === 'file') {
      const outFile = path.join(board.dir, '.dsh-team', 'outbox', `${task.id}.md`);
      parts.push(
        '## 交付方式（必须照做）',
        `把**完整产出**写进这个文件：${outFile}`,
        '聊天里只回两行：第一行 `DONE`，第二行 `@@END@@`。',
        '不要把正文贴回聊天——正文留在文件里，下游模型会自己读文件。',
        '',
      );
    }
    const refs = [...new Set([...(board.referenceDirs || []), ...(task.referenceDirs || [])])];
    const docs = [...new Set([...(board.requiredDocs || []), ...(task.requiredDocs || [])])];
    if (refs.length) {
      parts.push(
        '## 参考目录（必读，别只凭印象改）',
        ...refs.map((dir) => `- ${dir}`),
        '看完在回答里列出「已读文件」。没读就动手的产出会被拒收。',
        '',
      );
    }
    if (docs.length) {
      parts.push(
        '## 必读文档（标准以这里为准）',
        ...docs.map((doc) => `- ${doc}`),
        '',
      );
    }
    parts.push(
      '## 边界',
      '- 只做本任务范围，不要顺手改其他模块。',
      '- 需要看文件就直接读项目目录，不要把整份代码贴回来。',
      '',
      '## 回复格式',
      task.review
        ? '- 先给结论：通过 / 不通过（一句话）。\n- 再列问题：`P0|P1|P2 ｜ 文件:行号 ｜ 问题 ｜ 建议改法`。'
        : '- 先给结论（3 行以内）。\n- 再列改动/建议（文件路径 + 一句话）。',
      '- 最后单独一行输出：@@END@@',
    );
    return parts.join('\n');
  }

  async health(board) {
    const out = {};
    await Promise.all(Object.values(board.workers).map(async (worker) => {
      const list = await targets(worker.port).catch(() => undefined);
      out[worker.id] = {
        online: !!list,
        running: worker.exe ? processRunning(worker.exe) : false,
        targets: (list || []).filter((t) => t.type === 'page').length,
      };
    }));
    for (const worker of Object.values(board.workers)) {
      worker.online = out[worker.id]?.online === true;
    }
    return out;
  }
}
