# A2A（Agent2Agent Protocol）深度调研报告

对象：a2aproject/A2A（Linux Foundation，Google 贡献）。  
远端：`https://github.com/a2aproject/A2A`（~26.4k ★，Apache-2.0）；站点 `https://a2a-protocol.org/`。  
基线：HEAD `9fff3e08ab33`（2026-11-07 前后）。调研方式：规范文档 `docs/topics/*`、`docs/specification.md` 与 README；SDK 在独立仓（python/js/go/java/dotnet/rust）。关键断言附 [文档] 路径。

## 0. 一句话结论

A2A 是**异构、不透明 agent 之间的互操作协议**（发现、任务生命周期、消息/工件、流式与推送），明确与 MCP 正交：MCP 垂直连工具，A2A 水平连 peer agent。它给本设计第 11 章「角色只能靠消息与状态通信」提供了**C 类通信契约形状**，但**不决定**谁有权开票（Mandate）、不承载编排对账三态、不提供任务域焚毁。

**判定：协议先例过关；三个空位皆不填——禁止用 A2A Task 冒充本项目 Ticket/Mandate/编排账本。**

---

## 1. 系统一览

| 项 | 内容 |
| --- | --- |
| 定位 | [文档] README：「open protocol enabling communication and interoperability between opaque agentic applications」 |
| 传输 | JSON-RPC 2.0 over HTTP(S)；SSE 流式；Push Notification webhook |
| 核心对象 | Agent Card、Task、Message、Part、Artifact、`contextId` |
| 生态 | 多语言 SDK；samples；CLI；DeepLearning.AI 课程 |
| 许可 | Apache-2.0（Linux Foundation 项目） |

---

## 2. 它做到了什么（实证）

### 2.1 角色模型：User / Client Agent / Remote Agent（不透明）

- Client 代表用户发起；Server 是暴露 A2A 端点的远程 agent；对 Client 而言内部记忆/工具/逻辑保持 **opaque**。[文档] `docs/topics/key-concepts.md`「Core Actors」。
- 这与本设计「agent 异构、不共享内存/对象」**同向**。

### 2.2 Agent Card：发现与握手元数据

- JSON「名片」：身份、endpoint、能力、认证要求、skills。[文档] `key-concepts.md`「Agent Cards」；`docs/topics/agent-discovery.md`。
- 用途是**发现与如何安全交互**，不是组织编制或 Mandate。

### 2.3 Task 生命周期（协议层状态机）

- 可响应 **Message**（无状态短交互）或发起 **Task**（有状态长任务）。[文档] `docs/topics/life-of-a-task.md`。
- Task 有中断态（如 `input-required`、`auth-required`）与终态（`completed` / `canceled` / `rejected` / `failed`）；**终态不可重启**，后续 refinement 必须同 `contextId` 下新 Task。[文档] 同文「Task Immutability」。
- `contextId` 把多 Task / Message 绑成会话线索；`referenceTaskIds` 做细化引用。[文档] 同文。

**注意命名冲突**：A2A 的 Task ≠ DSH Ticket ≠ 本设计编排事实里的派发记录。协议 Task 是**互操作单元**；本设计 Ticket/Mandate 是**制度与编排单元**。

### 2.4 与 MCP 的官方分工

- MCP = vertical（工具/资源）；A2A = horizontal（agent↔agent）。[文档] `docs/topics/a2a-and-mcp.md`。
- 二者互补；ContextForge 等网关会同时联邦两者（见姊妹报告）。

### 2.5 企业就绪叙事（协议层，非组织 OS）

- 文档强调安全、认证、可观测性设计意图（「Enterprise-Ready」主题页）。[文档] `docs/topics/enterprise-ready.md`、README Key Features。
- 这是**协议与部署实践建议**，不是 BOS/租户治理实现。

---

## 3. 它没有什么

| 本设计概念 | A2A | 判定 |
| --- | --- | --- |
| Trigger→Eval→Mandate | 无开票权、无 BOS 动作分离 | ❌ |
| 任务域焚毁 / 移交包 | 不定义执行环境生命周期 | ❌ |
| 编排事实（归属/派发/在途/待对账） | Task 状态是 agent 侧工作单元，不是租户编排账本 | ❌ |
| 组织编制 / 预算 / 冻结 | 无 | ❌ |
| 对账三态 | 无 | ❌ |

---

## 4. 可借 / 不可借

### 4.1 值得借鉴

1. **异构角色通信的最小对象集**：Agent Card（发现）+ Task（有状态工作单元）+ Message/Part/Artifact（载荷）+ `contextId`（线索）——作为第 11 章 C 类通道的**候选信封字段表**。[文档] `key-concepts.md`。
2. **终态不可变 + 细化开新 Task**：与「编排事实可重建、权威状态不可含糊重放」同向的协议纪律；可启发 Ticket 终态与补单规则（**映射时改名，避免 Task 一词污染领域模型**）。[文档] `life-of-a-task.md`。
3. **opaque 协作**：不要求共享内部工具/记忆——支撑「Router/Worker/Watchdog 可跨厂商」。[文档] `a2a-and-mcp.md`、README。
4. **交互模式菜单**：同步 / SSE / Push——执行节点间歇在线时的投递选项清单。[文档] `key-concepts.md` Interaction Mechanisms。
5. **与 MCP 分层**：工具走 MCP，peer 协作走 A2A——写入互操作架构图，避免一个协议打天下。[文档] `a2a-and-mcp.md`。

### 4.2 明确不可借

- 用 A2A Task 状态机**替代** Mandate / Ticket / 编排存储。
- 用 Agent Card skills 列表**替代** BOS 制度事实或组织授权。
- 假设「实现了 A2A 就等于企业 Super-Agent」。

---

## 5. 建议

1. **P2 协议审计**：读 `specification.md` 中 Task 状态与认证章节；选一个官方 SDK 做「Worker 作为 A2A Server、Control Plane 作为 Client」的尖刺，验证 opaque 委派。
2. **领域模型命名**：对外可讲 A2A Task；对内坚持 Ticket / Assignment / Mandate 词汇，建立显式映射表。
3. **三空位不变**。

---

## 6. 引用

- [文档] `README.md`；`docs/topics/{key-concepts,life-of-a-task,a2a-and-mcp,agent-discovery,enterprise-ready}.md`；`docs/specification.md`
- SDK 仓：`a2aproject/a2a-{python,js,go,java,dotnet,rs}`
- 坐标系：架构 §0.1 异构与第 11 章；borrowable survey §3.5
