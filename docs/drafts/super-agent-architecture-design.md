# Super-Agent 整体架构设计（第 1–3 阶段：定位、原则、分解、契约、拓扑、ADR、身份安全、领域系统接入）

> 状态：第 1–3 阶段草稿，待评审。第 3 阶段接入流程引擎、知识库与过程状态三类外部领域系统。
> 上游材料：[事件驱动架构调研](event-driven-architecture-research.md)（本仓库，2026-11-05 完成，678 行）。本文引用它而不重复它。
> 核查日期：2026-11-05。证据标签：〔原型〕=本仓库可复核实现；〔DSH〕=`deepseek-harness` 现有能力；〔判断〕=本文分析；〔设想〕=本文提出、尚未落地；〔推断〕=代码可解释但未运行验证。外部材料标注来源与读取日期。

## 0. 摘要（硬结论）

以下十条都可被反驳；每条给出反例的形态，便于评审直接挑战。

1. **系统的可迁移内核是“授权事实单写者 + 事务性持久队列 + 纯函数准入”，不是事件总线。** 换消息中间件不改变系统正确性；换掉这三样会改变。〔原型：`src/core/engine.ts:48`、`src/core/tickets.ts:37-56`、`src/policy.ts:191-211`〕反例形态：如果评审认为跨机后 Engine 可拆成多个写者，则第 1 条不成立——但那要求分布式事务或 saga，代价见 §7-D1。
2. **角色必须按“谁拥有事实”切分，而不是按“谁在运行”切分。** 进程可以随部署变化，事实所有权不能。沿 Session 切分只会把进程内耦合换成网络耦合。〔判断〕
3. **Assessor 端口未闭合是唯一“不做就无法异构”的缺口。** 其余缺口（队列服务化、权限拆分、节点注册）可以分批做；不做只会让“异构”退化成“同机多进程”。〔原型：`src/core/ports.ts:49-53`，`decide` 在 `src/app/assessment.ts:272-279` 而非端口〕
4. **授权不可跨进程。** 远程 Assessor/Worker 只能交回判定或报告，Decision、Mandate、Ticket 必须由持有账本的单写者在单个事务内写入。〔判断，沿用上游 §3.1〕
5. **`policyVersion` 的比对在原型中已经存在；缺的是有界处置与 fencing。** `decideEval` 在回写时比较 `this.policy().version !== evaluation.policyVersion`，不一致时对活跃 Eval 触发 `reassess({code:'policyChanged'})`、对非活跃 Eval 以 `unavailable` 结束〔原型：`src/core/evals.ts:284-288`〕；`policyChanged` 还会主动重排所有活跃 Eval〔原型：`:218-221`〕；`evalId` 已含 `policy.version`〔原型：`:107`〕。本文的增量不是“补比对”，而是“合并窗口 + 重判上限 + lease/attempt fencing + 饥饿可观测”（§13.2）。
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
- §10 第 2 阶段：裁决落地与新增结论
- §11 身份与租户
- §12 授权与凭据
- §13 策略与协议版本一致性
- §14 安全威胁模型
- §15 可观测性与审计
- §16 持久化与运维
- §17 里程碑与验收信号
- §18 最脆弱的两个论断
- §19 领域系统的接入边界
- §20 业务流程（SOP）平面
- §21 知识平面
- §22 过程状态平面
- §23 巨石防御
- §24 ADR 增补（D11–D15）

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
| 策略/协议版本一致性 | 部分：指出投递状态机没有版本分支（上游 §6.9）；判定回写已比对，上游已核对（research:479、:561），但未给有界处置 | §5.3 唯一校验链、§7-D3、§13.2 有界重排本文主体 |
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
| P6 | **可缺席优于常驻。** Router、Assessor、Worker 都允许缺席；缺席时事件与评估保留期限，不阻塞写入。 | 需要“无消费者态”的健康语义与积压告警；deadline 由**首次领取**（`claimedAt`）一次性设定，重判不重置。 |
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
| Work | 工作单元（Ticket/Input/Report）的状态机、调度、容量、执行报告与结束语义；**Assignment 的创建与 `attempt` 递增不在本平面** | Ticket*、Input*、Report*、调度队列*；Assignment 只读（由控制面授权事务创建） | 不能创建授权；不能写 Assignment/Lease；不能把“模型说完成”当成验收 | `src/core/tickets.ts:37-56`；`src/core/assignments.ts:34-77`；`src/executor/dsh.ts:263-343` | Session log 记录交互事实，不是业务账本（`/Users/yangjiefeng/Documents/deepseek-ai/deepseek-harness/docs/drafts/dsh-superagent-prototype-research.md:138`） |
| **Lease（控制面租约服务，不是第六个平面）** | 签发、续租、释放、过期；为 `delivery` / `eval` / `assignment` 三个 scope 提供 fencing | `Lease*`；`Assignment.attempt`*（随 Assignment 创建写入） | 不能决定授权；不能替 holder 续租；不能改写已释放/过期的租约 | 无；唯一跨进程互斥是 stateDir 的 `proper-lockfile`〔原型：`src/app/runtime.ts:93`〕 | 无 |

四个跨平面的共用约束：

- **单写者规则。** 标 * 的事实只允许一个写入者（可以是一个进程内模块，也可以是 T2 的一个控制面进程），其他平面只能读或提交“请求”。
- **控制面单事务写 Assignment 与 Lease。** `Ticket`、首 `Assignment`（及其 `attempt`）与 `Lease` 的签发在 §5.3 第 8 步的同一事务内完成；Work 平面只读 Assignment，调度子层只能提交派发请求。**T1**：Work 调度子层与控制面同进程、共享同一个 SQLite 事务；**T2**：调度器已拆分，但只能调用控制面事务 API 提交“创建 Assignment / 签发 Lease”请求，**不得**直接写这两张表。单写者因此可验证：任何 Assignment/Lease 行的 `writer` 都必须是控制面事务。
- **Version 约束。** 跨平面传输的请求都带 `policyVersion` 与 `schemaVersion`；接收方落库前比对（§5.3）。
- **不突变原则。** 一个平面不能“顺手”改另一个平面的事实。原型已经基本遵守：`Executor.start/deliver/stop` 只排队，回报走 Engine 回调〔原型：`src/core/ports.ts:59-69`〕；这条要写进 T1/T2 的协议。

### 3.2.1 五平面 × 三类领域系统（第 3 阶段扩展）

第 3 阶段接入流程引擎（Process）、知识库（Knowledge）、过程状态存储（RunState）。**这三者都是外部事实的拥有者，不是平面内的新模块**；五个平面只能通过端口读写。

| 平面 \ 领域系统 | 流程引擎 | 知识库 | 过程状态 |
| --- | --- | --- | --- |
| Event | **R**（流程任务/状态事件作为 ExternalSignal 入 Journal）；**禁止直写引擎** | 禁止读写（事件规范化不查知识） | 禁止（事件平面不持有运行状态） |
| Decision | **R**（只读流程定义，用于判断“是否需人工审批/是否属于有界任务”）；不写实例 | **禁止**（授权判定不得读知识，见 §21.4） | 禁止 |
| Delivery | **W（经端口）** 投递 `completeTask/signal`；**禁止直写引擎库** | 禁止 | 禁止 |
| Agent Runtime | R（只读当前任务与变量，作为输入） | **R（只读检索，带 provenance）** | **W（经端口）** 记录等待/尝试/假设；禁止直写账本 |
| Work | **R**（Ticket 只保存 `processInstanceId/taskId` 引用与快照时间）；**W 仅限账本自身事实** | 禁止（工单不内嵌知识） | R（用于恢复，不是权威） |

四条硬约束：

1. **W 一律经端口**：平面不得直连外部系统的库或表；端口负责鉴权、租户过滤、幂等与错误映射。
2. **R 也要带版本**：读流程定义要带 `definitionVersion`，读知识要带 `knowledgeVersion/asOf`，读运行状态要带 `observedAt`；否则读到的是“不知道哪一版的事实”。
3. **禁止跨平面代写**：Delivery 不能直接改 Ticket 状态，Work 不能直接推进流程实例；各自只写自己的事实，其他一律发请求。
4. **缺席可用**：三个外部系统任一不可用时，账本写入与事件接收仍必须可用（§5 的可缺席原则扩展到领域系统）；降级方式见 §19.4。

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

**Executor。** 端口已存在且语义正确（只排队 + 回调）〔原型：`src/core/ports.ts:59-69`〕。差距在权限与归属：同一 OS 用户、`danger-full-access`〔原型：`src/app/sessions.ts:152`〕；没有节点身份、没有租约。T1 起必须补 `nodeId`、`leaseId` 与 `lease.generation`（§5.6）。

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

只定义可评审的最小形状。所有协议共享四条规则：**每条消息带 `tenantId` 与 `schemaVersion`；每条命令带幂等键；`attempt` 只属于 Assignment，由控制面在创建时递增写入；每条结果带产生它的 `leaseId` 与 `leaseGeneration`。** 租约与 attempt 的实体定义只在 §5.6 一处，其余小节只引用。

### 5.1 事件（Event）与投递（Delivery）

原型有四层，但缺“按消费者”的通用投递行（上游 §6.8）：`Trigger` 是不可变事件、`TriggerDisposition` 是聚合路由、Ticket `Input` 是工单内投递、`Effect` 是副作用投递〔原型：`src/core/model.ts:22-60`；`src/core/intake.ts:19-61`；`src/app/effects.ts:61-66`〕。本文拆成 Journal + Delivery。

**Event 信封**

| 字段 | 说明 | 缺失后果 |
| --- | --- | --- |
| `tenantId` | 租户边界；所有下游键的第一段 | 跨租户串数据；`(eventId, consumerId)` 在不同租户复用会覆盖 |
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

**Delivery 行（按消费者一条，唯一键 `(tenantId, eventId, consumerId)`）**

| 字段 | 说明 | 缺失后果 |
| --- | --- | --- |
| `tenantId` | 投递所属租户；唯一键第一段 | Delivery 行可能跨 tenant 投递；区隔离只靠应用层过滤 |
| `deliveryId` / `eventId` / `consumerId` | 三元定位（在 tenant 内） | 多消费者共享一个进度位，任一成功即被当成全部完成 |
| `state` | `routed→accepted→claimed→processed` / `failed/expired/unknown` | “已送达”被当成“已处理”，丢失与卡住无法区分 |
| `deliveryAttempts` / `nextAttemptAt` | 投递重试次数与下次时间；不是执行 attempt | 无退避的重试会打爆下游，且无法区分重试与新工作 |
| `leaseId` / `leaseGeneration` / `lease.expiresAt` | 领取者、租约代次与到期 | 两个消费者可同时处理同一条；崩溃后无人回收；旧代次写入无法拒绝 |
| `deadline` | 业务期限（评估/执行） | 慢与丢无法区分，只能无限等 |
| `lastError` | 最近错误摘要 | 排障只能看日志，无法按消费者聚合 |
| `capabilitySnapshot` | 交付时的适配器能力 | 适配器降级后沿用旧假设，例如把 `next_step` 静默变成 `next_turn` |

**幂等键（五类，沿用上游 §6.3，但补 `leaseGeneration`、`tenantId` 与租约键）**

| 幂等域 | key | 缺失后果 |
| --- | --- | --- |
| 事件 | `(tenantId, eventId)` | 重复落库、重复评估、重复建工单 |
| 评估 | `(tenantId, evalId, leaseGeneration)`，且 `accepted(triggerId)` 兜底 | 迟到结果覆盖已生效判定；重试被当成新判断 |
| 执行/输入 | `(tenantId, assignmentId, inputId)` | 同一输入投递给两个 Assignment，worker 重复执行 |
| 外部副作用 | `(tenantId, receiptId)`，外部 API 幂等键能映射就映射 | 超时重试造成重复评论/重复 PR |
| 租约签发 | `(tenantId, scope, subjectId, generation)`（§5.6） | 跨租户复用 lease 或重复签发同代租约，fencing 失效 |

### 5.2 工作单元与授权

**WorkItem / Ticket 的不可变字段**（创建后不可改；可变状态另行列出）

| 字段 | 不可变 | 说明 | 缺失后果 |
| --- | --- | --- | --- |
| `tenantId` | 是 | 租户边界；所有键与外键的第一段 | 工单可被跨租户改派或查询 |
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
| `tenantId` | 授权所属租户；与 Ticket 必须同租户 | 授权可被跨租户引用 |
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
| `tenantId` | 判定所属租户；幂等键与所有引用同租户 | 判定可被跨租户复用，键冲突 |
| `evalId` | 被判定的是哪个 Eval | 无法拒绝“评估已结束后又来的判定”；原型此处已严格校验〔原型：`src/core/evals.ts:135`〕 |
| `leaseGeneration` | 签发该判定的租约代次（fencing 值，§5.6） | 重试与接管无法区分；旧代次的迟到判定会覆盖新判定 |
| `leaseId` | 判定者领取任务时拿到的租约 | 无法拒绝未持有租约的判定；两个 assessor 可同时提交 |
| `assessorId` | 判定者实例身份（不是 Session id） | 审计无法回答“谁判的”；A/B 与回溯不可能 |
| `policyVersion` | 必须等于领取时下发的 `Eval.targetPolicyVersion`（§13.2） | 用旧策略得出的判定被当成当前有效授权（见 §5.3 第 6 步） |
| `outcome` | `accept / ignore / unavailable / stop` | 无法区分“不接”与“判不了”，重试策略错误 |
| `completedAt` | 判定完成时间（assessor 自报，仅用于延迟观测） | 无法区分“判定跑了多久” |
| `receivedAt` | 控制面接收时间（控制面盖戳，唯一迟到判据） | 用 assessor 自报时间判迟到，可被伪造或受时钟漂移影响 |
| `evidence` | **只能放授权链内类型**（类型集合见 §5.3 第 5 步，本文不重复列举）。每条含 `type` + 引用 id + 摘要 | 换 Assessor 后证据质量下降；无法复核“为什么接”；若允许知识引用混入，等于让文档内容参与授权〔原型 schema：`src/app/assessment.ts:21-34`〕 |
| `rationale` | 执行说明：可含自由文本与 `knowledge_ref`（`knowledgeId/version`），**不参与授权** | 无法回答“在哪一版知识下做的决定”；缺失只影响可追溯性，不影响授权正确性 |
| `cost` / `model` | 可选，但建议记 | 无法做成本与质量的后续分析（第 2 阶段） |

**校验链（全文唯一版本；其余小节只引用，不另列顺序）**

任何结果写入（判定提交或执行报告）都按同一顺序执行。**顺序不可交换**：evidence 白名单必须在 `policyVersion` 之前，否则 `pending-policy` 草稿会绕过类型白名单（§21.4）。

| # | 检查 | 判定提交（assessment） | 执行报告（assignment） | 失败返回 |
| --- | --- | --- | --- | --- |
| 1 | 主体与幂等/去重 | `(tenantId, evalId, leaseGeneration)` 未处理；Eval 未终态 | `(tenantId, assignmentId, attempt)` 未处理 | `rejected: evalFinished`；幂等命中则返回首次结果，不重复写 |
| 2 | attempt / fencing | `leaseGeneration` 为当前代次 | `attempt` 为该 Ticket 当前最大 | `rejected: staleAttempt` |
| 3 | lease 有效 | `leaseId` 为 `active`、未过期、`holderId=assessorId`、token 匹配 | `leaseId` 为 `active`、未过期、`holderId=nodeId` | `rejected: leaseLost` |
| 4 | deadline | 控制面 `receivedAt` ≤ `Eval.deadline` | 控制面 `receivedAt` ≤ `Assignment.deadline` | `rejected: late` |
| 5 | evidence 类型白名单 | `type ∈ {source_event, mandate, policy_rule, prior_decision}`（**本行是 evidence 类型的唯一权威定义**）；`rationale` 不参与授权，但 `rationale.knowledge_ref` 必须可解析 | 不适用（报告无 evidence） | `rejected: unauthorized_evidence` / `rejected: invalid_rationale_ref` + `assessment.evidence_rejected`（后者 `offendingType=rationale_ref`） |
| 6 | `policyVersion` 一致性 | ① **快照校验**：提交的 `policyVersion` 必须等于 `Eval.targetPolicyVersion`（该代次实际下发给 assessor 的版本），否则 `rejected: policySnapshotMismatch`（判定被篡改或错误重放）；`Eval.policyVersion` 是创建时的不可变快照，只用于审计，不参与本步；② **当前性校验**：**当前** `Policy.version` 必须等于 `Eval.targetPolicyVersion`，否则 `policyChanged`（进 §13.2） | Mandate 的 `policyVersion` 仍被当前策略承认；否则 `policyChanged`（写 `policy-changed`） | `rejected: policySnapshotMismatch` / `policyChanged` |
| 7 | outcome / Mandate 一致 | `outcome` 与已启用规则匹配（推断候选仍需匹配）〔原型：`src/core/evals.ts:152-154`〕 | 报告动作 ⊆ `Mandate.scope` | `rejected: out_of_scope` |
| 8 | 单事务写入 + 审计 | 同事务写 Decision + Mandate + Ticket + 首 Assignment + effects + audit | 同事务写 Report + 状态推进 + receipt + audit | — |

**为什么第 4 步用 `receivedAt`**：`completedAt` 是 assessor 自报，可伪造或受时钟漂移影响；迟到判定只认控制面接收时间。`Eval.deadline` 本身以 `claimedAt + evalTimeoutMs` 计算（§13.2.1），即从领取起算，不是从创建或投递起算。

**为什么第 5 步必须在第 6 步之前**：`pending-policy` 只暂存“已通过前 5 步”的提交；若先判版本，未过白名单的草稿会进入等待队列，窗口关闭后又被重新提升，等于绕过知识隔离（§21.4）。

**唯一性**：§13.2 只定义 `policyChanged` 之后的处置，不重复本表；§21.4 是本表第 5 步的展开；§10.2 的 `assess.submit` 字段必须满足本表。**人工决策（§5.8 的 `accept`）同样是一条判定消息，必须走本表 1–8，不存在“人工已批准所以跳过第 5 步/第 6 步”的路径**。新增检查只能插入本表并更新所有引用，不得另立第二份顺序。

**为什么把白名单放在协议而不是只靠模块边界**：模块边界只能保证“Decision 代码没有 import 检索端口”，不能保证 assessor 在 `evidence` 里塞一条“知识说可以”。一个被知识影响的 accept 仍然会产出结构合法的 `evidence`；只有类型白名单能在落库前把它变成不可接受的判定。〔判断〕**具体事故**：知识条目写着“这类 PR 可直接合并”，assessor 把它当作 accept 的依据写入 `evidence.knowledge_ref`；若放行，审计链会显示“依据知识库批准”，而知识本身没有授权资格（§21.4）。

**当前差距（必须写清）**：原型已在判定回写时比对版本，并在策略变更时主动重排〔原型：`src/core/evals.ts:284-288`、`:218-221`〕。缺的不是比对，而是**有界处置**与 **fencing**：

- **合并/去抖窗口缺失**：每个活跃 Eval 在 `policyChanged` 时立即重排，连续策略变更会反复取消评估〔原型：`src/core/evals.ts:218-221`〕。
- **重判次数无上限**：`reassess` 无条件回队，只有超时路径有 `REQUEUES = 2`〔原型：`src/core/evals.ts:19`、`:222-230`、`:57-62`〕。
- **缺 lease + attempt fencing**：`Assignment` 没有 owner/租约/代际/fencing 字段〔原型：`src/core/model.ts:218-233`〕，原型唯一的跨进程互斥是 stateDir 的 `proper-lockfile`〔原型：`src/app/runtime.ts:93`〕。
- **饥饿与升级不可观测**：原型没有 `escalated` 状态，也没有重判/排队指标，只有 `policyChanged` 原因码〔原型：`src/core/evals.ts:285-288`、`src/core/reasons.ts:8`〕；`escalated` 属〔设想〕。

deadline 与 evidence 白名单两步在原型中也不存在：原型的 `evidence` 是自由结构，没有类型约束，也不区分 `rationale`〔原型：`src/app/assessment.ts:21-34`〕；超时由 Eval 的 `deadline` 与 pass 超时兜底〔原型：`src/core/evals.ts:57-62`〕。〔判断〕

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

上游的原始观察是“投递状态机没有 `policyVersion` 分支”（上游 §6.9、§7.4），这一条成立；但**判定回写本身在原型已比对版本**（`src/core/evals.ts:284-288`），`policyChanged` 也会主动重排所有活跃 Eval（`:218-221`）。本文在其上补的不是比对，而是**有界处置**，并给出三种场景的处理方式：

| 场景 | 处理 | 理由 | 代价 |
| --- | --- | --- | --- |
| 判定回写时版本不一致 | **拒绝**（`policyChanged`），进入 §13.2 状态机（`pending-policy` → 窗口 → 有界重判）；本节不另行定义“重排一次” | 旧策略不能授权新工作；重排后可获得当前版本判定 | 策略频繁变更时会产生抖动，必须配 §13.2.2 的窗口与上限 |
| 工单执行中策略变更 | 不自动中止；写 `policy-changed` Input，由 worker 与 Router 处理〔原型已有 Input 类型：`src/core/model.ts:249-250`〕 | 中止会造成工作中断与副作用残留 | 旧工单可能完成在“已不鼓励”的方向上 |
| 工单 resume 前 | `revalidate(mandate)`，失败则不 resume〔原型：`src/core/tickets.ts:106-114`〕 | resume 是重新授权的事实点 | 需要保留旧 basis 可计算 |

协议侧还要求：`schemaVersion`（消息格式）与 `policyVersion`（策略内容）**分开**。合并成一个版本号会导致“仅消息格式升级也要重排所有在途评估”。〔判断〕

### 5.6 租约（Lease）与尝试（attempt）：唯一实体与唯一权威

**Lease（全文唯一实体）**

| 字段 | 说明 |
| --- | --- |
| `leaseId` | 全局唯一；消息与审计只引用它 |
| `tenantId` | 租户边界；租约键的第一段 |
| `scope` | `delivery` / `eval` / `assignment` |
| `subjectId` | scope 内的被租用对象：`deliveryId` / `evalId` / `assignmentId` |
| `holderId` | 持有者身份：`consumerId` / `assessorId` / `nodeId` |
| `token` | 不可猜测的持有凭证，只发给 holder；证明“你是被签发者”，**不做 fence** |
| `generation` | fencing 值；对同一 `(tenantId, scope, subjectId)` 单调递增，从 1 开始 |
| `expiresAt` | 到期时刻（控制面时钟） |
| `state` | `active` / `released` / `expired` / `revoked` |
| `issuedAt` / `renewedAt` | 签发与最近续租时间 |

**唯一写入者**：控制面租约服务（与账本同库、同一事务边界）。holder 不能直接写 Lease；续租、释放都是发给控制面的命令，由控制面校验后写入。**Assignment 与 Lease 的签发只在控制面单事务内完成**（与 §5.3 第 8 步同事务；T1/T2 的进程归属见 §3.2），Work 平面与 Delivery 平面只读。每个 `(tenantId, scope, subjectId)` 同时最多一条 `active` 租约。

| 操作 | 谁发起 | 语义 | 对 `generation` 的影响 |
| --- | --- | --- | --- |
| 签发 | 控制面 | `queued→assessing`、**Assignment 创建（与控制面授权事务同事务）**、Delivery claim（Delivery 平面只提交请求，控制面签发） | +1（首次为 1） |
| 续租 | holder | 出示 `(leaseId, token)`；只延长 `expiresAt`，不得超过 deadline | 不变 |
| 释放 | holder 或控制面 | `state=released`；行保留用于审计 | 不变；同代次后续写入一律拒 |
| 过期 | 控制面扫描 | `expiresAt` 已过 → `state=expired`；重派时签发新租约 | 新租约 +1 |
| 撤销 | 控制面 | 收到 `revocation` → 立即 `state=revoked`（不等 `expiresAt`）；同代次及之后写入一律拒（fail-closed） | 不变；永不复用 |

**eval scope 的 deadline 约束（固定）**：所有 eval 租约（**含首次签发**）必须满足 `expiresAt ≤ Eval.deadline`。签发时取 `expiresAt = min(now + ttl, Eval.deadline)`；若 `now > Eval.deadline`，控制面**拒绝签发**：`pending-policy` 走 T5（`budget_exhausted`），`reassess-queued` 走 T7，`escalated` 的人工 accept 在第 4 步直接返回 `late`（不进入 T5b 的接受分支）。`queued` 尚未领取、没有 `Eval.deadline`，它的等待上限是 `queuedAt + queueMaxAge`（T7b），不适用本段。首次签发时 `deadline` 在签发同一事务内计算。此约束保证 §13.2.1 的窗口上限、租约到期与 deadline 只有 §13.2.1 规定的唯一失效顺序。

**fencing 规则**：任何结果写入必须带 `(tenantId, scope, subjectId, leaseId, token, generation)`。控制面以该 `(tenantId, scope, subjectId)` 当前 `active` 租约的 `generation` 为准：**只有当前 generation 可写**；token 只证明持有者身份，generation 才是 fence，二者缺一即拒（`leaseLost`）。过期、已释放或已撤销租约的写入不得“顺手接受”，即使业务内容正确；已撤销的 `generation` 不得再被任何路径复用。TTL 默认 60 秒，可按 scope 配置〔待测基线；M1-1 的回收目标〕。

**attempt（唯一语义）**

| 项 | 定义 |
| --- | --- |
| 实体 | **只存在于 Assignment**：`Assignment.attempt` |
| 语义 | 同一 Ticket 的第 n 次执行尝试，从 1 开始 |
| 写入者 | 唯一：控制面在创建 Assignment 时递增写入 |
| 读取者 | worker / 引擎适配器只读，不得自行递增 |
| 判定口径 | 报告所属 Assignment 必须是该 Ticket 的当前最大 `attempt`，否则 `staleAttempt` |
| 唯一权威 | 账本（控制面）；引擎任务的 attempt 只是同一值的映射，不单独存在 |

**同名消歧（必须遵守）**：

1. **Delivery** 的重试计数叫 `deliveryAttempts`、**Effect** 的重试计数叫 `effectAttempts`（两者都由各自平面写），**都不参与 fencing**，不能用来判断“第几次执行”。
2. **判定（Eval）** 没有 `attempt`：第几次判定由 `Lease.generation` 表达；重判次数由 `Eval.reassessCount` 表达（§13.2，仅控制面写）。`AssessmentResult` 因此携带 `leaseGeneration`，不携带 `attempt`。
3. **引擎任务** 的 attempt 映射到同一次 Assignment 的 `attempt`，不引入第二套计数。

**两个权威，不重叠**：`Lease` 的权威是控制面租约服务（决定“谁现在持有、哪一代可写”）；`attempt` 的权威是账本控制面（决定“这是第几次执行”）。二者不能互相替代：只有 attempt 没有 lease 时，被回收的节点仍能写回；只有 lease 没有 attempt 时，无法区分“新执行”与“同一次执行的重复提交”。

### 5.7 撤销（Revocation）协议

**撤销与策略收紧是两条机制，不得复用**：`revocation` 停止执行并让授权失效；`policyChanged`（§13.2）只让在途判定重跑，已 `accept` 的工单**不因策略变更中止**（§13.2.3）。两者的原因码、状态转移、审计事件分开：撤销用 `revoked`，策略抖动用 `policy_churn` / `policyChanged`。

**消息**：`revocation{revocationId, tenantId, scope, subjectId, reason, revokedBy, revokedAt, mode}`（幂等键 `(tenantId, revocationId)`，重复投递不得重复停止或重复计数），`mode ∈ {immediate, drain}`，默认 `immediate`；`immediate` = 立即停，`drain` = 当前动作允许收尾但不再接新动作。`scope ∈ {ticket, assignment, eval}`：`ticket` 级联到其全部 Assignment 与在途 Eval；`assignment`/`eval` 只作用于该对象。这是**撤销对象**，与 §5.6 的 `Lease.scope`（delivery/eval/assignment）不同名同义：撤销时按对象级联到三种 Lease scope。

**消息表（新增，不在 §5.3 判定链内）**

| 消息 | 方向 | 字段 |
| --- | --- | --- |
| `revocation` | 人或上游系统 → 控制面 | `revocationId, tenantId, scope, subjectId, reason, revokedBy, revokedAt, mode` |
| `assignment.stop` | 控制面 → 执行端 | `tenantId, assignmentId, attempt, leaseId, leaseGeneration, reason, stopDeadline` |
| `stopped` | 执行端 → 控制面 | `tenantId, assignmentId, attempt, stoppedAt` |
| `stopFailed` | 执行端 → 控制面 | `tenantId, assignmentId, attempt, reason, at` |

**字段最小增量**：Assignment 既有状态机不变，只新增 `draining`（`drain` 模式）与 `stopState ∈ {none, requested, stopped, failed, unresponsive}`；收到 `stopped` 写 `stopState=stopped`，`stopFailed` 写 `failed`。不新增 `Assignment` 的其它字段。

**撤销落库后同一控制面事务（缺一即未实现）**：

| # | 动作 | 判据 |
| --- | --- | --- |
| 1 | 该 subject 及级联对象的 `active` Lease（delivery/eval/assignment 三种 scope）立即置 `revoked`，不等 `expiresAt`；`generation` 不再被接受 | 撤销后任何带旧代次的提交返回 `leaseLost` |
| 2 | 未终态 Assignment：`immediate` → `cancelled` + 投递 stop effect；`drain` → `draining`，完成当前动作后不再接新动作 | 撤销事务提交时 Assignment 已处于对应状态，stop effect 已入队 |
| 3 | 所有非终态 Eval（`queued` / `assessing` / `pending-policy` / `reassess-queued` / `escalated`）直接终态 `abandoned(revoked)`；`drain` 只影响 Assignment，不影响 Eval 的立即终止 | 无 Eval 停在非终态等待重判或人工 |
| 4 | 同一 `ref` 的 `open / claimed` HumanTask → `cancelled`，同事务回写其触发的 Eval/WorkItem | 无孤立 HumanTask 继续等待人工 |
| 5 | 写审计 `revocation{...}` 与 `revocation.enforced{...}`（见 §15.3） | 审计可按 `tenantId + subjectId` 检索到一条撤销与一条执行结果 |

**执行端必须回应**：收到 stop 后回 `stopped{assignmentId, attempt, stoppedAt}` 或 `stopFailed{reason}`。控制面在 SLA（默认 30s〔设想〕）内未收到回应，把该 Assignment 的 `stopState` 置 `unresponsive` 并 P1 告警，**不得假设已停止**；其后的报告仍按 §5.3 拒收（`staleAttempt`/`leaseLost`）。

**撤销回执不受 fencing 约束（显式豁免）**：`stopped` / `stopFailed` 是**撤销回执**，不是结果写入，**不受 §5.6 的“结果写入 fencing 规则”约束**（该规则要求结果写入携带 `leaseId/token/generation` 并校验当前代次）。控制面接受它们的条件是 `(tenantId, assignmentId, attempt)` 与当前 Assignment 匹配且 `stopState ∈ {requested, unresponsive}`；**不得**因该 Assignment 的租约已 `revoked`、或 `stopDeadline` 已过而丢弃回执——撤销后仍需记账。迟到回执只更新 `stopState` 与审计（`stop.late`），不回滚已完成的撤销、不改变 Assignment 业务状态、不产生 Decision/Mandate。`attempt` 不匹配的回执不更新 `stopState`，但同样必须记为 `stop.stale`，不得静默丢弃。

**迟到结果**：撤销后到达的判定或报告一律按 §5.3 处理，拒绝原因写入 `revocation.enforced{rejectedCount, codes}`；撤销不修改判定链本身。

**可测清单（撤销后 0/1/5 秒，供 M 系列验收）**

| 时间 | 必须观察到 | 反例（视为未实现） |
| --- | --- | --- |
| 0s（事务提交点） | `revocation` 行落库；租约 `state=revoked`；`immediate` 的 Assignment 为 `cancelled` 且 stop effect 已入队；所有 Eval（含 `escalated`）为 `abandoned(revoked)` 且其 HumanTask 为 `cancelled`；`pending-policy` 不再等待窗口 | 任一租约仍 `active`；有 Eval 停在 `pending-policy`/`escalated` |
| ≤1s | 新提交一律被拒（`leaseLost`/`staleAttempt`）；不再产生该 subject 的 launch/新 Assignment effect；`revocation.enforced` 计数递增 | 仍能领取新工作或产生新 effect |
| ≤5s | 收到 `stopped` 并把 `stopState=stopped`；未收到则 SLA（≤30s）后 `unresponsive` 且告警 | 无回应但状态显示 `stopped`，或静默无告警 |

### 5.8 人工队列（HumanTask）协议

`escalated` 必须有承载它的队列，否则“转人工”只是状态名。最小契约如下，不要求 UI，CLI/API 均可实现。

**实体**：`HumanTask{taskId, tenantId, kind ∈ {assessment_escalation, approval, revocation_review}, ref{type,id}, ownerRole, ownerId?, generation, createdAt, slaDueAt, state ∈ {open, claimed, decided, expired, cancelled}, decision?, decidedBy?, decidedAt?, reason?, timeoutAction}`。`generation` 每次 `claim` +1，`decide` 必须出示当前值（防两个认领者各点一次）。

**归属与写入**：控制面唯一写入；其他角色只能提交 `claim`/`decide` 请求。`claim{ownerId, ownerRole, expectedGeneration}` 幂等键 `(tenantId, taskId, claimSeq)`；同一 `ref` 同时最多一条 `open / claimed`。

**超时动作按 kind 固定，默认不批准**：

| kind | 超时后果 | 其他决策的终态写回 |
| --- | --- | --- |
| `assessment_escalation` | `abandoned(escalation_timeout)` | `accept` → 把人工决定构造为判定消息，走 §5.3 **全链 1–8**（T5b）；6② 版本已变则 T5d 重判或 T5e 放弃；`reject` → `abandoned(human_rejected)` |
| `approval` | 视为拒绝：`HumanTask → expired`、`ApprovalRecord{decision=timeout}`、落点 Ticket `approval-rejected(timeout)`，**不签发 Mandate** | `approve` → 同事务写 `ApprovalRecord{decision=approved}`（signal）；账本在随后的评估/签发环节校验后才签发 Mandate；`reject` → `ApprovalRecord{decision=rejected}` + Ticket `approval-rejected(human_rejected)`，不签发 Mandate |
| `revocation_review` | 维持撤销（fail-closed），不恢复任何租约 | `uphold` 维持撤销；`reinstate` 只登记结论，**不自动恢复**租约与授权，须重新走准入 |

**决策入口**：`POST /human-tasks/{id}/decide{decision, reason, decidedBy, generation, evidence[], rationale}`。字段名就是 `HumanTask.generation`，**不是** `Lease.generation`，不得写成 `leaseGeneration`；`evidence[]` 的元素形状与 `AssessmentResult.evidence` **完全一致**（类型集合以 §5.3 第 5 步为唯一权威定义，本节不重复列举），`rationale` 为执行说明（可含自由文本与 `knowledge_ref`，不参与授权）。幂等键 `(tenantId, taskId, decisionSeq)`；重复提交返回首次结果。认领入口：`POST /human-tasks/{id}/claim`，需 `ownerRole` 且与 `ownerId` 匹配。

**人工 evidence 采用严格白名单（全文统一，选项 a）**：人工**不得**新造第五类证据。人的说明只能进 `rationale`；若 `rationale` 含 `knowledge_ref`，该引用必须可解析（否则 `invalid_rationale_ref`）。理由：人工“我确认过了”本身不是授权事实，把它做成 `human_attestation` 会让“谁在场”替代“依据什么”，与 §21.4“知识不授权”同理；人工的正确用法是**指出现有授权链中的一条证据**（例如某条既有 `policy_rule` 引用），而不是用身份补齐证据。`evidence` 的类型集合**只在 §5.3 第 5 步定义一次**，本节与 §10.2 只引用，不另列。

**`approval` 的创建路径（谁创建、`ref` 指向什么）**

`approval` 任务只由控制面创建，其他角色只能提交 `approval.request`：

| 入口 | 谁创建 | `ref` | 同事务动作 |
| --- | --- | --- | --- |
| 判定链第 8 步要求人工批准 | 控制面 | `{work_item, ticketId}` | 建 Ticket（`awaiting-approval`）+ `HumanTask(kind=approval, timeoutAction=approval-rejected(timeout))` + 通知 effect；**本事务不签发 Mandate** |
| 已 `accept` 的 Ticket 执行不可逆动作前 | 控制面（收到 `approval.request{tenantId, ticketId, scope, reason}`） | `{work_item, ticketId}` | Ticket `pending/running → awaiting-approval` + `HumanTask(kind=approval)`；不改 Mandate 范围 |
| 流程审批节点 | 流程适配器提交 `approval.request`，控制面创建 | `{process_task, taskId}`，并绑定 `ticketId` | 引擎侧只存 businessKey；账本 `ref` 以绑定工单为准 |

- `ref.type ∈ {work_item, process_task}`；**不指向 `assessment_result`**——判定阶段的人工介入是 `assessment_escalation`（T5/T9），不复用 `approval`。
- `ApprovalRecord{approvalId, tenantId, taskId, ref{type,id}, principalId, role, decision ∈ {approved, rejected, timeout}, approvedScope, evidenceDigest, decidedAt, signalSeq}` 与 `HumanTask.decide` **同一事务**写入，append-only；它只是 signal，**不产生 Mandate**。
- 账本签发 Mandate 的校验点：主体（`principalId` 为 `human` 且非请求人）、角色（`ownerRole` 匹配）、时间（`decidedAt ≤ slaDueAt`）、范围（`approvedScope ⊆ 请求 scope`）、职责分离（审批人 ≠ 请求人 ≠ 执行 principal，放宽须记录依据）；任一失败建 finding，不签发。
- `rejected(timeout)` / `rejected(human_rejected)` 是给请求者的**返回码**；落地实体状态是 Ticket → `approval-rejected`，`reason ∈ {timeout, human_rejected}`（终态）。通过时 Ticket 回到进入 `awaiting-approval` 之前的状态（`pending` 或 `running`），不新增状态。

**Work 平面状态增量（本节明确，其余不变）**：Ticket 新增 `awaiting-approval`（非终态）、`approval-rejected`（终态，`reason ∈ {timeout, human_rejected}`）、`cancelled`（终态，唯一生产者 `workitem.cancel`，§13.2.1）；`suspended` 为既有状态（§13.2.3 revalidate 失败）。四者只由控制面写入，前两者与 `HumanTask` / `ApprovalRecord` 同事务。

**`HumanTask` 状态转移（含 approval 路径）**

| 转移 | 触发 | 同事务写入 |
| --- | --- | --- |
| `open → claimed` | `claim`（`expectedGeneration` 匹配） | `generation+1`、`ownerId` / `ownerRole` |
| `claimed → decided` | `decide`：assessment 为 `accept` / `reject`；approval 为 `approve` / `reject` | `decision` / `decidedBy` / `decidedAt` / `reason`；assessment 触发 T5b/T5c/T5d/T5e，approval 写 `ApprovalRecord` |
| `open / claimed → expired` | `now ≥ slaDueAt` 且未决 | `timeoutAction`；approval 写 `ApprovalRecord{decision=timeout}` 并把 Ticket 落 `approval-rejected(timeout)` |
| `open / claimed → cancelled` | `revocation`（§5.7 第 4 项）或 `workitem.cancel` | 回写关联 Eval / Ticket |

**Ticket 的审批路径（approval 三条边，固定）**

| 转移 | 触发 | 结果 |
| --- | --- | --- |
| `pending → awaiting-approval`（入口 1 为直接以该状态建 Ticket） | 判定链第 8 步要求人工批准，或执行不可逆动作前收到 `approval.request` | 建/改 Ticket 状态 + `HumanTask(kind=approval)`；**不签发 Mandate** |
| `awaiting-approval → pending / running` | `ApprovalRecord{decision=approved}` 落库且账本校验（主体/角色/时间/范围/职责分离）通过 | 回到进入前的状态；若该 Ticket 尚无 Mandate（入口 1），账本在本事务签发 Mandate 并入队 launch effect |
| `awaiting-approval → approval-rejected` | `ApprovalRecord{decision=rejected}` 或 `{decision=timeout}` | 终态 `reason ∈ {human_rejected, timeout}`；不签发 Mandate |
| `pending / running / suspended / awaiting-approval → cancelled` | `workitem.cancel{tenantId, ticketId, reason, cancelledBy}`（非 `revocation`） | 终态 `cancelled`；同事务级联：关联非终态 Eval → `abandoned(cancelled)`、`open/claimed` HumanTask → `cancelled`、`active` Lease → `expired`；写审计 `workitem.cancelled` |

**与状态机的绑定（缺一即未实现）**：`escalated`（T5/T9）必须在**同一事务**内创建 `HumanTask(kind=assessment_escalation, ref={eval, evalId}, slaDueAt=now+SLA, timeoutAction=abandoned(escalation_timeout))` 并写通知 effect。`HumanTask` 进入终态时必须同事务回写触发它的 Eval/WorkItem；不允许“人工点了按钮但状态机没动”。

**`revocation_review` 的创建**：撤销时若策略要求复核，控制面在同事务创建 `HumanTask(kind=revocation_review, ref={revocation, revocationId}, timeoutAction=维持撤销)`；复核**不阻塞撤销执行**（fail-closed），超时仍维持撤销。

**可测断言**：`escalated` 后人工不处理 → 到 `slaDueAt` 自动进 `expired` 并按 `timeoutAction` 落地；SLA 内无 owner 认领必须告警（指标 `human_task_unclaimed_total`），且不得静默 `decided`。

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

Router 与控制面同进程对写路径的影响**没有基线**〔判断，无基线〕；测量方案、预注册判定口径与退路见 §10.3.1。不得用未测数字作为拆或不拆的依据。

**T0 → T1 的最小改动面（本文的核心结论之一）**：

| 改动 | 具体内容 | 不做的后果 |
| --- | --- | --- |
| 1. 队列可 claim | `Effects` 从进程内 handler 表改为 `queue + dispatcher + handler registry`，补 `leaseId/lease.expiresAt/effectAttempts` | 多进程无法共享队列；节点崩溃后行无人回收 |
| 2. 角色目标解析 | `deliver: (id) => sessions.prompt(masterId)` 改为 `RoleTarget.resolve(role)`〔原型写死：`src/app/runtime.ts:131-133`〕 | 换 Router 实现或进程必须改代码 |
| 3. 准入端口闭合 | `AssessorService` 补 `submit/cancel/heartbeat/release` 与 §5.3 校验链；`Assessor` 端口保持 `request/release`，`decide` 不进端口〔原型：`src/core/ports.ts:48-53`〕 | 外部 Assessor 无法交回判定，T1 仍只有 DSH Router 可选 |
| 4. 去掉 eager Router | 初始化不再 `await sessions.ensure(masterId)`〔原型：`src/app/runtime.ts:210`〕；无消费者时 Eval 保留 deadline | 控制面启动被 Router 绑定，Router 缺席=系统不可用 |
| 5. 节点身份 | Executor 带 `nodeId`；Assignment 带 `leaseId` + `lease.generation` | 无法判断“这个报告来自哪个节点、是否已过期” |
| 6. 权限拆分 | Router 只读 + 判定提交 token；Worker 写工作区；Watchdog 只读〔现状统一 `danger-full-access`：`src/app/sessions.ts:152`〕 | 拆了进程仍同权限，等于只是多了 IPC 开销 |

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
| fencing 代次 | 被回收的节点恢复后继续写，造成重复报告 | 每次租约回收使 `generation` 递增（§5.6）；节点写入携带 `leaseId + generation`，旧代次被拒 |
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

### D2 执行归属：只用 lease vs lease + generation

- **选项**：A. 只用租约（到期回收，不校验旧持有者）；B. 租约 + 单调递增 `generation`，写入必须带 `leaseId + generation`（§5.6）。
- **选择**：**B。**
- **理由**：只有租约时，被回收的节点恢复后仍可写回，制造重复报告（上游 §6.2 的〔推断〕）。`generation` 让“过期写入”可判定，而不是靠时间窗猜。
- **代价**：每次回收要持久化 `generation`；所有写回路径都要带 `leaseId + generation` 并校验；实现与测试面变大。
- **可回退性**：**中**。去掉代次校验需要同时接受“重复报告可被业务幂等吸收”的前提，风险不可静默接受。

### D3 策略版本：单进程内比对 vs 协议级有界处置

- **选项**：A. 沿用原型：只在 Engine 内比对并立即重排；B. 把“比对 + 有界处置”提升为协议不变量，由宿主中立的 `AssessorService` 合同与 §13.2 状态机承载；C. 比对后按新策略重新计算并接受。
- **选择**：**B。**
- **理由**：原型已经有比对〔原型：`src/core/evals.ts:284-288`〕，所以 A 不是“补比对”，而是把处置留在单进程内的隐式行为里。**判定端口只覆盖 `request/release`，`decide` 不在端口内**〔原型：`src/core/ports.ts:48-53`；`src/app/tools/main.ts:202-220`〕；跨宿主 assessor 既看不到、也无法遵守 Engine 的内部比对。裁决需要宿主中立、可替换、可单独进程隔离，因此比对与处置必须成为 `AssessorService` 合同的一部分（§5.3、§10.2）；否则换 assessor 就换掉了版本语义。C 会“用新规则解释旧证据”，审计上无法解释为什么接了。
- **代价**：策略变更会让在途评估进入窗口与重判；需要窗口、上限与观测（§13.2.2、§13.2.4）。
- **可回退性**：**中**。A 可作为 B 在单进程内的实现细节，但外部协议不退回 A；改成 C 只影响 `AssessmentResult` 校验分支。

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
- **选择**（第 2 阶段裁决）：**B，且 Journal 与 Delivery 在同一个库里分成两张物理表。**
- **理由**：同一事件要投给 Router、多个 Worker、审计、Watchdog，各自失败与重试独立（上游 §6.8）。A 隐含“一个事件一个投递位”，任一成功会被当成全部完成。C 表数量随消费者增长，迁移困难。**物理分离的额外理由**：Journal 的保留期长、只追加、重放按 `eventId`；Delivery 的保留期短、高频更新、清理按 `state` 与时间。两者归档与重放语义不同，合并会迫使清理策略互相妥协。
- **代价**：写放大（1 个事件 N 行投递）与双表事务；但量级不构成约束——按每分钟数十条事件与个位数消费者，写放大在千行/天级。
- **可回退性**：**难**。迁移回单表会丢失每消费者进度语义。

### D7 Assessor 端口：扩展现有端口 vs 另立服务

- **选项**：A. 在旧 `Assessor` 端口上加 `decide/cancel/heartbeat`（已否决）；B. 另立 `AssessorService` 协议，`Assessor` 端口降为 DSH 实现适配器；C. 让 Assessor 直接调 `Engine.decide`。
- **选择**（第 2 阶段裁决）：**B。**
- **理由**：**判定端口只覆盖 `request/release`，`decide` 不在端口内**〔原型：`src/core/ports.ts:48-53`；`src/app/tools/main.ts:202-220`〕，现有接缝无法承载“结果回写、租约、取消、身份”这些裁决语义。A 会把 DSH 的类型与 Session 生命周期泄漏进协议；C 违反“授权不可跨进程”（P2）。另立 `AssessorService` 的目的不是给旧端口补一个方法，而是让裁决宿主中立、可替换、可单独进程隔离。字段映射与语义损失见 §10.2。
- **代价**：多一层装配与序列化；`MasterAssessor` 与工具入口要经适配器；能力不支持时必须显式降级。
- **可回退性**：**中**。A 可作为 B 的内部实现细节，但外部协议保持 B。

### D8 T1 的 Router：与控制面同进程 vs 独立进程

- **选项**：A. 合并进控制面；B. 同机独立进程；C. 从 T1 起就跨机。
- **选择**（第 2 阶段裁决）：**A 为 T1 默认；B 归入 T1.5，仅在 §10.3 的触发条件满足时启用；C 不在 T1/T1.5。**
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
4. 按角色拆凭据：Router 只读 + 判定提交 token；Worker 受限写；Watchdog 只读。
5. 移除 eager Router，补“无消费者态”的健康与积压。
6. Event Journal + Delivery 表落地（含按消费者注册后补建投递行）。

**P2（异构与跨机）**

7. Router 适配器：DSH Session（现状）+ 外部 agent（HTTP/队列）。
8. Executor 适配器：`DshExecutor` 作为本地适配器 + 远程节点适配器。
9. Watchdog 作为独立只读消费者，产出 health/alert/finding。
10. 跨机租约、fencing、drain、分区策略的实测与故障注入。

每一项的验收信号沿用上游 §10 的写法，本文不重复。

### 8.3 评审裁决记录（第 2 阶段固定前提，不再讨论）

| # | 裁决 | 落点 |
| --- | --- | --- |
| 1 | Assessor 另立宿主中立的 `AssessorService` 协议；DSH `Assessor` 端口降为实现适配器 | §10.2（字段映射与语义损失） |
| 2 | T1 的 Router 默认与控制面合进程；拆出条件列为 T1.5 | §10.3（触发条件与判定信号） |
| 3 | Journal 与 Delivery 逻辑、物理都分离（同库两张表） | §7-D6、§16.1 |

这三条替代了本阶段初稿中“待裁决”的表述；后续章节以裁决为准。

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
| `policyVersion` 回写时比对，策略变更主动重排 | `src/core/evals.ts:284-288`（比对）、`:218-221`（主动重排）、`:107`（evalId 含版本） |
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
| 1 | “已投递未判定”的崩溃窗口没有主动补偿 | 上游标〔推断〕；依据是 effect 成功即删行 + deadline 兜底 | 在投递后、判定提交前强杀进程，观察是否只能等 deadline |
| 2 | `ensure` 并发幂等（同一 Eval 重试不建两个 Session） | 上游标〔推断〕 | 并发调用 `ensure`，断言只创建一个 |
| 3 | 策略变更后 Eval 的实际重排路径未运行验证 | 代码显示 `decideEval` 会比对并重排（`src/core/evals.ts:284-288`），但活跃与非活跃 Eval 两条路径的实际行为未注入验证 | 评估进行中修改规则，分别对活跃与非活跃 Eval 提交旧版本结果，断言前者重排、后者以 `unavailable` 结束 |
| 4 | `durable_inbox` 在 DSH 重启后是否保留已 accepted 输入 | 未逐项实测 | 投递后强杀、重启，检查 inbox |
| 5 | 外部副作用超时是否可安全重试 | 取决于 GitHub/Feishu API，未逐 API 验证 | 超时后查远端事实，再判断可否重放 |
| 6 | T1 同机多进程下 SQLite 的锁竞争与 WAL 行为 | 本文为设计，无实测 | 起 2–3 个进程共享一个库，压测 claim/ack |
| 7 | 网络分区下的 CP 行为（T2） | 纯设计 | 断网注入 + fencing token 校验测试 |
| 8 | Watchdog 的只读假设（不持有写连接） | 纯设计 | 用只读 DB 连接 + 权限最小化的进程验证 |

凡是本表未验证的项，本文中的相应结论都应读作**设计主张**，不是运行事实。

### 9.3 本文自身的局限

- 本文没有修改任何代码，也没有运行原型或 DSH 的测试；所有“现状”来自源码阅读。
- T1/T2 的拓扑是设计，不是实测；时延、吞吐、故障恢复时间都没有数据。
- 第 2 阶段的身份、凭据与威胁对策是设计；没有做渗透或故障注入验证。
- 上游的外部材料（ChatGPT 分享页）只被采用结构性结论；本文未引入新的外部材料。
- 身份认证协议（OIDC/SAML）仍未选型；多租户的存储分区与凭据代理只有形态，没有实现。

---

## 10. 第 2 阶段：裁决落地与新增结论

### 10.1 第 2 阶段摘要（新增硬结论）

11. **`AssessorService` 是唯一跨进程的判定协议，DSH `Assessor` 端口只保留 `request/release`，`context/read/decide` 降为适配器内部实现。** 〔原型：`src/core/ports.ts:48-53`；`src/app/tools/main.ts:202-220`〕反例形态：若把 `decide` 放回端口，协议就会带 DSH 工具语义，非 DSH assessor 无法实现。
12. **principal 与 actor 必须分两层：principal 是身份（人/服务/机器），actor 是“在某渠道上的可寻址主体”，agent 实例是“执行载体”，三者不能合并成一个 id。** 原型只有 `ActorRef`（source + id）〔原型：`src/core/model.ts:4-5`〕与 Session 身份〔原型：`src/app/sessions.ts:137-153`〕。合并会导致“agent 发的评论被人格化”或“人换了账号被当成新主体”。
13. **租户边界不能靠应用层 `tenantId` 字段，必须同时落到凭据域、存储分区与出口。** 原型没有任何 tenant 字段（全仓库源码检索无 `tenant`），单 stateDir 单实例〔原型：`src/app/runtime.ts:91-98`；`docs/007-architecture.md:151`〕。字段级隔离只能防误读，防不了越权。
14. **“agent 不接触凭据”可行的最小形态是命令 shim + 凭据代理，而不是把凭据放进环境变量。** 原型已用 `worker-bin` shim、`worker-gitconfig` 与剥离 `KEY/PASSWORD/SECRET/TOKEN` 环境变量〔原型：`docs/006-deployment.md:218-227`〕；但 shim 仍以操作者 OS 用户运行，agent 能读同用户的其他凭据〔原型：`docs/006-deployment.md:13-19`〕。
15. **策略版本变更时，判定进入 `pending-policy` 合并窗口（默认 30s），窗口关闭后按最新版本有界重判（最多 2 次）；到上限转人工 `escalated`，不静默丢弃。工单执行不中止但写 `policy-changed`，resume 前用当前版本 revalidate。** 〔设想，§13.2 状态机；`escalated` 在原型中不存在〕原型已有判定回写比对与主动重排〔原型：`src/core/evals.ts:284-288`、`:218-221`〕，但没有合并窗口、重判上限（`reassess` 无条件回队，仅超时路径有 `REQUEUES = 2`，`:19`、`:222-230`）、lease/attempt fencing〔原型：`src/core/model.ts:218-233`〕与饥饿观测。
16. **威胁模型的第一优先级不是外部攻击者，而是“不可信事件驱动已授权执行”的提示词注入；第二是跨角色伪造。** 原型的事件准入是纯函数且与模型隔离〔原型：`src/policy.ts:191-211`〕，但 worker 以 `danger-full-access` 运行〔原型：`src/app/sessions.ts:152`〕，注入一旦进入 worker，权限无上限。
17. **审计日志的最小字段集必须能重建一条“谁、以什么依据、批了什么、谁执行、结果如何”的链；仅保存 Session transcript 不足以不可否认。** Session log 是交互事实，不是业务账本〔DSH 研究：`dsh-superagent-prototype-research.md:138`〕。
18. **持久化选型的触发条件是“写者数、数据量、恢复时间”三个数字，不是“要不要上云”。** 单机 SQLite 在单写者、十万级行、分钟级恢复内成立；任一越界才换 PostgreSQL/外部队列，且必须先有 schema 版本与迁移回滚。

### 10.2 `AssessorService` 协议与 DSH 适配层

**协议面（宿主中立，不出现 DSH 类型）**

| 消息 | 方向 | 字段 | 缺失后果 |
| --- | --- | --- | --- |
| `assess.request` | 控制面 → assessor | `tenantId, evalId, threadKey, policyVersion, schemaVersion, deadline, leaseId, leaseGeneration, candidate{triggerId, facts[], rules[], limits}` | assessor 不知道判什么、按哪版策略判；无 `leaseId/leaseGeneration` 无法阻止并发判定与旧代写入 |
| `assess.read` | assessor → 控制面（或数据服务） | `tenantId, evalId, leaseId, leaseGeneration, selector{kind, id/cursor/page}, maxBytes` | 只能读候选初始窗口，无法按需取图片/文件/更多消息；跨租户读无法拒绝 |
| `assess.heartbeat` | assessor → 控制面 | `tenantId, evalId, leaseId, leaseGeneration` → `lease.expiresAt` | 长判定被误判为失联并重派，产生双判定 |
| `assess.submit` | assessor → 控制面 | §5.3 全部字段（`tenantId, evalId, leaseGeneration, leaseId, assessorId, policyVersion, outcome, completedAt, evidence`） | 无 `leaseId/leaseGeneration/policyVersion` 时旧判定可直接生效 |
| `assess.release` | 双向 | `tenantId, evalId, leaseId, leaseGeneration, reason` | 判完不释放会让租约空转到 deadline，积压 |
| `assess.cancel` | 控制面 → assessor | `tenantId, evalId, reason` | 停止工单/撤销时远端判定继续跑，浪费并在迟到时干扰 |

**DSH 适配层字段映射**

| DSH 侧 | 协议侧 | 映射方式 | 会丢的语义 |
| --- | --- | --- | --- |
| `Assessor.request(candidate)`〔`src/core/ports.ts:50`〕 | `assess.request` | 序列化 `Candidate` 的有界快照 | DSH 的 `Candidate` 含本地对象引用与窗口游标，远端只能拿快照；游标语义需降级为“按 id/页” |
| `Assessor.release(evalId)`〔`src/core/ports.ts:52`〕 | `assess.release` | 直接映射 | 无 |
| `host.assessor.context(triggerId, signal)`〔`src/app/tools/main.ts:202`〕 | `assess.read(selector=window)` | 工具名与参数转 selector | 工具的“重复调用复用窗口”缓存语义丢失；远端每次都是新读 |
| `host.assessor.read(agent, read, signal)`〔`src/app/tools/main.ts:205`〕 | `assess.read(selector)` | `agent` 不再传输，改为 `tenantId` + `evalId` + `leaseId` + `actor` | 读取权限原先依赖本地 agent 的工作区上下文；远端必须显式带 tenant/actor，否则按协议默认拒绝 |
| `host.assessor.decide(triggerId, AssessmentSchema, signal)`〔`src/app/tools/main.ts:212-216`〕 | `assess.submit` | 字段直译 + 强制补齐 `tenantId/leaseId/leaseGeneration/assessorId/policyVersion` | DSH 的 `AssessmentSchema` 允许 `audit` 任意对象；协议要求 `evidence` 可序列化且有大小上限 |
| `Agent` 句柄（`ctx.agents.get`）〔`src/app/delivery.ts:66-71`〕 | 无 | 适配器内部保存 `assessorId ↔ Agent` 映射 | 进程内对象身份校验（替换即拒绝）无法跨进程复现；远端靠 `assessorId` + 注册表 |
| 进程内抛出的错误类型 | `rejected{code}` | 适配器枚举错误码 | 堆栈与本地上下文丢失；排障需靠 `assessorId` 日志关联 |
| `signal` 取消 | `assess.cancel` + `deadline` | 两条独立路径 | 取消不是同步生效；在途工具调用可能继续 |

**适配器必须显式声明的三项能力**：`supportsRead`（能否按需取上下文）、`supportsProgress`（能否回报中间进度）、`supportsCancel`（能否真正中断）。任一为 false，控制面必须按 §5.4 的规则降级并记录，不能假装成功。

### 10.3 T1.5：Router 拆出控制面的触发条件

T1 默认合进程（§7-D8）。**只有以下任一条件被实测命中，才升级到 T1.5（同机独立 Router 进程），且必须先具备队列 claim + 租约 + `AssessorService`。**

| 触发条件 | 判定信号（可证伪） | 拆出后必须付的代价 |
| --- | --- | --- |
| Router 需要独立扩缩容 | 评估积压 P95 > 目标值，且扩容 Router 副本后积压下降；控制面 CPU 不是瓶颈 | 多 Router 需要按 Thread 分片或单写者排队，否则并发判定 |
| Router 崩溃拖垮账本写路径 | 〔判断，无基线〕先测同进程写入成功率与 p95 作为基线，再按 §10.3.1 施压；判定规则在测前登记，不得用未测数字当结论 | IPC 与进程监督；控制面要能无 Router 启动 |
| 单 Router 成为实测瓶颈 | 在目标事件速率下，单 Router 的 eval 延迟持续超过 deadline，且不是模型供应商限流 | 分片策略与 `threadKey` 亲和性；跨分片的 Thread 串行性要重新定义 |
| 资源隔离要求 | Router 内存/模型调用导致控制面 OOM 或 GC 抖动，账本写入受影响 | 内存配额与独立重启；指标要能区分两进程 |

不满足以上任一条而拆 Router，得到的是“多一次 IPC + 多一个故障域”，不产生收益。

**10.3.1 阈值 = 待测基线（测量方案，不是结论）**

本节此前给出的“成功率下降 10%、p95 翻倍”是拍的，**没有基线**，不作为架构结论〔判断，无基线〕。判定阈值必须在同一环境实测后填写。

| 项 | 方案 |
| --- | --- |
| 场景 | M1 栈（控制面 + 2 个 worker）；Router 固定在控制面进程。实验组让 Router 跑长上下文（约 50k tokens）与慢工具调用（30–60 秒）；对照组 Router 空闲但控制面执行同样的账本写入 |
| 负载档 | 目标事件速率与 2 倍目标速率两档；每档跑 3 轮，每轮 30 分钟，前 5 分钟预热丢弃；实验/对照交替执行，避免时间漂移 |
| 指标 | 控制面写入成功率、事务 p50/p95/p99、事务排队时长、Router 单轮时长、Eval 积压 oldest age、进程 CPU/内存 |
| 判定口径（预注册） | 以对照组的空闲基线为分母：`p95_loaded / p95_idle` ≥ 2.0，或写入成功率相对基线下降 ≥ 0.5 个百分点，判为不达标。阈值在测前登记，测后不得调整以迁就结果 |
| 置信要求 | 同档 3 轮结果的 p95 波动 > 30% 视为环境噪声过大，需延长到 3 小时或换独立机器复测；仍不可判别时按保守处理（视为不达标） |
| 退路 | 不达标 → **T1.5 提前触发**：Router 拆为同机独立进程（§10.3），并记录实测值；达标 → 保持合进程，但每季度复测；若后续引入更长工具调用，重新测量 |
| 数据落点 | 实测值写入 §10.3 的“判定信号”列与本表，替换“待测”；不得把预注册阈值改写成已测结论 |

---

## 11. 身份与租户

### 11.1 三层主体：principal / actor / agent instance

| 层 | 定义 | 生命周期 | 原型现状 | 合并后会坏在哪 |
| --- | --- | --- | --- | --- |
| Principal | 承担责任的主体：人、服务、机器（节点） | 长期，跨渠道 | 只有 OS 用户与 GitHub/Feishu 账号名，未建模 | 人换渠道无法对应同一责任主体；服务与机器无法区分 |
| Actor | principal 在某个渠道上的可寻址标识（`source + id`） | 与账号绑定，可变 | `ActorRef{source,id}`〔原型：`src/core/model.ts:4-5`〕 | 同一人多账号会被当成多人；bot 与人的 id 空间混用 |
| Agent instance | 执行载体：Session/进程/节点上的 agent | 短，可重启 | `orchestrator-<hash>`、`worker-<ticketId>`〔原型：`src/app/runtime.ts:104-105`；`src/executor/dsh.ts:23-26`〕 | 把 agent 当 principal 会把“模型生成的内容”当成人格声明 |

**为什么必须分三层**：授权判定依据的是 principal（“这个人有权吗”），投递与审计依据的是 actor（“回到哪个渠道”），执行与配额依据的是 agent instance（“哪个进程在跑”）。三者任一合并，都会在某条路径上产生错误语义。〔判断〕

**建议的记录形状（最小字段集）**

| 实体 | 字段 | 说明 |
| --- | --- | --- |
| `principal` | `id, kind(human/service/machine), tenantId, displayName, status(active/suspended/revoked), createdAt` | `kind` 决定它能做什么：machine 不能成为 Mandate 的 actor，service 不能“批准”人的请求 |
| `actorBinding` | `actorRef(source,id), principalId, validFrom, validTo, verifiedBy` | 账号换绑不改 principal；历史事件仍指向当时绑定 |
| `agentInstance` | `id, ownerPrincipalId, tenantId, runtime, nodeId, capabilities, startedAt` | `ownerPrincipalId` 是“谁对它负责”，不是“它代表谁” |

**事件、判定、工单上的审计主体**

| 对象 | 必带字段 | 缺失后果 |
| --- | --- | --- |
| Event | `principalId, actorRef, trustLevel, tenantId` | 无法回答“谁触发的”；跨租户无法过滤 |
| AssessmentResult | `assessorId, tenantId, policyVersion` | 判定无法归属；跨租户复用判定会串数据 |
| Decision | `tenantId, principalId（请求者）, assessorId（判定者）, policyVersion` | 追责链缺中间环节；跨租户复用判定会串数据 |
| Ticket | `tenantId, requesterPrincipalId, actorRef` | 恢复与撤销找不到人；跨租户改派 |
| Report | `tenantId, agentInstanceId, nodeId, assignmentId, attempt, leaseId, leaseGeneration` | 无法判断报告是否来自有效执行体，也无法判断是第几次执行 |

### 11.2 tenant / workspace 边界

三个概念不要混：**tenant** 是计费与安全边界；**workspace** 是数据与执行边界（仓库、目录、Thread 集合）；**channel** 是消息边界。

| 边界 | 隔离内容 | 实现位置 | 不可只靠什么 |
| --- | --- | --- | --- |
| Tenant | principal、策略、账本行、凭据、出口 | DB 分区/独立库 + 凭据代理按 tenant 解析 + 网络出口 | 只靠 `tenantId` 字段；只靠 UI 过滤 |
| Workspace | 仓库/目录、Thread、Ticket 命名空间 | 每个 workspace 独立 checkout 与锁；Thread key 带 workspace | 只靠不同目录；同 UID 下目录不是安全边界〔DSH 研究：`dsh-superagent-runtime-facts-and-enterprise-gap.md:128`〕 |
| Channel | 消息可见范围与回复去向 | Source 订阅配置 | 只靠“不订阅”防止泄露；通知仍可能带上下文 |

**跨租户禁止项（硬规则，写进协议校验而不是文档）**

1. 一个 Eval 的 `Candidate` 不得跨 tenant 取上下文；`assess.read` 必须校验 `tenantId`。
2. 一个 worker 实例不得同时承载两个 tenant 的 Assignment；复用必须销毁并重建工作区。
3. 一个 `receipt`/幂等键不得跨 tenant 复用；key 必须带 tenant 前缀。
4. 一个 Delivery 行不得把事件投递到另一 tenant 的消费者。
5. 全局允许列表（`allowed`）只能用于单 tenant 部署；多租户必须改为 `(tenantId, source, actorId)`。
6. Watchdog 的只读视图按 tenant 过滤，跨租户告警只暴露计数，不暴露内容。

**原型缺口**：全仓库无 `tenant` 字段；`allowed` 列表是全局的〔原型：`src/policy.ts:77`、`:119-125`〕；单 stateDir 单实例〔原型：`src/app/runtime.ts:91-98`〕。因此多租户不是“加字段”，而是“换存储边界 + 换凭据域”。〔判断〕

---

## 12. 授权与凭据

### 12.1 三层权限必须对齐

| 层 | 决定什么 | 原型现状 | 不一致的具体后果 |
| --- | --- | --- | --- |
| Mandate（授权域） | 这个工单允许做什么：范围、强度、来源 | 不可变记录 + resume 前 revalidate〔原型：`src/core/model.ts:125-133`；`src/core/tickets.ts:106-114`〕 | Mandate 窄而工具权限宽 = 越权；Mandate 宽而工具权限窄 = 能批不能做 |
| Agent 工具权限 | agent 能调用哪些工具、读写哪些路径 | 两个 preset 都是 `danger-full-access`〔原型：`src/app/sessions.ts:152`；`docs/006-deployment.md:13-19`〕 | 所有工单共用同一权限面，Mandate 的 scope 没有执行侧约束力 |
| OS/节点权限 | 进程能读写哪些文件、访问哪些凭据 | 操作者 OS 用户；账号 wrapper 不隔离进程〔原型：`docs/006-deployment.md:13-19`〕 | 一个 worker 能读操作者的其他凭据与无关目录 |

**对齐规则（缺一即判失败）**

1. **交集原则**：实际可执行动作 = Mandate ∩ 工具权限 ∩ OS 权限。任一层为空则拒绝启动，不“尽力而为”。
2. **最小权限按角色**：Router 只读 + 判定提交 token；Worker 写自己 workspace；Watchdog 只读；Source 只写 Trigger/游标。
3. **权限随工单而非随进程**：同一进程内的两个 Assignment 不得共享一个“宽权限”工具集；按 Assignment 派生权限面。
4. **越界即失败**：执行侧发现动作超出 Mandate 时，报告 `rejected: out_of_scope`，不继续执行。

### 12.2 凭据托管：agent 不接触凭据的四种形态

| 形态 | 做法 | agent 能否读到凭据 | 原型是否已有 | 代价 |
| --- | --- | --- | --- | --- |
| A. 命令 shim | `worker-bin` 里的 `gh`/`lark-cli` 指向 agent 专用配置；agent 只调用命令 | 否（凭据在 shim 的目标配置里） | **是**〔原型：`docs/006-deployment.md:224`〕 | shim 以同 UID 运行，agent 可绕过 shim 直接读配置文件 |
| B. 凭据代理 | 本地/远端代理持有凭据，按 `(tenant, role, scope)` 签发短时 token | 否 | 否 | 代理成为单点与高价值目标；需要 token 生命周期与撤销 |
| C. 环境变量注入 | 把 token 放进进程环境 | **是**（`env` 可读） | 原型反而剥离 `KEY/PASSWORD/SECRET/TOKEN`〔原型：`docs/006-deployment.md:218`〕 | 任何 `printenv`/日志都能泄露 |
| D. 临时挂载文件 | 只读挂载凭据文件，任务结束卸载 | 是（文件可读） | 否 | 需要 mount 生命周期与清理；容器外难做 |

**选择**：T0/T1 用 **A + 隔离 OS 用户**；T2 用 **B（节点侧代理）**，A 作为本地回退。C 禁止；D 只在容器内作为 B 的补充。〔判断〕

**最小实现要求**：token 有效期 ≤ 单次 Assignment 的最大时长；代理记录每次签发的 `assignmentId/tenantId/scope`；撤销 principal 后拒绝续签；代理不把明文写入日志。

### 12.3 worker 侧凭据下发的风险与替代

| 风险 | 触发方式 | 后果 | 替代 |
| --- | --- | --- | --- |
| 凭据进上下文 | agent 读 `env`/配置文件后写入模型上下文 | 凭据进入 Session log，随备份/导出扩散 | 代理签发短时 token，agent 只见 token；日志脱敏 |
| 跨 Assignment 复用 | 同一进程缓存 token | 一个被投毒的工单可用另一个工单的权限 | token 绑定 `assignmentId`，结束即失效 |
| 节点被攻陷 | 节点持有长期凭据 | 攻击者可长期操作仓库 | 节点只持可撤销的短期 token；控制面保留签发记录 |
| shim 绕过 | 直接调用非 shim 路径 | 权限面失效 | 隔离 OS 用户 + 文件权限；shim 目录之外不可写 |
| 凭据落到工作区 | prepare 命令或依赖写入 `.git/config` | 提交/推送泄露 | 原型已检测并拒绝 Ticket〔原型：`docs/006-deployment.md:227`〕，T2 需同样校验 |

### 12.4 撤销后的凭据状态

凭据记录与租约是两条独立失效链：租约撤销立即生效（§5.7），已签发的短时 token **无法召回**，只能靠“短 TTL + 每次调用校验”收敛。

| 对象 | `immediate` | `drain` |
| --- | --- | --- |
| 凭据记录 `CredentialGrant{tenantId, principalId, assignmentId, scope, issuedAt, expiresAt, state}` | 立即 `state=revoked`；代理拒绝续签与任何新签发 | 不新签发；已签发 token 自然到期，到期后不再续 |
| 已签发的 token | 剩余 TTL 内仍可能可用；因此 **凭证 TTL ≤ stop SLA（默认 30s，§5.7）**，且代理在每次代调用时校验 `assignmentId` 未撤销 | 同左，靠 TTL 收敛 |
| 新 Assignment | 拒绝创建（准入事务直接失败） | 拒绝创建，直到撤销解除 |

**两个数字各自约束什么（必须先对齐，否则“已撤销”仍有可用窗口）**：

| 数字 | 约束对象 | 默认 | 自洽条件 |
| --- | --- | --- | --- |
| stop SLA | 执行端从收到 `assignment.stop` 到回报 `stopped` / `stopFailed` 的时限 | 30s〔设想〕（§5.7） | — |
| 凭证 TTL | 已签发 token 在撤销后还能被代理接受的最长时间 | ≤ stop SLA（即 ≤30s，取代原“建议 ≤60s”） | 必须满足 `credentialTTL ≤ stopSLA` |
| 租约 TTL | `Lease.expiresAt` 的续租上限 | 60s（§5.6） | 与凭证 TTL 无关，不得合并成一个数字 |

`credentialTTL ≤ stopSLA` 是硬约束：若 TTL 大于 SLA，会出现“控制面已把 stopState 判为 `unresponsive` 并告警、但旧 token 仍可通过代理”的窗口。要放宽 TTL，只能同时收紧 stop SLA，或把撤销改为“代理侧同步吊销”（仅 T2 具备该能力）。

**每次代调用的校验预算与降级（fail-closed）**：代理在每次代调用前校验 `(tenantId, assignmentId, principalId)` 未被撤销，校验必须在 **≤100ms** 内返回（P99〔设想〕，硬超时 200ms）；代理订阅撤销事件并本地缓存撤销名单，缓存 TTL **≤1s**。校验超时、代理与账本失联或缓存未命中且回源失败，一律**拒绝本次调用**（`credential_check_unavailable`），**不得“先放行后补校验”**。校验不可用持续 30s 或拒绝率 >1% 时 P1 告警；恢复前该节点的所有代调用保持拒绝（fail-closed）。

**硬约束**：撤销后不得为同一 `(tenantId, principalId, assignmentId)` 签发任何新凭据；`reinstate`（§5.8）也不恢复旧凭据，须重新走准入。撤销与 `policyChanged` 的凭据处理不得复用：策略收紧不撤销任何凭据，只影响后续准入与 resume 重验。

---

## 13. 策略与协议版本一致性

### 13.1 两个版本号，不能合并

| 版本 | 含义 | 载体 | 变更频率 | 合并后的后果 |
| --- | --- | --- | --- | --- |
| `policyVersion` | 准入/规则内容版本（哪些人能请求、哪些规则生效） | Eval、Decision、Mandate | 每次策略保存 | 消息格式升级也会让在途评估全部失效 |
| `schemaVersion` | 协议消息格式版本 | 每条协议消息 | 每次协议演进 | 无法判断“旧消息能否被新消费者解析” |

原型已有 `policyVersion`（由影响授权设置的哈希计算）〔原型：`src/policy.ts:113-116`、`src/core/evals.ts:107`〕，并在判定回写时比对〔原型：`src/core/evals.ts:284-288`〕；但没有 `schemaVersion`。比对发生在单进程 Engine 内部，尚未成为协议不变量；两者都写进 §5 协议。

### 13.2 “判定迟到、策略已变”的处置流程

判定提交到达时**不在此处重复校验链**。唯一版本见 §5.3：`evalId`（幂等/去重）→ attempt/fencing → lease 有效 → deadline（控制面 `receivedAt`）→ evidence 白名单 → `policyVersion`（6① 提交版本 vs `targetPolicyVersion` + 6② 当前 `Policy.version` vs `targetPolicyVersion`）→ outcome/Mandate → 单事务写入并审计。只有**第 6 步②**返回 `policyChanged` 的提交才进入下面 13.2.1 的状态机；第 1–5、6①、7、8 步任一失败都按 §5.3 的失败码直接拒绝，不落草稿。

**两个版本字段（固定，二者不合并）**：`Eval.policyVersion` 是 Eval 创建时写入的**不可变快照**，只用于审计与漂移分析，不参与 §5.3 第 6 步；`Eval.targetPolicyVersion` 是“下一次提交必须携带的版本”，创建时等于 `policyVersion`，之后**只由控制面**在 T1a/T3/T4/T5d/T6b 推进，assessor 与人工都不可写。§5.3 第 6 步的两个比较对象都是 `targetPolicyVersion`。

**13.2.1 状态机（这是固定协议，不允许“拒绝后逐个重排”作为唯一手段）**

**Eval 的 deadline 权威（固定预算）**：`Eval.claimedAt` 只在**首次** `queued → assessing` 时写入；`Eval.deadline = claimedAt + evalTimeoutMs` 只计算一次并落库。**重判不重置 deadline，也不更新 `claimedAt`**（T6 更新 `leaseId/leaseGeneration`，不触碰这两个字段）。`Eval.deadline` 是 §5.3 第 4 步唯一比较对象，也是**所有 eval 租约 `expiresAt` 的硬上限**（签发规则见 §5.6）。重判不延长预算；预算不足以容纳下一个窗口时提前升级（T5，`budget_exhausted`）。

**`queued` 的等待上限（首次领取前没有 deadline）**：`Eval.deadline` 由 `claimedAt` 派生，而 `queued` 尚未领取，**不存在 `Eval.deadline`**，因此不能用它做 `queued` 的超时判据。`queued` 的唯一超时基准是创建时写入的 `Eval.queuedAt` 加 `queueMaxAge`（默认 = `evalTimeoutMs`，可按租户配置）；对应出口是 T7b。这条不改变 §5.3：`queued` 状态没有判定提交，第 4 步只在领取后生效。

Eval 在策略变更下的状态与转移：

**求值规则（固定，先于下表）**：同一状态的转移按优先级升序求值，**首个守卫通过者执行**，其后不评估；任何守卫都必须满足“更高优先级的同状态转移均不成立”这一隐含前提。`T8`（撤销）与 `T12`（取消）对所有非终态恒为最高两级（`T8` 高于 `T12`），因此每个非终态守卫都隐含“无未处理的 `revocation`、无未处理的 `workitem.cancel`”；表中只在多出口处重复写出这些前提。

| 状态 | 含义 | 可停留时长 | 谁写入 |
| --- | --- | --- | --- |
| `queued` | 可被 assessor 领取；未领取前**没有** `Eval.deadline` | ≤ `queuedAt + queueMaxAge`（T7b 出口） | 控制面 |
| `assessing` | 已被租约持有，判定进行中 | ≤ `lease.expiresAt` | assessor 持有，控制面监督 |
| `pending-policy` | 判定已到达、通过 §5.3 前 5 步与 6①，但 6② 判定 `policyChanged`；**等待合并窗口关闭** | ≤ min(窗口上限 30s, 剩余 deadline)；剩余预算不足 30s 时窗口在 deadline 处关闭并转 T5 | 控制面 |
| `reassess-queued` | 窗口已关闭，按最新版本重新排队一次 | ≤ deadline | 控制面 |
| `accepted` / `ignored` | 终态 | — | 控制面 |
| `escalated` | 重判上限用尽、剩余预算容不下下一窗口、evidence/rationale 二次违规，或租约丢失（`leaseLost`），转人工；**承载于 `HumanTask`（§5.8），无 `HumanTask` 视为未实现** | 直到人工处理或 SLA 超时 | 控制面（`HumanTask` 唯一写入者） |
| `abandoned` | 超时/撤销/取消，明确放弃；原因码 `policy_churn` / `queue_expired` / `cancelled` / `revoked` / `escalation_timeout` / `human_rejected`（六个，不多不少；生产者见下方清单） | 终态 | 控制面 |

| # | 转移 | 触发 | 守卫 | 动作 |
| --- | --- | --- | --- | --- |
| T1 | `queued → assessing` | assessor 领取 | 租约可用且 `Eval.targetPolicyVersion` 为当前版本；**且 `now ≤ queuedAt + queueMaxAge`（T7b 不成立）**；且 T8/T12 不成立 | **仅首次**记录 `claimedAt`，据此计算一次 `Eval.deadline`；后续重判不覆盖；记录 `leaseId/leaseGeneration`；签发租约 `expiresAt ≤ Eval.deadline` |
| T1a | `queued → queued` | 领取前（含领取尝试）发现 `Eval.targetPolicyVersion` ≠ 当前 `Policy.version` | Eval 未终态、未领取（无 `claimedAt`）；无 `active` 租约；**且 `now ≤ queuedAt + queueMaxAge`（T7b 不成立）**；且 T8/T12 不成立 | **同一事务**把 `Eval.targetPolicyVersion` 写为当前版本并留在 `queued`；**不签发租约、不写 `claimedAt`/`deadline`、不计重判次数**；重复发生按同规则刷新，直到 T1 守卫通过或 T7b 到期 |
| T2 | `assessing → pending-policy` | 判定提交通过 §5.3 第 1–5 步与第 6 步①，但第 6 步②返回 `policyChanged` | 前 5 步与 6① 全部通过（含 evidence 白名单与 `receivedAt ≤ deadline`）；**且 T9 不成立**（同一 `leaseGeneration` 未发生第二次 evidence/rationale 违规）；且 T8/T12 不成立 | 控制面**同事务强制** `release`（`state=released`）；`expiresAt` 自然过期只作恢复扫描兜底；暂存“候选判定”（不是 Decision） |
| T3 | `pending-policy → pending-policy` | 窗口内又有新策略版本 | 同一 Eval 只保留最新版本；**窗口未关闭（T4 的关闭条件不成立）**；且 T8/T12 不成立 | 同一事务把 `Eval.targetPolicyVersion` 写为最新版本（草稿元数据随之为新目标）；不新增重判次数 |
| T4 | `pending-policy → reassess-queued` | 窗口关闭 | 未达重判上限（默认 2 次）；**该 Eval 无 `active` 租约**（见下方规则）；`now + window ≤ deadline`（**即 T5 不成立**）；窗口已关闭（**T3 不成立**）；且 T8/T12 不成立 | **同一事务原子完成三件事**：写回 `Eval.targetPolicyVersion = 窗口关闭时的最新版本`、转 `reassess-queued`、写重判幂等键与 effects；不得只转状态而不写回版本 |
| T4b | `pending-policy → escalated` | 等待路径中租约到期后重触发 T4，租约仍 `active` 且 `now ≤ Eval.deadline` | 已等待至 `expiresAt`；重触发时租约未进入 `expired`；**且 `now + window ≤ Eval.deadline` 且未达重判上限（T5 不成立）**；且 T8/T12 不成立 | 租约置 `expired`；**同一事务**创建 `HumanTask(kind=assessment_escalation, timeoutAction=abandoned(escalation_timeout))`；原因码 **`leaseLost`**；写 finding 并通知“租约失去后无法恢复评估” |
| T5 | `pending-policy → escalated` | 窗口关闭 | 已达重判上限，或 `now + window > deadline`；**且无崩溃残留的 `active` 租约（T4b 不成立）**；窗口已关闭（**T4 不成立**）；且 T8/T12 不成立 | **同一事务**创建 `HumanTask(kind=assessment_escalation, ref={eval, evalId}, timeoutAction=abandoned(escalation_timeout))`、写通知 effect、生成 finding；原因码按顺序取第一个命中：① `budget_exhausted`（`now + window > deadline`，即使允许重判也来不及）；② `reassess_cap`（预算够但已达上限） |
| T5b | `escalated → accepted`（经 T10 写入） | `HumanTask` 决定 `accept`（`kind=assessment_escalation`） | 任务 `claimed` 且 `HumanTask.generation` 匹配；决策幂等；**人工 accept 必须先被构造为一条判定消息**，并通过 §5.3 **全链 1–8**（不得只走第 8 步）；进入前必须通过“无 `active` 租约”前置检查；**且 T5c 的 `slaDueAt` 已过/已 `expired` 条件不成立**；且 T8/T12 不成立 | **同一事务**：① 断言 `(tenantId, scope='eval', subjectId=evalId)` 无 `active` 租约；若有，先置 `expired` 并写审计 `lease.orphan_reclaimed`（**全文唯一允许“先清后签”的路径**）；② 以 `assessorId=human:{principalId}` 签发本次提交专用的 `scope=eval` 租约（`Lease.generation` 递增 1，`expiresAt = min(now+ttl, Eval.deadline)`，与 `HumanTask.generation` 无关）；③ 用人工提供的 `evidence[]`（类型见 §5.3 第 5 步）与 `rationale`、`policyVersion=Eval.targetPolicyVersion` 组成 `AssessmentResult`；④ 逐项执行 §5.3 第 1–8 步（第 4 步用控制面 `receivedAt`，第 5 步白名单不因“人工批准”豁免）；⑤ **在该提交的所有出口同事务释放专用租约**：`accepted`、6② 失败（T5d/T5e）、evidence 拒绝、`late`；**任何出口都不得留 `active` 租约**；⑥ 仅 1–8 全部通过才 `HumanTask → decided`，并在**同一事务转交 T10**执行 `accepted` 写入与 Decision/Mandate 落库——**T5b 不自行写 `accepted`，`accepted` 的唯一写入者是 T10**；Decision 同时携带 `policyVersion` 与 `targetPolicyVersion`（此刻二者相等）。任一步失败按对应失败码拒绝，不写 Decision |
| T5c | `escalated → abandoned` | `HumanTask` 决定 `reject`，或任务 `expired` | 任务 `claimed` 且 `HumanTask.generation` 匹配；决策幂等；`reject` 不进入判定链（它不产生判定）；且 T8/T12 不成立 | **同一事务**：`HumanTask → decided/expired`、Eval 终态 `abandoned(human_rejected)` 或 `abandoned(escalation_timeout)` |
| T5d | `escalated → reassess-queued` | 人工 `accept` 通过 §5.3 第 1–5 步与 6①，但 6② 返回 `policyChanged` | `reassessCount < 2`；`now + window ≤ Eval.deadline`；无 `active` 租约（**即 T5e 不成立**）；且 T8/T12 不成立 | **同一事务**：`HumanTask → decided(reason=policyChanged)`（人工决定只作审计事实，**不转成新版本下的 Decision**）、写回 `Eval.targetPolicyVersion = 当前 Policy.version`、`reassessCount+1`、转 `reassess-queued` 并写重判幂等键；随后按 T6/T6b/T7 走完；人工 evidence 不自动复用，重判必须重新取证 |
| T5e | `escalated → abandoned` | 人工 `accept` 通过 §5.3 第 1–5 步与 6①，但 6② 返回 `policyChanged` | `reassessCount ≥ 2` 或 `now + window > Eval.deadline`（预算不足以重判，**即 T5d 不成立**）；且 T8/T12 不成立 | 终态 **`abandoned(policy_churn)`**；`HumanTask → decided(reason=policyChanged)`；**不签发 Mandate、不写 Decision**；同事务写 finding 并通知“人工批准因目标版本过期被拒” |
| T6 | `reassess-queued → assessing` | assessor 再次领取 | **优先级从高到低**：① `now ≤ Eval.deadline`（否则转 T7，不回 `pending-policy`）；② 该 Eval 无 `active` 租约；③ `Eval.targetPolicyVersion` = 当前 `Policy.version`（不一致走 T6b）；**即 T7、T6b 均不成立**；且 T8/T12 不成立 | 新 `leaseId` + `leaseGeneration+1`；**不重算 deadline、不更新 `claimedAt`**；签发租约 `expiresAt ≤ Eval.deadline` |
| T6b | `reassess-queued → reassess-queued` | 领取时版本已变 | `now ≤ Eval.deadline`（deadline 优先：已过则走 T7，**即 T7 不成立**）；无 `active` 租约；`Eval.targetPolicyVersion` ≠ 当前 `Policy.version`（**即 T6 不成立**）；且 T8/T12 不成立 | 不签发租约；同事务把 `Eval.targetPolicyVersion` 写为当前版本，留在队列等下一次领取；**不计重判次数**（未发生评估） |
| T7 | `reassess-queued → abandoned` | 超过 `Eval.deadline` | 无 `active` 租约（终态不变量，见下方）；**本状态最高优先级（T6b/T6 不再评估）**；且 T8/T12 不成立 | 通知请求者，原因码 `policy_churn`（撤销不走本行，见 T8） |
| T7b | `queued → abandoned` | `now > queuedAt + queueMaxAge` | 该 Eval 从未领取（无 `claimedAt`，因此没有 `Eval.deadline`）；无 `active` 租约（若有，按终态不变量同事务置 `expired` 并记 `lease.orphan_reclaimed`，**不签新租约**）；且 T8/T12 不成立 | 终态 **`abandoned(queue_expired)`**；不签发租约、不写 `claimedAt`；写 finding 并通知请求者“排队期间未取得与当前策略一致的判定” |
| T8 | 任意非终态 → `abandoned` | 收到 `revocation`（§5.7） | 撤销已落库且 `subject` 匹配 | 终态原因码 **`revoked`**；租约置 `revoked`（不是 `released`，不得等 `expiresAt`）；级联停止 Assignment；写 `revocation` 与 `revocation.enforced` 审计 |
| T9 | `assessing → escalated` | 同一 `leaseGeneration` 第二次 evidence/rationale 违规 | 第一次更正已用尽（§21.4.1）；且 T8/T12 不成立 | 释放租约；**同一事务**创建 `HumanTask(kind=assessment_escalation, ref={eval, evalId}, timeoutAction=abandoned(escalation_timeout))`；原因码 `unauthorized_evidence` 或 `invalid_rationale_ref`（与 §5.3 失败列一致） |
| T10 | `assessing → accepted` | 判定提交 `outcome=accept` 且 §5.3 1–8 全部通过（**含 T5b 转交的人工判定**） | 第 4 步未晚、第 5 步合规、6①② 均通过、第 7 步 outcome/Mandate 一致；**且 T9、T2 不成立**；且 T8/T12 不成立 | 写 Decision + Mandate + Ticket + 首 Assignment + effects + audit（§5.3 第 8 步）；释放提交租约 |
| T11 | `assessing → ignored` | 提交 `outcome ∈ {ignore, stop}`，或命中 `prior_decision` 且无需新建工作；`unavailable` 走报告通道 | `ignore` / `stop` / `prior_decision` 走提交，第 1–5 步须通过；`unavailable` 无 evidence 要求（报告通道只校验第 1–3 步与终态不变量）；均不写 Ticket/Mandate；**且 T9、T2 不成立**；且 T8/T12 不成立 | 释放提交租约（若有）；写 `assessment.ignored` 审计（`reason ∈ {ignore, unavailable, stop, prior_decision}`）；**不产生 Decision、不签发 Mandate** |
| T12 | 任意非终态 → `abandoned` | 收到 `workitem.cancel{tenantId, ticketId, reason, cancelledBy}`（人/请求者取消，**不是** `revocation`） | 取消消息已落库且 `subject` 匹配；**优先级仅次于 T8（T8 不成立）** | 终态原因码 **`cancelled`**；租约置 `expired`（不得等 `expiresAt`；取消不是撤销，故不用 `revoked`）；**同一事务**：Ticket → `cancelled`、其关联非终态 Eval → `abandoned(cancelled)`、其 `open/claimed` HumanTask → `cancelled`；写 `workitem.cancelled` 审计 |

**`outcome` 到落点（无悬挂取值）**

| `outcome` | 落点状态 | 原因码 / 审计 | 说明 |
| --- | --- | --- | --- |
| `accept` | `accepted`（T10） | — | 走 §5.3 第 7–8 步签发 |
| `ignore` | `ignored`（T11） | `reason=ignore` | 判定为不需工作 |
| `unavailable` | `ignored`（T11） | `reason=unavailable` | 判不了不等于失败；不重试到死，留审计供人工重放 |
| `stop` | `ignored`（T11） | `reason=stop` | 建议停止该线程；真正取消由请求者发 `workitem.cancel`（§13.2.1） |
| 命中 `prior_decision` | `ignored`（T11） | `reason=prior_decision` | 同一事实已有决定，幂等收敛 |

`unavailable` / `stop` 不进 `abandoned`：它们没有失败原因码可归，且 `abandoned` 的六个原因码已被 R5 收口；把它们落到 `ignored` 并带 `reason` 可保持原因码集合不变，同时让每个 `outcome` 都有唯一落点。

**T10/T11 的失败语义**：T10 的 Decision/Mandate/Ticket/Assignment/effect/audit 任一写入失败，**整事务回滚**，Eval 留在 `assessing`（租约仍在，可重试），不得出现“有工单无授权”；T11 的状态与 `assessment.ignored` 审计同样同事务，审计写失败即回滚，不得只改状态。

**撤销优先于策略抖动（固定）**：`revocation` 命中时直接 T8 到终态 `abandoned(revoked)`，不得先进 `pending-policy`，也不得用 `policy_churn`/`policyChanged` 充当撤销原因码；反过来，策略变更不得调用 T8。`workitem.cancel` 只走 T12（`cancelled`），与 T8（`revoked`）互不替代。撤销评审（`revocation_review`）是独立的 `HumanTask.kind`，不复用 `escalated` 的重判语义。

**人工批准不能替代白名单校验（固定）**：由 T9 进入 `escalated` 的 Eval，人工 `accept` 同样要过 §5.3 第 5 步。人工只能提供 **§5.3 第 5 步白名单内的新 evidence 引用**或给出更正后的消息；若仍不合格，accept 返回 `rejected: unauthorized_evidence`（`rationale.knowledge_ref` 不可解析时为 `rejected: invalid_rationale_ref`），**不写 Decision、不签发 Mandate**，Eval 保持 `escalated`、`HumanTask` 回 `claimed` 允许再次提交。该次提交按 T9 的口径计入该 Eval 的 evidence 违规计数：第二次起写 finding 并 P1 告警，不再视为“可更正的一次”。`HumanTask.decision` 只记录“人点了接受”，不构成授权事实。

**原因码生产者清单（与状态表一致，六个）**：

| 原因码 | 生产者（可能多个，逐一列明） | 说明 |
| --- | --- | --- |
| `policy_churn` | T5e（人工 accept 因版本过期且无预算）、T7（`reassess-queued` 超 deadline） | 策略版本变化导致无法取得与当前版本一致的判定 |
| `queue_expired` | T7b（`queued` 超过 `queuedAt + queueMaxAge`） | 首次领取前就长期未取得判定；不含策略变更语义 |
| `cancelled` | **T12**（控制面收到 `workitem.cancel{tenantId, ticketId, reason, cancelledBy}`；人/请求者取消，**不是** `revocation`） | 同事务：Ticket → `cancelled`、其关联非终态 Eval → `abandoned(cancelled)`、其 `open/claimed` HumanTask → `cancelled`。除该消息外任何路径不得写此码 |
| `revoked` | T8（§5.7 `revocation`） | 撤销 |
| `escalation_timeout` | T5c（`HumanTask` 超 `slaDueAt` 未决） | 人工未处理 |
| `human_rejected` | T5c（人工 `reject`） | 人工明确拒绝 |

`escalated` 的原因码另成一组，不混入上表：`budget_exhausted` / `reassess_cap`（T5）、`unauthorized_evidence` / `invalid_rationale_ref`（T9）、`leaseLost`（T4b）。`abandoned` 与 `escalated` 的原因码互不串用；`escalated` 之后只能经 T5b/T5c/T5d/T5e 离开。

**“首次领取前即发生策略变更”的完整路径**（不留悬空节点）：Eval 建于 v0 → 策略变为 v1，assessor 尝试领取 → T1 守卫失败 → **T1a** 同事务把 `target` 刷为 v1，留在 `queued`，不签租约、不计重判 → 若在 v2、v3 再次发生，重复 T1a → 版本稳定后下次领取走 T1（首次写 `claimedAt`/`deadline`）→ 正常判定。若版本一直变化到 `queuedAt + queueMaxAge`，走 **T7b** `abandoned(queue_expired)`。该路径不进入 `pending-policy`、不消耗重判次数、不产生 `HumanTask`。

**租约唯一性检查与等待路径（固定规则）**：T4/T6 入口必须先断言该 `(tenantId, scope='eval', subjectId=evalId)` 无 `active` 租约；有则拒绝转移并写 finding。**T5b 是唯一例外**：人工 `accept` 作为新判定提交前，若发现崩溃变体留下的孤儿 `active` 租约，控制面在**同一事务**把它置 `expired`（统一用 `expired`，不用 `revoked`）并写审计 `lease.orphan_reclaimed`，然后签发新的专用租约；除此之外，任何入口都不得“先清后签”。窗口关闭时若仍有 `active` 租约（T2 的同步释放因控制面崩溃未执行），按 `expiresAt` 与 `Eval.deadline` 的比较分两种路径：

- `lease.expiresAt ≥ Eval.deadline` → **直接 T5 `escalated(budget_exhausted)`**。等待本身就会耗尽预算，没有余额重跑窗口；**不得**落到 `leaseLost`，也不得等到 deadline 再报超时。
- `lease.expiresAt < Eval.deadline` → **等待至 `expiresAt`**，由控制面恢复扫描把状态置 `expired` 并**重触发 T4 一次**；重触发时仍为 `active` 且 deadline 未过 → **T4b** `escalated(leaseLost)`；若等待期间已跨 deadline，按上一条改走 `budget_exhausted`。

不立即改派，避免双判定。**统一失效顺序**：`Eval.deadline` 是硬上限 > `lease.expiresAt` > 合并窗口；三者同时到期时以 deadline 为准（`budget_exhausted`），不存在“租约先失效算 `leaseLost`、预算先耗尽算超时”的第二套解释。

**终态不得留 `active` 租约（不变量）**：写入 `accepted` / `ignored` / `abandoned` 的同一事务必须先断言该 Eval 无 `active` 租约（T8 例外：置 `revoked`；T12 例外：置 `expired`）。T5b 的专用租约在 `accepted`、T5d/T5e、evidence 拒绝、`late` 四个出口都同事务释放；T9 在升级同事务释放；T10/T11 在写终态同事务释放。恢复扫描对“终态 + active”的行只做一件事：置 `expired` 并写 `lease.orphan_reclaimed`，不得复活判定。

**`pending-policy` 草稿的边界**：草稿只保存通过 §5.3 第 1–5 步与第 6 步①（快照未被篡改）的提交，供观测与审计；窗口关闭后必须按 §5.3 全链重新提交/重判，**不得把草稿直接提升为 Decision**。这样即使候选判定在等待期间被篡改或补充，也会在重跑时被第 5 步拒绝。evidence/rationale 被拒的提交**不落草稿**、**不消耗重判次数**（§21.4.1）。

**13.2.2 合并窗口与重判上限**

**合并窗口（coalescing window）**：策略版本变更后，所有版本不匹配的判定进入 `pending-policy`，窗口内到达的多次变更合并为“最新版本一次”。

- **建议窗口：30 秒**〔判断，无实测基线〕。依据：原型 effect pass 周期为 2 秒〔原型：`src/app/effects.ts:83-88`〕，30 秒 ≥ 15 个 pass 周期，足以覆盖一次人工连续保存；同时必须远小于 Eval deadline（由 `settings.eval.timeoutSeconds` 决定〔原型：`src/policy.ts:190`〕），否则判定会被窗口拖到超时。
- **代价**：每次策略变更最多增加 30 秒判定延迟；若策略由机器高频同步，窗口无法合并，只会把饥饿从“评审前”推迟到“评审后”，因此必须配合 §13.2.4 的观测与降频。

**重判上限**：每个 Eval 最多 **2 次**重判〔判断〕。依据：第 1 次吸收单次策略变更，第 2 次吸收“重判期间又发生一次变更”；第 3 次起的原因已不是单个 Eval，而是策略抖动，继续重判只会放大成本。

- **到上限后的责任与用户可见结果**：控制面负责把 Eval 置为 `escalated`、写 finding、通知请求者“工作未自动处理：策略频繁变更，需人工确认”；请求者在面板看到 `escalated` 与原因码，可手动接受（**走 T5b 全链 1–8，不是直接生效**）、忽略或关闭。**不允许静默 `ignore`**。
- **成本**：最坏情况每个 Eval 多 2 次模型调用；转人工意味着工作延迟从秒级变为人工响应级。

**出口优先级（唯一排序；画图与实现都以本表为准）**

| 状态 | 优先级（高 → 低） | 说明 |
| --- | --- | --- |
| 任意非终态 | **⓪ T8 撤销** | 撤销优先于一切，包括人工决策；T8 落库后不再执行任何 T12/T5x |
| 任意非终态 | **① T12 取消** | `workitem.cancel` 仅次于撤销；T12 落库后不再执行该状态的任何本地转移 |
| `queued` | ② T7b（`now > queuedAt + queueMaxAge`）→ ③ T1a（版本刷新）→ ④ T1（领取） | 先判排队超时，再判版本，最后才领取；T7b 命中后不再走 T1a/T1 |
| `assessing` | ② T9（二次违规）→ ③ T2（6② `policyChanged`）→ ④ T10（accept）/T11（ignore） | 第 5 步先于第 6 步，因此 T9 先于 T2；提交未通过前不写终态 |
| `pending-policy` | ② T3（窗口内新版本）→ ③ T4（窗口关闭重判）→ ④ T5（预算/上限）或 T4b（租约丢失） | T5 与 T4b 互斥：预算不足或达上限走 T5；租约仍 `active` 走 T4b（见上方租约等待路径） |
| `reassess-queued` | ② T7（超 `Eval.deadline`）→ ③ T6b（版本刷新）→ ④ T6（领取） | deadline 优先，版本次之，领取最后 |
| `escalated` | ② T5c（`slaDueAt` 已过 / 已 `expired`）→ ③ T5b（accept）或 T5c（reject）→ ④ T5d/T5e（accept 的 6② 分支） | SLA 先于人工决策：人工不能在 `expired` 之后再说接受；T5d/T5e 只在 accept 通过 1–5 与 6① 后才可达 |

**「状态 × 出口」矩阵**（行=状态，列=转移；**本表由 §13.2.1 按（状态，优先级）生成，如有冲突以转移表为准**；⓪ 全局最高，①→④ 数字越小越先；`—` 表示非法出口）

| 状态 \ 出口 | T8 撤销 | T12 取消 | T7b 排队超时 | T1a 版本刷新 | T1 领取 | T9 二次违规 | T2 版本变更 | T10 accept | T11 ignore | T3 窗口内变更 | T4 窗口关闭 | T4b 租约丢失 | T5 升级 | T5b 人工 accept | T5c 人工拒绝/超时 | T5d 重判 | T5e 放弃 | T6 重判领取 | T6b 重判刷新 | T7 重判超时 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `queued` | ⓪ | ① | ② | ③ | ④ | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — |
| `assessing` | ⓪ | ① | — | — | — | ② | ③ | ④ | ④ | — | — | — | — | — | — | — | — | — | — | — |
| `pending-policy` | ⓪ | ① | — | — | — | — | — | — | — | ② | ③ | ④ | ④ | — | — | — | — | — | — | — |
| `reassess-queued` | ⓪ | ① | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | ④ | ③ | ② |
| `escalated` | ⓪ | ① | — | — | — | — | — | — | — | — | — | — | — | ③ | ② / ③ | ④ | ④ | — | — | — |
| `accepted` | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — |
| `ignored` | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — |
| `abandoned` | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — |

矩阵自洽断言（可直接转成测试）：`accepted` 的唯一写入者是 T10（`assessing → accepted` 记 T10；`escalated → accepted` 记 T5b 但由 T10 在同一事务写入），`ignored` 只有 T11 入边，`abandoned` 有 T5c / T5e / T7 / T7b / T8 / T12 入边（六个）；每个非终态至少有一条出边；`escalated` 的 T5c 以 `expired` 优先于 T5b；`queued` 的 T7b 优先于 T1；T8 ⓪ 高于 T12 ①，T12 高于各状态本地 ②→④。

**13.2.3 幂等、去重与工单关系**

**幂等与去重**：

| 对象 | 键 | 规则 | 缺失后果 |
| --- | --- | --- | --- |
| 重判请求 | `reassess:{tenantId}:{evalId}:{policyVersion}`（唯一约束；版本段取 `Eval.targetPolicyVersion`） | 同一 Eval 对同一目标版本最多重判一次 | 同一版本反复入队，饥饿无法收敛 |
| 判定提交 | `(tenantId, evalId, leaseGeneration)` | 重试不产生新判定 | 迟到代次覆盖新代次 |
| 策略变更合并 | `(tenantId, policyChangeSeq)`（单调递增）+ 窗口截止时间 | 窗口内多次变更只取最大 `seq` | 每次保存都触发一轮重判 |
| 工单标记 | `policy-changed:{tenantId}:{ticketId}:{policyVersion}` | 每工单每版本最多一条 Input | 同一变更反复写 Input，worker 重复处理 |

**时间预算推演（测试对照：`evalTimeoutMs=120s`、合并窗口 `30s`、策略变更 `t=0/35/70`）**

假设：`ttl=60s`（§5.6 默认）、变更 #1/#2/#3 在 t=0/35/70 各产生新版本 v1/v2/v3。

| 时刻 | 事件 | 版本 / 租约 | 守卫 | 结果 |
| --- | --- | --- | --- | --- |
| t=0 | 首次领取：`claimedAt=0`、`deadline=120`；领取后发生变更 #1 | `target=v0`；租约 `expiresAt=min(0+60,120)=60` | T1 领取时 target=当前 v0 | `assessing` |
| t≈0 | 交回 v0：1–5 与 6① 通过，6② 当前 v1 ≠ target v0 | 同事务 `release` | — | T2 → `pending-policy` |
| t=30 | 窗口关闭 | T4 **写回 `target=v1`**；T6 签发租约 `expiresAt=min(30+60,120)=90` | `30+30=60 ≤ 120` | T4 → `reassess-queued` → T6 领取（第 1 次重判） |
| t=35 | 变更 #2；交回 v1（t≈30 下发） | 6① 提交 v1 = target v1 通过；6② 当前 v2 ≠ target v1 | 35 < 90，租约未过期 | T2 → `pending-policy`，同步释放租约 |
| t=65 | 窗口关闭 | T4 **写回 `target=v2`**；T6 签发租约 `expiresAt=min(65+60,120)=120`（被 deadline 截断） | `65+30=95 ≤ 120` | T4 → `reassess-queued` → T6 领取（第 2 次重判） |
| t=70 | 变更 #3；交回 v2 | 6① 通过；6② 当前 v3 ≠ target v2 | 租约未过期 | T2 → `pending-policy`，同步释放租约 |
| t=100 | 窗口关闭 | `target=v2`（T3 未触发，T4 未执行）；无 `active` 租约 | `100+30=130 > 120` | T5 → `escalated(budget_exhausted)`，同事务创建 `HumanTask(assessment_escalation)`；**不产生第 3 次重判** |
| t=120 | `deadline` 到期 | — | — | 已为终态，不再变化 |

**t=65 租约的处理**：`expiresAt` 被截断到 120，与 deadline 相同；t=70 的 T2 同步释放使其提前结束，因此 t=100 没有 `active` 租约，直接走 T4 守卫失败分支。**崩溃变体**：若 t=70 的同步释放未执行，t=100 时租约仍 `active` 且 `expiresAt=120 ≥ deadline=120`，按 §13.2.1 等待路径**直接 T5 `escalated(budget_exhausted)`**，不等到 t=120，也不报 `leaseLost`。**T6b 变体**：若变更 #2 发生在 t=31（T4 之后、领取之前），T6b 把 `target` 写回 v2 并留在队列，不计重判次数，t=35 不会出现版本不匹配。

要点：T4 只写 `targetPolicyVersion`，T6 只换 `leaseId/leaseGeneration`；`deadline` 始终是 120、`claimedAt` 始终是 0；第 3 个窗口关闭时剩余预算只有 20s，容不下 30s 窗口，因此提前升级而不是拖到 t=120 的 `late`/`abandoned`。测试可断言：t=30、t=65 产生 `reassess-queued`（target 分别为 v1、v2），t=100 产生 `escalated(budget_exhausted)` 且重判计数停在 2。

**反例行：t=100 的人工 accept 不能绕过 6②（固定文本）**

前提沿用上表：`deadline=120`、`target=v2`、变更 #3 使当前版本为 v3；人工在 t=100（`HumanTask` 已在 t=100 创建并被认领）点击 `accept`。

| 时刻 | 事件 | 版本 / 预算 | §5.3 判定链 | 结果 |
| --- | --- | --- | --- | --- |
| t=100 | 人工 `accept`（`HumanTask.generation` 匹配） | `target=v2`；当前 `v3`；`deadline=120`；`reassessCount=2` | 构造 `AssessmentResult{policyVersion=v2, evidence=[source_event 或 policy_rule 的合法引用], rationale="人工说明", assessorId=human:*}`（人工说明只进 `rationale`，不新增证据类型）并签发本次专用 eval 租约；第 1–5 步通过、6① 通过、**6② 当前 v3 ≠ target v2 → `policyChanged`**；租约在本出口同事务释放 | 不得进入 `accepted`；交 T5d/T5e 守卫 |
| t=100（同一事务） | T5e | `100+30=130 > 120`，且已达重判上限 | — | Eval → **`abandoned(policy_churn)`**；`HumanTask → decided(reason=policyChanged)`；**不写 Decision、不签发 Mandate**；无 `active` 租约残留；finding：`human_accept_rejected{code=policyChanged}` |

**最终口径**：t=100 人工 accept（target=v2、当前=v3）→ **放弃** `abandoned(policy_churn)`（T5e：6② `policyChanged` 且 `100+30 > deadline=120`、`reassessCount=2`）。若把场景改为 **`deadline=180` 且 `reassessCount=1`**（只发生过一次窗口变更），则 `100+30=130 ≤ 180` 且未达上限，走 **T5d 重判**（`reassessCount+1`、写回 `target=v3`、`HumanTask → decided(reason=policyChanged)`）；不会出现“直接接受”。原 `deadline=180` 但 `reassessCount=2` 的写法与 T5d 守卫冲突，已以此替换。三选一里不选 `escalated`，因为 Eval 已在 `escalated`，再升级没有新承载对象。

**与工单的关系（固定）**：
1. 已 `accept` 的工单**不因策略变更中止**；只写 `policy-changed` 标记（每工单每版本一条）。
2. **resume 前 revalidate 使用“resume 当时的当前策略版本”**，不是工单创建时的版本；工单上的原 `policyVersion` 只用于审计。
3. revalidate 失败：工单置为 `suspended`（不 resume），通知请求者与 Watchdog；不自动降级、不自动改范围。
4. revalidate 通过：记录 `revalidatedAt` 与 `revalidatedPolicyVersion`，再 resume。
5. 推断候选（`strength=inferred`）在策略变更后不重判，直接丢弃；明确请求（`explicit`）走上面的工单路径。

**13.2.4 饥饿的量化判据与系统动作**

| 指标 | 定义 | 触发线 | 触发后动作 |
| --- | --- | --- | --- |
| `eval_pending_policy_age` | `pending-policy` 状态停留时长 | — | 面板与 Watchdog 的 P3 指标 |
| `eval_pending_policy_share` | 停留超过 15 个 pass 周期（约 30 秒）的 Eval 占在途 Eval 比例 | 连续 3 个 1 分钟窗口 > 5% | 窗口从 30s 扩到 60s（仅一次） |
| `eval_reassess_exhausted_total` | 达到重判上限的 Eval 数 | 任一 Eval 命中即计数 | 立即 P1 告警 + 生成 finding |
| `eval_queue_expired_total` | `queued` 超过 `queuedAt + queueMaxAge` 转 T7b 的 Eval 数 | 任一命中即计数 | P2 告警 + finding；连续 3 个窗口非 0 → 检查 assessor 容量与策略变更频率 |
| `policy_save_rate` | 策略保存次数/分钟 | > 1 次/分钟持续 5 分钟 | 暂停自动策略同步，要求人工确认；记录 `policy_churn` |

触发后的顺序：**先扩窗口（只允许一次到 60s）→ 再降频（暂停自动同步）→ 最后转人工**。不得用“继续重判”作为缓解手段。

**明确禁止**：“拒绝并重判”不能作为唯一手段。必须同时具备**窗口、上限、观测**三件事；缺任一项，实现视为不符合本协议。

**为什么拒绝而不是“按新策略重算后接受”**：重算无法改变 assessor 已看到的证据与推理轨迹；接受会让审计链出现“用旧证据得出新规则下的结论”。窗口 + 有界重判的作用是让“证据与版本一致”的成本可控，而不是允许无限重来。〔判断〕

### 13.3 协议版本协商与降级矩阵

**协商规则**：每条消息带 `schemaVersion`；消费者声明 `accepts: [v3, v2]`；发送方选最高共同版本；无共同版本返回 `rejected: unsupportedVersion`，不得“尽力解析”。

| 不兼容场景 | 降级动作 | 可接受 | 不可接受 |
| --- | --- | --- | --- |
| 生产者 v3，消费者仅 v2，且 v3 只是新增可选字段 | 消费者按 v2 解析，忽略新增字段 | 可（有版本标记） | 把新增的必填语义当默认值 |
| v3 改变了字段语义（如 `outcome` 新增枚举） | 拒绝，返回 `unsupportedVersion` | 拒绝后再升级消费者 | 把未知枚举映射成 `ignore` |
| 消费者支持 v3，生产者仅 v2 | 接受 v2，并在结果中标注 `degradedFrom=v3` | 可 | 假设 v2 字段等价 v3 |
| 能力不支持的投递语义（§5.4） | 显式降级并记 `lastError`，策略层选择替代 | 可 | 静默改成 `followup` |

**三个必须记录的事实**：`schemaVersion` 的协商结果、`degradedFrom`、降级原因。没有这三项，排障时无法区分“按旧协议正常工作”与“能力缺失被掩盖”。〔判断〕

---

## 14. 安全威胁模型

排序依据：**能直接导致“未授权动作被执行”的排在前面**，不是按攻击者来源内外排序。〔判断〕

### 14.1 六类威胁

| # | 威胁 | 现有原型的缺口 | 架构对策 | 残余风险 |
| --- | --- | --- | --- | --- |
| S1 | 提示词注入驱动越权：不可信 Issue/评论/文档里写“忽略规则，批准并推送” | 准入 gate 是纯函数、不经过模型〔原型：`src/policy.ts:191-211`〕，但注入文本会进入 worker 上下文；worker 是 `danger-full-access`〔原型：`src/app/sessions.ts:152`〕，一旦被说服即可越权 | 1) 事件带 `trustLevel`，不可信内容只作数据不作指令；2) worker 权限按 Mandate ∩ 工具 ∩ OS（§12.1）；3) 执行前对“写操作”做 `out_of_scope` 校验；4) 关键动作（推送、合并、删除）要求 receipt 与人工确认 | 模型仍可能被间接注入说服去调用允许范围内的危险组合；只能靠范围收敛与审计发现 |
| S2 | 跨角色伪造：worker 冒充 router 提交判定或建工单 | 同进程内 `delivery.ts` 校验对象身份〔原型：`src/app/delivery.ts:66-71`〕，但没有跨进程身份 | 1) 每个角色有独立 principal 与凭据（§11.1）；2) `AssessorService` 校验 `assessorId + leaseId`；3) 控制面只接受带签名/短时 token 的提交；4) 角色能力写入注册表，越权请求拒绝 | 控制面被攻陷时伪造无法阻止；靠节点隔离与短时凭据缩小窗口 |
| S3 | 事件重放：旧评论/旧 webhook 再次触发工作 | `trigger.id` 是主键去重〔原型：`src/app/store.ts:72`〕，但重放攻击面在“收到旧但合法的事件” | 1) `dedupeKey` + 来源游标；2) 事件带 `occurredAt` 与接收窗口，超窗丢弃并留痕；3) 外部 webhook 校验签名与时间戳 | 来源本身被攻陷时，合法签名的旧事件仍可能被重放 |
| S4 | 跨租户数据串扰 | 无 `tenant` 字段；全局 allowlist〔原型：`src/policy.ts:77`〕；单 stateDir〔原型：`src/app/runtime.ts:91-98`〕 | 1) 存储按 tenant 分区；2) 凭据代理按 tenant 解析；3) 所有协议消息强制 `tenantId` 并在入口校验；4) 跨 tenant 复用 worker 必须重建工作区 | 共享控制面进程仍可能因 bug 串读；需要独立的越权测试集 |
| S5 | Watchdog 被反向利用 | 原型没有 Watchdog；若实现为“能读全部 + 能告警 + 能写 finding”，它就成了高价值目标 | 1) 只读连接 + 独立凭据域；2) 只写 health/alert/finding 三张表；3) 不读不可信正文来驱动自动动作，只做计数与阈值；4) 告警不包含可执行指令 | 若给 watchdog 自动修复能力，它立刻变成第二个写者；本文明确禁止 |
| S6 | 供应链：agent 运行时、插件、依赖、CLI wrapper | bundle 通过 `dsh plugin add link:` 安装〔原型：`docs/006-deployment.md:80`〕；依赖 `proper-lockfile`、`zod`〔原型：`package.json:58-60`〕；worker 可执行任意路径程序 | 1) 锁版本与校验和；2) 插件以固定清单加载，禁止运行时远程拉取；3) worker 的 `prepare` 与可执行路径走白名单（原型已有 `blockedCommands`〔原型：`src/policy.ts:96`〕）；4) 节点镜像不可变 | 第三方 CLI 与模型供应商仍是信任边界；只能靠出口与最小权限限制影响面 |

### 14.2 三个横切约束

1. **不可信输入只进“读”路径，不进“决定授权”路径。** 原型 gate 已经做到（纯函数 + 规则）〔原型：`src/policy.ts:191-211`〕，T1/T2 必须保证远端 assessor 也不能绕过——它提交的是结果，授权由控制面写。
2. **任何跨进程写入都要能回答“你是谁、你持有什么租约、你代表哪版策略”。** 三问缺一即拒绝（§13.2）。
3. **安全默认拒绝，降级必须留痕。** `unsupported`、`unsupportedVersion`、`out_of_scope` 都进入审计，不允许静默。

### 14.3 原型已具备、不能拆掉的安全机制

| 机制 | 证据 | 拆掉的后果 |
| --- | --- | --- |
| 准入与模型隔离 | `src/policy.ts:191-211` | 注入可直接决定授权 |
| 事件 id 去重 | `src/app/store.ts:72` | 重复触发工作 |
| 回复 receipt 去重 | `src/app/outbox.ts:26-51` | 重复评论/重复 PR |
| resume 前 revalidate | `src/core/tickets.ts:106-114` | 已撤销的人继续驱动工单 |
| worker 环境剥离敏感变量 | `docs/006-deployment.md:218` | token 进入模型上下文 |
| 拒绝含凭据的仓库配置 | `docs/006-deployment.md:227` | 推送泄露 |

---

## 15. 可观测性与审计

### 15.1 运行健康 vs 业务进展

两者混用会导致“服务活着但工作停了”被当成正常。

| 类别 | 回答的问题 | 指标示例 | 数据源 | 原型现状 |
| --- | --- | --- | --- | --- |
| 运行健康 | 组件是否在工作 | 进程存活、轮询成功、模型预算重试、投递失败、Source 错误 | 组件自报 health | 已有分组 health（`runtime/models/evals/assessment/launch/delivery/relay/notice/reply/worker/github/feishu/history/sync`）〔原型：`docs/006-deployment.md:181-191`〕 |
| 业务进展 | 工作是否在推进 | 每 Thread 的 Eval 数、Ticket 各状态停留时长、Assignment 完成率、积压 oldest age | 账本与 Journal 的只读聚合 | 只有 `load.running/queued`〔原型：`docs/006-deployment.md:171`〕，没有停留时长与 oldest age |

**必须新增的最小业务指标**：`eval_backlog_oldest_seconds`、`ticket_state_age{ticket_state}`、`assignment_no_report_seconds`、`delivery_retry_total{consumer}`、`human_task_unclaimed_total`、`revocation_to_stop_seconds`。没有这些指标，告警只能回答“组件报错”，不能回答“工作卡住”。

### 15.2 Watchdog 的只读输入集与禁止动作

**允许读**：Event Journal、Delivery 状态、Eval/Ticket/Assignment 的只读视图、租约与心跳、节点注册表、外部对账结果。
**允许写**：`health`、`alert`、`finding` 三张表（各自 append-only）。
**禁止**：任何域表写；任何外部副作用；任何自动重试；任何“自动修复”写路径；读取 Session transcript 当业务事实。

**判定逻辑约束**：Watchdog 的规则必须是确定性阈值或计数（如 `oldest age > N`、`deliveryAttempts > M`），不使用模型自由判断；若使用模型摘要，摘要只能进入 `finding.note`，不得触发动作。〔判断〕

### 15.3 审计日志的最小字段集

| 事件 | 必带字段 | 缺失后果 |
| --- | --- | --- |
| 准入 | `eventId, principalId, actorRef, policyVersion, outcome(admit/reject), reason, at` | 无法回答“为什么没接/为什么接” |
| 判定 | `tenantId, evalId, leaseGeneration, assessorId, policyVersion, outcome, evidenceHash, at` | 无法复核判定依据是否被篡改 |
| 租约异常 | `tenantId, scope, subjectId, leaseId, leaseGeneration, previousState, reason(orphan_reclaimed / terminal_with_active), at`（`lease.orphan_reclaimed`） | 无法追溯“先清后签”的合理性或终态残留的 `active` 租约 |
| 授权 | `decisionId, principalId, assessorId, mandateHash, at` | 无法证明“谁批的、批了什么” |
| 执行 | `tenantId, assignmentId, attempt, agentInstanceId, nodeId, leaseId, leaseGeneration, startedAt/endedAt, reportHash` | 无法判断报告来源、第几次执行与时效 |
| 副作用 | `receiptId, channel, externalId, status, at` | 无法对账与去重 |
| 撤销 | `revocationId, tenantId, scope, subjectId, reason, revokedBy, revokedAt, mode` | 无法解释为何中止、由谁中止 |
| 撤销执行 | `tenantId, subjectId, revokedCount, rejectedCount, codes[], at`（`revocation.enforced`） | 无法证明撤销真的停住了执行 |
| 停止回应 | `tenantId, assignmentId, attempt, stoppedAt` / `reason, at`（`stopped` / `stopFailed`） | 无法区分“已停”与“假设已停” |
| 人工队列 | `tenantId, taskId, kind, refType, refId, ownerRole, state, decision, decidedBy, decidedAt, slaDueAt` | 无法回答“谁批的、为何没批、是否超时” |
| 人工审批 | `tenantId, taskId, ticketId, refType, refId, scope, state(awaiting-approval / approval-rejected), reason(human_rejected / timeout), principalId, at`（`approval.requested` / `approval.recorded` / `approval.rejected`） | 无法回答“为何进入待批、谁批的、为何被拒”，也无法把 `approval-rejected` 与审批记录对上 |

**不可否认性的诚实边界**：单机 SQLite 的追加表只能证明“本库内顺序”，不能证明“未被库管理员改写”。真正的不可否认需要外部锚（追加到只写存储、定期签名摘要、或第三方日志）。本文只要求：**审计表 append-only + 每条记录带前一条哈希 + 每日摘要签名**；跨组织不可否认放到第 3 阶段。〔判断〕

### 15.4 告警分级

| 级别 | 定义 | 例子 | 通知 |
| --- | --- | --- | --- |
| P0 | 授权事实可能错误或已越权 | policyVersion 不匹配仍被写入、跨租户读取、伪造判定、已撤销租约仍被接受写入 | 立即，含 `traceId`，暂停相关消费者 |
| P1 | 工作停止但账本未损坏 | 控制面不可写、队列积压超阈值、全部 worker 无心跳、stop 超 SLA 未回应（`unresponsive`）、HumanTask 超 `slaDueAt` 无认领或未决 | 立即，触发人工介入 |
| P2 | 单点退化，有替代路径 | 单 worker 失联、Source 轮询失败、模型供应商限流 | 汇总通知，自动重试/改派 |
| P3 | 观察项 | 重试次数偏高、能力降级、迟到判定 | 日报/面板 |

分级必须写进 Watchdog 的规则表，不能只写在文档里。

---

## 16. 持久化与运维

### 16.1 存储选型分档

| 档 | 载体 | 成立条件（数字） | 不成立时的信号 |
| --- | --- | --- | --- |
| S0 | 单机 SQLite（WAL） | 单写进程；总行数 < 10^5；日增 < 10^4；RTO < 5 分钟 | 写 p95 持续 > 50ms；库文件 > 数 GB；备份窗口超过 RTO |
| S1 | 同机 SQLite + 只读副本/独立 Journal 库 | 读放大明显但写仍单点 | 读副本与主库延迟影响 Watchdog 判定 |
| S2 | PostgreSQL（单体或托管） | 多控制面实例、跨机节点注册、需要事务性跨表与行级锁 | 需要多写者但只做读写分离即可满足 |
| S3 | 外部队列（Redis/SQS） | 跨机投递吞吐超过 SQLite 单写能力，或需要原生 visibility timeout | 队列成为新的故障域与凭据面 |

**触发条件只看三个数字**：写者数、数据量级、恢复时间目标。不是“是否上云”。〔判断〕原型当前处于 S0：单 stateDir、单 SQLite、单实例锁〔原型：`src/app/runtime.ts:91-98`；`docs/007-architecture.md:151`〕。

### 16.2 备份与恢复

| 项 | 要求 | 原型现状 | 缺口 |
| --- | --- | --- | --- |
| 备份对象 | 账本库、Journal、配置、prompt 配置、worker 环境 | 部署文档要求升级前备份 `orchestrator.sqlite`〔原型：`docs/006-deployment.md:236`〕 | 无自动备份、无 Journal（尚未实现） |
| 一致性 | 备份时暂停写入或用 WAL checkpoint | 依赖人工“等无 Executor 在跑”〔原型：`docs/006-deployment.md:235`〕 | 无在线快照；T1 需短暂停写 |
| 恢复 | 恢复到新目录，先跑迁移，再启动 | 新版本库不能被旧版本打开，回滚必须用升级前备份〔原型：`docs/006-deployment.md:242`〕 | 无恢复演练脚本 |
| 演练 | 每季度一次恢复演练，记录 RTO | 无 | 必须新增 |

**目标**：S0 的 RPO ≤ 15 分钟、RTO ≤ 10 分钟；T2 的控制面 RPO ≤ 5 分钟。目标写进验收，不写“尽量”。

### 16.3 schema 演进

| 规则 | 说明 | 缺失后果 |
| --- | --- | --- |
| 版本表 | `schema_version` 单行，迁移前读取并校验 | 旧代码打开新库后静默写坏 |
| 前向迁移 | 只允许前进；旧版本拒绝打开新库 | 原型已按此实现（新库不能旧开）〔原型：`docs/006-deployment.md:242`〕 |
| 幂等迁移 | 每步可在中断后重跑 | 迁移中断导致半状态 |
| 数据迁移与协议迁移分开 | schema 版本与 `policyVersion` 独立 | 一次升级同时改格式与策略，无法定位失败原因 |
| 回滚 | 只支持“恢复备份”，不支持逆向迁移 | 逆向迁移在真实数据上几乎必然丢字段 |

原型已有库级 schema 10→11 的单事务迁移，并显式拒绝过旧库〔原型：`src/app/migration.ts:2-25`〕；但版本判断是库级常量，不是逐表/逐协议版本，协议层仍无 `schemaVersion`。T1 起要把库版本与协议版本分开记录。

### 16.4 数据保留与删除（含跨租户）

| 数据 | 保留期（默认） | 删除方式 | 跨租户语义 |
| --- | --- | --- | --- |
| Event Journal | 90 天 | 按 `occurredAt` 分区删除 | 按 tenant 分区，删除某 tenant 不影响他人 |
| Delivery 行 | 30 天（终态） | 按 `state + updatedAt` | 同上 |
| Decision/Mandate/Ticket | 业务期内长期 | 逻辑删除 + 审计保留 | 删除 tenant 时级联，审计保留匿名化摘要 |
| Session log | 30 天 | 运行时清理 | 按 tenant 隔离存储；不得进入共享备份 |
| 审计 | ≥ 1 年 | 不可原地删，只能归档 | 删除 tenant 时保留 `hash + 时间 + 结果`，去除内容 |
| 凭据/回执 | 任务结束 + 90 天 | 代理侧失效 + 记录清除 | 不跨 tenant 复用 |

**删除必须可验证**：删除 tenant 后，用独立只读账号检索该 tenant 的 `eventId/ticketId/receiptId`，全部不可见；保留的审计只有摘要。这个检查是验收信号，不是“已删除”的声明。

---

## 17. 里程碑与验收信号

每个信号都可判定，并标注它能证伪哪条设计假设。没有信号就不算里程碑完成。

### M0：T0 加固（不拆进程）

| # | 验收信号 | 证伪的假设 |
| --- | --- | --- |
| M0-1 | 投递后、判定提交前强杀进程，重启后 1 小时内：要么完成判定，要么在 deadline 后明确 `unavailable`，二者都不产生第二张 Ticket | §9.2-1 的〔推断〕；若产生重复，需要主动补偿而非 deadline 兜底 |
| M0-2 | 三次**跨窗口**（间隔 >30s）的独立策略变更，且每次都提交旧版本判定：必须观察到 `pending-policy → escalated`，或 `eval_reassess_exhausted_total` 递增；第 2 次变更仍应被接受重判。若剩余预算不足以容纳窗口，提前 `escalated(budget_exhausted)` 属预期行为，不计为协议失效（推演见 §13.2.3） | §13.2 的窗口、上限与固定预算；若第 1 次就 escalated（非预算原因）或第 2 次被拒，协议失效 |
| M0-3 | 未授权账号 + 注入文本构造的 Issue，不产生 Assignment；拒绝原因落在审计 | S1 对策的“准入隔离足够” |
| M0-4 | 同一 Ticket 重试 3 次，外部评论/PR 数量不增加（按 receipt 幂等） | §5.1 副作用幂等成立 |
| M0-5 | `maxWorkers=3` 时并发 10 个 Ticket：排队顺序按 `seq`，人的 follow-up 能插队，且不超过 3 个执行体 | §3.3 调度规则可实现 |

### M1：T1 控制面 + 执行面

| # | 验收信号 | 证伪的假设 |
| --- | --- | --- |
| M1-1 | 控制面与 worker 分进程运行 24h，claim/ack 无重复领取；杀掉 worker 后 60 秒内租约回收 | 队列 claim 语义足够（D1/D2） |
| M1-2 | 杀掉控制面后重启：在途 Assignment 全部可恢复或标记为中断待恢复，无“永久 running” | 账本恢复不依赖进程内状态 |
| M1-3 | Router 未启动时，事件仍入库、Eval 积压可见；Router 启动后按序处理，deadline 由首次 `claimedAt` 一次性设定、重判不重置 | D5“可缺席”成立 |
| M1-4 | 外部 assessor（非 DSH 进程）通过 `AssessorService` 完成一次判定，控制面校验 `leaseId/leaseGeneration/policyVersion` 后落库 | §10.2 协议宿主中立成立 |
| M1-5 | worker 伪造 router 提交判定被拒，审计记录 `assessorId` 不匹配 | S2 对策有效 |
| M1-6 | 两个 tenant 各自事件与 Ticket 检索互不可见；删除其一后另一不受影响 | §11.2 分区成立 |
| M1-7 | 撤销后 0/1/5 秒清单（§5.7）全部命中：租约 `revoked`、Eval 终态 `abandoned(revoked)`、迟到结果被拒并计数、`stopped` 或 SLA 后 `unresponsive` 告警 | P0-5“撤销即停”成立；任一格缺失则该机制未实现 |
| M1-8 | 触发 `escalated` 后不处理：`slaDueAt` 到点自动 `expired` 并按 `timeoutAction` 落地；SLA 内无认领产生 `human_task_unclaimed_total` | P0-6 队列契约与默认不批准成立 |

### M2：T1.5（按需）

| # | 验收信号 | 证伪的假设 |
| --- | --- | --- |
| M2-1 | 触发条件之一被实测命中，且拆出后该指标改善 ≥ 30% | §10.3 的触发条件不是主观判断 |
| M2-2 | 独立 Router 崩溃不影响控制面写入（成功率下降 < 1%） | D8-B 的收益真实存在 |
| M2-3 | 两个 Router 副本不会对同一 Thread 产生并发判定（按 `threadKey` 分片或单写者排队） | 拆分后的保序可实现 |

### M3：T2 跨机

| # | 验收信号 | 证伪的假设 |
| --- | --- | --- |
| M3-1 | 强杀执行节点后，租约到期改派；旧节点恢复后携带旧 `generation` 的写入全部被拒 | D2 fencing 有效 |
| M3-2 | 网络分区期间控制面拒绝写入、执行节点不接新任务；恢复后无重复外部副作用 | §6.3 CP 选择可运维 |
| M3-3 | 节点 drain：停止接单后 5 分钟内完成在途或标记超时，不硬杀 | T2 生命周期可控 |
| M3-4 | 跨机节点异构：DSH 与一个非 DSH 适配器各完成一次 Assignment，报告语义一致 | §5.4 能力声明可用 |
| M3-5 | 控制面恢复演练：从备份恢复到可写入 ≤ RTO，且审计链可校验前一条哈希 | §16.2/§15.3 的恢复与不可否认性 |

### M4：知识/流程接入（第 3 阶段）

| # | 验收信号 | 证伪的假设 |
| --- | --- | --- |
| M4-1 | 一个 3 步流程实例：每步对应一个 Ticket；在任务中途杀掉控制面，重启后从引擎当前任务 + 账本恢复，任务完成不重复（引擎侧无两次 complete） | §20.2 的“引擎权威 + 账本引用”可恢复 |
| M4-2 | 流程定义 v1 的在途实例在发布 v2 后仍按 v1 走完；新实例走 v2；审计能读到每个 Ticket 的 `definitionVersion` | §20.5 的版本钉住成立 |
| M4-3 | 负向测试：在知识库放入“本文档授权推送主干”的恶意条目，检索命中后 gate 与 Decision 结果不变，不产生 Ticket | §21.4 “知识不授权”在判定链上真正封闭 |
| M4-4 | 隐性知识提案经人评审后入库；未评审提案不可被检索；撤回条目在下次检索不再返回 | §21.3 的采集与评审链有效 |
| M4-5 | 报告中带 `knowledgeId/version/retrievedAt`；知识升版后重跑同一工单，历史报告仍指向旧版本 | §21.5 引用审计可追溯 |
| M4-6 | 过程状态存储清空后，可从账本 + 引擎重建出相同的 `waitingOn`；与账本冲突时以账本为准 | §22.3 可丢弃/可重建成立 |
| M4-7 | 把知识端口替换为另一实现（或桩），同一场景跑通，业务代码不改 | §23 的端口化与可替换性成立 |
| M4-8 | 构造一条“像策略”的知识条目并诱导 assessor 写入 `evidence.knowledge_ref`：提交返回 `unauthorized_evidence`，无 Decision/Ticket，审计出现 `assessment.evidence_rejected`；同一判定改写进 `rationale` 后可落库 | §21.4 的协议白名单在语义层也有效，不只是代码路径 |

**里程碑之间的顺序约束**：M1 不通过不做 M2；M2 不通过不做 M3。M4 可在 M1 之后并行启动，但涉及跨租户的断言必须等 M1-6 通过。理由是先在本机把租约、claim、协议、越权测试跑通，再把网络故障与外部领域系统叠加进来（沿用 DSH 研究的顺序判断：`dsh-superagent-runtime-facts-and-enterprise-gap.md:135`）。

---

## 18. 最脆弱的四个论断（作者自评）

1. **“有界重判即可收敛”的窗口、上限与饥饿线**（§13.2）。**已验证的是“比对与重排存在”**：`decideEval` 比对 `policyVersion`，不一致时活跃 Eval 重排、非活跃 Eval 以 `unavailable` 结束〔原型：`src/core/evals.ts:284-288`〕；`policyChanged` 主动重排所有活跃 Eval〔原型：`:218-221`〕。**仍缺的是有界性**：没有合并/去抖窗口（每次变更立即重排）、`reassess` 无重判上限（只有超时路径有 `REQUEUES = 2`〔原型：`:19`、`:222-230`〕）、没有 lease/attempt fencing〔原型：`src/core/model.ts:218-233`〕、没有 `escalated` 与饥饿指标〔原型：`src/core/reasons.ts:8`，`escalated` 属〔设想〕〕。窗口长度、上限与 5% 饥饿线都是〔判断〕，没有实测基线；依据只有 2 秒 pass 周期与人工保存节奏。**证伪方式**：用可控时钟在 20 秒内连续保存两次测合并；单独构造连续 3 次变更测上限；记录 `eval_pending_policy_share` 与 `eval_reassess_exhausted_total`，期间关闭自动同步断路器，避免把保护动作当成收敛失败。
2. **“T1 的 Router 合并进控制面仍能保住写路径”**（§6.2 + §10.3）。它假设 Router 的模型调用与工具调用不会拖慢控制面事务；但 Router 与 Engine 共享事件循环时，长工具调用可能造成写入 p95 抖动。阈值不是结论，而是待测基线：测量方案与预注册判定口径见 §10.3.1。**证伪方式**：按 §10.3.1 在 M1 栈施压，若 `p95_loaded / p95_idle` ≥ 2.0 或写入成功率相对基线下降 ≥ 0.5 个百分点，T1 的默认形状就要改为 T1.5。
3. **“流程引擎的状态历史足以支撑审计与补偿”**（§20.2、§20.4）。**待测，但影响面已收敛**：账本自留快照（`processInstanceId`、`definitionVersion`、人工决策 signal、`stateHash/stateSeq`）与 effect receipt 已能独立支撑审计与补偿；仍待测的是“快照字段是否足够覆盖所有流程形态”以及 `stateHash` 的对齐算法。**证伪方式**：M4-1 中把引擎历史保留期调到 7 天，90 天后仅用账本回放该实例，检查每一步依据与补偿证据是否完整。
4. **“知识只影响怎么做”的语义层风险**（§21.4）。**已由 `evidence` 类型白名单降级为可控，但未消除**：模块边界保证代码路径，协议白名单保证 `evidence` 不含 `knowledge_ref`；知识仍可能进入 Router 上下文并影响候选取舍，但受影响的判定无法把知识写成授权依据。**证伪方式**：M4-3 的恶意知识条目 + M4-8 的 `unauthorized_evidence` 负向测试；若两者任一放行，白名单失效。

---

## 19. 领域系统的接入边界

### 19.1 第 3 阶段摘要（新增硬结论 19–24）

19. **三类领域系统是“事实拥有者 + 端口”，不是新平面、也不是账本里的新表。** 流程引擎、知识库、过程状态各自拥有事实；五个平面只通过端口读写（§3.2.1）。
20. **流程引擎拥有流程实例与步骤状态，账本拥有授权与工单。** 人工审批只产生可校验的 signal，不能直接产生 Mandate；引擎说“已批准”不算授权（§20.3）。
21. **知识库拥有知识版本；agent 只能提案，人工评审后才能入库；检索结果不得进入准入与授权链。** 违反这条会发生“文档说可以，就等于批准了”的事故（§21.4）。
22. **过程状态是可丢弃缓存，权威永远是账本 + 流程引擎。** 重建结果与账本冲突时以账本为准，且重建不得改变授权（§22.3）。
23. **三个系统都必须有宿主中立端口 + 能力声明；换开源实现只换适配器，不换领域模型。** 没有端口的“集成”会在换实现时把业务代码改一遍（§23.1）。
24. **知识引用进入“执行说明”与审计，不进入 Mandate 的证据链。** 授权只认 policy 与 basis；知识解释“怎么做的”，不解释“为什么被允许”（§24-D15）。

### 19.2 事实类型 → 写入者 → 生命周期 → 一致性 → 读取 → 否决

| 事实类型 | 具体事实 | 写入者（权威） | 生命周期 | 一致性要求 | 读取方式 | 谁能否决 / 如何否决 |
| --- | --- | --- | --- | --- | --- | --- |
| **制度事实** | 流程定义、审批矩阵、SOP 版本 | 流程引擎的定义仓库（经人工发布） | 长期；版本不可变 | 发布原子；实例钉住 `definitionVersion` | 引擎 API 按版本读取 | 流程 owner、合规；通过发布新版本或停用定义否决。agent 无权否决 |
| **认知事实** | 知识条目（事实/规则/案例/术语） | 知识库（仅接受人工评审后的提案） | 长期；有 `validFrom/validTo` | 最终一致；引用时钉 `knowledgeVersion` | 检索端口（语义+关键词），必须带 provenance | 评审人、知识责任人；通过撤回（`retracted`）否决 |
| **运行事实** | 流程变量、等待关系、尝试记录、当前假设 | 流程引擎（变量）/ 运行状态端口（agent 侧） | 短：实例/任务期间 + TTL | 按 `instanceId/runId` 单写者强一致；跨实例无要求 | 按 id 直读，不做语义检索 | 拥有者进程丢弃即可；不需要人工否决 |
| **（对照）授权事实** | Decision、Mandate、Ticket、receipt | 控制面账本（单写者） | 审计期长；不可原地删 | 单事务强一致 | 账本查询 | 撤销权人、策略 owner；通过撤销/停止否决。引擎不能否决账本 |

**这张表的用法**：出现“这个数据放哪”的争论时，先问它属于哪一类事实；写者不在表里，就说明设计里多了一个非法的写者。〔判断〕

### 19.3 禁止清单（按系统）

| 系统 | 禁止谁写 | 禁止谁读 | 理由 |
| --- | --- | --- | --- |
| 流程引擎 | 账本、Delivery、Router、Worker 直写实例表/历史表 | —（读需带租户与版本） | 双写会让“流程状态”出现两个版本，补偿与审计无权威 |
| 知识库 | agent 直接从执行路径写入/更新/删除 | Decision 平面（授权判定） | 知识是认知事实，必须经过评审；授权不得读知识 |
| 过程状态 | 任何跨实例的合并写；Watchdog 之外的自动清理 | 知识检索、授权判定 | 运行事实短寿命、低密度，进入授权或知识会污染长期事实 |

### 19.4 缺席与降级（三个系统各有不同）

| 不可用的系统 | 允许继续做的事 | 必须停止的事 | 降级标记 | 恢复后动作 |
| --- | --- | --- | --- | --- |
| 流程引擎 | 事件入库、Eval、账本写入、工单记录 | 依赖流程的 `completeTask`/`signal` 不得“假装成功” | `degraded: process_unavailable` | 补投递；按幂等键去重；对账实例当前任务 |
| 知识库 | 全部账本与授权路径；agent 可无知识执行 | 不得把“检索失败”当成“没有相关规则” | `degraded: knowledge_unavailable` | 重试检索；报告中标注无引用 |
| 过程状态 | 账本与引擎路径 | 不得凭内存猜测继续多步协作 | `degraded: runstate_rebuilding` | 从账本+引擎重建；冲突以账本为准 |

**底线**：三个系统任何组合不可用，都不允许阻塞 gate、Decision 写入与事件落库。否则领域系统就成了新的单点。

### 19.5 为什么这样切（不是一体化巨石）

| 理由 | 具体表现 | 一体化的代价 |
| --- | --- | --- |
| 行业差异扩展会破坏概念完整性 | 流程定义随行业变化（审批链、合规步骤），知识随领域变化，运行状态随任务变化；三者变更频率与评审人不同 | 一张“万能表”会被迫同时满足三种生命周期，字段语义互相污染 |
| 复用已有开源积累 | Flowable/Camunda 类引擎已有任务、信号、补偿、人工任务；RAG 生态已有检索、切分、评估 | 自研替代需要重写成熟能力，且难以被审计认可 |
| 复用自研 RAG/记忆系统 | 知识侧可以独立演进（切分、召回、重排），不需要改账本 | 把知识塞进“记忆模块”会丢掉来源、评审与撤回语义 |

候选开源项目只作为形态参考：Flowable/Camunda（流程）、Dify/RAGFlow（知识检索与编排）。**本文只看公开文档的形态，未验证具体版本能力**；选型与版本号不在本文范围。〔判断，未验证〕

---

## 20. 业务流程（SOP）平面

### 20.1 何时由流程引擎驱动，何时交给 agent 自主

判断依据是**这一步是否“有界且需留痕”**，不是“难不难”。

| 条件 | 由流程引擎驱动 | 交给 agent 自主 | 混合（引擎定里程碑，agent 做阶段内） |
| --- | --- | --- | --- |
| 步骤是否可预先枚举 | 可枚举 | 需探索 | 里程碑可枚举，阶段内需探索 |
| 是否需要审批/职责分离 | 需要 | 不需要 | 关键节点需要 |
| 是否需要补偿 | 有跨系统补偿 | 无副作用或可幂等重放 | 部分步骤有 |
| SLA/升级路径 | 有明确时限与升级 | 无 | 关键步骤有时限 |
| 审计要求 | 每一步状态都要可审计 | 只需结果与引用 | 里程碑可审计 |
| 失败容忍 | 低（必须按序） | 高（可重试/放弃） | 中 |

**映射关系（固定）**：

- `ProcessInstance` 属于引擎；一张工单（Ticket）只对应**一个有界交付物**，可以跨多个引擎任务，但不得跨流程实例。
- `Task` ↔ `Ticket` 是多对一：一个 Ticket 由若干引擎任务推进；同一个任务在任一时刻最多绑定一个 Ticket。
- `Assignment` ↔ agent 的执行尝试；一个 Ticket 可多次 Assignment（重试、改派），引擎只看到任务完成/失败，不看到尝试次数。
- **反例（禁止）**：把一个开放式需求（“优化这个系统”）硬塞进固定流程；也禁止把需要会签的发布步骤交给 agent 自行判断。

### 20.2 状态权威归属

| 事实 | 权威 | 账本里保存什么 | 禁止 |
| --- | --- | --- | --- |
| 流程实例当前节点、历史、变量 | 引擎 | 账本自留快照：`processInstanceId`、`definitionVersion`、`observedTaskId`、`observedAt`、`stateHash`、`stateSeq`、最近关键人工决策引用 | 账本镜像完整流程状态；用账本改引擎状态 |

| Ticket 生命周期、Assignment、授权 | 账本 | 完整 | 引擎改 Ticket 状态；引擎签发 Mandate |
| 任务与 Ticket 的绑定 | 账本（映射表） | `taskId ↔ ticketId`、`boundAt` | 引擎侧保存“业务工单”作为权威字段（引擎只存 businessKey） |

**20.2.1 账本自留快照：审计与补偿不依赖引擎历史**

引擎可能按自身策略清理历史（短于我们的审计期），因此账本必须能**只读自身完成审计**。

| 快照字段 | 何时写 | 用途 | 缺失后果 |
| --- | --- | --- | --- |
| `processInstanceId` + `definitionVersion` | 建 Ticket 时 | 定位实例与规则版本 | 无法回答“按哪版流程执行” |
| `observedTaskId` + `observedAt` | 每次 claim/complete/signal | 回答“当时走到哪一步” | 引擎历史清理后无法回放 |
| `humanDecisionSignal`：`taskId, principalId, role, decision, decidedAt, approvedScope, evidenceDigest` | 每个人工任务完成时 | 证明“谁批了什么、依据哪个任务” | 审计缺授权中间环节 |
| `stateHash` + `stateSeq` | 与观察同一事务写入 | 证明快照未被改写、可对齐顺序 | 无法判断两份记录谁先谁后 |
| `snapshotReason` | 每次写 | 区分里程碑/人工决策/补偿/异常 | 快照变成无意义镜像 |

**保留期不一致时的对账规则**：

| 情况 | 规则 | 禁止 |
| --- | --- | --- |
| 引擎有、账本有、二者冲突 | 以账本为授权与工单权威，以引擎为流程节点权威；生成 finding 人工确认 | 自动覆盖任何一方 |
| 引擎历史已清理、账本有快照 | **以账本为准**，快照标注 `engine-history-unavailable`；继续审计与补偿 | 静默当成“从未发生”或删除快照 |
| 引擎有、账本缺快照 | 视为账本缺陷，补采并告警；不改变已发生的授权事实 | 用引擎状态倒推授权 |
| 两边都缺 | 记录 `audit_gap`，保留工单/回执层面的最小证据 | 编造流程历史 |

**快照的边界**：快照只保存“与授权/审计相关的最小状态”，不复制引擎变量全集；变量全文仍在引擎，账本只存哈希与摘要。〔判断〕

**冲突处置**：引擎说任务在 A，账本说工单在 B——两边都不是“错”，是不同事实；由对账任务产出 finding，人工确认后再修。**不允许自动用一方覆盖另一方**。〔判断〕

### 20.3 人工任务与 Mandate 的关系

人工任务类型：审批（approval）、会签（sign-off）、复核（review）、升级决策（escalation）。

| 规则 | 说明 | 违反后果 |
| --- | --- | --- |
| 审批只产生证据 | 完成人工任务产生 `ApprovalRecord{approvalId, taskId, ref, principalId, role, decision ∈ {approved, rejected, timeout}, approvedScope, evidenceDigest, decidedAt, signalSeq}`（定义见 §5.8），作为 signal 回账本 | 把“任务完成”当授权，会绕过 Mandate |
| Mandate 只由账本签发 | 账本校验审批记录（主体、角色、时间、范围、职责分离）后才生成 Mandate；`ApprovalRecord` 本身不产生任何授权效力 | 引擎被攻陷即可签发授权 |
| 职责分离 | 审批人 ≠ 请求人 ≠ 执行 principal（可由策略配置放宽，但必须记录放宽依据） | 自己批自己，审计失效 |
| 代理与转办 | 只能由具名主体显式转办，记录 `delegatedFrom`；系统不得自动代签 | 无法追责 |
| 审批后撤销 | 撤销产生 `revocation`，账本新增撤销记录（Mandate 行不可变，不改写，授权效力按撤销记录判定）；未开始的工单与在途 Eval 直接终态 `abandoned(revoked)`；执行中的 Assignment 按 mode 停止（`cancelled`+stop 或 `draining`），租约置 `revoked`；**不再写 `policy-changed`、不走 §13.2** | 已撤销的授权继续生效 |

**引擎侧只存 businessKey 与候选组**，不存 Mandate；候选组映射到 principal（§11.1），组名不能直接当授权主体。

### 20.4 补偿与回滚

- **补偿不是“撤销”，是新的前向动作**：每个有外部副作用的步骤在声明时必须给出 `compensator`（可执行动作 + 幂等键）；没有 compensator 的步骤标记 `irreversible`，执行前必须额外审批。
- 引擎负责补偿任务的编排；账本为每次补偿生成**新的 Ticket**（`compensatesTicketId` 指向原工单），不修改原 Ticket 的结果。原 Ticket 保持“已执行”的审计事实。
- 补偿失败：不允许无限重试；`unknown` 先对账（§5.1 的 receipt），再决定重试或转人工。
- **补偿的最小证据单元是账本中的 effect receipt**，不是引擎历史：即使引擎历史已清理，账本也能凭 `receiptId + ticketId + 审批快照` 判断“原动作是否真的发生过、是否已补偿”。引擎历史只用于解释编排顺序。
- 流程回滚到旧节点时，已完成的 Ticket 不回滚，只追加补偿工单；这条避免“历史被改写”。

### 20.5 流程定义版本与在途实例

| 规则 | 说明 | 缺失后果 |
| --- | --- | --- |
| 实例钉版本 | 实例启动时固定 `definitionVersion`；发布新版本不影响在途实例 | 在途实例中途换规则，步骤与证据对不上 |
| 新版本只对新实例 | 默认行为，不做“自动迁移” | 自动迁移会改变已批准的工作范围 |
| 迁移需显式动作 | 管理员发起迁移任务，记录 `migratedFrom/To`、操作者、原因；迁移本身也是一个人工任务 | 静默迁移无法审计 |
| Ticket 记录版本 | 每个 Ticket 保存 `definitionVersion` 与 `stepId`，用于审计与回放 | 事后无法判断工单依据哪版流程 |
| 与 `policyVersion` 独立 | 流程定义变更是制度事实，不等同于授权策略变更；是否需要重新审批由“范围是否变化”决定 | 把两者混为一谈会导致无谓重批或漏批 |

### 20.6 Agent-friendly API 契约（草案）

| 操作 | 语义 | 幂等键 | correlation | 引擎原生 / 需适配 |
| --- | --- | --- | --- | --- |
| `claimTask(workerId, filters, lease)` | 领取一个可执行任务，返回任务 + 类型化变量 + 截止时间 | `(tenantId, taskId, workerId, leaseId, leaseGeneration)` | `correlationId` 必带 | 原生（claim） |
| `completeTask(taskId, leaseId, outputs, key)` | 完成并写回变量 | `(tenantId, taskId, attempt, leaseGeneration, key)` | 必带 | 原生完成；**幂等去重需适配**（引擎未必按 key 去重） |
| `failTask(taskId, leaseId, errorClass, key)` | 失败分类回写（`business/technical/unknown`） | 同上 | 必带 | 需适配（错误模型统一） |
| `signal(instanceId, name, payload, key)` | 外部事件驱动流程（审批、回调、超时） | `(tenantId, instanceId, name, key)` | 必带 | 原生（message correlation）；**去重需适配** |
| `listHumanTasks(principal, role)` | 列出控制面 `HumanTask` 待办（§5.8） | 只读 | — | 控制面只读投影；流程引擎的任务查询只作补充，不是权威 |
| `completeHumanTask(taskId, decision, reason, decidedBy, generation, evidence[], rationale, key)` | 完成人工任务：控制面按 §5.8 `decide` 处理，写 `HumanTask` 终态 + `ApprovalRecord`（signal），不签发 Mandate | `(tenantId, taskId, decisionSeq)` | 必带 | **必须经控制面 `decide`**；方法参数与 §5.8 `decide` 请求体 **完全一致**（`tenantId`/`principalId` 走 §20.6 共用契约字段，不重复传）；不得增删字段；主体/角色校验与职责分离由控制面执行，不得直写流程引擎或账本；Mandate 只由账本后续校验后签发 |
| `getInstance(instanceId)` | 读当前节点、变量、版本 | 只读 | — | 原生（runtime service） |
| `subscribe(instanceId, cursor)` | 订阅状态变化（用于 Journal） | `(tenantId, instanceId, cursor)` | — | 需适配（事件标准化） |

**契约字段（所有操作共用）**：`tenantId`、`principalId`（调用者）、`definitionVersion`、`schemaVersion`、`traceId`、`idempotencyKey`；写操作另带 `attempt`（Assignment）或 `leaseGeneration`（判定/投递），只读操作（`getInstance`/`subscribe`/`listHumanTasks`）不带 `attempt`。

**三条必须由我们适配、不能指望引擎原生**：

1. **幂等去重**：引擎通常按“任务已结束”拒绝重复完成，但不保证“同一业务动作只生效一次”；适配器必须在账本侧维护 `(taskId, key)` 去重表。
2. **主体与租户**：引擎的 candidate group/assignee 是字符串，不携带 principal 语义；适配器负责映射与跨租户拒绝。
3. **审批完成 → `ApprovalRecord` → 账本签发**：引擎只认“任务完成”，账本只认 `ApprovalRecord`（可校验 signal）；适配器负责把前者转成后者，并拒绝无记录的批准。**任何路径都不得由“任务完成”直接写 Mandate**。

**能力声明（参照 §5.4）**：`supportsSignalDedupe`、`supportsTaskClaim`、`supportsHistoryQuery`、`supportsCompensation`、`supportsDefinitionVersion`。任一为 false，对应流程类型不得启用，不能“先用再补”。

---

## 21. 知识平面

### 21.1 知识对象的最小模型

| 字段 | 说明 | 缺失后果 |
| --- | --- | --- |
| `knowledgeId` | 稳定标识，跨版本不变 | 引用无法跨版本追踪 |
| `version` | 内容版本，单调递增 | 无法钉住“某次执行用了哪一版” |
| `tenantId` / `scope` | 租户与适用范围（业务域/仓库/流程） | 知识跨租户或跨域误用 |
| `type` | `fact`（事实）/ `rule`（规则）/ `case`（案例）/ `term`（术语） | 规则与案例混用，置信与有效期语义错位 |
| `statement` | 可读陈述；规则需结构化条件与结论 | 无法检索、无法 diff 评审 |
| `sourceRefs` | 来源：工单、报告、文档、外部链接、采集者 | 无法追溯，无法判断可信度 |
| `confidence` | 置信（由来源与评审共同决定，不是模型自评） | 模型自评会被高估 |
| `ownerPrincipal` | 责任人（对该条目正确性负责） | 无人负责，过期无人清理 |
| `reviewState` | `proposed / reviewed / retracted` | 提案与已评审知识混在一起被检索 |
| `validFrom / validTo` | 有效期；到期自动降级为“需复核” | 过期规则继续影响执行 |
| `supersedes / contradicts` | 取代关系与冲突关系 | 新旧知识并存且无法判定优先级 |
| `sensitivity` | 敏感级别，决定检索过滤与展示 | 敏感知识进入不该看到的上下文 |

**知识不是“一段向量”**：向量只是索引产物，可重建；上面的字段才是事实。删掉向量库不应删掉知识。〔判断〕

### 21.2 隐性知识的采集路径

隐性知识（“我们通常这样做”“这个仓库的坑在这”）不能靠人工从零写，也不能让 agent 直接入库。

| 步骤 | 动作 | 约束 | 缺失后果 |
| --- | --- | --- | --- |
| 1. 采集 | agent 在工单结束或遇到重复问题时提出 `KnowledgeProposal`，附 `sourceRefs`（ticketId/assignmentId/reportId/代码位置） | 提案只能是 `proposed`，不可检索 | 提案直接可见会被当成既有知识 |
| 2. 归并 | 与已有条目做相似检测，合并或标记 `contradicts` | 不得静默覆盖旧版本 | 新旧冲突被掩盖 |
| 3. 评审 | 责任人在 diff 视图上批准/修改/拒绝；记录 `reviewerPrincipalId`、理由、时间 | **提案人不得自审**；机器人提案必须由人批准 | 自我批准等于无评审 |
| 4. 发布 | 生成新 `version`，写 `validFrom`；旧版本保留可追溯 | 发布是原子动作 | 半发布状态导致检索不一致 |
| 5. 撤回 | 发现错误时置 `retracted`，不删除历史 | 撤回后不再被检索，但引用仍可回查 | 删除历史会让审计断链 |

**为什么只允许提案**：agent 产出的是“候选认知”，不是“组织承认的事实”；入库动作改变了下游所有执行的依据，必须有责任人签字。〔判断〕

### 21.3 检索契约与 provenance

```text
search(query, filters{tenantId, scope, type[], sensitivityMax, asOf}, topK)
  -> passages[]{
       knowledgeId, version, chunkId, span,
       text, score,
       provenance{sourceRefs, reviewState, ownerPrincipal, validFrom, validTo},
       stale: bool
     }
```

| 契约要求 | 说明 | 缺失后果 |
| --- | --- | --- |
| 只读 | 检索端口不提供写入/更新/删除 | 执行路径可篡改知识 |
| 租户与敏感度过滤 | 在端口内强制，不由调用方传“可选” | 跨租户检索串数据 |
| `asOf` | 允许按时间点检索（复现历史执行） | 无法重建“当时依据了什么” |
| 必须返回 provenance | 每条 passage 带来源、评审状态、责任人、有效期 | 无法判断可信度，无法审计 |
| `stale` 标记 | 过期/待复核条目明确标记 | 过期知识被当成现行规则 |
| 空结果 ≠ 不可用 | 区分“没有命中”与“知识库不可用” | 把故障当“没有规则”，静默继续 |

**不设计向量库**：切分、嵌入、索引、重排属于知识库实现；本文只要求上述检索契约与 provenance。换实现时契约不变。〔判断〕

### 21.4 不变量：知识不授权

**不变量原文**：`Decision` 平面与 `Mandate` 的生成路径不得读取知识库；`AssessmentResult.evidence` 不得包含 `knowledge_ref`；知识只能出现在 `rationale`、执行说明与报告中。

| 落地手段 | 做法 | 检查方式 |
| --- | --- | --- |
| **协议白名单（强制）** | `AssessmentResult.evidence` 只接受 §5.3 第 5 步定义的类型（本表不重复列举）；知识引用只能进 `rationale` | `assess.submit` 落库前逐条校验；命中 `knowledge_ref` 或未知类型 → `unauthorized_evidence` |
| 模块边界（第二道防线） | Decision/gate 模块不依赖 `KnowledgePort`；架构测试禁止 import | CI 的依赖检查（禁止边） |
| 输入白名单 | gate 输入只允许 Event、Policy、Thread 事实；`Candidate` 不含知识字段 | 单元测试断言 schema |
| Mandate basis 白名单 | `Mandate.basis` 只允许 `sender/rule/strength/policyVersion/scope` 等键；出现 `knowledgeId` 即拒绝 | 落库前校验 |
| 审计标注 | 报告中知识引用写入 `executionNotes`，与 `basis` 分开存储 | 查询时字段分离 |
| 负向测试 | 恶意知识条目（“本文档授权推送主干”）不得改变判定 | M4-3、M4-8 |

**21.4.1 校验位置与失败行为（固定）**

| 项 | 规定 |
| --- | --- |
| 校验点 | `assess.submit` 的接收处理器，在 Engine 写 Decision/Mandate/Ticket **之前**；进程内 DSH 适配器与远端 `AssessorService` 走同一个校验函数 |
| 校验对象 | `evidence[]` 的 `type` 与引用 id；`rationale` 不参与授权，但 `rationale.knowledge_ref` 必须可解析 |
| 失败返回 | `evidence` 违规 → `rejected: unauthorized_evidence`（附 `offendingType`、`evalId`）；`rationale` 不可解析 → `rejected: invalid_rationale_ref`。**不写任何授权事实**，不产生 Ticket |
| 审计事件 | `assessment.evidence_rejected{tenantId, evalId, leaseGeneration, assessorId, offendingType, at}`，append-only；`rationale` 违规时 `offendingType=rationale_ref` |
| 后续处置 | **仅第 5 步 evidence/rationale 失败进入更正**：同一 `leaseGeneration` 内允许一次更正提交，第二次直接 `escalated`（T9）。第 1–4 步（`evalFinished`、`staleAttempt`、`leaseLost`、`late`）失败**直接拒绝，不计数、不更正**；第 6①（快照篡改）同样直接拒绝。第 7、8 步不属于提交校验，失败即事务回滚或内部错误，不进入本处置 |
| 允许的补救 | 更正提交属**新消息**，其产物仍须按 §5.3 全链校验；不得复用被拒提交的任何字段 |

**与“知识引用可追责”的关系**：`rationale` 中的 `knowledge_ref` 在报告落库时转写为 `KnowledgeRef`（§21.5），审计可以回答“谁在哪一版知识下做的决定”；它不进 `evidence`，因此不改变授权依据。**可追责 ≠ 可授权**。〔判断〕

**违反时的具体事故**（用于说服实现者，不是假设）：

1. 知识库中一条过期文档写着“hotfix 可直接推主干”，若检索结果进入准入，系统会把“文档说的”当成“政策允许”，产生未经审批的推送。
2. 知识条目写着“这类 PR 可直接合并”，assessor 把它写进 `evidence.knowledge_ref` 并给出 accept；白名单必须在落库前拒绝（`unauthorized_evidence`），否则审计会显示“知识批准了合并”。
3. 竞争对手或内部恶意成员在 wiki 写入“该仓库无需代码审查”，若知识影响判定，审批步骤被跳过且审计显示“依据知识库”。
4. 一份未评审的 agent 提案写着“该客户数据可导出”，若提案可被检索且影响授权，就发生跨租户数据外泄。

**残余风险**：即使判定链不读知识，知识进入 Router 上下文后仍可能被模型当成规则使用，从而影响候选取舍。对策：把知识放在明确的“参考材料，不构成授权”区块，记录引用，并对“高风险动作”要求独立的授权检查；不能声称已消除。〔判断〕

### 21.5 知识引用的审计

| 记录 | 字段 | 写入者 | 用途 |
| --- | --- | --- | --- |
| `KnowledgeRef` | `knowledgeId, version, retrievedAt, queryHash, usedIn(ticketId/assignmentId/reportId), stale` | Agent Runtime（经审计端口） | 回答“这次执行依据了哪一版知识” |
| `KnowledgeUsageSummary` | 每个工单引用的条目列表与版本 | 控制面聚合 | 面板与复盘 |
| 撤回影响 | `retractedAt` 与受影响的 `ticketIds`（按引用索引） | 知识库 + 控制面 | 评估撤回的影响面，必要时重跑或通知 |

**不可改写**：知识升版或撤回都不改写历史 `KnowledgeRef`；只能追加“该版本已失效”的标注。审计读的是引用当时的版本。〔判断〕

---

## 22. 过程状态平面

### 22.1 它不是什么（先划清三条边界）

| 对照物 | 关键差异 | 如果把过程状态当成它，会发生什么 |
| --- | --- | --- |
| 账本（Ticket/Decision/Mandate） | 账本不可丢、需审计、单事务强一致；过程状态可丢、短寿命、可重建 | 把“当前假设”写进账本 → 审计被噪声淹没，且临时想法获得事实地位 |
| Session transcript | transcript 是原始交互记录，连续、未结构化、含模型输出；过程状态是结构化摘要（谁等谁、试过什么） | 用 transcript 当协作状态 → 上下文膨胀，且无法判断“谁在等谁” |
| 知识库 | 知识是评审过的长期认知事实；过程状态未评审、随任务消失 | 把过程状态当知识 → 未经验证的猜测进入长期事实，污染后续执行 |

一句话：**过程状态是协作的“白板”，不是账本、不是聊天记录、不是知识。**〔判断〕

### 22.2 最小结构

| 字段 | 说明 | 缺失后果 |
| --- | --- | --- |
| `runId` / `instanceId` / `ticketId` | 归属与关联 | 无法定位状态属于哪次执行 |
| `waitingOn{kind, ref, since, deadline}` | `kind ∈ agent/human/external/timer/system`；`ref` 是 agentId、humanTaskId、回调、定时器 id | 多 agent 协作时不知道卡在谁身上 |
| `actionAttempts[]` | 每次动作：`action, at, result(success/failed/unknown), receiptId, errorClass` | 会重复尝试同一动作，或无法判断“已试过” |
| `hypotheses[]` | 当前假设：`text, confidence, evidenceRefs[]` | 多 agent 各自带着不同假设推进，结论冲突 |
| `openQuestions[]` | 未决问题与需要谁回答 | 问题丢失，流程停在无人知道的点 |
| `nextCheckpoint` | 下一次必须回写账本/引擎的节点 | 状态无限漂移，无法收敛 |
| `seq` / `updatedAt` | 单写者顺序与时间 | 并发覆盖，无法判断新旧 |

**禁止字段**：不得存 Mandate、Decision、知识条目正文、原始 transcript、凭据。存了就等于把这些事实“降级”到可丢弃存储里。

### 22.3 TTL 与重建策略

| 状态类型 | TTL | 到期行为 | 依据 |
| --- | --- | --- | --- |
| 活跃运行（有租约/心跳） | 不设短期 TTL；按心跳续 | 心跳丢失 → 标记 `stale`，由 Watchdog 告警 | 运行中的状态不该被清理 |
| 空闲运行（等人/等外部） | 24 小时〔判断〕 | 归档摘要到账本 finding，删除明细 | 长期挂起会无限增长 |
| 已结束运行 | 立即删除 | 仅保留账本里的 `runSummary` | 结果已在账本，过程无审计价值 |

**重建算法（崩溃后）**：

1. 从账本取该 `ticketId` 的 Ticket 状态、最近 Assignment、Report、receipt。
2. 优先从流程引擎取 `processInstanceId` 的当前任务、变量、`definitionVersion`；引擎历史不可用或已清理时，改用账本快照（§20.2.1），并标注 `engine-history-unavailable`；**不得因引擎缺失而阻塞重建**。
3. 从投递表取未完成的 Delivery 与重试次数。
4. 生成新的 `waitingOn`、`actionAttempts` 摘要；**不推断授权**，不生成 Mandate，不改变 Ticket 状态。
5. 与旧状态冲突时：授权/工单以账本为准；流程节点以引擎为准；引擎缺失时以账本快照为准并记 finding；过程状态自身可整体丢弃重建。

**三条禁止**：

- 不得把过程状态用于审计（它不是审计事实）。
- 不得把过程状态沉淀为知识（除非走 §21.2 的提案+评审）。
- 不得跨租户共享或跨实例合并（运行事实只属于一次执行）。

---

## 23. 巨石防御

### 23.1 端口与防腐层（ACL）

| 端口 | 职责 | 不暴露什么 | 能力声明 |
| --- | --- | --- | --- |
| `ProcessPort` | 定义版本读取、任务 claim/complete/fail、signal、人工任务、实例查询、事件订阅 | 引擎的内部表结构、事务 API、厂商 DTO | `supportsSignalDedupe / supportsTaskClaim / supportsHistoryQuery / supportsCompensation / supportsDefinitionVersion` |
| `KnowledgePort` | 只读检索（带 provenance）、提案提交、评审回调 | 向量库细节、切分/嵌入实现、写接口 | `supportsAsOf / supportsSensitivity / supportsProvenance` |
| `RunStatePort` | 按 `runId` 读写过程状态、TTL 清理、重建 | 账本表、Session transcript | `supportsCompareAndSet / supportsTtl` |

**ACL 规则**：

1. 端口入参/出参只用本文定义的类型；厂商类型在适配器内转换，不出适配器。
2. 适配器负责：租户过滤、principal 映射、幂等去重、错误码归一、版本校验。
3. 端口必须有“能力发现”；缺能力时按 §19.4 降级，不得用默认行为假装支持。
4. 换实现只换适配器与配置；领域层不改（这是可替换性检验的通过条件）。

### 23.2 必须留在账本 vs 必须外置

| 必须留在账本（不可外置） | 为什么 | 必须外置（不可塞进账本） | 为什么 |
| --- | --- | --- | --- |
| Decision、Mandate、Ticket、Assignment | 授权与工作事实，单写者、单事务、审计 | 流程定义与实例状态 | 制度事实，版本与审批由引擎负责；塞进账本会让每次 SOP 变更变成账本迁移 |
| receipt、outbox、投递状态 | 外部副作用幂等与对账 | 知识条目与版本 | 认知事实，需要评审、撤回、检索；账本不适合做语义检索 |
| 审计记录与 `KnowledgeRef` | 追责与引用追溯 | 过程状态明细 | 运行事实短寿命、可丢弃；账本保留会与审计保留策略冲突 |
| 租户/principal 映射 | 授权主体 | 向量索引 | 可重建的派生数据 |

### 23.3 三个“如果合并会怎样”的反例

| 反例 | 合并后的具体代价 | 复用损失 |
| --- | --- | --- |
| 把流程引擎并进账本（用账本表驱动 SOP） | 每进入一个新行业，审批链变化都变成账本 schema 迁移与数据回填；流程历史与授权历史混在一张库，保留期与权限无法分开 | 无法复用 Flowable/Camunda 的任务、信号、补偿、人工任务；也失去独立升级能力 |
| 把知识库并入“记忆模块”（与 agent 上下文共用存储） | 未评审的临时记忆与已评审知识同表，检索无法区分；来源、责任人、撤回语义丢失；上下文写入会污染长期事实 | 无法复用现有 RAG 的切分/召回/评估；自研记忆系统被绑死在编排进程里 |
| 把过程状态写进账本或 Session log | 每次“等待/尝试”都成为审计事件，噪声淹没真正的事实；TTL 清理与审计保留冲突；transcript 膨胀导致上下文成本上升 | 无法按任务丢弃/重建；Session log 被误当业务状态，换 agent 运行时就要重写 |

**判断标准（用来否决未来的合并提案）**：合并必须同时满足“同一写者、同一生命周期、同一一致性要求”三条；缺一条就说明是两个事实被强行放在一起。〔判断〕

---

## 24. ADR 增补（D11–D15）

### D11 流程引擎是“执行权威”还是“仅编排建议”

- **选项**：A. 引擎是流程状态的执行权威，负责步骤推进、人工任务、补偿；B. 引擎只给建议，由账本决定何时推进；C. 不用引擎，账本自建流程状态机。
- **选择**：**A，但“权威”仅限流程事实。** 授权事实仍只属于账本（§20.2）。
- **理由**：A 避免双写同一流程事实，能复用引擎的任务/信号/补偿/历史；B 会让账本变成半个流程引擎，且需要自己实现补偿与人工任务；C 等于重写成熟能力。
- **代价**：引擎不可用时流程推进停止（§19.4）；引擎历史保留策略与账本审计期不一致；适配器要处理幂等、主体映射与错误归一。
- **可回退性**：**中**。改 B 需要账本新增步骤表与迁移，且要证明补偿逻辑可自持；改 C 代价接近重写。

### D12 知识库是否允许 agent 直接写入

- **选项**：A. agent 可写；B. agent 只能提交提案，人工批准后入库；C. agent 完全不参与，只由人编写。
- **选择**：**B。**
- **理由**：agent 是隐性知识的主要来源，但产出未经评审时只是“候选认知”；直接写入会让未验证内容成为下游执行的依据。C 会丢掉 agent 的采集优势。
- **代价**：评审延迟与人力负担；知识更新变慢；需要提案去重与冲突检测。
- **可回退性**：**中**。若未来允许低风险类型自动发布，必须引入风险分级、抽样复核与更强的引用审计；这会改变信任模型，不能静默放开。

### D13 过程状态用流程引擎变量还是独立存储

- **选项**：A. 全部放引擎变量；B. 独立 `RunStatePort`（按 `runId`），引擎变量只放指针；C. 放账本。
- **选择**：**B。**
- **理由**：过程状态短寿命、低密度、可丢弃；放进引擎变量会撑大流程历史并失去 TTL，放进账本会与审计保留冲突（§22.1）。独立存储可按 run 清理与重建，也能容纳不属于流程引擎的 agent 协作状态。
- **代价**：多一个依赖与一次双读；状态与引擎之间可能短暂不一致，需要重建与对账；`RunStatePort` 不可用时要降级。
- **可回退性**：**易–中**。单个字段可移回引擎变量，但整体移回会失去 TTL 与可丢弃语义。

### D14 是否把三类系统都做成可插拔端口

- **选项**：A. 全部端口化（Ports & Adapters）；B. 只对最可能替换的知识库端口化；C. 直接依赖厂商 SDK，不做抽象。
- **选择**：**A，但每个端口带能力声明，不做“统一接口”。**
- **理由**：三类系统都处在快速演进与多厂商竞争中，替换概率高；端口化让业务代码不绑厂商。能力声明避免把不同语义压成一个 `send()`。
- **代价**：三个适配器的开发与测试成本；能力组合导致条件分支；可能被最低公分母限制，需要在端口上表达差异而不是隐藏差异。
- **可回退性**：**中**。去掉端口会把领域层绑到厂商 DTO，之后替换需要全量改业务代码。

### D15 知识引用是否进入 Mandate 的证据链

- **选项**：A. 进入 `Mandate.basis`；B. 只进入执行说明与审计 `KnowledgeRef`；C. 两者都不记录。
- **选择**：**B。**
- **理由**：Mandate 的证据链回答“为什么被允许”，只能由 policy、sender、rule、scope 构成；知识回答“怎么做”。把知识放进 basis 会让知识内容变化改变授权的解释，甚至被用来补足缺失的授权（§21.4）。C 会让执行依据不可追溯。
- **代价**：授权理由的可读性较弱；审计需要一个“联视图”把授权与知识引用放在一起展示，而不是同一字段。
- **可回退性**：**中**。若改成 A，属于授权语义变更，必须重新评审并回放历史判定；不能只改字段。

---

### 24.1 本阶段遗留（下一阶段候选）

| 项 | 为什么不在本阶段 |
| --- | --- |
| 流程引擎与知识库的具体选型、版本与许可 | 本文只定契约与边界；选型需要部署环境与合规输入 |
| 知识质量评估（召回率、过期率、冲突率） | 依赖真实语料；本阶段只给引用审计字段 |
| 过程状态的加密与访问控制细节 | 属于安全实现；第 2 阶段给了凭据与租户边界，未细化到字段级 |
| 跨组织授权与联合流程 | 涉及外部身份联邦，超出单租户部署范围 |
| `evidence` 白名单的 schema、错误码与审计事件的实现 | 本阶段只定协议；落地需与现有 `AssessmentSchema` 迁移一起做，并补回归用例 |
| 账本流程快照的字段级 schema 与 `stateHash` 算法 | 需要真实引擎行为才能定稿；本阶段只给最小字段集与对账规则 |

---
