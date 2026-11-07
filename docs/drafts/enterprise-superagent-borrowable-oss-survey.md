# 企业级 Super-Agent：值得借鉴的开源项目综述

> **性质**：只收录「对本设计真的值得借鉴」的公开开源项目——有可核对的代码/文档证据，能落到架构空位或生产级先例，而不是高星清单或产品宣传汇总。  
> **坐标系**：与 `enterprise-superagent-reference-survey.md`（下称「入口综述」）同一套 §0 三问；设计结论以 `enterprise-superagent-architecture.md` 为准。  
> **基线**：仓库元数据以 **2026-11-07（Asia/Shanghai）** 前后 GitHub HEAD 为准；事实分 [文档] / [代码]。  
> **关系**：入口综述覆盖已考察的 8 个对象（含私有系统与本仓库原型）。本文是**公开 GitHub 侧、可借鉴层**的续篇：不重写那 8 个对象的深查，只在总表里用一行指针标出它们已在入口综述中的位置。

## 0. 「值得借鉴」的门槛

本设计要的不是「又一个 Agent 框架」，而是能对照三类事实（制度 / 认知 / 编排）与三个空位的**可裁剪先例**：

1. **通用准入链**（Trigger→Eval→Mandate / accept-mode）——谁有权发起工作  
2. **任务域焚毁**——每任务一域、凭据随域生灭、只留移交包  
3. **组织级治理**——租户化编排存储、对账三态、冻结/审计、知识生产线

另加一类：**通道与账本先例**（送达、委派、驱动契约、凭据卫生、协议）——不填空位，但证明「可以做生产级」。

**过关条件**（须同时满足）：

- 至少服务上述空位之一，或提供可引用的通道/账本/沙箱基建先例  
- 有 README **以及**关键代码路径或正式 docs 可核对  
- 许可允许研究与内部参照（ELv2 等仅可研究、不可当底座时单独标注）

**明确不收录为主推**：OpenClaw、Hermes 及同类消费级个人助理壳；纯 prompt / multi-agent 玩具框架；把 hibernation/pause 伪装成任务域焚毁的项目。

## 1. 总判（先读这段）

公开 GitHub 上**没有**完整实现「企业级 Super-Agent」的现成整包。值得借鉴的是分层先例：

| 层 | 结论 |
| --- | --- |
| **准入 / 制度接缝** | 仍空。动作级策略有先例（AGT）；开票权 Eval/Mandate 仍须自建并对接 BOS |
| **任务域焚毁** | **产品语义仍空**；销毁生命周期 + 箱外凭据 vault 已有可参照基建（OpenSandbox / CubeSandbox / SPACE / nono） |
| **组织治理核心** | **仍空**；org/工单/预算/SSO 等**外形**可参照（Paperclip / Archestra） |
| **通道与账本** | 有先例（入口综述中的 Comma / OpenMausBot / UHP；外加 A2A / ContextForge / Hatchet） |
| **Harness / 工程边界** | DeerFlow、OpenHands 可作外围；不进控制平面 |

**推荐姿态**：自建企业 Control Plane（DSH 领域模型 + BOS/RAG 归位），**裁剪借鉴**下表项目的具体机制；禁止整包 fork 当底座。

## 2. 总表（仅过关）

| 项目 | 许可 | 借鉴什么 | 不要借什么 | 对三个空位 | 落点 |
| --- | --- | --- | --- | --- | --- |
| **microsoft/agent-governance-toolkit** | MIT | 确定性动作策略闸、审计 Decision Record、kill-switch、身份绑定形状 | 把动作审批当成 Trigger→Eval 开票链 | ①部分 ②弱 ③部分 | **部分填空**（动作准入/审计） |
| **opensandbox-group/OpenSandbox** | Apache-2.0 | `create→run→destroy`、Credential Vault（真密钥出箱）、egress、多租户 ns | pause/resume 当默认生命周期；无移交包就当已解决焚毁 | ②部分 | **部分填空**（焚毁基建） |
| **TencentCloud/CubeSandbox** | Apache-2.0 | MicroVM + credential vault + 生命周期 API（E2B 兼容） | 快照/常驻哲学；当任务域信封产品 | ②部分 | **部分填空**（同左，硬件隔离更强） |
| **perplexityai/SPACE** | Apache-2.0 | Firecracker 沙箱：模板→沙箱→会话→delete 的干净 API | 无移交包、无组织编排 | ②部分 | **先例**（微 VM API） |
| **nolabs-ai/nono** | Apache-2.0 | 每工具一次临时沙箱、凭据代理注入、审计 | 产品定位（可包装个人助理）；工具粒度≠任务域信封 | ②部分（粒度错位） | **部分填空**（工具级隔离） |
| **paperclipai/paperclip** | MIT | Org / Goal / Issue / Assignment / Heartbeat / Budget / Approval 外形；控制面与 Runtime Adapter 解耦 | `eval-kernel`（产品评测，不是准入 Eval）；整包当 Mandate 系统；依赖消费级助理生态叙事 | ①无 ②弱 ③部分外形 | **过关新参照**（组织/Assignment 外形） |
| **archestra-ai/archestra** | AGPL-3.0 + Enterprise | SSO/RBAC、触发入口、MCP/A2A 网关、成本/护栏外形 | 整包替代三类事实归位；AGPL/EE 双许可未评估就商用 | ①弱 ②弱–中 ③部分外形 | **部分填空**（平台外壳） |
| **bytedance/deer-flow** | MIT | 长周期 harness、`SandboxProvider` 抽象、Message Gateway、subagent | 当成企业准入控制平面 | ①无 ②弱–中 ③无 | **外围先例**（Harness） |
| **OpenHands/OpenHands** | MIT | Automation Service ↔ Agent Server 分层；Cron/事件触发后的调度与失败处理 | 研发工作流自动化 ≠ 通用企业 Super-Agent | ①无 ②弱 ③无 | **外围先例**（工程边界） |
| **a2aproject/A2A** | Apache-2.0 | Agent↔Agent 互操作契约形状 | 用协议代替 Mandate/Assignment 领域模型 | 不填空位 | **先例**（C 类协议） |
| **IBM/mcp-context-forge** | Apache-2.0 | MCP/A2A/REST 联邦网关：发现、鉴权、限流、可观测 | 用网关代替编排事实账本或 BOS | ①弱 ②无 ③弱 | **先例**（MCP host） |
| **hatchet-dev/hatchet** | MIT | 多租户 durable 任务、事件触发、重试、可观测 | 用通用工作流引擎冒充 agent 制度/任务域 | ③部分外形 | **先例**（租户化编排存储外形） |
| **kubernetes-sigs/agent-sandbox** | Apache-2.0 | Sandbox CRD / WarmPool 的**声明式 API 形状** | **生命周期哲学**（hibernation / resume） | ②方向相反 | **先例（API only）**；禁止当焚毁默认 |
| **sisyphuslabs/dori-superagent** | MIT | Lead/Lane/Duty/merge gate 与 DSH 同构对照 | 升为主参照；当企业租户治理 | 皆无 | **脚注级**（主动式角色切分） |

### 入口综述已深查（本表不重复展开）

| 对象 | 在本设计中的位置 | 指针 |
| --- | --- | --- |
| BOS / Spring-AI-RAG / BlueCortex | 制度 / 认知 / 参与者记忆承载者 | 入口综述 §2 |
| DSH 原型 + DeepSeek 设计文章 | 领域模型与 BYOM 框架 | 入口综述 §3 |
| HarnessRouter/UHP、Comma、OpenMausBot | C 类驱动契约、送达语义、委派账本 | 入口综述 §4 |

## 3. 按「借什么」分组的核实要点

### 3.1 动作级治理（对准空位①的外围，不是替代）

#### microsoft/agent-governance-toolkit（AGT）

1. **承载**：[文档] Policy 引擎族、SPIFFE/DID 身份、防篡改审计、特权环、SRE kill-switch；多语言 SDK。[结构] `agent-os` / `agent-runtime` / `agent-sre` / `agent-mesh` / `agent-compliance` 等包。  
2. **先例**：确定性拦截（denied 结构上不可达）、Decision Record、框架适配面。  
3. **空位**：① **部分**——借鉴「动作是否允许」的形状；**开票权**仍须自建并对接 BOS 十动作分离。② 弱。③ 审计/合规映射可作组织治理参考层。  
4. **借鉴清单**：策略版本化、审计记录字段、kill-switch 接线方式。  
5. **禁借**：`require_approval` ≠ Mandate；不要用 AGT 冒充 Trigger→Eval。

### 3.2 销毁型沙箱与凭据卫生（对准空位②的基建）

#### OpenSandbox / CubeSandbox / SPACE

1. **共同承载**：可销毁执行环境 +（OpenSandbox/Cube）Credential Vault（真密钥留在箱外/egress 侧）。  
2. **先例**：与架构 §4.5 / §6.2 **同向**的基础设施——「建域 → 注入能力凭据 → 执行 → 销毁」。SPACE 提供 Firecracker 生命周期 API 的干净形状。  
3. **空位**：② **部分填**。仍缺一等公民**移交包**（只读摘要/归档引用、无凭据、到期删）与 BYOM 节点上按任务焚毁的纪律。  
4. **借鉴清单**：destroy 必达路径、vault 边界、egress 策略、多租户 namespace（OpenSandbox）。  
5. **禁借**：pause/resume/snapshot 当默认；把控制面租户当成编排事实租户。

#### nolabs-ai/nono

1. **承载**：工具调用级 ephemeral sandbox、凭据代理、L7、审计。  
2. **先例**：与 OpenMausBot bot-box / UHP relay **同族**——密钥出进程。  
3. **空位**：隔离单元是**工具**不是**任务信封**；引用时只取安全原语。

#### kubernetes-sigs/agent-sandbox（警示条目）

1. **承载**：`Sandbox` CRD、WarmPool、**暂停/恢复**。  
2. **正确用法**：学声明式 API。  
3. **错误用法**：当成任务域默认生命周期——官方叙事是常驻/休眠，与焚毁**相反**。

### 3.3 组织 / Assignment 外形（对准空位③的外形）

#### paperclipai/paperclip

1. **承载**：[文档]「AI Agent Workforce 的 Control Plane」。[代码] schema 含 `companies` / `agents` / `goals` / `issues` / `heartbeat_runs` / `approvals` / `budget_*`；**无** `mandate` 表。Adapter 对接外部 Runtime。  
2. **先例**：组织树、任务归属、心跳唤醒、预算与审批——「谁负责什么」的外形。  
3. **空位**：① **不填**（无 Trigger→Eval→Mandate）。② 弱。③ **部分外形**——无对账三态、冻结、知识生产线。  
4. **名称陷阱**：`paperclip-eval-kernel` 是**产品评测矩阵**，不是准入 Eval。  
5. **借鉴清单**：控制面与 Runtime Adapter 解耦；Issue/Assignment/Heartbeat 状态机外形；预算边界。  
6. **禁借**：整包替代 DSH；把 Heartbeat 叙述成 Eval；依赖 OpenClaw/Hermes 员工叙事当架构前提。

#### archestra-ai/archestra

1. **承载**：企业平台面（SSO/RBAC、MCP/A2A 网关、触发、护栏、成本）。Open Core（AGPL + Enterprise）。  
2. **先例**：组织入口与平台外壳。  
3. **空位**：①弱 ②弱–中 ③部分外形。引入前评估双许可。

### 3.4 Harness 与工程边界（不进控制平面）

#### bytedance/deer-flow

- 长周期 Super-Agent harness；`SandboxProvider` 可接 OpenSandbox/E2B/AIO 等。  
- **借鉴**：Provider 抽象、Gateway、subagent 边界。  
- **禁借**：当成企业准入或组织治理。

#### OpenHands/OpenHands

- Automation Service 与 Agent Server 分离：`Trigger → Automation → Agent Server`。  
- **借鉴**：事件触发后的调度、运行记录、失败处理边界（尤其研发域）。  
- **禁借**：等同通用 Eval/Mandate/Ticket 模型。

### 3.5 协议与 durable 外形

| 项目 | 借鉴 | 边界 |
| --- | --- | --- |
| **A2A** | Agent↔Agent 发现/任务/消息契约 | 不决定 Mandate/责任归属 |
| **ContextForge** | MCP host / 联邦网关治理 | 不承载编排对账三态 |
| **Hatchet**（Temporal 同类可选） | 多租户 durable、重试、事件触发 | 通用引擎 ≠ agent 领域模型 |
| **dori-superagent** | 与 DSH 角色同构的又一份落地 | 脚注；不升主参照 |

## 4. 明确不主推（及理由）

| 项目 / 类别 | 理由 |
| --- | --- |
| **OpenClaw / Hermes** 及包装物 | 用户硬排除；SECURITY/定位为个人单租户或 personal assistant；机制最多作对照脚注 |
| **kortix-ai/CompanyOS**（原 Suna） | 覆盖面广但 **ELv2 巨石**；session **sleep/wake** 与焚毁相反；可研究不可当底座 |
| Agent Zero / Goose / Open Interpreter / OpenManus / AgenticSeek 等 | 个人工作空间或 Manus 风格执行；不承载三类事实与三空位 |
| 多数 multi-agent framework / LangGraph 单列 | 可作 Eval **内部**推理图组件，不能替代控制平面（LangGraph 若用，仅限此角色） |
| 把 hibernation 沙箱当任务域的叙事 | 生命周期哲学冲突 |

## 5. 三个空位：更新判断（2026-11-07）

| 空位 | 判断 | 可借鉴先例（裁剪用） |
| --- | --- | --- |
| **1. 通用准入链** | **仍空** | AGT（动作级）；Paperclip Heartbeat/审批（唤醒/外形，非开票 Eval） |
| **2. 任务域焚毁** | **产品语义仍空**；基建**部分有先例** | OpenSandbox / CubeSandbox / SPACE / nono；**反向过滤** k8s agent-sandbox 与各类 pause |
| **3. 组织级治理** | **核心仍空**；外形**部分有先例** | Paperclip、Archestra、Hatchet；知识生产线与对账三态仍接 BOS / Spring-AI-RAG 自建 |

通道与账本「可以做生产级」的判断不变（见入口综述 §5）；本篇把沙箱/凭据与组织外形先例加厚，**不推翻三空位须自建**。

## 6. 建议的借鉴顺序（源码审计）

### P0

1. **本仓库 DSH 原型** — Trigger/Eval/Mandate/Ticket/Assignment（不变）  
2. **入口综述已深查** — Comma 送达、OpenMausBot 委派账本、UHP 驱动契约  
3. **AGT** — 动作策略/审计形状  
4. **OpenSandbox + CubeSandbox**（SPACE 作 API 索引）— destroy + vault；裁掉 pause 哲学

### P1

5. **Paperclip** — org/assignment/heartbeat/budget 外形；书面记录「无 Mandate」  
6. **Archestra** — 平台外壳（许可评估后）  
7. **DeerFlow** — SandboxProvider / Gateway  
8. **OpenHands** — Automation↔Server 分层

### P2

9. **Hatchet 或 Temporal（二选一）** + **A2A / ContextForge** + **k8s agent-sandbox（仅 API）** + **nono（工具级）**

### 不进主推审计

OpenClaw、Hermes、CompanyOS（除非单独做许可证与反模式研究）、消费级桌面助理清单。

## 7. 推荐的组合姿态（一句话图）

```
自建 Control Plane（DSH 领域模型）
  ├─ 制度事实 → 只消费 BOS（不复刻）
  ├─ 认知事实 → Spring-AI-RAG + 第 9 章知识生产线
  ├─ 编排事实 → 本项目自持（对账/重启/幂等）
  ├─ 动作治理外形 ← AGT（裁剪）
  ├─ 组织/Assignment 外形 ← Paperclip / Archestra（裁剪）
  ├─ 执行域基建 ← OpenSandbox / Cube / SPACE / nono（销毁纪律）
  ├─ Durable 外形 ← Hatchet 或 Temporal（可选）
  └─ 互操作 ← MCP + A2A（+ ContextForge 作网关先例）
         Runtime/Harness ← DeerFlow / OpenHands / 自定义（Adapter 接入，无写控制平面权）
```

坚持三项解耦：**Control Plane ≠ Runtime**；**Assignment ≠ Executor 所在机器**；**Mandate ≠ 无限工具权限**。

## 8. 材料索引

| 材料 | 路径 |
| --- | --- |
| 入口综述（8 对象 + 原三空位） | `docs/drafts/enterprise-superagent-reference-survey.md` |
| 架构文档 | `docs/drafts/enterprise-superagent-architecture.md` |
| 会话备忘 | `docs/drafts/enterprise-superagent-session-notes.md` |
| Comma / OpenMausBot 深查 | `docs/drafts/comma-deep-research-report.md`、`openmausbot-deep-research-report.md` |
| 本文 | `docs/drafts/enterprise-superagent-borrowable-oss-survey.md` |

---

*撰写说明：本文综合 2026-11-07 对公开 GitHub 的扩展检索与对高星产品清单的批判核验；只保留过 §0 门槛的借鉴项。*
