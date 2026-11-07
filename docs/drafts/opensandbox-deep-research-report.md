# opensandbox-group/OpenSandbox 深度调研报告

对象：`opensandbox-group/OpenSandbox`，远端 `https://github.com/opensandbox-group/OpenSandbox`；站点 `https://open-sandbox.ai`。  
基线：HEAD 附近 `1f3ec4f27`（2026-11-07，`docs(osep): specify resolver caller authentication for OSEP-0025`）；`pushed_at` 同日活跃。  
调研方式：README、Credential Vault 指南、Fast Sandbox checkpoints、架构/egress 文档与本仓库 §4.5 / §6.2 / §7 对照；事实分 [文档] / [代码·结构]。

## 0. 一句话结论

OpenSandbox 是 **AAIF 旗下、Apache-2.0 的可自托管 Agent 沙箱运行时**：统一生命周期 API（本地 Docker → Kubernetes），内建命令/文件/代码执行，以及与本设计 **§4.5 / §7.5 同向** 的 **Credential Vault**（真密钥出箱、egress 侧注入）。它提供 `create → run → destroy/kill` 的销毁路径，也提供 Fast Sandbox 的 **pause/resume/snapshot**——后者是密度与成本优化，**不是**任务域焚毁语义。

**判定：对准空位②的「销毁型执行基建 + 箱外凭据」部分填空先例；不填①③。可裁剪借 destroy 纪律与 vault/egress；禁借 pause 默认生命周期，也无移交包产品。**

---

## 1. 系统一览

| 项 | 内容 |
| --- | --- |
| **形态** | 控制面 server + 多语言 SDK + CLI（`osb`）+ MCP server + K8s operator / Fast Sandbox |
| **技术栈** | Python server/SDK 为主；另有 Java/Kotlin、TS、C#、Go SDK；egress 侧 sidecar（MITM + nft）；Fast Sandbox 走 Firecracker 等高密度路径 |
| **规模与活跃** | ~16.5k stars、~1.6k forks（**stars≠生产证据**）；当日仍有 egress/OSEP 文档与 pin 提交；E2E / K8s nightly CI |
| **许可** | Apache-2.0（AAIF 项目） |
| **结构** | [代码] `server/`、`components/`（含 egress）、`sdks/`、`cli/`、`kubernetes/`、`specs/`、`oseps/`、`docs/`、`examples/` |

---

## 2. 它做到了什么（实证）

### 2.1 统一沙箱生命周期（含销毁）

- [文档] README Quick Start：`Sandbox.create(image)` → `commands.run` / `files.write` → **`await sandbox.destroy()`**（示例 `finally` 必达）。  
- 同步 SDK 示例用 `sandbox.kill()`（Credential Vault 指南）。  
- 生命周期契约在 `specs/` 与 API docs：面向「agent 工作环境」而非会话聊天。  
- **与我们 §6.2 同构的步骤**：生成域 → 执行 →（上报由上层做）→ 销毁。OpenSandbox 覆盖基建四步中的 1/2/4；**副作用清单 / 移交包由上层自建**。

### 2.2 Credential Vault：真密钥不进沙箱（对本设计权重最高）

[文档] `docs/guides/credential-vault.md`：

1. Host SDK 把真实凭据写入 **egress sidecar** 的 Vault API；沙箱进程只见 fake/empty env。  
2. 出站 HTTPS 经透明 MITM；**精确 binding**（scheme/host/port/method/path）匹配后注入 `Authorization` / apiKey / basic / customHeaders / passthrough substitutions。  
3. 要求：`[egress].mode = "dns+nft"`（DNS-only 拒绝激活——防直连 IP 绕过）；建议 `defaultAction="deny"`。  
4. 失败语义：**fail-closed**——resolver 超时/不可达则 407 或掐流，**从不**无凭据放行。  
5. Exchange credentials（1.2.1+）：按请求向 unix/https resolver 取短时头；subject = sandbox id（权威由 egress 填）。  
6. **Pause 与 vault**：[文档] 明确——sidecar 配置下 vault 是进程内存；K8s pause 删 Pod 后 resume **vault 空**，必须在 Running 后重建；Fast-sandbox 路径 vault 可随 snapshot bundle，但强调密钥信任面在 emptyDir/memory。

这几乎是我们 §7.5「凭据不进模型上下文 / 能力注入」与 §4.5「注入能力凭据」的**可运行参照**；也对齐 UHP「短时、单会话、可吊销」方向。

### 2.3 网络：Ingress + 每沙箱 Egress 策略

- [文档] README Features：统一 ingress；per-sandbox egress。  
- Vault 与 egress 绑定：无 outbound policy + `credentialProxy.enabled` 则 vault 不成立。  
- 与 OpenMausBot bot-box「egress 门」同族，但 OpenSandbox 是集群侧 sidecar，不是桌面 bubblewrap。

### 2.4 Fast Sandbox：高性能 + pause/resume（必须反向过滤）

[文档] `docs/architecture/fast-sandbox/checkpoints.md`：

- Pause 把 rootfs+vmstate+memory 写入制品库并**释放 Fastlet 容量**；Resume 可在**另一节点**恢复。  
- Snapshot 把运行态发布为可复用制品。  
- API：`POST .../pause|resume|snapshots` → 202 异步。  

**对我们的纪律**：这些能力对 RL/评测/成本优化有价值；作为**任务域默认生命周期则与焚毁相反**——暂停保留状态、快照可复活身份连续。借鉴清单里只保留「destroy/kill 必达」与「vault 在 pause 后须重建」的警告，不把 pause 写成任务域标准动作。

### 2.5 多语言 SDK / CLI / MCP / 示例生态

- DeerFlow、Claude Code、Codex、Harbor 评测等示例——说明它被当作 **SandboxProvider** 后端（与 borrowable survey 中 DeerFlow 条目互证）。  
- MCP 暴露 create/command/file——异构 agent 可把「手」伸进沙箱，但仍无 Mandate。

---

## 3. 它没有什么（对照三空位）

| 本设计概念 | OpenSandbox | 判定 |
| --- | --- | --- |
| Trigger→Eval→Mandate | 无；谁都能调 API（鉴权是平台运维问题） | ❌① |
| 任务域**产品语义**（每任务一域、只留移交包） | 有 destroy；**无**移交包一等公民；pause/snapshot 鼓励状态保留 | ⚠️②部分基建 |
| 副作用清单 / 对账三态 | 无 | ❌ |
| 组织治理 / 冻结 / 知识生产线 | 无（多租户 ns 是控制面租户，≠编排事实租户） | ❌③ |
| BYOM 员工节点 daemon | 面向集群/本机 Docker，不是「节点属于人」模型 | ❌（执行面可选后端） |

---

## 4. 与我们企业级设计的对照

### 4.1 可以借鉴的（按分量）

1. **Credential Vault + deny-by-default egress（最高）**  
   - Binding 粒度（host/method/path）、fake env、egress 注入、fail-closed、exchange resolver。  
   - 直接服务 §4.5 步骤 1–2 与 §7.5。

2. **`destroy`/`kill` 作为任务结束的必达路径**  
   - SDK 示例 `finally: destroy()` 文化——编排层派发完成协议应强制调用，失败进「中断待恢复」而非静默泄漏域。

3. **Pause 后 vault 必须重建的运维纪律**  
   - 写入我们的节点手册：任何「休眠」路径都视为凭据失效。

4. **SandboxProvider 抽象的对接面**  
   - 与 DeerFlow 的 provider 插槽一致：控制平面只依赖「创建/执行/销毁/注入 vault」接口。

5. **路径歧义 / 编码穿越防护（Vault Path Ambiguity Guard）**  
   - 注入前拒绝 `..` / 歧义 `%2f` 跨 binding——可抄进我们的能力代理。

### 4.2 不可借的（禁借清单）

- **pause / resume / snapshot 当任务域默认**——明确与焚毁相反。  
- **把控制面多租户 ns 当成编排存储租户**（§3.4 各系统各自定义租户）。  
- **无移交包就宣布空位②已解决**——仍缺只读摘要、无凭据、到期删。  
- **服务网格双 sidecar 同 ns**——文档禁止与 Istio 叠加；我们若上 mesh 要另设计。  
- **整包替代执行节点模型**——员工机器 BYOM 仍要自建 daemon（§0.1 / §11）。

---

## 5. 结论与建议动作

1. OpenSandbox 是目前公开 GitHub 上与「销毁 + 箱外凭据」最对齐的成套基建之一；**部分填空②**，不推翻「产品语义仍空」。  
2. 建议：执行节点的云端/集群任务域优先评估 OpenSandbox（或同族 Cube）作 Provider；本地桌面域继续对照 OpenMausBot bot-box。  
3. 动作：  
   - 精读 `docs/guides/credential-vault.md` + egress 架构；  
   - 在架构附录写死「任务域 API：create / inject-capabilities / exec / report-side-effects / destroy」；pause 仅允许评测/成本场景且必须吊销 Mandate 绑定凭据；  
   - 自建移交包模式（清单字段 + 存储位置 + TTL）。

---

## 6. 引用

- README.md；docs/guides/credential-vault.md；docs/architecture/fast-sandbox/checkpoints.md；docs/architecture/network/egress.md  
- specs/；examples/；sdks/；components/egress/  
- 本仓库 architecture §4.5 / §6.2 / §7；borrowable-oss-survey §3.2
