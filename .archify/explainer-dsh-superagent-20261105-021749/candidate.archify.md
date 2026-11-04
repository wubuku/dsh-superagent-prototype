# DSH Super-Agent 原型：一页看懂主动式编码代理

这套原型把允许来源里的请求变成授权工单，在独立 DSH 执行会话和目录中完成，再把结果送回原对话。核心分工是：**授权归 Engine 与 Policy，执行归 Worker**。

- 来源先把 GitHub 或飞书事件标准化为 Trigger；默认 bundle 只启用 GitHub，飞书被禁用。[](source:bundle-patch)
- Intake 只存储一次 Trigger，再按来源范围过滤、扇出到订阅 Ticket，或排队给 Eval。[](source:intake)
- Policy 先判断发送者、范围和强度；主 Session 只对候选做评估和路由，不能把外部文本变成权限。[](source:policy)
- 每个 Ticket 由 DSH Worker 在独立会话和目录执行；报告与回复经过 Engine、Effects 和 Outbox 持久化后再发出。[](source:executor)

@answer scope="研究原型 · 当前提交 6337fc8 · Git 拓扑已调整"
@meta locale=zh-CN repo_url=https://github.com/wubuku/dsh-superagent-prototype.git repo_revision=6337fc823ce20251c8de8085948165c81aaa701e
@source bundle-patch title="Bundle 插件与 Worker 预设" path=cordis.patch.yml lines=1:30
@source engine title="Engine 单一事务入口" path=src/core/engine.ts lines=24:48
@source intake title="Intake 去重、扇出与排队" path=src/core/intake.ts lines=19:46
@source policy title="Policy 准入与 Mandate 复核" path=src/policy.ts lines=175:220
@source executor title="每个 Ticket 的 DSH 会话与目录" path=src/executor/dsh.ts lines=84:99
@source worker-preset title="Worker 只保留工作所需工具" path=cordis.patch.yml lines=28:100
@source store title="SQLite 状态与一次写入口" path=docs/007-architecture.md lines=149:163
@source outbox title="Outbox 发送回执与重试" path=src/app/outbox.ts lines=22:45
@source health title="健康状态由唯一写者持有" path=src/infra/health.ts lines=1:80
@source stage title="Ticket 阶段判定规则" path=src/core/stage.ts lines=9:22
@source tickets title="Ticket 生命周期与 Mandate 复核" path=src/core/tickets.ts lines=37:70
@source wake title="同一 Mandate 下恢复已结束 Ticket" path=src/core/tickets.ts lines=220:248
@source sessions title="主会话与 Worker 会话预设" path=src/app/sessions.ts lines=48:105
@source setup title="部署检查与 Worker 环境写入" path=docs/006-deployment.md lines=266:282

## 系统如何组成？ {#overview span=12}

@diagram architecture id=system-overview source=diagram.system-overview.json title="Runtime、可复用核心、DSH 执行与控制面"

左侧是外部事件来源，中间是可复用领域核心，右侧是 DSH 执行资源，下方是持久化与控制面。飞书连线用虚线，因为默认 bundle 中它被禁用。[](source:bundle-patch)

## 一次请求如何变成结果？ {#lifecycle-request}

@sequence id=request-flow title="显式请求：授权、执行与回传"
| actor requester | Requester | external |
| actor source | Source | external |
| actor engine | Engine | security |
| actor orchestrator | Main Session | backend |
| actor executor | Worker | frontend |
| actor channels | Outbox | messagebus |
| phase | authorization |
| requester | source | mention | emphasis |
| source | engine | trigger | emphasis |
| engine | orchestrator | candidate | emphasis |
| orchestrator | engine | accept mandate | security |
| phase | execution |
| engine | executor | assignment | emphasis |
| executor | engine | report | return |
| engine | channels | reply | return |
| channels | requester | to thread | return |

前四步解决“谁可以授权”；Assignment 之后由 Worker 执行，Engine 记录事实并驱动回复。外部消息只是上下文，不能改写 Mandate。

## Ticket 会经过哪些状态？ {#ticket-lifecycle span=12}

@diagram lifecycle id=ticket-lifecycle-diagram source=diagram.ticket-lifecycle.json title="Ticket 状态与人工干预"

`person / answer` 与 `person / review` 是必须有人接管的停点；人工 stop 直接终止，失效的 Mandate 阻止恢复。未被人工停止的已结束 Ticket，可在同一 Mandate 下被原线程消息唤醒。[](source:wake)

## 这张图不能承诺什么？ {#limitations}

| 边界 | 当前事实 | 读图提示 |
| --- | --- | --- |
| 运行成熟度 | 仓库声明为 research prototype，非生产软件 | 不要把页面当作安全或可用性承诺 |
| Worker 权限 | 以操作系统用户完整权限运行，包装器只是默认值 | 画出的隔离主要是工作目录与会话隔离 |
| 来源开关 | 默认启用 GitHub；Feishu 插件默认 disabled | 虚线代表可选能力 |
| 文档方向 | 项目文档含未来设计 | 图只画当前提交已实现的主链路 |

部署文档要求用独立系统账户获得更强隔离；包装器只决定默认凭据和命令解析，不能阻止 Worker 按绝对路径执行程序。[](source:setup)

@callout id=goal-note level=note title="设计目标"
这套系统的原则是用最少的人类注意力换取最大价值。它只在被请求或规则允许时行动。它只在有人必须行动或能使用结果时说话。
