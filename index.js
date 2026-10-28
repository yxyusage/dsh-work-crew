/**
 * dsh-work-crew — DSH as the team lead of the local AI apps.
 *
 * It contributes only deterministic primitives: a task board with ordering and
 * resource locks, a dispatch/collect pair that drives the apps over CDP, and a
 * shared `.dsh-team/` folder that survives restarts. Judgement stays with the
 * model; this plugin makes sure *who may work on what, and when* is enforced
 * rather than suggested.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Team } from './lib/team.js';
import { loadAll, select, render as renderKnowledge } from './lib/knowledge.js';
import { ask, waitAnswer, waitAnyAnswer, ensureWorker, killApp, targets, processRunning, checkReady } from './lib/cdp.js';

export const inject = ['tools', 'webServer'];

const OUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'text'],
  properties: {
    ok: { type: 'boolean' },
    text: { type: 'string' },
    data: { type: 'object' },
  },
};

const render = (_args, value) => [{ type: 'text', text: value.text }];

/**
 * Pull only the decision-relevant lines out of a report.
 * Main sessions usually need blockers and risks, not the whole table of changes.
 */
function blockersOnly(text, maxLines = 12) {
  const lines = text.split('\n');
  const picked = lines.filter((line) => /阻塞|风险|待办|未完成|缺少|失败|blocker|risk|TODO/i.test(line));
  const head = lines.slice(0, 3);
  const merged = [...new Set([...head, ...picked])].slice(0, maxLines);
  return merged.join('\n') || '（报告里没有找到阻塞/风险段落）';
}

function defineTool(name, description, properties, required, execute) {
  return {
    name,
    description,
    parameters: {
      type: 'object',
      properties,
      additionalProperties: false,
      ...(required.length ? { required } : {}),
    },
    output: { schema: OUT_SCHEMA, render },
    execute,
  };
}

const DEFAULT_MISSION = `# 项目目标

（在这里写清楚：要做什么、给谁用、什么算做完。DSH 会把这一段原文交给每个 worker。）

## 约束
- 技术栈：
- 不做什么：
- 验收标准：

## 目录约定
- 代码：
- 文档：
- 设计稿：
`;

const DEFAULT_RUBRIC = `# 验收标准（评审任务默认带上）

## 必须通过

- 改动能跑起来：构建/启动命令成功，控制台无报错。
- 需求逐条达成；每条需求都能指到具体文件或界面位置。
- 没有偷偷引入新的外部依赖、外链资源或密钥。
- 与现有代码风格、目录结构一致。

## 必须拒绝

- 声称完成，但产物（文件 / 截图）不存在的。
- 只改文案不改行为，却声称修复了逻辑问题。
- 把「我没验证」写成「已验证」。

## 输出要求

- 问题按 P0 / P1 / P2 分级，每条指到 \`文件:行号\`。
- 同类问题合并成一条；风格偏好不写。
- 最后给结论：通过 / 不通过。
`;

const DEFAULT_ROLES = `# 团队分工

| worker | 角色 | 适合的任务 | 不适合 |
|---|---|---|---|
| WorkBuddy | 实施者 | 写代码、改文件、跑命令、修 bug | 自评"我做得好" |
| 豆包 | 评审 / 创意 | 挑问题、提创新点、查设计合理性 | 直接改代码 |

## 规则
- 同一产物：写任务与评审任务互斥，必须排队。
- 讨论/创意类任务不占产物锁，可以与实现并行。
`;

export function apply(ctx) {
  const team = new Team(ctx);
  const disposers = [];

  const boardFor = async (exec) => team.board(await team.resolveDir(exec?.agent));

  const pluginRoot = path.dirname(fileURLToPath(import.meta.url));

  /**
   * Curated references for this task, rendered for the brief.
   *
   * "Make it look good" produces nothing; "look at this and here is how to apply
   * it" changes the output. Entries are matched by task tags or by keywords in
   * the task text, so authors do not have to remember to ask.
   */
  function referenceText(board, task) {
    try {
      const entries = loadAll(pluginRoot, board.dir);
      const picked = select(entries, {
        tags: task.tags || [],
        text: `${task.title} ${task.note || ''}`,
        limit: 4,
      });
      return renderKnowledge(picked);
    } catch {
      return '';
    }
  }


  /** Run a git command in the project, or return '' when this is not a repo. */
  function gitOut(board, args, timeout = 60000) {
    try {
      return execSync(`git ${args}`, { cwd: board.dir, encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'ignore'] }) || '';
    } catch {
      return '';
    }
  }

  /**
   * Which commit a review should diff from.
   *
   * Implementers usually commit. Diffing only the working tree would then show an
   * empty review, so each implementation records HEAD before it starts and the
   * review diffs from there — committed and uncommitted work both show up.
   */
  function reviewBase(board, task) {
    const overlaps = (a, b) => a === b || a.startsWith(`${b}:`) || b.startsWith(`${a}:`);
    for (let i = board.tasks.length - 1; i >= 0; i -= 1) {
      const item = board.tasks[i];
      if (item.status !== 'done' || !item.baseCommit) continue;
      if ((item.write || []).some((w) => (task.read || []).some((r) => overlaps(w, r)))) return item.baseCommit;
    }
    return '';
  }

  /** Unified diff of the change under review, capped so it fits a brief. */
  function reviewDiff(board, base) {
    const stat = base ? gitOut(board, `diff --stat ${base}`, 20000) : gitOut(board, 'diff --stat', 20000);
    const full = base ? gitOut(board, `diff ${base}`) : gitOut(board, 'diff');
    if (!full.trim()) return '';
    return `${stat.trim()}\n\n${full}`.trim().slice(0, 8000);
  }

  /**
   * Copy the changed files aside for a review.
   *
   * The review then reads an immutable snapshot instead of the live tree, so it no
   * longer needs a read lock — the next implementation can start while it reads.
   */
  function copySnapshot(board, task, base) {
    try {
      const raw = base ? gitOut(board, `diff --name-only ${base}`, 20000) : gitOut(board, 'diff --name-only', 20000);
      const names = raw.split('\n').map((line) => line.trim()).filter(Boolean).slice(0, 200);
      if (!names.length) return '';
      const dir = path.join(board.dir, '.dsh-team', 'snapshots', task.id);
      fs.rmSync(dir, { recursive: true, force: true });
      let bytes = 0;
      for (const rel of names) {
        const src = path.join(board.dir, rel);
        if (!fs.existsSync(src) || !fs.statSync(src).isFile()) continue;
        const size = fs.statSync(src).size;
        if (bytes + size > 12 * 1024 * 1024) break;
        bytes += size;
        const dest = path.join(dir, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, dest);
      }
      return fs.existsSync(dir) ? dir : '';
    } catch {
      return '';
    }
  }

  /** Send one task's brief right now (used by queue promotion and cross-check). */
  async function sendNow(board, task) {
    const worker = board.workers[task.worker];
    const base = task.review ? reviewBase(board, task) : '';
    const diff = task.review ? (task.pendingDiff ?? reviewDiff(board, base)) : '';
    const snapshotDir = task.review && task.snapshot
      ? (task.pendingSnapshot ?? copySnapshot(board, task, base))
      : '';
    delete task.pendingDiff;
    delete task.pendingSnapshot;
    const references = task.pendingReferences ?? referenceText(board, task);
    delete task.pendingReferences;
    if (snapshotDir) {
      task.snapshotDir = snapshotDir;
      task.readAdvisory = true;
    }
    const brief = team.brief(board, task, { diff, snapshotDir, reviewRound: task.reviewRound || 1, references });
    const briefFile = path.join(board.dir, '.dsh-team', 'briefs', `${task.id}.md`);
    fs.writeFileSync(briefFile, brief, 'utf8');
    team.acquireLocks(board, task);
    task.status = 'running';
    task.startedAt = new Date().toISOString();
    task.queuedAt = '';
    task.stalled = false;
    task.stalledNotified = false;
    task.brief = briefFile;
    task.error = '';
    team.event(board, 'task/dispatch', `${task.id} → ${worker.name}${snapshotDir ? '（评审快照）' : ''}`, { taskId: task.id });
    team.save(board);
    const sent = await ask(worker, brief);
    task.baseline = sent.baseline;
    team.save(board);
    return { sentVia: sent.sentVia, snapshot: !!snapshotDir };
  }


  /**
   * Dispatch one task: queue when busy, prepare review context, gate, send.
   * A function so `taskIds` can dispatch several tasks in one step — every extra
   * model step re-sends the whole conversation, which is the real cost.
   */
  async function dispatchOne(board, task, options = {}) {
    const worker = board.workers[task.worker];
    if (!worker.exe) throw new Error(`找不到 ${worker.name} 的可执行文件，请在 .dsh-team/board.json 的 workers.${task.worker}.exe 里填写路径。`);

    const busy = team.workerBusyTask(board, task.worker);
    if (busy && options.queue !== false) {
      task.status = 'queued';
      task.queuedAt = new Date().toISOString();
      const ahead = board.tasks
        .filter((item) => item.worker === task.worker && item.id !== task.id && (item.status === 'running' || item.status === 'queued'))
        .map((item) => item.id);
      team.event(board, 'task/queue', `${task.id} 排队在 ${worker.name} 后面（${ahead.join(',')}）`, { taskId: task.id });
      team.save(board);
      return `${task.id} 已排队：${worker.name} 正在跑 ${busy.id}（前面 ${ahead.length} 个）。`;
    }

    let diff = '';
    let snapshotDir = '';
    let reviewRound = 0;
    if (task.review) {
      const overlaps = (a, b) => a === b || a.startsWith(`${b}:`) || b.startsWith(`${a}:`);
      reviewRound = board.tasks.filter((item) => item.review && item.status === 'done'
        && (item.read || []).some((r) => (task.read || []).some((tr) => overlaps(r, tr)))).length + 1;
      task.reviewRound = reviewRound;
      const base = reviewBase(board, task);
      diff = reviewDiff(board, base);
      if (task.snapshot) {
        snapshotDir = copySnapshot(board, task, base);
        if (snapshotDir) {
          task.snapshotDir = snapshotDir;
          task.readAdvisory = true;
        }
      }
    } else if (task.write.length) {
      const head = gitOut(board, 'rev-parse HEAD', 10000).trim();
      if (head) task.baseCommit = head;
    }

    team.assertDispatchable(board, task);

    const warnings = [];
    const looksLikeReview = /评审|验收|review|audit/i.test(task.title);
    if (looksLikeReview && task.read.length) {
      const sameAuthor = board.tasks.find((item) => item.status === 'done' && item.worker === task.worker
        && (item.write || []).some((write) => (task.read || []).some((read) => write === read
          || write.startsWith(`${read}:`) || read.startsWith(`${write}:`))));
      if (sameAuthor) warnings.push(`${sameAuthor.id} 就是 ${worker.name} 自己实现的，自证容易走过场。`);
    }

    const ready = await checkReady(worker, board.project);
    const codeWrite = task.write.filter((ns) => !/^(discussion|docs?|review|report|notes?|briefs?)(:|$)/i.test(ns));
    if (!ready.ok && codeWrite.length) {
      throw new Error(`${worker.name} 没就绪：${ready.reason || '当前模式不能读写本地文件'}\n→ ${ready.hint || '先切工作区/权限'}`);
    }

    const holder = team.acquireChannel(task.worker, board.dir, task.id);
    if (holder) {
      throw new Error(`${worker.name} 正被另一个项目占用：${holder.project} / ${holder.taskId}。等它收单，或先对那个项目 team_release。`);
    }

    try {
      task.pendingDiff = diff;
      task.pendingSnapshot = snapshotDir;
      const sent = await sendNow(board, task);
      team.save(board);
      const notes = [];
      if (!ready.ok) notes.push(`${worker.name} 当前模式读写不到本地文件：${ready.hint}`);
      notes.push(...warnings);
      return `已派单 ${task.id} → ${worker.name}（${sent.sentVia}${snapshotDir ? '，评审读快照' : ''}）。`
        + (notes.length ? `\n⚠️ ${notes.join('\n⚠️ ')}` : '');
    } catch (error) {
      task.status = 'ready';
      task.error = error.message;
      team.releaseLocks(board, task);
      team.releaseChannel(task.worker, task.id);
      team.event(board, 'task/error', `${task.id} 派单失败：${error.message}`, { taskId: task.id });
      team.save(board);
      throw new Error(`派单失败：${error.message}`);
    }
  }

  const tools = [
    defineTool(
      'team_init',
      '初始化一个多模型协作项目：在项目目录下创建 .dsh-team/（mission.md、roles.md、board.json、briefs/、outbox/）。'
      + '开始任何多环节项目之前先调用一次。mission 会原文交给每个 worker，请写清目标、约束、验收标准。',
      {
        mission: { type: 'string', description: '项目目标与约束的 markdown 原文；省略时使用模板。' },
        project_dir: { type: 'string', description: '项目根目录；省略时使用当前会话工作目录。' },
        reference_dirs: {
          type: 'array',
          items: { type: 'string' },
          description: '参考目录（老实现、后端仓库等）。会写进每个任务的简报，要求 worker 先读再动手。',
        },
        required_docs: {
          type: 'array',
          items: { type: 'string' },
          description: '必读文档（设计规范、接口契约）。同样写进每个简报。',
        },
      },
      [],
      async (args, exec) => {
        if (args?.project_dir) team.explicitDir = path.resolve(args.project_dir);
        const dir = await team.resolveDir(exec?.agent);
        const board = team.board(dir);
        if (Array.isArray(args?.reference_dirs)) board.referenceDirs = args.reference_dirs;
        if (Array.isArray(args?.required_docs)) board.requiredDocs = args.required_docs;
        fs.mkdirSync(path.join(dir, '.dsh-team', 'briefs'), { recursive: true });
        fs.mkdirSync(path.join(dir, '.dsh-team', 'outbox'), { recursive: true });
        const missionFile = path.join(dir, '.dsh-team', 'mission.md');
        const rolesFile = path.join(dir, '.dsh-team', 'roles.md');
        if (!fs.existsSync(missionFile)) fs.writeFileSync(missionFile, args?.mission || DEFAULT_MISSION, 'utf8');
        else if (args?.mission) fs.writeFileSync(missionFile, args.mission, 'utf8');
        // roles.md must list the workers that actually exist. A stale table made
        // the model skip Qoder entirely in a real run.
        const existingRoles = fs.existsSync(rolesFile) ? fs.readFileSync(rolesFile, 'utf8') : '';
        const missingWorker = Object.keys(board.workers).some((id) => !existingRoles.includes(id));
        if (!existingRoles.trim() || missingWorker) {
          const axis = (w, cap) => (w.caps || []).includes(cap) ? '✓' : '·';
          const table = Object.values(board.workers)
            .map((w) => `| \`${w.id}\` | ${w.name} | ${axis(w, 'implement')} | ${axis(w, 'review')} | ${axis(w, 'screenshot')} | ${axis(w, 'audit')} | ${w.port} |`)
            .join('\n');
          fs.writeFileSync(rolesFile, [
            '# 团队分工与能力矩阵',
            '',
            '| id | 名字 | 实现 | 评审 | 截图 | 审计 | 端口 |',
            '|---|---|---|---|---|---|---|',
            table,
            '',
            '## 规则',
            '- 同一产物的写与读互斥；更细的命名空间（`landing:hero`）可以并行。',
            '- 同一软件同一时刻只有一个在途任务（其余进队，自动顶替）。',
            '- 实现者不验收自己的产物：写任务的人和验收任务的人要分开。',
            '- 产出默认落 `outbox/<id>.md`，聊天只回回执。',
            '- 额度无法读取：长任务前先 `team_workers ping`，失败就 `team_reassign` 改派。',
            '',
            '## 实测脾气',
            '- WorkBuddy：能跑命令、改文件、截图，慢（10~20 分钟），适合实现。',
            '- 豆包：快（1~2 分钟），适合评审/看图，不能改文件（除非开工作模式+本地电脑）。',
            '- ZCode：免费额度会中途断，长任务前先 ping。',
            '- Qoder：VS Code 系，需选工作区 + 自动审批。',
            '',
          ].join('\n'), 'utf8');
        }
        const rubricFile = path.join(dir, '.dsh-team', 'rubric.md');
        if (!fs.existsSync(rubricFile)) fs.writeFileSync(rubricFile, DEFAULT_RUBRIC, 'utf8');
        // Project-specific knowledge entries live here; they override built-ins by id.
        const knowledgeDir = path.join(dir, '.dsh-team', 'knowledge');
        if (!fs.existsSync(knowledgeDir)) fs.mkdirSync(knowledgeDir, { recursive: true });
        team.save(board);
        return {
          ok: true,
          text: `已初始化协作目录：${path.join(dir, '.dsh-team')}\n`
            + `worker：${Object.values(board.workers).map((w) => w.name).join('、')}\n`
            + '下一步：用 team_add_task 建任务（声明 dependsOn 先后顺序、write/read 产物锁）。',
          data: { dir, board: team.toJSON(board) },
        };
      },
    ),

    defineTool(
      'team_status',
      '读取协作任务板：谁在线、每个任务的状态/依赖/锁、下一步该派给谁。每次决定派单或验收前先看一眼。',
      {},
      [],
      async (_args, exec) => {
        const board = await boardFor(exec);
        await team.health(board);
        team.save(board);
        return { ok: true, text: team.statusText(board), data: team.toJSON(board) };
      },
    ),

    defineTool(
      'team_add_task',
      '往任务板加一个任务。dependsOn 表达先后顺序（上游 done 才能派）；'
      + 'write/read 声明产物锁（同名产物写×写、写×读互斥，读×读放行）。'
      + '注意：讨论/创意类任务不要声明锁，这样它能与实现并行。',
      {
        title: { type: 'string', description: '任务标题，一句话。' },
        worker: { type: 'string', description: '负责人：workbuddy / doubao / zcode / qoder。' },
        id: { type: 'string', description: '显式指定任务 id（默认按已有最大号 +1，不会复用）。' },
        note: { type: 'string', description: '派单简报正文：具体要它做什么、边界、产出要求。' },
        dependsOn: { type: 'array', items: { type: 'string' }, description: '前置任务 id 列表，例如 ["T1","T2"]。' },
        write: {
          type: 'array',
          items: { type: 'string' },
          description: '要写的产物命名空间，支持层级：landing 覆盖 landing:hero，但 landing:hero 与 landing:meta 互不冲突。',
        },
        read: { type: 'array', items: { type: 'string' }, description: '要读的产物命名空间，规则同上。' },
        deadlineMin: { type: 'integer', description: '软超时（分钟），默认 45。超过标记停滞，超过两倍自动 blocked 并释放锁。' },
        review: {
          type: 'boolean',
          description: '评审任务：简报只给需求 + git diff + 验收标准（rubric），并禁止读实现者的 outbox，避免自证与先入为主。',
        },
        snapshot: {
          type: 'boolean',
          description: '评审时把改动文件复制成快照，评审读快照、不占读锁（默认 true）。没有 git 或没有改动时自动退回读工作区。',
        },
        crossCheck: {
          type: 'boolean',
          description: '评审收单后自动建一个「交叉核验」任务，交给另一个评审者逐条判真/误报，只保留成立的。',
        },
        verify: {
          type: 'string',
          description: '验收命令（在项目目录执行，例如 "pnpm build"）。收单时先跑它，失败就 blocked、不允许 done。留空表示不跑。',
        },
        risk: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description: '风险等级，默认 medium。high（支付/鉴权/密钥/CI/安装器）必须人工确认，'
            + '收单时要传 confirm:true，插件不会自己放行。',
        },
        expect: {
          type: 'array',
          items: { type: 'string' },
          description: '验收产物路径（相对项目目录，支持目录与 * 通配）。收单时逐个检查，缺了就不算完成；'
            + 'deliver=file 时会自动把 outbox/<id>.md 加进去。',
        },
        referenceDirs: {
          type: 'array',
          items: { type: 'string' },
          description: '本任务的额外参考目录（老实现、后端仓库）。会覆盖式追加到简报的「参考目录」。',
        },
        requiredDocs: {
          type: 'array',
          items: { type: 'string' },
          description: '本任务必读的设计/契约文档路径。',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: '知识库匹配标签，例如 ["frontend","ui","motion"]。不传则按标题与简报关键词自动匹配。',
        },
        seeUi: {
          type: 'boolean',
          description: '让 worker 自己开页面、自己截图再评审。注意：实测它可能只截到桌面，界面评审优先用 image 传截图路径。'
        },
        seePath: { type: 'string', description: 'seeUi 时的页面路径，相对项目目录，默认 index.html。' },
        image: {
          type: 'string',
          description: '已截好的界面截图路径（相对项目目录或绝对路径）。'
            + '实测豆包可以直接打开本地 PNG 并读懂，因此 DSH 截图后只传路径，图片不进 DSH 上下文。'
        },
        deliver: {
          type: 'string',
          enum: ['file', 'chat'],
          description: '默认 file：worker 把正文写进 outbox/<id>.md，聊天只回 DONE，正文不进调用方上下文。'
            + 'chat：旧行为，回收时把正文摘要带回来（只在需要当场读结论时用）。'
        },
      },
      ['title', 'worker'],
      async (args, exec) => {
        const board = await boardFor(exec);
        const task = team.addTask(board, args);
        // File delivery implies a report. Requiring it in `expect` is what stopped
        // "done but no outbox" from being accepted in the second real run.
        if (task.deliver === 'file') {
          const outboxRel = `.dsh-team/outbox/${task.id}.md`;
          if (!task.expect.some((item) => item.includes(`outbox/${task.id}.md`))) task.expect.push(outboxRel);
          team.save(board);
        }
        return {
          ok: true,
          text: `已建任务 ${task.id}：${task.title} → ${board.workers[task.worker].name}`
            + `${task.dependsOn.length ? `，依赖 ${task.dependsOn.join(',')}` : ''}`
            + `${task.expect.length ? `\n验收产物：${task.expect.join('、')}` : ''}`
            + `\n下一步：team_dispatch {"taskId":"${task.id}"}`,
          data: { task: team.toJSON(board).tasks.find((t) => t.id === task.id) },
        };
      },
    ),

    defineTool(
      'team_dispatch',
      '把任务派给对应软件：生成简报、检查依赖与锁、投喂并发送。'
      + '支持一次传 taskIds 派多个（并行时省一整个来回）。worker 忙时自动排队，当前任务收单后顶上。',
      {
        taskId: { type: 'string', description: '单个任务 id（与 taskIds 二选一）。' },
        taskIds: { type: 'array', items: { type: 'string' }, description: '一组任务 id：一次派多个，各走各的锁与队列。' },
        queue: { type: 'boolean', description: 'worker 忙时是否排队，默认 true；传 false 则直接报错。' },
      },
      [],
      async (args, exec) => {
        const board = await boardFor(exec);
        const ids = Array.isArray(args?.taskIds) && args.taskIds.length
          ? args.taskIds
          : [args?.taskId].filter(Boolean);
        if (!ids.length) throw new Error('需要 taskId 或 taskIds');
        const lines = [];
        for (const id of ids) {
          const task = team.findTask(board, id);
          try {
            lines.push(await dispatchOne(board, task, args));
          } catch (error) {
            lines.push(`❌ ${id}：${error.message}`);
          }
        }
        return { ok: true, text: lines.join('\n'), data: { dispatched: ids } };
      },
    ),
    defineTool(
      'team_collect',
      '等任务收单：可以一次传多个 taskId，**谁先完成就返回谁**，不用一个个轮询。'
      + '完成了 → 落盘 outbox、释放锁、返回一行回执；都没完 → 到点返回，任务继续跑。'
      + '并行派了 N 个任务时，用它一次等，别分 N 次调。',
      {
        taskId: { type: 'string', description: '单个任务 id（与 taskIds 二选一）。' },
        taskIds: {
          type: 'array',
          items: { type: 'string' },
          description: '一组任务 id：谁先答完就返回谁，剩下的继续跑。',
        },
        waitSec: { type: 'integer', description: '本次最多等几秒；单个默认 60，多个默认 120（上限 900）。' },
        summary: {
          type: 'string',
          enum: ['none', 'blockers', 'full'],
          description: '回收内容的详略：none=只给回执（默认，文件交付时）；'
            + 'blockers=只回摘要头部 + 阻塞/风险行；full=整篇拉回（慎用）。',
        },
        summaryChars: { type: 'integer', description: '仅 full/chat 时用：摘要长度上限，默认 1200。' },
        confirm: {
          type: 'boolean',
          description: '高风险任务（risk=high）收尾时必须传 true，表示人已经确认过；不传则只报告"待确认"，不收尾。',
        },
      },
      [],
      async (args, exec) => {
        const board = await boardFor(exec);
        const ids = Array.isArray(args?.taskIds) && args.taskIds.length
          ? args.taskIds
          : [args?.taskId].filter(Boolean);
        if (!ids.length) throw new Error('需要 taskId 或 taskIds');

        const tasks = ids.map((id) => {
          const task = team.findTask(board, id);
          if (task.status === 'queued') return task;
          if (task.status !== 'running') {
            throw new Error(`${task.id} 当前状态是 ${task.status}，只有 running / queued 的任务能收取结果。`);
          }
          return task;
        });
        const queuedOnly = tasks.filter((task) => task.status === 'queued');
        const activeTasks = tasks.filter((task) => task.status === 'running');
        if (!activeTasks.length) {
          const detail = queuedOnly.map((task) => {
            const busy = team.workerBusyTask(board, task.worker);
            return `${task.id} 在 ${board.workers[task.worker].name} 排队${busy ? `（当前 ${busy.id}）` : ''}`;
          }).join('；');
          return {
            ok: true,
            text: `${detail}。排队不占锁、不计超时，前面收单后会自动开始；先收前面那个。`,
            data: { queued: true, taskIds: queuedOnly.map((task) => task.id) },
          };
        }
        const waitMs = Math.min(Math.max(args?.waitSec ?? (activeTasks.length > 1 ? 120 : 60), 5), 900) * 1000;

        const settled = await waitAnyAnswer(
          activeTasks.map((task) => ({ key: task.id, spec: board.workers[task.worker], baseline: task.baseline })),
          { timeoutMs: waitMs },
        );

        if (!settled) {
          const seconds = Math.round(waitMs / 1000);
          const notes = [];
          for (const task of activeTasks) {
            const ageMin = task.startedAt ? Math.round((Date.now() - Date.parse(task.startedAt)) / 60000) : 0;
            const deadline = task.deadlineMin || 45;
            if (ageMin >= deadline * 2) {
              // Twice the budget: stop pretending it is alive. Free the locks so the
              // rest of the plan can move, and say exactly what to do next.
              task.status = 'blocked';
              task.error = `超过 ${deadline} 分钟预算两倍，自动标记阻塞`;
              team.releaseLocks(board, task);
              team.releaseChannel(task.worker, task.id);
              team.event(board, 'task/timeout', `${task.id} 自动 blocked（${ageMin}m > ${deadline * 2}m）`, { taskId: task.id });
              notes.push(`${task.id} 已超时 ${ageMin} 分钟 → 自动 blocked、锁已释放。检查 worker 状态后可 team_reopen 重试。`);
            } else if (ageMin >= deadline && !task.stalledNotified) {
              task.stalled = true;
              task.stalledNotified = true;
              team.event(board, 'task/stalled', `${task.id} 停滞告警（${ageMin}m）`, { taskId: task.id });
              notes.push(`${task.id} 已跑 ${ageMin} 分钟（预算 ${deadline}），标为停滞。再等下去到 ${deadline * 2} 分钟会自动 blocked。`);
            }
          }
          team.event(board, 'task/poll', `${activeTasks.map((t) => t.id).join(',')} 都没结束（${seconds}s）`);
          team.save(board);
          return {
            ok: true,
            text: `${activeTasks.filter((t) => t.status === 'running').map((t) => t.id).join('、') || '（无）'} 还在生成（等了 ${seconds} 秒）。\n`
              + (notes.length ? `${notes.join('\n')}\n` : '')
              + '再等就再调一次同一个 team_collect，把没完成的 taskIds 传进来。',
            data: { running: true, taskIds: activeTasks.filter((t) => t.status === 'running').map((t) => t.id) },
          };
        }

        const task = activeTasks.find((item) => item.id === settled.key);
        const result = settled.result;

        if (!result.done && result.offline) {
          task.status = 'blocked';
          task.error = result.reason;
          team.releaseLocks(board, task);
          team.releaseChannel(task.worker, task.id);
          team.event(board, 'task/offline', `${task.id} ${result.reason}`, { taskId: task.id });
          team.save(board);
          return {
            ok: false,
            text: `${result.reason}\n任务 ${task.id} 已标记 blocked 并释放锁；拉起软件后用 team_reopen 继续。`,
            data: { taskId: task.id, offline: true },
          };
        }

        const { text, elapsedMs } = result;
        const outbox = path.join(board.dir, '.dsh-team', 'outbox', `${task.id}.md`);
        const onDisk = fs.existsSync(outbox) ? fs.readFileSync(outbox, 'utf8') : '';
        // File handoff: the body stays on disk. Only when the worker ignored the
        // instruction do we persist what it said in chat — and say so.
        const fellBack = !onDisk.trim();
        if (fellBack) fs.writeFileSync(outbox, text, 'utf8');
        const body = fellBack ? text : onDisk;

        // Declared artifacts must exist before a task counts as done. Workers
        // sometimes report success without having written the file at all.
        const missing = (task.expect || []).filter((rel) => !fs.existsSync(path.resolve(board.dir, rel)));
        if (missing.length) {
          task.status = 'blocked';
          task.error = `缺少产物：${missing.join(', ')}`;
          team.releaseLocks(board, task);
          team.releaseChannel(task.worker, task.id);
          team.event(board, 'task/missing', `${task.id} 缺少产物 ${missing.join(',')}`, { taskId: task.id });
          team.save(board);
          return {
            ok: false,
            text: `${task.id} 交了结果，但声明的产物不存在：${missing.join('、')}\n`
              + '已标记 blocked 并释放锁。确认后重派（team_reopen + team_dispatch）或先看看 worker 到底写了什么。',
            data: { taskId: task.id, missing },
          };
        }

        // Regression gate: any code task that touches a page must leave the page
        // runnable. Structure checks passed while the UI was broken, so this runs
        // the page for real: console errors, exceptions, overflow at two widths.
        const codeNamespaces = task.write.filter((ns) => !/^(discussion|docs?|review|report|notes?|briefs?)(:|$)/i.test(ns));
        let runtimeNote = '';
        if (codeNamespaces.length && fs.existsSync(path.join(board.dir, 'index.html'))) {
          try {
            const { check } = await import('./lib/runtime.js');
            const runtime = await check({ target: path.join(board.dir, 'index.html'), widths: [1440, 390] });
            task.runtimeCheck = { ok: runtime.problems.length === 0, problems: runtime.problems };
            if (runtime.problems.length) {
              task.status = 'blocked';
              task.error = `运行时检查失败：${runtime.problems[0]}`;
              team.releaseLocks(board, task);
              team.releaseChannel(task.worker, task.id);
              team.event(board, 'task/runtime', `${task.id} 运行时检查失败`, { taskId: task.id });
              team.save(board);
              return {
                ok: false,
                text: `${task.id} 的改动让页面跑不起来了：\n`
                  + runtime.problems.map((p) => ` - ${p}`).join('\n')
                  + '\n任务已 blocked、锁已释放。修完再派（同一批改动不需要拆任务，直接 team_reopen + team_dispatch）。',
                data: { taskId: task.id, runtime: false, problems: runtime.problems },
              };
            }
            runtimeNote = '\n运行时：控制台零报错、1440/390 无横向溢出。';
          } catch (error) {
            runtimeNote = `\n（运行时检查跳过：${error.message}）`;
          }
        }

        // Evidence before verdict: if the task declared an acceptance command,
        // run it. A green chat answer does not outrank a red build.
        if (task.verify) {
          let verifyOk = true;
          let tail = '';
          try {
            const out = execSync(task.verify, { cwd: board.dir, encoding: 'utf8', timeout: 300000, stdio: ['ignore', 'pipe', 'pipe'] });
            tail = String(out || '').trim().slice(-800);
          } catch (error) {
            verifyOk = false;
            tail = `${error.stdout || ''}${error.stderr || ''}`.trim().slice(-800) || error.message;
          }
          task.verifyResult = { ok: verifyOk, command: task.verify, tail };
          team.event(board, 'task/verify', `${task.id} 验收命令${verifyOk ? '通过' : '失败'}：${task.verify}`, { taskId: task.id });
          if (!verifyOk) {
            task.status = 'blocked';
            task.error = `验收命令失败：${task.verify}`;
            team.releaseLocks(board, task);
            team.releaseChannel(task.worker, task.id);
            team.save(board);
            return {
              ok: false,
              text: `${task.id} 的验收命令失败：${task.verify}\n--- 输出（尾部）---\n${tail}\n`
                + '任务已 blocked、锁已释放。修好后可以重派，或先核对是不是命令本身不对。',
              data: { taskId: task.id, verify: false, tail },
            };
          }
        }

        // High-risk work never approves itself: auth/payment/CI/secrets need an
        // explicit human confirmation, not another model's opinion.
        if (task.risk === 'high' && args?.confirm !== true) {
          team.event(board, 'task/await-approval', `${task.id} 高风险，等待人工确认`, { taskId: task.id });
          team.save(board);
          return {
            ok: false,
            text: `${task.id} 是高风险任务（${task.title}）。产物和验收都过了，但它不会自己收尾。\n`
              + '确认没问题就再调一次：team_collect {"taskId":"' + task.id + '","confirm":true}\n'
              + '不确定就先自己看一眼 diff / 运行结果，再决定要不要放行。',
            data: { taskId: task.id, awaitingApproval: true },
          };
        }

        task.outbox = outbox;
        task.status = 'done';
        task.stalled = false;
        task.finishedAt = new Date().toISOString();
        task.elapsedMs = elapsedMs;
        team.releaseLocks(board, task);
        team.releaseChannel(task.worker, task.id);
        team.event(board, 'task/done', `${task.id} 完成（${Math.round(elapsedMs / 1000)}s，${body.length} 字）`, { taskId: task.id });
        team.save(board);

        const stillRunning = activeTasks.filter((item) => item.id !== task.id).map((item) => item.id);

        // A finished task frees its worker: start whatever was queued behind it,
        // so the queue never needs a second manual dispatch.
        let promoted = '';
        const next = team.nextQueued(board, task.worker);
        if (next) {
          try {
            await sendNow(board, next);
            promoted = next.id;
          } catch (error) {
            next.status = 'queued';
            next.error = `自动开始失败：${error.message}`;
            team.save(board);
          }
        }

        // Cross-check: hand the review's findings to a second reviewer to confirm
        // or dismiss each one. Off by default; enabled per task with crossCheck.
        let crossTask = '';
        if (task.review && task.crossCheck && !task.crossChecked) {
          const verifier = Object.values(board.workers)
            .find((item) => item.id !== task.worker && (item.caps || []).includes('review'));
          if (verifier) {
            const created = team.addTask(board, {
              title: `核验：${task.title} 的问题清单`,
              worker: verifier.id,
              dependsOn: [task.id],
              review: true,
              crossCheckOf: task.id,
              note: [
                '这是一次**交叉核验**，不是重新评审。',
                `读 ${outbox}（${task.id} 的评审清单），逐条判断每个问题：`,
                '- 成立：给出证据（文件:行号 / 复现步骤）；',
                '- 误报：说明为什么；',
                '- 证据不足：说明还缺什么。',
                '最后只保留「成立」的问题，按 P0/P1/P2 重排。宁少勿滥。',
              ].join('\n'),
            });
            task.crossChecked = created.id;
            team.save(board);
            try {
              await sendNow(board, created);
              crossTask = created.id;
            } catch (error) {
              created.status = 'ready';
              created.error = `核验任务未自动派出：${error.message}`;
              team.save(board);
              crossTask = `${created.id}（已建但未派出：${error.message}）`;
            }
          }
        }

        const tail = [
          stillRunning.length ? `\n还在跑：${stillRunning.join('、')}（继续用 team_collect 收）。` : '',
          promoted ? `\n队列里的 ${promoted} 已自动开始。` : '',
          crossTask ? `\n交叉核验任务 ${crossTask} 已建${String(crossTask).includes('未派出') ? '' : '并已派出'}（另一个评审者逐条判真/假）。` : '',
        ].join('');
        if (task.deliver === 'file' && !fellBack) {
          return {
            ok: true,
            text: `${task.id} 完成，用时 ${Math.round(elapsedMs / 1000)} 秒。\n`
              + `产出已落盘：${outbox}（${body.length} 字）\n`
              + `正文没有进上下文——下游任务读这个文件即可。${runtimeNote}${tail}`,
            data: { taskId: task.id, outbox, chars: body.length, delivered: 'file', stillRunning },
          };
        }
        if (args?.summary === 'blockers') {
          return {
            ok: true,
            text: `${task.id} 完成，用时 ${Math.round(elapsedMs / 1000)} 秒，${body.length} 字（全文在 ${outbox}）。\n`
              + `--- 阻塞/风险 ---\n${blockersOnly(body)}${tail}`,
            data: { taskId: task.id, outbox, chars: body.length, delivered: 'blockers', stillRunning },
          };
        }
        const limit = Math.min(Math.max(args?.summaryChars ?? 1200, 200), 8000);
        const summary = body.length > limit ? `${body.slice(0, limit)}\n…（全文见 outbox）` : body;
        return {
          ok: true,
          text: `${task.id} 完成，用时 ${Math.round(elapsedMs / 1000)} 秒，${body.length} 字。`
            + (fellBack ? '（它没按约定写文件，下面这段是我从聊天里存的）' : '')
            + `\n全文：${outbox}\n\n--- 摘要 ---\n${summary}${tail}`,
          data: { taskId: task.id, outbox, chars: body.length, delivered: fellBack ? 'chat' : 'file', stillRunning },
        };
      },
    ),

    defineTool(
      'team_reassign',
      '把任务改派给另一个 worker：保留 brief、依赖、锁声明和产物路径，只换执行者。'
      + '额度耗尽、工作区不可用、或"实现者不该验收自己"时用它，不用新建任务、也不会丢时间线。',
      {
        taskId: { type: 'string', description: '任务 id。' },
        worker: { type: 'string', description: '新的负责人：workbuddy / doubao / zcode / qoder。' },
        note: { type: 'string', description: '改派原因，写进时间线。' },
      },
      ['taskId', 'worker'],
      async (args, exec) => {
        const board = await boardFor(exec);
        const task = team.findTask(board, args.taskId);
        const previous = task.worker;
        team.reassign(board, task, args.worker, args.note);
        return {
          ok: true,
          text: `${task.id} 已从 ${board.workers[previous].name} 改派给 ${board.workers[task.worker].name}，状态回到 ready。\n`
            + '简报、依赖、锁声明和 expect 都保留了；下一步 team_dispatch。',
          data: { taskId: task.id, from: previous, to: task.worker },
        };
      },
    ),

    defineTool(
      'team_resubmit',
      '补交：任务因为缺少产物被 blocked 时用。只重新检查 expect（不重新派单），齐了就转 done 并释放锁。',
      {
        taskId: { type: 'string', description: '任务 id。' },
        note: { type: 'string', description: '补交说明（谁补的、补了什么），写进时间线。' },
      },
      ['taskId'],
      async (args, exec) => {
        const board = await boardFor(exec);
        const task = team.findTask(board, args.taskId);
        const missing = (task.expect || []).filter((rel) => !fs.existsSync(path.resolve(board.dir, rel)));
        if (missing.length) {
          return {
            ok: false,
            text: `${task.id} 还缺：${missing.join('、')}。补齐后可以再调一次 team_resubmit。`,
            data: { taskId: task.id, missing },
          };
        }
        task.status = 'done';
        task.error = '';
        task.finishedAt = new Date().toISOString();
        team.releaseLocks(board, task);
        team.releaseChannel(task.worker, task.id);
        team.event(board, 'task/resubmit', `${task.id} 补交通过${args.note ? `：${args.note}` : ''}`, { taskId: task.id });
        team.save(board);
        return { ok: true, text: `${task.id} 的产物齐了，已转 done 并释放锁。`, data: { taskId: task.id } };
      },
    ),

    defineTool(
      'team_reopen',
      '把被误判完成的任务打回「进行中」，不重新发送。'
      + '用于软件其实还在干活（例如还在写文件），但 collect 已经提前收单的情况：打回后可以继续 collect。',
      { taskId: { type: 'string', description: '任务 id。' }, note: { type: 'string', description: '为什么打回，写进时间线。' } },
      ['taskId'],
      async (args, exec) => {
        const board = await boardFor(exec);
        const task = team.findTask(board, args.taskId);
        task.status = 'running';
        task.error = '';
        team.acquireLocks(board, task);
        team.event(board, 'task/reopen', `${task.id} 打回进行中：${args.note || '仍在生成'}`, { taskId: task.id });
        team.save(board);
        return { ok: true, text: `${task.id} 已打回「进行中」，锁重新占上。继续 team_collect 取结果。`, data: {} };
      },
    ),

    defineTool(
      'team_release',
      '手动结束一个任务（不取结果）：status=done 表示已完成并释放锁，blocked 表示卡住需要人介入。'
      + '标 done 时会先核对 expect；产物不齐会被拒绝，确要认真收尾请传 force:true。',
      {
        taskId: { type: 'string', description: '任务 id。' },
        status: { type: 'string', enum: ['done', 'blocked'], description: '默认 done。' },
        note: { type: 'string', description: '原因/交接说明，写进时间线。' },
        force: { type: 'boolean', description: '产物不齐也强制标 done（不建议）。' },
      },
      ['taskId'],
      async (args, exec) => {
        const board = await boardFor(exec);
        const task = team.findTask(board, args.taskId);
        const target = args.status === 'blocked' ? 'blocked' : 'done';
        if (target === 'done' && !args.force) {
          const missing = (task.expect || []).filter((rel) => !fs.existsSync(path.resolve(board.dir, rel)));
          if (missing.length) {
            return {
              ok: false,
              text: `${task.id} 的验收产物还缺：${missing.join('、')}\n`
                + '补齐后可以 team_resubmit 只做检查；如果就是要收尾，传 force:true。',
              data: { taskId: task.id, missing },
            };
          }
        }
        task.status = target;
        task.note = args.note || task.note;
        team.releaseLocks(board, task);
        team.releaseChannel(task.worker, task.id);
        team.event(board, `task/${task.status}`, `${task.id} ${args.note || ''}`.trim(), { taskId: task.id });
        team.save(board);
        return { ok: true, text: `${task.id} 已标记 ${task.status}，产物锁与全局通道都已释放。`, data: {} };
      },
    ),

    defineTool(
      'team_workers',
      '查看、重启或自检协作软件。'
      + 'status：端口/进程健康检查；preflight：检查每家是否处于能干活的模式（工作区/本地电脑/权限）；'
      + 'restart：关掉并带调试端口重新启动（会中断它当前正在做的事）；'
      + 'ping：发一条无害的测试消息，验证「投喂→生成→完成判定→读回」整条链路是否正常，返回往返耗时。',
      {
        action: { type: 'string', enum: ['status', 'preflight', 'restart', 'ping'], description: '默认 status。' },
        worker: { type: 'string', description: 'restart / ping 时指定：workbuddy / doubao / zcode / qoder；restart 传 all 可一次重启四家。' },
        workers: { type: 'array', items: { type: 'string' }, description: 'restart 时批量指定几家，例如 ["doubao","qoder"]。' },
      },
      [],
      async (args, exec) => {
        const board = await boardFor(exec);
        const action = args?.action || 'status';
        if (action === 'preflight') {
          const rows = [];
          const projectName = path.basename(board.dir);
          for (const worker of Object.values(board.workers)) {
            const ready = await checkReady(worker, projectName);
            rows.push({
              worker: worker.id,
              name: worker.name,
              ok: ready.ok,
              hint: ready.hint || '',
              reason: ready.reason || '',
              caps: worker.caps || [],
            });
          }
          const lines = rows.map((row) => (row.ok
            ? `- ${row.name}：✅ 可以干活（${row.caps.join(' / ') || '未标注能力'}）`
            : `- ${row.name}：❌ ${row.reason || '当前模式不能读写本地文件'}\n    → ${row.hint || '请在该软件里切换模式/工作区'}`));
          team.event(board, 'worker/preflight', rows.map((r) => `${r.worker}:${r.ok ? 'ok' : 'not-ready'}`).join(' '));
          team.save(board);
          const bad = rows.filter((row) => !row.ok).length;
          return {
            ok: bad === 0,
            text: `${bad === 0 ? `${rows.length} 家都就绪，可以派活。` : `${bad}/${rows.length} 家没就绪，派过去会读写不到文件：`}\n${lines.join('\n')}`,
            data: { rows },
          };
        }
        if (action === 'restart' || action === 'ping') {
          // restart accepts "all": four cold starts in one step instead of four.
          const restartAll = action === 'restart' && (args?.worker === 'all' || Array.isArray(args?.workers));
          const workerList = restartAll
            ? (Array.isArray(args?.workers) ? args.workers.map((id) => board.workers[id]).filter(Boolean) : Object.values(board.workers))
            : [board.workers[args?.worker]].filter(Boolean);
          const worker = workerList[0];
          if (!worker) throw new Error(`未知 worker：${args?.worker}；可用：${Object.keys(board.workers).join(', ')} 或 all`);
          if (action === 'restart') {
            const lines = [];
            let allOk = true;
            for (const item of workerList) {
              if (!item.exe) {
                lines.push(`- ${item.name}：找不到可执行文件`);
                allOk = false;
                continue;
              }
              killApp(item.exe);
              await new Promise((r) => setTimeout(r, 2000));
              let pages = 0;
              let error = '';
              try {
                await ensureWorker(item);
                pages = ((await targets(item.port)) || []).filter((t) => t.type === 'page').length;
              } catch (err) {
                error = err.message;
              }
              team.event(board, 'worker/restart', `${item.name} 已重启（端口 ${item.port}，页面 ${pages}）`);
              if (error) {
                allOk = false;
                lines.push(`- ${item.name}：启动失败（${error}）`);
              } else if (pages === 0) {
                allOk = false;
                lines.push(`- ${item.name}：端口已开但还没有页面（可能还在加载，稍后 ping 一下）`);
              } else {
                lines.push(`- ${item.name}：✅ 端口 ${item.port}，页面 ${pages}`);
              }
            }
            team.save(board);
            return {
              ok: allOk,
              text: ['重启完成：', ...lines].join('\n'),
              data: { restarted: workerList.map((item) => item.id) },
            };
          }
          // ping: a real round trip, so a broken selector or a half-finished
          // completion rule shows up here instead of in the middle of a project.
          const started = Date.now();
          await ensureWorker(worker);
          const { baseline } = await ask(worker, '连通性自检：请只回复两个字「在线」，不要做其他事。最后单独一行输出 @@END@@。');
          const result = await waitAnswer(worker, baseline, { timeoutMs: 90000 });
          const seconds = Math.round((Date.now() - started) / 1000);
          const ok = result.done && /在线/.test(result.text || '');
          team.event(board, 'worker/ping', `${worker.name} 自检${ok ? '通过' : '未通过'}（${seconds}s）`);
          team.save(board);
          return {
            ok,
            text: `${worker.name} 自检${ok ? '通过' : '未通过'}：${seconds} 秒。\n`
              + `读回内容：${(result.text || '(空)').slice(0, 80)}\n`
              + `完成信号：${result.done ? (result.degraded ? '完成（未收到哨兵，按 30 秒静止兜底）' : '已判定完成') : '超时未完成'}${result.busy ? '（仍在忙）' : ''}`,
            data: { worker: worker.id, seconds, done: result.done, text: result.text },
          };
        }
        const health = await team.health(board);
        team.save(board);
        const lines = Object.entries(health).map(([id, h]) => {
          const worker = board.workers[id];
          const note = !h.online && h.running ? '（进程在跑但没有调试端口，需 restart）' : '';
          return `- ${worker.name}：${h.online ? '在线' : '离线'}${note}，端口 ${worker.port}`;
        });
        return { ok: true, text: lines.join('\n'), data: health };
      },
    ),

    defineTool(
      'team_shot',
      '用无头浏览器截一张图，只返回文件路径（图片本身不进上下文）。'
      + '手机宽度必须用它：直接 resize 窗口会得到"被裁切的桌面版"，会误导评审。',
      {
        target: { type: 'string', description: '页面路径（相对项目目录或绝对路径）或 URL。' },
        out: { type: 'string', description: '输出 PNG 路径，相对项目目录，例如 shots/mobile-390.png。' },
        width: { type: 'integer', description: '视口宽度，默认 1440；手机用 390。' },
        height: { type: 'integer', description: '视口高度，默认 900。' },
        mobile: { type: 'boolean', description: 'true 时按移动设备模拟（DPR 2 + mobile 视口），手机宽度必须传 true。' },
        fullPage: { type: 'boolean', description: '是否截整页，默认 true。' },
      },
      ['target', 'out'],
      async (args, exec) => {
        const board = await boardFor(exec);
        const out = path.isAbsolute(args.out) ? args.out : path.join(board.dir, args.out);
        const target = path.isAbsolute(args.target) ? args.target : path.join(board.dir, args.target);
        const { capture } = await import('./lib/shot.js');
        const result = await capture({
          target,
          out,
          width: args.width ?? 1440,
          height: args.height ?? 900,
          mobile: args.mobile === true,
          fullPage: args.fullPage !== false,
        });
        team.event(board, 'shot', `${path.basename(out)} ${result.cssWidth}px${result.overflow ? ' 溢出!' : ''}`);
        team.save(board);
        return {
          ok: true,
          text: `已截图：${result.path}（${Math.round(result.bytes / 1024)} KB，视口 ${result.cssWidth}px）`
            + (result.overflow ? `\n⚠️ 检测到横向溢出：scrollWidth=${result.scrollWidth} > ${result.cssWidth}` : '')
            + '\n把路径交给评审者即可，不要让主会话去看图。',
          data: { path: result.path, bytes: result.bytes, overflow: result.overflow },
        };
      },
    ),

    defineTool(
      'team_split_html',
      '把单文件 HTML 拆成 index.html + styles.css + app.js（机械拆分，保留原内容）。'
      + '拆完才能让几个 worker 各改一个文件、真正并行；不拆就只能串行改同一个文件。',
      {
        file: { type: 'string', description: '要拆的 HTML 文件，默认 index.html。' },
        force: { type: 'boolean', description: '目标文件已存在时是否覆盖，默认 false。' },
      },
      [],
      async (args, exec) => {
        const board = await boardFor(exec);
        const file = path.join(board.dir, args?.file || 'index.html');
        if (!fs.existsSync(file)) throw new Error(`找不到 ${args?.file || 'index.html'}`);
        const cssFile = path.join(board.dir, 'styles.css');
        const jsFile = path.join(board.dir, 'app.js');
        if (!args?.force && (fs.existsSync(cssFile) || fs.existsSync(jsFile))) {
          return { ok: false, text: 'styles.css / app.js 已存在，确认要重拆请传 force:true。', data: {} };
        }
        const html = fs.readFileSync(file, 'utf8');
        const styleMatch = html.match(/<style[^>]*>([\s\S]*?)<\/style>/i);
        const scriptMatches = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
        if (!styleMatch && !scriptMatches.length) {
          return { ok: false, text: '这个 HTML 里没有内联 <style> 或 <script>，不需要拆。', data: {} };
        }
        let next = html;
        if (styleMatch) {
          fs.writeFileSync(cssFile, styleMatch[1].trim() + '\n', 'utf8');
          next = next.replace(styleMatch[0], '<link rel="stylesheet" href="styles.css">');
        }
        if (scriptMatches.length) {
          const js = scriptMatches.map((m) => m[1]).join('\n\n');
          fs.writeFileSync(jsFile, js.trim() + '\n', 'utf8');
          for (const m of scriptMatches) next = next.replace(m[0], '');
          next = next.replace('</body>', '  <script src="app.js" defer></script>\n</body>');
        }
        fs.writeFileSync(file, next, 'utf8');
        team.event(board, 'split', `${path.basename(file)} → styles.css ${fs.statSync(cssFile).size}B / app.js ${fs.existsSync(jsFile) ? fs.statSync(jsFile).size : 0}B`);
        team.save(board);
        return {
          ok: true,
          text: `已拆分：${path.basename(file)}（${Buffer.byteLength(next)} 字节）`
            + `${styleMatch ? ' + styles.css' : ''}${scriptMatches.length ? ' + app.js' : ''}。\n`
            + '接下来可以给不同 worker 分配不同的 write 命名空间（page:html / page:css / page:js）并行改。',
          data: { html: file, css: styleMatch ? cssFile : null, js: scriptMatches.length ? jsFile : null },
        };
      },
    ),

    defineTool(
      'team_check',
      '运行时验收：真的打开页面，抓控制台报错、量横向溢出、可跑一段点击冒烟脚本。'
      + '结构检查（文件存在/无外链）过了不代表页面能跑——这道闸门专治"PASS 但报错/按钮没反应"。',
      {
        target: { type: 'string', description: '页面路径或 URL，默认 index.html。' },
        widths: { type: 'array', items: { type: 'integer' }, description: '要检查的视口宽度，默认 [1440, 390]。' },
        smoke: { type: 'string', description: '可选：一段在页面里执行的 JS（如点按钮后读结果），返回值会带回来。' },
      },
      [],
      async (args, exec) => {
        const board = await boardFor(exec);
        const target = path.isAbsolute(args?.target || 'index.html')
          ? (args?.target || path.join(board.dir, 'index.html'))
          : path.join(board.dir, args?.target || 'index.html');
        const { check } = await import('./lib/runtime.js');
        const result = await check({
          target,
          widths: Array.isArray(args?.widths) && args.widths.length ? args.widths : [1440, 390],
          smoke: args?.smoke || '',
        });
        team.event(board, 'check', `${path.basename(target)} ${result.problems.length ? 'FAIL' : 'PASS'}`);
        team.save(board);
        const lines = [
          result.problems.length ? `FAIL（${result.problems.length} 项）` : 'PASS：控制台零报错、各宽度无横向溢出',
          ...result.problems.map((item) => ` - ${item}`),
        ];
        if (result.errors.length) lines.push(`控制台：${result.errors.slice(0, 3).join(' ｜ ')}`);
        lines.push(`视口：${result.widths.map((w) => `${w.width}px→scrollWidth ${w.scrollWidth}`).join('，')}`);
        if (result.smoke !== undefined) lines.push(`冒烟返回：${JSON.stringify(result.smoke).slice(0, 300)}`);
        return { ok: result.problems.length === 0, text: lines.join('\n'), data: { problems: result.problems } };
      },
    ),

    defineTool(
      'team_bundle',
      '把 styles.css 和 app.js 内联回 index.html，产出一个可以单独发走的单文件。'
      + '并行开发时拆开、交付前合并——别让"多文件"成为交付形态。',
      {
        out: { type: 'string', description: '输出文件，默认 index.html（会覆盖）。' },
      },
      [],
      async (args, exec) => {
        const board = await boardFor(exec);
        const htmlFile = path.join(board.dir, 'index.html');
        const cssFile = path.join(board.dir, 'styles.css');
        const jsFile = path.join(board.dir, 'app.js');
        if (!fs.existsSync(htmlFile)) throw new Error('找不到 index.html');
        let html = fs.readFileSync(htmlFile, 'utf8');
        const parts = [];
        // Replacement functions, not strings: a `$` in the inlined source is
        // interpreted by String.replace ("$$" → "$"), which silently corrupts code.
        if (fs.existsSync(cssFile) && /<link[^>]+styles\.css/i.test(html)) {
          const css = fs.readFileSync(cssFile, 'utf8').trim();
          html = html.replace(/<link[^>]+styles\.css[^>]*>/i, () => `<style>\n${css}\n</style>`);
          parts.push('styles.css');
        }
        if (fs.existsSync(jsFile) && /<script[^>]+app\.js/i.test(html)) {
          const js = fs.readFileSync(jsFile, 'utf8').trim();
          html = html.replace(/<script[^>]+app\.js[^>]*><\/script>/i, () => `<script>\n${js}\n</script>`);
          parts.push('app.js');
        }
        if (!parts.length) return { ok: false, text: 'index.html 里没有引用 styles.css / app.js，可能已经是单文件。', data: {} };
        const out = path.isAbsolute(args?.out || 'index.html') ? (args.out || htmlFile) : path.join(board.dir, args?.out || 'index.html');
        fs.writeFileSync(out, html, 'utf8');

        // Never trust a build you did not run: check the bundled file immediately.
        let verdict = '';
        let ok = true;
        try {
          const { check } = await import('./lib/runtime.js');
          const runtime = await check({ target: out, widths: [1440, 390] });
          if (runtime.problems.length) {
            ok = false;
            verdict = `\n⚠️ 合并后页面有问题：\n${runtime.problems.map((p) => ` - ${p}`).join('\n')}\n源文件没动，修好后重新合并。`;
          } else {
            verdict = '\n运行时：控制台零报错、1440/390 无溢出。';
          }
        } catch (error) {
          verdict = `\n（合并后检查跳过：${error.message}）`;
        }
        team.event(board, 'bundle', `合并 ${parts.join(' + ')} → ${path.basename(out)}${ok ? '' : '（失败）'}`);
        team.save(board);
        return {
          ok,
          text: `已合并：${path.basename(out)}（${Math.round(Buffer.byteLength(html) / 1024)} KB）${verdict}`,
          data: { out, parts, ok },
        };
      },
    ),

    defineTool(
      'team_knowledge',
      '协作知识库：内置的设计/写法参考（去 AI 味、界面结构、动效、空状态、字体配色、文案、可访问性）。'
      + '派单时会按任务标签自动带进简报；这里用于查看、检索、以及给项目补充自己的参考。',
      {
        action: { type: 'string', enum: ['list', 'search', 'add'], description: '默认 list。' },
        query: { type: 'string', description: 'search 时的关键词，例如「动效」「文案」。' },
        id: { type: 'string', description: 'add 时的条目 id，例如 brand-guide。' },
        title: { type: 'string', description: 'add 时的标题。' },
        tags: { type: 'array', items: { type: 'string' }, description: 'add 时的匹配标签。' },
        url: { type: 'string', description: 'add 时的参考链接。' },
        use: { type: 'string', description: 'add 时的一句话用法。' },
        avoid: { type: 'string', description: 'add 时的一句话禁忌。' },
        rules: { type: 'array', items: { type: 'string' }, description: 'add 时的规则条目（每条一行）。' },
      },
      [],
      async (args, exec) => {
        const board = await boardFor(exec);
        const action = args?.action || 'list';
        if (action === 'add') {
          const id = String(args?.id || '').trim();
          if (!/^[a-z0-9-]{2,40}$/i.test(id)) throw new Error('id 只能是字母数字和短横线（2~40 位），例如 brand-guide');
          const dir = path.join(board.dir, '.dsh-team', 'knowledge');
          fs.mkdirSync(dir, { recursive: true });
          const lines = [
            `# ${id}`,
            `title: ${args?.title || id}`,
            `tags: ${(args?.tags || []).join(', ')}`,
            `url: ${args?.url || ''}`,
            `use: ${args?.use || ''}`,
            `avoid: ${args?.avoid || ''}`,
            '',
            ...(args?.rules || []).map((rule) => `- ${rule}`),
            '',
          ];
          fs.writeFileSync(path.join(dir, `${id}.md`), lines.join('\n'), 'utf8');
          team.event(board, 'knowledge/add', `${id} 加入项目知识库`);
          team.save(board);
          return { ok: true, text: `已写入 .dsh-team/knowledge/${id}.md，之后匹配到标签的任务会自动带上。`, data: { id } };
        }
        const entries = loadAll(pluginRoot, board.dir);
        if (action === 'search') {
          const picked = select(entries, { text: String(args?.query || ''), limit: 5 });
          if (!picked.length) return { ok: true, text: `没有匹配「${args?.query || ''}」的条目。用 list 看全部。`, data: { count: 0 } };
          return { ok: true, text: renderKnowledge(picked, { maxRules: 2 }), data: { count: picked.length } };
        }
        const lines = entries.map((entry) => `- ${entry.id}｜${entry.title}｜tags: ${entry.tags.join(',')}${entry.url ? `｜${entry.url}` : ''}`);
        return { ok: true, text: `${entries.length} 条：\n${lines.join('\n')}\n\n项目专属条目放 .dsh-team/knowledge/，与内置条目按 id 覆盖。`, data: { count: entries.length } };
      },
    ),
  ];

  for (const definition of tools) {
    disposers.push(ctx.tools.register(definition));
  }

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-work-crew/state',
    handler: async (_req, res) => {
      try {
        // Most recently touched project first: the panel shows boards[0].
        const boards = [...team.dirs.values()]
          .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
          .map((board) => team.toJSON(board));
        const health = {};
        for (const board of team.dirs.values()) {
          const one = await team.health(board);
          Object.assign(health, one);
        }
        const payload = JSON.stringify({ ok: true, boards, health, now: new Date().toISOString() });
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(payload);
      } catch (error) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: error.message }));
      }
    },
  }));

  // A short nudge so the model reaches for the team instead of doing everything
  // itself. Tools alone are discoverable but easy to ignore; this is ~120 tokens.
  const systemPrompt = ctx.get('systemPrompt');
  if (systemPrompt) {
    disposers.push(systemPrompt.section({
      name: 'dsh-work-crew',
      order: 60,
      text: [
        '多模型协作（dsh-work-crew 已安装）：当任务需要在几个本机 AI 软件之间分工时（写代码 / 评审 / 写文档 / 看图评审），用 team_* 工具调度，不要自己全做。',
        '流程：team_status 看板 → team_add_task（声明 dependsOn 与 write/read 产物锁）→ team_dispatch 派单 → team_collect（传 taskIds 批量等，谁先完成返回谁）。',
        '产出默认写在 outbox 文件里，不要把正文拉回聊天；界面评审用 image 传截图路径，让 worker 自己打开图看。',
        '约束：同一软件同时只能有一个在途任务；同一产物的写与读互斥；开工前用 team_workers preflight 确认各家工作区就绪。',
      ].join('\n'),
    }));
  }

  ctx.effect(() => () => {
    for (const dispose of disposers) {
      try { dispose(); } catch { /* already gone */ }
    }
  });
}
