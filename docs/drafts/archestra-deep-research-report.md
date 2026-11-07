# Archestra 深度调研报告

对象：archestra-ai/archestra，远端 `https://github.com/archestra-ai/archestra`。
基线：HEAD `8cb33633`（2026-11-07，main）。
调研方式：README / LICENSE.md / docs/pages/agents/* / `platform/shared/access-control.ts` 核对；双许可与平台能力边界单独标注。

## 0. 一句话结论

Archestra 是 **企业 AI 平台外壳（Open Core）**：SSO/RBAC、LLM/MCP/A2A 网关、触发通道、会话级代码沙箱、确定性 Guardrails（OpenAPPA）、成本与可观测——把「组织怎么安全地让人/agent 用模型与工具」做成了可部署产品。它 **不是** BOS（制度事实/流程引擎），也 **不是** 我们的 Trigger→Eval→Mandate 开票控制平面；会话沙箱默认常驻于对话、进程不跨命令保留，**不等于** 任务域焚毁。许可为 **AGPL-3.0 + Enterprise 双许可**，商用前必须评估。

**判定：空位③平台外形 + 护栏/网关先例可借鉴；禁止整包替代三类事实归位或当 BOS。**

---

## 1. 系统一览

| 项 | 内容 |
| --- | --- |
| 定位 | [文档] Secure AI Platform：Chat、LLM proxy、MCP gateway/registry/orchestrator、A2A、agent runtime、RAG connectors、guardrails、SSO/RBAC |
| 技术栈 | TypeScript 为主；`platform/` monorepo；Docker/Helm；Terraform provider |
| 规模 | ~4.4k stars；声称 Fortune-50 部署与融资（营销声明，本报告不当作架构证据） |
| 许可 | [代码] `LICENSE.md`：默认 `AGPL-3.0-only`；`*.ee.*` / `ee/` / SPDX Enterprise snippet → `LicenseRef-Archestra-Enterprise` |
| 文档结构 | `docs/pages/{admin,agents,chat,llm-proxy,mcp,knowledge,...}` |

---

## 2. 它做到了什么（实证路径）

### 2.1 身份与 RBAC（平台外壳）

[代码] `platform/shared/access-control.ts`：

- 预定义角色与权限图：`admin` / `editor` / `member` / `platformAdmin`。
- 资源动作覆盖：`agent`、`guardrailsPolicy`、`llmProxy`、`mcpGateway`、`mcpRegistry`、`environment`、`credential`、`knowledgeSource`、`auditLog`、`identityProvider`、`accessPolicies`、`team` 等。
- 与 better-auth organization 插件语句组合。

[文档] README：SSO（OIDC/SAML/Okta/Entra）、RBAC role mapping & team sync、secrets management、per-environment egress 与 cost limits。

→ 这是 **平台 IAM 外形**，回答「谁能配置代理/网关/护栏」，不是「这笔业务工作凭哪张 Mandate 开票」。

### 2.2 触发与通道（弱准入外壳）

[文档] `docs/pages/agents/index.md` + `triggers-and-channels/`：

- 调用路径：Chat/Projects、coding agent handoff（`start_agent_run`）、Slack/Teams/Telegram/Email、Webhook / A2A。
- Agent = 可复用助手：instructions、model、tools/skills/knowledge/subagents。

有「事件进来 → 跑 agent」的外壳，**未见** 与 BOS 十动作分离同构的资格评估、accept-mode、Ticket/Mandate 实体。

### 2.3 代码沙箱（会话级，非焚毁产品）

[文档] Agents → Code Sandbox：

- **每个 conversation** 一个私有 Linux 容器；`run_command` 跑 shell/Python。
- 附件、大工具结果落盘；**文件在命令间保留，运行中的进程不保留**。
- 网络服从 environment egress policy（可 per-agent 覆盖）。
- 可用 `ARCHESTRA_CODE_RUNTIME_ENABLED=false` 关掉。

→ 隔离有；生命周期是 **对话会话**，不是「一任务一域、销毁只留移交包」。

### 2.4 Guardrails（动作级确定性策略）

[文档] `docs/pages/agents/guardrails/index.md`：

- 每个 tool call 在跑前经 OpenAPPA 策略引擎（规则，非再调一个模型）；跑在 agent loop 外，抗 prompt injection 改策略。
- Lethal Trifecta：私有数据 + 不信任内容 + 外发能力 → 泄漏面；用 trust/audience label 单调收紧。
- 补救：人工批准单次调用、sanitizer、`attest-schema` 子代理、接受更严标签。

→ 与 microsoft/agent-governance-toolkit **同族**：动作级闸；**不是** Mandate 开票。可与 AGT 并列作空位①外围。

### 2.5 MCP / A2A / LLM 网关

- LLM gateway：多供应商、虚拟 API key、成本限额、动态路由。
- MCP gateway：OAuth + On-Behalf-Of（工具以用户身份跑，非共享服务账号）。
- A2A gateway：agent-to-agent 触发。
- 私有 MCP registry + K8s operator 编排。

→ C 类互操作与 MCP host 外形，可与 ContextForge / A2A 对照；不承载编排对账账本。

---

## 3. 它没有什么

| 我们需要的 | Archestra | 判定 |
| --- | --- | --- |
| **BOS 制度事实**（流程版本/审批十动作） | 无；自建 agent/工具/护栏配置 | ❌ 不是 BOS |
| **Mandate / Ticket 领域模型** | 无对应一等公民 | ❌ |
| **对账三态 / 租户冻结语义** | 有 audit/cost，无我们的冻结与待对账状态机 | ❌ |
| **任务域焚毁 + 移交包** | 会话沙箱；文件跨命令保留 | ❌ 生命周期错位 |
| **知识生产线**（agent 提案→人确认→入库） | 有 RAG connectors；非我们第 9 章生产线 | ⚠️ 弱 |
| **宽松商用许可** | AGPL + EE 双许可 | ⚠️ 引入前评估 |

---

## 4. 与企业级设计的对照

### 4.1 可以借鉴

1. **平台外壳清单**：SSO/RBAC 资源动作表、environment egress、虚拟密钥、成本限额——组织入口外形。
2. **On-Behalf-Of MCP**：工具以终端用户身份调用——对照「调用身份 ≠ Mandate」，但强化身份传递。
3. **Guardrails 标签单调收紧 + 人批单次调用**：动作级治理与 Lethal Trifecta 叙事，可对照 AGT / 我们 §7.4 工具权限层。
4. **A2A/Webhook 触发外形**：作为通道适配器先例，不升格为 Eval。
5. **Open Core 边界意识**：哪些在 AGPL、哪些在 EE——我们自建时避免无意污染。

### 4.2 不可借

- **整包替代 BOS / 编排存储 / DSH 领域模型**。
- **把会话沙箱当任务域默认生命周期**。
- **未评估 AGPL/EE 就商用嵌入**。
- **Migration Kit 针对 OpenClaw/Hermes 的叙事**不改变我们对消费级助理的排除（最多作「企业如何收编危险单租户」的反模式阅读）。

---

## 5. 结论与建议动作

1. **定位**：P1「平台外壳」参照；许可评估通过前不进依赖树。
2. **建议动作**：
   - 精读 `platform/shared/access-control.ts` 与 guardrails 策略模型，抽取 RBAC 资源清单与标签闸形状；
   - 对照 MCP OBO 与我们的调用身份设计；
   - 法务评估 AGPL vs EE 对内部研究/未来产品的影响；
   - **明确写入材料**：Archestra ≠ BOS。
3. **三空位**：①弱（护栏/触发外壳）②弱–中（会话沙箱）③部分外形。

---

## 6. 引用

- README.md、LICENSE.md、LICENSE_AGPL、LICENSE_ENTERPRISE
- docs/pages/agents/{index.md,guardrails/index.md}、docs/pages/admin/*
- platform/shared/access-control.ts
- 对照：architecture §1.1 / §4.5 / §7.4；borrowable-oss-survey §3.3
