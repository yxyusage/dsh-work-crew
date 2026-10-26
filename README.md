# dsh-work-crew

<img src="assets/hero.svg" alt="dsh-work-crew — one prompt, a working team" width="100%">

<p align="center">
  <a href="https://github.com/yxyusage/dsh-work-crew"><img alt="version" src="https://img.shields.io/badge/version-0.3.0-blue"></a>
  <a href="./LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-2ea44f"></a>
  <img alt="platform" src="https://img.shields.io/badge/DSH-Desktop%20%2B%20Web-6b5cff">
  <img alt="workers" src="https://img.shields.io/badge/workers-4-orange">
</p>

<p align="center"><b>One prompt. A working team.</b><br>一个指令。一支有纪律的本机 AI 班组。</p>

<p align="center"><a href="./README.zh-CN.md">简体中文</a> · English</p>

---

`dsh-work-crew` is a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that turns the AI apps already
installed on your machine — Doubao, WorkBuddy, ZCode, Qoder — into a **crew with a task board**.

DSH stays the orchestrator. It does not write your code itself; it plans, dispatches, enforces locks,
collects receipts and keeps the books. The crew does the typing.

## Why

One model reviewing its own work is the weakest link in every AI coding session:

| Failure | What the crew does instead |
|---|---|
| **Self-review blind spot** — the model checks its own output | A different model reviews it; the implementer never signs off on itself |
| **Concurrent edits** — writing and reviewing the same file at once | Artifact locks: `write:landing:hero` and `read:landing` cannot overlap in time |
| **Lost progress** — who is waiting for whom, asked again next session | A task board on disk (`.dsh-team/`) with dependencies, locks and timeline |

## Install

```powershell
# from GitHub
dsh plugin --profile desktop add github:yxyusage/dsh-work-crew

# from a local checkout
dsh plugin --profile desktop add "E:\path\to\dsh-work-crew"
```

Then fully quit DSH (tray → Quit) and reopen it.

## Quick start

```text
team_init          → create .dsh-team/ (mission, roles, board, outbox)
team_add_task      → title, worker, dependsOn, write/read locks, expect
team_dispatch      → builds a brief, enforces locks, sends it (queues when busy)
team_collect       → wait for receipts; takes taskIds, returns whoever finishes first
team_status        → board: who is running, what is queued, which locks are held
```

A typical plan:

```
T1  implement hero      WorkBuddy   write:landing:hero
T2  review landing      Doubao      read:landing        ← waits for T1 (write×read)
T3  product discussion  Doubao      —                   ← runs in parallel with T1
T4  docs                Qoder       write:docs          dependsOn: [T1, T2]
```

## Tools

| Tool | When to use |
|---|---|
| `team_init` | first time in a project; records reference dirs and required docs |
| `team_status` | who runs what, queue depth, last activity, held locks |
| `team_add_task` | declare worker, dependencies, locks, deadline, expected artifacts |
| `team_dispatch` | send a brief; queues when the worker is busy (no lock, no timeout yet) |
| `team_collect` | wait for receipts: `taskIds` returns whoever finishes first |
| `team_reassign` | move a task to another worker, keeping brief and history |
| `team_reopen` | a false completion → back to running, without re-sending |
| `team_resubmit` | artifacts now exist → re-check expect instead of re-dispatching |
| `team_release` | close a task (refuses `done` while expected artifacts are missing) |
| `team_workers` | status / preflight / restart / ping |

## Workers

| id | App | Good at | Debug port |
|---|---|---|---|
| `workbuddy` | WorkBuddy | implementing, running commands, verifying builds | 9332 |
| `doubao` | Doubao | visual review, ideas, reading screenshots | 9331 |
| `zcode` | ZCode | implementation / second opinion (limited free quota) | 9334 |
| `qoder` | Qoder | implementation / read-only audits (VS Code family) | 9335 |

## How it works

- **Driven over CDP.** The plugin launches each app with `--remote-debugging-port` and types into its chat box.
  Windows can stay offscreen; nothing steals your mouse.
- **Completion is a hard signal.** WorkBuddy's "已完成" badge; Doubao/ZCode/Qoder's `@@END@@` sentinel.
  No guessing from text stillness.
- **File handoff.** Workers write reports to `.dsh-team/outbox/<id>.md` and reply with one line.
  The body never enters the orchestrator's context — that is where the token savings come from.
- **Locks with hierarchy.** `landing` covers `landing:hero`; siblings (`hero`, `meta`) run in parallel.
- **Queue, not stuck.** A busy worker queues the task (`queued`, no locks, no timeout) and promotes it when the
  current one is collected.
- **Budget.** `deadlineMin` (default 45) flags a stalled task; at twice the budget it is blocked and its locks released.
- **Artifacts are checked.** `expect` paths must exist before a task counts as done; the outbox file is added automatically.

## Requirements

- Windows with DSH Desktop (or DSH Web + Node 22+).
- At least one of the four apps installed and **logged in**.
- In each app: select the project folder as its workspace, and allow auto-approval / full access.
- The plugin launches the apps itself; an app already running without a debug port must be restarted
  (`team_workers {"action":"restart","worker":"doubao"}`), which is also the fix when a port goes stale.

## Limits

- Selectors are tied to each app's UI. App updates can break them; every worker carries a `spec` version and
  `team_workers {"action":"ping"}` tells you whether the chain still works.
- Quota cannot be read from any of the four apps. A worker that runs out mid-task is detected by timeout and
  is meant to be re-dispatched with `team_reassign`.
- One app can hold only one in-flight task. That is a property of a single input channel, not a bug.
- Kimi desktop is not supported: it rejects both `--remote-debugging-port` and `--remote-debugging-pipe`.

## Layout

```
index.js            tools + the /dsh-work-crew/state route for the panel
lib/team.js         board, locks, briefs, roles, queue
lib/cdp.js          CDP sessions, launch, typing, reading, completion rules
client.js           sidebar panel (React, conversation.composer.dock)
locale/             zh + en metadata
```

## License

MIT
