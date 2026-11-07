# perplexityai/SPACE 深度调研报告

对象：`perplexityai/SPACE`（Sandboxed Platform for Agentic Code Execution），远端 `https://github.com/perplexityai/SPACE`。  
基线：HEAD 附近 `2f19d5fd7`（2026-11-07，`template: partition template caches by execution environment`）；同日有大量 lifecycle admission / store 重构提交。  
调研方式：README、`docs/architecture.md`、`docs/first-sandbox.md`、egress profiles 与本仓库 §4.5 / §6.2 / §7 对照；事实分 [文档] / [代码·结构]。

## 0. 一句话结论

SPACE 是 Perplexity 开源的 **Firecracker 微 VM 沙箱平台**：应用通过 HTTP API 走 **template → sandbox → command session → delete**，控制面状态在 PostgreSQL，执行面与数据面分离。它把「可销毁的隔离执行环境」做成干净、可运维的 API 形状，同时一等公民支持 **pause / suspend / wake**（保活与成本优化）。**没有** OpenSandbox/Cube 那种一等公民 Credential Vault；也没有 Trigger→Eval→Mandate 或组织治理。

**判定：空位②的「微 VM 生命周期 API」先例（偏索引/契约）；销毁路径存在（DELETE），但 pause/suspend 不得被叙述成焚毁。产品语义（移交包、凭据随域生灭、BYOM 节点）仍须自建。**

---

## 1. 系统一览

| 项 | 内容 |
| --- | --- |
| **形态** | 多服务平台：API + controllers + worker（Firecracker）+ data plane + template builders；可 Kind 本地或直连 worker |
| **技术栈** | **Rust** 分层 crate（`l10_foundation` → `l50_app`）；PostgreSQL；对象存储；可选 Kubernetes；Python 标准库即可调 API（无强制 SDK） |
| **规模与活跃** | ~2.1k stars、~185 forks；2026-10 开源后提交密度高（生命周期/准入/store 持续硬化） |
| **许可** | Apache-2.0 |
| **结构** | [代码] `crates/<layer>/`、`proto/`、`templates/firecracker/`、`docs/`、`examples/first_sandbox.py`、`infra/space/kind/` |

---

## 2. 它做到了什么（实证）

### 2.1 清晰的核心概念表

[文档] `docs/architecture.md`：

| 概念 | 含义 |
| --- | --- |
| Template | 起始文件系统与运行配置；多沙箱共享同一模板而不改模板 |
| Sandbox | 独立微 VM + 可写 FS + 自有生命周期 |
| Process | 箱内进程；同箱共享环境 |
| Command session | 一次命令的连接与授权；创建 session 分配 process id，attach 才启动 |
| Operation | 异步 create/pause/suspend/wake/delete 的跟踪记录 |

要点：**sandbox 寿命可长于创建请求与输出连接**——这是平台能力，也是与「短命任务域」需要上层纪律约束的地方。

### 2.2 请求与执行流：期望状态 vs 就绪

- API 把期望状态写入 PostgreSQL；controllers/workers **调和**到运行态。  
- **202 Accepted ≠ Ready**：客户端必须轮询 operation + sandbox `running` + process endpoint。  
- 这与我们「编排事实可重建、派发与在途分离」同向：**接受写账 ≠ 执行完成**。

### 2.3 销毁路径（与焚毁对齐的部分）

[文档] `docs/first-sandbox.md` / architecture：

- 示例流程最后一步：**DELETE sandbox**，等待 operation 成功。  
- Delete 可取消仍在排队的 create（`superseded_by_delete`）——删除意图优先，避免「删了又被晚到的 create 救活」。  
- Native 生命周期操作有 30 分钟 deadline；超时语义区分「已开始」与「未开始」。  

这些对「任务域必须能关掉」是强先例：**删除是一等公民，且与创建竞态有明确规则**。

### 2.4 Pause / Suspend / Wake（必须反向过滤）

[文档] architecture 状态表：

| 状态 | 保留什么 | 下一步 |
| --- | --- | --- |
| Running | 活 VM 内存 + 可写 FS | 继续命令 / pause / suspend / delete |
| Paused | 内存仍驻留 worker；**非持久快照** | wake |
| Suspended | 快照（内存+运行时+rootfs），释放活 VM 资源 | wake 恢复 |
| Deleted | API 不可用 | 另建 |

默认：SPACE API 创建的沙箱 **6 小时无活动可自动 suspend**（空闲限制，非最大寿命）。  
ECW（E2B Compatibility Wrapper）：E2B 的 pause ≈ SPACE suspend，resume ≈ restore。

**对我们**：与 k8s agent-sandbox 的 hibernation 同类风险——**休眠是平台默认诱惑**。任务域协议应只把 **Deleted** 映射为「域结束」；Paused/Suspended 至多用于评测/成本，且必须吊销能力凭据（SPACE 本身不提供 vault 吊销原语）。

### 2.5 安全边界与 egress

- Firecracker 隔离 guest；管理令牌 ≠ 数据面 attachment token（不可互换）。  
- Kind 部署：sandbox namespace NetworkPolicy 限制出口。  
- [文档] `tls_interception_exemptions` / operator egress profiles：可组合出站策略；**豁免不授予 egress 许可**，也不做凭据注入。  
- 对比 OpenSandbox/Cube：**SPACE 文档重心在生命周期与隔离，不在箱外密钥代理**——凭据卫生要上层补（env 明文风险需自管）。

### 2.6 工程硬度（可借鉴的「平台味」）

- Idempotency-Key、operation 轮询、安全重试指南（first-sandbox / troubleshooting）。  
- Inline durable execution：API 进程可内联执行部分 lifecycle，失败由 dispatcher 认领——偏运维可靠性。  
- `admit_user_lifecycle`：所有用户生命周期请求过统一准入点（提交信息显示仍在硬化）——这是 **sandbox API 准入**，不是业务 Trigger→Eval。

---

## 3. 它没有什么（对照三空位）

| 本设计概念 | SPACE | 判定 |
| --- | --- | --- |
| Trigger→Eval→Mandate | 无业务开票；只有 API/组织鉴权与 sandbox lifecycle admission | ❌① |
| 任务域焚毁产品语义 | 有 DELETE；默认文化含 pause/suspend；无移交包 | ⚠️② API 先例 |
| Credential Vault / 凭据出箱 | 无与 OpenSandbox/Cube 同级的一等 vault | ❌（需自建） |
| 对账三态 / 冻结 / 知识生产线 | 无 | ❌③ |
| BYOM 员工节点 | 集群/Kind worker 模型 | ❌ |
| 副作用清单上报 | 无；应用自己决定保留什么 | ❌ |

---

## 4. 与我们企业级设计的对照

### 4.1 可以借鉴的（按分量）

1. **生命周期状态机与 Operation 模型**  
   - `creating/running/paused/suspended/deleted` + 异步 operation +「接受≠就绪」。  
   - 可直接对照 §6.2 任务域状态，但我们的终止态应是 **destroyed + 移交包**，不是 paused。

2. **Delete 与 Create 的竞态规则**  
   - `superseded_by_delete`：结束意图覆盖未完成创建——适合写入 Provider 契约。

3. **管理面 / 数据面令牌分离**  
   - 与「调用身份 ≠ 工具能力」同向：attachment token 只能流式拉输出，不能改生命周期。

4. **Template 不可变 + digest 记录**  
   - 沙箱响应带 resolved template digest——利于审计「跑的是哪份环境」，对齐认知/制度版本化精神（环境制品侧）。

5. **作为 SandboxProvider 的「干净 API 索引」**  
   - 文档友好、Python stdlib 可调；适合做接口对照表，再由 OpenSandbox/Cube 提供 vault 实现。

### 4.2 不可借的（禁借清单）

- **pause / suspend / 自动 idle suspend 当任务域完成。**  
- **长寿 sandbox 多命令复用 = 一任务一域**——同箱多 process 共享 FS，削弱任务边界。  
- **无 vault 就假设凭据安全**——env 继承字段明确存在（first-sandbox 表格）。  
- **把 `admit_user_lifecycle` 当成 DSH Eval。**  
- **整包当企业 Control Plane 或组织治理。**  
- **以 stars 或「Perplexity 出品」代替验收。**

---

## 5. 结论与建议动作

1. SPACE 证明「Firecracker + 异步 operation + 强删除语义」可做成开放平台；对空位②是 **API/契约先例**，基建完整度上 vault 弱于 OpenSandbox/Cube。  
2. 推荐阅读顺序：SPACE（把状态机与 delete 竞态抄进 Provider SPI）→ OpenSandbox/Cube（补 vault 与 egress）→ 自建移交包与副作用清单。  
3. 动作：  
   - 对照 `docs/architecture.md` 画「我们的任务域状态 ⊂ SPACE 状态」映射表（仅 Running + Deleted 为任务域合法稳态）；  
   - Provider 禁止暴露 pause 给编排完成路径；  
   - 凭据层强制对接 Vault 类组件，不依赖 SPACE env。

---

## 6. 引用

- README.md；docs/architecture.md；docs/first-sandbox.md；docs/egress-profiles.md；docs/ecw.md  
- examples/first_sandbox.py；crates/ 分层 AGENTS.md；infra/space/kind/  
- 本仓库 architecture §4.5 / §6.2 / §7；borrowable-oss-survey §3.2（SPACE 作 API 索引）
