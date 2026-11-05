# 事件驱动架构调研：面向角色进程隔离与 agent 异构

## 0. 摘要（结论先行）

本文研究对象是 `dsh-superagent` 原型的事件驱动实现，服务目标不是复刻原型，而是回答：当 router、worker、watchdog 可以是不同实现、不同厂商的 agent，且三者可以运行在不同进程时，事件驱动系统应该保留什么、替换什么、新增什么。

结论如下。

1. **原型的可迁移内核不是 Cordis 事件，也不是 DSH Session，而是“域事务 + 持久副作用队列 + 确定性准入”。** 触发器落库、准入、Decision、Ticket、Assignment 与副作用入队都在同一个 SQLite 事务里完成；跨角色的评估投递、执行启动、输入投递和外部回复则全部落到持久队列里重试。这条边界比“Session 即 agent”更稳定。
2. **角色应该按“谁拥有事实”切分，而不是按“谁在运行”切分。** Source 拥有外部世界的事实，Engine 拥有授权与工作单元的事实，Assessor 产生判断，Executor 执行并回报事实。进程隔离沿这条线切才有意义；沿 Session 切只会把同一套耦合换成网络耦合。
3. **当前形态确实是 daemon-first。** 主 Session 在初始化中被急切创建（`src/app/runtime.ts:210`），评估投递目标写死为主 Session（`src/app/runtime.ts:131-133`），判断只以主 Session 的工具协议存在（`src/app/tools/main.ts:202-220`），通知只能 steer 到已存在的 agent（`src/app/sessions.ts:104-105`）。因此“没有 Router agent 就没有评估”是结构性的，不是配置问题。
4. **Assessor 端口的“接缝”已经存在，但端口没有闭合。** `Assessor` 只有 `request` / `release`（`src/core/ports.ts:49-53`），判定结果从主 Session 的 `orchestrator_eval_decide` 工具回写（`src/app/tools/main.ts:214-220`）。要做可插拔 Assessor，第一刀不是换模型，而是把 `decide`、取消、租约与身份纳入协议。
5. **DSH 的 `steer` / `followup` / `inject` 是适配器内部语义，不应进入跨进程协议。** 跨进程协议只应表达“向某个工作单元追加一条带幂等键的输入”，以及“这条输入在下一轮、下一步还是仅上下文生效”；具体怎么映射由 DSH 适配器决定。DSH 的三段语义见 `/Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness/packages/core/agent/src/runtime-types.ts:215-241`。
6. **必须同步完成的只有授权事实和工作单元事实；跨角色投递和外部副作用都可以异步。** 具体边界见 §3。把 gate、域事务、Ticket+Mandate 创建拆成远程调用，收益为负。
7. **进程隔离真正新增的是协议能力，不是线程/进程数量：** 跨进程事件总线、执行节点注册与租约、四类幂等键、deadline 与心跳、失败与“结果未知”的区分、按角色拆权限域。没有这六样，拆进程只会得到更难排查的分布式单体。
8. **事件事实与投递状态必须分成两层。** 同一个事件可能投给 Router、多个 Worker、审计与 watchdog；持久化、路由、接受、领取、处理是五个不同状态，任一层的成功都不能当作下一层完成。原型已有 `Trigger`、`Input`、`inputsDelivered` / `inputsRead` 的雏形，但缺少按消费者记录的通用投递表。〔外部材料主张 + 原型 + 判断〕
9. **建议分三阶段：P0 协议闭合（`AssessorService` + 事件日志/投递表，仍单进程，保留 eager Router）；P1 队列、租约、节点注册服务化并允许 Router 缺席；P2 角色进程拆分与异构适配器。** 先把协议写对，再拆进程；把“Router 可缺席”放在 P1，是因为协议未闭合时移除 eager ensure 的失败面过大。

一句话结论：**先协议化，再进程化；保留“事务 + 持久队列 + 纯函数准入”的内核，把 Session、投递语义和权限绑定留在 DSH 适配器里。**

**范围与文档关系：** 本文记录 `dsh-superagent` 原型的现状核对与迁移分析，是上游材料；后续整体设计见 [super-agent-architecture-design.md](./super-agent-architecture-design.md)（该文档 §1.2 也以本文为输入）。两份文档冲突时以架构设计文档为准，并应回改本文。**§6.9 / §7.4 关于 `policyVersion` 的结论已按源码复核更正**：原型在 `decideEval` 已比对版本（`src/core/evals.ts:284-288`），`policyChanged` 会主动重排活跃 Eval（`:218-221`）；缺口是合并窗口、重判上限、lease/attempt fencing 与饥饿可观测。处置协议以架构文档 §5.3、§13.2 为准。

## 目录

- §1 证据等级与核查方法
- §2 原型的事件驱动全貌：启动时序、事件到执行、常驻/按需、重启恢复
- §3 同步/异步边界：什么必须同步，什么可以异步
- §4 角色无关协议不变量 vs DSH 专有实现：订阅分层、异构适配层、webhook 边界
- §5 daemon-first：八个耦合点与分阶段改造
- §6 进程隔离的新要求：总线、租约、幂等、deadline、失败分类、权限、审计、事件日志/投递、watchdog 输入
- §7 Assessor 瓶颈：四种形态、三步重构与结果合同、权属澄清
- §8 不要为了进程隔离把所有东西都拆成进程
- §9 局限与未验证项
- §10 目标形态与 P0/P1/P2
- §11 关键引用索引

## 1. 证据等级与核查方法

全文严格区分四类证据，正文用标签标注：

| 标签 | 含义 | 本文写法 |
| --- | --- | --- |
| 〔原型〕（原型实现） | 本仓库 `dsh-superagent-prototype` 中可直接复核的实现 | 给 `file:line`，必要时给短引用 |
| 〔DSH〕（DSH 已有能力） | DSH 仓库 `deepseek-harness` 已提供的能力 | 给绝对路径与行号，不用相对链接 |
| 〔判断〕（本文分析判断） | 本文基于前两类证据做出的分析、取舍或结论 | 明确写成判断，不冒充实现 |
| 〔设想〕（文章设想） | 本文提出、尚未在原型或 DSH 中落地的设计 | 明确写成建议 |
| 〔推断〕 | 代码可解释但未做运行验证的结论 | 在〔判断〕内额外标注 |

另设一个来源标记 **〔外部材料主张〕**，它不是第五类证据，而是出处标签：表示该说法来自 [分享页“调研Agent事件订阅”](https://chatgpt.com/share/6aeb76b7-8874-83ea-a742-75434a6ce4bf)，读取日期 2026-11-05。凡涉及本原型、DSH 或开源实现的断言，本文都回到代码/文档核对：核对后归入〔原型〕/〔DSH〕/〔判断〕；核对不符写“外部材料在此处失准”；无法核对写“无法核实”。页面正文约 9.6 万字符，含多轮回答；与本文无关的厂商产品综述不纳入。

核查方式：先按任务给定线索定位，再逐处复核源码。任务描述与源码行号有偏差的地方以源码为准。例如 GitHub 游标推进的实际位置是 `src/sources/github.ts:225-244` 与 `src/sources/github.ts:372`，而不是 127-146；127-146 是轮询主循环。

需要特别说明：**watchdog 在原型中不存在。** 仓库只有 Source 的轮询循环和健康看板，没有独立 watchdog 角色。因此本文关于 watchdog 的部分全部属于〔设想〕，不能引用原型行为当作证据。

## 2. 原型的事件驱动全貌

### 2.1 启动时序：agent 依赖发生在哪一步

初始化入口是 `Runtime.initialize()`（`src/app/runtime.ts:201-218`）。按发生顺序：

| # | 步骤 | 等待方式 | 是否依赖 agent | 证据 |
| --- | --- | --- | --- | --- |
| 1 | 创建 stateDir、加文件锁、打开 SQLite | 同步 | 否 | `src/app/runtime.ts:91-98` |
| 2 | 构造 Sessions / Executor / Assessor / Outbox / Engine / Passes；注册 assessment、launch、relay、notice 等 effect handler | 同步 | 否 | `src/app/runtime.ts:121-158` |
| 3 | 注册管理 HTTP 路由 | 同步 | 否 | `src/app/runtime.ts:203` |
| 4 | `setup.run()`；未完成则标记 `paused/setupPending` 并直接 return | await | 否 | `src/app/runtime.ts:204-207` |
| 5 | `sessions.install()`、`executor.install()` 订阅 DSH 进程内事件 | 同步 | 否 | `src/app/runtime.ts:208-209` |
| 6 | **`await sessions.ensure(masterId, ...)` 急切创建主 Session** | await | **是** | `src/app/runtime.ts:210` |
| 7 | 逐项同步 Source 成员列表 | await | 否 | `src/app/runtime.ts:211` |
| 8 | 关闭检查 | 同步 | 否 | `src/app/runtime.ts:213` |
| 9 | `executor.resume()`：中断 running、重排 pending | 同步入队 | 否（launch 之后才需要 agent） | `src/app/runtime.ts:214`；`src/executor/dsh.ts:519-537` |
| 10 | `passes.start()`：启动 2 秒定时器 | 同步 | 否 | `src/app/runtime.ts:215`；`src/app/passes.ts:28` |
| 11 | `effects.start()`：开始派发持久副作用 | 同步 | 否 | `src/app/runtime.ts:216` |
| 12 | 标记 `ready` | 同步 | 否 | `src/app/runtime.ts:217` |

这张表最重要的两行是 6 和 11。

- 第 6 行把“创建 Router agent”放在“启动事件泵”之前，并且是 `await`。主 Session 的创建失败或变慢，会直接推迟第 10、11 行。〔原型〕
- 第 11 行最后才启动 effect 派发。因此初始化过程中排队的 assessment、launch、relay 都不会提前投递，必须等主 Session 建好。〔原型〕
- 唯一的“无 agent 运行态”是 setup 未完成时的早退（`src/app/runtime.ts:204-207`）：路由已注册、事件仍可落库，但不装事件钩子、不启泵、不评估。注意这不是“可运行的降级态”，而是“等待重启的暂停态”。〔原型〕
- `masterId` 由 `store.get(KV.runtime.masterId) ?? orchestrator-${key(stateDir)}` 生成并持久化（`src/app/runtime.ts:104-105`）。身份是“安装目录哈希”，不是可注册、可迁移的角色身份；多节点场景需要替换。〔判断〕

### 2.2 事件到执行的完整时序

下表把一次“外部事件 → 工单执行”的链路按步骤拆开，并标明完成方式、事务/队列边界和失败后果。

| # | 动作 | 完成方式 | 事务 / 队列 | 失败后果 | 证据 |
| --- | --- | --- | --- | --- | --- |
| 1 | Source 拉取外部事件，`await ctx.receive(trigger)`，成功后才推进游标 | 同步等待 | Engine 事务 | 抛错则游标不动，下次重放；Trigger id 去重兜底 | `src/sources/host.ts:41-42`；`src/sources/github.ts:225-244`；`src/sources/github.ts:372`；`src/core/intake.ts:23` |
| 2 | Intake：落 Trigger、范围过滤、Thread 关联、Subscription 扇出、排队 Eval | 同步 | 单个 `repo.atomic` | 整体回滚，不产生半个事件 | `src/core/engine.ts:48`；`src/core/intake.ts:19-61` |
| 3 | `passes.receive()` 成功后立即踢一拍 | 异步合并 | 进程内串行 pass | 失败只进 health，下一拍重试 | `src/app/passes.ts:34-46`；`src/app/passes.ts:56-62` |
| 4 | 确定性 gate：`policy.gate` 纯函数，不调模型 | 同步 | 与建 Eval 同一事务 | 返回不可准入则记 Decision，不产生模型调用 | `src/core/evals.ts:96`；`src/policy.ts:191-211` |
| 5 | 建 Eval、写 deadline、发 `eval.started`、`assessor.request()` | 同步写持久队列 | 业务写 + `effect` 行同一事务 | 行持久化，重启后重试 | `src/core/evals.ts:107-118`；`src/app/effects.ts:61-66` |
| 6 | `assessment` effect：组卡并 steer 给主 Session，成功后设置 `delivered` 与 deadline | 异步、有界并发、退避 | 持久 effect；`candidate:<evalId>` 去重 | 退避重试；`paused` 时挂起；deadline 原型从 `delivered` 起算，目标形态从 claim 起算（见 §6.4） | `src/app/assessment.ts:96-101`；`src/app/effects.ts:70`；`src/app/effects.ts:130-145` |
| 7 | Router 的 turn 调 `orchestrator_eval` / `_read` / `_decide` / `orchestrator_route` | 模型驱动，时长不可控 | 每次工具调用各自开事务 | 超过 deadline 后 expire，重排队最多 2 次，然后 `unavailable` | `src/app/tools/main.ts:202-220`；`src/core/evals.ts:35-69` |
| 8 | accept：同事务建 Ticket + Mandate + Subscription + 首 Assignment + 回执 + launch effect | 同步 | 单事务 | 整单回滚，不会出现“有工单无授权” | `src/core/tickets.ts:37-56` |
| 9 | `launch` effect：准备目录、按需创建 `worker-<ticketId>` Session、以 JSON 下发任务 | 异步、受 worker 槽限制、退避 5s→300s | 持久 effect | `Later` 不计失败；真失败记 ticket failed，等人或重试 | `src/executor/dsh.ts:263-285`；`src/executor/dsh.ts:424-470` |
| 10 | 输入投递：把 waiting inputs 依次 steer 给运行中的 worker | 异步、有界并发 | 持久 `delivery` effect | 失败记录在 ticket 上，不乱报 effect 健康 | `src/executor/dsh.ts:290-343`；`src/executor/dsh.ts:234-235` |
| 11 | 外部回复：写 receipt，再排队 reply effect | 异步、按会话顺序 | receipt + effect | receipt 防重复；外部结果可能未知 | `src/app/outbox.ts:26-51` |
| 12 | 域事件通知：`emit` 在事务内触发，实际投递走 effect | 同步入队、异步投递 | `notify` = inject；`relay` = steer | 重启后由 effect 重试 | `src/app/runtime.ts:138-153`；`src/app/sessions.ts:104-105`；`src/app/sessions.ts:171-186` |

由此可以画出边界：

- **同步边界 = 事实与授权。** 事件的落库、准入、Decision、Ticket/Mandate、Assignment 状态、副作用入队，都不能跨进程拆成“先写 A 再通知 B”。一旦拆开，崩溃窗口会制造“有工单无授权”或“有授权无工单”。
- **异步边界 = 跨角色投递与外部副作用。** 评估投递、启动、输入投递、通知、回复都可以从持久状态重建，因此可以 at-least-once 重试。
- 原型的 effect 队列已经具备持久化、按 kind 限流、退避、有序、暂停等能力（`src/app/effects.ts:46-160`），但派发仍是进程内 `queueMicrotask`（`src/app/effects.ts:84-88`）。这是后续服务化的起点。 〔原型 + 判断〕

### 2.3 常驻 vs 按需

| 类别 | 内容 | 生命周期 | 证据 |
| --- | --- | --- | --- |
| 常驻 | Host 进程、Cordis 容器、Runtime、stateDir 文件锁、SQLite | 进程级 | `src/app/runtime.ts:91-98` |
| 常驻 | 主 Session（Router agent） | 进程启动即创建，直到 shutdown | `src/app/runtime.ts:210`、`src/app/runtime.ts:230-252` |
| 常驻 | 2 秒 pass 定时器 | 进程级 | `src/app/passes.ts:28` |
| 常驻 | effect 派发器（事件驱动，无固定周期） | 进程级 | `src/app/effects.ts:83-88` |
| 常驻 | GitHub 轮询循环 | 进程级 | `src/sources/github.ts:127-146` |
| 常驻 | 管理 HTTP 路由 / loopback HTTP | 进程级 | `src/app/runtime.ts:203` |
| 常驻 | Feishu 轮询循环 | 进程级 | `src/sources/feishu-loops.ts:143-159` |
| 按需 | worker Session 与工作目录 | 首次 launch 创建，随 ticket | `src/executor/dsh.ts:441`；`src/executor/dsh.ts:23-26` |
| 按需 | worker 内部 subagent、shell job | 由 worker 的 turn 派生 | `src/app/sessions.ts:61-62`；`docs/003-execution.md:24-34` |
| 按需 | Ticket / Assignment / Effect / Receipt 行 | 持久，但有生命周期 | `src/core/tickets.ts:37-56`；`src/app/effects.ts:61-66` |
| 按需 | `prepare` 命令、`gh` / `lark-cli` 子进程 | 每次调用派生，短生命周期 | `src/executor/dsh.ts:247-261`；`src/infra/commands.ts:2`、`src/infra/commands.ts:70` |

有两个容易误判的点：

- **Feishu 的 `lark-cli` 不是常驻子进程。** 它是 `execFile` 按命令派生的短进程（`src/infra/commands.ts:2`、`src/infra/commands.ts:70`）。常驻的是它的轮询循环，不是 CLI 本身。 〔原型〕
- **主 Session 是常驻中的“异类”。** 它既是常驻资源，又是唯一的评估入口；worker 可以按需创建，Assessor 却不能按需缺席。这是 daemon-first 的直接体现。 〔判断〕

### 2.4 重启恢复：已经做到的与只是推断的

已经做到的：

- `executor.resume()` 会中断所有 running Assignment，重新排队 pending 的 launch；被中断的 Assignment 会以 `RECOVERY_NOTE` 重启（`src/executor/dsh.ts:519-537`；`src/core/assignments.ts:21`、`src/core/assignments.ts:83-92`；`src/core/tickets.ts:317-327`）。
- `RECOVERY_NOTE` 要求 worker 先核对 worktree、git 历史、GitHub 状态再继续，并避免重复已完成的外部操作（`src/core/assignments.ts:21`）。这是提示词级的对账，不是协议级的对账。 〔原型 + 判断〕
- effect 行全部在 SQLite 里，重启后按 due 重试；默认退避上限 60 秒，`launch` 与 `reply` 的上限是 300 秒（`src/app/effects.ts:70`、`src/app/effects.ts:141`；`src/executor/dsh.ts:233`；`src/app/outbox.ts:24`）。
- 消息投递用 `requestId` 映射到稳定 `MessageId`，并从持久历史恢复，避免重复投递（`src/app/delivery.ts:16`、`src/app/delivery.ts:61-64`、`src/app/delivery.ts:73-84`）。
- 外部回复用 receipt 去重，同一消息不会重复排队（`src/app/outbox.ts:26-32`）。

属于〔推断〕的一处：

- 如果崩溃发生在“候选卡已经 steer 进主 Session、但尚未 decide”之间，assessment effect 行已经在投递成功后被删除（`src/app/effects.ts:130-145`），重启不会重投；Eval 仍持有 `delivered`，只能等 deadline 到期，再走 expire → requeue 最多 2 次 → `unavailable`（`src/core/evals.ts:35-69`）。这意味着**已投递未决的评估没有主动补偿**，只有期限兜底。该结论由代码路径推导，未做崩溃注入验证。 〔推断〕
- 同样地，worker 已经发出外部写操作但未回报时，系统只有提示词要求的“先核对再继续”，没有服务端的“结果未知”状态与对账协议。 〔判断〕

## 3. 事件驱动的边界：什么必须同步，什么可以异步

### 3.1 必须同步、事务性完成

| 事项 | 为什么不能异步 | 原型证据 |
| --- | --- | --- |
| Trigger 落库、去重、范围过滤 | 重复事件会重复建工作；过滤结果必须与落库一致 | `src/core/intake.ts:19-29`；`src/core/engine.ts:48` |
| Thread 关联、Subscription 扇出、Input 入队 | 后续 gate 与 worker 归属依赖一致快照 | `src/core/intake.ts:31-59` |
| 确定性 gate 与 Eval 创建 | 准入是授权事实；拆开后可能“已排队但未授权” | `src/core/evals.ts:71-118`；`src/policy.ts:191-211` |
| Decision 落库 | Decision 是 Mandate 的来源，必须与工单同源 | `src/core/evals.ts:131-163`；`src/core/tickets.ts:37-56` |
| Ticket + Mandate + Subscription + 首 Assignment + 回执 | 五者缺一即产生无授权工作或不可执行的工单 | `src/core/tickets.ts:37-56` |
| effect / outbox 与业务写同事务入队 | 这是 transactional outbox；异步提交会丢副作用 | `src/app/effects.ts:61-66`；`src/app/outbox.ts:26-32` |
| Assignment 的 started / delivered / report 状态迁移 | 执行事实必须单调，不能由网络重试改写 | `src/core/assignments.ts:34-77` |

注意：这里的“同步”是指**在同一个写者的同一个事务里完成**，不要求所有参与者都在同一进程。P1 之后仍应保持“单一写者负责授权事实”，只是写者可以是一个独立的 Engine 进程。 〔设想〕

### 3.2 可以异步、可重试

| 事项 | 可异步的理由 | 原型机制 |
| --- | --- | --- |
| 评估候选投递 | 可从 Eval 行重建；Session 忙时可等 | `assessment` effect（`src/app/assessment.ts:96-104`） |
| worker 启动与目录准备 | 可从 pending Assignment 重建 | `launch` effect（`src/executor/dsh.ts:263-285`） |
| 输入投递 | 可从 `undelivered` 重建 | `delivery` effect（`src/executor/dsh.ts:290-343`） |
| relay / notice | 可从事件与 requestId 重建 | `relay` / `notice` effect（`src/app/sessions.ts:104-105`、`src/app/sessions.ts:171-186`） |
| 外部回复 | 可从 receipt 重建；按会话保序 | `reply` effect（`src/app/outbox.ts:24-51`） |
| Source 轮询 | 可重放；游标只在落库后推进 | `src/sources/github.ts:225-244` |
| 外部副作用（评论、PR、消息） | 需要幂等键或对账，不是纯重试 | 目前靠 receipt + 提示词对账（`src/app/outbox.ts:39-51`；`src/core/assignments.ts:21`） |

### 3.3 可复用的四条判定规则

〔设想〕把“要不要拆成进程/异步”的判断收敛成四个问题：

1. **能否从持久状态重建？** 能 → 允许异步与重试；不能 → 必须同步落库。
2. **失败是否可能已经产生不可撤销的外部副作用？** 是 → 不能只重试，必须有幂等键、收据或“结果未知 → 对账”。
3. **是否改变授权事实？** 是 → 必须单写者、单事务；不能让两个角色各自写一半。
4. **是否纯函数、无 I/O、无状态？** 是 → 不拆进程。跨进程只会增加延迟与失败面。
5. **持久化、投递、领取、处理是否被混为一谈？** 混了 → 先拆状态机。只要任一层成功就被当作完成，跨进程后一定会丢消息或重复消费。 〔外部材料主张 + 判断〕

## 4. 角色无关协议不变量 vs DSH 专有实现

### 4.1 对照表

| 维度 | 角色无关协议不变量（换 agent 仍保留） | 原型中的实现 | DSH 专有部分（换 agent 要重做） |
| --- | --- | --- | --- |
| 事件模型 | 通道无关的 `Trigger`：来源、线程引用、actor、是否人、是否 addressed、文本、频道、来源原生 meta | `src/core/model.ts:23-39`；`src/core/intake.ts:20-21` | 无（事件模型本身不依赖 DSH） |
| 事件到工作单元 | Trigger → Thread → Eval → Decision → Ticket → Assignment；授权依据随 Decision 固化 | `src/core/evals.ts:71-118`；`src/core/tickets.ts:37-56` | 无 |
| 授权依据 | gate 的 strength / basis / actor / policyVersion；resume 前 revalidate | `src/policy.ts:191-239`；`src/core/tickets.ts:106-114` | 无 |
| 持久队列 | 副作用与业务写同事务入队；按 kind 限流、退避、保序、可暂停 | `src/app/effects.ts:46-160` | 派发器跑在 Cordis 进程内（`src/app/effects.ts:83-88`）；存储是 SQLite（可替换） |
| 投递幂等 | 每条投递有稳定 requestId；重复投递被识别 | `src/app/delivery.ts:16`、`src/app/delivery.ts:61-84` | `MessageId`、`agent.inbox`、`agent.steer/followup/inject` 是 DSH 机制 |
| 期限与回收 | Eval deadline、过期重排、次数上限；Assignment 中断重启 | `src/core/evals.ts:35-69`；`src/core/assignments.ts:83-92` | 重启后的 Session 保留/取消依赖 DSH 的 inbox 与持久化 |
| 执行单元 | “一个工作单元由一个执行者实例承担”，执行者可替换 | `src/core/ports.ts:59-69` 的 `Executor` 端口 | `Session 即 agent 单元`；`worker-<ticketId>` 命名（`src/executor/dsh.ts:23-26`）；`Agent` / `Session` |
| 投递语义 | “下一轮 / 下一步 / 仅上下文”三种意图 | 通过 `Sessions.prompt` 的 `queue` / `steer` / `inject` 暴露（`src/app/sessions.ts:161-167`） | 三种语义就是 DSH 的 `followup` / `steer` / `inject`（DSH 绝对路径 `/Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness/packages/core/agent/src/runtime-types.ts:215-241`） |
| 并发与写者 | 一个工作单元同一时刻只有一个执行者；评估同一 Thread 串行 | Eval 由 Thread 串行（`src/core/evals.ts:71-118`）；worker 由 assignment 归属 | Session 单写者所有权（DSH 绝对路径 `/Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness/packages/session/session-persistence/README.md:40`、`:90`） |
| 权限 | 角色权限域：谁能判断、谁能执行、谁只能观察 | 原型统一给 `danger-full-access`（`src/app/sessions.ts:152`） | `permissionPresets`、preset 选择、工具集合（`src/app/sessions.ts:137-153`） |
| 上下文与模型 | 评估者需要的最小事实集：Thread 窗口、仓库读、图片、规则 | `MasterAssessor.context/read`（`src/app/assessment.ts:109-140`） | `eval.model` 绑定 Session、system prompt / skill 装饰（`src/app/sessions.ts:149-153`；`src/app/role-models.ts:15-42`） |
| 进程拓扑 | “角色可在不同节点，协议不假设共享内存” | 原型全部在同一 Host 进程 | Host 进程、Cordis 事件总线、`ctx.on(...)` 进程内订阅（`src/app/sessions.ts:108-136`） |

### 4.2 一个关键结论：不要把 DSH 投递语义写进协议

〔判断〕跨进程协议如果把 `steer` / `followup` / `inject` 当作原语，就会把 DSH 的 inbox 模型固化成系统契约，其他 agent 实现必须模仿 DSH 的“下一步插话 / 下一轮排队 / 只注入上下文”。正确做法是：

- 协议表达：`deliver(workItemId, inputId, intent)`，`intent ∈ {next_turn, next_step, context_only}`，并携带 `idempotencyKey`。
- DSH 适配器把 `next_turn` 映射为 `followup`，`next_step` 映射为 `steer`，`context_only` 映射为 `inject`。
- 其他 agent 适配器可以退化为“只能 next_turn”，但必须在适配器能力声明中写出，不能让上游假设 `next_step` 一定可用。

这样，DSH 的三种语义仍然保留在原型里（`src/app/sessions.ts:161-167`；`src/app/delivery.ts:79-81`），但不会污染角色协议。 〔设想〕

### 4.3 两级订阅：Work Subscription 与 Session Subscription

来源：[分享页“调研Agent事件订阅”](https://chatgpt.com/share/6aeb76b7-8874-83ea-a742-75434a6ce4bf)（读取日期 2026-11-05）。〔外部材料主张〕

外部材料主张把订阅拆成两层，避免把“工单关心哪个 Thread”和“agent 运行时监听哪些事件”混成一张表：

| 层 | 定义 | 生命周期 | 原型对应 |
| --- | --- | --- | --- |
| Work Subscription | Ticket 与 Thread 的持久业务关系；决定哪些事件成为工单的上下文输入 | 跨 worker、跨重启存活 | `Thread.subscriptions` 保存 ticket id（`src/core/model.ts:156-164`）；扇出时创建 Ticket Input（`src/core/intake.ts:49-52`） |
| Session Subscription | 某个 agent 实例对事件类型、资源范围、投递方式、优先级的运行时配置 | 随 agent 实例；重启后重挂 | 不存在通用 API；主 Session 由写死的 effect 投递（`src/app/runtime.ts:131-133`），worker 只接收 Ticket 输入（`src/executor/dsh.ts:290-343`） |

核对结论：

- 原型只有 Work Subscription 一层，这一点外部材料说对了：`Thread.subscriptions` 的类型就是 ticket id 数组（`src/core/model.ts:163-164`），扇出逻辑按它复制输入（`src/core/intake.ts:49-52`）。
- 外部材料把 Session Subscription 列为需要新增的一层。核查后 DSH 侧只有进程内事件钩子（`src/app/sessions.ts:108-136`），没有可配置、可持久化、重启可重挂的 Session Subscription API；原型的 `Subscription` 也只是 Work Subscription。因此这一层是新增设计，不是现有能力。〔判断〕
- DSH 的 webhook 也提供不了这一层：它按规则创建新根 Session（见 §4.5），没有“把某类事件投给已有 Session”的订阅表。

〔设想〕建议的 `SessionSubscription` 最小字段：

| 字段 | 用途 |
| --- | --- |
| `sessionId` / `agentInstanceId` | 投递目标；跨进程时是节点内身份，不是全局 Session |
| `source` / `resourceType` / `resourceId` | 订阅范围，支持 `*` 或精确匹配 |
| `eventTypes` | 领域事件类型集合 |
| `filter` | 内容过滤，例如仅 addressed、仅本人、仅提及 |
| `deliveryMode` | `next_turn` / `next_step` / `context_only` |
| `priority` | 评估、通知、审计的排队优先级 |
| `enabled` / `expiresAt` | 可暂停、可过期，防止孤儿订阅 |
| `policyVersion` / `capabilitySnapshot` | 建订阅时的授权与适配器能力快照 |

为什么要拆：worker Session 会被替换、Router Session 会被重启、watchdog 只读且独立；Work Subscription 必须比任何 agent 实例活得久，Session Subscription 必须能按实例重建。两者混在一起，换 agent 就会丢工单关系。 〔判断〕

### 4.4 异构适配层：能力声明，而不是一个 `sendMessage`

〔外部材料主张〕外部材料的核心提醒是：不要用统一的 `sendMessage()` 抹平 Claude Code、Codex、DSH 的差异。它们的“投递”语义不同，适配器必须显式声明能力，调用方不得假设。

〔DSH〕DSH 的三种输入语义可以直接核对：`followup` 唤醒下一轮、`steer` 针对下一步且可能在下一次取消时丢弃、`inject` 只注入上下文且可能错过当前请求，三者都返回 `void`（绝对路径 `/Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness/packages/core/agent/src/runtime-types.ts:215-241`）；停止当前轮用 `agent.cancel({ kind: 'user' })`（同文件 `:183`）。原型的 `AgentDelivery` 已经映射 `queue → followup`、`steer → steer`、`inject → inject`（`src/app/delivery.ts:79-81`），但它是直接调用 DSH，不是可替换端口。

〔设想〕建议的 `AgentSessionPort` 只保留四个操作，加一组能力标志：

| 操作 / 能力 | 语义 | DSH 核查结果 |
| --- | --- | --- |
| `injectContext` | 只加上下文，不唤醒 | 有（`inject`，可能错过当前请求） |
| `steer` | 影响活跃轮的下一个 step | 有（可能被取消丢弃） |
| `followup` | 排到下一轮并唤醒空闲 agent | 有 |
| `interrupt` | 停止当前轮 | 有（`agent.cancel`） |
| `persistent_session` | Session 跨重启存在 | 有（session persistence） |
| `cross_process_control` | 从另一个进程操作 agent | 无；Agent Handle 是进程内对象（绝对路径 `/Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness/packages/core/agent/src/index.ts:235`） |
| `progress_events` | 能回报 `claimed` / `processed` | 有进程内 session/agent 事件；跨进程需另建通道 |
| `durable_inbox` | 已 accepted 的输入在重启后仍保留 | 未逐项实测；适配器必须声明，不能默认成立 |

外部材料给出的 Codex / Claude 具体 API 名称（如 `turn/steer`、`inject_items`）在本仓库与 DSH 仓库都没有对应代码或文档，**无法核实**，因此不作为协议设计依据。本文只采用其结构性建议：适配器声明能力，调用方按能力选择投递语义。

关键规则：

- 适配器返回 `unsupported` 时，调用方不得静默降级为 `followup`；降级必须由策略层显式决定，并记录原因。 〔设想〕
- `accepted` 只表示 inbox 插入成功，不表示模型看见；`claimed` / `processed` 必须由运行时事件回报（见 §6.9）。 〔判断〕
- 能力快照要随 Session Subscription 或 Assessor target 一起持久化；重启后能力变化（例如从本地 DSH 换成远程 agent）必须触发重新校验，而不是沿用旧假设。 〔设想〕
- DSH 的 initiator 归属只在同进程异步链内有效，不是授权凭据（绝对路径 `/Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness/packages/core/agent/src/index.ts:239-242`）；跨进程必须显式携带 actor / 主体，不能依赖 ambient presence。 〔DSH + 判断〕

### 4.5 DSH 已有能力的边界：Webhook 不是持久事件总线

〔外部材料主张 + DSH 核对〕分享页提醒 DSH webhook 是 fire-and-forget。核对 DSH 文档与实现后，结论成立，且比“fire-and-forget”更具体：

- webhook 在进程内 fire-and-forget；没有持久投递、重试或死信队列（绝对路径 `/Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness/packages/experimental/webhook/README.md:71-73`）。
- 它只提供“创建一个新的根 Session”这一种动作（同文件 `:12`）；规则命中后提交一条 `Agent.followup()`，这是它的提交点；`deliveryId` 只是提供方 id，不用于我们的事件去重或重试（同文件 `:30`、`:41`）。
- 它不等待 idle、不检查回复、不发布完成状态（同文件 `:41`、`:73`）；重复投递会重复跑规则。
- 因此它可以作为 Source 适配器（低延迟唤起一个新 Session），但不能承担“事件事实日志 + 至少一次投递 + 去重”的总线职责。 〔判断〕

这补强了 §4.1 的结论：DSH 提供的是进程内 agent 控制与 webhook 触发，不是跨进程可靠事件总线；“跨进程总线、租约、投递表”仍需自建。 〔判断〕

## 5. daemon-first：耦合点与改造清单

### 5.1 四个核心耦合点（扩展为八项）

| # | 耦合点 | 现状与证据 | 异构/隔离后会怎样 | 改造方向 | 代价 | 优先级 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 主 Session 在初始化中急切创建 | `await sessions.ensure(masterId, ...)`（`src/app/runtime.ts:210`） | Router 进程未起时，整个系统不能进入 ready | P1：初始化不创建 agent；Router 作为消费者按需注册；无消费者时 Eval 不启动 deadline（从 claim 起算，见 §6.4） | 中 | P1 |
| 2 | 评估投递目标写死 masterId | `deliver: (id, text) => sessions.prompt(masterId, ...)`（`src/app/runtime.ts:131-133`）；relay handler 同样（`src/app/sessions.ts:104`） | 无法把评估投给另一个 Router 实现或节点 | 引入 `RoleTarget`：按角色 + 租约解析目标，而不是固定 session id | 中 | P0 |
| 3 | 判断只以主 Session 工具存在 | `orchestrator_eval*` / `orchestrator_route`（`src/app/tools/main.ts:202-220`）；工具只装在主 Session（`src/app/sessions.ts:149-153`） | 外部 Assessor 无法“回写判定”，端口不闭合 | 另立宿主中立的 `AssessorService`（架构文档 D7）；现有 `Assessor` 端口降为 DSH 适配器；工具只是其中一个适配器 | 高 | P0 |
| 4 | 通知只能 steer/inject 到已存在 agent | relay 与 notice handler（`src/app/sessions.ts:104-105`、`src/app/sessions.ts:162-186`） | Router 不在线时通知丢失或长期挂起 | 通知改成按事件 id 持久投递；接收方上线后补投；非 DSH 适配器可降级为队列 | 中 | P1 |
| 5 | effect 派发与 handler 注册都在进程内 | `Effects` 持有 handler 表并 `queueMicrotask` 派发（`src/app/effects.ts:46-88`） | 多节点无法共享队列；节点崩溃后无人 claim | 拆成 queue 服务（先 SQLite 表，后可换 Redis/SQS）：claim / heartbeat / ack / visibility timeout | 高 | P1 |
| 6 | 域事件没有事务性事件流，只是回调 | `emit` 在事务内回调，`runtime` 直接处理（`src/core/part.ts:64-65`；`src/app/runtime.ts:138-153`） | 跨进程消费者收不到事件；崩溃后无法补投 | 拆成 Event Journal（seq、type、payload、dedupeKey）与 Delivery 表（consumerId、state、attempts、due）；同事务写事件与待投递行 | 高 | P0 |
| 7 | Router 与 Worker 共享 OS 权限 | 两者都 `danger-full-access`（`src/app/sessions.ts:152`）；worker 以 operator OS 用户跑命令（`docs/003-execution.md:27`） | 判断侧可写仓库、执行侧可决定新工作，权限域没有拆开 | Router：只读上下文 + decide token；Worker：写工作区 + 授权范围内外部写；Watchdog：只读事件 | 高 | P1 |
| 8 | Session/agent 注册表是进程内单写者 | 订阅 `agent/created`、`session/event`、`agent/status`（`src/app/sessions.ts:108-136`）；单写者约束见 DSH 绝对路径 `/Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness/packages/session/session-persistence/README.md:90` | 不能跨节点直接操作同一个 agent | 一个 agent 只属于一个执行节点；跨节点只传协议消息，不共享 Session | 高 | P2 |

### 5.2 改造的先后顺序

〔外部材料主张 + 判断〕外部材料建议以 Assessor 可插拔为切入点，不先拆 daemon。核对后本文采纳这个顺序：P0 只闭合协议、目标绑定与事件日志/投递表，保留 eager Router；把“Router 可缺席”下移到 P1。理由是 eager `ensure(masterId)` 同时影响启动、投递、deadline 与通知；在协议未闭合时移除它，失败面过大，也难以区分是协议问题还是装配问题。

**P0：仍单进程，闭合 `AssessorService` 协议与事件/投递表**

1. 另立宿主中立的 `AssessorService`（架构文档 D7、§10.2）：`request(candidate) → AssessmentResult`；现有 `Assessor` 端口降为 DSH 适配器。结果带 `tenantId`、`evalId`、`policyVersion`、`assessorId`、`leaseGeneration`、`leaseId`、`actor`、`outcome`、`completedAt`、`evidence`；未持有租约的判定被拒绝。
2. 新增 `DecisionCommand` 的认证与校验：校验顺序以架构文档 §5.3 的**唯一校验链**为准，本文不另列；工具调用只是签发这个 command 的一种方式。
3. 持久化 Eval → AssessmentTarget（tenantId、runtimeType、sessionId、assessorProfile、policyVersion、deliveryState）；Engine 不再在构造期写死 session id，但默认仍解析到共享 Router，保留 eager ensure。
4. `RoleTarget` 替代 `masterId` 直投：relay / notice / assessment 都按角色解析当前目标；解析不到时记录并排队，而不是静默丢弃。
5. 拆出 Event Journal 与 Delivery 表；即使消费者进程尚未启动，事件事实与待投递行都不丢。
6. 抽象 AssessorProvider / AssessorInstance（`create` / `assess` / `dispose`）与 SessionProvider（`resolve` / `ensure`）；`ensure` 必须稳定身份、幂等创建，同一 Eval 重试不能建两个 Assessor Session。

验收信号：同一 Eval 重试只产生一个 Assessor Session；迟到、旧 `policyVersion` 与越权 `evidence` 三类 `AssessmentResult` 被拒绝；共享 Router 形态仍可运行。 〔设想〕

**P1：队列与租约服务化，允许消费者缺席**

7. `Effects` 从“进程内 handler 表”拆成“queue + dispatcher + handler registry”；引入 claim 租约、心跳、ack、visibility timeout、dead-letter。
8. 执行节点注册：nodeId、roles、capacity、heartbeat、drain；worker 槽从本地设置（`src/policy.ts:93` 的 `maxWorkers` 默认 3）升级为节点容量声明。
9. 失败分类：`rejected`（无副作用）、`failed`（已知无副作用）、`timeout`（结果未知）、`cancelled`（人停止）、`paused`（暂停）。`timeout` 不自动重试外部副作用，先对账。
10. 按角色拆凭据与工具白名单：Router 无仓库写权限，Worker 无判定权限，Watchdog 无写权限。
11. 移除 eager ensure：初始化只启动引擎与队列；Router 上线后消费评估队列，无消费者时 Eval 不启动 deadline（从 claim 起算，见 §6.4）。

验收信号：杀掉 Router 进程后，事件仍落库、Eval 不被 deadline 耗光、重启后能被新 Router 接走；节点失联后租约在 TTL 内被回收；另一个节点接管同一工作单元不会写出两份 Decision。 〔设想〕

**P2：角色进程拆分与异构适配器**

12. Router 适配器：DSH Session 适配器（现状）+ 外部 agent 适配器（HTTP/队列）。
13. Executor 适配器：`Executor` 端口已经是现成的接缝（`src/core/ports.ts:59-69`），把 `DshExecutor` 作为本地适配器，新增远程节点适配器。
14. Watchdog 作为独立只读消费者：订阅事件流，产出健康、告警、审计，不持有任何写权限。

验收信号：同一套引擎可以同时接一个 DSH Router、一个外部 Assessor、一个远程 Worker；任一角色替换不影响其他角色的代码。 〔设想〕

〔判断〕三处原有判断被外部材料修正或收紧，记录如下：

| 项 | 此前判断 | 外部材料主张 | 核查后结论 |
| --- | --- | --- | --- |
| P0 是否移除 eager ensure | 是，P0 就移除 | 不要急着拆 daemon；先做 Assessor 可插拔 | 采纳外部材料：lazy Router 下移到 P1，P0 只闭合端口 |
| 事件队列表形态 | 单张 outbox + consumer offset | 事件日志与投递表分离 | 采纳外部材料，见 §6.8 |
| Subscription 分层 | 只讨论 Ticket↔Thread | Session Subscription 与 Work Subscription 分离 | 采纳分层；但 DSH 没有现成 Session Subscription API，属新增设计 |

## 6. 进程隔离 + agent 异构对事件驱动的新要求

这一节把“新增要求”写成可评审的协议条目。每条都给出现状缺口。

### 6.1 跨进程事件总线与工作队列

| 要求 | 为什么需要 | 建议协议形态 | 原型缺口 |
| --- | --- | --- | --- |
| 至少一次投递 | 进程会崩，网络会断 | 持久队列 + ack；消费者幂等 | effect 队列是进程内派发（`src/app/effects.ts:83-88`） |
| 按 key 保序 | 同一 Thread 的评估、同一 Ticket 的输入不能乱序 | `partitionKey = threadKey` 或 `ticketId`；只保证同 key 顺序 | 当前靠单进程串行与 `ordered` effect；跨进程无约束 |
| 可暂停与可恢复 | 运维需要停下来修配置 | 队列支持 `paused`；未消费行保留 | `limit: () => paused() ? 0 : ...`（`src/app/assessment.ts:101`、`src/executor/dsh.ts:232-235`） |
| 事实与投递分离 | 同一事件要投给 Router、多个 Worker、审计等多个目标，各自重试 | Event Journal 一行 + Delivery 每个消费者一行 | 有 `Trigger` 与 Ticket `Input`，但没有以 consumer 为维度的通用投递行 |
| 消费者可缺席 | Router 进程可能后起 | 事件先落库，消费者注册后再拉 | 初始化阻塞在 Router 创建（`src/app/runtime.ts:210`） |

〔判断〕建议的队列语义是“至少一次 + 按 key 保序 + 消费者侧幂等”，而不是“恰好一次”。跨进程的恰好一次通常需要分布式事务，代价远高于收益。

### 6.2 执行节点注册与租约

| 要求 | 说明 | 原型现状 |
| --- | --- | --- |
| 节点注册 | nodeId、支持的 roles、容量、版本、能力声明 | 无 |
| 心跳 | 定期续租；失联即回收 | 无；只有进程内 health（`src/infra/health.ts` 的 HealthBoard） |
| 工作单元租约 | 租约属于 work item，不属于 agent；到期可被其他节点 claim | 无；Assignment 只记录 running |
| fencing token | 旧节点租约过期后的迟到写入必须被拒绝 | 无；跨进程后必须补 |
| drain | 节点优雅下线时停止 claim、完成在途 | `executor.shutdown()`（`src/executor/dsh.ts:391-401`）只覆盖本地 |

〔推断〕如果没有 fencing token，网络抖动或长 GC 会让“已被回收的 worker”在恢复后继续写回，制造重复报告或重复外部副作用。这是跨进程执行最常见的一致性漏洞。

### 6.3 四类幂等键

| 幂等域 | key | 作用 | 原型证据 |
| --- | --- | --- | --- |
| 事件 | `trigger.id` | 同一外部事件只落一次 | `src/core/intake.ts:23`；`src/sources/github.ts:232` 依赖 Trigger id 去重 |
| 评估/判定 | 原型用 `evalId` + `accepted(triggerId)`；协议建议再加 `leaseGeneration` | 同一 Eval 只接受一个有效 Decision；已建工单的 Trigger 重放不会建第二张 | `src/core/evals.ts:131-146` |
| 执行/输入 | 原型用 `input.id`；协议建议加 `assignmentId` 作用域 | 同一输入只投递给同一 Assignment 一次 | `src/app/delivery.ts:16`；`src/executor/dsh.ts:342` |
| 外部副作用 | `messageId` / receipt id / 外部操作 id | 同一条回复或评论只发一次 | `src/app/outbox.ts:26-32`；`src/app/outbox.ts:39-51` |

〔设想〕跨进程协议要求每条 command 与 result 都携带同一组 key（至少 `tenantId` + 业务 id + `leaseGeneration`），执行路径另带 `attempt`。只带业务 id，无法区分“重试”与“新工作”，也无法拒绝旧代次写入。

### 6.4 deadline、心跳与回收

原型的 Eval deadline 已经是一个好模型：

- 原型在候选送达后才开始计时（`src/app/assessment.ts:100`；`src/core/evals.ts:47-55`）；目标形态必须从 claim 起算，见下条第 1 点；
- 暂停时冻结 deadline，恢复后平移（`src/core/evals.ts:35-46`）；
- 过期后重排最多 2 次，然后记 `unavailable`（`src/core/evals.ts:19`、`src/core/evals.ts:60-69`）。

〔判断〕跨进程后需要把它一般化为“三类时钟”：

1. **评估 deadline**：从判定任务被某个 Assessor 领取（claim）开始计时，而不是从投递成功开始；否则 Router 缺席或队列积压时，deadline 会在排队阶段被耗光，判定还没开始就过期。排队时长应由队列积压指标单独衡量，见架构文档 D5 与 §13.2 状态机。
2. **租约心跳**：执行者必须定期续租；心跳丢失先标记“可疑”，到期才回收。
3. **外部操作 deadline**：外部写操作必须有独立超时；超时进入“结果未知”，不能直接重试。

### 6.5 失败与“结果未知”的区分

〔设想〕失败分类至少六种，且必须进入协议：

| 状态 | 含义 | 是否可重试 | 处理 |
| --- | --- | --- | --- |
| `rejected` | 准入拒绝，无副作用 | 否 | 记 Decision / health |
| `failed` | 已知失败，无外部副作用 | 是（有上限） | 退避重试 |
| `timeout` | 调用超时，可能已产生副作用 | 否（先对账） | 标记 unknown，对账后再决定 |
| `unknown` | 结果不确定 | 否 | 人工或对账任务处理 |
| `cancelled` | 人停止 / 下线 | 否 | 结束 Assignment |
| `paused` | 系统暂停 | 延后 | 保留队列行 |

原型的 `Later` 已经区分“现在不能跑”和“失败”（`src/app/effects.ts:1-5`、`src/app/effects.ts:138-143`），这是对的基础；但 `timeout` 与 `unknown` 还没有独立状态。 〔判断〕

### 6.6 按角色拆权限域

| 角色 | 应能读 | 应能写 | 不应能 | 原型现状 |
| --- | --- | --- | --- | --- |
| Source / Watcher | 外部来源、Thread | Trigger、游标、健康 | 判定、建工单、写仓库 | Source 只能 `receive` / `state`（`src/sources/host.ts:31-45`） |
| Router / Assessor | Thread 上下文、仓库只读、规则 | Decision、通知 | 执行命令、推代码 | 主 Session 有 `danger-full-access`（`src/app/sessions.ts:152`），但工具集较小（`src/app/tools/main.ts:155-220`） |
| Worker / Executor | 工作区、凭据范围 | 工作区文件、授权范围内外部写 | 接受新工作、停止别人的工单、判定 | worker 同样 `danger-full-access`（`src/app/sessions.ts:152`），靠工具白名单约束（`src/app/sessions.ts:61-62`） |
| Watchdog | 事件流、健康、审计 | 告警、健康状态 | 任何域写、任何外部副作用 | 不存在此角色 |

〔判断〕“工具白名单”不是权限隔离。两个 Session 都以 operator 的 OS 用户运行，且都拿 `danger-full-access`；真正的角色隔离需要进程级凭据与文件系统边界。当前形态在单机、可信 operator 下可接受，在多角色/多厂商下不可接受。

### 6.7 审计与可观察性

- 域事件已经是审计线索（`src/core/ports.ts:86-103`），但只存在内存回调，不构成可回放的日志。 〔原型〕
- Decision 的证据要求已经很强：`AssessmentSchema` 要求 `direction`、`rule_assessments`、`title`、`scope`、`intent_evidence`、`reason`（`src/app/assessment.ts:21-34`）。跨进程后这些字段应随 `DecisionCommand` 一起传输并落库。 〔原型 + 设想〕
- 需要补充：`tenantId`、`traceId`（通常就是 `triggerId`）、`nodeId`、`leaseGeneration`（判定）或 `attempt`（执行）、`leaseId`、`capability`。否则跨进程后无法回答“这条判定是谁、在哪个节点、第几次尝试做出的、属于哪个租户”。

### 6.8 事件日志与投递队列：事实和投递不是一张表

来源：[分享页“调研Agent事件订阅”](https://chatgpt.com/share/6aeb76b7-8874-83ea-a742-75434a6ce4bf)（读取日期 2026-11-05）。〔外部材料主张〕

外部材料主张把“不可变事件日志”和“按消费者的投递状态”分开：事件只写一次，投递可以多次；同一事件可以同时投给 Router、多个 Worker、审计和 watchdog，各自的进度与重试互不影响。这个主张与原型的分层高度吻合，但比原型的 `effect` 队列更完整。

〔原型〕原型其实已经有四层，只是没有以 consumer 为维度的通用投递表：

| 层 | 原型对应 | 作用 | 缺口 |
| --- | --- | --- | --- |
| 事件事实 | `Trigger` | 通道无关、不可变、按来源 id 去重 | 已具备 |
| 准入与路由 | `TriggerDisposition` | 记录是否过滤、进了哪个 Eval、扇出到哪些 Ticket | `fanout` / `acked` 聚合在事件行上，不是每个目标一行 |
| 目标投递 | Ticket `Input` | 每个 Ticket 自己的待投递输入 | 只覆盖 Ticket；Router、审计、watchdog 没有同类投递行 |
| 副作用投递 | `Effect` | 退避、限流、有序、暂停 | 与服务事件 id、消费者身份的关联较弱 |

证据：`Trigger` 的不可变定义见 `src/core/model.ts:22-39`；路由记录见 `src/core/model.ts:41-60`；扇出创建 Ticket Input 见 `src/core/intake.ts:49-52`；副作用入队见 `src/app/effects.ts:61-66`。

〔设想〕建议的事件信封字段：

| 字段 | 用途 |
| --- | --- |
| `eventId` | 来源稳定 id；重放时不变 |
| `source` / `resourceType` / `resourceId` | 事件来自哪、作用于什么 |
| `eventType` | 领域事件类型，不是厂商事件名 |
| `payload` | 原始事实的规范化副本，不可变 |
| `actor` | 人、agent、系统；用于授权与审计 |
| `occurredAt` | 外部世界发生时间，不是入库时间 |
| `dedupeKey` | 来源级去重键；与 `eventId` 可不同 |
| `correlationId` | Thread / Ticket / Trace 的关联键 |
| `trustLevel` | 不可信外部输入、已验证成员、系统内部 |
| `schemaVersion` | 兼容升级用 |

投递表字段建议：`tenantId`、`deliveryId`、`eventId`、`consumerId`、`state`、`attempts`、`dueAt`、`leaseId`、`leaseGeneration`、`deadline`、`lastError`、`result`。唯一键是 `(tenantId, eventId, consumerId)`，而不是单个事件行的 offset。信封与投递字段的目标形态（含 `schemaVersion`、`trustLevel`、`capabilitySnapshot`）见架构文档 §5.1；本节不再复制。

〔判断〕这里修正了本文此前的建议：此前写“加一张事件 outbox 表 + 消费者按 offset 拉取”，这暗含“一个事件一个投递位”。本系统的事件有多个消费者（Router、Worker、审计、watchdog），每个消费者的失败与重试是独立的，因此应拆成 Event Journal + Delivery。两者都在业务事务内写入，但允许 Delivery 尚未创建（消费者后注册时由 Journal 补建）。

### 6.9 投递状态机：persisted、accepted、claimed、processed

〔外部材料主张 + 原型 + 判断〕外部材料提出“持久化不等于送达、送达不等于处理完成”。原型已经有两个现成的状态证据：`inputsDelivered` 与 `inputsRead` 分开记录（`src/core/engine.ts:181-190`；worker 的 turn 开始时才标记 read，`src/executor/dsh.ts:495-503`）。这说明“投递成功”和“真的被 agent 看见”在原型里就是两件事。

| 状态 | 含义 | 原型证据 | 谁能推进 |
| --- | --- | --- | --- |
| persisted | 事件/输入/副作用已提交到库 | `src/core/intake.ts:23-30`；`src/app/effects.ts:61-66` | Engine 事务 |
| routed | 已决定投给哪些消费者，Delivery 行已建 | `src/core/intake.ts:49-55` | Intake / Router |
| accepted | 适配器已把输入放进 agent 的 inbox 并返回 | `src/app/delivery.ts:79-84` | Agent 适配器 |
| claimed | agent 真正开始处理这条输入 | `src/core/engine.ts:181-190`；`src/executor/dsh.ts:495-503` | Agent 运行时事件 |
| processed | 产生了业务结果（Decision、Report、Reply） | `src/core/tickets.ts:37-56`；`src/executor/dsh.ts:342` | Engine / Worker |
| failed / expired / unknown | 失败、超期、结果不确定 | `src/app/effects.ts:130-143`；`src/core/evals.ts:60-69` | Dispatcher / Watchdog |

关键结论：

- **DSH 的 `steer` / `followup` / `inject` 返回 `void`，不是“模型已处理”的 Promise**（DSH 绝对路径 `/Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness/packages/core/agent/src/runtime-types.ts:215-241`）。适配器最多能诚实报告 `accepted`；`claimed` / `processed` 必须另有运行时事件或心跳。
- `steer` 可能在下一次取消时被丢弃、`inject` 可能错过当前请求（同一注释段），所以 `accepted` 也不等于“一定进入模型上下文”。〔DSH〕
- 跨进程协议必须把 `DeliveryResult` 定义为 `accepted | rejected | unsupported`，而不是布尔成功；`claimed` / `processed` 通过后续事件回报。若外部 agent 无法提供 `claimed`，就用 deadline 加心跳把“慢”与“丢”区分开。 〔设想〕
- 这直接补强 §6.5 的失败分类：`timeout` 应细分为“未 accepted 的超时”和“已 accepted 未 claimed 的超时”；后者更像投递丢失，前者更像连接失败。 〔判断〕

〔原型 + 判断〕以上是原型现状：**投递状态机**没有 `policyVersion` 分支，版本不一致的迟到判定没有专门投递状态。注意这**不等于**判定链路不比对版本：`decideEval` 在回写时已比对并重排（`src/core/evals.ts:284-288`），`policyChanged` 也会主动重排所有活跃 Eval（`:218-221`）。真正缺的是有界处置（合并窗口、重判上限）与 fencing。后续设计见架构文档 §13.2：版本不匹配的判定先进入 `pending-policy`，等窗口关闭后按最新版本重派；每个 Eval 最多重判 2 次，到上限转人工 `escalated`。

### 6.10 Watchdog 的判定输入（页面未覆盖，本文设想）

分享页没有讨论 watchdog（全文检索无该词），因此本节没有外部来源，全部是本文基于 §6.8 / §6.9 推导的设计，不能当作外部证据。

〔设想〕watchdog 只读三类持久事实与一类外部对账结果：

| 判定输入 | 读什么 | 能回答的问题 | 不能替代什么 |
| --- | --- | --- | --- |
| 事件位点 | Event Journal 的 `seq`、`occurredAt`、`persistedAt`、消费者登记 | 事件是否落库、积压多久、是否有事件没有任何消费者 | 不能证明消费者已处理 |
| 投递状态 | Delivery 的 `state`、`attempts`、`dueAt`、`deadline`、`lastError` | 是没送出、accepted 未 claimed、还是 claimed 未 processed | 不能判断业务结果对错 |
| 租约与心跳 | `nodeId`、`leaseId`、`lease.generation`、`expiresAt`、`lastHeartbeat`、在途工作单元 | 节点是否失联、租约能否回收、迟到写入是否应拒 | 不能代替 fence 校验本身 |
| 外部对账 | receipt 与外部事实（评论 / PR / 消息是否真实存在） | `timeout` / `unknown` 是已生效还是未生效 | 不能自动重试，只能给出建议 |

三条判定规则：

- **只读输入，只写发现。** watchdog 写 health、alert、finding；不写 Trigger / Decision / Mandate / Ticket，也不直接重试外部副作用。重试只能作为“建议事件”交给 Engine 或 Executor 决定。 〔设想〕
- **判定可重放。** 输入必须带位点与 `observedAt`，让“同一 Journal 前缀 + 同一时钟快照”得到同一结论；不允许只读“当前最新状态”就下结论。 〔设想〕
- **三段超时分开判。** accepted 前超时更像连接失败或消费者缺席；accepted 后未 claimed 更像投递丢失或 agent 卡住；claimed 后过 deadline 才是执行慢或失控。三者对应不同告警与处置，不能合并成一个 `timeout`。 〔判断〕

watchdog 也不应以 Session transcript 作为判定依据：transcript 是认知记录，不是业务事实；业务事实只在域表与 Journal。 〔判断〕

完整只读输入集（含 Eval / Ticket / Assignment 只读视图、节点注册表）与确定性阈值要求见架构文档 §15.2；本节不复制。

## 7. 为什么“判断寄生在常驻 Router 会话”是瓶颈

### 7.1 五个具体瓶颈

1. **上下文污染。** 主 Session 同时承担路由、评估、通知处理和工具调用。候选卡被 steer 进同一个对话（`src/app/runtime.ts:131-133`；`src/app/sessions.ts:104`），路由历史、通知、其他工单的结果都会进入评估上下文。〔原型 + 判断〕
2. **串行化。** 一个 Session 只有一个 agent 循环；`assessment` effect 虽然允许 4 个并发投递（`src/app/assessment.ts:101`），但所有判定最终都在同一个主 Session 的 turn 里完成。评估 deadline 默认 120 秒（`src/policy.ts:85`），繁忙时更容易触发 expire → requeue ≤2 → `unavailable`（`src/core/evals.ts:60-69`）。〔推断〕
3. **模型/提示词/权限耦合。** 主 Session 的模型来自 `eval.model`（`src/app/sessions.ts:150`），prompt 与 skill 在创建时绑定（`src/app/sessions.ts:151`），权限固定为 `danger-full-access`（`src/app/sessions.ts:152`）。想换 Assessor 模型或做 A/B，只能重建 Session，不能按 Eval 选择。〔原型〕
4. **启动耦合。** 初始化 `await ensure(masterId)`（`src/app/runtime.ts:210`），在此之前 effect 泵不启动（`src/app/runtime.ts:216`）。Router 慢，评估就慢；Router 挂，评估就没有消费者。〔原型〕
5. **不可水平扩展。** worker 有 `maxWorkers` 默认 3（`src/policy.ts:93`），但 Assessor 只有一个主 Session；无法按评估负载增加判定节点。 〔判断〕

### 7.2 Assessor 可插拔的四种形态与代价

| 方案 | 判定单元 | 上下文/工具能力 | 隔离与并发 | 需要动的点 | 代价与风险 | 适用 |
| --- | --- | --- | --- | --- | --- | --- |
| A. 常驻 Router 会话（现状） | 主 Session 的一个 turn | 完整：可多步读 Thread、仓库、图片 | 无隔离；单 Session 串行 | 无 | 上下文污染、单点、难 A/B；启动耦合 | 单机、低负载 |
| B. 每个 Eval 一个临时 DSH Session | 临时 Session | 完整；prompt/skill 可按评估配置 | 进程内并发；崩溃可丢 Session | 新增 Session 池/生命周期；`AssessorService` 接入；工具身份校验 | 创建成本；仍依赖 DSH；清理复杂 | 想保留工具能力但去串行 |
| C. 一次性模型调用 | 一次 `ctx.llm.stream` | 仅预取上下文 + 结构化输出；不能多步读 | 最轻；易并发、易替换 provider | 预取 Thread/文件/图片；组装 prompt；schema 校验；重试与审计 | 复杂候选判断质量下降；无工具探索 | 低风险、规则明确、量大 |
| D. 外部 agent 进程 | 一个工作单元 | 由外部 agent 决定；能力需声明 | 进程级隔离；可异构、可横向扩展 | 定义 AssessorService 协议（request/read/decide/cancel）、认证、租约、deadline、结果未知 | 协议与运维成本最高；需要节点注册与对账 | 多厂商、强隔离、规模化 |
| E. 混合：预取 + C，复杂升级 B/D | 分级 | 简单走 C，复杂走 B/D | 按需 | 路由器/分级策略、预算、审计 | 策略复杂；需要质量基线 | 规模化且质量敏感 |

〔判断〕对“比原型更通用 + agent 异构 + 角色进程隔离”的目标，推荐顺序是 **先做 D 的 `AssessorService` 协议，再把 B 作为 DSH 适配器、C 作为轻量适配器**。不要先做 B 再改 D，否则 Session 语义会渗进协议。

### 7.3 具体要动的几处（原型参照）

| 改动点 | 当前代码 | 改动内容 | 代价 |
| --- | --- | --- | --- |
| Assessor 协议 | `src/core/ports.ts:49-53` | P0：另立宿主中立的 `AssessorService`（架构文档 D7、§10.2）；现有 `Assessor` 端口降为 DSH 适配器 | 中高；影响 Engine、MasterAssessor、工具 |
| 判定入口 | `src/app/tools/main.ts:214-220`；`src/app/assessment.ts` 的 `decide` | P0：工具改为签发带认证的 `DecisionCommand`；外部适配器走同一命令 | 中 |
| 投递目标 | `src/app/runtime.ts:131-133`；`src/app/sessions.ts:104` | P0：`RoleTarget` 解析；解析不到时排队，不丢 | 中 |
| 初始化 | `src/app/runtime.ts:210-216` | P1：去掉 eager ensure；Router 作为消费者注册后再启动评估投递（P0 保留 eager Router） | 中；需要“无消费者”态与 deadline 规则 |
| 事件 | `src/core/part.ts:64-65`；`src/app/runtime.ts:138-153` | P0：Event Journal + Delivery 表（按消费者），不是单表加 offset | 高 |
| 队列派发 | `src/app/effects.ts:46-160` | P1：claim/lease/ack/visibility timeout；handler registry 可远程发现 | 高 |
| 权限 | `src/app/sessions.ts:152` | P1：Router 只读 + decide；Worker 写工作区 + 受限外部写；Watchdog 只读 | 高 |

〔判断〕其中“`AssessorService` 协议落地”是唯一一个**不做就无法真正异构**的改动；其余（队列服务化、权限拆分）可以分批做，但不做会让异构变成“同机多进程”。

### 7.4 Assessor 可插拔的三步与结果合同

来源：[分享页“调研Agent事件订阅”](https://chatgpt.com/share/6aeb76b7-8874-83ea-a742-75434a6ce4bf)（读取日期 2026-11-05）。〔外部材料主张〕

外部材料建议分三步：抽象 `AssessorProvider` / `AssessorInstance`，抽象 Session 定位与生命周期（`resolve` / `ensure`），再把 Eval 与 Assessor 的绑定持久化。逐步核对如下。

| 步骤 | 外部材料主张 | 原型核对 | 核查后结论 |
| --- | --- | --- | --- |
| 1. Provider / Instance | `AssessorProvider.create(profile, candidate)` 返回 `AssessorInstance`，后者提供 `assess` / `dispose` | 端口只有 `request` / `release`（`src/core/ports.ts:49-53`）；`decide` 在应用类 `MasterAssessor` 上（`src/app/assessment.ts:272-279`），不在端口；结果最终由 `Engine.decide` 落库（`src/core/evals.ts:131-146`） | **部分成立，一处失准。** 领域层确实依赖端口，这一点成立；但“只差默认组装、Engine 不用重写”不成立——结果回写不在端口合同里；补法也不是给现有端口加方法（见下方“历史方案”），而是另立宿主中立的 `AssessorService`（架构文档 D7、§10.2），现有 `Assessor` 端口降为该协议的 DSH 实现适配器 |
| 2. Session 定位 | `AssessorSessionProvider.resolve` / `ensure`；`ensure` 必须稳定身份、幂等创建，同一 Eval 重试不能建两个 Session | `Sessions.ensure` 已是 resolve-then-create（`src/app/sessions.ts:138-147`），但调用方固定传 `masterId`；`AssessmentTarget` 不存在，`resolve` 也没有 | **可复用，但需换键。** 现有 `ensure` 的“找不到才创建”可复用；新键应是 `(evalId, assessorProfile)`，而不是固定 id。并发下两个 `ensure` 是否只创建一个 Session 未验证，属〔推断〕风险 |
| 3. 绑定持久化 | 存 `AssessmentTarget`：runtimeType、sessionId、assessorProfile、policyVersion、deliveryState | `Evaluation` 已存 `policyVersion`、`delivered`、`deadline`、`pausedAt`（`src/core/model.ts:136-154`），但没有 assessor / session / runtime 绑定 | **未落地，属新增。** 现有字段只够“这个评估什么时候到期”，不够“这个评估由谁在做、重启后回到哪” |

**历史方案（已被裁决取代）：** 曾考虑在现有 `Assessor` 端口上直接补 `assess` / `cancel` 与租约——这是改动最小的做法。它的问题是把 DSH 的 Session 生命周期与类型带进协议：非 DSH 的 Assessor 必须迁就 DSH 语义，跨宿主复用无从谈起。架构文档 D7 因此裁决为另立宿主中立的 `AssessorService`，现有 `Assessor` 端口只作该协议的 DSH 实现适配器（§10.2）；取代理由是“跨宿主复用 vs 绑死 DSH 类型”。下面的 `AssessmentResult` 合同归 `AssessorService`，不再作为 `Assessor` 端口的方法。

〔设想〕`AssessmentResult` 的字段分两批：外部材料给出 `evalId`、`policyVersion`、`assessorId`、`outcome`、`completedAt` 五个；本文再补 `tenantId`、`leaseGeneration`、`leaseId`、`actor`、`evidence` 五个。后五个不是装饰：

- `tenantId` 让判定与幂等键可跨租户隔离（架构文档 §11.2）。
- `leaseGeneration` / `leaseId` 让重试与并发接管可区分，也让迟到结果能被拒绝（`attempt` 只用于 Assignment，见架构文档 §5.6）。
- `actor` 让判定者身份进入审计，不能依赖进程内 initiator 归属。
- `evidence` 承接原型工具 schema 的强制字段（`direction`、`rule_assessments`、`title`、`scope`、`intent_evidence`、`reason`，`src/app/assessment.ts:21-34`），保证换 Assessor 不会降低证据质量。

〔判断〕校验链以架构文档 §5.3 的**唯一版本**为准（`evalId` 幂等 → attempt/fencing → lease → deadline（控制面 `receivedAt`）→ evidence 白名单 → `policyVersion` → outcome/Mandate → 单事务写入 + 审计）。原型的现状是：`evalId` 已严格校验（`src/core/evals.ts:135`），`policyVersion` 在判定回写时已比对（`src/core/evals.ts:284-288`），`Mandate` 规则在 `assessmentOutcome` 与 `Engine.decide` 内校验（`src/app/assessment.ts:275-277`；`src/core/evals.ts:152-154`）；**缺的是 lease/attempt fencing 与 evidence 类型白名单**。关于版本的实际行为：`assessmentOutcome` 用当前 settings 计算 outcome（`src/app/assessment.ts:275`），但 `decideEval` 会以 Eval 上记录的 `policyVersion`（`src/core/evals.ts:111`）与之比较；不一致时活跃 Eval 走 `reassess({code:'policyChanged'})`、非活跃 Eval 以 `unavailable` 结束（`:284-288`），不会把旧版本判定当作有效授权。〔原型〕

上述是原型现状，不是最终处置。架构文档 §13 已把它升级为有界重判协议：版本不匹配的判定进入 `pending-policy`，合并窗口关闭后按最新版本重派，每个 Eval 最多重判 2 次，幂等键为 `reassess:{tenantId}:{evalId}:{policyVersion}`，到上限转人工 `escalated`（〔设想〕，原型无此状态）；本文不再重复其状态机。目标形态另有 `schemaVersion`（协议消息格式版本），与 `policyVersion` 不可合并，见架构文档 §13.1。

### 7.5 权属澄清：Decision 不在 Session 里

〔判断〕外部材料的两条原则——“Event Engine 不依赖任何一种 Agent Runtime”“Agent Session 是可替换的认知执行后端”——与原型结构一致，也需要说清边界：

- 领域层不持有 Session：`Assessor` 是端口（`src/core/ports.ts:49-53`），`Engine.decide` 只接收 `AssessmentOutcome` 与 `evalId`（`src/core/evals.ts:131-146`）。
- 授权事实在 Engine / SQLite：Decision、Mandate、Ticket、Assignment 都是域表，`Mandate` 是不可变记录（`src/core/model.ts:125-133`）。
- Session 只提供认知能力：它读 Thread、仓库，给出判定，不拥有“这条判定是否有效”的权力。

因此，本文所说的瓶颈是**认知串行与目标绑定**，不是状态所有权。把 Assessor 拆成远程进程不需要把 Decision 搬走；相反，如果让远程 Assessor 直接“写 Decision”，授权事实就跨进程了，违背 §3 的同步边界。正确做法仍是 Assessor 交回 `AssessmentResult`，由本地 Engine 在单事务内决定。

## 8. 不要为了“进程隔离”把所有东西都拆成进程

这一节是反向约束，避免过度工程。

| 不该拆的 | 原因 | 证据 |
| --- | --- | --- |
| 确定性 gate | 纯函数、无 I/O、无状态；拆出去只增加延迟与失败点 | `src/policy.ts:191-211`；在事务内调用 `src/core/evals.ts:96` |
| 域事务（Trigger/Decision/Ticket/Mandate） | 授权事实必须单写者单事务；拆开需要分布式事务或 saga | `src/core/engine.ts:48`；`src/core/tickets.ts:37-56` |
| SQLite 单库（单机阶段） | 单机下它是最可靠的队列与事务载体；换成远程库反而引入网络分区 | `src/app/store.ts:51-64`、`src/app/store.ts:136-162`；`src/app/effects.ts:61-66` |
| 进程内 effect 派发（单机阶段） | 队列语义已经具备；只有在多节点共享队列时才需要独立派发器 | `src/app/effects.ts:46-160` |
| Outbox receipt | 它解决的是“外部副作用只发一次”，拆出去不会更好 | `src/app/outbox.ts:26-51` |
| 2 秒 pass 定时器 | 成本极低；改成分布式调度需要协调，收益不成比例 | `src/app/passes.ts:28` |
| 策略解析与版本哈希 | 纯计算；应与 Engine 同进程以保证快照一致 | `src/policy.ts:111-118` |

〔设想〕拆进程的判据只保留四条：**需要不同的故障域、需要不同的凭据/权限域、需要不同的扩缩容曲线、需要不同的运行时/厂商。** 四条都不满足的，留在原地。

## 9. 局限与未验证项

1. **没有多进程原型。** 本文所有进程拆分与租约建议都是设计，不是实测。 〔设想〕
2. **“候选已投递未判定”的补偿缺口是代码推断。** 未做崩溃注入验证；结论依据是 effect 成功即删行（`src/app/effects.ts:130-145`）与 deadline 路径（`src/core/evals.ts:35-69`）。 〔推断〕
3. **没有评估瓶颈的量化数据。** 120 秒 deadline、单 Session 串行、超时路径 `REQUEUES = 2` 都是代码事实，但“繁忙 Router 会导致多少 unavailable”没有压测。 〔判断〕
4. **外部副作用的幂等性未逐 API 验证。** GitHub 评论、PR 创建、Feishu 消息在超时后是否可安全重试，取决于具体 API；原型用 receipt 防重复排队，但没有“结果未知 → 对账”的服务端状态。 〔判断〕
5. **权限隔离没有实测。** 当前两个角色都是 `danger-full-access`，本文建议的只读 Router / 受限 Worker 尚未落地，也没有 OS 级沙箱验证。 〔设想〕
6. **DSH 版本是 alpha。** `steer` / `followup` / `inject` 的语义可能变化；协议不应依赖它们，应通过适配器映射。 〔判断〕
7. **watchdog 没有原型证据。** 它的只读事件消费者定位是本文设定，不是现有实现。 〔设想〕
8. **多租户、多仓库、多节点路由未覆盖。** 原型是“一个 GitHub 仓库 + 可选 Feishu”的单部署；跨仓库/跨租户的 Thread 命名、凭据与配额需要另行设计。 〔判断〕
9. **全局顺序不存在。** 本文只主张按 key 保序；跨 key 的全局顺序没有保证，也不建议追求。 〔设想〕
10. **外部材料的部分厂商细节无法核实。** 页面关于 Codex（`turn/steer`、`thread/inject_items`）与 Claude（`asyncRewake`、Streaming Input）的 API 描述，在本仓库与 DSH 仓库都没有对应代码或文档；本文只采用其结构性结论，未把这些名称当作协议依据。 〔判断〕
11. **`ensure` 的并发幂等未验证。** 现有实现是 resolve-then-create（`src/app/sessions.ts:138-147`），两个并发调用是否只创建一个 Session 取决于 `sessionController.create`，未做并发测试。 〔推断〕
12. **`policyVersion` 的比对在原型中已存在，缺的是有界处置。** `decideEval` 比较 `this.policy().version !== evaluation.policyVersion`，不一致时活跃 Eval 重排、非活跃 Eval 以 `unavailable` 结束（`src/core/evals.ts:284-288`）；`policyChanged` 主动重排所有活跃 Eval（`:218-221`）。仍缺四项：合并/去抖窗口（每次变更立即重排，`:218-221`）；重判上限（`reassess` 无条件回队，仅超时路径有 `REQUEUES = 2`，`:19`、`:222-230`）；lease + attempt fencing（`Assignment` 无 owner/租约/代际字段，`src/core/model.ts:218-233`；唯一跨进程互斥是 stateDir 锁，`src/app/runtime.ts:93`）；饥饿与升级不可观测（无 `escalated`、无重判指标，`src/core/reasons.ts:8`）。处置协议由架构文档 §5.3、§13.2 接管。 〔原型 + 判断〕

## 10. 建议的分阶段落地

### 目标形态：五个平面与原型映射

来源：[分享页“调研Agent事件订阅”](https://chatgpt.com/share/6aeb76b7-8874-83ea-a742-75434a6ce4bf)（读取日期 2026-11-05）。〔外部材料主张 + 判断〕

外部材料给出的目标形态是五层：Event Plane、Decision Plane、Delivery Plane、Agent Runtime、Work Plane。逐层映射到原型后，缺口一目了然：

| 平面 | 外部材料职责 | 原型对应 | 缺口 |
| --- | --- | --- | --- |
| Event Plane | Source 适配器 → Event Ingress → Event Journal → Subscription Registry → Event Router | Source registry 与 Intake（`src/core/intake.ts:19-61`）；Thread 是聚合边界（`src/core/model.ts:156-164`） | 无独立 Ingress、Journal、Subscription Registry、Event Router；事件直接从 Source 进 Engine 事务 |
| Decision Plane | 确定性 Gate → 可插拔 Assessor → Decision → Mandate | `policy.gate`（`src/policy.ts:191-211`）→ `MasterAssessor` → `Engine.decide`（`src/core/evals.ts:131-156`）→ Mandate（`src/core/model.ts:125-133`） | Gate / Decision / Mandate 已在，Assessor 协议是唯一未闭合的端口（另立 `AssessorService`，见架构文档 D7） |
| Delivery Plane | Durable Delivery / Effects → Session Input Adapters | `Effects`（`src/app/effects.ts:46-160`）→ `AgentDelivery`（`src/app/delivery.ts:61-84`） | 无按消费者记录的投递表；适配器不可替换 |
| Agent Runtime | Shared Router / Domain Router / Dedicated Assessor / Workers | 单一主 Session + 按需 worker（`src/app/sessions.ts:138-155`；`src/executor/dsh.ts:424-470`） | 只有 Shared Router 一种形态，无远程运行时 |
| Work Plane | Ticket / Assignment → Worker → Report | Ticket + Mandate + Assignment（`src/core/tickets.ts:37-56`） | 已具备；缺“结果未知”的显式状态 |

〔判断〕这张表也解释了为什么 P0 不该先拆进程：五个平面里，只有 Decision Plane 的端口是“有接缝但没闭合”，其余平面的缺口都可以先在单进程内补齐。

### P0：协议闭合（仍单进程，保留 eager Router）

1. 另立宿主中立的 `AssessorService`（架构文档 D7、§10.2）：`request(candidate) → AssessmentResult`；现有 `Assessor` 端口降为 DSH 适配器。结果带 `tenantId`、`evalId`、`policyVersion`、`assessorId`、`leaseGeneration`、`leaseId`、`actor`、`outcome`、`completedAt`、`evidence`；未持有租约的判定被拒绝。
2. `DecisionCommand` 的认证与校验：校验顺序、失败码与写入事务以架构文档 §5.3 的**唯一校验链**为准，本文不另列；工具调用只是签发这个 command 的一种方式。
3. 持久化 `AssessmentTarget`（tenantId、runtimeType、sessionId、assessorProfile、policyVersion、deliveryState）；`Engine` 不再在构造期写死 session id，但默认仍解析到共享 Router。
4. `RoleTarget` 替代 `masterId` 直投；relay / notice / assessment 统一走角色解析；解析不到时记录并排队。
5. 拆出 Event Journal 与 Delivery 表：事件事实与每个消费者各自的投递行同事务写入。
6. 抽象 `AssessorProvider` / `AssessorInstance`（`create` / `assess` / `dispose`）与 `SessionProvider`（`resolve` / `ensure`）；`AssessorProvider` 是 `AssessorService` 在 DSH 宿主内的装配，不是对外协议；`ensure` 以 `(evalId, assessorProfile)` 为键，重试不能建两个 Session。

验收信号：同一 Eval 重试只产生一个 Assessor Session；迟到、旧 `policyVersion` 与越权 `evidence` 三类 `AssessmentResult` 被拒绝；共享 Router 形态仍可运行。

### P1：队列与租约服务化，允许消费者缺席

7. `Effects` 从“进程内 handler 表”拆成“queue + dispatcher + handler registry”；引入 claim 租约、心跳、ack、visibility timeout、dead-letter。
8. 执行节点注册：nodeId、roles、capacity、heartbeat、drain；`maxWorkers` 从本地设置（`src/policy.ts:93`）升级为节点容量声明。
9. 失败分类补齐 `timeout` / `unknown`；外部副作用超时先对账再重试，不自动重放。
10. 按角色拆凭据与工具白名单：Router 无仓库写权限，Worker 无判定权限，Watchdog 无写权限。
11. 移除 eager ensure：初始化只启动引擎与队列；Router 上线后消费评估队列，无消费者时 Eval 不启动 deadline（从 claim 起算，见 §6.4）。

验收信号：杀掉 Router 进程后，事件仍落库、Eval 不被 deadline 耗光、重启后能被新 Router 接走；节点失联后租约在 TTL 内被回收；另一个节点接管同一工作单元不会写出两份 Decision。

### P2：角色进程拆分与异构

12. Router 适配器：DSH Session（现状）+ 外部 agent（HTTP/队列）。
13. Executor 适配器：`Executor` 端口已存在（`src/core/ports.ts:59-69`），`DshExecutor` 作为本地适配器，新增远程节点适配器。
14. Watchdog 作为事件流的只读消费者，按 §6.10 的输入产出健康与告警，不持有写权限。

### 每阶段的回归信号

- P0：`pnpm check` 通过；新增“同一 Eval 重试”“迟到结果”“旧 policyVersion”“越权 evidence”四类测试；崩溃点注入至少覆盖“已投递未判定”。
- P1：无 Router 时事件不丢；节点失联回收；fencing token；外部超时进入 unknown。
- P2：同一引擎接两个不同实现的角色；替换其一不影响其他角色的测试。

〔判断〕外部材料在“最终落地路线”里把 Event Ingress 排在 Assessor 之前（P1/P2），又在专章建议“先让 Assessor 可插拔”。两处顺序并不一致。本文取后者，但把 Event Journal / Delivery 与 `AssessorService` 协议放在同一个 P0：两者都改协议，拆成两个阶段会经历一次“投递语义已换、判定仍走工具回写”的中间态，迁移成本更高。

## 11. 关键引用索引

| 主题 | 引用 |
| --- | --- |
| 初始化顺序与 eager master | `src/app/runtime.ts:201-218` |
| 写死 masterId 的投递 | `src/app/runtime.ts:131-133`；`src/app/sessions.ts:104-105` |
| Intake 事务 | `src/core/intake.ts:19-61`；`src/core/engine.ts:48` |
| 确定性 gate | `src/policy.ts:191-211`；`src/core/evals.ts:96` |
| Eval 创建与 deadline | `src/core/evals.ts:35-69`、`src/core/evals.ts:107-118` |
| assessment effect | `src/app/assessment.ts:96-104` |
| Decision 工具入口 | `src/app/tools/main.ts:202-220` |
| Ticket 同事务创建 | `src/core/tickets.ts:37-56` |
| launch / worker 创建 | `src/executor/dsh.ts:263-285`、`src/executor/dsh.ts:424-470` |
| 输入投递 | `src/executor/dsh.ts:290-343` |
| effect 队列 | `src/app/effects.ts:46-160` |
| 投递幂等 | `src/app/delivery.ts:16`、`src/app/delivery.ts:61-84` |
| 外部回复 receipt | `src/app/outbox.ts:26-51` |
| 恢复与 RECOVERY_NOTE | `src/core/assignments.ts:21`、`src/core/assignments.ts:83-92`；`src/core/tickets.ts:317-327`；`src/executor/dsh.ts:519-537` |
| 角色端口 | `src/core/ports.ts:49-53`、`src/core/ports.ts:59-69` |
| 角色权限现状 | `src/app/sessions.ts:137-153` |
| DSH Session 写者所有权 | `/Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness/packages/session/session-persistence/README.md:53`、`:90` |
| DSH 投递语义 | `/Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness/packages/core/agent/src/runtime-types.ts:215-241` |
| DSH 模型流式调用 | `/Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness/packages/llm/llm/src/index.ts:1166` |
| 进程内事件订阅 | `src/app/sessions.ts:108-136` |
| 投递状态（delivered / read） | `src/core/engine.ts:181-190`；`src/executor/dsh.ts:495-503` |
| Assessor 结果回写（不在端口） | `src/app/assessment.ts:272-279`；`src/core/evals.ts:131-156` |
| Session 定位与创建 | `src/app/sessions.ts:138-155` |
| Eval 持久字段 | `src/core/model.ts:136-154` |
| 适配层投递映射 | `src/app/delivery.ts:79-81`；DSH 绝对路径 `/Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness/packages/core/agent/src/runtime-types.ts:215-241` |
| DSH webhook 边界 | 绝对路径 `/Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness/packages/experimental/webhook/README.md:12`、`:30`、`:41`、`:71-73` |
| DSH 进程内 initiator 归属 | 绝对路径 `/Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness/packages/core/agent/src/index.ts:233-242` |
