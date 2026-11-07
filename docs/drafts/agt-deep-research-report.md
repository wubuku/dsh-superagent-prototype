# microsoft/agent-governance-toolkit 深度调研报告

对象：`microsoft/agent-governance-toolkit`（AGT），远端 `https://github.com/microsoft/agent-governance-toolkit`。  
基线：仓库元数据截至 **2026-11-07（Asia/Shanghai）**；近期可见提交含 `ea260c540`（2026-11-05，`fix(agent-lightning): count only accepted spans…`）。`pushed_at` 显示至 2026-11-06。  
调研方式：README / Architecture / LIMITATIONS / 正式 specs（Audit、Hypervisor）与入口综述、`enterprise-superagent-architecture.md`（§0 三类事实、§1.4、§4.5、§7、§11）、`enterprise-superagent-borrowable-oss-survey.md` 对照；关键断言附路径。事实分 [文档] / [代码·包结构]。

## 0. 一句话结论

AGT 是**动作级、确定性的应用层治理中间件**（Public Preview）：在工具调用/消息/委派**到达外部世界之前**做策略求值，denied 在结构上不可达；并提供身份（SPIFFE/DID）、防篡改审计、特权环、SRE kill-switch 等外形。它**不是** DeepSeek / 本设计意义上的「企业级 Super-Agent 控制平面」：没有 Trigger→Eval→Mandate 开票链，不承载任务域焚毁，不承担组织对账三态 / 冻结 / 知识生产线。

**判定：对准空位①的「动作是否允许」外围先例（部分填空）；对②弱；对③仅审计/合规映射可参考。可裁剪借鉴策略闸与 Decision Record 形状，禁止整包当准入 Eval 或 Mandate 系统。**

---

## 1. 系统一览

| 项 | 内容 |
| --- | --- |
| **形态** | 多语言 SDK + 策略引擎宿主 + 框架适配器；宣称「one `pip install`，any framework」 |
| **技术栈** | Python 为主（完整栈）；另有 TypeScript / .NET / Rust / Go SDK；策略决策运行时上游为 `agent-control-spec`（Rust core） |
| **规模与活跃** | ~6.5k stars、~1.1k forks（**stars 不作生产证据**）；仓库体量大（约 50MB GitHub size）；CI / Discord / PyPI / npm / NuGet 齐全；状态为 **Public Preview**（[文档] README） |
| **许可** | MIT |
| **包切分（v4.1+ 合并后）** | `agent-governance-toolkit-core`（策略/审计/身份/MCP 网关）、`…-runtime`（特权环/saga/终止）、`…-sre`、`…-cli`；`[full]` 元包 |
| **组件目录** | [代码·包结构] `agent-governance-python/` 下含 `agent-os`、`agent-mesh`、`agent-runtime`、`agent-sre`、`agent-compliance`、`agent-hypervisor`、`agent-marketplace`、`agent-lightning` 等；另有 `policy-engine/` |

---

## 2. 它做到了什么（实证）

### 2.1 确定性动作拦截（核心价值）

- [文档] README：「Every tool call, message send, and delegation is intercepted in deterministic application code *before* the model's intent reaches the wire. Actions the AGT kernel denies are … **structurally impossible**.」
- 最小用法：`govern(my_tool, policy="policy.yaml")`；策略可 `deny` / `require_approval`（带 `approvers`）。
- 完整宿主：`AgentControl.from_path(manifest)` → `evaluate(...)` → `verdict`（ACS 路径）。
- 这与我们 §7.4「工具授权」层同向：**答的是「这次动作能不能做」**，不是「这次工作凭什么被允许」（Mandate）。

### 2.2 策略、身份、审计分层（可选叠层）

[文档] README / Architecture 流水线：

```
Agent → Policy Engine → Identity → Audit Log
         (YAML/OPA/Cedar)  (SPIFFE/DID/mTLS)  (Tamper-evident)
              ├─ Allowed → Tool executes
              └─ Denied  → GovernanceDenied
                                    ↓
                             Decision Record
```

- **身份**：AgentMesh 的 Ed25519 / SPIFFE / DID、信任分 0–1000、委派链。
- **审计**：[文档] `docs/specs/AUDIT-COMPLIANCE-1.0.md`——`AuditEntry`（decision: allow/deny/escalate/warn）、Merkle 链、Decision BOM（事后重建决策输入）、合规框架映射（SOC2 / HIPAA / EU AI Act / GDPR）。
- **特权环**：[文档] `docs/specs/AGENT-HYPERVISOR-EXECUTION-CONTROL-1.0.md`——Ring 0–3；Ring 0 需 SRE Witness；默认最小权限；fail-closed。
- **Kill switch**：[文档] LIMITATIONS §13——跨 SDK 语义不一致；Python 靠注册回调，`terminated=False` 时**不能**当作进程已停。对我们：可借「急停接口形状」，不可当 OS 级焚毁。

### 2.3 框架适配与 MCP 网关

- 适配 LangChain / LangGraph / AutoGen / CrewAI / OpenAI Agents / Claude Code 插件等。
- MCP Security Gateway：工具投毒、漂移、隐藏指令扫描（规格 `docs/specs/MCP-SECURITY-GATEWAY-1.0.md`）。
- 示例含 `k8s-agent-sandbox-governed`——在 K8s sandbox **之上**再挂预调度命令策略（说明 AGT 自认是应用层，需外加隔离）。

### 2.4 它自己承认的边界（高价值）

[文档] `docs/LIMITATIONS.md` 明确：

| 缺口 | 含义（对我们） |
| --- | --- |
| Action ≠ Reasoning | 不治理「想什么」；不防跨会话拼出的恶意工作流 |
| Audit = attempt，非 outcome | 与我们「对账三态 / 外部核实」**不对齐**——AGT 记允许/拒绝，不记外部世界是否真发生 |
| 非 OS 隔离 | 与 agent 同进程边界；生产要再叠容器/VM |
| Knowledge governance gap | 不治理 RAG 知识流——对齐我们「认知事实归 Spring-AI-RAG + 知识生产线」 |
| **Credential persistence gap** | **不**在任务边界吊销凭据——与 §4.5 / §7.5「凭据随域生灭」**反向空缺** |
| Kill switch 非跨 SDK 统一「进程已死」证明 | 急停要自己验收 |

这些自承让 AGT 成为「诚实的外围先例」：借形状，不借完胜叙事。

---

## 3. 它没有什么（对照三空位与 DSH）

| 本设计概念 | AGT | 判定 |
| --- | --- | --- |
| **Trigger→Eval→Mandate**（谁有权发起工作） | 无事件准入、无开票、无 accept-mode；`require_approval` 是**动作级**人工批，不是 Mandate | ❌ 空位①仍空 |
| **任务域焚毁**（§4.5） | 无 per-task 域；凭据持久化缺口自承；sandbox 示例依赖外部 | ❌ / ②弱 |
| **组织治理核心**（对账三态 / 冻结 / 知识生产线） | 有审计与合规映射外形；无编排存储、无待对账集合、无 TenantDirectory 冻结纪律 | ⚠️ ③仅外形 |
| **三类事实归位** | 不区分制度/认知/编排；全部压成「动作治理」 | ❌ |
| **Router/Worker/Watchdog** | 无角色模型 | ❌ |
| **移交包** | 无 | ❌ |

---

## 4. 与我们企业级设计的对照

### 4.1 可以借鉴的（按分量）

1. **动作策略闸的形状**（最高优先级）  
   - 确定性拦截 + fail-closed + 策略版本化字段（audit 里的 `policy_version` / `matched_rule`）。  
   - 落点：执行节点 / Runtime Adapter **外侧**的「工具授权」层，挂在 Mandate 之下（§7.4 三层分离）。

2. **Decision Record / AuditEntry 字段契约**  
   - `agent_id` / `action` / `decision` / `reason` / `latency_ms` / `policy_*` / `trace_id` / `session_id`。  
   - 可裁进治理账本的「动作审计」子集；**不要**用它冒充编排事实或对账结论。

3. **Decision BOM 的「事后可重建决策上下文」思路**  
   - 与我们「运行事实可重建、不承担授权」同向但粒度不同：BOM 重建的是治理决策，我们重建的是谁在等谁。

4. **特权环 / 风险分级的产品隐喻**  
   - Ring 3 默认、Ring 0 需人证——可对照人工介入三层（§8）里「批」的强度分级，**不要**把 Ring 当成租户或任务域。

5. **Kill-switch 接线方式（含 LIMITATIONS 警告）**  
   - 接口：注册终止回调 + 必须检查 `terminated`；失败要重注册。  
   - 与节点「中断待恢复」正交：AGT 急停是治理动作，我们的中断是编排状态。

6. **MCP 网关的投毒/漂移检查**  
   - 可作为 C 类工具面卫生先例，接在 ContextForge / 自建 MCP host 旁。

### 4.2 不可借的（禁借清单）

- **`require_approval` ≠ Mandate**：人工批动作 ≠「这次工作凭什么被允许」的制度记录。  
- **整包 fork 当 Control Plane**：无 Trigger/Eval/Ticket/Assignment 领域模型。  
- **用审计 attempt 当对账「已确认」**：LIMITATIONS §2 自承不核实外部结果。  
- **信任分驱动业务优先级**：我们明确 Router 调度顺序 ≠ 业务优先级（§7.2）。  
- **默认 allow / permissive 未加载策略**：初始化旁路风险（LIMITATIONS §9）——我们若接入必须 **strict deny-by-default**。  
- **把 AGT「Runtime Sandboxing / rings」当成任务域**：仍是同进程应用层隐喻，不满足 §4.5 焚毁与 §7 文件/凭据边界。  
- **OpenClaw / Hermes 生态叙事**：本仓库硬排除；AGT 文档若出现个人助理示例，只作适配面，不当底座。

---

## 5. 结论与建议动作

1. **定位**：AGT = 动作治理外形库，不是企业 Super-Agent。三空位判断不变：①仍空（AGT 只补动作闸）；②弱；③仅审计外形。  
2. **推荐姿态**：自建 DSH 控制平面；在 Worker/工具出口 **裁剪接入** AGT 风格策略闸 + Decision Record；策略内容由 BOS/组织规则供给，AGT 不拥有开票权。  
3. **建议动作**：  
   - P0 精读：`docs/LIMITATIONS.md`、`docs/specs/AUDIT-COMPLIANCE-1.0.md` §4–§5、Hypervisor kill-switch §12；  
   - 草拟「工具授权」SPI：输入 =（调用身份, Mandate 引用, action, args hash），输出 = allow/deny/escalate + Decision Record；  
   - 明确禁止：Eval 服务调用 AGT 作为「是否开票」的决策引擎。

---


---

## 6. 机制深挖（对照架构 §7 三层授权）

### 7.1 三层授权在 AGT 中的落点

本设计 §7.4 要求一次外部调用分清：

| 层 | 问题 | AGT 有无 |
| --- | --- | --- |
| 调用身份 | 谁在调 | 有：agent DID / mesh identity / trust score |
| Mandate | 凭什么调（这次工作的开票） | **无** |
| 工具授权 | 能调到什么 | 有：policy allow/deny/require_approval、rings、capability model |

因此正确装配是：

```
BOS/FlowCatalog ──开票结果──► Mandate（本项目）
Mandate + 调用身份 ──约束──► 工具授权闸（可裁 AGT）
工具授权闸 ──允许后──► 执行域（OpenSandbox/Cube/SPACE/…）
```

把 AGT 的 `evaluate()` 直接接到「事件进线」等于用工具闸冒充 Eval——这是禁借项的工程形态。

### 7.2 Decision Record 与我们对账三态的差异

AGT AuditEntry.decision ∈ {allow, deny, escalate, warn} ——描述**治理层是否放行动作**。  
本设计待对账三态 ∈ {已确认, 未发生, 未知} ——描述**外部世界副作用是否核实**（§6.3）。

二者正交：

- 动作被 allow，外部 API 仍可能超时 → 编排记「未知」；
- 动作被 deny，不应产生待对账条目；
- 人工 escalate（AGT）≠ 人工对账裁定（本设计）——前者批不批做，后者裁定有没有发生。

### 7.3 Kill switch 与任务域销毁

Hypervisor Kill Switch 面向「停 agent 执行」；本设计任务域销毁面向「拆执行环境 + 吊销能力凭据 + 留移交包」。  
LIMITATIONS 已说明：`terminated=False` 时不能假设进程已死。  
节点实现若串联二者：先治理 kill（停跑）→ 再 Provider destroy（拆域）→ 再写移交包；任一步失败进入「中断待恢复」，不得记完成。

### 7.4 与空位①的「部分填空」到底部分在哪

「部分」仅指：

- 有可引用的**动作准入**形状与审计字段；
- 有 fail-closed / 策略版本 / 审批动作的工程经验；

**不包括**：Trigger 来源建模、Eval 资格、Mandate 记录、accept-mode、Ticket/Assignment、与 BOS 十动作分离的对接。  
入口综述与 borrowable survey 的「①仍空」判断**不因 AGT 改变**。


## 7. 引用

- README.md；docs/ARCHITECTURE.md；docs/LIMITATIONS.md  
- docs/specs/AUDIT-COMPLIANCE-1.0.md；docs/specs/AGENT-HYPERVISOR-EXECUTION-CONTROL-1.0.md；docs/specs/MCP-SECURITY-GATEWAY-1.0.md  
- agent-governance-python/（core / runtime / sre / compliance / mesh / hypervisor）  
- 本仓库：`docs/drafts/enterprise-superagent-architecture.md`；`enterprise-superagent-borrowable-oss-survey.md`；`enterprise-superagent-reference-survey.md`
