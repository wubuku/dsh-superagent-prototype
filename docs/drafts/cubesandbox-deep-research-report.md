# TencentCloud/CubeSandbox 深度调研报告

对象：`TencentCloud/CubeSandbox`，远端 `https://github.com/TencentCloud/CubeSandbox`；站点 `https://cubesandbox.com`。  
基线：`master` HEAD 附近 `c44a81d25`（2026-11-07，`fix(pvm): drop module.sig_enforce=1…`）；同日另有 pause/resume 指标与 lifecycle 文档提交。  
许可核实：以仓库根目录 **`LICENSE` 文件为准**——正文写明 **Apache-2.0**（Tencent 版权声明 + 第三方组件清单：kata-containers、cloud-hypervisor 等；cilium/bpf 选 BSD-2-Clause）。GitHub API 的 `license.spdx_id=NOASSERTION` **不可采信**；README badge 与 LICENSE 一致为 Apache-2.0。  
调研方式：README、`docs/guide/security-proxy.md`、架构组件表、OpenAPI/changelog 叙事与 §4.5 / §7 对照。

## 0. 一句话结论

CubeSandbox 是 **基于 RustVMM/KVM MicroVM 的高密度 Agent 沙箱服务**（E2B API 兼容）：硬件级每箱一内核、毫秒级创建、CubeEgress **L7 安全代理 + Credential Vault**（密钥永不进箱）。生命周期 API 支持创建/删除，也大力宣传 **AutoPause、跨节点 pause/resume、CubeCoW 快照/克隆/回滚**——这些是产品卖点，但对我们的任务域而言属于**必须裁掉的默认哲学**。

**判定：空位②的「更强隔离 + vault」部分填空先例（硬件隔离强于普通容器）；pause/snapshot ≠ 焚毁。可借 MicroVM 边界、CubeEgress 注入与审计；禁借常驻/休眠/快照复活当任务域信封。**

---

## 1. 系统一览

| 项 | 内容 |
| --- | --- |
| **形态** | 控制面（CubeAPI/CubeMaster/CubeOps）+ 计算节点 Cubelet + MicroVM 层 + CubeEgress/CubeVS 网络 |
| **技术栈** | Go（Cubelet 等）+ Rust（API/Hypervisor 系）+ OpenResty/Lua（CubeEgress）+ eBPF（CubeVS）；Python SDK `cubesandbox`；E2B 兼容 |
| **规模与活跃** | ~13.2k stars、~1.2k forks；2026-11-07 仍有生产向修复；CNCF Landscape 收录（叙事，非达标证明） |
| **许可** | **Apache-2.0**（`LICENSE` 全文 + 第三方 NOTICE） |
| **结构** | [代码] `CubeAPI/`、`CubeMaster/`、`Cubelet/`、`CubeEgress/`、`CubeProxy/`、`CubeOps/`、`hypervisor/`、`cubecow/`、`sdk/`、`deploy/`、`docs/`、`openapi.yml` |

---

## 2. 它做到了什么（实证）

### 2.1 硬件级隔离 + 高密度

- [文档] README：每沙箱独立 OS 内核（MicroVM）；冷启动宣称 &lt;60ms；内存开销 &lt;5MB 量级（benchmark 文档另册）。  
- 组件：`CubeHypervisor` / `CubeShim`（containerd shim v2）把沙箱接入容器运行时生态。  
- **对我们**：故障域 / 文件边界（§7 表）比共享内核容器更接近「任务崩溃不拖垮邻居」；仍须上层保证「一任务一域」调度，而不是一会话一长寿 VM。

### 2.2 CubeEgress：过滤 + 注入 + 审计（Vault）

[文档] `docs/guide/security-proxy.md`：

- 透明 TPROXY：HTTP/HTTPS 经 host 侧 CubeEgress；叶证书由模板预置 CA 信任（MITM 合法可读）。  
- **规则**：match（scheme/host/sni/method/path/port）+ action（allow/deny + inject + audit）；**默认无匹配则 deny**。  
- **Credential injection**：`Inject(header, format="Bearer ${SECRET}", secret=…)`——密钥在 operator 侧规则里，**不进沙箱 env/FS/进程**。  
- 审计 JSONL：`/data/log/cube-egress/access.jsonl`；secret 脱敏；`security_event` / `tls_handshake` 分型。  
- 扩展点：`CubeEgress/lua/access_phase.lua` 等——可挂内容过滤，但文档提醒延迟与 fail-safe。

与 OpenSandbox Vault **同族**：出站注入、箱内无真密钥。Cube 侧更强调 eBPF L3/L4 + L7 叠层，以及「规则在 create 时附着」。

### 2.3 生命周期：删除存在，但产品重心在 pause/snapshot

- v0.5 AutoPause/AutoResume：空闲挂起、请求唤醒。  
- v0.3 CubeCoW：事件级快照、克隆、回滚。  
- v0.7 跨节点 pause/resume（S3 后端）。  
- 近期提交 `#2155`：pause/resume 后 guest metrics epoch 重置——说明 **resume 被建模为 create-from-pause**（新 epoch），状态连续是一等公民。

**焚毁对齐点**：API/SDK 仍有删除沙箱路径（E2E lifecycle 含 delete）；**产品叙事默认是保活/休眠/快照**。我们引用时必须写清：只用 create+delete（及 vault 附着），AutoPause 不得映射为任务域结束。

### 2.4 E2B 兼容与部署面

- 换 endpoint 即可从 E2B Cloud 迁到自托管——降低 harness 对接成本（DeerFlow/OpenHands 类 Provider）。  
- 部署：裸金属 KVM、PVM 云主机、Terraform、K8s（preview）。  
- Volume 框架：卷可跨沙箱共享、独立生命周期——**与「任务域销毁只留移交包」冲突风险**：共享卷若持有任务私货，会破坏焚毁；借鉴时 Volume 只宜只读材料，不写任务状态。

### 2.5 额外产品面（边界提示）

- WebUI `:12088`、数字助手 AgentHub（文档提及 OpenClaw 集成示例）——**OpenClaw 不得进入我们主推**；Cube 本身仍是沙箱基建，示例集成不改变其层定位。

---

## 3. 它没有什么（对照三空位）

| 本设计概念 | CubeSandbox | 判定 |
| --- | --- | --- |
| Trigger→Eval→Mandate | 无 | ❌① |
| 任务域焚毁产品语义 | 有强隔离与 delete；主推 pause/snapshot；无移交包 | ⚠️②部分 |
| 对账三态 / 冻结 / 知识生产线 | 无（egress 审计 ≠ 编排对账） | ❌③ |
| 「节点属于人」BYOM | 集群/裸金属算力池模型 | ❌（可作云端执行后端） |
| Mandate ≠ 工具权限 | 网络规则 ≠ 开票 | ❌ |

---

## 4. 与我们企业级设计的对照

### 4.1 可以借鉴的（按分量）

1. **MicroVM 一任务一内核的隔离上限**  
   - 高风险任务域的执行后端候选；与 §7 故障域/文件边界同向。

2. **CubeEgress 规则 DSL + 注入 + JSONL 审计**  
   - `Rule/Match/Action/Inject` SDK 形状清晰，可作「能力出口策略」原型。  
   - 审计字段（sandbox id、matched_rule、decision、redacted headers）可映射治理账本子集。

3. **密钥永不进箱的硬保证（与 OpenSandbox 并列）**  
   - 写进我们的执行节点安全基线：任何 Provider 必须提供 vault 或等价代理。

4. **E2B 兼容 API**  
   - 降低 SandboxProvider 适配成本；控制平面仍只认我们的领域事件。

5. **resume = 新 metrics epoch 的「身份不连续」细节**  
   - 反证：即便 pause 产品存在，实现上也承认「恢复不是无缝同一寿命」——可用来论证「任务域结束应 delete 而非 pause」。

### 4.2 不可借的（禁借清单）

- **AutoPause / 跨节点 resume / 快照克隆回滚作任务域默认。**  
- **共享 Volume 承载任务可写状态。**  
- **把 egress 审计当「已确认」外部副作用**——仍无独立核实（§6.3）。  
- **AgentHub / OpenClaw 助手壳**当架构前提。  
- **以 stars 或 CNCF badge 替代生产验收。**  
- **LICENSE 只看 GitHub 自动检测**：必须以 `LICENSE` 文件为准（本报告已核）。

---

## 5. 结论与建议动作

1. CubeSandbox 与 OpenSandbox 同属空位②基建梯队；Cube **隔离上限更高**、运维更重（KVM/PVM）。选型：强隔离/合规敏感 → Cube；通用 K8s/多运行时 → OpenSandbox；API 索引 → SPACE。  
2. 组合：控制平面自建；Cube 仅作 Executor Provider；策略闸可再叠 AGT。  
3. 动作：精读 `docs/guide/security-proxy.md` + `docs/architecture/overview.md`；在 Provider 契约写「结束 = delete，禁止 auto-pause 映射完成」；评估是否需要裸金属/PVM 前置。

---

## 6. 引用

- LICENSE；README.md；docs/guide/security-proxy.md；docs/architecture/overview.md；docs/architecture/network.md  
- docs/changelog/v0.3.0.md–v0.7.0.md；CubeEgress/lua/；openapi.yml  
- 本仓库 architecture §4.5 / §7；borrowable-oss-survey §3.2
