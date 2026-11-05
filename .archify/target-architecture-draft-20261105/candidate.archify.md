# Super-Agent 目标架构粗稿（构图验证）

状态：粗稿，仅用于验证构图与语义映射，不是终稿，也不是对现有代码的解释。
证据来源：`docs/drafts/super-agent-architecture-design.md`（当前 HEAD `7fd12f7`）。全部节点/边只引用该文档章节号，不引用源码路径与行号。
标记：〔目标〕= 文档中作为目标形态提出的结构；〔待验证〕= 文档明确标为设想、待测或无基线的部分。

## 1. `diagram.system-overview.json` — 五平面与唯一契约通道

### 构图意图

把 §3 的五平面画成一条从左到右的主路径：Event → Decision → Work → Delivery → Agent Runtime。Decision 与 Work 被一个 `security-group` 边界包住，表示“授权与工作事实账本”的单写者、单事务区域；Assessor 单独放在 Decision 下方，强调“只产判断、不签发授权”。Agent Runtime 的报告用顶部回环回到 Work，表示“报告只回交、不直写域表”。

### 节点

| id | 标签 | 类型 | 标注 |
| --- | --- | --- | --- |
| event | Event 平面 | messagebus | 自身事实唯一写者 |
| decision | Decision 平面 | security | Decision* / Mandate* |
| work | Work 平面 | backend | 不拥有授权 |
| delivery | Delivery 平面 | messagebus | 不改业务事实 |
| agentrt | Agent Runtime | cloud | 运行时适配层，非进程 |
| assessor | Assessor | external | 结果待控制面校验 |

### 边界

- `security-group`：「授权与工作事实账本：单写者 + 单事务」包住 decision、work。

### 边

| from → to | 标签 | 含义 | 章节 |
| --- | --- | --- | --- |
| event → decision | 只读候选 + 版本 | 准入只读事件事实，不写域表 | §3.2、§5.1 |
| decision → work | 单事务写入 | Decision/Mandate/Ticket/首 Assignment 同事务写入 | §5.3 第 8 步 |
| work → delivery | 派发 effect | 工作平面只发请求，不代投递 | §3.2 不突变 |
| delivery → agentrt | 投递 + 能力 | 按适配器能力声明投递，不静默降级 | §5.4 |
| agentrt → work | 报告只回交（不直写域表） | 执行回报经控制面校验后才推进状态 | §3.2、§5.3 |
| decision → assessor | 请求 / 结果两段式 | 远程判定只能交回结果 | §5.3、§10.2 |

### 映射说明

五平面定义与“拥有事实/不拥有权力”来自 §3.2；调度不单独成平面来自 §3.1、§3.3；assessor 端口与两段式来自 §10.2。

---

## 2. `diagram.role-topology.json` — 角色与进程拓扑（T0 → T2）

### 构图意图

上半部分画角色与三类进程边界：控制面进程（Source + Engine + Router）、执行面进程组（Worker/Executor）、只读观察者进程（Watchdog）。Assessor 放在控制面下方，标为可缺席、可独立。下半部分用 T0 → T1 → T1.5 → T2 的链条表达四档部署形态，而不是把每档都展开成完整拓扑——粗稿只验证“哪些角色必须隔离、哪些可以合进程”。

### 节点

| id | 标签 | 所在边界 | 标注 |
| --- | --- | --- | --- |
| source | Source Adapter | 控制面进程 | 只写 Trigger 与游标 |
| engine | Engine | 控制面进程 | 授权事实单写者 + 租约服务 |
| router | Router | 控制面进程 | T1 默认合进程 |
| assessor | Assessor | 无（可缺席） | 只产判断 |
| worker | Worker / Executor | 执行面进程组 | 可多节点 |
| watchdog | Watchdog | 只读观察者进程 | 禁止任何域写 |
| t0 / t1 / t15 / t2 | 四档部署形态 | 无 | 起点 / 默认目标 / 按需 / 异构 |

### 边界

- `region`：控制面进程（T0 单进程；T1 默认合进程），包住 source、engine、router。
- `region`：执行面进程组（T1 起必须独立），包住 worker。
- `region`：只读观察者进程（必须独立），包住 watchdog。

### 边

| from → to | 标签 | 含义 | 章节 |
| --- | --- | --- | --- |
| source → engine | 事件 | Source 只交事件与游标 | §4.1 |
| engine → router | 只读视图 | Router 依赖账本读视图，不写域表 | §4.2、§6.2 |
| engine → assessor | assess 请求 / 结果 | 判定两段式，结果待校验 | §5.3、§10.2 |
| engine → worker | claim + 租约 | 执行由 claim + lease 驱动 | §5.6、§6.2 |
| engine → watchdog | 只读账本与 Journal | 只读输入集，不允许域写 | §15.2 |
| t0 → t1 | 四条判据 | 满足故障域/凭据域/扩缩容/运行时才拆 | §6、§6.2 |
| t1 → t15 | 实测命中 | 仅 Router 触发条件被实测命中才拆 | §10.3 |
| t15 → t2 | 跨机 + fencing | 节点注册、租约、fencing、CP 分区策略 | §6.3 |

### 映射说明

角色契约（含“明确禁止”）来自 §4.1；角色与进程非一对一来自 §4.3；T0/T1/T1.5/T2 的形状来自 §6.1–§6.3、§10.3。

---

## 3. `diagram.ticket-lifecycle.json` — 判定与工单时序

### 构图意图

用 lifecycle 表达 Eval 在策略变更下的有界处置：主路径 `queued → assessing → accepted`，分支 `pending-policy → reassess-queued → escalated/abandoned`。窗口、重判上限、lease generation 都挂在状态或转移上；工单侧规则（不中止、写 policy-changed、resume 前 revalidate）放在卡片，避免把两张状态机混在一张图里。

### 状态

| id | 类型 | 标注 | 章节 |
| --- | --- | --- | --- |
| queued | start | 可被 assessor 领取，≤ deadline | §13.2.1 |
| assessing | active | 租约持有，lease.eval · gen=n | §5.6、§13.2.1 |
| accepted | success | §5.3 全链通过后落库 | §5.3、§13.2.1 |
| ignored | neutral | 判定无需工作 | §5.3 |
| pending_policy | waiting | 前 5 步通过、版本不匹配；窗口 ≤ 30s | §13.2.1、§13.2.2 |
| reassess_queued | active | 按最新 policyVersion 重派，重判 ≤ 2 次 | §13.2.1、§13.2.2 |
| escalated | external | 上限用尽，转人工，不静默丢弃 | §13.2.2 |
| abandoned | failure | deadline/撤销 | §13.2.1 |

### 转移

| from → to | 标签 / note | 含义 | 章节 |
| --- | --- | --- | --- |
| queued → assessing | 领取 + 租约；记录 leaseId/generation | 领取时签发租约 | §5.6、T1 |
| assessing → accepted | 全链通过；§5.3 第 1–8 步顺序校验 | 唯一允许落库的路径 | §5.3 |
| assessing → ignored | outcome=ignore | 判定无需工作 | §5.3 |
| assessing → pending_policy | policyChanged；前 5 步必须已通过 | 第 6 步版本不一致 | §5.3、T2 |
| pending_policy → reassess_queued | 窗口关闭，未达上限 | 有界重判 | T4 |
| reassess_queued → assessing | 重派；新 leaseId，generation+1 | 旧代次写入 = leaseLost | §5.6、T6 |
| reassess_queued → escalated | 已达 2 次上限 | 转人工 | T5 |
| reassess_queued → abandoned | deadline / 撤销 | 明确放弃 | T7 |
| assessing → abandoned | 撤销 / 停止 | 释放租约 | T8 |

### 映射说明

状态机与转移编号来自 §13.2.1；30s 窗口与 2 次上限来自 §13.2.2（文档明确标〔判断，无实测基线〕）；lease/fencing 与 attempt 消歧来自 §5.6；工单侧规则来自 §13.2.3。

---

## 4. `diagram.domain-integration.json` — 领域系统接入

### 构图意图

左侧是账本与 Agent Runtime，中间是三个宿主中立端口，右侧是三个外部事实拥有者。`security-group` 边界包住 Decision 与 Work，标签同时写出“evidence 白名单在落库前强制”；KnowledgePort → Decision 画一条 `security` 边并标“禁止进入授权”，把“知识不授权”画成显式的禁止通道，而不是只写在卡片里。

### 节点

| id | 标签 | 类型 | 标注 |
| --- | --- | --- | --- |
| agentrt | Agent Runtime | cloud | 不直写账本 |
| decision | Decision 平面 | security | 禁止读知识 |
| work | Work 平面 | backend | 只存引用 |
| process_port | ProcessPort | backend | 能力声明 |
| knowledge_port | KnowledgePort | backend | 无写接口 |
| runstate_port | RunStatePort | backend | 可丢弃 |
| engine | 流程引擎 | external | 制度事实 |
| knowledge | 知识库 | external | 认知事实 |
| runstate | 过程状态存储 | database | 运行事实 |

### 边界

- `security-group`：「授权事实账本（单写者）· evidence 白名单在落库前强制」包住 decision、work。

### 边

| from → to | 标签 | 含义 | 章节 |
| --- | --- | --- | --- |
| engine → process_port | 任务 / signal | claim/complete/signal 经端口 | §20.6、§23.1 |
| process_port → work | 实例引用 | Ticket 只存 processInstanceId/taskId 与快照 | §3.2.1、§20.2 |
| decision → process_port | 只读定义 | 仅读流程定义判断是否需要人工审批 | §3.2.1 |
| knowledge → knowledge_port | 检索 | 只读检索，带 provenance | §21.3、§23.1 |
| knowledge_port → agentrt | 只读检索（带版本） | 执行侧可读知识，带 knowledgeVersion | §3.2.1、§21.3 |
| knowledge_port → decision | 禁止进入授权（security） | Decision 不得读知识 | §21.4 |
| runstate → runstate_port | 按 id 读写 | 运行状态按 runId 读写 | §22.2、§23.1 |
| runstate_port → agentrt | 等待 / 尝试 | Agent Runtime 经端口记录运行事实 | §3.2.1、§22.2 |

### 映射说明

三类事实与写者来自 §19.2；禁止清单来自 §19.3；缺席降级来自 §19.4；知识不授权与白名单来自 §21.4、§21.4.1；端口与 ACL 来自 §23.1。

---

## 交付边界

- 本目录不复用、不修改 `.archify/explainer-dsh-superagent-20261105-021749/`。
- 没有源码证据；每个语义项只对应设计文档章节。
- `diagram.domain-integration` 的自动化校验通过，但报告了 2 处路线交叉（advisory），按粗稿标准保留，不做第二轮布局打磨。
