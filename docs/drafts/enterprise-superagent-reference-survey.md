# 企业级 Super-Agent：参考项目综述（入口/索引）

> **性质**：考察综述与入口，不是设计文档。它回答一个问题：**为了规划企业级 Super-Agent，我们考察过哪些项目、各自证明了什么、空位在哪**。每节的深入材料都给指针；设计结论以《企业级 Super-Agent 架构设计》（`enterprise-superagent-architecture.md`，下称「架构文档」）为准，讨论过程以会话备忘（`enterprise-superagent-session-notes.md`，下称「备忘」）为准。
>
> **基线**：各仓库以 2026-11-07 前后的 HEAD 为准（逐项标注）；事实全部经代码/文档核对，[文档] 与 [代码] 分开标注的部分在各自报告里。

## 0. 考察要回答的三个问题

本设计的坐标系是三类事实（架构文档 §0.2）：**制度事实**归 BOS、**认知事实**归 Spring-AI-RAG、**运行事实**由本项目以「编排事实」自持；外加一块**没有任何承载者**的能力——执行节点（结论 14）。考察参考项目，是为了回答：

1. **承载**：三个既有系统各自把哪类事实承载到什么程度？
2. **先例**：通道（C1–C9）、沙箱/任务域、账本（对账/重启/幂等）有没有生产级实现可参照？
3. **空位**：哪些东西考察了一圈之后确认**必须自建**？

## 1. 总表

| 项目 | 许可 / 形态 | 在本设计中的位置 | 一句话结论 |
| --- | --- | --- | --- |
| **BOS** | 私有仓库（Wubuku） | **制度事实承载者**——我们只消费（结论 7） | Agent-Friendly API（MCP）成熟，版本/审批/对账齐备；直接接 |
| **Spring-AI-RAG** | 私有仓库（Wubuku） | **认知事实承载者** | 检索/代际可信断言扎实；责任人模型、写入生产线、KG 未实施（第 9 章补） |
| **BlueCortex CE/EE** | 私有仓库（Blueforce） | **参与者的跨会话记忆**——不是协作状态（结论 86） | Claude-Mem 的 Java 移植；EE 多租户落地；缺代际与 fencing |
| **DSH Super-Agent 原型** | 本仓库（研究原型） | **被借鉴的对象**：七项照抄、四项不继承（第 10 章） | 单进程单写者的主动式 agent；任务域/BYOM 为零 |
| **设计文章**（DeepSeek，2026-10-31） | 归档可检索 | **被借鉴的框架**；BYOM = Bring Your Own Machine | 提出脑手分离与四条设计因素；无实现 |
| **HarnessRouter / UHP** | 开源（协议开放） | **C 类通信的候选协议**（§11.2） | 调用方↔Server 契约；任务域信封明文 out of scope |
| **Comma**（AFK-surf） | AGPL-3.0 + 自托管 | **送达语义与验证强度的参照** | 个人助理级完整落地；企业级编排层未及 |
| **OpenMausBot** | Apache 2.0 + enterprise 层 | **委派运行时与 C1 通道的参照** | 多 agent 委派生产级；无准入链/任务域焚毁/组织治理 |

## 2. 三个承载者（既有系统）

### 2.1 BOS —— 制度事实

- **已核实**：Flowable 在防腐层之后（provider key 一律不透明）；Agent-Friendly API 六条性质；MCP 面上「起草/校验/编译/审批/发布/领取/上下文读取/结果提交/对账/人审」**十个动作分离**（`backend/src/main/resources/mcp/guides/common-v1.md:7`，且「Never infer approval from a chat message」）；版本化用不可变 pin + generation；三态对账（`UNKNOWN`/`RECONCILING`/幂等键/回执）是一等公民。
- **对本设计**：制度事实只在 BOS 里存在；本项目不建流程引擎、不复刻治理语义（结论 7）。接缝细节（Mandate 派生与否）是架构文档 §11 的未决项之二。

### 2.2 Spring-AI-RAG —— 认知事实

- **已核实**：自研 JDBC 检索管线（pgvector HNSW + 分词 + RRF）；证据只回到原始 chunk；确定性断言 + `INSUFFICIENT_EVIDENCE` 一等结果；代际四元组、「不得覆盖原失败制品」；多租户与 KG **均未实施**（单仓单 schema 路线已定；KG 的 ACL 判断落在证据层）。
- **对本设计**：认知事实存这里（结论 8）；三处缺口——责任人模型、提请→确认→落库的生产线、结构化表达——由本设计的知识生产线（架构文档第 9 章）补上。

### 2.3 BlueCortex CE/EE —— 参与者的跨会话记忆

- **已核实**：Claude-Mem 的 Java 移植（Claude-Mem 最初面向 Claude Code，后扩展到 Cursor/Codex 等）；瘦代理 + 胖服务器 + PostgreSQL/pgvector；四个钩子（session-start/user-prompt/tool-use/session-end）；持久化并向 agent 回供的是 `observation`/`summary` 派生痕迹；EE 的 RLS fail-closed 已落地（GUC 未绑定读到零行）；**缺代际与 fencing**（无 generation 概念、无 fencing token）。
- **对本设计**：它是**参与者一侧的跨会话记忆，不是协作一侧的状态**（结论 86）——「谁在等谁」既不在 agent 会话里、也不在其提炼的摘要里；协作状态只能由编排事实承载。`CollaborationMemory` port 只能问痕迹与推移，不能问现状（架构文档 §5.3）。

## 3. 被借鉴的原型与文章

### 3.1 DSH Super-Agent 原型（本仓库）

- 主动式 agent：Source → Trigger → Thread → Eval（gate+assessment）→ Mandate → Ticket → Assignment → Executor；Effects 队列 + outbox 回执；`threadKey = ${source}:${id}`；**单进程单写者**（`stateDir` 目录锁 + 单 SQLite）。
- **对本设计**：七项机制直接照抄（§10.1，结论 83/84）、四项明确不继承（§10.2，结论 4/22）；Thread↔Ticket 的关系与 Worker 生命周期已集中陈述（`prototype-architecture-as-built.md` §3.4 与角色节）。任务域、执行节点、BYOM 在原型里**为零**——这正是第 7 章要自建的部分。

### 3.2 设计文章（DeepSeek，2026-10-31）

- 提出脑手分离（harness 无状态、会话日志外置、按需接入执行环境）与 **BYOM = Bring Your Own Machine**（原文第 212 行：用户的开发机/个人电脑接入云端 Agent，可能间歇在线、有未提交修改与本地凭据）；四条被验证的设计因素（订阅直通、Fast/Slow Path、异步 ReAct Loop、投机执行）归本项目自建（结论 18）。
- **对本设计**：是「扩得更广」这一第一性（结论 20）的出处；本设计的 BYOM 支持两种形态——节点可在云端或员工电脑，云端节点里的 agent 仍可把手伸到员工机器（架构文档 §0.1「不是二选一」）。

## 4. 通信与编排的参照（本轮深查）

### 4.1 HarnessRouter / UHP —— 候选协议

- **已核实**（协议 `versions/2026-10-19`）：UHP 是调用方↔UHP Server 跑一个任务的契约（任务/会话/流式/文件/结果）；与 A2A 互补；server 内部（容器/子进程/队列）明文 out of scope；`session_busy` 一会话一任务；安全章硬要求凭据不进 agent 工具、短时单会话可吊销、越权 404 非 403。
- **账目**：能给的——驱动契约形状、driver-per-harness 范式、凭据 relay（凭据不进进程）、控制面 lease+fencing、安全规则；**没有的**——任务域信封（无 API）、执行节点/BYOM 接入（其实现是一容器一卷的服务器，方向相反）。
- **落点**：UHP 的语义是「驱动 harness 契约」的参考形状；**节点内部无信任边界时用子进程 + 管道即可**，回环 HTTP 只在整块复用现成实现时付代价（架构文档 §11）。

### 4.2 Comma（AFK-surf）—— 送达语义与验证强度

- **已核实**：sessionless（Task 是持久执行状态，Message 只在 host 上）；站点协议把「至少一次 + 幂等 + 未知态」做成完整送达规则（host 记 sent/answered、站点 `task.hello` 报到后按水位补发）；一 Task 一 L4ES 沙箱（磁盘只是缓存、零 GitHub token、按启动轮换）；**Lean 可执行内核**（491 文件编译进 NIF，4,225 条定理）+ TLA+ 八个协议模型 + IFC 机器验证；编排是单 Router + 一 Task 一 Worker + 分段看门狗。
- **没有的**：通用准入链（Triage 仅 Slack）、任务域焚毁（站点常驻）、组织级治理。
- 深入报告：`comma-deep-research-report.md`（同目录）。

### 4.3 OpenMausBot —— 委派运行时与 C1 通道

- **已核实**：统一 Assignment 运行时（工作树、SQLite 事件溯源、重启对账、**同请求只答一次**、子问题打断等待，约 7.5k 行 + 11k 行测试）；bot box（bubblewrap + egress/harness 双门 + 凭据 broker，仅 Cloud home 默认开）；connector 协议 v2（只出站、一条 WebSocket、Admin 只签发任务、无 shell）；四种计算面**全部持久复用**（无焚毁）；审批层把「问题永不自动回答」与「层级只升不降」做成运行时规则；记忆是纯 markdown + FTS（无向量）。
- **没有的**：通用准入链、Router/Worker/Watchdog 角色（扁平 peer + Chief of Staff）、任务域、组织治理。
- 深入报告：`openmausbot-deep-research-report.md`（同目录）。

## 5. 共同结论：通道有先例，三个空位确认

考察一圈之后，架构文档 §1.4 的判断被多份生产代码反复印证：

1. **通道与账本可以做生产级**：送达语义（Comma 站点协议）、委派账本（OpenMausBot runtime）、驱动契约（UHP）、凭据卫生（UHP relay / Comma 沙箱 / OpenMausBot broker）都有可参照的实现——C1–C9 不必从零发明。
2. **通用准入链是空位**：没有一个项目有「谁有权发起工作」的授权评估链（Policy/Mandate/accept-mode）。这与本设计把制度事实归 BOS、把多层审查列为未决项之三（架构文档 §11）互为印证。
3. **任务域的焚毁语义是空位**：最接近的 bot box 是 per-process 且不焚毁；「每任务一域、凭据随域生灭、只留移交包」仍要自建（架构文档 §4.5）。
4. **组织级治理是空位**：租户化编排存储、对账三态、冻结/审计、知识生产线——没有项目承载，这正是本设计三类事实归位要补的。

## 6. 材料索引

- 会话备忘（讨论过程与全部结论编号）：`enterprise-superagent-session-notes.md` §11
- 架构文档（设计结论）：`enterprise-superagent-architecture.md`（§1 三系统、§4.5 任务域、§7 隔离、§11 未决项与调研备注）
- 深度报告：`comma-deep-research-report.md`、`openmausbot-deep-research-report.md`（同目录）
- 值得借鉴的开源项目综述（公开 GitHub 续篇）：`enterprise-superagent-borrowable-oss-survey.md`（同目录）
- 原型代码事实：`prototype-architecture-as-built.md`
- 各仓库本地路径见备忘 §11 的索引表

## 7. 如何继续找：GitHub 搜索关键字

按本设计的六个关切分组（引号内可直接粘贴 GitHub 搜索框）：

| 关切 | 关键字 |
| --- | --- |
| **发现入口**（最大覆盖） | `topic:ai-agents`、`topic:autonomous-agents`、`topic:multi-agent`、`awesome-llm-agents`、`awesome-ai-agents`、`awesome-mcp-servers` |
| **主动式 / 事件驱动**（Trigger→Eval 准入） | `proactive agent`、`event-driven agent`、`agent triggers webhook`、`autonomous agent monitor` |
| **BYOM / local-first**（执行节点在员工机器） | `"bring your own" agent`、`BYOA agent`、`local-first AI agent`、`personal AI agent desktop` |
| **沙箱 / 任务域**（隔离与焚毁） | `agent sandbox`、`code execution sandbox`、`computer use agent`、`firecracker microvm agent`、`bubblewrap sandbox` |
| **委派 / 编排**（Assignment 与编排事实） | `agent orchestration`、`agent-to-agent delegation`、`multi-agent framework`、`agent workflow engine`、`team of agents` |
| **协议 / 互操作**（C 类通信） | `agent2agent`、`A2A protocol`、`agent client protocol`、`MCP host`、`agent harness` |
| **已验证有效的发现模式** | 已知闭品名 + open source alternative：`grok bot alternative`、`manus alternative`、`meta muse alternative`、`openai dots alternative`、`open interpreter`（本项目即由此发现） |

搜索语法建议：加活跃度过滤（`stars:>300 pushed:>2026-09-01`）、限定语言（`language:TypeScript`）、`in:readme` 限定命中位置；另盯 GitHub Trending（周榜）与 Awesome 列表的更新。命中后的核查口径沿用本综述 §0 的三个问题（承载 / 先例 / 空位）。
