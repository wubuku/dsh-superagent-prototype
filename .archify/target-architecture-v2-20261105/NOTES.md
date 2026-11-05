# v2 与 v1 的差异、取舍与校验

## 与第一版的实质差异

### 1. `diagram.system-overview`

| 变化 | 内容 | 原因 |
| --- | --- | --- |
| 新增 | HumanTask / ApprovalRecord / 账本校验 / Mandate 四个节点与三条边 | §5.8、§20.3：approve 只写 append-only signal；Mandate 由账本校验后签发 |
| 新增 | revocation / 控制面单事务级联 / 执行端回执 三节点与三条边 | §5.7：撤销是控制面单事务级联，不是策略收紧 |
| 新增 | 「已知缺口」卡片 | 本轮硬性要求 |
| 未改 | 五平面主路径、Decision+Work 单写者边界、报告回交 | 冻结版未改变这些结构 |

### 2. `diagram.role-topology`

| 变化 | 内容 | 原因 |
| --- | --- | --- |
| 新增 | Lease 节点 + 独立安全边界 | §5.6：Lease 是唯一实体，state 四值、generation 是 fence |
| 新增 | HumanTask 节点 + 独立安全边界 | §5.8：open/claimed/decided/expired/cancelled，独立 generation |
| 新增 | engine → lease、engine → human_task、worker → engine 三条边 | 表达控制面唯一写与报告回交 |
| 新增 | 终态不变量卡片 | §13.2.1：写终态前断言无 active 租约；T8 置 revoked、T12 置 expired |
| 未改 | 三类进程边界、四档升级链 | 冻结版未改变 |

### 3. `diagram.ticket-lifecycle`

| 变化 | v1 | v2 | 原因 |
| --- | --- | --- | --- |
| 状态 | 8 个（含直接入 accepted 的路径） | 9 个节点，其中 T10 为写入闸门节点 | §13.2.1：accepted 唯一写入者是 T10，不能画两条平行入边 |
| 转移 | 9 条，从正文推断 | 21 条，按矩阵 | §13.2.1 状态 × 出口矩阵 |
| 人工 | 无 T5b 路径 | `escalated --T5b--> T10 --> accepted` | §13.2.1、§5.8：人工 accept 必须经 1–8 校验 |
| 撤销/取消 | 一条 `assessing --撤销/停止--> abandoned` | 六条 `⓪T8/①T12` 全局边 + 独立 T11 stop | §13.2.1：T8/T12 高于本地出口；stop 属于 T11，不是撤销 |
| escalated | 只有 `上限用尽` | 五个出口：T5c expired / T5b / T5c reject / T5d / T5e | §13.2.2 |
| queued | 只有领取/超时 | 增加 T7b 超时优先、T1a 版本刷新 | §13.2.1：T7b ② 先于 T1a ③ 与 T1 ④ |
| 优先级 | 无 | 每条边带 ⓪–④，并保留完整求值顺序卡片 | §13.2.1：同状态按序求值、首个命中即执行 |
| 缺口 | 无 | 「已知缺口」卡片 | 本轮硬性要求 |

### 4. `diagram.domain-integration`

| 变化 | 内容 | 原因 |
| --- | --- | --- |
| 新增 | “人工 evidence 同样走白名单”卡片条目 | §5.8、§21.4 |
| 新增 | 「已知缺口」卡片 | 本轮硬性要求 |
| 未改 | 三端口结构、KnowledgePort → Decision 禁止边 | 冻结版未改变 |

## 图 → 章节映射表

| 图 | 关键内容 | 章节 |
| --- | --- | --- |
| system-overview | 五平面、单写者、契约通道 | §3.1、§3.2、§3.3 |
| system-overview | Decision 同事务写 Ticket/Assignment | §5.3 |
| system-overview | 审批 signal 与 Mandate | §5.8、§20.3 |
| system-overview | 撤销级联 | §5.7 |
| role-topology | 角色契约、进程边界、隔离 | §4.1、§4.3、§6.1–§6.3 |
| role-topology | Lease 实体与 fencing | §5.6 |
| role-topology | HumanTask 实体 | §5.8 |
| role-topology | 终态租约不变量 | §13.2.1 |
| role-topology | T1.5 触发 | §10.3 |
| ticket-lifecycle | 状态 × 出口矩阵、优先级 | §13.2.1 |
| ticket-lifecycle | 窗口、重判上限、SLA/人工 | §13.2.2 |
| ticket-lifecycle | 工单不中止、resume revalidate | §13.2.3 |
| ticket-lifecycle | T5b 与 evidence 白名单 | §5.3、§5.8 |
| ticket-lifecycle | T8 撤销语义 | §5.7 |
| domain-integration | 三类事实与写者 | §19.2、§20.5、§21.2、§22 |
| domain-integration | 禁止清单、缺席降级 | §19.3、§19.4 |
| domain-integration | 领域端口与 ACL | §20.6、§23.1 |
| domain-integration | 知识不授权与白名单 | §21.4、§21.4.1 |

## 画图时不得不做的取舍

1. **T10 画成节点**：矩阵里 T10 是转移，不是状态。为表达“accepted 唯一写入者 + 人工 T5b 不直连”，画成 `T10 写入闸门` 节点，并在图头注明“T10 是转移，图中以闸门表示”。这是图元层妥协，不是新增状态。
2. **自环不出边**：T1a / T3 / T6b 是“同态刷新”。画成自环时 lifecycle 宽度 1468px > 1270px 预算，finalize 直接失败。改为在「求值规则与优先级」卡片中完整保留，语义未删，图上没有自环箭头。
3. **T5 与 T4b 合并一条边**：同源同宿、优先级同为 ④，不同原因码放卡片；否则产生并列边。
4. **T5c 两个出口合并**：expired ② 与 reject ③ 同宿 abandoned，合并为 `②③ T5c`，具体原因码放卡片。
5. **T8/T12 用六条全局边**：没有“任意非终态”这种合法图元，只能每个非终态各画一条 `⓪T8/①T12`；这直接导致 lifecycle 的交叉告警。
6. **Ticket 审批三态未画成状态节点**：`awaiting-approval / approval-rejected / cancelled` 写在 system-overview 审批卡片与 candidate 中；lifecycle 的 8 态矩阵本身不含 Ticket 状态，混画会破坏矩阵语义。
7. **Lease 与 HumanTask 分两个边界**：两者不在同一紧凑矩形内；强行同框会把 Assessor 框进去，产生错误归属。

## 校验与 advisory（如实列出）

四张图 `validate / deliver / check / browser-check` 全 pass，`diagnostics = 0`。

| 图 | advisory |
| --- | --- |
| system-overview | 0 交叉；1 条绕行：`decision → rev_cascade` 3 个弯，stretch 1 |
| role-topology | 2 处交叉：`router→assessor × engine→worker`、`engine→worker × engine→lease`；2 条绕行：`engine→lease` 3 弯、`worker→engine` 4 弯 stretch 2.517；提示 engine 右侧有 5 条关系、端口建议 ≥ 88px |
| ticket-lifecycle | 21 处已解决交叉、2 条绕行（`T7` stretch 1.421、`global-reassess` stretch 1.356），advisory 列表 truncated=true |
| domain-integration | 2 处交叉：`process→work × knowledge→agent`、`process→work × knowledge→decision` |

以上均按粗稿标准保留，未做第二轮布局打磨；语义未因减少告警而删改。

## 边界声明

- 未读取 `src/`，未 grep 源码，未在图中出现源码路径/行号。
- 未复用、未修改 `.archify/explainer-dsh-superagent-20261105-021749/`，也未覆盖第一版 `.archify/target-architecture-draft-20261105/`。
- 仅新增 `.archify/target-architecture-v2-20261105/` 下的 4 份 JSON、4 个 HTML、candidate、NOTES 与 finalize 回执。
