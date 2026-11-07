# Paperclip 深度调研报告

对象：paperclipai/paperclip，远端 `https://github.com/paperclipai/paperclip`。
基线：HEAD `b8e02fc2`（2026-11-07，master）。
调研方式：README / DESIGN / schema 源码核对；`packages/db/src/schema` 全量文件名枚举；`mandate` 在 `packages/db` 代码搜索 **0 命中**；`paperclip-eval-kernel` 与 `evals/README.md` 核对名称陷阱。

## 0. 一句话结论

Paperclip 是 **「AI Agent Workforce」的组织/工单控制平面外形**：公司（company）→ 目标（goal）→ 议题（issue）→ 指派/签出 → Heartbeat 唤醒 Adapter Runtime，外加预算、审批与 org chart。它把「谁负责什么、预算多少、何时醒来」做成了可自托管的生产系统（MIT，~11 万 stars）。但它 **没有** DSH/我们设计中的 Mandate（任务授权开票）、**没有** Trigger→Eval 准入链；名为 `paperclip-eval-kernel` / `evals/` 的东西是 **产品行为评测矩阵**，不是准入 Eval。控制面与 Runtime Adapter 解耦是真正值得抄的缝。

**判定：空位③的组织/Assignment 外形可借鉴；禁止整包替代 DSH 控制平面；OpenClaw/Hermes 仅是其适配器生态叙事，不是我们的推荐底座。**

---

## 1. 系统一览

| 项 | 内容 |
| --- | --- |
| 定位 | [文档]「If OpenClaw is an employee, Paperclip is the company」——编排团队 agent 跑业务，不教你怎么造 agent |
| 技术栈 | Node.js 24+ / TypeScript / React UI / Postgres（可嵌入）/ pnpm monorepo |
| 结构 | `server/` 控制面；`packages/db` schema；`packages/adapters` + 可变 registry；`ui/`；`packages/paperclip-eval-kernel`；`evals/` |
| 规模 | ~111k stars；MIT；极高提交密度（master 持续更新） |
| 四支柱 | Agentic Task Manager / Org Chart / Agent Training(evals) / Agentic OS |
| 适配器 | Claude Code、Codex、Cursor、Gemini CLI、OpenCode、Pi、Hermes、Grok、Kimi、HTTP/webhook（含 OpenClaw）等——**Adapter 接入，控制面自持** |

---

## 2. 它做到了什么（实证路径）

### 2.1 Schema：组织与工单外形（已核实）

`packages/db/src/schema/` 中与本调研相关的一等公民表（节选，路径均为该目录下文件）：

| 表 / 文件 | 关键字段（摘要） | 意义 |
| --- | --- | --- |
| `companies.ts` | `status`、`pauseReason`、`budgetMonthlyCents`、`requireBoardApprovalForNewAgents` | 公司边界 + 公司级预算/暂停 |
| `agents.ts` | `companyId`、`reportsTo`、`adapterType`/`adapterConfig`、`runtimeConfig`、`budgetMonthlyCents`、`lastHeartbeatAt`、`permissions` | org chart + **Runtime 经 adapter 解耦** |
| `goals.ts` | `companyId`、`parentId`、`ownerAgentId`、`level`/`status` | 目标树 |
| `issues.ts` | `assigneeAgentId`/`assigneeUserId`、`checkoutRunId`/`executionRunId`→`heartbeat_runs`、`goalId`/`projectId`/`parentId`、`executionWorkspaceId`、`originKind`、原子签出相关索引 | **工单即 Assignment 载体**（无独立 `assignments` 表名，指派在 issue 上） |
| `heartbeat_runs.ts` | `agentId`、`issueId`、`invocationSource`、`status`、成本记账、liveness、retry、日志引用 | Heartbeat 执行账本 |
| `approvals.ts` | `type`、`requestedByAgentId`、`status`、`payload`、`decidedByUserId` | 审批记录 |
| `budget_policies.ts` | `scopeType`/`scopeId`、`hardStopEnabled`、`warnPercent`、`unpricedUsagePolicy` | 预算策略硬停 |

另有大量配套表：`execution_workspaces`、`routines`、`company_secrets`、`issue_watchdogs`、`heartbeat_run_watchdog_decisions` 等——组织外形厚度远超「一个 issue tracker」。

**关键负向核实**：对 `repo:paperclipai/paperclip path:packages/db` 搜索 `mandate` → **total_count: 0**。无 `mandate` 表、无 Mandate 领域对象。

### 2.2 Heartbeat ≠ Eval

- Heartbeat：[文档] agents 因指派工作、跟进消息或定时醒来；DB-backed wakeup queue、budget check、secret injection、adapter invocation。
- `evals/README.md`：明确是「Eval framework for testing Paperclip agent behaviors across models and prompt versions」——assignment pickup、approval required、company boundary、MCP gateway 行为等 **promptfoo 用例**。
- `packages/paperclip-eval-kernel/package.json`：`"Provider-neutral evaluation matrix kernel without Paperclip scenario content"`。

→ **名称陷阱已坐实**：`eval-kernel` = 产品评测，**不是** Trigger→Eval 开票。

### 2.3 控制面 ↔ Runtime Adapter 解耦

- `agents.adapterType` + `adapterConfig`：控制面登记「雇了谁」，执行交给 adapter。
- README 系统图：Identity / Work&Tasks / Heartbeat / Governance / Org / Budget / Routines 在 Paperclip Server；Claude/Codex/CLI/HTTP bots 在下方接入。
- `adapter-plugin.md` / registry：server 与 UI 的 adapter registry 可变，`registerServerAdapter` / 路由侧 `assertKnownAdapterType`——外部 runtime 可插拔。

这正是我们「Control Plane ≠ Runtime；Adapter 接入、无写控制平面权」的可参照实现缝。

### 2.4 治理外形（仍非我们的核心）

- 审批：board / execution policy / connection action approvals。
- 预算：company/agent/project 级；hard stop。
- 公司可暂停；atomic task checkout；activity log。
- Watchdog 相关表存在（`issue_watchdogs`、`heartbeat_run_watchdog_decisions`）——偏运行恢复/生产力审查，**不是**异构只读 Watchdog agent 角色模型。

---

## 3. 它没有什么

| 我们需要的 | Paperclip | 判定 |
| --- | --- | --- |
| **Mandate（这次工作凭什么被允许）** | schema 无 mandate；授权叙事落在审批/连接权限/预算 | ❌ |
| **Trigger→Eval 开票链** | Routines 有 cron/webhook/API，但是「建 issue + 唤醒」，不是资格评估与 accept-mode | ❌ |
| **对账三态**（已确认/未发生/未知） | 有成本记账、审批决策，无外部副作用对账状态机 | ❌ |
| **任务域焚毁 + 移交包** | 有 execution workspaces / sandbox providers（e2b 等），偏工作区与云执行，非「一任务一域用完即焚」产品语义 | ⚠️ 弱 |
| **制度事实归 BOS / 认知事实归 RAG 生产线** | 自建 org+skills+部分 memory 路线；不对接我们的三类事实归位 | ❌ |
| **禁止依赖消费级助理生态** | README/topics 大量 OpenClaw/Hermes 叙事 | ⚠️ 生态叙事，adapter 可换 |

---

## 4. 与企业级设计的对照

### 4.1 可以借鉴

1. **控制面与 Runtime Adapter 解耦**：`adapterType` + 可变 registry + 服务端校验——直接服务「异构 agent / 不绑定 DSH」。
2. **Issue/Assignment/Heartbeat 状态机外形**：签出锁、executionRun 绑定、wakeup 合并、预算门——对照我们编排事实的「归属/派发」外形（不是照搬表结构）。
3. **Org / Goal / Budget / Approval 外形**：多 company、reportsTo、board 审批——空位③外形参考。
4. **密钥引用而非拷贝进 agent config**（文档声称 secret references）——与凭据卫生同向。
5. **把「评测」与「准入」用词彻底分开**——反例教材：避免我们自己的模块再叫模糊的 Eval。

### 4.2 不可借

- **整包当 Mandate/DSH 替代品**。
- **把 Heartbeat 或 eval-kernel 叙述成准入 Eval**。
- **把 OpenClaw/Hermes 员工叙事写成架构前提**（用户硬排除）。
- **用其 execution workspace 冒充任务域焚毁**。
- **用其 activity/approval 冒充对账三态与冻结语义**（我们的冻结：停新工作、在途跑完、对账继续写）。

---

## 5. 结论与建议动作

1. **定位**：P1 级「组织/Assignment 外形」参照；不进控制平面底座候选。
2. **建议动作**：
   - 精读 `packages/db/src/schema/{companies,agents,goals,issues,heartbeat_runs,approvals,budget_policies}.ts`，画一张与我们 thread/编排事实的映射表（只映射外形，不合并领域）；
   - 精读 adapter registry 与 heartbeat 调度边界，写入「Runtime Adapter 契约」草案；
   - 在材料索引中 **书面标注：无 Mandate；eval-kernel≠准入 Eval**；
   - 不将 OpenClaw/Hermes 适配器路径纳入主推审计。
3. **三空位**：①不填 ②弱 ③部分外形。

---

## 6. 引用

- README.md、evals/README.md、adapter-plugin.md、packages/paperclip-eval-kernel/package.json
- packages/db/src/schema/{companies,agents,goals,issues,heartbeat_runs,approvals,budget_policies}.ts 及同目录全量枚举
- 代码搜索：`mandate` in packages/db → 0
- 对照：architecture §0.2 / §4.3 / §7.4；borrowable-oss-survey §3.3
