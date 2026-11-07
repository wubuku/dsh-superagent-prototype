# OpenHands 深度调研报告

对象：OpenHands/OpenHands（Agent Canvas 前端与本地栈）+ 配套 `OpenHands/automation`（Automation Service）+ `OpenHands/software-agent-sdk`（Agent Server）。  
基线：OpenHands HEAD `340c2d930fea`（约 2026-11-07）；Automation 独立仓 ~48 stars、MIT、仍标 Beta。  
调研方式：README / `docs/architecture.md` / Automation README 与 `openhands/automation/{models,dispatcher,filter_eval,trigger_matcher}.py` 文档↔代码核对；坐标系为 `enterprise-superagent-architecture.md` 与 `enterprise-superagent-borrowable-oss-survey.md`。

## 0. 一句话结论

OpenHands 现在是**研发域的「开发者控制中心」**：Agent Canvas 管会话与后端选择，Agent Server 跑 agent，Automation Service 单独负责「何时起跑」（Cron / Webhook）。分层清晰、工程边界可抄。但它的触发是**研发工作流自动化**（GitHub PR/Issue、自定义 webhook、JMESPath 过滤），**不是**企业级 Trigger→Eval→Mandate 开票链；沙箱是会话/Docker 工作区，**不是**任务域焚毁。

**判定：外围 Harness / 工程边界先例（P1）；不进控制平面，不填三空位。**

---

## 1. 系统一览

| 项 | 内容 |
| --- | --- |
| 定位 | Self-hosted developer control center for coding agents and automations |
| Stars / 许可 | OpenHands ~92.8k、MIT；Automation 独立仓、MIT、Beta |
| 多仓边界 | Canvas（UI）↔ Agent Server/SDK（执行）↔ Automation（调度）↔ typescript-client（API） |
| 技术栈 | TypeScript/React（Canvas）；Python FastAPI + Postgres/SQLite（Automation）；Python Agent Server（SDK 仓） |
| 触发 | Cron + Event（GitHub 等 + custom webhook） |
| 沙箱 | 无沙箱主机直跑 / 单 Docker / 每 conversation 一 Docker；非 destroy-by-default |

[文档] README「Repository boundaries」表；`docs/architecture.md`「System boundaries」「Runtime services」。  
[代码] `OpenHands/automation` 的 `scheduler.py` / `dispatcher.py` / `models.py`。

---

## 2. 它做到了什么（实证）

### 2.1 Automation Service ↔ Agent Server 分层（本设计最该看的）

- **职责切分写死在文档里**：Automation「manages when work runs」；Agent Server/SDK「execute the agent conversations」并拥有 tools/workspaces/events。[文档] Automation README「Repository boundaries」。
- Canvas **不跑** scheduled/event automations——没有 automation backend 就不触发。[文档] `docs/architecture.md`「Agent Canvas is not responsible for… Running scheduled or event-triggered automations without an automation backend」。
- 与我们的硬原则同向：**Control Plane ≠ Runtime** 的工程投影——只不过这里「控制」只是调度壳，不是企业准入控制平面。

### 2.2 触发与运行记录

- `Automation` 模型：`trigger` JSON、`org_id`、`user_id` / `run_as_kind`（user|service）、状态 ACTIVE/INACTIVE/DRAFT。[代码] `openhands/automation/models.py`（`Automation` 类注释「what to run and when to trigger it」；`trigger` 字段）。
- `AutomationRun`：`PENDING→RUNNING→COMPLETED/FAILED/CANCELLED/SKIPPED`；`trigger_source`（manual/cron/event）；事件跑可挂 `trigger_event_id` 与 webhook payload。[代码] 同文件 `AutomationRun`、`trigger_source`、`trigger_event_id`。
- 事件过滤：JMESPath DSL（`glob` / `icontains` / `regex`），用于匹配仓库、评论、label 等。[代码] `filter_eval.py` 模块头注释与 `FilterFunctions`。
- Custom webhook：按 org 的 `custom_webhooks` 表，带 secret 验签。[代码] `models.py` `CustomWebhook` 类注释。

### 2.3 多后端与 ACP

- 同一 Canvas 可切 local / remote / cloud Agent Server；支持 OpenHands 自有 agent 与 Claude Code / Codex / Gemini / ACP 兼容 agent。[文档] README 能力表「Switch between different backends」「Use with any agent」。
- 每 conversation 可进独立 Docker（工作区与会话状态挂载可随容器替换保留）。[文档] README「Option 3: With Multiple Docker Sandboxes」。

### 2.4 安全姿态（有限）

- 本地无沙箱模式明确警告「agent will have full access to your filesystem」。[文档] README Option 1 WARNING。
- 自托管指南要求鉴权、HTTPS、防火墙、工作区收窄。[文档] `docs/architecture.md`「Security posture」、`docs/SELF_HOSTING.md`。

---

## 3. 它没有什么（对照企业级三空位）

| 我们的概念 | OpenHands | 判定 |
| --- | --- | --- |
| **通用 Trigger→Eval→Mandate** | Webhook/Cron → JMESPath 过滤 → 直接起 AutomationRun；无 Policy/Mandate/accept-mode/开票权 | ❌ 研发域触发 ≠ Eval |
| **任务域焚毁** | Docker 会话工作区可复用；无「凭据随域生灭 + 只留移交包」 | ❌ |
| **组织级治理核心** | 有 `org_id`、run-as user/service；无对账三态、冻结、知识生产线、BOS 十动作分离 | ❌ 仅外形 |
| **Router/Worker/Watchdog 异构角色** | Coding agent + Automation watchdog（不健康检查类）；非异构角色编排 | ❌ |
| **编排事实账本** | AutomationRun 历史 ≠ thread 归属/派发/在途/待对账四类事实 | ❌ |

---

## 4. 可借 / 不可借

### 可借（裁剪清单）

1. **服务边界文案与仓边界**：`when`（Automation）与 `what`（Agent Server）分仓、分 API、分迁移——实现 Control Plane ≠ Runtime 时的工程模板。[文档] 两仓 README boundaries。
2. **运行记录形状**：run 状态机 + `trigger_source` + 事件 payload 归档——可作「触发后可观测」的最小表结构，**不要**升为编排事实权威。
3. **事件匹配 DSL**：JMESPath + 自定义函数——适合**来源轨道上的技术过滤**；Eval 仍在其后自建。
4. **run-as user/service**：自动化以谁的身份跑的字段——对照调用身份，但≠ Mandate。
5. **多后端切换**：执行落点可换、UI 不绑死一台机器——与「Assignment ≠ Executor 所在机器」同向的弱先例。

### 不可借

- 把 Automation 当成通用准入控制平面或 DSH 的 Trigger/Eval。
- 把 conversation Docker 当成任务域默认生命周期。
- 把 GitHub/Jira 等研发集成默认成企业事件总线。
- 整包 fork Agent Canvas 当企业门户。

---

## 5. 建议

1. **审计优先级**：P1 外围——精读 Automation 的 `dispatcher.py` / `scheduler.py` / `models.py`，只摘分层与 run 记录。  
2. **对接姿势**：若研发域要「PR 来了跑 agent」，用 Automation 类服务作**适配器**；开票与责任仍走自建 Control Plane + BOS。  
3. **三空位**：不因 OpenHands 而更新；仍须自建。

---

## 6. 引用

- [文档] `OpenHands/OpenHands` README、`docs/architecture.md`、`docs/SELF_HOSTING.md`
- [文档] `OpenHands/automation` README（boundaries、Project Structure）
- [代码] `openhands/automation/models.py`、`filter_eval.py`、`dispatcher.py`、`scheduler.py`、`trigger_matcher.py`、`webhook_router.py`
- 本仓库：`docs/drafts/enterprise-superagent-borrowable-oss-survey.md` §3.4、`enterprise-superagent-architecture.md` §0/§4/§7
