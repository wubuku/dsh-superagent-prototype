# 企业级 Super-Agent：会话备忘（2026-11-05，第 3 版）

> **性质**：会话过程备忘，不是架构设计文档，不是决策记录。它只保存「本轮讨论中已经形成、且值得带入后续讨论」的理解、判断和未决问题。
>
> **写作纪律**：每条都标出**来源**（用户说的 / 本文从用户表述推出的 / 助手提出的待确认判断）。三者不可混写。
>
> **明确不包含**：任何模块划分、组件清单、接口定义、技术选型。这些尚未讨论。

## 0. 起点与边界

- **输入**：DeepSeek Harness 团队文章《Super-agent 设计探索：迈向更自主的 Agent 系统》（2026-10-31），以及公开原型 `dsh-superagent-prototype`。二者只作**启发**，不作模板。
- **用户的定位**：「原型只设计了一台接活、派活、记账的机器，没有设计这台机器怎么懂业务。」
- **工作方式约束**：此前另一份架构设计文档已作废，不继承其结论、结构与措辞。
- **三个已指定的承载项目**（用户指定，非本文推断）：

| 事实类型 | 承载项目 | 路径 |
| --- | --- | --- |
| **制度事实**（a） | BOS（AI-Native Business Operating System） | `/Users/yangjiefeng/Documents/wubuku/AI-Native-Business-Operating-System` |
| **认知事实**（b） | spring-ai-rag | `/Users/yangjiefeng/Documents/wubuku/spring-ai-rag` |
| **运行事实**（c） | BlueCortex（CE + EE） | `/Users/yangjiefeng/Documents/Blueforce-Tech-Inc/BlueCortexCE`、`.../BlueCortexEE` |

## 1. 用户提出的三个硬要求（约束，不是功能）

| # | 要求 | 用户原话要点 | 对原型的直接冲击 |
| --- | --- | --- | --- |
| H1 | **更通用** | 事件/trigger 的来源不只是 GitHub/Feishu，不只单仓库单团队 | `github`/`feishu` 已写进 schema、策略、轮询器与 ID 生成；「单仓库单团队」是整套假设的地基 |
| H2 | **Agent 异构** | router / worker / watchdog 可以是不同实现、不同厂商，不绑定 DSH | 原型的三个角色都长在同一个 DSH `ctx` 上；异构意味着角色之间只能靠**消息 + 状态**通信 |
| H3 | **关键角色进程隔离** | 可以是不同进程，甚至不必是 DSH | 原型把所有 Session 放进同一个 `danger-full-access` 进程 |

**助手判断（待确认）**：H1–H3 叠加后才成立。一旦 Router 可以是别家 agent、Worker 可以在另一台机器上，原型「一个进程 + 一个 SQLite + 一个目录锁」的单写者模型必须被明确放弃。

## 2. BYOM：用户给出的关键语义

- **用户原话**：「企业员工的机器上运行的 agent 可以加入到协作中；也可以实现 BYOM……必要时人工（企业员工）可介入干预，否则 BYOM 没有意义。」
- **助手理解（待确认）**：BYOM 的价值主张不是「借员工的机器算力」，而是「任务跑到人的环境里，人看得见、接得住」。没有人工介入的 BYOM 只是分布式算力租赁。
- **推论（待确认）**：**执行节点的隔离等级应与它承载的信任等级挂钩**。员工自有笔记本与云端按需沙箱不应是同一种节点。

## 3. 用户点的「企业级盲区」及三类系统

- **用户原话**：「文章漏掉了企业的业务流程（SOP 等）与隐性知识如何沉淀。」
- **(a)** 类 Flowable 的工作流引擎 + Agent-Friendly API；
- **(b)** 承载业务知识（含 agent 捕获梳理的隐性知识）的 RAG / 语义知识库；用户**不同意**归入「记忆系统/模块」；
- **(c)** 协调多 agent 协作的过程上下文状态；用户认可可归入记忆模块——「偏原始、偏短期、与运行过程紧绑、信息与价值密度低」。

## 4. 三类事实（本备忘的最高层结论）

| | **制度事实**（a） | **认知事实**（b） | **运行事实**（c） |
| --- | --- | --- | --- |
| 定义（用户原话） | 流程定义：谁在什么节点该做什么 | 业务知识：我们怎么理解这门生意 | 过程状态：这次任务进行到哪、谁在等谁 |
| 谁有权写 | **人**（组织的权力） | 人 + agent 捕获，**人确认** | **系统** |
| 怎么算「对」 | 走完了、可审计 | 有来源、有置信、有责任人 | 与实际状态一致 |
| 怎么失效 | **被新版流程替换** | **被推翻**（保留旧版与推翻理由） | **直接丢弃** |
| 失效后果 | 高：已执行实例需重算 | 高：已基于它做过决定 | 低：可重建即可 |
| 因此需要 | 版本化 + 审批 + 实例迁移 | 溯源 + 置信 + 撤权 | TTL + 重建 |
| 用户给的性质 | — | **允许被推翻** | **密度低、寿命短、可丢弃** |

**防越界规则（待确认）**：运行事实「可丢弃」不是因为它不重要，而是因为**它不承担任何需要持久正确的判断**。一旦用过程上下文支撑授权或业务结论，它就升级为认知事实，不能再被丢弃。

**质量指标（待确认）**：运行事实的唯一质量指标是**可重建**——「丢掉以后能从事实流重算出同样的状态」。

## 5. 三个承载项目的事实基线

### 5.1 制度事实 → BOS：已解，我们只消费

**用户的纠正**：「这些都是典型的工作流系统的问题，和 ai agent 的引入几乎没有什么关系！要是我们还打算『自己求解』，那就是『重新发明轮子』了。」

已核实（代码/文档证据）：

- **Flowable 在防腐层后**：`backend/src/main/java/com/wubuku/bos/adapter/flowable/`（`FlowableWorkflowAdapter` / `FakeWorkflowAdapter` / `DefaultWorkflowAdapterRegistry`）；provider key 一律不透明 `external*Ref` + `providerProfile`。
- **Agent-Friendly API 有定义**：六条性质——可发现、可解析、可恢复、可控、可审计、可演进；「不是一个单一标准」。
- **形态是 MCP 工具 + 严格行动边界**：draft / validate / compile / release approval / publish / claim / context read / result submission / reconciliation / human review 是**分离动作**；「Never infer approval from a chat message or a host confirmation dialog」。
- **人审通道独立**：`HUMAN` review 只能经认证的 BOS human work channel 创建；MCP token、execution grant、聊天记录、主机弹窗都不能创建它。
- **版本化 + 审批已解**：`Organization → Workspace → BusinessApplication → BusinessApplicationVersion → ApplicationBinding → WorkflowBinding → WorkflowComponentBinding`，每层带 generation；upgrade 与 rollback 都递增 installation generation。
- **三态语义是一等公民**：`UNKNOWN` / `RECONCILING` / `reconcile operation` / 幂等键 / `ACTIVATED` receipt。
- **双层 OS**：Agent Runtime OS（能不能工作）vs Business OS（该不该工作、为谁工作、谁负责）；六层中「② AGENT LAYER 保持可插拔」，本项目应掌握 ③④⑤。

**推论（待确认）**：(a) 不应出现在我们的模块清单里，应写成「由 BOS 以 Agent-Friendly API（MCP）提供，Super-Agent 只作为调用方和参与者」；「反对巨石」由此变成禁止项——**不复刻任何 BOS 已有的治理语义**。

### 5.2 认知事实 → spring-ai-rag：承载，但三处缺口

- **形态**：基于 Spring AI 的通用 RAG 服务；自研 JDBC 检索管线（pgvector HNSW + pg_jieba/pg_trgm + RRF K=60 + 查询改写 + 重排）。
- **来源** ✅：chunk 字符偏移 + `local_index_generation` + `content_hash`；证据快照只接受 `VECTOR`/`KEYWORD`，「回答只回到原始 Chunk」是硬约束。
- **置信** ✅：确定性断言；`expectedOutcome` 含 `INSUFFICIENT_EVIDENCE`（「证据不足」是一等业务结果）；「词法门槛失败不能直接宣布事实错误」；Judge 不能覆盖确定性失败。
- **允许被推翻** ✅：代际四元组（证据存稳定定位键，不存会重建的行 ID）；代际不存在判 stale；「不得覆盖原失败制品」；「诊断的新回答不能冒充历史答案」。
- **责任人** ⚠️ 缺口：`owner_principal_id` 只答「谁写的」，不答「谁负责、权威来自哪、谁有权推翻」。

**三处缺口**：① 责任人模型；② 写入路径（现有写入是文档入库，缺「agent 提请 → 人确认 → 落库」生产线）；③ 表达形式（检索系统 vs 结构化知识，KG 仍在评审、**未实施**）。

**规划状态（诚实标注）**：多租户「当前不支持」，方向已定（单仓单 schema、表永远租户化、单租户=N=1、四阶段），**未实施**；KG「前期技术讨论，未实施」，否决 Apache AGE 首发，第一版邻接表 + 递归 CTE。KG 评审的 P0 判断：**ACL 必须落在「证据→文档」层而非实体层**（实体跨文档聚合，可见性在证据上）。

### 5.3 运行事实 → BlueCortex（CE + EE）

**CE 形态**：为 AI 助手提供跨会话持久化记忆。**瘦代理（Node.js，hook <200ms 返回）+ 胖服务器（Spring Boot 3.3，port 37777）+ PostgreSQL 16 + pgvector**。客户端：Claude Code、Cursor、OpenClaw、各语言 SDK；MCP 服务器；WebUI（git 子模块）。

**五个生命周期钩子**：SessionStart → UserPromptSubmit → PostToolUse → Summary → SessionEnd。→ `/api/session/start`、`/api/ingest/{tool-use,user-prompt,session-end}`。

**数据模型（CE，Flyway V25）**：

| 表 | 角色 |
| --- | --- |
| `mem_sessions` | 一次会话（`content_session_id` 唯一、`project_path`、`user_id`、`status` active/completed/skipped、`platform_source`、上下文缓存） |
| `mem_observations` | **基本单位**：`type`、`title/content`、`facts`/`concepts` JSONB、`files_read/modified`、`source`（tool_result/user_statement/llm_inference/manual）、`extracted_data` JSONB、`quality_score`、`feedback_type`、`step_number`、`content_hash`、三档 embedding（768/1024/1536）、tsvector |
| `mem_summaries` | 会话摘要 |
| `mem_prompts` | 用户提示 |
| `mem_pending_messages` | **崩溃恢复队列**：`status` pending/processing/processed/failed/skipped、`retry_count`、`tool_input_hash` |
| `message_queue_mapping` | 入队与持久化的映射 |

**可恢复性（用户特别指出的文档）**——`docs/evo-memory-implementation-zh.md` + `ARCHITECTURE-zh-CN.md` §「崩溃恢复」：

- 三段式：**实时**（`@Async` 事件监听器，虚拟线程）→ **兜底**（`PendingMessageProcessor`，`@Scheduled` 每 5 分钟捞 `pending`）→ **恢复**（`StaleMessageRecoveryTask`，把卡在 `processing` 超过阈值的重置回 `pending`；默认阈值 10 分钟，扫描间隔 5 分钟，`@PostConstruct` 启动时先跑一次）。
- **`POST /api/session/start` 的定位是「初始化或恢复会话，生成上下文注入和 CLAUDE.md 更新」**——恢复的产品形态是「重开会话时把上下文重新注入」，不是「恢复进行中的回合」。
- **准入与去重的真实机制**：靠 `AgentService` 的应用层 `existsBySessionAndTool` 检查 + Conversation 行 `PESSIMISTIC_WRITE` 锁串行化；`@UniqueConstraint` 声明存在但**数据库里没有该约束**（`ddl-auto: none`，无迁移创建），所以「数据库拒绝重复」不是保证。
- **代际意识存在但很薄**：`content_hash` + 30 秒窗口只在同一 Conversation 内抑制重复；没有代际/generation 概念，没有 fencing token，没有「旧 owner 的写入要被拒绝」的机制。
- **结构化提取**：提示词驱动的 YAML 模板 + Schema；**追加式（Append-Only）**——LLM 只输出 `add`/`remove`/`keep_hint`，服务端与库中完整先前数据合并，避免截断导致的静默丢失。

**EE 形态**：CE 的 Spring Boot 移植 + 企业多租户。已核实：

- **双数据库路径**：应用池 `cortex_app`（`NOBYPASSRLS`，每连接绑定 GUC）+ 平台池（`BYPASSRLS`，仅用于枚举活跃租户与 `/api/platform/**`）；平台池启动校验 `verifyRole`（必须 `rolsuper`/`rolbypassrls`，否则 FORCE RLS 把它过滤成 0 行直接失败）。
- **RLS 四件套**：`ENABLE` + `FORCE` + `tenant_id DEFAULT current_setting('app.current_tenant_id', true)` + `USING`/`WITH CHECK` 同一表达式。**GUC 未设置 → `NULL` → 0 行**，即 fail-closed 而非报错或读全量。
- **V21–V25 迁移**：`tenant/team/team_member/tenant_api_key/audit_event/usage_meter` → 7 张 `mem_*` 补 `tenant_id` → 11 张表 RLS → license/quota。
- **39 份 ADR**：租户 API key + RLS、删除与保留、许可轮换、审计分区、团队层级、幂等、导出、备份加密 + PITR、失败降级、webhook 加固、迁移安全门禁、SLO、成本归属、副本一致性、地域路由、**恢复演练进 CI（ADR 0020）**等。
- **模块边界有 CI 检查**：`scripts/architecture-check.sh`，只读 import，29 个包/224 文件/81 条包级依赖；`config` 是组合根，`platform` 与 `tenant` 不是上下级，`tenant → platform` 只允许两个类型。

**与运行事实三条失效规则的对齐**：

| 要求 | BlueCortex 状态 |
| --- | --- |
| 系统有权写 | ✅ 钩子自动写入 |
| 与实际状态一致 | ⚠️ 见「切口」一节——它记录的是**助手会话**的事实，不是**多 agent 协作**的事实 |
| 可直接丢弃、可重建 | ⚠️ **恢复 ≠ 可重建**：恢复的是「被中断的处理任务」，不是「被丢弃的运行状态」；且恢复靠「时间阈值猜卡住」，不是靠代际或 fencing |

**跨三个系统的公约数（助手观察，待确认）**：BOS（不可变 pin + generation + `ACTIVATED` receipt + reconciliation）与 spring-ai-rag（`local_index_generation` + 代际四元组 + claim/lease/fencing + fail-closed）各自独立采用了「**不可变版本 + 代际 + 幂等 + fencing + fail-closed**」。BlueCortex 有幂等与 fail-closed，**缺代际与 fencing**。

### 5.4 用户的判断：集成不是问题（推翻助手的隐性悲观假设）

**用户原话要点**：「现在已有的三个组件/系统/模块，都已经『能』——或者接近『能』——和 Agent 集成。」

| 系统 | 它从第一天起就是什么 |
| --- | --- |
| BOS | 目标就是「把工作流系统通过 MCP Server 提供 agent 友好 API」，并留有跑通的端到端验收 |
| BlueCortex | 本质是 Claude Code 外挂记忆插件的 Java 移植——**插件形态是起点，不是增量** |
| spring-ai-rag | 虽无 MCP 端点，但 BOS 已给出完整范式（六条性质 + 生产模型 + 工具指南），可同样暴露 |

**用户的问题**：「个人版 agent（Codex、Claude Code）已经能以相当松耦合的方式集成它们，那我们构建企业版 Super-Agent，有什么理由不能集成它们呢？」

**助手承认的错误**：前几轮用「切缝」「需要另一次调用形态」等措辞，隐含假设「为个人助手设计的集成方式，放大到企业必然要重设计」。这是**未经检验的跳跃**。

**助手修正后的分析（三个层次，待确认）**：

1. **协议层：能接，且已被证明。** BOS 的 MCP 工具、BlueCortex 的 MCP 服务器 + 四种 SDK、spring-ai-rag 的 REST，都是标准接口。此层不再存疑。
2. **松耦合层：「能」，但需要一条引用纪律。** 个人版的松耦合依赖一个隐含前提——一个人、一个 agent、一个工作目录、一条主线；于是 `mem_sessions` 按 `project_path` + `user_id` 分区、「恢复」=「重开会话重注上下文」、去重靠一条 Conversation 行锁就够了。多 agent 时该前提消失：同一 Thread 上可能同时挂着异构的 Router / Worker / Watchdog，而「谁在等谁」不属于其中任何一个。**这不是接口问题，是对象归属问题。** 解法不是新增系统，而是：**Super-Agent 自己持有协作编排事实，三个系统各自持有自己领域内的事实，两者通过 ID 互相引用，不互写对方的表。**
3. **企业层：只多三件事，且都不要求改三个系统的集成方式。**
   - **身份与租户**（谁在调用）：BOS 有 Organization/Workspace，BlueCortex EE 有 RLS，spring-ai-rag 有多租户路线——**三者都已或正在从内部解决**，Super-Agent 只传上下文。
   - **策略与审批归属**（谁批准）：已在 BOS（Mandate / HUMAN channel），Super-Agent 只做调用方。
   - **异构 agent 的信任分级**（谁能调什么）：**唯一真正新增的**，且只发生在 Super-Agent 内部，不动外部系统。

**由此得出的关键区分**：工作量不是「三个系统 × 企业化改造」，而是「**一个薄编排层 + 三条引用纪律**」：

1. Super-Agent 只读写自己领域的运行事实；对方的 (a)(b)(c) 一律通过 ID 引用。
2. 企业级差异由被调用方负责，Super-Agent 只传上下文，不复制策略。
3. 跨系统一致性不做两阶段提交，只做「事件 + 可对账」——这正是三个系统各自的既有模式（BOS reconciliation、spring-ai-rag claim/lease、BlueCortex pending 队列）。

**对 Q-I 的影响**：原本担心的「缺代际与 fencing」被缩小——不是「给 BlueCortex 补一套架构」，而是「它的 pending 队列已提供重试语义，Super-Agent 只需在**自己的**编排事实上带代际」。

## 6. H1–H3 与三类系统的交接面

- **H1 × (c)**：来源一旦不止 GitHub，过程上下文不能只按「线程」组织。
- **H1 × (b)**：知识库按**来源**标注可信度，而非按渠道类型。
- **H2 × (c)**：异构 agent 不能共享内存过程状态，必须以**可序列化、可对账**形式存在。
- **H3 × (b)**：知识库是跨租户、跨进程共享资产，权限边界不能依赖「同进程同用户」。
- **H3 × BYOM/人工介入**：执行节点隔离后，「员工接管」通道成为必需项。
- **Watchdog × H2**：Watchdog 的异构最难——要判断「另一个 agent 有没有进展」，要求被观察方暴露**可判定的进展信号**，而非自述。
- **H1 × BOS**：Organization → Workspace 链可能就是 H1 的答案；也可能不是。

## 7. 用户给出的模块划分理由（原则，不是方案）

1. 反对一体化巨石 / 单体；
2. 保护概念完整性——「领域」小一些，维护概念完整性的成本更低；
3. 复用已有开源积累或自己做过的 RAG、记忆系统——职责单一才容易找到「已经发明的轮子」；
4. 在架构阶段就做模块划分。

**执行含义**：既然 (a)(b)(c) 已有承载者，「复用」意味着**不建，只接**。真正需要设计的是**三者之间的切缝**与三个角色的接缝。

## 8. 未决问题（讨论续接点）

### 8.1 已被外部项目解答的

| 原编号 | 问题 | 解答 |
| --- | --- | --- |
| Q1 | 制度事实换版本时，运行中的实例怎么办 | **BOS 已解**：不可变 pin + generation + 升级/回滚迁移 |
| Q6 | 「类 Flowable」的主语是谁 | **BOS 已答**：主语是业务流程本身，agent 是调用方 |
| Q7 | Agent-Friendly API 的准确含义 | **BOS 调研已给出**：六条性质 + 生产模型 |

### 8.2 仍然未决（按必须先答排序）

| # | 问题 | 为什么必须答 | 目前状态 |
| --- | --- | --- | --- |
| **Q-G** | **「会话」的主语是谁**：BlueCortex 的 Session 是「助手会话」；Super-Agent 的 Router/Worker 也是 Session；BOS 有 Run/WorkItem；spring-ai-rag 有 chat memory。这四个「会话」如何对齐？ | 这是 (c) 的核心切缝；不答，过程状态会被四次记录 | 助手提出，未确认 |
| **Q-H**（已改写） | **Super-Agent 需要向 BlueCortex 传哪些协作上下文**，才能在不改其 `mem_*` 模型的前提下被正确分区？（原问法「是否需要另一次调用形态」已按 §5.4 撤回——它暗含「要改它」） | 决定协作状态引用 BlueCortex 的粒度 | 助手改写，未确认 |
| **Q-A** | **Super-Agent 与 BOS 的接缝**：Router/Worker/Watchdog 分别以什么身份调用 BOS？Mandate 自有还是从 BOS grant 派生？ | 决定授权链位置 | 未讨论 |
| **Q-B** | **(c) 与 BOS 的 WorkGraph/WorkItem/ContextPackage 怎么切** | 否则「任务进度」两份 | 助手倾向「BOS 是业务事实、(c) 是执行事实」，未确认 |
| **Q-C** | **「企业」的边界**：一企业一套 (a)(b)(c) 还是各团队一套？Super-Agent 边界跟 BOS Workspace 走还是独立？ | 决定 (b) 多/单租户与 (c) 归属 | 未讨论 |
| **Q-E** | **认知事实的「责任人」模型**：谁对知识负责、权威来自哪、谁有权推翻？ | spring-ai-rag 只答「谁写的」 | 助手提出，未确认 |
| **Q-F** | **隐性知识的「提请 → 确认 → 落库」生产线谁做** | 用户点的「盲区」核心，不在任何现有项目形态里 | 助手提出，未确认 |
| **Q-I** | **运行事实是否需要代际与 fencing**：BlueCortex 现在是「时间阈值猜卡住 + 重置为 pending」。Super-Agent 的 Assignment 若跨进程，旧 owner 的迟到写入必须被拒绝 | 决定 (c) 是否需要在 BlueCortex 之上补一层 | 助手提出，未确认 |
| **Q-J** | **推算属性的归属**：`status`、`pending`/`processing`、`quality_score`、`summary` 都是派生/可丢的，但 `mem_observations` 的正文不是。运行事实里的「派生层」与「原始层」如何分开？ | 否则耦合不可解 | 助手提出，未确认 |
| Q2 | 认知事实被推翻后，此前基于它的决定怎么记账（二值记录而非改写 Decision） | 企业系统最难的一层 | 助手提出，未确认 |
| Q8 | 「记忆」一词是否会把 (b) 与 (c) 的验收标准混回去 | 巨石风险的实质 | 助手提出，等用户判断 |

## 9. 本轮已确立、可直接作为设计前提的结论

1. **三类事实、三条失效规则**是「宪法」级约束，所有模块从它推导，不从原型推导。
2. **运行事实不得承担授权或业务结论**。
3. **BYOM 与人工介入是同一件事的两面**。
4. **原型的单进程单写者模型不可继承**。
5. **agent 不能自己改写制度事实或认知事实**，只能提请，由人确认。
6. **模块划分在架构阶段完成**，目标是保护概念完整性。
7. **(a) 不建，只接 BOS**；禁止在 Super-Agent 内复刻 BOS 的治理语义。
8. **(b) 的承载者是 spring-ai-rag**；多租户与 KG 是必要强化，但**均未实施**。
9. **(c) 的承载者是 BlueCortex CE/EE**；EE 的多租户与 fail-closed 已落地，但**代际与 fencing 未落地**，且其「会话」语义面向单个助手而非多 agent 协作。
10. **不可变版本 + 代际 + 幂等 + fencing + fail-closed 是公约数**；三个项目中只有 BlueCortex 缺前两项。
11. **集成三个系统不构成设计难题**（用户判断，助手确认）：三者从第一天起就是面向 agent 集成的；个人版 agent 已能以松耦合方式接入。**企业级的差别不在「能否接入」，而在「编排契约归谁、企业级属性由谁负责」**。工作量因此是「一个薄编排层 + 三条引用纪律」，而不是「三个系统 × 企业化改造」。

## 10. 本备忘不作声明的部分

- 不包含模块清单、层次图、接口契约、技术栈。
- 不判断三个系统是否需要各自独立部署。
- 不继承作废文档的任何结论。
- 不把任何项目的**规划**当作**已具备能力**。

## 11. 参考材料索引

| 材料 | 地址 | 用途 |
| --- | --- | --- |
| 设计文章（原文） | https://mp.weixin.qq.com/s/zoS7GlReWPhfCjENGxXCdg | 被借鉴的框架 |
| 设计文章（归档） | `deepseek-harness/docs/drafts/reference-materials/super-agent-design-exploration.md` | 可检索副本 + 配图 |
| 原型仓库 | `dsh-superagent-prototype` | 代码事实见 `docs/drafts/prototype-architecture-as-built.md` |
| DSH 主仓库 | https://github.com/deepseek-ai/deepseek-harness.git | 宿主能力边界 |
| **BOS** | `/Users/yangjiefeng/Documents/wubuku/AI-Native-Business-Operating-System` | 制度事实承载者 |
| · 语义映射 | `docs/drafts/BOS-Workspace-BusinessApplication-Flowable语义映射决策备忘-2026-10-17.md` | 对象链与版本治理 |
| · 隔离语义 | `docs/drafts/BOS-SaaS租户与Organization-Workspace隔离语义决策备忘-2026-10-17.md` | 租户/组织/工作空间边界 |
| · Agent API 调研 | `docs/drafts/Agent友好API实现深度调研报告.md` | 六条性质与生产模型 |
| · MCP 指引 | `backend/src/main/resources/mcp/guides/*.md` | agent 面向的行动边界与授权规则 |
| · 双层 OS | `docs/drafts/AI原生企业工作流与云端Agent执行平台深度调研报告.md` | 我们在第几层 |
| **spring-ai-rag** | `/Users/yangjiefeng/Documents/wubuku/spring-ai-rag` | 认知事实承载者 |
| · 多租户现状 / 路线 | `docs/drafts/MULTI_TENANCY_STATUS.md`、`MULTI_TENANCY_TECH_ROADMAP.md` | 未实施；单仓单 schema |
| · KG 评审 | `docs/drafts/KNOWLEDGE_GRAPH_MODULE_REVIEW.md` | 未实施；ACL 落在证据层 |
| · 可信断言 | `docs/trustworthy-evaluation-admission-zh-CN.md` | `INSUFFICIENT_EVIDENCE`、不可变版本 |
| · 多实例语义 | `docs/multi-instance-semantics-zh-CN.md` | claim + lease + fencing |
| **BlueCortex CE** | `/Users/yangjiefeng/Documents/Blueforce-Tech-Inc/BlueCortexCE` | 运行事实承载者（社区版） |
| · 架构 | `docs/ARCHITECTURE-zh-CN.md` | 瘦代理 + 胖服务器、崩溃恢复 |
| · 记忆演进 | `docs/evo-memory-implementation-zh.md` | **三段式恢复：实时 / 兜底 / 陈旧恢复** |
| · 项目现状 | `docs/PROJECT-STATE-zh-CN.md` | 601 用例、V25、门禁清单 |
| · 结构化提取 | `docs/structured-extraction-zh-CN.md` | 追加式提取（add/remove/keep_hint） |
| · 恢复实现 | `backend/.../service/StaleMessageRecoveryTask.java`、`PendingMessageProcessor.java` | 阈值 10 分钟、扫描 5 分钟 |
| **BlueCortex EE** | `/Users/yangjiefeng/Documents/Blueforce-Tech-Inc/BlueCortexEE` | 运行事实承载者（企业版） |
| · 多租户 | `docs/multi-tenancy.md` | RLS 四件套、双连接池、fail-closed |
| · 模块边界 | `docs/architecture/module-boundaries.md` | CI 检查的包级依赖 |
| · ADR | `docs/adr/0001` … `0039` | 含 0020 恢复演练进 CI |
| 原型运行事实研究 | `deepseek-harness/docs/drafts/dsh-superagent-runtime-facts-and-enterprise-gap.md` | 同进程、BYOM 三件套、隔离三层 |
| 原型组织责任研究 | `deepseek-harness/docs/drafts/dsh-superagent-prototype-research.md` | 组织责任划分、团队收益评价 |