# DeerFlow 深度调研报告

对象：bytedance/deer-flow，远端 `https://github.com/bytedance/deer-flow`。
基线：HEAD `3a85baba`（2026-11-07，main，DeerFlow 2.0）。
调研方式：README / README_zh / AGENTS.md / `SandboxProvider` 源码与 OpenSandbox community provider 核对；明确无 Eval/Mandate。

## 0. 一句话结论

DeerFlow 2.0 是 **长周期 Super-Agent Harness（运行时外壳）**：LangGraph + Gateway + subagents + memory + skills + **可插拔 `SandboxProvider`** + Message/IM Gateway，把「研究/编码/创作类长任务」跑成产品。它的价值在于 **执行环境 Provider 抽象与工程边界**，不是企业准入控制平面——**无 Trigger→Eval→Mandate**，沙箱按 thread/user scope 获取与释放，**不等于** 我们的任务域焚毁产品语义（虽可对接 OpenSandbox 等销毁型后端）。

**判定：外围 Harness 先例（P1）；禁止当成企业 Control Plane。**

---

## 1. 系统一览

| 项 | 内容 |
| --- | --- |
| 定位 | [文档] open-source long-horizon SuperAgent harness；2.0 相对 1.x Deep Research **重写**，代码不共享 |
| 技术栈 | Python 3.12+（`backend/packages/harness` = `deerflow.*`）+ Next.js frontend + Nginx 统一入口 + 可选 Provisioner |
| 拓扑 | Nginx:2026 → Gateway:8001（FastAPI + 内嵌 agent runtime）+ Frontend:3000 + 可选 Provisioner:8002 |
| 规模 | ~85k stars；MIT |
| 扩展 | `plugins` / extensions 贡献 middleware、lifecycle、routers；官方强调 extension-first |

---

## 2. 它做到了什么（实证路径）

### 2.1 `SandboxProvider` 抽象（核心可借鉴点）

[代码] `backend/packages/harness/deerflow/sandbox/sandbox_provider.py`：

```text
acquire(thread_id, user_id) -> sandbox_id
get / get_scoped
release(sandbox_id)   # 文档语义：释放/销毁由具体 provider 定义
sync_agent_skills(...)
sandbox_network_mode / network policy decide hooks
```

- 抽象基类 + 线程安全单例（`get_sandbox_provider` / `reset` / `shutdown`）。
- 配置 `config.sandbox.use` 动态 `resolve_class` 到具体 Provider。
- Community providers（同仓路径）：
  - `community/opensandbox/provider.py` → **OpenSandboxProvider**
  - `community/e2b_sandbox/`、`aio_sandbox/`、`boxlite/`、`tenki/` 等
  - `sandbox/local/local_sandbox_provider.py`

[代码] OpenSandboxProvider 要点：

- 「Create one OpenSandbox environment per effective user/thread scope」；
- `acquire` 可 reuse/renew；`release` 同步 outputs 后进入 **warm pool**（空闲回收），shutdown 才 destroy——即 **有销毁能力，默认策略含复用/保活**；
- 与我们「销毁必达 + 禁止把 pause/warm 当焚毁语义」对照时：可学 API 与对接方式，**生命周期哲学需裁剪**。

### 2.2 Gateway / 长周期运行时

[文档] AGENTS.md / README_zh：

- Agent 运行时 **嵌入 Gateway**；`/api/langgraph/*` 由 nginx 改写。
- 线程隔离工作区、memory、subagents、skills、IM channels（Feishu 等）。
- 调度任务（scheduler）、产物交付回执 `run.delivery`、trace id 贯通。
- 前端 thread/streaming；可分叉对话。

这是 **Harness 工程完成度**，证明长周期任务、沙箱、网关可以产品化——仍是 Runtime 层。

### 2.3 Subagent 与 Skills

- 并行/委派 subagents、skills 包、skill review CI。
- 扩展包示例含 agent-teams、knowledge 等——仍在 harness/plugin 域，不产生组织 Mandate。

---

## 3. 它没有什么

| 我们需要的 | DeerFlow | 判定 |
| --- | --- | --- |
| **Eval / Mandate / Ticket** | 全仓定位为 harness；无开票领域模型 | ❌ |
| **通用企业事件准入** | IM/webhook 是通道；无资格评估链 | ❌ |
| **组织治理核心**（对账三态、冻结、BOS 对接） | 无 | ❌ |
| **任务域焚毁产品语义** | Provider 可 destroy，但 thread 级 reuse/warm pool 常见；无移交包一等公民 | ⚠️ 基建可接，产品语义空 |
| **Router/Worker/Watchdog 异构角色** | lead + subagents，不是三角色制度模型 | ⚠️ 部分委派 |

---

## 4. 与企业级设计的对照

### 4.1 可以借鉴

1. **`SandboxProvider` 抽象**：`acquire/get/release` + 配置热切换 + 多后端（OpenSandbox/E2B/AIO/local）——我们执行节点侧「任务域后端可替换」的直接模板。
2. **Gateway 与 Harness 边界**：对外通道/API 与 agent loop 同进程但路由清晰；可对照「Runtime 无写控制平面权」时的进程内模块边界（仍建议我们控制面独立进程）。
3. **OpenSandbox 对接实践**：community provider 展示如何把销毁型沙箱接到 harness——与 borrowable survey 的 OpenSandbox 条目互证。
4. **产物交付回执 / trace**：运行事实可重建的工程启发（编排事实仍须自持）。
5. **Extension-first**：业务能力外置，避免巨石——与我们「反对一体化巨石」同向。

### 4.2 不可借

- **当成企业准入或组织治理控制平面**。
- **把 warm pool / thread reuse 默认复制为任务域生命周期**（我们硬约束：一任务一域、销毁留移交包）。
- **用 LangGraph 状态冒充编排存储租户账本**。
- **把 IM 触发当成 Eval 完成**。

---

## 5. 结论与建议动作

1. **定位**：P1 外围 Harness；SandboxProvider 进执行面设计参考清单。
2. **建议动作**：
   - 精读 `sandbox_provider.py` + `community/opensandbox/provider.py`，起草我们自己的 `TaskDomainBackend` 接口（必须含 **强制 destroy + 移交包钩子**，默认禁用 warm-as-primary）；
   - 对照 Gateway 与控制面部署拓扑：DeerFlow 可嵌入；我们应坚持 Control Plane ≠ Runtime；
   - 不 fork DeerFlow 当企业底座。
3. **三空位**：①无 ②弱–中（可接销毁基建）③无。

---

## 6. 引用

- README.md、README_zh.md、AGENTS.md、backend/AGENTS.md
- backend/packages/harness/deerflow/sandbox/sandbox_provider.py
- backend/packages/harness/deerflow/community/opensandbox/provider.py
- backend/packages/harness/deerflow/community/{e2b_sandbox,aio_sandbox,boxlite}/
- 对照：architecture §4.5 / §6.2；borrowable-oss-survey §3.4
