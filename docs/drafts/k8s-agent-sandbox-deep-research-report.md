# Kubernetes Agent Sandbox 深度调研报告

对象：kubernetes-sigs/agent-sandbox（SIG Apps）。  
远端：`https://github.com/kubernetes-sigs/agent-sandbox`（~4.5k ★，Apache-2.0）；站点 `https://agent-sandbox.sigs.k8s.io`。  
基线：HEAD `993fd4aa9f57`（2026-11-07 前后）。调研方式：README、`docs/api.md`、`roadmap.md`。关键断言附 [文档] 路径。

> **警示（本报告的第一句话）**：**hibernation / Suspended / resume ≠ 任务域焚毁。** 本项目只允许借鉴其**声明式 API 形状**；禁止把暂停-恢复哲学抄进任务域默认生命周期。

## 0. 一句话结论

agent-sandbox 提供 Kubernetes 上 **Sandbox CRD + WarmPool/Claim/Template** 的声明式 API，用于管理**有稳定身份、可持久卷、可暂停恢复的单例有状态工作负载**（agent runtime、RL、notebook）。它是优秀的**沙箱编排 API 先例**，但官方动机与路线图明确追求 **deep hibernation / auto suspend-resume / PVC 保留后再挂载**——与架构 §4.5「每任务一域、用完即焚、只留移交包」**方向相反**。

**判定：API-only 先例过关；对空位②是反向教材。禁抄生命周期。**

---

## 1. 系统一览

| 项 | 内容 |
| --- | --- |
| 范围 | [文档] README NOTE：是 *sandbox orchestrator*；底层隔离交给 gVisor/Kata 等 RuntimeClass |
| 核心 CRD | `Sandbox`（agents.x-k8s.io）；扩展：`SandboxTemplate`、`SandboxClaim`、`SandboxWarmPool` |
| 语言 | Go controller；Go/Python SDK |
| 许可 | Apache-2.0 |

---

## 2. 它做到了什么（实证）

### 2.1 声明式 Sandbox API

- 稳定 hostname/网络身份；可挂 PVC；控制器管创建 / 定时删除 / **pause / resume**。[文档] README「Core: Sandbox」。
- `podTemplate` + `volumeClaimTemplates`；安全默认：经 Template/Claim/WarmPool 时 `AutomountServiceAccountToken` 默认 false。[文档] `docs/api.md`。

### 2.2 生命周期字段（与焚毁冲突的证据中心）

- `operatingMode`：`Running` | **`Suspended`**——Suspended 时终止 Pod 但**保留 Sandbox 对象与 volumes，以便日后 resume；恢复时用当前 podTemplate 建新 Pod 并重新挂卷**。[文档] `docs/api.md` `operatingMode`。
- `shutdownTime` / `shutdownPolicy`：到期撕掉 Pod/Service；对 Sandbox 对象可选 `Retain`（默认，标 Expired）或 `Delete`。[文档] 同文 Lifecycle。
- PVC：**在 Suspended 或 expiry Retain 后仍保留，resume 再挂载；随 Sandbox 对象删除才 GC**。[文档] `volumeClaimTemplates` 说明。

这些字段合起来就是「长寿命、可休眠、状态可回来」——RL/notebook/开发环境的正确模型，**不是**任务域。

### 2.3 WarmPool

- 预热池降低冷启动；Claim 从池收养；滚动更新策略 Recreate / OnReplenish。[文档] README Extensions；`docs/api.md` WarmPool。
- 可借鉴「池化供给 API」；池化对象若持久化用户数据，仍须外置焚毁策略。

### 2.4 路线图坐实 hibernation 哲学

- 已完成：**Suspend / Resume (PVC-based)**。[文档] `roadmap.md`。
- 计划中：**Auto Suspend/Resume**、deep hibernation 叙事、成本向的 suspend。[文档] `roadmap.md` Planned / 相关条目。
- README「Desired Sandbox Characteristics」明确列出 **Deep hibernation**、**Automatic resume**。

---

## 3. 它没有什么 / 它故意做成相反的什么

| 本设计概念 | agent-sandbox | 判定 |
| --- | --- | --- |
| 任务域焚毁 | Suspended + PVC 保留 + resume | ❌ **相反** |
| 移交包（只读摘要、无凭据、到期删） | 无此产品对象；Retain 的是卷与对象 | ❌ |
| Mandate / Eval | 无 | ❌ |
| 编排账本 | 无 | ❌ |
| 强隔离实现 | 委托 RuntimeClass，自身不实现微 VM | ⚠️ 范围正确但非焚毁 |

---

## 4. 可借 / 不可借

### 4.1 值得借鉴（API only）

1. **CRD 形状**：`Sandbox` / `SandboxTemplate` / `SandboxClaim` / `SandboxWarmPool` 的职责切分——若云端执行面跑在 K8s，可作「任务域供给 API」的命名与索赔（claim）模型参考；**实现时默认 `shutdownPolicy=Delete` 且禁止 Suspended 作为任务域模式**。[文档] README Architecture。
2. **安全默认**：SA token 默认不自动挂载。[文档] api.md。
3. **WarmPool 冷启动**：与 OpenSandbox/Cube 的预热思路可对照（预热 ≠ 保留用户脏状态）。[文档] WarmPool。
4. **到期 teardown 字段**：`shutdownTime` 作为「墙钟到期」API——可映射到任务域 TTL；但到期后应 **Delete + 移交包**，不要 Retain 卷。[文档] Lifecycle——**改语义再用**。

### 4.2 明确不可借（禁抄）

- `operatingMode: Suspended` 及任何 hibernate/resume 默认。
- 「PVC 随暂停保留、resume 再挂」作为任务域存储模型。
- 把 README 的 Deep hibernation 写成我们的隔离卖点。
- 把 agent-sandbox 整包当任务域产品。

---

## 5. 建议

1. **审计标签**：资料库与调研表中固定标注 **「反模式 / API-only」**（borrowable survey 已如此）。
2. **若 K8s 云端执行**：优先 OpenSandbox/Cube/SPACE 的 destroy+vault；agent-sandbox 仅在需要 SIG 级 CRD 生态时作 API 草图，并写准入策略拒绝 Suspended。
3. **三空位**：②仍空；本项目是反向过滤器，不是填空者。

---

## 6. 引用

- [文档] `README.md`（Scope NOTE、Desired Characteristics、Architecture）
- [文档] `docs/api.md`（`operatingMode`、`shutdownTime`、`shutdownPolicy`、`volumeClaimTemplates`）
- [文档] `roadmap.md`（Suspend/Resume completed；Auto Suspend planned）
- [文档] `docs/security/threat_model.md`（安全模型，按需）
- 坐标系：架构 §4.5；borrowable survey §3.2「警示条目」
