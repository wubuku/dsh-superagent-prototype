# DSH Super-Agent 原型：一页看懂主动式编码代理

默认 `observe` 下，它只记录“若自动接单本来会接受”，不会建工单。只有把 `eval.mode` 改成 `auto` 且评估命中已启用规则，允许来源里的请求才会变成授权工单。Router 与 Worker 是同一个 DSH Host 进程里的两个平级 Session。准入由确定性 Policy 判断，授权事实由 Engine 落库，执行归每个 Ticket 一个 Worker Session。[](source:mode)

- 来源先把 GitHub 或飞书事件标准化为 Trigger；GitHub 是轮询拉取，不是 webhook，默认 bundle 只启用 GitHub，飞书被禁用。[](source:bundle-patch)[](source:github-poll)
- Intake 在一个事务里落 Trigger、按来源范围过滤、关联 Thread，并把输入扇出给已订阅的 Ticket；只有没有工单承接时才排队给 Eval。[](source:intake)
- 确定性 gate 先按发送者、范围和准入表判定强度。主 Session 只在这个强度内评估并提交判断，Decision 由 Engine 落库；它不能把外部文本提高成新授权。accept 还要求命中已启用规则。[](source:policy)[](source:decide)
- 每个 Ticket 有独立的 DSH Session 和工作目录，但 Router 与 Worker 同在一个 DSH 进程、同一 OS 用户。[](source:executor)[](source:router)

@answer scope="研究原型 · 代码基线 6337fc8 · 源码静态核对"
@meta locale=zh-CN repo_url=https://github.com/wubuku/dsh-superagent-prototype.git repo_revision=6337fc823ce20251c8de8085948165c81aaa701e
@source bundle-patch title="Bundle 插件与 Worker 预设" path=cordis.patch.yml lines=1:30
@source engine title="Engine 单一事务入口" path=src/core/engine.ts lines=24:48
@source intake title="Intake 去重、扇出与排队" path=src/core/intake.ts lines=19:63
@source decide title="Decision 由 Engine 原子落库" path=src/core/engine.ts lines=100:100
@source github-poll title="GitHub 轮询循环" path=src/sources/github.ts lines=133:144
@source events title="域事件为进程内回调" path=src/app/runtime.ts lines=137:139
@source close title="线程关闭结束 Ticket" path=src/core/tickets.ts lines=74:100
@source policy title="Policy 准入与 Mandate 复核" path=src/policy.ts lines=175:220
@source executor title="每个 Ticket 的 DSH Session 与目录" path=src/executor/dsh.ts lines=424:470
@source router title="启动时先建主 Session" path=src/app/runtime.ts lines=201:218
@source rhythm title="Passes 2 秒一拍" path=src/app/passes.ts lines=28:67
@source effects title="Effects 持久队列" path=src/app/effects.ts lines=42:66
@source mode title="默认 observe 模式" path=src/policy.ts lines=83:87
@source process title="以 DSH bundle 插件运行" path=src/index.ts lines=7:25
@source recovery title="resume 中断 running、重排 pending" path=src/executor/dsh.ts lines=519:537
@source recovery-note title="RECOVERY_NOTE 要求先核对远端" path=src/core/assignments.ts lines=21:21
@source restart title="进程重启终止后台工作" path=docs/003-execution.md lines=45:45
@source document title="research prototype 与未实现的文章设计" path=README.md lines=3:5
@source worker-preset title="Worker 只保留工作所需工具" path=cordis.patch.yml lines=28:100
@source store title="SQLite 状态与一次写入口" path=docs/007-architecture.md lines=149:163
@source outbox title="Outbox 发送回执与重试" path=src/app/outbox.ts lines=22:45
@source health title="健康状态由唯一写者持有" path=src/infra/health.ts lines=1:80
@source stage title="Ticket 阶段判定规则" path=src/core/stage.ts lines=9:22
@source tickets title="Ticket 生命周期与 Mandate 复核" path=src/core/tickets.ts lines=37:70
@source wake title="同一 Mandate 下恢复已结束 Ticket" path=src/core/tickets.ts lines=220:248
@source sessions title="主会话与 Worker 会话预设" path=src/app/sessions.ts lines=48:105
@source subagent title="Subagent 只在 Worker 内部使用" path=cordis.patch.yml lines=102:111
@source state-lock title="stateDir 单实例锁" path=src/app/runtime.ts lines=87:98
@source http title="管理 HTTP 仅 loopback + 固定请求头" path=src/app/http.ts lines=75:79
@source setup title="权限与隔离边界" path=docs/006-deployment.md lines=13:20

## 系统如何组成？ {#overview span=12}

@diagram architecture id=system-overview source=diagram.system-overview.json title="Runtime 组装、core/ 领域逻辑与 DSH Session"

左侧是外部来源；中间是 Runtime 组装层与 core/ 领域逻辑；下方是持久化与控制面。右侧是同一 Host 进程里的两类 Session：Router 在启动时创建并常驻，Worker 每个 Ticket 一个、按需创建。[](source:router)[](source:executor)

Router 与 Worker 不是 Subagent 父子；Subagent 只在 Worker 内部使用。Engine 只把 launch 入队；Effects 派发后，Executor 按需创建 Worker Session 并下发 assignment。飞书连线用虚线，因为默认 bundle 中它被禁用。[](source:bundle-patch)[](source:subagent)[](source:executor)[](source:effects)

Runtime 的 Passes 每 2 秒一拍，踢 Effects 并推进到期评估。Effects 是 SQLite 持久队列，事件驱动、退避重试；消息投递另用 requestId 去重。域事件是进程内回调，没有可回放的 event log。[](source:rhythm)[](source:effects)[](source:events)

## 一次请求如何变成结果？ {#lifecycle-request}

@sequence id=request-flow title="显式请求：准入、授权、执行与回传"
| actor requester | Requester | external |
| actor source | Source | external |
| actor engine | Engine | security |
| actor policy | Policy | security |
| actor orchestrator | Main Session | backend |
| actor store | SQLite | database |
| actor executor | Worker | frontend |
| actor channels | Outbox | messagebus |
| phase | authorization |
| requester | source | mention | emphasis |
| source | engine | trigger | emphasis |
| engine | policy | gate | security |
| policy | engine | strength | return |
| engine | orchestrator | candidate | emphasis |
| orchestrator | engine | decision | security |
| engine | store | ticket + mandate | emphasis |
| phase | execution |
| engine | executor | launch effect | emphasis |
| executor | engine | report | return |
| engine | channels | receipt + reply | return |
| channels | requester | to thread | return |

gate 在 Engine 的同步路径里判定准入，是纯函数、不调模型。Decision 为 accept 时，Engine 再用一个事务建 Ticket 与 Mandate；Assignment 之后由 Worker 执行，Engine 记录事实并驱动回复。后续外部消息可以补充输入或唤醒已结束 Ticket，但不能扩展 Mandate 的授权范围。

默认 observe 下，accept 分支不成立：Decision 落为 ignore，audit 记 would_accept，不建 Ticket，也不下发 Assignment。[](source:mode)

## Ticket 会经过哪些状态？ {#ticket-lifecycle span=12}

@diagram lifecycle id=ticket-lifecycle-diagram source=diagram.ticket-lifecycle.json title="Ticket 状态与人工干预"

person 停点有五类：delivery 表示输入投递失败；answer 表示 Worker 在等答案；review 表示已有 ready 报告、等后续线程收口或人工验收。blocked 与 failed 表示报告需要人。图中只画出 answer 与 review 两个人工停点；idle 是回合之间的等待，delivery、blocked、failed 不单独入图。[](source:stage)

Ticket 在 ready 报告后结束：没有后续线程就立即结束，跟随后续线程则等线程收口。dropped 报告直接结束，人工 stop 也可终止。失效的 Mandate 只阻止已结束 Ticket 恢复。未被人工停止的已结束 Ticket 可被原线程的人类消息唤醒，唤醒前先复核 Mandate。[](source:close)[](source:wake)

## 这张图不能承诺什么？ {#limitations}

下面几项是读图时最容易高估的边界，依据来自插件入口、策略默认值、会话预设、恢复路径与 README。[](source:process)[](source:mode)[](source:sessions)[](source:recovery)[](source:document)

| 边界 | 当前事实 | 读图提示 |
| --- | --- | --- |
| 运行形态 | 本仓库是 DSH bundle 插件，运行在 DSH Host 进程内；`package.json` 没有 `bin` | 没有独立 daemon 进程，也没有 BYOM 端侧组件 |
| 默认接单 | `eval.mode` 默认 `observe`：只记 ignore + `would_accept`，不建 Ticket、不启动 Worker | 未改成 `auto` 时，请求不会自动变成工单 |
| 授权边界 | Mandate 是 Engine 在同一事务里写下的授权记录；Session 权限固定 `danger-full-access` | Mandate 不限制工具或 OS 权限，不能当作沙箱 |
| 执行隔离 | 每 Ticket 一个 DSH Session 和目录；Router 与 Worker 同在 Host 进程、同 OS 用户；没有跨进程 Worker，工作目录也没有跨进程锁 | 会话与目录是逻辑隔离，不是进程、OS 或租户隔离 |
| 持久化 | 单一 SQLite 库；stateDir 由 `proper-lockfile` 单实例持有；不同 stateDir 的实例互不相认 | 只支持单机重启恢复，不是多副本 HA |
| 恢复 | `resume()` 中断 running、重排 pending；新 Assignment 先读 `RECOVERY_NOTE` 核对 worktree、git 与 GitHub；进程重启会终止后台工作 | 核对面是提示词要求，不是服务端对账协议；没有 watchdog 进程 |
| 来源开关 | 默认启用 GitHub 轮询；Feishu 插件默认 `disabled`，需要单独启用并配置凭据 | 虚线代表可选能力 |
| 成熟度与文章设想 | README 声明为 research prototype；部分文章设计是未来方向，未实现 | 不要把页面当作承诺；Watchdog、Chain of Recall、投机执行、跨设备 BYOM、跨进程角色与租约都不在图中 |

部署文档建议用独立系统账户获得更强隔离。账号包装器只决定默认凭据和命令解析，不能阻止 Worker 按绝对路径执行程序，Worker 也能读操作员的主目录。[](source:setup)

持久化与管理面还有两条边界：SQLite 是单库，stateDir 有单实例锁。管理 HTTP 只监听 loopback、要求固定请求头，没有 token。[](source:state-lock)[](source:http)

@callout id=goal-note level=note title="设计目标"
这套系统的原则是用最少的人类注意力换取最大价值。它只在被请求或规则允许时行动。它只在有人必须行动或能使用结果时说话。
