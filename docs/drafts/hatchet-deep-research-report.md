# Hatchet 深度调研报告

对象：hatchet-dev/hatchet。  
远端：`https://github.com/hatchet-dev/hatchet`（~8.2k ★，MIT）；文档 `https://docs.hatchet.run`；可选 Hatchet Cloud。  
基线：HEAD `4a0a4f10b132`（2026-11-07 前后）。调研方式：README 功能矩阵、仓库内 tenant handlers / migrations、`pkg/repository` 耐久组件名。关键断言附 [文档] / [代码] 路径。

## 0. 一句话结论

Hatchet 是**多租户默认的 durable 任务 / DAG / 事件驱动编排引擎**（Postgres 作耐久与可观测层），面向后台任务与「AI agents」工作流的正确性、重试、限流与水平扩展。它提供本设计「租户化编排存储外形」的强先例，但**通用工作流引擎 ≠ agent 制度**：没有 Mandate、没有任务域焚毁、没有 BOS 级制度事实。

**判定：租户化 durable 外形先例过关；空位③仅外形；①②不填。禁止用 Hatchet 冒充企业 Super-Agent 控制平面。**

---

## 1. 系统一览

| 项 | 内容 |
| --- | --- |
| 定位 | [文档] README：「orchestration engine for background tasks, AI agents, and durable workflows」 |
| 语言 | 引擎 Go；SDK：Python / TypeScript / Go / Ruby |
| 耐久层 | Postgres（任务运行时 + 可观测）；强调易自托管 |
| 多租户 | README 写明 **Multi-tenant by default**；Users and roles；Cloud 另有 SSO |
| 许可 | MIT（Cloud 为商业服务） |

---

## 2. 它做到了什么（实证）

### 2.1 任务与工作流原语

- 一次性后台任务、重试与指数退避、Cron、定时、事件触发、webhook 触发、durable sleep / event waits。[文档] README「Hatchet Features」。
- DAG 与 durable tasks 双模式；文档指导如何选择。[文档] README + cookbooks 链接。
- Worker slots、priority、rate limit、按动态 key 的 concurrency/fair scheduling、worker affinity/labels 路由。[文档] README Scale 段。

### 2.2 多租户与治理外形（引擎级）

- API 面有完整 `tenants` handlers：创建、成员、邀请、alerting、entitlements、resource policy、queue metrics 等。[代码] `api/v1/server/handlers/tenants/*.go`。
- 迁移史可见租户资源限制、数据保留期、alerting、environment/onboarding 等。[代码] `cmd/hatchet-migrate/migrate/migrations/*tenant*.sql`（如 `add_tenant_resource_limits`、`add_tenant_data_retention_period`）。
- 这是**工作流平台租户**，不是本设计四个系统各说各话的「租户」映射表（架构 §3.4）——可借鉴隔离与配额外形，不要建跨系统租户同步。

### 2.3 可观测

- Web UI、OpenTelemetry、Prometheus；保留执行历史以便重放/调试。[文档] README Monitoring；对比 Celery/BullMQ 时强调持久历史。

### 2.4 与 Temporal 等的自我定位

- Durable tasks 可作为 Temporal/DBOS 的替代叙事，并宣称多租户/限流/路由开箱。[文档] README「Hatchet vs Durable Execution Platforms」。
- 对本设计：可选「耐久执行引擎」供应商之一，与 Temporal 二选一评估即可（borrowable survey P2）。

---

## 3. 它没有什么

| 本设计概念 | Hatchet | 判定 |
| --- | --- | --- |
| Trigger→Eval→Mandate | 事件/webhook 直接触发工作流函数；无开票评估 | ❌ |
| 任务域焚毁 | 编排的是函数/worker 槽位，不定义每任务销毁执行域 | ❌ |
| Router/Worker/Watchdog 角色 | 「worker」是队列消费者，不是 DSH 三角色 | ❌ 词碰撞 |
| 对账三态 / 冻结 / 知识生产线 | 无 | ❌ |
| 编排事实语义 | 有 run 历史与 durable 状态，但是**通用工作流状态**，不是以 thread 为锚的四类编排事实 | ⚠️ 外形可参考，语义须自建 |

---

## 4. 可借 / 不可借

### 4.1 值得借鉴

1. **多租户 + 配额 + 保留期**：租户资源限制、retention——编排存储物理隔离与清理策略的参照。[代码] tenants handlers + migrations。
2. **事件触发 + durable wait**：外部事件与长等待的引擎级实现——可用于「在途」技术底座，**之上**仍要映射到本项目编排事实 schema。[文档] events / durable-event-waits。
3. **重试 / 限流 / 公平调度 / worker slots**：执行面过载保护清单。[文档] Scale 段。
4. **幂等与可观测默认**：比自建队列+临时脚本更接近「可重建」。[文档] vs 任务队列对比。

### 4.2 明确不可借

- 把 Hatchet workflow 当成 Mandate/Ticket 领域模型。
- 把 Hatchet worker 叙述成 Super-Agent Worker 角色。
- 用引擎 UI 代替治理账本与 BOS 审批。

---

## 5. 建议

1. **P2 二选一**：Hatchet vs Temporal——比较自托管复杂度、多租户模型、SDK 语言与「AI agent」示例是否贴合；选定后只作**耐久执行垫层**。
2. **接入模式**：Control Plane 写编排事实 → 投递 Hatchet task（payload 仅能力引用与 ticket id）→ worker 调 Runtime；禁止 workflow 代码直写治理结论。
3. **三空位不变**（③仅外形加厚）。

---

## 6. 引用

- [文档] `README.md`；https://docs.hatchet.run（tasks、events、durable、concurrency、opentelemetry）
- [代码] `api/v1/server/handlers/tenants/`；`cmd/hatchet-migrate/migrate/migrations/*tenant*`；`pkg/repository/{dispatcher.go,durable_events.go,dag_orchestrator.go,idempotency.go}`
- 坐标系：borrowable survey §3.5 / §5；架构 §4.3–4.4 编排存储
