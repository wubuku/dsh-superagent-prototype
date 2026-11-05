# DSH Superagent 原型现状架构（as-built）

本文描述仓库在 `903fc6a` 提交中的真实行为，不描述设计意图。文中的每个机制、默认值和数字都对应到 `文件:行号`；无法从仓库内代码确认的内容集中列在末章〔未核实〕。

本文不依赖任何其他文档：文中出现的概念都在正文内解释。其他材料只在“与既有材料的差异”一章作为被比较对象出现。

## 一句话定位

这是一个 DSH（DeepSeek Harness）bundle 插件。它监听一个 GitHub 仓库（可再启用飞书），把外部事件标准化为 Trigger，用确定性 Policy gate 判定准入强度，由主 Session 评估主动候选，授权后生成 Ticket，并为每个 Ticket 在同一个 DSH Host 进程内创建一个 Worker Session 去执行，最后把回复与通知经持久化队列投递回外部渠道。

## 装配与启动

### 1.1 bundle 的三层入口

`package.json` 声明了 `dsh.bundle.patch`，指向 `cordis.patch.yml`；同一份 `package.json` 没有 `bin` 字段（`package.json:1-125`）。这意味着仓库产出的是 DSH 插件包，不是可执行守护进程。

`cordis.patch.yml` 向 DSH profile 插入三个插件：

| 插件 id | 模块 | 状态 | 位置 |
| --- | --- | --- | --- |
| `dsh-superagent` | 主插件 | 启用 | `cordis.patch.yml:5-6` |
| `dsh-superagent-github` | GitHub Source | 启用 | `cordis.patch.yml:7-8` |
| `dsh-superagent-feishu` | 飞书 Source | `disabled: true` | `cordis.patch.yml:10-12` |

同一个文件还定义了两个 agent preset：Worker 用的 `dsh-superagent-worker`（`cordis.patch.yml:20-120`）和主 Session 用的 `dsh-superagent-router`（`cordis.patch.yml:125-192`）。两者的 shell 都把前台命令在 5 秒后转入后台作业，目的是不让长命令挡住人类消息。

主机侧入口是 `src/index.ts`：

- 插件名 `dsh-superagent`（`src/index.ts:7`）。
- `inject` 声明了 11 个宿主服务：`agents`、`sessionController`、`sessionPersistence`、`workspaceRegistry`、`permissionPresets`、`tools`、`systemPrompt`、`skills`、`webServer`、`llm`、`subprocess`（`src/index.ts:8`）。
- `apply` 先关掉 DSH 自动生成的设置页，因为本插件自带管理面板（`src/index.ts:12-13`）。
- 然后构造 `Runtime`，把 `restart` 回调交给它，并注册停机副作用（`src/index.ts:18-22`）。
- 最后等待 `runtime.ready`，根据是否完成 setup 输出不同日志（`src/index.ts:23-24`）。

### 1.2 Runtime 构造：先锁目录，再开库

`Runtime` 是组合根，本身不含领域规则（`src/app/runtime.ts:54-59`）。构造顺序是固定且不可交换的：

| 步骤 | 动作 | 位置 |
| --- | --- | --- |
| 1 | 把插件注册为 Cordis 服务 `orchestrator` | `src/app/runtime.ts:88` |
| 2 | 以 `0o700` 创建 `stateDir` | `src/app/runtime.ts:91` |
| 3 | 对 `stateDir` 取 `proper-lockfile` 锁，`stale: 30_000`，锁被破坏时把运行时健康置 error 并中止全局 `AbortSignal` | `src/app/runtime.ts:92-93` |
| 4 | 打开 `<stateDir>/orchestrator.sqlite` | `src/app/runtime.ts:98` |
| 5 | 从 KV 读取主 Session id，没有则以 `orchestrator-<stateDir 的 SHA-1>` 生成并写回 | `src/app/runtime.ts:104-105` |
| 6 | 依次构造 `Setup`、`Prompts`、`Commands`、`Effects`、`SourceRegistry`、`Sessions`、`Settings`、`DshExecutor`、`MasterAssessor`、`Outbox`、`Engine`、`Passes` | `src/app/runtime.ts:99-158` |
| 7 | 把初始化 Promise 挂到 `this.ready` | `src/app/runtime.ts:166` |

锁在开库之前拿到，是为了阻止第二个进程在写库或迁移时进入（`src/app/runtime.ts:90-93`）。构造失败时先关库、再释放锁，避免进程内重启拿不到锁（`src/app/runtime.ts:167-171`）。

### 1.3 初始化：先开 HTTP，再决定是否进入运行态

`Runtime.initialize()`（`src/app/runtime.ts:201-218`）：

1. 先注册管理 HTTP 路由，再执行 setup。这样即使 setup 未完成，操作者仍能在面板里修复配置（`src/app/runtime.ts:202-203`）。
2. `setup.run()` 返回 false 时，只把运行时健康置为 `paused/setupPending` 并返回；此时没有主 Session、没有 passes、没有 effects 消费（`src/app/runtime.ts:204-207`）。
3. setup 完成后，安装 Session 事件订阅与执行器订阅（`src/app/runtime.ts:208-209`）。
4. **急切创建主 Session**：`sessions.ensure(masterId, stateDir, 'dsh-superagent orchestrator', 'orchestrator')`（`src/app/runtime.ts:210`）。
5. 对每个可同步的 Source 执行一次策略同步，失败只记录在健康条目（`src/app/runtime.ts:211`）。
6. 检查是否已在等待 setup 期间被停止；未停止才恢复执行器、启动 passes 与 effects（`src/app/runtime.ts:213-216`）。
7. 健康置 `ready`（`src/app/runtime.ts:217`）。

因此，主 Session 不是按需创建，而是 setup 完成后立即存在。这是后文 Router 角色的关键事实。

### 1.4 停机

`stop()` 是幂等的，重复调用共享同一个 Promise（`src/app/runtime.ts:228-229`）。停机顺序（`src/app/runtime.ts:230-253`）：

1. 置 closing 标志，停止 passes 定时器，中止全局 `AbortSignal`。
2. 停止 assessor。
3. 收集主 Session 与全部 `worker-<ticketId>` Session，对同进程内的 agent 逐个 `cancel({keepInbox: true})`。
4. 等待 passes、effects drain、agent 空闲。
5. 停止并释放执行器，释放 Session，移除 HTTP 等 disposer。
6. flush DSH 的 Session 持久化。
7. 恢复进程环境变量，关闭 SQLite，最后释放目录锁。

关闭数据库在释放锁之前，防止另一个进程在写入中途打开数据库（`src/app/runtime.ts:245-251`）。

## 运行时分层

代码按职责分为六层，层与层之间只通过构造参数和窄接口连接。

| 层 | 目录 | 职责 | 代表文件 |
| --- | --- | --- | --- |
| 装配层 | `src/app/` | 组合根、HTTP、设置、Session、Outbox、Effects、Passes、视图 | `runtime.ts`、`http.ts`、`sessions.ts`、`outbox.ts`、`effects.ts`、`passes.ts` |
| 领域核心 | `src/core/` | Trigger 摄入、Thread 关联、Eval、Decision、Ticket、Assignment、Stage | `intake.ts`、`evals.ts`、`engine.ts`、`tickets.ts`、`model.ts` |
| 策略 | `src/policy.ts`、`src/admission.ts` | 默认值、schema、gate、策略版本哈希、准入表、Mandate 校验 | `policy.ts`、`admission.ts` |
| 执行 | `src/executor/` | 工单目录准备、Worker Session、槽位、报告、重试、恢复 | `dsh.ts` |
| 来源 | `src/sources/` | GitHub/飞书轮询与事件消费、注册表、共享轮询 | `github.ts`、`feishu.ts`、`registry.ts`、`poll.ts` |
| 基础设施 | `src/infra/` | 健康板、命令封装、环境变量、文本缓存 | `health.ts`、`commands.ts`、`environment.ts` |
| 客户端 | `src/client/` | 管理面板 React 组件与 API 调用 | `api.ts`、各页面 |

领域核心不直接操作系统：它通过 ports 声明 `Assessor`、`Executor`、`Outbox`、`SourceScope` 等接口，由装配层注入实现。`EngineForExecutor`、`EngineForMainSession`、`EngineForPeople`、`EngineForSettings` 这几个窄接口把可调用面限制在各自角色（`src/core/engine.ts:267-280`）。

## 事件从哪来，如何进入

### 3.1 两个来源的采集方式

GitHub Source 是轮询，不是 webhook：

- 默认 `pollSeconds` 为 60，范围 60–3600（`src/sources/github.ts:25`）。
- 每轮通过 `gh api` 读取 issues、pull requests、comments、review comments、CI checks、notifications 等流（`src/sources/github.ts:179-247`、`src/sources/github.ts:298-400`）。
- 回看窗口是 `POLL_HORIZON_MS = 14 * 24 * 3600_000`，即 14 天（`src/sources/poll.ts:6`）；读取时把游标时间与 14 天漏斗取较大值（`src/sources/github.ts:209-211`）。
- 轮询游标与 ETag 存在 Source 的 KV 状态里；列表未变化时用 `If-None-Match` 换 304（`src/sources/github.ts:212-232`）。
- 每轮结束按配置的 `pollSeconds` 休眠，取下限 60 秒（`src/sources/github.ts:144`）。
- 连续失败达到 `failuresBeforeError`（默认 3）后，健康条目报 error（`src/sources/github.ts:25-26`、`src/sources/github.ts:141`）。

飞书 Source 是“常驻 CLI 子进程 + 回填轮询”：

- 用 `spawn` 执行 `lark-cli event consume im.message.receive_v1 --as bot`，从 stdout 读 NDJSON（`src/sources/feishu-loops.ts:70-71`）。
- 消费者 45 秒内未 ready 就判失败（`src/sources/feishu-loops.ts:78`）。
- 单行超过 1 MiB 直接报错（`src/sources/feishu-loops.ts:88`）。
- 消费者崩溃后的重启间隔：运行不足 60 秒时 1 秒起指数退避，上限 60 秒（`src/sources/feishu-loops.ts:67-69`）。
- 历史回填每 60 秒一轮，首次没有游标时把“现在”写成游标，不回灌历史（`src/sources/feishu-loops.ts:128-159`）。
- 聊天名称列表每 60 秒刷新一次，独立于回填（`src/sources/feishu-loops.ts:116-125`）。
- 已订阅 Thread 的轮询也受 14 天漏斗限制；超出漏斗且没有活动工单的 Thread 不再轮询（`src/sources/poll.ts:5-8`、`src/sources/poll.ts:17-28`）。

两个 Source 都不是 HTTP webhook 接收端。GitHub 靠主动拉取；飞书靠 CLI 在外部建立长连接并把事件写到 stdout。

### 3.2 从 Source 到 Engine 的调用链

每次采集到事件后，Source 调用 `ctx.receive(trigger)`（GitHub：`src/sources/github.ts:232`、`:241`、`:268`；飞书：`src/sources/feishu-loops.ts:26-27`）。这条链是：

```text
SourceKind.apply
  -> SourceContext.receive
  -> Runtime.sourceDeps.receive        (src/app/runtime.ts:161)
  -> Passes.receive                    (src/app/passes.ts:34-39)
  -> Engine.receive                    (src/core/engine.ts:48)
  -> Intake.receive                    (src/core/intake.ts:19-62)
```

`Engine.receive` 把整个摄入放进一个 `atomic` 事务（`src/core/engine.ts:48`）。`Intake.receive` 在这个事务内做五件事：

1. 规范化时间戳；Trigger 必须至少属于一个 Thread，否则抛错（`src/core/intake.ts:20-22`）。
2. 按 Trigger id 查重，已存在直接返回 `duplicate`（`src/core/intake.ts:23`）。
3. 用 `SourceScope.scope(trigger)` 判断是否被监听、是否被观察；未监听时只落 Trigger 和 `filtered` disposition，然后返回（`src/core/intake.ts:25-29`）。
4. 落 Trigger，更新 Thread 的 `lastAt` 与 `correlated`，按 Thread 订阅关系把 Trigger 扇出到活动工单；只有“人类、非 context、非 human-stopped”的消息能让已结束工单恢复（`src/core/intake.ts:30-48`）。
5. 给命中的工单加 `Input`，写 disposition（`fanout`/`context`），并决定是否排队评估：**没有任何工单承接时才 `queueForEval`**（`src/core/intake.ts:49-59`）。

最后发出 `trigger.received` 域事件（`src/core/intake.ts:60`）。

### 3.3 域事件的处理

`Engine` 的 `emit` 是进程内回调，不是持久事件日志。`Runtime` 在构造 `Engine` 时注册一个 `emit` 处理函数（`src/app/runtime.ts:137-153`），做三件事：

1. 当没有主 Session 工具正在执行（`quiet === 0`）时，把域事件转成通知注入主 Session（`src/app/runtime.ts:139-141`）。
2. 对 `trigger.received`、`ticket.resumed`、`trigger.followup` 追加 follow-up 通知（`src/app/runtime.ts:142-146`）。
3. 对 `ticket.ended`，如果是通过 PR 结束，则生成对外回复消息并交给 Outbox（`src/app/runtime.ts:147-152`）。

事件只在事务提交前由领域代码发出；`Runtime` 的处理是同步的内存操作，需要持久化的动作必须自己进 effect 队列或 outbox。仓库里没有可回放的事件表。

## 准入与策略

### 4.1 策略默认值

策略 schema 的默认值直接决定了原型开箱行为：

| 配置 | 默认值 | 位置 |
| --- | --- | --- |
| `eval.mode` | `observe` | `src/policy.ts:84` |
| `eval.timeoutSeconds` | 120（范围 30–600） | `src/policy.ts:85`、`src/limits.ts:5` |
| `executor.maxWorkers` | 3（范围 1–16） | `src/policy.ts:93`、`src/limits.ts:6` |
| 部署 `promptMaxChars` | 100000 | `src/deployment.ts:24` |
| 准入上下文最多读取页数 | 10 | `src/deployment.ts:26` |
| 单次准入上下文读取超时 | 15000 ms | `src/deployment.ts:28-30` |

`observe` 的含义是：gate 可以判出“本来会接受”，但不会建工单；只有 `auto` 且命中已启用规则时，推断候选才可能被接受（`src/policy.ts:212`）。

### 4.2 策略版本

`policyVersion` 是对三部分内容做 SHA-1 得到的字符串：规则列表、评估模式、各 Source 的策略（含 bot 列表）（`src/policy.ts:116-117`）。它被写入每次 Evaluation、Decision 与 Mandate。

版本的作用在 `decideEval`：回写判定时，如果当前策略版本不等于 Evaluation 上记录的版本，活跃 Eval 会 `reassess`，非活跃 Eval 以 `unavailable` 结束（`src/core/evals.ts:284-288`）。`policyChanged` 还会主动把所有活跃 Thread 的 Eval 重排（`src/core/evals.ts:216-220`）。

### 4.3 gate 如何判强度

`settingsPolicy` 返回的 `gate` 把人消息与机器消息分开处理（`src/policy.ts:171-212`）。

人类消息：

- 发送者在允许列表且消息明确点名 agent（`addressed`）→ 直接 `explicit`，依据是 `via: 'addressed'`（`src/policy.ts:197`）。
- 否则查准入表单元。明文接受 → `explicit`；否则再看是否属于参与中的 Thread 的 follow-up：允许发送者给 `explicit`，非允许发送者给 `inferred`（`src/policy.ts:198-208`）。
- 准入表给 `inferred` 且 `mode` 不为 `off` → `inferred`（`src/policy.ts:209`）。
- 其余情况拒绝，原因可能是 `not_a_member`、`admission_ignored`、`no_mention`（`src/policy.ts:210`）。

机器消息：

- 有 actor id 但不在该 Source 的 `bots` 列表中 → `not_human`（`src/policy.ts:171-173`）。
- 在 `bots` 列表中 → 最多是 `inferred`，依据 `via: 'bot'`；`mode: off` 时拒绝（`src/policy.ts:174-180`）。
- 没有 actor id 的系统/CI 事件 → 走“未列出且未点名”的准入表单元，只有该单元给 `inferred` 且 `mode` 不为 `off` 才准入（`src/policy.ts:181-186`）。

`bots` 列表由各 Source 的 kind 校验，解析失败时按空列表处理（`src/policy.ts:122-125`）。

### 4.4 评估、截止与判定

`Evals` 按 Thread 合并 Trigger，一个 Thread 的排队 Trigger 合并为一次 Evaluation（`src/core/evals.ts:22-23`）。

- 评估 id 由 Thread、策略版本、时间和待评估 Trigger 一起哈希（`src/core/evals.ts:107`）。
- 截止时间 = 开始时间 + `evalTimeoutMs`（`src/core/evals.ts:108`）。
- 未投递的 Eval 不会过期；已投递的到期后重排，连续过期超过 `REQUEUES = 2` 才记为 `unavailable`（`src/core/evals.ts:19`、`:43`、`:57-62`）。
- 处理暂停期间，已开始的 Eval 记录暂停起点，恢复后把截止时间顺延暂停时长（`src/core/evals.ts:31-41`）。

判定结果有 `accept`、`stop`、`ignore`、`unavailable` 四类。`accept` 时会生成不可变 Mandate（强度、策略版本、依据、actor、scope），用 `key('ticket', evalId)` 生成工单 id，并在同一事务里创建工单（`src/core/evals.ts:305-317`）。`stop` 只允许对活动工单、且评估强度为 `explicit` 时生效（`src/core/evals.ts:292-302`）。

`Engine.decide` 还有两层幂等与权限检查：同一个 Trigger 已经建过工单时返回原工单的 Decision，不再建第二张（`src/core/evals.ts:131-146`）；推断候选的接受必须落在 `auto` 模式且命中已启用规则（`src/core/evals.ts:152-154`）。

### 4.5 Mandate 的复查

恢复已结束工单前会重新验证 Mandate（`src/policy.ts:226-255`）。复查覆盖：

- 来源 scope 是否仍被监听；
- 匹配规则是否仍启用；
- follow-up 的显式/推断条件；
- bot 是否仍在 bot 列表；
- 准入表单元是否仍给出不低于原强度的授权；
- 观察型推断是否仍处于 `auto` 且规则全开。

策略变更还会按工单逐条计算效果：例如从 `observe` 切到其他模式、或从 `auto` 切走，会关闭已存在的主动授权（`src/policy.ts:155-166`）。

## 工单与执行

### 5.1 工单对象

一个 Ticket 携带：来源 Trigger、多个 Assignment、Inputs、渠道、Thread 绑定、Mandate、执行信息、结束原因（`src/core/model.ts:276-307`）。

关键状态：

- `liveTicket(ticket)` 等价于“没有 `ended`”（`src/core/model.ts:317-318`）。
- Assignment 状态只有 `pending`、`running`、`ended`（`src/core/model.ts:211`）。
- 只有最新 Assignment 被视为当前 Assignment（`src/core/model.ts:334`）。
- 结束原因记录 `at`、`by`、`outcome`、可选 `reason`（`src/core/model.ts:284-285`）。

Stage 分类把工单归入四类：`ended`（已结束）、`person`（需要人处理，动作可能是 `delivery`、`answer`、`review`、`blocked`、`failed`）、`working`（执行中或尚未启动）、`idle`（等待中或回合已结束）。归类逻辑在 `src/core/stage.ts:9-22`。

### 5.2 启动一个 Assignment

`DshExecutor.start` 不直接启动进程，只入队 `launch` effect（`src/executor/dsh.ts:268-270`）。`launchQueued` 做以下检查后才真正启动（`src/executor/dsh.ts:272-285`）：

- 工单仍存在且未结束；
- 最新 Assignment id 匹配；
- Assignment 状态仍是 `pending`；
- 先保留一个 worker 槽位。

真正的 `launch`（`src/executor/dsh.ts:425-470`）：

1. 再检查 closing、paused、工单与 Assignment 是否仍有效。
2. 工作目录不存在时执行 prepare 命令；目录已存在就视为已准备（`src/executor/dsh.ts:435-439`）。
3. `sessions.ensure(workerSessionId(ticket.id), workspace, ticket.title, 'worker')` 创建 Worker Session（`src/executor/dsh.ts:441`）。
4. 先停止被替换的旧 Assignment 的后台工作，避免旧回合的结束清掉新消息（`src/executor/dsh.ts:443`）。
5. 清掉仍留在 Session inbox 里的重复 Input，再发送 assignment 消息（`src/executor/dsh.ts:445-450`）。

### 5.3 Worker Session 与槽位

Session id 规则是 `worker-<ticketId>`（`src/executor/dsh.ts:23-26`）。Worker Session 也通过同一个 `ctx.sessionController.create` 创建（`src/app/sessions.ts:142-145`），并设置 `danger-full-access` 权限（`src/app/sessions.ts:152`）。因此 Worker 与 Router 在同一个 DSH Host 进程、同一个 OS 用户下运行。

`WorkerSlots` 的规则：

- 上限来自 `executor.maxWorkers`（`src/executor/dsh.ts:230`）。
- `reserve(ticketId, by)` 的 `by` 是 `launch`、`wake`、`person`（`src/executor/dsh.ts:192`）。
- 人类消息可以额外占用一个槽位；唤醒优先于新启动（`src/executor/dsh.ts:308`）。
- 拿不到槽位时，launch/delivery 抛 `Later`，按该类型的 `retry[0]` 重排且不计失败：launch 是 5 秒，delivery 与 assessment/relay/notice 是 2 秒（`src/app/effects.ts:138-139`）。
- 唤醒路径每 5 秒重试一次（`src/executor/dsh.ts:564-575`）。

### 5.4 执行失败与恢复

- 准备命令超时 10 分钟（`src/executor/dsh.ts:28`）。
- 临时性 provider/网络失败最多 3 次，退避 15 秒起、指数增长（`src/executor/dsh.ts:30`、`:550`、`:575`）。
- 后台作业与子代理运行上限 30 分钟（`src/executor/dsh.ts:32`）。
- 停机时等待后台任务 10 秒（`src/executor/dsh.ts:34`）。
- 启动失败不是临时错误时，工单进入失败态，等待人类输入或显式重试（`src/executor/dsh.ts:279-283`）。

启动时 `resume()` 会扫描活动工单：已 `running` 的 Assignment 报告 `assignmentInterrupted` 并重排；`pending` 且不等待人的启动重新入队，旧工单优先（`src/executor/dsh.ts:524-535`）。

### 5.5 输入投递

`deliverQueued` 每次只投递队首 Input，并在投递前重新读取工单状态；工单结束或 Assignment 换人时立即停止（`src/executor/dsh.ts:287-330`）。投递失败的 error 记录在工单自身（`delivery` effect 是 `quiet: true`），而不是 effect 健康条目（`src/executor/dsh.ts:235`）。

## 效果与投递

### 6.1 Effects 是唯一的持久化副作用队列

`Effects` 建立在 SQLite `effect` 表上，命令在事务内 `enqueue(kind, key, payload)`，队列在提交后才开始执行（`src/app/effects.ts:42-66`）。

同一 `(kind, key)` 只有一行；重复入队会替换 payload、`generation + 1`、`attempts = 0`、`due` 立即，但保留 `seq` 队列位置（`src/app/effects.ts:61-65`）。

默认行为：

- 并发上限 1（`src/app/effects.ts:70`）。
- 重试区间 `[2000, 60_000]`，即 2 秒起指数退避到 60 秒（`src/app/effects.ts:70`、`:141`）。
- `ordered` 类型按 `seq` 取最老一行，失败会挡住同类型后续行（`src/app/effects.ts:105-113`）。
- `Later` 不计失败，只按该类型的 `retry[0]` 重排（`src/app/effects.ts:138-139`）。
- 连续失败 3 次后该类型健康置 error；`quiet` 类型除外（`src/app/effects.ts:7`、`:155-159`）。
- `drain` 停止取新行，运行中的行保留在库里，下次 `start` 重新认领（`src/app/effects.ts:98-102`、`:136-137`）。

六种 effect 的实际参数：

| kind | 处理器 | 并发 | 重试 | 位置 |
| --- | --- | --- | --- | --- |
| `assessment` | `MasterAssessor` | 4（暂停时 0） | 默认 2s→60s | `src/app/assessment.ts:96-101` |
| `launch` | `DshExecutor` | 空闲槽位数（暂停时 0） | 5s→300s | `src/executor/dsh.ts:232-233` |
| `delivery` | `DshExecutor` | 4（暂停时 0） | 默认 2s→60s；`quiet` | `src/executor/dsh.ts:235` |
| `relay` | `Sessions` | 1，有序 | 默认 2s→60s | `src/app/sessions.ts:104` |
| `notice` | `Sessions` | 1，有序 | 默认 2s→60s | `src/app/sessions.ts:105` |
| `reply` | `Outbox` | 1（暂停时 0） | 5s→300s | `src/app/outbox.ts:24` |

### 6.2 Outbox 的幂等

每条外发消息先写 receipt，再在同一个事务里入队 `reply` effect；重复 message id 被忽略（`src/app/outbox.ts:26-31`）。

- 发送前检查 receipt 仍是 `pending`，且该 Source 已启用；未启用抛 `Later`（`src/app/outbox.ts:41-43`）。
- 同一工单、同一会话若还有更早的消息未失败到 3 次，后续消息抛 `Later`，保证顺序（`src/app/outbox.ts:45`）。
- 渠道被策略忽略时 settle 为 `channelIgnored`；目标永久不可达时 settle 为 `channelGone`，避免无限重试（`src/app/outbox.ts:46-50`）。
- `withdraw` 在事务里撤回 receipt 并取消对应 effect（`src/app/outbox.ts:34-36`）。

## 持久化与并发

### 7.1 SQLite 配置与表

`Store` 打开数据库后立刻执行 `PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL`（`src/app/store.ts:64`）。九张表在第一次打开时建立（`src/app/store.ts:72-80`）：

| 表 | 主键/结构 | 用途 |
| --- | --- | --- |
| `kv` | `key` | 单值状态、设置修订、Source 游标 |
| `trigger` | `id` | 原始 Trigger |
| `disposition` | `id` | 过滤/扇出/评估/判定去向 |
| `thread` | `key` | Thread 聚合（含 `evaluating`、订阅） |
| `ticket` | `id` | 工单聚合 |
| `decision` | `id`，带 `thread` 列 | 判定记录 |
| `outbox` | `id` | 外发消息 receipt |
| `trigger_thread` | `(thread, id)` | 本索引，用于按 Thread 查 Trigger |
| `effect` | `(kind, key)` | 持久副作用队列 |

`atomic(fn)` 用 `SAVEPOINT` 实现，嵌套调用安全（`src/app/store.ts:144` 附近）。`afterCommit` 只在提交后执行内存回调，不回滚（`src/app/store.ts:157-159`）。

### 7.2 单写者与进程边界

并发写只允许一个进程：`stateDir` 的 `proper-lockfile`（`stale: 30_000`）在开库前取得（`src/app/runtime.ts:93`）。这是仓库里唯一的跨进程互斥手段。

在同一进程内，所有领域写入都经过 `Store.atomic`，`Engine` 的每个命令各自是一个事务（`src/core/engine.ts:48`、`:256`）。因此“单写者规则”在此刻的含义是：一个 DSH 进程 + 一个 SQLite 文件 + 一个目录锁。

Schema 版本是 11；只接受 10 或 11，遇到更新的库直接拒绝启动，10 升级到 11 在启动时执行一次（`src/app/migration.ts:20`、`src/app/store.ts:56`、`src/app/store.ts:66-95`）。

设置与提示词使用 `Versions` 追加保存；设置历史读取上限默认 20 条（`src/app/store.ts:198-199`）。Trigger、Disposition、Decision、Ticket、Outbox receipt 没有删除路径，只有 effect 完成时删行；因此这些表随时间单调增长。

## 对外接口

### 8.1 管理 HTTP API

只在回环 Web 服务器上注册；启动时若 `webServer.host` 不是 `127.0.0.1` 直接抛错（`src/app/http.ts:231`）。路由前缀是 `/orchestrator/api`（`src/app/http.ts:234-236`）。

鉴权不是令牌，而是三个条件同时满足：

1. Host 必须是 `127.0.0.1:<port>` 或 `localhost:<port>`（`src/app/http.ts:77`）。
2. 请求头必须有 `x-orchestrator-request: 1`（`src/app/http.ts:78`）。
3. 若有 `Origin`，必须等于 `http://<host>`（`src/app/http.ts:78`）。

请求体默认上限 `128 * 1024` 字节（`src/app/http.ts:62`）；提示词保存另有按 `promptMaxChars` 计算的上限（`src/app/http.ts:154`）。

路由表（`src/app/http.ts:151-213`；下表路径省略 `/orchestrator/api` 前缀）：

| 方法与路径 | 作用 |
| --- | --- |
| `GET /state` | 运行态与 setup 摘要 |
| `GET /overview` | 概览、健康、策略版本、执行器负载 |
| `GET /search` | 全文/链接搜索 |
| `GET /sources` | Source 实例与健康 |
| `GET /settings` | 设置块列表与修订 |
| `POST /sources/:id/labels` | 刷新 Source 标签 |
| `GET /threads`、`GET /threads/:key` | Thread 列表与详情 |
| `POST /threads/:key/unsubscribe` | 取消订阅 |
| `POST /triggers/:id/requeue` | 重新排队评估 |
| `GET /decisions`、`POST /decisions/:id/dismiss` | 判定列表与忽略 |
| `GET /tickets`、`GET /tickets/:id` | 工单列表与详情 |
| `POST /tickets/:id/retry`、`POST /tickets/:id/stop` | 重试、停止 |
| `POST /executor/pause` | 暂停/恢复处理 |
| `PUT /settings/:block` | 按修订保存设置块 |
| `GET /policy/history` | 策略历史 |
| `POST /policy-sync/:id` | 同步 Source 策略 |
| `POST /setup/check` | 重新检查 setup |
| `GET /models` | 模型目录 |
| `GET /prompts`、`PUT /prompts`、`POST /prompts/preview` | 提示词读取、保存、预览 |

设置保存带乐观并发：修订不匹配抛 `SettingsConflict`（`src/app/settings.ts:21`、`:151`、`:168`），HTTP 映射为 409（`src/app/http.ts:89`）。执行环境与账户命令的修改只允许来自 `panel`，非面板来源抛 `panelOnlyEnvironment`；Source 账户切换同理抛 `panelOnlyAccounts`（`src/app/settings.ts:41-51`）。这层 guard 是防提示注入的边界，不是 OS 安全边界，因为 agent 本身能跑 shell。

### 8.2 模型工具面

主 Session 有 14 个应用工具：13 个 `orchestrator_*` 加 `orchestrator_read`。

| 用途 | 工具 |
| --- | --- |
| 读取与路由 | `orchestrator_read`、`orchestrator_route` |
| 工单管理 | `orchestrator_ticket_retry`、`orchestrator_ticket_request_status`、`orchestrator_ticket_note` |
| 重新评估 | `orchestrator_trigger_requeue` |
| 主动候选评估 | `orchestrator_eval`、`orchestrator_eval_read`、`orchestrator_eval_decide` |
| 沟通与退订 | `orchestrator_reply`、`orchestrator_thread_unsubscribe` |
| 配置 | `orchestrator_settings_save`、`orchestrator_policy_sync`、`orchestrator_prompts_save` |

工具注册位置：`src/app/tools/main.ts:127`、`:162-280`，`orchestrator_read` 在 `src/app/tools/tool.ts:25`。

Worker Session 有 6 个应用工具：`orchestrator_read`、`orchestrator_ack`、`orchestrator_thread_unrelated`、`orchestrator_thread_follow`、`orchestrator_trigger_handback`、`orchestrator_report`（`src/app/tools/executor.ts:29-75`、`src/app/tools/tool.ts:25`）。

主 Session 的 `noWait` 守卫会拒绝：命令位置是 `sleep`、shell `timeoutMs` 大于 30 秒、`job_output` 等待大于 5 秒（`src/app/sessions.ts:77-84`）。

## 可观测性

健康板是一个命名条目的集合，条目一旦被某个部件 claim 就不能被第二个部件 claim（`src/infra/health.ts:15-34`）。当前条目来源：

| 条目 | 谁写入 | 位置 |
| --- | --- | --- |
| `runtime` | Runtime 启动、pass 失败、锁被破坏、关闭 | `src/app/runtime.ts:75`、`src/app/passes.ts:40-45` |
| `models` | Sessions 的模型/账号状态 | `src/app/runtime.ts:121` |
| `worker` | 执行器 | `src/app/runtime.ts:128` |
| `evals` | 每拍根据最近一小时是否有 `unavailable` 评估更新 | `src/app/runtime.ts:154-156` |
| `github` | GitHub Source | `src/sources/github.ts:63` |
| `feishu`、`history` | 飞书 Source | `src/sources/feishu.ts:53` |
| `assessment`、`launch`、`delivery`、`relay`、`notice`、`reply` | 各 effect 类型 | `src/app/effects.ts:69` |
| `sync:<source-id>` | 设置同步 | `src/app/settings.ts:101-103` |

除此之外没有指标端点、没有 trace、没有结构化审计表。可观测性由“文本健康条目 + 管理 API + DSH Session 持久化”构成。

## 角色在代码中的真实对应

这一章给出结论，不做推测。

### Router

**Router 是主 Session，不是独立进程，也不是独立服务。**

- 它在 setup 完成后被急切创建：`sessions.ensure(masterId, ..., 'orchestrator')`（`src/app/runtime.ts:210`）。
- 它使用 preset `dsh-superagent-router`（`src/app/sessions.ts:48`、`:127`、`:145`）。
- 它的模型评估职责由 `MasterAssessor` 通过 `assessment` effect 把候选卡 steer 到它（`src/app/runtime.ts:131-133`、`src/app/assessment.ts:93-101`）。
- 它没有独立健康条目；它的进程生命周期就是 DSH Host 生命周期。
- 它和 Worker 一样被设置 `danger-full-access`（`src/app/sessions.ts:152`）。

因此“Router 缺席”在代码里不成立：没有主 Session 时，评估无法投递，`MasterAssessor` 的 deliver 目标是构造时固定的 `masterId`。

### Worker

**Worker 是按工单创建的 DSH Session，仍在同一进程内。**

- id 为 `worker-<ticketId>`（`src/executor/dsh.ts:23-26`）。
- 创建时机是 `launch` effect 真正执行时（`src/executor/dsh.ts:441`），或在投递输入时发现 Session 被外部删除后重建（`src/executor/dsh.ts:313-316`）。
- 每个 Worker 有独立工作目录（`ticket.execution.directory`），由 prepare 命令准备（`src/executor/dsh.ts:250-266`、`:435-439`）。
- 没有跨进程 Worker，也没有节点注册；`ctx.agents.get` 取的是同进程内的 agent（`src/app/runtime.ts:234-236`）。

### Watchdog

**代码中不存在 watchdog。**

证据：

- `src/` 内没有 watchdog 模块或角色；仓库的 `package.json` 没有 `bin`，不存在独立监控进程。
- 唯一的后台循环是 Source 轮询、飞书消费者、passes 定时器、effects 泵；它们都写在各自模块里，不构成“只读观察者”。
- 健康板是**被动**的：条目由被观察者自己 `set`（`src/infra/health.ts:6`、`:15-34`），没有第三方核对。
- 仓库里有一个运维脚本 `scripts/dsh-superagent`（250 行），用 tmux 启动 `dsh --profile <profile> --no-open`，通过管理 API 读状态并停止进程（`scripts/dsh-superagent:159-205`）。它是进程级启停工具，不是 watchdog：它不读业务事实、不做对账、不参与授权。

### 三者的关系

| 角色 | 真实对应 | 生命周期 | 进程 |
| --- | --- | --- | --- |
| Router | 主 Session（`orchestrator-<hash>`） | 随 Runtime 启动急切创建，随 Runtime 停止取消 | DSH Host 进程内 |
| Worker | 每工单一个 Session（`worker-<ticketId>`） | 按 `launch` 创建，工单结束/停机时取消 | 同一 DSH Host 进程内 |
| Watchdog | 无 | 无 | 无 |

## 已知缺口（仅记录，不给方案）

以下条目只记录“代码此刻没有某物”，不提出修复方向。

1. 没有 watchdog：没有独立只读观察者，没有第三方健康核对（见第 10 章）。
2. 没有 daemon 打包：`package.json` 无 `bin`；只有外部 Python 脚本用 tmux 托管 DSH 进程（`package.json:1-125`、`scripts/dsh-superagent:159-205`）。
3. 没有 webhook 接收端：GitHub 走轮询（`src/sources/github.ts:25`、`:133-144`）；飞书走 CLI 子进程（`src/sources/feishu-loops.ts:70-71`）。
4. 没有 lease/fencing：`Assignment` 只有状态，没有 owner、lease id、代次字段（`src/core/model.ts:211-232`）；唯一互斥是目录锁（`src/app/runtime.ts:93`）。
5. 没有跨进程/多节点执行：所有 Session 由同一 `ctx.sessionController` 创建（`src/app/sessions.ts:142-145`）；没有节点注册表。
6. 没有通用事件日志与按消费者投递表：`emit` 是进程内回调（`src/app/runtime.ts:137-153`）；持久化只有 `effect` 队列、`outbox` receipt、`trigger`/`disposition`。
7. 没有多租户：没有 tenant 字段，也没有按租户隔离的配置或数据库。
8. 没有保留策略：`trigger`、`disposition`、`decision`、`ticket`、`outbox` 没有删除路径；设置历史只限制读取条数，不删除旧行（`src/app/store.ts:198-199`）。
9. 没有指标与追踪：运行时依赖只有 `proper-lockfile` 和 `zod`（`package.json` 的 `dependencies`）；没有 metrics/tracing 库或端点。
10. 管理 API 没有令牌：鉴权只有回环地址、同源和自定义请求头（`src/app/http.ts:62`、`:77-78`、`:231`）。
11. 评估超时重排有上限：连续过期超过 2 次后记为 `unavailable`，没有升级到人工的独立状态（`src/core/evals.ts:19`、`:62`）。
12. 工单执行没有按工单目录的锁：除 `stateDir` 全局锁外，代码里没有第二个锁文件或按目录的互斥（`src/app/runtime.ts:93`）。

## 证据索引

关键结论与代码位置的对照表。行号以本文写作时的 `903fc6a` 为准。

| 结论 | 证据 |
| --- | --- |
| 仓库是 DSH bundle，不是独立可执行文件 | `package.json:1-125`（无 `bin`）、`cordis.patch.yml:4-12` |
| 默认只启用 GitHub，飞书默认禁用 | `cordis.patch.yml:10-12` |
| 目录锁在开库之前，过期 30 秒 | `src/app/runtime.ts:90-93` |
| SQLite 用 WAL 与 `synchronous=FULL` | `src/app/store.ts:64` |
| 共九张表 | `src/app/store.ts:72-80` |
| 主 Session 急切创建 | `src/app/runtime.ts:210` |
| 主 Session id 形如 `orchestrator-<hash>` | `src/app/runtime.ts:104` |
| Worker Session id 形如 `worker-<ticketId>` | `src/executor/dsh.ts:23-24` |
| Router/Worker 都在同一 DSH 进程 | `src/app/sessions.ts:142-145`、`src/app/runtime.ts:234-236` |
| 所有 Session 都是 `danger-full-access` | `src/app/sessions.ts:152` |
| pass 每 2 秒一拍 | `src/app/passes.ts:28` |
| 一拍的动作是先踢 effects，再推进到期评估 | `src/app/passes.ts:63-67` |
| Trigger 摄入是一个事务 | `src/core/engine.ts:48`、`src/core/intake.ts:19-62` |
| 重复 Trigger 按 id 去重 | `src/core/intake.ts:23` |
| 只有没有工单承接时才排队评估 | `src/core/intake.ts:56-58` |
| 域事件是进程内回调 | `src/app/runtime.ts:137-153` |
| 策略默认 `observe` | `src/policy.ts:84` |
| 评估超时默认 120 秒 | `src/policy.ts:85` |
| 默认最多 3 个 worker | `src/policy.ts:93` |
| 策略版本哈希覆盖规则、模式、来源策略 | `src/policy.ts:116-117` |
| gate 区分人类与机器消息 | `src/policy.ts:168-225` |
| bot 消息最高只能是 `inferred` | `src/policy.ts:175-179` |
| 判定回写比对策略版本 | `src/core/evals.ts:284-288` |
| 策略变化重排活跃 Eval | `src/core/evals.ts:216-220` |
| 评估连续过期上限是 2 | `src/core/evals.ts:19`、`:62` |
| 接受时生成 Mandate 与工单 | `src/core/evals.ts:305-317` |
| 工单结束字段 | `src/core/model.ts:284-285` |
| Assignment 三态 | `src/core/model.ts:211` |
| 启动先入队 launch | `src/executor/dsh.ts:268-270` |
| 启动时创建工作目录与 Worker Session | `src/executor/dsh.ts:435-441` |
| 准备命令超时 10 分钟 | `src/executor/dsh.ts:28` |
| 临时失败 3 次，退避 15 秒起 | `src/executor/dsh.ts:30`、`:550`、`:575` |
| 后台作业上限 30 分钟 | `src/executor/dsh.ts:32` |
| 槽位上限来自 `maxWorkers` | `src/executor/dsh.ts:230` |
| 人类消息可多占一个槽位 | `src/executor/dsh.ts:308` |
| effect 同 key 合并并保留队列位置 | `src/app/effects.ts:61-65` |
| effect 默认 1 并发、2s→60s 退避 | `src/app/effects.ts:70` |
| 连续失败 3 次报 error | `src/app/effects.ts:7`、`:155` |
| reply 重试 5s→300s | `src/app/outbox.ts:24` |
| reply receipt 幂等 | `src/app/outbox.ts:26-31` |
| 管理 API 只允许回环 | `src/app/http.ts:231` |
| 管理 API 只靠请求头与同源 | `src/app/http.ts:76-79` |
| 请求体上限 128 KB | `src/app/http.ts:62` |
| GitHub 默认 60 秒轮询 | `src/sources/github.ts:25`、`:144` |
| 轮询回看 14 天 | `src/sources/poll.ts:6`、`src/sources/github.ts:209-211` |
| 飞书用 CLI 子进程消费 NDJSON | `src/sources/feishu-loops.ts:70-71` |
| 飞书消费者 45 秒 ready 超时 | `src/sources/feishu-loops.ts:78` |
| 飞书单行上限 1 MiB | `src/sources/feishu-loops.ts:88` |
| 飞书回填每 60 秒 | `src/sources/feishu-loops.ts:128-159` |
| 健康板条目不能被重复 claim | `src/infra/health.ts:18-20` |
| schema 版本 11，仅支持 10→11 | `src/app/migration.ts:20`、`src/app/store.ts:56` |
| 设置历史读取上限 20 | `src/app/store.ts:198-199` |
| 主 Session 14 个工具 | `src/app/tools/main.ts:127-280`、`src/app/tools/tool.ts:25` |
| Worker 6 个工具 | `src/app/tools/executor.ts:29-75`、`src/app/tools/tool.ts:25` |
| `noWait` 拒绝 30 秒以上 shell 与 5 秒以上 job 等待 | `src/app/sessions.ts:77-84` |
| 启动脚本用 tmux 托管 DSH profile | `scripts/dsh-superagent:159-205` |

## 与既有材料的差异

这里比较的对象是 `docs/drafts/` 下的旧文档、`docs/007-architecture.md` 的现状描述，以及 `.archify/explainer-dsh-superagent-20261105-021749/dsh-superagent.html`。差异指“若把该材料当作现状会与代码冲突”，或“材料时点早于当前 HEAD”。

| # | 材料 | 材料说法 | 代码事实 | 判定 |
| --- | --- | --- | --- | --- |
| D1 | `docs/drafts/reviews/architecture-design-review-20261105.md:34-37` | 旧稿称 `policyVersion` “只记录不比对”，并以此作为核心增量前提 | `decideEval` 在 `src/core/evals.ts:284-288` 明确比较版本并重排/结束 | 旧说法被证伪 |
| D2 | `docs/drafts/super-agent-architecture-design.md:131` | 把 Lease 当作控制面的既有组成，提供 `delivery`/`eval`/`assignment` 三种 scope 的 fencing | 代码没有 Lease 表、Lease 字段或签发路径；唯一跨进程互斥是目录锁（`src/app/runtime.ts:93`） | 设计条目，不是现状 |
| D3 | `docs/drafts/super-agent-architecture-design.md:223-226` | T1/T2 拓扑中 Watchdog 是独立只读进程，Assessor 可独立进程 | 原型没有 Watchdog；Assessor 是进程内 `MasterAssessor`，评估投递目标固定为主 Session（`src/app/runtime.ts:131-133`） | 设计条目，不是现状 |
| D4 | `docs/drafts/super-agent-architecture-design.md:120-126`、`:220-226` | 跨进程 T2、控制面/执行面拆分、节点注册表 | 所有 Session 由同一 `ctx.sessionController` 创建，同进程同 OS 用户（`src/app/sessions.ts:142-145`、`:152`） | 设计条目，不是现状 |
| D5 | `docs/drafts/super-agent-architecture-design.md:394-410` | 租约实体、`leaseId`/`leaseGeneration`、心跳与代次 | `Assignment` 只有 `pending/running/ended`，无 owner、lease、代次（`src/core/model.ts:211-232`） | 设计条目，不是现状 |
| D6 | `docs/drafts/event-driven-architecture-research.md:11`、`:282` | 用 “daemon-first” 描述当前形态 | 仓库无 `bin`、无守护进程；只有 DSH Host 进程内的 eager 主 Session（`package.json:1-125`、`src/app/runtime.ts:210`） | 术语差异：这里的 daemon 指“常驻主 Session”，不是 OS daemon |
| D7 | `docs/drafts/event-driven-architecture-research.md:413` | 角色表列出 Watchdog 的能力与禁止项 | 该文档同时在第 53 行承认“watchdog 在原型中不存在”；代码核实结果同样是不存在 | 前后一致，属设想 |
| D8 | `.archify/.../dsh-superagent.html` | 页面标注“代码基线 6337fc8”，所有 `file:line` 都带该提交 | 当前 HEAD 是 `903fc6a`；抽样核对的机制结论一致，但行号属于旧提交 | 时点差异，不是结论错误 |
| D9 | `.archify/.../dsh-superagent.html` | “没有独立 daemon 进程”“没有 watchdog 进程”“Router 与 Worker 同进程同 OS 用户”“没有跨进程 Worker，工作目录也没有跨进程锁” | 与代码一致：`package.json` 无 `bin`、`src/` 无 watchdog、`src/app/sessions.ts:142-152`、`src/app/runtime.ts:93` | 一致，不作差异 |
| D10 | `docs/007-architecture.md:175` | `launch` 的 effect 退避写作“5 s→300 s，three times” | `Effects.attempt` 只递增 `attempts`、按 `retry[1]` 封顶，没有尝试次数上限；连续 3 次失败只把健康条目标 error，不停止重试（`src/app/effects.ts:141-143`、`:155`） | 措辞不符：`three times` 是健康阈值，不是重试次数上限 |

补充说明两点容易误读的边界：

- `.archify` 页面虽然写了“工作目录也没有跨进程锁”，但仓库确实有 `stateDir` 的全局目录锁；两者不矛盾——锁的是状态目录，不是每个工单工作目录。
- 旧材料中的 `Watchdog`、`Lease`、`T2` 多数已显式标为〔设想〕或“目标形态”。只有 D1 是明确的错误前提，D10 是 007 的措辞不精确；D2–D5 的风险在于脱离上下文引用时会被误当成现状描述。

## 自查记录

以下 12 条结论在写作后重新回代码核对，全部与正文一致。

| # | 结论 | 回代码位置 | 结果 |
| --- | --- | --- | --- |
| 1 | `passes` 每 2 秒一拍 | `src/app/passes.ts:28` | 一致 |
| 2 | 目录锁 `stale: 30_000`，且在开库前 | `src/app/runtime.ts:91-98` | 一致 |
| 3 | 主 Session 在 `initialize` 中急切创建 | `src/app/runtime.ts:210` | 一致 |
| 4 | Worker 与 Router 同为 `danger-full-access` | `src/app/sessions.ts:152` | 一致 |
| 5 | effect 默认 `[2000, 60_000]` | `src/app/effects.ts:70` | 一致 |
| 6 | 连续失败 3 次进入 error | `src/app/effects.ts:7`、`:155` | 一致 |
| 7 | reply 重试 `[5000, 300_000]` | `src/app/outbox.ts:24` | 一致 |
| 8 | 判定回写比较 `policyVersion` | `src/core/evals.ts:284-288` | 一致 |
| 9 | 评估连续过期上限 2 | `src/core/evals.ts:19`、`:62` | 一致 |
| 10 | GitHub 默认 60 秒、回看 14 天 | `src/sources/github.ts:25`、`:144`、`src/sources/poll.ts:6` | 一致 |
| 11 | 飞书消费者 45 秒 ready 超时、1 MiB 单行上限 | `src/sources/feishu-loops.ts:78`、`:88` | 一致 |
| 12 | 管理 API 只允许回环，靠请求头与同源 | `src/app/http.ts:62`、`:77-78`、`:231` | 一致 |

## 〔未核实〕清单

以下条目的结论依赖仓库之外的实现或环境，本文没有把它们当作已证实事实使用。

| # | 主题 | 为什么未核实 |
| --- | --- | --- |
| U1 | DSH `sessionController.create` 是否绝对不创建新 OS 进程 | 代码只能证明所有 Session 共享同一个 `ctx.agents` 与同一个 Cordis 上下文；宿主内部实现不在本仓库 |
| U2 | `ctx.sessionPersistence.flush()` 的持久化粒度与崩溃语义 | DSH 宿主实现，仓库内只有调用点（`src/app/runtime.ts:243`） |
| U3 | GitHub API 在限流时如何改变轮询间隔 | 仓库只读取响应并决定下一轮休眠（`src/sources/github.ts:144`），限流协商在远端 |
| U4 | 飞书 CLI 的事件去重与 at-least-once 语义 | 仓库只按行解析 NDJSON 并调用 `ctx.receive`（`src/sources/feishu-loops.ts:95`），CLI 内部行为不在本仓库 |
| U5 | `proper-lockfile` 在网络文件系统上的可靠性 | 依赖库与文件系统行为，不在本仓库代码内 |
| U6 | `scripts/dsh-superagent` 在异常退出后的自动恢复能力 | 脚本只做 tmux/进程启停与健康读取（`scripts/dsh-superagent:159-205`），没有验证自动重启策略 |

〔未核实〕共 6 条，主题分别是：DSH Session 进程模型、DSH 持久化 flush、GitHub 限流协商、飞书 CLI 投递语义、目录锁的网络文件系统行为、外部托管脚本的恢复能力。
