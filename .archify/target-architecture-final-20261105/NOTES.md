# 最终版（final）：审计修复、v1.0 对照与已知取舍

结论：**可作评审依据**。四张图 `validate / deliver / check / browser-check` 全 pass、`diagnostics = 0`；F1–F5 全部落实，三条事实性错误已消除。

证据基线：`docs/drafts/super-agent-architecture-design.md` 的 v1.0（审计基线 HEAD `2f8e62e`；当前仓库 HEAD `55bafba`，所引章节内容一致）。图中只出现章节号，无源码路径/行号。

## 1. F1–F5 修复记录

| 编号 | 问题 | 改了哪张图的哪个节点/边 |
| --- | --- | --- |
| F1 | 「已知缺口」按旧基线写，6 条中 4 条已被 v1.0 设计 | 四张图的「已知缺口」卡片统一重写为 5 条，每条带章节号：索引与分区（§1.3/§8.2）、T2 未发布/迁移未验证（§6.3）、outbox+relay 路径 B 未实现（§7-D1）、成本/容量数值未压测（§15.4）、SLO 未实测（§15.4）。删除“迁移缺失”“断路器缺失”“SLO 无数值”“降级矩阵漏控制面依赖” |
| F2 | `escalated → abandoned` 单条 `②③ T5c` 合并两件事 | ticket-lifecycle：删除合并边，新增 `t5c-timeout`（`② 超时→escalation_timeout`，security）与 `t5c-reject`（`③ reject→human_rejected`），原因码分开 |
| F3 | `global-t10` 不存在；T10 被当作状态；三条全局边同路径 | ticket-lifecycle：删除全部 `global-*`（含 `global-t10`）；`t10_gate` 标签改为「转移：写入闸门（T10）」、sublabel「不是生命周期状态；accepted 的唯一写入者」、tag「T10 是转移」；新增 `nonterminal`（「所有非终态 / T8-T12 源集合，不是状态」）并汇成一条 `⓪T8/①T12` 边 |
| F4 | 自环省略导致编号跳号（①③④） | ticket-lifecycle：不加自环边；按状态重排连续编号（queued ①②、assessing ①②③④、pending ①②、reassess ①②、escalated ②③③④④）；`queued` / `pending-policy` / `reassess-queued` 的 tag 加 `↻` 徽章；「求值规则与优先级」卡片与图例说明 ↻ = 被省略的同态刷新（T1a/T3/T6b） |
| F5 | Lease / HumanTask 两条不变量未上图 | role-topology 的「Lease 与 HumanTask 各自是实体」卡片：Lease `expiresAt ≤ Eval.deadline`（签发取 min；`now > deadline` 拒绝签发）（§5.6、§13.2.1）；HumanTask `expired` 唯一写入者=控制面超时扫描（周期 30s、幂等键含 generation）、三类 SLA 4h / 24h / 24h（§5.8） |

## 2. v1.0 对照表（逐条裁定）

| 原缺口 | 裁定 | 依据 |
| --- | --- | --- |
| DB outbox + relay（队列与 DB 事务未结合） | **仍未做，保留**：文档只给出“正确性条件”与路径选择，路径 B 未实现 | §7-D1（路径 B 标〔目标〕〔待验证〕） |
| T1→T2 迁移 / 双跑 / 回滚缺失 | **已设计，保留为“未验证”**：迁移/双跑/回滚的纸面规则已在 §6.3，但 T2 未发布、整表标〔目标〕〔待验证〕 | §6.3 |
| 成本与容量断路器缺失 | **已设计，删除“缺失”**：三类断路器与默认值已有；只保留“数值未压测验证” | §15.4（标〔目标〕〔待验证〕） |
| SLO 无数值 | **已设计，删除“无数值”**：目标数值已有；只保留“未实测固化” | §15.4（明写“数值须实测后固化”） |
| 索引与分区未定 | **仍未做，保留**：明确不做具体索引与迁移脚本，待写清单也未列 | §1.3、§8.2 |
| 降级矩阵漏控制面依赖 | **已设计，删除**：控制面依赖降级矩阵六行（DB / Effects / 模型 / SessionController / 凭据 / 时钟）已存在 | §19.4 |

保留的 5 条缺口均满足“文档明确说了它还没做”，无“疑似缺失”措辞；四条图中同一份卡片，消除 v2 的 domain 页自相矛盾。

## 3. 已知取舍

1. **单图不拆（21 处交叉 → 本轮 11 处已解决交叉）。** lifecycle 仍是一张图，未按状态族拆成多图。代价是分支区（尤其 `abandoned` 多入边与 `escalated` 五出口）存在交叉与绕行；这是**单图可读性的代价，不是遗漏**。拆图会丢失“同状态按序求值、首个命中即执行”的整体顺序感。
2. **自环省略。** T1a / T3 / T6b 是同态刷新，画自环会把 lifecycle 宽度推到 1468px（预算 1270px）。本轮不加自环边，改由状态 tag 的 `↻` 徽章 + 「求值规则与优先级」卡片承载；语义完整保留。风险：不看卡片的读者可能低估刷新出口的存在感。
3. **T10 用闸门节点表达。** T10 在矩阵里是转移而非状态；为表达“`accepted` 唯一写入者”且不画 `escalated` 与 `assessing` 两条平行入边，画成「转移：写入闸门（T10）」节点。风险：读者可能误读为第 9 个生命周期状态——已用 label、sublabel、tag 三处明示“是转移”。
4. **T8/T12 用一条源集合边。** 以 `nonterminal`（“所有非终态 / 源集合，不是状态”）汇成一条 `⓪T8/①T12` 边，替代 v2 的六条全局边。风险：源集合节点本身不是状态，已在 label/sublabel 与卡片注明。
5. **T5 与 T4b 仍合并一条边**（同源同宿、同为 ②，原因码放卡片）。未在本轮拆开，因为审计只点名 T5c。
6. **Ticket 审批三态（awaiting-approval / approval-rejected / cancelled）未画进 lifecycle**：§13.2.1 矩阵是 Eval 状态，混画 Ticket 状态会破坏矩阵语义；改在 system-overview 审批卡片与 candidate 说明。
7. **Lease 与 HumanTask 各自独立边界**：强行同框会误包 Assessor，造成错误归属。

## 4. 图 → 章节映射表

| 图 | 关键内容 | 章节 |
| --- | --- | --- |
| system-overview | 五平面、单写者、契约通道 | §3.1、§3.2、§3.3 |
| system-overview | Decision 同事务写 Ticket/Assignment | §5.3 |
| system-overview | 审批 signal 与 Mandate（approve 不直连） | §5.8、§20.3 |
| system-overview | 撤销级联（不是策略收紧） | §5.7 |
| role-topology | 角色契约、进程边界、隔离 | §4.1、§4.3、§6.1–§6.3 |
| role-topology | Lease 实体、fencing、`expiresAt ≤ deadline` | §5.6、§13.2.1 |
| role-topology | HumanTask 实体、唯一 expired 写者、三类 SLA | §5.8 |
| role-topology | T1.5 触发 | §10.3 |
| ticket-lifecycle | 状态 × 出口矩阵、优先级、T5c 两原因码 | §13.2.1、§13.2.2 |
| ticket-lifecycle | 窗口、重判上限、SLA/人工 | §13.2.2 |
| ticket-lifecycle | 工单不中止、resume revalidate | §13.2.3 |
| ticket-lifecycle | T5b 与 evidence 白名单 | §5.3、§5.8 |
| ticket-lifecycle | T8 撤销语义 | §5.7 |
| domain-integration | 三类事实与写者 | §19.2、§20.5、§21.2、§22 |
| domain-integration | 禁止清单、缺席降级矩阵（六行已设计） | §19.3、§19.4 |
| domain-integration | 领域端口与 ACL | §20.6、§23.1 |
| domain-integration | 知识不授权与白名单 | §21.4 |

## 5. 校验与 advisory（如实列出）

四张图四道门禁全 pass，`diagnostics = 0`。

| 图 | advisory |
| --- | --- |
| system-overview | 0 交叉；1 条绕行：`decision → rev_cascade` 3 个弯、stretch 1 |
| role-topology | 2 处交叉：`router→assessor × engine→worker`、`engine→worker × engine→lease`；2 条绕行：`engine→lease` 3 弯 1.07、`worker→engine` 4 弯 2.517；提示 engine 右侧 5 条关系、端口建议 ≥ 88px |
| ticket-lifecycle | 11 处已解决交叉（明细列表 truncated=true，artifact 列出 8 处，集中在 `abandoned` 多入边与 `escalated` 五出口）；1 条绕行：`t7` 2 弯 1.351 |
| domain-integration | 2 处交叉：`process→work × knowledge→agentrt`、`process→work × knowledge→decision` |

以上按用户明确要求保留（21 处交叉/绕行、单图结构不改），未为减少告警删改语义。

## 6. 边界声明

- 未读取 `src/`，未 grep 源码，图中无源码路径/行号；证据只指章节号。
- 未复用、未修改 `.archify/explainer-dsh-superagent-20261105-021749/`。
- 未覆盖对照目录 `.archify/target-architecture-draft-20261105/` 与 `.archify/target-architecture-v2-20261105/`。
- 本目录只含最终版 4 JSON、4 HTML、4 组 finalize 回执、`candidate.archify.md`、`NOTES.md`。
