# Super-Agent 目标架构 v2（按冻结版重画）

证据：`docs/drafts/super-agent-architecture-design.md`（冻结基线 HEAD `15a2422`）。全部节点/边只引用章节号，不含源码路径或行号。
图例：〔目标〕= 冻结版既定结构；〔待验证〕= 文档明确标为设想/待测/无基线。
标记：`*` = 该平面/实体自身事实的唯一写者。每张图含「已知缺口（P1 未落地，不是设计）」卡片。

## 1. `diagram.system-overview.json` — 五平面、授权写入与撤销级联

### 构图意图

主路径仍是 Event → Decision → Work → Delivery → Agent Runtime，Decision + Work 被“单写者账本”边界包住。新增两个侧栏：
- 左下：`HumanTask → ApprovalRecord(signal) → 账本校验 → Mandate`，明确 approve 不直连 Mandate；
- 下方：`revocation → 控制面单事务级联 → 执行端回执`，明确撤销不是策略收紧。

### 节点

| id | 标签 | 类型 | 标注 |
| --- | --- | --- | --- |
| event | Event 平面 | messagebus | 自身事实唯一写者 |
| decision | Decision 平面 | security | Decision* / Mandate* |
| work | Work 平面 | backend | 不拥有授权 |
| delivery | Delivery 平面 | messagebus | 不改业务事实 |
| agentrt | Agent Runtime | cloud | 运行时适配层 |
| human_task | HumanTask | database | 控制面唯一写；审批任务 |
| approval_record | ApprovalRecord | security | append-only signal，不产生 Mandate |
| ledger_check | 账本校验 | security | 主体/角色/时间/范围/职责分离 |
| mandate | Mandate 签发 | security | 账本是唯一授权来源 |
| revocation | revocation 消息 | external | 幂等键 (tenantId, revocationId) |
| rev_cascade | 控制面单事务级联 | security | 不是策略收紧 |
| rev_stop | 执行端回执 | backend | stopped / stopFailed；超 SLA → unresponsive |

### 边

| from → to | 标签 | 含义 | 章节 |
| --- | --- | --- | --- |
| event → decision | 只读候选 + 版本 | 准入只读事件事实 | §3.2、§5.3 |
| decision → work | 单事务写入 | Decision/Mandate/Ticket/首 Assignment | §5.3、§20.3 |
| work → delivery | 派发 effect | 工作平面只发请求 | §3.2 |
| delivery → agentrt | 投递 + 能力 | 按能力声明投递 | §5.4 |
| agentrt → work | 报告只回交 | 不直写域表 | §3.2、§5.3 |
| work → human_task | 建审批任务 | Ticket awaiting-approval 时创建 | §5.8、§20.3 |
| human_task → approval_record | 只写记录 | approve 只追加 signal | §5.8 |
| approval_record → ledger_check | signal | 进入账本校验 | §5.8 |
| ledger_check → mandate | 校验签发 | 通过才签发 Mandate | §5.8、§20.3 |
| revocation → rev_cascade | T8 ⓪ | 撤销入口 | §5.7 |
| rev_cascade → rev_stop | stop | 下发 stop effect | §5.7 |
| decision → rev_cascade | 编排撤销 | 控制面编排单事务级联 | §5.7 |

### 卡片

唯一契约通道（§3.2）；审批只产生信号（§5.8、§20.3）；撤销级联五项动作（§5.7）；已知缺口 6 项。

## 2. `diagram.role-topology.json` — 角色、进程边界、Lease 与 HumanTask

### 构图意图

上半部保留三类进程边界（控制面 / 执行面 / Watchdog），新增 Lease 与 HumanTask 两个独立实体节点及各自的安全边界。执行面回报走外侧回环，体现“报告不直写”。下半部 T0→T1→T1.5→T2 升级链保持不变。

### 节点

| id | 标签 | 所在边界 | 标注 |
| --- | --- | --- | --- |
| source | Source Adapter | 控制面进程 | 只写 Trigger 与游标 |
| engine | Engine | 控制面进程 | 授权事实单写者 + 租约服务 |
| router | Router | 控制面进程 | T1 默认合进程 |
| assessor | Assessor | 无（可缺席） | 只产判断 |
| worker | Worker / Executor | 执行面进程组 | 可多节点 |
| watchdog | Watchdog | 只读观察者进程 | 禁止任何域写 |
| lease | Lease（唯一实体） | 租约服务边界 | active/released/expired/revoked；generation 是 fence |
| human_task | HumanTask | 人工队列边界 | open/claimed/decided/expired/cancelled |
| t0/t1/t15/t2 | 四档部署形态 | 无 | 起点/默认目标/按需/异构 |

### 边界

- `region`：控制面进程（T0 单进程；T1 默认合进程）。
- `region`：执行面进程组（T1 起必须独立）。
- `region`：只读观察者进程（必须独立）。
- `security-group`：租约服务（控制面唯一写）。
- `security-group`：人工队列（控制面唯一写）。

### 边

| from → to | 标签 | 含义 | 章节 |
| --- | --- | --- | --- |
| source → engine | 事件 | Source 只交事件与游标 | §4.1 |
| engine → router | 只读视图 | Router 不写域表 | §4.2、§6.2 |
| router → assessor | 请求 / 结果 | 判定两段式 | §5.3、§10.2 |
| engine → worker | claim + 租约 | 执行由 claim+lease 驱动 | §5.6、§6.2 |
| engine → watchdog | 只读 | 只读账本与 Journal | §15.2 |
| engine → lease | 唯一写者 | 签发/续租/回收 | §5.6 |
| engine → human_task | 创建 / 终结 | 控制面唯一写 | §5.8 |
| worker → engine | 报告，不直写 | 回报经控制面校验 | §3.2、§5.3 |
| t0 → t1 | 四条判据 | 拆执行面 | §6.2 |
| t1 → t15 | 实测命中 | 仅 Router 条件命中才拆 | §10.3 |
| t15 → t2 | 跨机 + fencing | 节点注册/租约/fencing | §6.3 |

### 卡片

必须隔离（§4.3、§6.2、§6.3）；Lease 字段与 fence（§5.6）；HumanTask generation（§5.8）；终态不变量（§13.2.1）；已知缺口 6 项。

## 3. `diagram.ticket-lifecycle.json` — Eval 状态 × 出口（按冻结矩阵）

### 构图意图

主路径 `queued → assessing → T10 写入闸门 → accepted`。T10 是转移，不是状态；本图以“写入闸门”节点表达，保证 `accepted` 只有一条入边。人工 T5b 画成 `escalated --T5b--> T10 --> accepted`，不画平行入边。其余状态作为分支放在主路径下方。

### 状态

| id | 类型 | 标注 | 章节 |
| --- | --- | --- | --- |
| queued | start | 未领取，无 Eval.deadline；⓪T8/①T12 前置 | §13.2.1 |
| assessing | active | 租约持有，lease.generation = n | §5.6、§13.2.1 |
| t10_gate | decision | accepted 的唯一写入者 | §13.2.1 |
| accepted | success | Decision/Mandate/Ticket/首 Assignment | §13.2.1 |
| ignored | neutral | 终判原因见卡片 | §13.2.1 |
| pending_policy | waiting | 前 5 步 + 6① 通过；窗口 ≤ 30s〔判断〕 | §13.2.2 |
| reassess_queued | active | 按最新目标版本重派；≤ 2 次〔判断〕 | §13.2.2 |
| escalated | external | 同事务建 HumanTask；SLA 到期先于人工决策 | §13.2.2 |
| abandoned | failure | 六类原因码 | §13.2.1 |

### 状态 × 出口（T1–T12）

| 状态 | 出口（按优先级 ⓪ → ④ 求值，首个命中即执行） |
| --- | --- |
| queued | ⓪T8 撤销 → abandoned；①T12 取消 → abandoned；②T7b 排队超时 → abandoned；③T1a 版本刷新（同态）；④T1 领取 → assessing |
| assessing | ⓪T8；①T12；②T9 二次违规 → escalated；③T2 policyChanged → pending-policy；④T10 accept → T10 → accepted；④T11 ignore/unavailable/stop/prior → ignored |
| pending-policy | ⓪T8；①T12；②T3 窗口内新版本（同态）；③T4 关窗 → reassess-queued；④T5 预算/上限 → escalated；④T4b 租约丢失 → escalated |
| reassess-queued | ⓪T8；①T12；②T7 超 deadline → abandoned；③T6b 版本刷新（同态）；④T6 领取 → assessing |
| escalated | ⓪T8；①T12；②T5c SLA expired → abandoned；③T5b 人工 accept（经 1–8）→ T10 → accepted；③T5c 人工 reject → abandoned；④T5d 重判 → reassess-queued；④T5e 放弃 → abandoned |
| accepted / ignored / abandoned | 无出口（终态） |

同态出口 T1a / T3 / T6b 因 lifecycle 宽度预算未画自环边，在「求值规则与优先级」卡片中完整保留，语义不删。

### 转移

| from → to | 标签 | 章节 |
| --- | --- | --- |
| queued → assessing | ④ T1 领取 | §13.2.1 |
| queued → abandoned | ② T7b 超时 | §13.2.1 |
| assessing → t10_gate | ④ T10 通过 | §13.2.1 |
| t10_gate → accepted | 单事务写入 | §13.2.1 |
| assessing → ignored | ④ T11 终判 | §13.2.1 |
| assessing → escalated | ② T9 违规 | §13.2.1 |
| assessing → pending_policy | ③ T2 版本变更 | §13.2.1 |
| pending_policy → reassess_queued | ③ T4 关窗 | §13.2.2 |
| pending_policy → escalated | ④ T5 / T4b | §13.2.2 |
| reassess_queued → assessing | ④ T6 领取 | §13.2.1 |
| reassess_queued → abandoned | ② T7 超期 | §13.2.1 |
| escalated → t10_gate | ③ T5b 人工 accept | §13.2.1、§5.3 |
| escalated → abandoned | ②③ T5c | §13.2.2 |
| escalated → reassess_queued | ④ T5d | §13.2.2 |
| escalated → abandoned | ④ T5e | §13.2.2 |
| queued/assessing/pending/reassess/escalated/t10 → abandoned | ⓪T8/①T12（六条全局边） | §13.2.1、§5.7 |

### 卡片

求值规则与优先级（§13.2.1、§13.2.2）；accepted 唯一写入者与 T5b（§5.3、§5.8、§13.2.1）；两段时长与工单侧（§13.2.1、§13.2.2、§13.2.3）；已知缺口 6 项。

## 4. `diagram.domain-integration.json` — 领域系统接入与知识不授权

### 构图意图

结构沿用第一版：左侧账本与 Agent Runtime、中间三端口、右侧三事实拥有者；KnowledgePort → Decision 仍画成显式禁止边。新增“人工 evidence 同样走白名单”与已知缺口卡片。

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

### 边

| from → to | 标签 | 含义 | 章节 |
| --- | --- | --- | --- |
| engine → process_port | 任务 / signal | claim/complete/signal | §20.6 |
| process_port → work | 实例引用 | 只存实例/任务引用与快照 | §3.2.1、§20.2 |
| decision → process_port | 只读定义 | 读定义版本判断审批 | §3.2.1 |
| knowledge → knowledge_port | 检索 | 只读 + provenance | §21.3 |
| knowledge_port → agentrt | 只读检索（带版本） | 执行侧可读，带版本 | §3.2.1、§21.3 |
| knowledge_port → decision | 禁止进入授权 | security 边 | §21.4 |
| runstate → runstate_port | 按 id 读写 | 运行状态 | §22.2 |
| runstate_port → agentrt | 等待 / 尝试 | 经端口记录运行事实 | §3.2.1、§22.2 |

### 卡片

三类事实与写者（§19.2、§20.5、§21.2、§22）；知识不授权与人工 evidence 白名单（§5.8、§21.4）；缺席与降级（§19.4、§21.3、§22.3）；已知缺口 6 项。
