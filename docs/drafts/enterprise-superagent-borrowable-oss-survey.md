# 企业级 Super-Agent：值得借鉴的开源项目综述

> **性质**：公开 GitHub 侧的**架构设计价值索引**。只收录「对本设计真的值得借鉴」的项目——有可核对的代码/文档证据，能落到架构空位或生产级先例。排序依据是**对本设计的架构决策价值**，不是星数，也不是「作为一般 agent 好不好用」。  
> **坐标系**：与 `enterprise-superagent-reference-survey.md`（下称「入口综述」）同一套 §0 三问；设计结论以 `enterprise-superagent-architecture.md` 为准（三类事实：制度 / 认知 / 编排；三个空位：通用准入链 / 任务域焚毁 / 组织级治理）。  
> **基线**：仓库元数据以 **2026-11-07（Asia/Shanghai）** 前后 GitHub HEAD 为准；事实分 [文档] / [代码]。分级不新增仓库事实，只重排已有深查。  
> **读法**：先读 §1。后文总表、分组核实、材料索引是证据，不是第二份等权推荐。  
> **关系**：入口综述覆盖已考察的 8 个对象（含私有系统与本仓库原型）。本文是**公开 GitHub 侧、可借鉴层**的续篇：不重写那 8 个对象的深查；其中对架构边界同等重要的项在 §1 用一行指针列入 S，正文仍留在入口综述。

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

## 1. 架构设计高价值分级索引

本节是本文的入口。分级只回答一个问题：这项先例会不会改变**本设计**的 Control Plane 或领域模型怎么写。

三条同时成立：

1. 下表里的项目绝大多数是**可裁剪的先例**，不是可以整包接上的产品。
2. **没有一项填满三个空位**（通用准入链 / 任务域焚毁 / 组织级治理）。
3. **企业 Control Plane 仍须自建**：DSH 领域模型，制度事实只消费 BOS，认知事实归 Spring-AI-RAG，编排事实由本项目自持。

过 §0 门槛只说明「可以对照」，不说明「会改变架构边界」。**多数过关项对架构决策权重不高。** 要读深查、并据此改边界写法的，是 S。A 只裁外形或工程缝。B 留在索引里，避免日后把协议或反模式误升成主参照。

| 档 | 客观标准 |
| --- | --- |
| **S** | 直接约束 Control Plane 或领域模型在至少一个空位上的写法；或已在入口综述中被当作生产级通道 / 账本先例 |
| **A** | 能裁出外壳、接口边界或存储外形，但不进入控制平面核心 |
| **B** | 协议、脚注或警示。索引保留，架构权重低 |

深查报告的路径以 §8 为总索引；下表给出读边界时要打开的那一份。

### S / 真高价值（读深查 + 决定架构边界）

| 项目 | 对架构的真实价值（一句） | 主要空位 | 深查报告相对路径 | 禁借一句话 |
| --- | --- | --- | --- | --- |
| **microsoft/agent-governance-toolkit（AGT）** | 公开项目里最接近动作级治理的形状：确定性策略闸、Decision Record、kill-switch、身份绑定。用来决定空位①上「动作是否允许」写到哪一层 | ①部分（动作是否允许）。开票权仍空 | `docs/drafts/agt-deep-research-report.md` | `require_approval` 与动作闸不是 Trigger→Eval→Mandate |
| **OpenSandbox + CubeSandbox**（一条架构课；**SPACE 作 API 伴读**） | 销毁路径 + 箱外 Credential Vault，对齐架构 §4.5 / §6.2 的基建。填的是空位②的基础设施，不是移交包产品语义。SPACE 只贡献 Firecracker「模板→沙箱→会话→delete」的 API 清洁度，vault 弱于前两者 | ②部分（基建）。①③不填 | `docs/drafts/opensandbox-deep-research-report.md`、`docs/drafts/cubesandbox-deep-research-report.md`；伴读 `docs/drafts/space-deep-research-report.md` | pause / resume / snapshot 不得当任务域默认；没有移交包不得宣布焚毁已解决 |
| **paperclipai/paperclip** | 空位③目前最好的组织外形：Org / Goal / Issue / Assignment / Heartbeat / Budget，且控制面与 Runtime Adapter 解耦。schema 已核实无 Mandate | ③部分外形。①明确不填。②弱 | `docs/drafts/paperclip-deep-research-report.md` | 无 Mandate；`paperclip-eval-kernel` 是产品评测，不是准入 Eval |
| **入口综述已深查**（Comma / OpenMausBot / UHP；BOS / Spring-AI-RAG 为承载者） | 与上三行同一档，正文不在本文展开。Comma 送达、OpenMausBot 委派账本、UHP 驱动契约是生产级通道 / 账本先例；BOS 与 Spring-AI-RAG 是制度 / 认知事实的承载者，决定 Control Plane **不复刻什么** | 通道与账本有先例；三个空位仍空。承载者不是空位填充物 | `docs/drafts/enterprise-superagent-reference-survey.md` §2、§4；`docs/drafts/comma-deep-research-report.md`；`docs/drafts/openmausbot-deep-research-report.md`（UHP 无独立深查，见入口综述 §4.1 与架构 §11.2） | 通道先例不是准入链、任务域焚毁或组织治理；个人助理 / 桌面委派整包不是企业 Control Plane |

### A / 有价值（裁剪外形或边界，不进控制平面核心）

| 项目 | 对架构的真实价值（一句） | 主要空位 | 深查报告相对路径 | 禁借一句话 |
| --- | --- | --- | --- | --- |
| **archestra-ai/archestra** | 平台外壳：SSO / RBAC、触发入口、MCP / A2A 网关、成本与护栏。可裁「组织怎么进门」 | ③部分外形。①②弱 | `docs/drafts/archestra-deep-research-report.md` | 整包替代三类事实归位；AGPL-3.0 + Enterprise 未评估不得当底座 |
| **bytedance/deer-flow** | `SandboxProvider`、Message Gateway、subagent 的 harness 边界。执行环境可插拔，本身不定义企业准入 | 不进控制平面。②仅当后端本身可销毁时才沾边 | `docs/drafts/deerflow-deep-research-report.md` | 长周期 harness 不是企业准入，也不是组织治理 |
| **OpenHands/OpenHands** | Automation Service 与 Agent Server 分开：何时起跑，和谁在跑，是两段 | 不进控制平面。研发域触发不是 Eval | `docs/drafts/openhands-deep-research-report.md` | Cron / Webhook 自动化不是 Trigger→Eval→Mandate |
| **hatchet-dev/hatchet**（或 Temporal 同类，二选一） | 多租户 durable 存储外形：事件触发、重试、可观测。可选的编排存储外壳 | ③仅外形。①②不填 | `docs/drafts/hatchet-deep-research-report.md` | 通用工作流引擎不是 Mandate、任务域或制度事实 |
| **nolabs-ai/nono** | 工具粒度的一次一箱 + 凭据代理。与 OpenMausBot bot-box、UHP relay 同族，密钥出进程 | ②原语，粒度错位（工具不是任务域信封）。①③无 | `docs/drafts/nono-deep-research-report.md` | 工具级隔离不得升成任务域产品 |

### B / 协议·脚注·警示（索引保留，架构权重低）

**SPACE 不单列。** 它的 API 清洁度已并入 S 的 OpenSandbox / CubeSandbox 一行。单独看，它没有一等公民 Credential Vault，pause / suspend 不得叙述成焚毁。

| 项目 | 对架构的真实价值（一句） | 主要空位 | 深查报告相对路径 | 禁借一句话 |
| --- | --- | --- | --- | --- |
| **a2aproject/A2A** | Agent↔Agent 的发现 / 任务 / 消息契约。互操作合同，到此为止 | 不填空位 | `docs/drafts/a2a-deep-research-report.md` | A2A Task 不是 Mandate，也不是 Assignment 账本 |
| **IBM/mcp-context-forge** | MCP / A2A / REST 联邦网关：发现、鉴权、限流、可观测 | ①弱，③弱，②无 | `docs/drafts/contextforge-deep-research-report.md` | 网关不是编排事实账本，也不是 BOS |
| **kubernetes-sigs/agent-sandbox** | 只借 `Sandbox` CRD / WarmPool 的**声明式 API 形状** | ②方向相反 | `docs/drafts/k8s-agent-sandbox-deep-research-report.md` | hibernation / resume 是焚毁的反模式，禁止当任务域默认生命周期 |
| **sisyphuslabs/dori-superagent** | 与 DSH 同构的 Lead / Lane / Duty 脚注，说明三角色可以在很小的代码量里落地 | 三空位皆无 | `docs/drafts/dori-superagent-deep-research-report.md` | 不升主参照；个人 coding 终端拓扑不是企业租户治理 |

### 不值得当架构主参照

分级表只排序**已过 §0** 的项。下面这些不进分级，避免被当成「漏收的高价值项目」：

| 对象 | 为什么不进分级 |
| --- | --- |
| **OpenClaw / Hermes** 及包装物 | 用户硬排除。定位是个人单租户或 personal assistant。机制最多留在对照脚注，不进借鉴顺序 |
| **kortix-ai/CompanyOS**（原 Suna） | ELv2 巨石：可研究，不可当底座。session 的 sleep / wake 与任务域焚毁相反 |
| **把 hibernation / pause / resume 当任务域** | 生命周期哲学与架构 §4.5 / §6.2 冲突。因此 k8s agent-sandbox 只留在 B 且仅 API；OpenSandbox、CubeSandbox、SPACE 里的 pause 能力同样不得抄进任务域默认 |

### 分层判断（保留；入口以上表为准）

公开 GitHub 上没有完整实现「企业级 Super-Agent」的现成整包。分层结论不变，权重以本节分级为准：

| 层 | 结论 |
| --- | --- |
| **准入 / 制度接缝** | 仍空。动作级策略有先例（AGT，S）；开票权 Eval / Mandate 仍须自建并对接 BOS |
| **任务域焚毁** | **产品语义仍空**。销毁生命周期 + 箱外凭据 vault 的基建先例是 OpenSandbox / CubeSandbox（S；SPACE 仅 API 伴读）。nono 是工具粒度（A） |
| **组织治理核心** | **仍空**。组织 / Assignment 外形看 Paperclip（S）；SSO / 网关外壳看 Archestra（A），不与 Paperclip 等权 |
| **通道与账本** | 生产级先例在入口综述（Comma / OpenMausBot / UHP，S）。A2A / ContextForge 是协议与网关（B）；Hatchet 是 durable 外形（A） |
| **Harness / 工程边界** | DeerFlow、OpenHands（A）可作外围；不进控制平面 |

**姿态**：自建企业 Control Plane，按 S → A 的顺序裁剪具体机制。禁止整包 fork 当底座。

## 2. 总表（仅过关）

> 权重以 §1 为准。本表只回答「过没过 §0、借什么、空位落在哪」，不表示各行等权。多数行对架构决策权重不高。

| 分级 | 项目 | 许可 | 借鉴什么 | 不要借什么 | 对三个空位 | 落点 |
| --- | --- | --- | --- | --- | --- | --- |
| **S** | **microsoft/agent-governance-toolkit** | MIT | 确定性动作策略闸、审计 Decision Record、kill-switch、身份绑定形状 | 把动作审批当成 Trigger→Eval 开票链 | ①部分 ②弱 ③部分 | **部分填空**（动作准入/审计） |
| **S** | **opensandbox-group/OpenSandbox** | Apache-2.0 | `create→run→destroy`、Credential Vault（真密钥出箱）、egress、多租户 ns | pause/resume 当默认生命周期；无移交包就当已解决焚毁 | ②部分 | **部分填空**（焚毁基建） |
| **S** | **TencentCloud/CubeSandbox** | Apache-2.0 | MicroVM + credential vault + 生命周期 API（E2B 兼容） | 快照/常驻哲学；当任务域信封产品 | ②部分 | **部分填空**（同左，硬件隔离更强） |
| **S（API 伴读）** | **perplexityai/SPACE** | Apache-2.0 | Firecracker 沙箱：模板→沙箱→会话→delete 的干净 API | 无移交包、无组织编排；无一等公民 Credential Vault，不得单列升格 | ②部分 | **先例**（微 VM API；不单列） |
| **A** | **nolabs-ai/nono** | Apache-2.0 | 每工具一次临时沙箱、凭据代理注入、审计 | 产品定位（可包装个人助理）；工具粒度≠任务域信封 | ②部分（粒度错位） | **部分填空**（工具级隔离） |
| **S** | **paperclipai/paperclip** | MIT | Org / Goal / Issue / Assignment / Heartbeat / Budget / Approval 外形；控制面与 Runtime Adapter 解耦 | `eval-kernel`（产品评测，不是准入 Eval）；整包当 Mandate 系统；依赖消费级助理生态叙事 | ①无 ②弱 ③部分外形 | **过关新参照**（组织/Assignment 外形） |
| **A** | **archestra-ai/archestra** | AGPL-3.0 + Enterprise | SSO/RBAC、触发入口、MCP/A2A 网关、成本/护栏外形 | 整包替代三类事实归位；AGPL/EE 双许可未评估就商用 | ①弱 ②弱–中 ③部分外形 | **部分填空**（平台外壳） |
| **A** | **bytedance/deer-flow** | MIT | 长周期 harness、`SandboxProvider` 抽象、Message Gateway、subagent | 当成企业准入控制平面 | ①无 ②弱–中 ③无 | **外围先例**（Harness） |
| **A** | **OpenHands/OpenHands** | MIT | Automation Service ↔ Agent Server 分层；Cron/事件触发后的调度与失败处理 | 研发工作流自动化 ≠ 通用企业 Super-Agent | ①无 ②弱 ③无 | **外围先例**（工程边界） |
| **B** | **a2aproject/A2A** | Apache-2.0 | Agent↔Agent 互操作契约形状 | 用协议代替 Mandate/Assignment 领域模型 | 不填空位 | **先例**（C 类协议） |
| **B** | **IBM/mcp-context-forge** | Apache-2.0 | MCP/A2A/REST 联邦网关：发现、鉴权、限流、可观测 | 用网关代替编排事实账本或 BOS | ①弱 ②无 ③弱 | **先例**（MCP host） |
| **A** | **hatchet-dev/hatchet** | MIT | 多租户 durable 任务、事件触发、重试、可观测 | 用通用工作流引擎冒充 agent 制度/任务域 | ③部分外形 | **先例**（租户化编排存储外形） |
| **B** | **kubernetes-sigs/agent-sandbox** | Apache-2.0 | Sandbox CRD / WarmPool 的**声明式 API 形状** | **生命周期哲学**（hibernation / resume） | ②方向相反 | **先例（API only）**；禁止当焚毁默认 |
| **B** | **sisyphuslabs/dori-superagent** | MIT | Lead/Lane/Duty/merge gate 与 DSH 同构对照 | 升为主参照；当企业租户治理 | 皆无 | **脚注级**（主动式角色切分） |

### 入口综述已深查（本表不重复展开）

| 分级 | 对象 | 在本设计中的位置 | 指针 |
| --- | --- | --- | --- |
| S（承载者） | BOS / Spring-AI-RAG / BlueCortex | 制度 / 认知 / 参与者记忆承载者 | 入口综述 §2 |
| S（领域模型） | DSH 原型 + DeepSeek 设计文章 | 领域模型与 BYOM 框架 | 入口综述 §3 |
| S | HarnessRouter/UHP、Comma、OpenMausBot | C 类驱动契约、送达语义、委派账本 | 入口综述 §4 |

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

短表见 §1「不值得当架构主参照」。本节保留理由，不新增主推。

| 项目 / 类别 | 理由 |
| --- | --- |
| **OpenClaw / Hermes** 及包装物 | 用户硬排除；SECURITY/定位为个人单租户或 personal assistant；机制最多作对照脚注 |
| **kortix-ai/CompanyOS**（原 Suna） | 覆盖面广但 **ELv2 巨石**；session **sleep/wake** 与焚毁相反；可研究不可当底座 |
| Agent Zero / Goose / Open Interpreter / OpenManus / AgenticSeek 等 | 个人工作空间或 Manus 风格执行；不承载三类事实与三空位 |
| 多数 multi-agent framework / LangGraph 单列 | 可作 Eval **内部**推理图组件，不能替代控制平面（LangGraph 若用，仅限此角色） |
| 把 hibernation 沙箱当任务域的叙事 | 生命周期哲学冲突 |

## 5. 三个空位：更新判断（2026-11-07）

| 空位 | 判断 | 可借鉴先例（裁剪用；权重见 §1） |
| --- | --- | --- |
| **1. 通用准入链** | **仍空** | AGT（S，动作级）。Paperclip 的 Heartbeat / 审批只是唤醒外形，不填本空位 |
| **2. 任务域焚毁** | **产品语义仍空**；基建**部分有先例** | OpenSandbox / CubeSandbox（S）；SPACE 仅 API 伴读；nono 为工具粒度（A）。**反向过滤** k8s agent-sandbox 与各类 pause |
| **3. 组织级治理** | **核心仍空**；外形**部分有先例** | Paperclip（S）。Archestra、Hatchet 只是外壳或 durable 外形（A），不与 Paperclip 等权。知识生产线与对账三态仍接 BOS / Spring-AI-RAG 自建 |

通道与账本「可以做生产级」的判断不变（见入口综述 §5）；本篇把沙箱/凭据与组织外形先例加厚，**不推翻三空位须自建**。

## 6. 建议的借鉴顺序（源码审计）

顺序跟 §1，按架构设计价值，不按星数。多数过关项对架构决策权重不高：S 决定边界，A 只裁外形，B 留索引。

### S — 先读深查，决定架构边界

1. **本仓库 DSH 原型**，加上入口综述里的承载者（BOS / Spring-AI-RAG）— 领域模型与制度 / 认知归位；不在公开 GitHub 侧重找替代品  
2. **入口综述通道先例** — Comma 送达、OpenMausBot 委派账本、UHP 驱动契约  
3. **AGT** — 动作策略 / 审计 / kill-switch 的形状；书面记下它不是 Trigger→Eval→Mandate  
4. **OpenSandbox + CubeSandbox**（SPACE 只作 API 伴读）— destroy + vault；裁掉 pause 哲学  
5. **Paperclip** — Org / Goal / Issue / Assignment / Heartbeat / Budget 外形；书面记录「无 Mandate；eval-kernel 不是准入 Eval」

### A — 裁剪外形或边界，不进控制平面核心

6. **Archestra** — 平台外壳；先评估 AGPL / Enterprise  
7. **DeerFlow** — `SandboxProvider` / Gateway  
8. **OpenHands** — Automation Service ↔ Agent Server  
9. **Hatchet 或 Temporal（二选一）** — 只看多租户 durable 外形  
10. **nono** — 工具级一次一箱与凭据代理；粒度错位，不升成任务域

### B — 索引保留，架构权重低

11. **A2A、ContextForge** — 互操作合同与 MCP host，不代替 Mandate / Assignment 账本  
12. **kubernetes-sigs/agent-sandbox** — 仅声明式 API；生命周期是反模式  
13. **dori-superagent** — 同构脚注，不作为主参照审计

### 不进主参照审计

OpenClaw、Hermes、CompanyOS（除非单独做许可证与反模式研究）、把 hibernation 当任务域的叙事。消费级桌面助理清单同样不进。

## 7. 推荐的组合姿态（一句话图）

权重以 §1 为准。下图是装配关系：S 决定边界，A / B 只提供外形、协议或警示。任务域的默认动作是销毁；pause / hibernation 不进入这张图。

```
自建 Control Plane（DSH 领域模型）          ← 仍须自建
  ├─ 制度事实 → 只消费 BOS（不复刻）          〔承载者〕
  ├─ 认知事实 → Spring-AI-RAG + 第 9 章知识生产线
  ├─ 编排事实 → 本项目自持（对账/重启/幂等）
  ├─ 通道/账本先例 ← Comma / OpenMausBot / UHP 〔S，入口综述〕
  ├─ 动作治理外形 ← AGT（裁剪）               〔S〕
  ├─ 组织/Assignment 外形 ← Paperclip         〔S〕
  ├─ 平台外壳 ← Archestra（许可评估后）       〔A〕
  ├─ 执行域基建 ← OpenSandbox / Cube          〔S；SPACE 仅 API 伴读〕
  ├─ 工具级凭据卫生 ← nono                    〔A，粒度错位〕
  ├─ Durable 外形 ← Hatchet 或 Temporal（可选）〔A〕
  └─ 互操作 ← A2A / ContextForge              〔B，不代替账本〕
         Runtime/Harness ← DeerFlow / OpenHands 〔A；Adapter 接入，无写控制平面权〕
```

坚持三项解耦：**Control Plane ≠ Runtime**；**Assignment ≠ Executor 所在机器**；**Mandate ≠ 无限工具权限**。

## 8. 材料索引

深查报告的入口以本表为准，分级与 §1 一致。`S（API 伴读）` 表示不单列升格。设计坐标文档不参与分级。

| 分级 | 材料 | 路径 |
| --- | --- | --- |
| — | 架构文档 | `docs/drafts/enterprise-superagent-architecture.md` |
| — | 会话备忘 | `docs/drafts/enterprise-superagent-session-notes.md` |
| — | 本文 | `docs/drafts/enterprise-superagent-borrowable-oss-survey.md` |
| S（入口） | 入口综述（8 对象 + 原三空位；含 BOS / Spring-AI-RAG / UHP） | `docs/drafts/enterprise-superagent-reference-survey.md` |
| S | Comma 深查 | `docs/drafts/comma-deep-research-report.md` |
| S | OpenMausBot 深查 | `docs/drafts/openmausbot-deep-research-report.md` |
| S | AGT 深查 | `docs/drafts/agt-deep-research-report.md` |
| S | OpenSandbox 深查 | `docs/drafts/opensandbox-deep-research-report.md` |
| S | CubeSandbox 深查 | `docs/drafts/cubesandbox-deep-research-report.md` |
| S（API 伴读） | SPACE 深查 | `docs/drafts/space-deep-research-report.md` |
| S | Paperclip 深查 | `docs/drafts/paperclip-deep-research-report.md` |
| A | Archestra 深查 | `docs/drafts/archestra-deep-research-report.md` |
| A | DeerFlow 深查 | `docs/drafts/deerflow-deep-research-report.md` |
| A | OpenHands 深查 | `docs/drafts/openhands-deep-research-report.md` |
| A | Hatchet 深查 | `docs/drafts/hatchet-deep-research-report.md` |
| A | nono 深查 | `docs/drafts/nono-deep-research-report.md` |
| B | A2A 深查 | `docs/drafts/a2a-deep-research-report.md` |
| B | ContextForge 深查 | `docs/drafts/contextforge-deep-research-report.md` |
| B | k8s agent-sandbox 深查 | `docs/drafts/k8s-agent-sandbox-deep-research-report.md` |
| B | dori-superagent 深查（脚注） | `docs/drafts/dori-superagent-deep-research-report.md` |

---

*撰写说明：过关名单综合 2026-11-07 对公开 GitHub 的扩展检索与对高星产品清单的批判核验。分级只重排同一批深查：S 决定架构边界，多数过关项权重不高。各报告见上表（同目录）。*
