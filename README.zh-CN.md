# dsh-work-crew

<img src="assets/hero.svg" alt="dsh-work-crew — 一个指令，一支班组" width="100%">

<p align="center">
  <a href="https://github.com/yxyusage/dsh-work-crew"><img alt="version" src="https://img.shields.io/badge/version-0.7.1-blue"></a>
  <a href="./LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-2ea44f"></a>
  <img alt="platform" src="https://img.shields.io/badge/DSH-Desktop%20%2B%20Web-6b5cff">
  <img alt="workers" src="https://img.shields.io/badge/workers-4-orange">
</p>

<p align="center"><b>一个指令。一支有纪律的本机 AI 班组。</b><br>One prompt. A working team.</p>

<p align="center">简体中文 · <a href="./README.md">English</a></p>

---

`dsh-work-crew` 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的插件：把你电脑上已经装好的
AI 软件——豆包、WorkBuddy、ZCode、Qoder——变成一支**有任务板的班组**。

DSH 只当调度者：拆任务、派单、加锁、收单、记账。代码由班组来写，DSH 不自己动手。

## 为什么需要它

一个模型自己写、自己审，是 AI 编码里最弱的一环：

| 问题 | 班组怎么解 |
|---|---|
| **自评盲区**：模型检查自己的产出 | 换一个模型来评；实现者不验收自己的活 |
| **并发打架**：一边改、一边评同一个文件 | 产物锁：`write:landing:hero` 与 `read:landing` 不可能同时进行 |
| **进度失忆**：谁在等谁，换个会话就断片 | 任务板落盘（`.dsh-team/`）：依赖、锁、时间线都在 |

## 安装

```powershell
# 从 GitHub 安装
dsh plugin --profile desktop add github:yxyusage/dsh-work-crew

# 或从本地目录安装
dsh plugin --profile desktop add "E:\path\to\dsh-work-crew"
```

装完**完全退出 DSH**（托盘 → 退出）再重新打开。

## 快速开始

```text
team_init        → 建 .dsh-team/（mission、roles、board、outbox）
team_add_task    → 标题、负责人、依赖、读写锁、验收产物
team_dispatch    → 生成简报、检查锁、投喂发送（忙时自动排队）
team_collect     → 等回执；可传多个 taskId，谁先完成返回谁
team_status      → 看板：谁在跑、排队几条、锁被谁占着
```

一个典型排班：

```
T1  实现 Hero      WorkBuddy   write:landing:hero
T2  评审落地页     豆包        read:landing         ← 等 T1（写×读互斥）
T3  产品讨论       豆包        —                    ← 与 T1 并行
T4  写文档         Qoder       write:docs           dependsOn: [T1, T2]
```

## 工具

| 工具 | 什么时候用 |
|---|---|
| `team_init` | 项目第一次用；顺便记下参考目录和必读文档 |
| `team_status` | 谁在跑、队列多长、最后活动、锁被谁占 |
| `team_add_task` | 声明负责人、依赖、锁、超时预算、验收产物 |
| `team_dispatch` | 派单；**传 taskIds 可一次派多个**；worker 忙时自动排队（不占锁、不计超时） |
| `team_collect` | 收单：传 `taskIds`，谁先完成返回谁 |
| `team_reassign` | 改派给另一个 worker，保留简报与时间线 |
| `team_reopen` | 误判完成 → 打回进行中，不重新发送 |
| `team_resubmit` | 产物补齐了 → 只重查 expect，不用重新派单 |
| `team_release` | 收尾；产物不齐时拒绝标 done |
| `team_split_html` | 把单文件 HTML 拆成 html/css/js，让三个 worker 各改一个文件、真正并行 |
| `team_shot` | 截图存盘只回路径；手机宽度用设备模拟，不会拍到"被裁切的桌面版" |
| `team_workers` | status / preflight / restart / ping |

## 四名成员

| id | 软件 | 擅长 | 调试端口 |
|---|---|---|---|
| `workbuddy` | WorkBuddy | 写代码、跑命令、验证构建 | 9332 |
| `doubao` | 豆包 | 视觉评审、创意、看截图 | 9331 |
| `zcode` | ZCode | 实现 / 第二意见（免费额度有限） | 9334 |
| `qoder` | Qoder | 实现 / 只读审计（VS Code 系） | 9335 |

## 怎么运作

- **走 CDP 驱动。** 插件带 `--remote-debugging-port` 拉起各家，直接往它的输入框里打字。窗口可以放在屏幕外，不抢鼠标。
- **完成判定是硬信号。** WorkBuddy 看「已完成」徽标；豆包 / ZCode / Qoder 看 `@@END@@` 哨兵。不靠"文字不动了"猜。
- **文件交接。** worker 把报告写进 `.dsh-team/outbox/<id>.md`，聊天里只回一行。正文不进调度者上下文——省 token 就省在这。
- **层级锁。** `landing` 覆盖 `landing:hero`；同级的 `hero` 与 `meta` 可以并行。
- **排队不是卡死。** worker 忙时任务进 `queued`：不占锁、不计超时；当前任务收单后自动顶上。
- **有预算。** `deadlineMin`（默认 45 分钟）到点标停滞，两倍时间自动 blocked 并释放锁。
- **验收产物。** `expect` 里的路径必须真实存在才算完成；`outbox/<id>.md` 会自动加进去。

## 六道闸门

从「模型说完成了」到「任务真的完成」之间，有六道检查：

| 闸门 | 作用 |
|---|---|
| `review: true` | 评审只拿到 **需求 + `git diff` + 验收标准**，并被明确要求**不要读实现者的报告**。读了实现者的叙述，就会继承他的盲区。 |
| 评审快照 | 改动文件先复制到 `.dsh-team/snapshots/<id>/`，评审读**副本**，因此不占读锁——下一个实现可以立刻开始。diff 从实现任务记录的 `baseCommit` 起算，**已提交的改动也不会漏**。 |
| `verify: "pnpm build"` | 收单前在项目里**真跑一次**验收命令。红了就 blocked——没有绿色构建，就没有 done。 |
| `risk: "high"` | 高风险改动（鉴权/支付/CI/密钥/安装器）**不能自己放行**：收单只回「待确认」，必须人再调一次 `confirm: true`。 |
| `rubric.md` + 评审轮次 | `team_init` 生成项目验收标准，评审任务自动带上；同一产物从第 4 轮评审起，简报会先问「是不是方案本身有问题」，而不是继续要补丁清单。 |
| `crossCheck: true` | 评审出问题后，再派**第二个评审者**逐条投票：成立 / 误报 / 证据不足。只留成立的。 |

## 前置条件

- Windows + DSH Desktop（或 DSH Web + Node 22+）。
- 四家里至少装一家并**已登录**。
- 每家软件里：把项目目录选成工作区，权限开"自动审批 / 完全访问"。
- 软件由插件带端口启动；已经在跑但没有调试端口的，用
  `team_workers {"action":"restart","worker":"doubao"}` 重启一次（端口掉了也用它）。

## 已知限制

- 选择器绑定各家 UI，软件大改版可能失效。每个 worker 带 `spec` 版本号，
  `team_workers {"action":"ping"}` 可以一条命令验证整条链路还通不通。
- 四家都读不到剩余额度。额度中途耗尽只能靠超时发现，再用 `team_reassign` 改派。
- 同一个软件同时只能有一个在途任务——这是单输入通道的物理限制，不是 bug。
- Kimi 桌面版不支持：它既拒绝 `--remote-debugging-port` 也拒绝 `--remote-debugging-pipe`。

## 目录

```
index.js            工具定义 + 看板数据路由 /dsh-work-crew/state
lib/team.js         任务板、锁、简报、角色表、队列
lib/cdp.js          CDP 会话、启动、投喂、读取、完成判定
client.js           侧边栏看板（React，conversation.composer.dock）
locale/             中英文元数据
```

## 许可

MIT
