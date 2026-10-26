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
import { Team } from './lib/team.js';
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
          const table = Object.values(board.workers)
            .map((w) => `| \`${w.id}\` | ${w.name} | ${w.role} | ${w.port} |`)
            .join('\n');
          fs.writeFileSync(rolesFile, [
            '# 团队分工',
            '',
            '| id | 名字 | 角色 | 端口 |',
            '|---|---|---|---|',
            table,
            '',
            '## 规则',
            '- 同一产物的写与读互斥；更细的命名空间（`landing:hero`）可以并行。',
            '- 同一软件同一时刻只有一个在途任务。',
            '- 产出默认落 `outbox/<id>.md`，聊天只回回执。',
            '',
            '## 实测脾气',
            '- WorkBuddy：能跑命令、改文件，慢（10~20 分钟），适合实现。',
            '- 豆包：快（1~2 分钟），适合评审/看图，不能改文件（除非开工作模式+本地电脑）。',
            '- ZCode：免费额度会中途断，长任务前先 ping。',
            '- Qoder：VS Code 系，需选工作区 + 自动审批。',
            '',
          ].join('\n'), 'utf8');
        }
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
      + 'worker 正忙时自动排队（status=queued，不占锁、不开始计时），当前任务收单后自动顶上。'
      + '实现类任务（有 write）在软件工作区未就绪时直接拒绝，不会派出去才发现白跑。',
      {
        taskId: { type: 'string', description: '任务 id，例如 T1。' },
        queue: { type: 'boolean', description: 'worker 忙时是否排队，默认 true；传 false 则直接报错。' },
      },
      ['taskId'],
      async (args, exec) => {
        const board = await boardFor(exec);
        const task = team.findTask(board, args.taskId);
        const worker = board.workers[task.worker];
        if (!worker.exe) throw new Error(`找不到 ${worker.name} 的可执行文件，请在 .dsh-team/board.json 的 workers.${task.worker}.exe 里填写路径。`);

        // A busy worker means "queued", not "stuck". Hiding this cost a real run
        // ten minutes of confusion.
        const busy = team.workerBusyTask(board, task.worker);
        if (busy && args?.queue !== false) {
          task.status = 'queued';
          task.queuedAt = new Date().toISOString();
          const ahead = board.tasks
            .filter((item) => item.worker === task.worker && item.id !== task.id && (item.status === 'running' || item.status === 'queued'))
            .map((item) => item.id);
          team.event(board, 'task/queue', `${task.id} 排队在 ${worker.name} 后面（${ahead.join(',')}）`, { taskId: task.id });
          team.save(board);
          return {
            ok: true,
            text: `${task.id} 已排队：${worker.name} 正在跑 ${busy.id}。\n`
              + `前面还有 ${ahead.length} 个（${ahead.join('、')}）。排队不占锁、不计超时，当前任务收单后自动开始。`,
            data: { taskId: task.id, queued: true, ahead },
          };
        }

        team.assertDispatchable(board, task);

        // Implementation tasks need a real workspace; a chat-mode app would answer
        // confidently while writing nothing.
        const ready = await checkReady(worker, board.project);
        if (!ready.ok && task.write.length) {
          throw new Error(`${worker.name} 没就绪，拒绝派实现任务：${ready.reason || '工作区未选中'}\n→ ${ready.hint || '先切工作区/权限'}`);
        }

        // Machine-wide channel lock: one app, one typist — across projects too.
        const holder = team.acquireChannel(task.worker, board.dir, task.id);
        if (holder) {
          throw new Error(
            `${worker.name} 正被另一个项目占用：${holder.project} / ${holder.taskId}（自 ${holder.since}）。\n`
            + '同一个软件同一时刻只能被一个任务投喂，否则两边输入会串。等它收单，或先对那个项目 team_release。',
          );
        }

        const brief = team.brief(board, task);
        const briefFile = path.join(board.dir, '.dsh-team', 'briefs', `${task.id}.md`);
        fs.writeFileSync(briefFile, brief, 'utf8');

        team.acquireLocks(board, task);
        task.status = 'running';
        task.startedAt = new Date().toISOString();
        task.stalled = false;
        task.stalledNotified = false;
        task.brief = briefFile;
        team.event(board, 'task/dispatch', `${task.id} → ${worker.name}`, { taskId: task.id });
        team.save(board);

        try {
          const { baseline, sentVia } = await ask(worker, brief);
          task.baseline = baseline;
          task.error = '';
          team.save(board);
          const warning = ready.ok
            ? ''
            : `\n⚠️ ${worker.name} 当前模式读写不到本地文件：${ready.hint}\n`;
          return {
            ok: true,
            text: `已派单 ${task.id} → ${worker.name}（发送方式 ${sentVia}，端口 ${worker.port}）。\n`
              + `简报：${briefFile}\n`
              + `${warning}`
              + `下一步：team_collect {"taskId":"${task.id}"} 取回结果（生成通常需要 30 秒~数分钟）。`,
            data: { taskId: task.id, worker: worker.id, ready: ready.ok },
          };
        } catch (error) {
          task.status = 'ready';
          task.error = error.message;
          team.releaseLocks(board, task);
          team.releaseChannel(task.worker, task.id);
          team.event(board, 'task/error', `${task.id} 派单失败：${error.message}`, { taskId: task.id });
          team.save(board);
          throw new Error(`派单失败：${error.message}`);
        }
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
            const nextBrief = team.brief(board, next);
            const nextBriefFile = path.join(board.dir, '.dsh-team', 'briefs', `${next.id}.md`);
            fs.writeFileSync(nextBriefFile, nextBrief, 'utf8');
            team.acquireLocks(board, next);
            next.status = 'running';
            next.startedAt = new Date().toISOString();
            next.queuedAt = '';
            next.brief = nextBriefFile;
            next.error = '';
            team.event(board, 'task/promote', `${next.id} 从队列开始`, { taskId: next.id });
            team.save(board);
            const sent = await ask(board.workers[next.worker], nextBrief);
            next.baseline = sent.baseline;
            team.save(board);
            promoted = next.id;
          } catch (error) {
            next.status = 'queued';
            next.error = `自动开始失败：${error.message}`;
            team.save(board);
          }
        }

        const tail = [
          stillRunning.length ? `\n还在跑：${stillRunning.join('、')}（继续用 team_collect 收）。` : '',
          promoted ? `\n队列里的 ${promoted} 已自动开始。` : '',
        ].join('');
        if (task.deliver === 'file' && !fellBack) {
          return {
            ok: true,
            text: `${task.id} 完成，用时 ${Math.round(elapsedMs / 1000)} 秒。\n`
              + `产出已落盘：${outbox}（${body.length} 字）\n`
              + `正文没有进上下文——下游任务读这个文件即可。${tail}`,
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
      '手动结束一个任务（不取结果）：status=done 表示已完成并释放锁，blocked 表示卡住需要人介入。',
      {
        taskId: { type: 'string', description: '任务 id。' },
        status: { type: 'string', enum: ['done', 'blocked'], description: '默认 done。' },
        note: { type: 'string', description: '原因/交接说明，写进时间线。' },
      },
      ['taskId'],
      async (args, exec) => {
        const board = await boardFor(exec);
        const task = team.findTask(board, args.taskId);
        task.status = args.status === 'blocked' ? 'blocked' : 'done';
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
        worker: { type: 'string', description: 'restart / ping 时指定：workbuddy / doubao / zcode。' },
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
            });
          }
          const lines = rows.map((row) => (row.ok
            ? `- ${row.name}：✅ 可以干活`
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
          const worker = board.workers[args?.worker];
          if (!worker) throw new Error(`未知 worker：${args?.worker}；可用：${Object.keys(board.workers).join(', ')}`);
          if (action === 'restart') {
            if (!worker.exe) throw new Error(`找不到 ${worker.name} 的可执行文件。`);
            killApp(worker.exe);
            await new Promise((r) => setTimeout(r, 2500));
            await ensureWorker(worker);
            // The port may answer before any page target exists; never assume a list.
            const list = (await targets(worker.port)) || [];
            const pages = list.filter((t) => t.type === 'page').length;
            team.event(board, 'worker/restart', `${worker.name} 已重启（端口 ${worker.port}，页面 ${pages}）`);
            team.save(board);
            if (pages === 0) {
              return {
                ok: false,
                text: `${worker.name} 端口已开，但还没有可用的页面（可能还在加载）。等 10 秒再 ping ${worker.id}，或手动看一眼它是否卡在登录页。`,
                data: { pages },
              };
            }
            return { ok: true, text: `${worker.name} 已带调试端口重启，页面目标 ${pages} 个。`, data: { pages } };
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
