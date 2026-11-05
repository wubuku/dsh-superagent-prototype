# Super-Agent 整体架构设计（第 1 阶段：定位、原则、分解、契约、协议、拓扑、ADR）

> 状态：第 1 阶段草稿，待评审。第 2 阶段（多租户、身份、安全、可观测性、持久化与运维）尚未撰写。
> 上游材料：[事件驱动架构调研](event-driven-architecture-research.md)（本仓库，2026-11-05 完成，678 行）。本文引用它而不重复它。
> 核查日期：2026-11-05。证据标签：〔原型〕=本仓库可复核实现；〔DSH〕=`deepseek-harness` 现有能力；〔判断〕=本文分析；〔设想〕=本文提出、尚未落地；〔推断〕=代码可解释但未运行验证。外部材料标注来源与读取日期。

## 0. 摘要（硬结论）

以下十条都可被反驳；每条给出反例的形态，便于评审直接挑战。

1. **系统的可迁移内核是“授权事实单写者 + 事务性持久队列 + 纯函数准入”，不是事件总线。** 换消息中间件不改变系统正确性；换掉这三样会改变。〔原型：`src/core/engine.ts:48`、`src/core/tickets.ts:37-56`、`src/policy.ts:191-211`〕反例形态：如果评审认为跨机后 Engine 可拆成多个写者，则第 1 条不成立——但那要求分布式事务或 saga，代价见 §7-D1。
2. **角色必须按“谁拥有事实”切分，而不是按“谁在运行”切分。** 进程可以随部署变化，事实所有权不能。沿 Session 切分只会把进程内耦合换成网络耦合。〔判断〕
3. **Assessor 端口未闭合是唯一“不做就无法异构”的缺口。** 其余缺口（队列服务化、权限拆分、节点注册）可以分批做；不做只会让“异构”退化成“同机多进程”。〔原型：`src/core/ports.ts:49-53`，`decide` 在 `src/app/assessment.ts:272-279` 而非端口〕
4. **授权不可跨进程。** 远程 Assessor/Worker 只能交回判定或报告，Decision、Mandate、Ticket 必须由持有账本的单写者在单个事务内写入。〔判断，沿用上游 §3.1〕
5. **`policyVersion` 必须从“记录”升级为“比对与拒绝”。** 当前它只被写入 Eval 与 Decision，判定回写时用当前设置计算规则〔原型：`src/core/evals.ts:107-111`、`src/app/assessment.ts:275`〕。单进程是隐患；跨进程会变成“用旧策略做的判定生效”。这是本文与上游文档的核心增量之一。
6. **部署拓扑应按“故障域 / 凭据域 / 扩缩容曲线 / 运行时”四条判据选择，而不是按角色数量选择。** T0→T1 的最小改动面是“把 effect 派发改成可 claim 的队列 + 把角色目标改成解析而非写死”，不是拆包、不是换库。〔判断〕
7. **T1 的合理形状不是一个角色一个进程，而是“控制面进程 + 执行面进程组”。** Router 与 Engine 共享授权事实，必须同进程或同节点强一致；Worker 天然可多节点；Watchdog 必须独立且只读。〔判断〕
8. **协议先于进程。** 没有幂等键、`attempt`、`leaseId`、能力声明的“进程拆分”得到的只是分布式单体。〔沿用上游 §6、§8〕
9. **宁可少拆：gate、域事务、单机 SQLite、outbox receipt、2 秒 pass 定时器留在原地。** 四条判据一条不满足就不拆。〔沿用上游 §8〕
10. **adapter 的能力必须显式声明并持久化快照，缺失的操作要由策略层显式降级。** 静默降级为 `followup` 会把“只支持下一轮”的 agent 当成“支持中途插话”。〔DSH：投递语义见 `/Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness/packages/core/agent/src/runtime-types.ts:215-241`〕

## 目录

- §1 文档定位与范围
- §2 设计原则
- §3 系统分解：角色与平面
- §4 角色契约
- §5 协议草案（第 1 版）
- §6 部署拓扑 T0 / T1 / T2
- §7 决策清单（ADR）
- §8 第 1 阶段不做的事
- §9 证据索引与待验证项

---

## 1. 文档定位与范围

### 1.1 这份文档解决什么

它回答一个工程问题：**把 `dsh-superagent` 原型那套“事件→准入→授权→工单→执行→回报”的可追责语义，扩展成一个更通用、agent 可异构、关键角色可进程隔离的系统时，哪些结构必须保留、哪些必须替换、按什么顺序替换。**

服务对象是设计者与实现者，不是运维手册，也不是产品需求文档。

### 1.2 与事件驱动文档的边界

| 主题 | 事件驱动文档（上游） | 本文 |
| --- | --- | --- |
| 事件到执行的时序、同步/异步边界 | 已完整覆盖（上游 §2、§3） | 只引用，不重述 |
| 八个耦合点与 P0/P1/P2 | 已完整覆盖（上游 §5、§10） | 作为输入约束，不重新推导 |
| 角色与平面的职责边界、权力边界 | **缺失**（只写到 Ticket/Assignment/Report） | §3、§4 本文主体 |
| 任务调度、容量、多节点分工 | **缺失** | §3.3、§6 |
| 部署拓扑与四条判据的落点 | **缺失**（判据有，形状无） | §6 本文主体 |
| 协议字段与“缺失后果” | 部分（上游 §6、§7.4） | §5 补全为可评审草案 |
| 策略/协议版本一致性 | **未处理**（只指出 `policyVersion` 记录不比对） | §5.3、§7-D3 本文增量 |
| 多租户、身份、安全、可观测性 | 明确列为局限（上游 §9.8） | 第 2 阶段，不在本文 |

本文不复制上游的时序表与耦合点表；读者应先读上游 §2–§5。

### 1.3 非目标（本文明确不做）

- 不设计管理 UI、面板交互、审批流界面。
- 不选模型、不做模型路由与 A/B 的质量基线。
- 不做多租户计费、配额计费、SLA。
- 不做身份认证的具体协议（OIDC/SAML 选型推迟到第 2 阶段）。
- 不写数据库 DDL、不写具体索引与迁移脚本。
- 不评估开源替代（如 Temporal/LangGraph）；上游材料已有结论，本文沿用“基于 DSH 自建 + 只补最小持久层”的立场。

---

## 2. 设计原则

每条格式为“判断 + 代价”。原则用于裁决分歧，不是口号；违反时要写明为什么。

| # | 原则（判断） | 代价 |
| --- | --- | --- |
| P1 | **事实与判断分离。** 域表记录“发生了什么、被谁授权、谁在执行”；模型只产出判断与报告，不持有授权。 | 判定与授权之间多一层协议；远端 assessor 不能“直接决定”，必须交回结果由本地校验。 |
| P2 | **授权不可跨进程。** Decision/Mandate/Ticket 只由账本持有者在单事务写入；远端角色只能提交“请求”与“结果”。 | 远程判定需要两段式（请求→结果→本地落库），延迟高于“远端直接写库”。 |
| P3 | **按“谁拥有事实”切角色。** Source 拥有外部世界事实，Engine 拥有授权与工作单元事实，Assessor 产生判断，Executor 执行并回报事实，Watchdog 只观察。 | 角色边界与组织边界不必对齐；一个团队可能要同时承担两个角色的部署与运维。 |
| P4 | **协议先于进程。** 先定义幂等键、租约、deadline、能力声明与失败分类，再决定谁跑在哪个进程。 | 首版会同时改端口与装配，迁移一次到位的风险高于分批。 |
| P5 | **能力声明优于统一接口。** 适配器声明自己支持 inject/steer/followup/interrupt/持久会话/进度事件/跨进程控制/持久 inbox，上游按能力选择。 | 调用方要为每种能力组合写分支；`unsupported` 需要显式降级策略，不能默认成 `followup`。 |
| P6 | **可缺席优于常驻。** Router、Assessor、Worker 都允许缺席；缺席时事件与评估保留期限，不阻塞写入。 | 需要“无消费者态”的健康语义与积压告警；deadline 从“领取”计时而不是“投递”计时。 |
| P7 | **宁可少拆。** 四条判据（故障域/凭据域/扩缩容曲线/运行时）全不满足就留在原地。 | 单进程的故障半径大；运维上接受这一点，换取一致性与可排查性。 |
| P8 | **版本是契约的一部分。** `policyVersion`、协议 `schemaVersion`、适配器能力快照都要随请求与结果传输，并在落库前比对。 | 每次策略变更都可能让在途评估失效，需要重排与补偿逻辑。 |
| P9 | **至少一次 + 按 key 保序 + 消费端幂等。** 不追恰好一次。 | 重复消费必须靠幂等键压住；外部副作用仍需 receipt + 对账。 |
| P10 | **失败必须分类，未知不等于失败。** `rejected/failed/timeout/unknown/cancelled/paused` 进入协议。 | 每个消费方都要处理六个状态；UI 与告警复杂度上升。 |

由此得到一条总裁决规则：**当性能诉求与 P2/P8 冲突时，先保证授权与版本正确；当便利性与 P7 冲突时，先保证可排查性。**

---

## 3. 系统分解：角色与平面

### 3.1 为什么沿用五平面，但改两处

上游给出的五平面（Event / Decision / Delivery / Agent Runtime / Work）方向正确，但有两个错位：**Work Plane 只写到 Ticket/Assignment/Report，没有调度与容量**；**Agent Runtime 既是平面又是角色，容易把“运行时”当成“进程”。**〔判断〕

本文的调整（只说这两处，其余不变）：

1. **Work Plane 扩为“工作平面 + 调度子层”。** 工作平面拥有 Ticket/Assignment/Input/Report 的事实与调度决策（谁来做、做几个、排队顺序），但**不拥有授权**。调度是工作平面内部的确定性逻辑，不单独成平面，否则会与 Engine 的授权事务再次耦合。
2. **Agent Runtime 明确为“运行时适配层”，不是进程单元。** 一个“runtime adapter”可以跑在任何进程里；它声明能力，不拥有事实。

不新增平面的理由：六个平面会让 Delivery 与 Work 的边界重合（两者都涉及“把输入送到执行体”），而调度若独立成平面，会诱使实现者把“排队顺序”误当成“业务优先级”——上游研究报告已指出 Router 的调度顺序不构成业务优先级（`/Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness/docs/drafts/dsh-superagent-prototype-research.md:60`）。〔DSH 研究材料 + 判断〕

### 3.2 五平面的职责、拥有的事实、不拥有的权力

| 平面 | 职责边界 | 拥有的事实（sole writer 为标 *） | 不拥有的权力 | 原型映射 | DSH 映射 |
| --- | --- | --- | --- | --- | --- |
| Event | 把外部世界的事件规范化、去重、落库、按 Thread 归集、扇出到订阅者 | Trigger*、Event Journal*、Delivery 行*、Thread*、Source 游标 | 不能决定“是否授权工作”；不能调用模型 | `src/core/intake.ts:19-61`；`src/core/model.ts:23-39`；`src/sources/host.ts:31-45` | Source 无对应能力；DSH webhook 只能唤起新 Session，不是总线（`/Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness/packages/experimental/webhook/README.md:71-73`） |
| Decision | 纯函数 gate、可插拔 assessor 的请求/结果、Decision 落库、Mandate 生成 | Decision*、Mandate*、Evaluation*、policyVersion 快照 | 不能直接写 Ticket；不能执行命令；不能改工作区 | `src/policy.ts:191-211`；`src/core/evals.ts:96-118`、`:131-163`；`src/app/assessment.ts:21-34` | 无；模型只能作为 assessor 适配器 |
| Delivery | 把事实与输入按消费者投递、重试、保序、暂停；记录投递状态 | Effect*、Delivery 状态*、Receipt*（与 Outbox 共用） | 不能改业务事实；不能决定授权；不能“代为完成” | `src/app/effects.ts:46-160`；`src/app/delivery.ts:61-84`；`src/app/outbox.ts:26-51` | `steer/followup/inject` 是 inbox 语义，不是投递协议（`.../runtime-types.ts:215-241`） |
| Agent Runtime | 承载 agent 实例，声明能力，接受输入，回报 `accepted/claimed/processed` 与进度 | Agent 实例状态、能力快照、inbox 内容 | 不能写域表；不能签发 Decision/Mandate；不能决定工作单元归属 | `src/app/sessions.ts:137-155`；`src/executor/dsh.ts:424-470` | Session/Agent Handle、inbox、presence（`.../core/agent/src/index.ts:235`） |
| Work | 工作单元（Ticket/Assignment）的状态机、调度、容量、执行报告与结束语义 | Ticket*、Assignment*、Input*、Report*、调度队列* | 不能创建授权；不能把“模型说完成”当成验收（验收属第 2 阶段） | `src/core/tickets.ts:37-56`；`src/core/assignments.ts:34-77`；`src/executor/dsh.ts:263-343` | Session log 记录交互事实，不是业务账本（`/Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness/docs/drafts/dsh-superagent-prototype-research.md:138`） |

三个跨平面的共用约束：

- **单写者规则。** 标 * 的事实只允许一个写入者（可以是一个进程内模块，也可以是 T2 的一个控制面进程），其他平面只能读或提交“请求”。
- **Version 约束。** 跨平面传输的请求都带 `policyVersion` 与 `schemaVersion`；接收方落库前比对（§5.3）。
- **不突变原则。** 一个平面不能“顺手”改另一个平面的事实。原型已经基本遵守：`Executor.start/deliver/stop` 只排队，回报走 Engine 回调〔原型：`src/core/ports.ts:59-69`〕；这条要写进 T1/T2 的协议。

### 3.3 调度、容量与多节点分工（上游缺失的部分）

调度不是一个角色，而是 Work Plane 的三条确定性规则 + 一个容量来源：

| 层 | 决定什么 | 不决定什么 | 归属 |
| --- | --- | --- | --- |
| 准入调度 | 事件是否进入 Eval（gate） | 不做优先级排序 | Decision Plane，事务内 |
| 评估调度 | 同一 Thread 串行、Eval 的 deadline 与重试上限 | 不决定“哪个 Thread 更重要” | Decision Plane + Delivery |
| 执行调度 | 哪个 Ticket 先拿到 slot、并发几个、哪个节点接 | 不改变 Mandate 范围，不绕过授权 | Work Plane |
| 容量 | 节点能跑几个 worker、什么规格、是否可 drain | 不是业务优先级 | 节点注册表（T1 本地、T2 控制面） |

原型现状：执行并发只有计数 `maxWorkers`（默认 3，范围 1–16）〔原型：`src/policy.ts:91-97`，`src/limits.ts:6`〕，worker 槽由 `WorkerSlots` 在进程内管理，launch 优先级靠 effect 队列的 `seq` 顺序〔原型：`src/executor/dsh.ts:229-235`〕。它没有节点概念，也没有资源配额。

〔设想〕T1/T2 的调度规则（确定性，可测试）：

1. **按 key 保序**：同一 `ticketId` 的 launch/delivery 必须串行；同一 `threadKey` 的评估必须串行。
2. **先到先得 + 人的输入插队**：新 Ticket 按入队 `seq`，但人的 follow-up 可用专留槽位。原型已有这个行为〔原型：`src/executor/dsh.ts:303-309`〕。
3. **容量声明优先于本地计数**：T1 的容量=节点声明；T2 的容量=注册表里 `capacity` 的汇总。
4. **不做全局优先级**：跨 Ticket 的全局优先级会引入“谁更重要”的业务判断，属于第 2 阶段的组织配置，不在本轮。

---

## 4. 角色契约

角色是**职责与权限的最小单元**，不是进程。一个进程可以承载多个角色（T0/T1），一个角色也可以分布到多个进程（T2 的 worker 池）。契约以“禁止的动作”为一等公民，因为跨进程后最危险的是越权，不是遗漏。

### 4.1 契约总表

| 角色 | 输入 | 输出 | 可读事实 | 可写事实 | **明确禁止** |
| --- | --- | --- | --- | --- | --- |
| Source Adapter | 外部渠道的轮询/webhook、游标 | Trigger、Thread 描述、健康 | 自己的游标、自己接管的 Thread/Ticket 只读 | Trigger（经 Intake）、游标、Thread `meta` 中自己拥有的键 | 判定、建 Ticket、写工作区、调用模型、推进别人的游标 |
| Router（编排/评估入口） | 事件通知、候选卡、人的消息、ticket 状态通知 | 评估请求、`AssessmentResult`（经工具或服务）、通知回复 | Thread 窗口、仓库只读、Ticket 摘要 | 自己的上下文/会话记录；**不直接写域表** | 直接写 Ticket/Mandate/Decision；执行命令；改工作区；代替评估服务签发结果（工具只是适配器） |
| Assessor | `Candidate`（evalId + 有界事实 + policyVersion） | `AssessmentResult` | Thread、仓库只读、图片、规则 | 仅自己的评估草稿/证据缓存 | 写域表；创建工单；决定授权；跨 Eval 复用他人上下文 |
| Executor（执行节点/执行器） | Ticket + Assignment 快照、Input | `started/report/ready/dropped/failed`、外部副作用 receipt | 自己 assignment 的 Ticket 快照、工作区、授权范围 | Assignment 状态（经 Engine 回调）、工作区文件、授权范围内的外部写 | 接受新工作；停止别人的工单；产生 Decision；扩大 Mandate 范围；写别人的工作区 |
| Watchdog | 事件位点、投递状态、租约/心跳、外部对账结果（只读） | Health、Alert、Finding | 全部域表与 Journal 的只读视图 | Health/Alert/Finding | 任何域写；任何外部副作用；直接重试；把 Session transcript 当业务事实 |
| 人（Operator/Requester） | — | 消息、配置、审批 | 面板可见范围 | 配置、暂停、停止、撤销 | 无技术禁止，但系统不得把人的沉默当成批准 |

### 4.2 逐角色说明与现状差距

**Source Adapter。** 原型已经做到“只写 Trigger 与游标、成功后才推进游标”〔原型：`src/sources/host.ts:41-45`；`src/sources/github.ts:225-244`、`:372`〕。差距：Source 通过 `SourceContext` 能读 Ticket 并 `notify`〔原型：`src/sources/host.ts:53-63`〕，这本身可以接受，但 T2 下必须限制为“只读 + 提交副作用请求”，不能直接投递。

**Router。** 现在是常驻主 Session，工具集受限但权限是 `danger-full-access`〔原型：`src/app/sessions.ts:137-155`〕。禁止项的第 1 条（不直接写域表）原型已经成立：工具调用走 `Engine.decide`，不是直写〔原型：`src/app/tools/main.ts:202-220`〕。真正要补的是“Router 缺席时系统仍可运行”和“Router 不能借工具绕过 `policyVersion` 比对”。

**Assessor。** 现状是 Router 内部的一段逻辑，端口只有 `request/release`〔原型：`src/core/ports.ts:49-53`〕。它的禁止项最关键：**不能写 Decision**。上游已经说明：让远程 Assessor 直接写 Decision，就把授权事实跨进程了（上游 §7.5）。本文补充一条：Assessor 也不能修改 `Candidate` 里的 `policyVersion`，否则版本比对失效。

**Executor。** 端口已存在且语义正确（只排队 + 回调）〔原型：`src/core/ports.ts:59-69`〕。差距在权限与归属：同一 OS 用户、`danger-full-access`〔原型：`src/app/sessions.ts:152`〕；没有节点身份、没有租约。T1 起必须补 `nodeId`、`leaseId`、`fencingToken`。

**Watchdog。** 原型没有此角色，全部是〔设想〕。定义上它与上游一致：只读输入、只写发现（上游 §6.10）。本文加一条禁止：**不得以 Session transcript 作为判定依据**，业务事实只在域表与 Journal。

### 4.3 角色与进程的映射不是一对一

| 部署形态 | Source | Router | Assessor | Executor | Watchdog |
| --- | --- | --- | --- | --- | --- |
| T0 | 同进程 | 同进程（常驻 Session） | 同进程（Router 内逻辑） | 同进程 | 不存在 |
| T1 | 控制面进程 | 控制面进程（或独立但同机） | 独立进程（可缺席） | 执行进程组 | 独立只读进程 |
| T2 | 控制面 | 控制面（可多实例但单写者） | 控制面或独立评估集群 | 多执行节点 | 独立只读观察者 |

关键点：**Router 与 Engine 在 T1 可以同进程，因为它们共享授权事实；Assessor 必须可独立，因为它只产判断；Watchdog 必须独立，因为它要求只读且不能与写者共享故障域。**〔判断〕

---

## 5. 协议草案（第 1 版）

只定义可评审的最小形状。所有协议共享三条规则：**每条消息带 `schemaVersion`；每条命令带幂等键与 `attempt`；每条结果带产生它的 `leaseId` 与 `attempt`。**

### 5.1 事件（Event）与投递（Delivery）

原型有四层，但缺“按消费者”的通用投递行（上游 §6.8）：`Trigger` 是不可变事件、`TriggerDisposition` 是聚合路由、Ticket `Input` 是工单内投递、`Effect` 是副作用投递〔原型：`src/core/model.ts:22-60`；`src/core/intake.ts:19-61`；`src/app/effects.ts:61-66`〕。本文拆成 Journal + Delivery。

**Event 信封**

| 字段 | 说明 | 缺失后果 |
| --- | --- | --- |
| `eventId` | 来源稳定 id，重放不变 | 重复事件会重复建工作；幂等退化到“靠文本+时间猜” |
| `source` / `resourceType` / `resourceId` | 事件来自哪、作用于什么 | 无法按资源做订阅与权限过滤；跨租户时无法隔离 |
| `eventType` | 领域事件类型（不是厂商事件名） | 消费者绑定厂商，换 Source 要改所有消费者 |
| `payload` | 原始事实的规范化不可变副本 | 审计无法回放；重放会读到被改写的外部状态 |
| `actor` + `actorKind` | 人 / agent / 系统 | 授权与审计失去主体，可能把 bot 当人 |
| `occurredAt` | 外部世界时间 | 延迟统计与 deadline 全失真（入库时间会掩盖积压） |
| `dedupeKey` | 来源级去重键 | 同一事实多入口进入时去重失效 |
| `correlationId` | threadKey / ticketId / traceId | 无法把事件、判定、报告串成一条可追责链 |
| `trustLevel` | 不可信外部 / 已验证成员 / 系统内部 | 提示注入与不可信输入没有分流依据 |
| `schemaVersion` | 兼容升级 | 老消费者解析新事件时静默丢字段 |
| `persistedAt` | 入库时间 | 无法区分“外部慢”与“系统积压” |

**Delivery 行（按消费者一条，唯一键 `(eventId, consumerId)`）**

| 字段 | 说明 | 缺失后果 |
| --- | --- | --- |
| `deliveryId` / `eventId` / `consumerId` | 三元定位 | 多消费者共享一个进度位，任一成功即被当成全部完成 |
| `state` | `routed→accepted→claimed→processed` / `failed/expired/unknown` | “已送达”被当成“已处理”，丢失与卡住无法区分 |
| `attempts` / `nextAttemptAt` | 重试次数与下次时间 | 无退避的重试会打爆下游，且无法区分重试与新工作 |
| `leaseId` / `leaseUntil` | 领取者与租约到期 | 两个消费者可同时处理同一条；崩溃后无人回收 |
| `deadline` | 业务期限（评估/执行） | 慢与丢无法区分，只能无限等 |
| `lastError` | 最近错误摘要 | 排障只能看日志，无法按消费者聚合 |
| `capabilitySnapshot` | 交付时的适配器能力 | 适配器降级后沿用旧假设，例如把 `next_step` 静默变成 `next_turn` |

**幂等键（四类，沿用上游 §6.3，但补 `attempt` 语义）**

| 幂等域 | key | 缺失后果 |
| --- | --- | --- |
| 事件 | `trigger.id`（= `eventId`） | 重复落库、重复评估、重复建工单 |
| 评估 | `(evalId, attempt)`，且 `accepted(triggerId)` 兜底 | 迟到结果覆盖已生效判定；重试被当成新判断 |
| 执行/输入 | `(assignmentId, inputId)` | 同一输入投递给两个 Assignment，worker 重复执行 |
| 外部副作用 | `receiptId`，外部 API 幂等键能映射就映射 | 超时重试造成重复评论/重复 PR |

### 5.2 工作单元与授权

**WorkItem / Ticket 的不可变字段**（创建后不可改；可变状态另行列出）

| 字段 | 不可变 | 说明 | 缺失后果 |
| --- | --- | --- | --- |
| `id` | 是 | 工单 id，也是执行体命名与目录派生的依据 | 改名会让 worker、目录、回执对不上 |
| `decisionId` | 是 | 授权来源 | 无法回答“谁批的”，审计链断裂 |
| `mandate` | 是 | 见下表 | 执行失去边界，后续输入可被当成扩大授权 |
| `origin.triggerId` / `origin.triggerIds` | 是 | 起始事件与批次 | 重放时会建第二张工单；无法回溯原始请求 |
| `channels` | 是（可追加不可删） | 回复去向 | 结果可能发错会话，或发不出去 |
| `createdAt` | 是 | 审计时间 | 无法做时限与积压统计 |
| `title` | 是（可变标题另设） | 人可读标识 | 面板与回执指代不清 |

**Mandate 的不可变字段**

| 字段 | 说明 | 缺失后果 |
| --- | --- | --- |
| `strength` | `explicit` / `inferred` | 推断的工作与明确请求混为一谈，无法按强度收敛 |
| `policyVersion` | 准入时的策略版本 | 策略变更后无法判断工单是否仍被授权 |
| `basis` | `via` 与接收范围、发送者、匹配规则 | 重启重验时无法复现准入依据（原型已具备，`src/core/model.ts:116-133`） |
| `actor` | 发起主体 | 无法追责；无法按人撤销 |
| `scope` | 授权范围描述 | 执行侧无法判断“这算不算越界” |

原型已把 Mandate 设计成不可变记录〔原型：`src/core/model.ts:125-133`〕，并在 resume 前 revalidate〔原型：`src/core/tickets.ts:106-114`；`src/policy.ts:191-239`〕。协议要做的只是把 `basis` 与 `policyVersion` 显式传输，而不是埋在结构化对象里。

### 5.3 判定结果（AssessmentResult）合同

这是整个协议里最关键的合同，因为它把“模型的判断”变成“可校验的授权输入”。

| 字段 | 说明 | 缺失后果 |
| --- | --- | --- |
| `evalId` | 被判定的是哪个 Eval | 无法拒绝“评估已结束后又来的判定”；原型此处已严格校验〔原型：`src/core/evals.ts:135`〕 |
| `attempt` | 第几次尝试 | 重试与新判断无法区分；迟到的旧尝试会覆盖新的 |
| `leaseId` | 判定者领取任务时拿到的租约 | 无法拒绝未持有租约的判定；两个 assessor 可同时提交 |
| `assessorId` | 判定者实例身份（不是 Session id） | 审计无法回答“谁判的”；A/B 与回溯不可能 |
| `policyVersion` | 领取时快照，必须与 Eval 上的一致 | 用旧策略得出的判定被当成当前有效授权（见 §5.5） |
| `outcome` | `accept / ignore / unavailable / stop` | 无法区分“不接”与“判不了”，重试策略错误 |
| `completedAt` | 判定完成时间 | 超过 deadline 的迟到结果无法识别 |
| `evidence` | `direction`、`rule_assessments`、`title`、`scope`、`intent_evidence`、`reason` 等 | 换 Assessor 后证据质量下降；无法复核“为什么接”〔原型 schema：`src/app/assessment.ts:21-34`〕 |
| `cost` / `model` | 可选，但建议记 | 无法做成本与质量的后续分析（第 2 阶段） |

**校验链（接收方必须按顺序执行）**：

1. `evalId` 对应的 Eval 仍存在且未判定（否则 `rejected: evalFinished`）。
2. `attempt` 是当前 Eval 的最大 attempt（否则 `rejected: staleAttempt`）。
3. `leaseId` 仍是该 Eval 的有效租约（否则 `rejected: leaseLost`，即 fencing 校验）。
4. `policyVersion` 等于 Eval 上记录的版本（否则 `rejected: policyChanged`，由 Engine 决定重排还是放弃）。
5. `outcome` 与 `Mandate` 规则一致（推断候选仍需匹配已启用规则）〔原型：`src/core/evals.ts:152-154`〕。
6. 通过后由 Engine 在单事务内写 Decision + Mandate + Ticket + 首 Assignment + effects〔原型：`src/core/tickets.ts:37-56`〕。

**当前差距（必须写清）**：第 3、4 步在原型中不存在——`policyVersion` 只记录不比对，`leaseId` 没有概念。原型靠 `evalId` 与 deadline 兜底〔原型：`src/core/evals.ts:107-111`、`src/app/assessment.ts:275`〕。单进程下这最多导致“用新规则解释旧评估”；跨进程后会变成“旧策略判定的工作在新策略下被执行”，且无法在事后识别。〔判断 + 上游 §7.4〕

### 5.4 Agent 适配器能力声明

适配器不提供统一的 `sendMessage`，而是声明能力；调用方按能力选择，缺失时显式降级并记录原因。

| 能力 | 语义 | DSH 现状 | 缺失后果 |
| --- | --- | --- | --- |
| `inject` | 只加上下文，不唤醒 | 有（可能错过当前请求） | 通知被当成任务唤醒，产生空 turn |
| `steer` | 影响活跃轮的下一个 step | 有（可能被取消丢弃） | 中途补充要求丢失，worker 按旧要求执行 |
| `followup` | 排到下一轮并唤醒空闲 agent | 有 | 最基础的投递能力缺失，只能轮询 |
| `interrupt` | 停止当前轮 | 有（`agent.cancel`） | 停止只能靠 deadline，人在停止后仍看到产出 |
| `persistent_session` | Session 跨重启存在 | 有 | 重启即丢上下文，恢复只能重建 |
| `progress_events` | 能回报 `claimed` / `processed` | 进程内有；跨进程需另建通道 | 只能靠 deadline 区分慢与丢，误判率高 |
| `durable_inbox` | 已 accepted 的输入重启后仍在 | 未逐项实测，必须声明 | 重启后输入蒸发，但投递表显示 accepted |
| `cross_process_control` | 从另一进程操作该 agent | 无（Agent Handle 是进程内对象） | T2 无法直接控制远端 agent，必须走协议消息 |

DSH 能力核查见 `/Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness/packages/core/agent/src/runtime-types.ts:215-241`（三种投递语义与 `cancel`）与 `.../core/agent/src/index.ts:235`（Handler 进程内）。〔DSH〕

三条使用规则：

1. `unsupported` 不得静默降级为 `followup`；降级由策略层决定并落 `lastError`/审计。
2. `accepted` 只表示 inbox 插入成功，不表示模型看见；`claimed`/`processed` 必须来自运行时事件或心跳。
3. 能力快照随 Delivery 行或 Session Subscription 持久化；重启后能力变化必须重新校验。

### 5.5 策略与协议版本的一致性（本文相对上游的增量）

上游只指出“`policyVersion` 记录不比对”是隐患（上游 §7.4）。本文把它升级为一条协议约束，并给出三种处理方式：

| 场景 | 处理 | 理由 | 代价 |
| --- | --- | --- | --- |
| 判定回写时版本不一致 | **拒绝**（`policyChanged`），Eval 重新排队一次 | 旧策略不能授权新工作；重排后可获得当前版本判定 | 策略频繁变更时会产生抖动，需要节流 |
| 工单执行中策略变更 | 不自动中止；写 `policy-changed` Input，由 worker 与 Router 处理〔原型已有 Input 类型：`src/core/model.ts:249-250`〕 | 中止会造成工作中断与副作用残留 | 旧工单可能完成在“已不鼓励”的方向上 |
| 工单 resume 前 | `revalidate(mandate)`，失败则不 resume〔原型：`src/core/tickets.ts:106-114`〕 | resume 是重新授权的事实点 | 需要保留旧 basis 可计算 |

协议侧还要求：`schemaVersion`（消息格式）与 `policyVersion`（策略内容）**分开**。合并成一个版本号会导致“仅消息格式升级也要重排所有在途评估”。〔判断〕

---

## 6. 部署拓扑

这一节把上游的四条拆进程判据落到具体形状。判据原文：**不同故障域 / 不同凭据域 / 不同扩缩容曲线 / 不同运行时**（上游 §8）。四条都不满足就不拆。

### 6.1 T0：单进程（原型形态）

```
┌────────────── 一个进程 / 一个 stateDir / 一把文件锁 / 一个 SQLite ──────────────┐
│ Source 轮询 → Intake → gate → Eval → Router Session → Decision → Ticket         │
│ → Assignment → launch effect → worker Session（同进程） → report → Outbox       │
└────────────────────────────────────────────────────────────────────────────────┘
```

| 维度 | 事实 | 证据 |
| --- | --- | --- |
| 角色合并 | 全部角色合并；Router/Worker 只是两个平级 Session | `src/app/runtime.ts:104-105`、`:210`；`src/executor/dsh.ts:23-26` |
| 必须独立 | 无 | — |
| 故障域 | 一个进程；任一 Session 卡死或 OOM 影响全部 | 同进程共享 `ctx.agents`〔`src/app/sessions.ts:137-153`〕 |
| 凭据域 | 单一 OS 用户，Router 与 Worker 都是 `danger-full-access` | `src/app/sessions.ts:152`；`docs/006-deployment.md:13-19` |
| 扩缩容曲线 | 无；`maxWorkers` 计数 1–16，不能跨机 | `src/policy.ts:91-97` |
| 运行时 | 只有 DSH | `package.json` 的 `dsh.bundle` |
| 对四条判据 | 全部不满足 → 不拆（正确） | — |

**T0 的适用范围**：单团队、单仓库、可信成员、研究或试点。它的一致性优势来自“单写者 + 单事务 + 单 SQLite”，不是来自架构先进。

### 6.2 T1：同机多进程

```
        ┌──────────────── 控制面进程 ────────────────┐         ┌── 执行面进程组 ──┐
        │ Source 轮询 / Intake / gate / Eval          │         │ worker-A         │
        │ Router Session（可缺席）                    │  队列   │ worker-B         │
        │ Engine（授权事实单写者）                     │◄──────►│ worker-C（按需）  │
        │ 共享 SQLite（含 Effect / Journal）           │         └──────────────────┘
        └────────────────────────────────────────────┘         ┌── watchdog 进程 ─┐
                                                               │ 只读事件与健康    │
                                                               └──────────────────┘
```

| 维度 | T1 的答案 |
| --- | --- |
| 角色合并 | Source + Engine + Router 合并为**控制面进程**；Assessor 可留在控制面（默认），也可独立；多个 worker 合并为**执行面进程组** |
| 必须独立 | **Executor** 独立（故障域不同：worker 崩溃不能拖垮账本）；**Watchdog** 独立（只读、且不能与写者共享故障域） |
| 故障域 | 控制面挂 → 全局停写；执行节点挂 → 只影响在途 Assignment，账本可回收租约；watchdog 挂 → 只丢观察 |
| 凭据域 | 控制面持有 Source 凭据与仓库读凭据；执行面持有仓库写凭据与工作区路径。两者用不同 OS 用户或不同凭据代理 |
| 扩缩容曲线 | 控制面 ~1（单写者）；执行面按 worker 数横向；watchdog ~1 |
| 运行时 | 控制面必须 DSH（或兼容 Engine 的宿主）；执行面可以是 DSH、也可以是别的 agent 运行时 |
| 对四条判据 | Executor：故障域 ✓、凭据域 ✓、扩缩容 ✓（运行时可选 ✓）→ 拆；Watchdog：故障域 ✓、凭据域 ✓（只读）→ 拆；Router：故障域与凭据域都与 Engine 同域，扩缩容曲线不同（评估负载 vs 写入）→ **只允许“同机独立进程”，不允许跨机** |

**为什么 Router 不跟着跨机。** Router 的产出是 `AssessmentResult`，它可以跨机传输（§5.3）；但 Router 依赖 Engine 的读视图（Thread、Ticket、candidate），且 Engine 的授权事务要求单写者。把 Router 放到另一台机器，等于把“读一致快照”变成“跨机读”，在没有分布式事务前只能靠版本比对兜底——代价高于收益。〔判断〕

**T0 → T1 的最小改动面（本文的核心结论之一）**：

| 改动 | 具体内容 | 不做的后果 |
| --- | --- | --- |
| 1. 队列可 claim | `Effects` 从进程内 handler 表改为 `queue + dispatcher + handler registry`，补 `leaseId/leaseUntil/attempts` | 多进程无法共享队列；节点崩溃后行无人回收 |
| 2. 角色目标解析 | `deliver: (id) => sessions.prompt(masterId)` 改为 `RoleTarget.resolve(role)`〔原型写死：`src/app/runtime.ts:131-133`〕 | 换 Router 实现或进程必须改代码 |
| 3. 准入端口闭合 | `Assessor` 端口补 `decide/cancel/heartbeat` 与 §5.3 校验链〔原型：`src/core/ports.ts:49-53`〕 | 外部 Assessor 无法交回判定，T1 仍只有 DSH Router 可选 |
| 4. 去掉 eager Router | 初始化不再 `await sessions.ensure(masterId)`〔原型：`src/app/runtime.ts:210`〕；无消费者时 Eval 保留 deadline | 控制面启动被 Router 绑定，Router 缺席=系统不可用 |
| 5. 节点身份 | Executor 带 `nodeId`；Assignment 带 `leaseId/fencingToken` | 无法判断“这个报告来自哪个节点、是否已过期” |
| 6. 权限拆分 | Router 只读 + decide token；Worker 写工作区；Watchdog 只读〔现状统一 `danger-full-access`：`src/app/sessions.ts:152`〕 | 拆了进程仍同权限，等于只是多了 IPC 开销 |

**不需要改的**：SQLite（同机共享仍成立）、gate（纯函数）、域事务、outbox receipt、2 秒 pass 定时器、Ticket/Mandate 模型。这六项沿用上游 §8 的反向约束。

### 6.3 T2：跨机（控制面 + 多执行节点）

```
                    ┌──────────── 控制面（单写者） ────────────┐
                    │ Engine / Decision 账本 / Event Journal   │
                    │ Router（可缺席，可多实例但单写者）         │
                    │ 节点注册表 / 租约 / 配额                  │
                    └───────┬──────────────┬───────────────────┘
                  协议消息  │              │  协议消息
                ┌───────────▼───┐   ┌──────▼────────┐
                │ 执行节点 A     │   │ 执行节点 B     │
                │ (DSH worker)  │   │ (异构 agent)  │
                └───────────────┘   └───────────────┘
                    ┌───────────────────────────────┐
                    │ Watchdog（独立只读，跨节点观察） │
                    └───────────────────────────────┘
```

| 维度 | T2 的答案 |
| --- | --- |
| 角色合并 | 控制面内：Source + Engine + Router 可合并（单写者）；Assessor 可独立成评估集群 |
| 必须独立 | **每个执行节点**（故障域、凭据域、扩缩容曲线都不同）；**Watchdog**（只读且跨故障域）；**控制面的账本写者**（不能被执行节点共享） |
| 故障域 | 控制面挂 → 全局停写，执行节点保留在途但无法续租；执行节点挂 → 租约到期后任务可改派；网络分区 → 见下 |
| 凭据域 | 控制面：Source 与仓库读；节点：仓库写 + 本机凭据代理；节点之间不共享凭据 |
| 扩缩容曲线 | 控制面 1（写者）+ 读副本；执行节点 N；评估集群 M |
| 运行时 | 节点可异构：DSH、Codex、Claude、自研；靠能力声明区分 |
| 对四条判据 | 执行节点：四条全满足 → 必须拆；控制面：故障域不同（账本不能与执行共享）→ 拆；Watchdog：全满足 → 拆 |

**T2 新增的协议要求（T1 没有的）**：

| 要求 | 缺什么会坏 | 最小实现 |
| --- | --- | --- |
| 节点注册 | 不知道谁在线、谁能接什么 | 控制面存 `nodeId/roles/capacity/version/capabilities/lastHeartbeat` |
| 租约与心跳 | 节点失联后任务永久卡住 | Assignment 级租约 + TTL；心跳续租；到期可改派 |
| fencing token | 被回收的节点恢复后继续写，造成重复报告 | 每次租约回收递增 token；节点写入携带 token，旧 token 被拒 |
| drain | 优雅下线会硬杀在途任务 | 节点先停止 claim，等在途结束或到超时 |
| 结果未知 | 网络超时被当成失败重试，重复外部副作用 | `timeout` 与 `unknown` 分离，先对账再决定 |
| 跨机读一致 | router 读到旧 Ticket 建错工单 | 所有读带 `policyVersion` + `seq`；判定回写做 §5.3 校验 |

**网络分区时的三种选择（必须显式定，不能靠默认）**：

| 策略 | 行为 | 代价 | 适用 |
| --- | --- | --- | --- |
| CP（拒绝写入） | 控制面失去多数→停写；执行节点保留在途、不接新任务 | 可用性下降 | 授权优先（本文默认） |
| AP（本地继续） | 执行节点本地继续，恢复后对账合并 | 可能重复外部副作用，需要 fencing + 对账 | 高吞吐、可容忍重复 |
| 混合 | 授权停写、执行不停、报告延后 | 实现最复杂 | 不建议首版 |

本文选 **CP**：因为 P2（授权不可跨进程）优先于可用性。代价是控制面成为单点；可用性靠“进程监督 + 快速重启 + 租约回收”，不靠多写者。T2 若要做控制面 HA，必须先把账本改成支持单写者切换（选举或外部一致性存储），这超出第 1 阶段。

### 6.4 三形态对照

| 维度 | T0 | T1 | T2 |
| --- | --- | --- | --- |
| 故障域数 | 1 | 3（控制面/执行面/watchdog） | N+2 |
| 凭据域数 | 1 | 2 | N+2 |
| 扩缩容 | 垂直（maxWorkers） | 执行面横向 | 执行面与评估面横向 |
| 运行时异构 | 不可 | 执行面可异构 | 全面可异构 |
| 单写者 | 进程内 | 控制面进程 | 控制面实例 |
| 最小改动起点 | — | 队列 claim + RoleTarget + 端口闭合 + 去 eager | 节点注册 + 租约 + fence + 未知态 |
| 不做会怎样 | 单机上限 | 只是“多窗口跑同一个程序” | 分布式单体，难排查 |

---

## 7. 决策清单（ADR）

格式：选项 / 选择 / 理由 / 代价 / 可回退性。可回退性分三级：**易**（改配置或适配器）、**中**（改一个平面）、**难**（改账本模型或跨平面协议）。

### D1 队列载体：本地 SQLite vs 外部队列

- **选项**：A. 继续用 SQLite 表（单机/T1 共享文件）；B. Redis Streams；C. SQS/Kafka；D. Temporal/Restate 一类持久执行。
- **选择**：**T0/T1 用 A，T2 控制面仍用 A（若单机）或 B（若控制面独立部署）；C/D 推迟。**
- **理由**：队列语义已经具备（同事务入队、退避、限流、保序、暂停）〔原型：`src/app/effects.ts:46-160`〕；替换载体不改变正确性，只增加网络分区面。T2 的跨节点通信是“控制面↔节点”的少量命令，不需要高吞吐总线。
- **代价**：SQLite 单写者限制吞吐；跨机共享文件系统不可靠，T2 必须由控制面进程独占写。
- **可回退性**：**易**。队列接口只要求 `enqueue/claim/ack/nack/heartbeat`，换 B 是替换实现。

### D2 执行归属：只用 lease vs lease + fencing token

- **选项**：A. 只用租约（到期回收，不校验旧持有者）；B. 租约 + 单调递增 fencing token，写入必须带 token。
- **选择**：**B。**
- **理由**：只有租约时，被回收的节点恢复后仍可写回，制造重复报告（上游 §6.2 的〔推断〕）。token 让“过期写入”可判定，而不是靠时间窗猜。
- **代价**：每次回收要持久化 token；所有写回路径都要带 token 并校验；实现与测试面变大。
- **可回退性**：**中**。去掉 token 校验需要同时接受“重复报告可被业务幂等吸收”的前提，风险不可静默接受。

### D3 策略版本：记录 vs 比对

- **选项**：A. 沿用现状，只记录 `policyVersion`；B. 回写时比对，不一致拒绝并重排；C. 比对后按新策略重新计算并接受。
- **选择**：**B。**
- **理由**：A 在跨进程时会把旧策略判定当成有效授权；C 会“用新规则解释旧证据”，审计上无法解释为什么接了。
- **代价**：策略变更会让在途评估重排；需要节流与“重排上限”，否则抖动。
- **可回退性**：**中**。改成 C 只影响 `AssessmentResult` 校验分支。

### D4 判定回写通道：HTTP vs 队列

- **选项**：A. Assessor 通过 HTTP 调 `POST /assessment-result`；B. Assessor 把结果写成队列消息，由控制面消费；C. 双向：命令走队列、结果走 HTTP。
- **选择**：**B（结果走队列）。**
- **理由**：结果本身是可重试、可延迟的事实，队列天然提供至少一次与退避；HTTP 需要额外的重试、去重与鉴权中间件。命令（`assess request`）也走队列，形成对称。
- **代价**：结果有延迟（取决于 dispatcher 周期）；需要把“结果到达”纳入 deadline 计算。
- **可回退性**：**易**。HTTP 端点可后加，队列仍是权威路径。

### D5 Router 生命周期：常驻 vs 可缺席

- **选项**：A. 启动即创建（现状）；B. 启动不创建，Router 作为消费者注册后生效；C. 常驻但可热替换。
- **选择**：**B。**
- **理由**：A 让控制面启动被 agent 创建绑定〔原型：`src/app/runtime.ts:210`〕，且 Router 挂=评估无消费者；C 的“热替换”在没有租约前会造成两个 Router 同时判定。
- **代价**：需要“无消费者态”的健康与积压指标；deadline 必须从领取计时，否则缺席会耗光时间（上游 §6.4）。
- **可回退性**：**中**。可先保留 eager 创建，只把“消费者注册”做成可选路径，再切换默认。

### D6 事件与投递：单表 offset vs Journal + Delivery 分表

- **选项**：A. 一张 outbox 表 + 消费者 offset；B. 事件 Journal 一行 + 每个消费者一行 Delivery；C. 每个消费者一张表。
- **选择**：**B。**
- **理由**：同一事件要投给 Router、多个 Worker、审计、Watchdog，各自失败与重试独立（上游 §6.8）。A 隐含“一个事件一个投递位”，任一成功会被当成全部完成。C 表数量随消费者增长，迁移困难。
- **代价**：写放大（1 个事件 N 行投递）；需要清理与归档策略。
- **可回退性**：**难**。迁移回单表会丢失每消费者进度语义。

### D7 Assessor 端口：扩展现有端口 vs 另立服务

- **选项**：A. 在 `Assessor` 端口加 `decide/cancel/heartbeat`；B. 另立 `AssessorService` 协议，`Assessor` 端口保持只读；C. 让 Assessor 直接调 `Engine.decide`。
- **选择**：**A。**
- **理由**：领域层已经依赖 `Assessor` 端口〔原型：`src/core/ports.ts:49-53`〕，扩展它比新增服务少一层装配；C 会把授权事实暴露给 assessor，违反 P2。
- **代价**：端口变更影响 Engine、`MasterAssessor` 与工具入口；需要一次性迁移。
- **可回退性**：**中**。B 可作为 A 的后续收敛（把 `decide` 搬到独立服务），但协议字段不变。

### D8 T1 的 Router：与控制面同进程 vs 独立进程

- **选项**：A. 合并进控制面；B. 同机独立进程；C. 从 T1 起就跨机。
- **选择**：**A 为默认，B 为可选项，C 明令不在 T1。**
- **理由**：Router 与 Engine 共享授权读视图与 `policyVersion`；合并进程换来一致性，代价是 Router 崩溃会带走控制面。B 在需要“Router OOM 不影响账本”时可以启用，但必须已有租约与队列 claim。C 缺分布式读一致。
- **代价**：A 的故障半径大；B 增加 IPC 与部署复杂度。
- **可回退性**：**易**。A→B 只是换个装配方式与角色目标解析。

### D9 失败语义：三态 vs 六态

- **选项**：A. `success/failed/retry`；B. `rejected/failed/timeout/unknown/cancelled/paused`。
- **选择**：**B。**
- **理由**：外部副作用超时后可能已生效，重试会重复评论/PR；`unknown` 必须独立，先对账（上游 §6.5）。原型已有 `Later` 区分“现在不能跑”与“失败”〔原型：`src/app/effects.ts:1-5`、`:138-143`〕，B 是在其上补两态。
- **代价**：每个消费方要处理六态；UI 与告警需要新文案。
- **可回退性**：**中**。合并 `timeout/unknown` 会把“结果未知”退化成“失败重试”，风险不可接受。

### D10 适配器接口：统一 `sendMessage` vs 能力声明

- **选项**：A. 统一 `send(agentId, text)`；B. 四个操作 + 八项能力标志；C. 每个适配器自定义协议，不做抽象。
- **选择**：**B。**
- **理由**：统一接口会抹平 `inject/steer/followup` 的语义差异，跨厂商时调用方会假设不存在的保证〔DSH：`.../runtime-types.ts:215-241`〕。C 让调用方无法编排。
- **代价**：调用方要按能力分支；能力快照要持久化并校验。
- **可回退性**：**中**。删掉能力标志等于接受“静默降级”，与 P5 冲突。

---

## 8. 第 1 阶段明确不做的事

### 8.1 本文不做的（已在上游 P1/P2 中，属于下一阶段）

| 项 | 所属阶段 | 为什么不在本轮 |
| --- | --- | --- |
| 多租户隔离、租户身份、数据分区 | 第 2 阶段 | 需要先决定账本与凭据模型，否则租户字段只是装饰 |
| 身份认证协议（OIDC/SAML/服务身份） | 第 2 阶段 | 依赖部署形态定稿；T1/T2 的节点身份已在 §6 定义轮廓 |
| 沙箱、网络出口白名单、凭据代理实现 | 第 2 阶段 | 属安全实现，不是平面划分问题 |
| 可观测性（trace、指标、告警口径） | 第 2 阶段 | 本文只给出 Watchdog 的只读定位与输入 |
| 持久化运维（备份、迁移、归档、容量） | 第 2 阶段 | 需要先定 Journal/Delivery 的保留策略 |
| 控制面 HA 与写者选举 | 第 3 阶段 | T2 的 CP 选择已定，HA 需要账本层改造 |
| 外部副作用对账的具体实现（GitHub/Feishu API 幂等映射） | 第 3 阶段 | 本文只定义 `unknown → 对账` 的状态与位置 |
| UI、审批界面、人机协作流的交互设计 | 不排期 | 非架构范围 |

### 8.2 下一阶段待写清单（按上游 P1/P2 归并）

**P1（协议落地，仍以单机/T1 为主）**

1. `Effects` 服务化：claim / heartbeat / ack / visibility timeout / dead-letter。
2. 节点注册与容量声明（T1 的本地注册表）。
3. 失败分类六态落地，含 `timeout → unknown → 对账` 的状态机。
4. 按角色拆凭据：Router 只读 + decide token；Worker 受限写；Watchdog 只读。
5. 移除 eager Router，补“无消费者态”的健康与积压。
6. Event Journal + Delivery 表落地（含按消费者注册后补建投递行）。

**P2（异构与跨机）**

7. Router 适配器：DSH Session（现状）+ 外部 agent（HTTP/队列）。
8. Executor 适配器：`DshExecutor` 作为本地适配器 + 远程节点适配器。
9. Watchdog 作为独立只读消费者，产出 health/alert/finding。
10. 跨机租约、fencing、drain、分区策略的实测与故障注入。

每一项的验收信号沿用上游 §10 的写法，本文不重复。

### 8.3 评审时需要先裁决的三个分歧点（本文自己未定论）

1. **D7 的形态**：扩展 `Assessor` 端口（A）还是另立 `AssessorService`（B）。本文选 A 求最小改动，但如果目标是“DSH 之外也能复用这套协议”，B 更干净。取舍取决于“协议是否要被非 DSH 宿主复用”。
2. **T1 的 Router 是否默认独立进程**：本文默认合并（D8-A）。如果团队更看重“Router 崩溃不影响账本”，应改为 B，但前提是队列 claim 与租约先落地。
3. **Journal 与 Delivery 是否同一张物理表**：本文按语义分两层（D6-B），但物理上可以一张表加 `kind` 列。本文倾向**逻辑分离、物理可合并**，以降低写放大；如果评审认为“物理分开更利于清理与归档”，需要现在定，因为后期迁移代价高。

---

## 9. 证据索引与待验证项

### 9.1 关键论断 → 证据

| 论断 | 证据 |
| --- | --- |
| 域事务是单写者单事务 | `src/core/engine.ts:48`；`src/core/tickets.ts:37-56` |
| 准入是纯函数、事务内调用 | `src/policy.ts:191-211`；`src/core/evals.ts:96` |
| Assessor 端口未闭合（只有 request/release） | `src/core/ports.ts:49-53`；`src/app/assessment.ts:272-279` |
| Executor 端口已闭合（只排队 + 回调） | `src/core/ports.ts:59-69` |
| 主 Session 急切创建 | `src/app/runtime.ts:210` |
| 评估投递写死 masterId | `src/app/runtime.ts:131-133` |
| 通知只能 steer 到已存在 agent | `src/app/sessions.ts:104-105` |
| `policyVersion` 只记录不比对 | `src/core/evals.ts:107-111`；`src/app/assessment.ts:275` |
| effect 队列有退避/限流/保序/暂停，但派发在进程内 | `src/app/effects.ts:46-160`、`:83-88` |
| 投递幂等按 requestId | `src/app/delivery.ts:16`、`:61-84` |
| 外部回复靠 receipt 去重 | `src/app/outbox.ts:26-51` |
| 角色权限现状 `danger-full-access` | `src/app/sessions.ts:152` |
| 执行并发只有计数，无配额 | `src/policy.ts:91-97`；`src/limits.ts:6` |
| Source 只写 Trigger 与游标 | `src/sources/host.ts:41-45`；`src/sources/github.ts:225-244`、`:372` |
| Mandate 不可变、resume 前 revalidate | `src/core/model.ts:125-133`；`src/core/tickets.ts:106-114` |
| DSH 三种投递语义 | `/Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness/packages/core/agent/src/runtime-types.ts:215-241` |
| DSH Agent Handle 为进程内对象 | `/Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness/packages/core/agent/src/index.ts:235` |
| DSH webhook 只是 fire-and-forget | `/Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness/packages/experimental/webhook/README.md:71-73` |
| Session log 不等于业务账本 | `/Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness/docs/drafts/dsh-superagent-prototype-research.md:138` |
| 原型是单进程两个平级 Session | `/Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness/docs/drafts/dsh-superagent-runtime-facts-and-enterprise-gap.md:43-49` |

### 9.2 待验证项（本文未运行验证，不得当作已成立）

| # | 待验证 | 现状 | 验证方式 |
| --- | --- | --- | --- |
| 1 | “已投递未判定”的崩溃窗口没有主动补偿 | 上游标〔推断〕；依据是 effect 成功即删行 + deadline 兜底 | 在投递后、decide 前强杀进程，观察是否只能等 deadline |
| 2 | `ensure` 并发幂等（同一 Eval 重试不建两个 Session） | 上游标〔推断〕 | 并发调用 `ensure`，断言只创建一个 |
| 3 | `policyVersion` 不一致的实际可复现性 | 上游标〔推断〕 | 评估进行中修改规则，提交旧版本结果，观察是否被接受 |
| 4 | `durable_inbox` 在 DSH 重启后是否保留已 accepted 输入 | 未逐项实测 | 投递后强杀、重启，检查 inbox |
| 5 | 外部副作用超时是否可安全重试 | 取决于 GitHub/Feishu API，未逐 API 验证 | 超时后查远端事实，再判断可否重放 |
| 6 | T1 同机多进程下 SQLite 的锁竞争与 WAL 行为 | 本文为设计，无实测 | 起 2–3 个进程共享一个库，压测 claim/ack |
| 7 | 网络分区下的 CP 行为（T2） | 纯设计 | 断网注入 + fencing token 校验测试 |
| 8 | Watchdog 的只读假设（不持有写连接） | 纯设计 | 用只读 DB 连接 + 权限最小化的进程验证 |

凡是本表未验证的项，本文中的相应结论都应读作**设计主张**，不是运行事实。

### 9.3 本文自身的局限

- 本文没有修改任何代码，也没有运行原型或 DSH 的测试；所有“现状”来自源码阅读。
- T1/T2 的拓扑是设计，不是实测；其中的时延、吞吐、故障恢复时间都没有数据。
- 上游的外部材料（ChatGPT 分享页）只被采用结构性结论；本文未引入新的外部材料。
- 本文不处理多租户、身份、安全、可观测性；这些会影响本轮的平面边界，第 2 阶段可能需要回头修改 §3。
