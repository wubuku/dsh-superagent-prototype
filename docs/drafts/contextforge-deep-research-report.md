# IBM ContextForge（mcp-context-forge）深度调研报告

对象：IBM/mcp-context-forge（产品名 ContextForge）。  
远端：`https://github.com/IBM/mcp-context-forge`（~4.8k ★，Apache-2.0）；文档 `https://ibm.github.io/mcp-context-forge/`。  
基线：HEAD `7d34038ca1f2`（2026-11-07 前后）。调研方式：README Overview、包结构 `mcpgateway/`、关键 service 文件头。关键断言附 [文档] / [代码] 路径。

## 0. 一句话结论

ContextForge 是**坐在 MCP / A2A / REST·gRPC 前面的联邦网关与注册中心**：统一发现、鉴权、限流、重试、可观测与插件扩展，并能量化遗留 API 为 MCP 工具、翻译 gRPC、路由 A2A agent。它证明「企业要把工具与 agent 出口收口到一层治理网关」在工程上可行，但**网关不是编排账本，也不是 Mandate 系统**——不能代替 BOS 制度事实或本项目编排存储。

**判定：MCP host / 联邦网关先例过关；空位①弱、②无、③弱外形。**

---

## 1. 系统一览

| 项 | 内容 |
| --- | --- |
| 定位 | [文档] README：「registry and proxy that federates MCP, A2A, and REST/gRPC APIs with centralized governance, discovery, and observability」 |
| 能力块 | Tools Gateway；Agent Gateway（A2A / OpenAI·Anthropic 兼容路由）；API Gateway（限流/鉴权/重试）；40+ plugins；OpenTelemetry |
| 运行时 | Python / FastAPI；PyPI（`mcp-contextforge-gateway`）与 Docker；Kubernetes + Redis 联邦/缓存 |
| 包结构 | 主实现在 `mcpgateway/`：`services/`（gateway、a2a、catalog、auth、audit…）、`plugins/`、`transports/`、`middleware/`、Admin UI |
| 许可 | Apache-2.0 |

---

## 2. 它做到了什么（实证）

### 2.1 联邦与虚拟化

- 联合多个 MCP / REST；可选 MCP 协议版本；统一对外接口。[文档] README「Gateway Layer with Protocol Flexibility」。
- 把非 MCP 服务登记为虚拟 MCP server；gRPC reflection → MCP 工具。[文档] README「Virtualization」「gRPC-to-MCP」；[代码] `mcpgateway/translate_grpc.py`、`services/grpc_service.py`。
- REST→MCP Tool Adapter：JSON Schema、头/令牌、重试/超时/限流策略。[文档] README「REST-to-MCP Tool Adapter」。

### 2.2 A2A 作为一等公民出口

- A2A agent 注册、列表、更新、启停、调用；与 DB 模型 `A2AAgent` / `A2ATask` 等绑定。[代码] `mcpgateway/services/a2a_service.py` 文件头与导入；`a2a_protocol.py`。
- 意义：网关层同时懂「工具协议」与「agent 协议」——与 A2A 报告中的水平/垂直分工一致。

### 2.3 治理与可观测外形

- 内建 auth、retries、rate-limit；用户作用域 OAuth；Admin UI / 可空气间隙部署叙事。[文档] README Overview。
- OpenTelemetry → Phoenix/Jaeger/Zipkin 等。[文档] README；[代码] `observability.py`、`services/observability` 相关。
- 审计/合规类服务存在于树中（如 `audit_trail_service.py`、`compliance_service.py`）。[代码] `mcpgateway/services/` 目录列表——**是网关侧审计，不是业务对账三态**。

### 2.4 插件与传输

- 插件扩展传输与集成；HTTP / JSON-RPC / WebSocket / SSE / Streamable HTTP；stdio 用于服务端场景。[文档] README。

---

## 3. 它没有什么

| 本设计概念 | ContextForge | 判定 |
| --- | --- | --- |
| Trigger→Eval→Mandate | 无开票评估；注册与代理 ≠ 谁有权发起工作 | ❌（①仅弱：鉴权/限流外形） |
| 任务域焚毁 | 不编排执行沙箱生命周期 | ❌ |
| 编排事实账本 | 无 thread 锚的归属/派发/在途/待对账 | ❌ |
| 知识生产线 / 对账三态 / 冻结 | 无（合规服务 ≠ 组织治理核心） | ❌ |
| BOS 十动作分离 | 无 | ❌ |

---

## 4. 可借 / 不可借

### 4.1 值得借鉴

1. **「单一出口」姿态**：MCP 工具、A2A agent、REST/gRPC 都经网关发现与策略——本设计执行节点出站调用企业工具时，可把 ContextForge（或同构自建）放在**工具/peer 边界**，Control Plane 只发「允许调用的能力引用」。[文档] README 架构叙述。
2. **遗留系统 MCP 化**：REST/gRPC 虚拟化——降低「每个 Worker 私接一套系统」的爆炸面。[文档] Virtualization 段。
3. **限流 / 重试 / 鉴权 / OTel 字段**：网关层横切能力清单，避免塞进编排领域模型。[代码] `gateway_service.py`、middleware、observability。
4. **A2A + MCP 共存实现**：作为「水平 + 垂直」同时落地的参照实现，而不仅是规范幻灯片。[代码] `a2a_service.py` + gateway federation。

### 4.2 明确不可借

- 用网关注册表**代替**编排存储或治理账本。
- 用网关 JWT/OAuth **代替** Mandate（任务授权）或调用身份三层分离（架构 §7.4）。
- 假设「上了 ContextForge = 企业 Super-Agent 已治理」。

---

## 5. 建议

1. **P2**：若互操作优先，做尖刺——Control Plane 签发的能力令牌只在 ContextForge 校验；Worker 不持有上游真密钥（与 OpenSandbox vault / nono 凭据代理同族思想）。
2. **许可与运维**：Apache-2.0 友好；评估 Redis/多集群运维成本是否值得引入，或只借鉴形状自建薄网关。
3. **三空位不变**。

---

## 6. 引用

- [文档] `README.md`；官方 docs site architecture/overview
- [代码] `mcpgateway/services/{gateway_service.py,a2a_service.py,a2a_protocol.py,catalog_service.py,audit_trail_service.py}`；`translate_grpc.py`；`plugins/`；`transports/`
- 坐标系：borrowable survey §3.5；架构 §1（BOS/RAG 归位）与 §7（隔离）
