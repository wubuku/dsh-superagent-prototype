# 目标架构粗稿：构图取舍与映射

## 结论

- 交付 4 张图（未砍到 3 张）：五平面总览、角色与进程拓扑、判定/工单时序、领域系统接入。
- 4 份 JSON 均通过 `finalize` 的 validate / deliver / check / browser-check，`diagnostics = 0`，产出 4 个可直接打开的 HTML。
- 这是构图验证级粗稿：没有做第二轮布局美化，没有改用例、没有追加章节。

## 画了什么

| 图 | 构图选择 | 主要章节 |
| --- | --- | --- |
| system-overview | 五平面排成一条主路径；Decision + Work 用边界包成“单写者账本”；Assessor 单列，强调只产判断 | §3.1、§3.2、§3.3、§5.3、§5.4 |
| role-topology | 上半部画三类进程边界（控制面/执行面/Watchdog）；下半部用 T0→T1→T1.5→T2 链条表达部署形态 | §4.1、§4.3、§6.1–§6.3、§10.3 |
| ticket-lifecycle | 主路径只留 queued→assessing→accepted；policy 分支与重判/升级画在主路径下方 | §5.6、§13.2.1、§13.2.2、§13.2.3 |
| domain-integration | 左侧账本与 Runtime、中间三端口、右侧三系统；KnowledgePort→Decision 画成显式禁止边 | §3.2.1、§19.2–§19.4、§20.6、§21.4、§22、§23.1 |

## 故意没画

| 内容 | 理由 |
| --- | --- |
| 每个平面的完整字段表（Event 信封、Delivery 行、Mandate 字段） | 属于协议细节，画进节点会变成字段清单，不再是架构图；留在 §5 文档 |
| §5.3 的 8 步校验链逐步展开 | 图里只保留“全链通过”与“第 6 步 policyChanged”两个位置，避免把时序图画成检查清单 |
| §5.3 第 1–5 步的每种失败码 | 粗稿不追求协议枚举完整；失败码在 candidate 表格与文档里 |
| T0/T1 的完整进程内模块图 | 与“目标架构”定位冲突；只保留四档形态与必须隔离的角色 |
| 节点注册表、配额、CP 网络分区策略的细节 | §6.3 的 T2 新增要求较多，图上只保留“跨机 + fencing”一条升级边，细节在卡片/文档 |
| Watchdog 的三张输出表逐项 | 只画角色与只读通道；字段在 §15.2 |
| 人工审批（ApprovalRecord）与工单的完整关系 | 属 §20.3 的领域接入细节，粗稿只用 `process_port → work` 与卡片表达 |
| 知识提案/评审/撤回全流程 | 属 §21.2，画进图会与“知识不授权”主线抢焦点 |
| 任何源码文件、行号、〔原型〕证据 | 按本轮边界，代码考古禁止；图只标〔目标〕/〔待验证〕 |

## 语义仍不确定的地方

1. **`escalated` 的形态**：文档明确说它在原型不存在、属〔设想〕（§5.3、§13.2.2）；图中按“转人工的外部等待态”画，是否应算 failure 或 waiting 仍未定。
2. **Assessor 与 Router 的关系**：§4.1 把 Router 描述为评估入口、Assessor 为独立角色；§4.3 又说 T0/T1 的 Assessor 可以是 Router 内逻辑或独立进程。图中在 system-overview 里只画 Assessor，在 role-topology 里把 Router 放控制面、Assessor 放控制面外，避免断言“Assessor 一定在 Router 内”。
3. **Delivery 行的所有权**：§3.2 把 Delivery 行归 Event 平面唯一写者，Delivery 平面拥有 Delivery 状态；图中节点标签分别写“Delivery 行*”和“Delivery 状态*”，但没有画两平面之间的写入边——这是文档本身需要进一步澄清的点。
4. **30s 窗口与 2 次上限**：文档明确标〔判断，无实测基线〕（§13.2.2）；图中作为标签呈现，不代表已测量。
5. **T1.5 的独立性**：§10.3 的触发条件是“实测命中才升级”，图中只画升级链，没有画触发阈值（文档也明确说阈值待测）。
6. **知识库节点类型**：用 `external` 表示“外部事实拥有者”，不表示部署位置；文档未定具体选型（§19.5、§24.1）。

## 图 → 文档章节映射表

| 图 | 元素 | 章节 |
| --- | --- | --- |
| system-overview | 五平面职责与事实所有权 | §3.2 |
| system-overview | 不新增第六平面、调度在 Work 内 | §3.1、§3.3 |
| system-overview | 单写者 / Version / 不突变三条约束 | §3.2 |
| system-overview | Decision 同事务写 Ticket 与首 Assignment | §5.3 第 8 步 |
| system-overview | Assessor 结果两段式 | §5.3、§10.2 |
| system-overview | 能力声明与显式降级 | §5.4 |
| role-topology | 角色契约与禁止动作 | §4.1 |
| role-topology | 角色与进程非一对一 | §4.3 |
| role-topology | T0 单进程、T1 三故障域、T2 跨机 | §6.1、§6.2、§6.3 |
| role-topology | T1.5 触发条件 | §10.3 |
| role-topology | Watchdog 只读输入与禁止动作 | §15.2 |
| ticket-lifecycle | 状态集合与转移 T1–T8 | §13.2.1 |
| ticket-lifecycle | 合并窗口 30s、重判上限 2 次 | §13.2.2 |
| ticket-lifecycle | 幂等键（重判/判定/合并/工单标记） | §13.2.3 |
| ticket-lifecycle | Lease 唯一实体、generation 是 fence | §5.6 |
| ticket-lifecycle | 工单不中止、resume 前 revalidate | §13.2.3 |
| domain-integration | 五平面 × 三类系统读写矩阵 | §3.2.1 |
| domain-integration | 三类事实与写者 | §19.2 |
| domain-integration | 禁止清单 | §19.3 |
| domain-integration | 缺席与降级 | §19.4 |
| domain-integration | Agent-friendly API 与能力声明 | §20.6 |
| domain-integration | 知识不授权与 evidence 白名单 | §21.4、§21.4.1 |
| domain-integration | 过程状态最小结构与重建 | §22.2、§22.3 |
| domain-integration | 三个端口与 ACL | §23.1 |

## 校验状态

| 图 | validate | deliver | check | browser-check | diagnostics |
| --- | --- | --- | --- | --- | --- |
| system-overview | pass | pass | pass | pass | 0 |
| role-topology | pass | pass | pass | pass | 0 |
| ticket-lifecycle | pass | pass | pass | pass | 0 |
| domain-integration | pass | pass | pass | pass | 0 |

`domain-integration` 的 finalize 回执带 advisory：2 处路线交叉（`process_port → work` 与两条 KnowledgePort 出边）。按粗稿标准保留，未做第二轮布局修复。

## 边界声明

- 未读取 `src/`，未 grep 源码，未标注任何源码路径/行号。
- 未复用、未修改 `.archify/explainer-dsh-superagent-20261105-021749/`。
- 仅新增 `.archify/target-architecture-draft-20261105/` 下的候选、HTML 与回执。
