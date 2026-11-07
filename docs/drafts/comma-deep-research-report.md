# Comma 深度调研报告

对象：AFK-surf/Comma，本地路径 `/Users/yangjiefeng/Documents/AFK-surf/Comma`（远端 `https://github.com/AFK-surf/Comma.git`）。
基线：HEAD `66ab3dc9`（Sync Comma source，仓库仅 8 个 sync 提交，内部代码为定期同步的快照）。
调研方式：文档 ↔ 代码逐条核对，关键断言附文件路径；编排与验证两条线由专项子核查补证据。

## 0. 一句话结论

Comma 不是营销口号里的「类似 Super-agent 的东西」，它是**把「可长期无人值守的 Agent 运行时」做成真实产品的、工程密度罕见的生产系统**:sessionless 的 Task 持久状态、单 Router + 一 Task 一 Worker 的委派与分段看门狗、用户/Group 硬件上的 Station（iroh 点对点组网）、一 Task 一隔离沙箱（磁盘只是缓存）、IFC 信息流控制（在 Lean 内核里机器验证）、Lean 步骤选择内核 + TLA+ 协议模型。

但它**没有**把 DeepSeek Super-agent「更通用 / 更异构 / 跨厂商异构编排」做到企业级的高度：没有通用 Trigger 准入链（最接近的 Triage 只是 Slack 专用）、Router 的路由决策只能来自规则提示（`tool_policy.ex`，约 500 行），不能组织动态 swarm、「Swarm」是产品词；看门狗是 runtime 的 Actor（`TaskWorkerWatch` / `StationTaskWatch`），不是独立只读 agent；Worker 角色正在被 retire（2026-10-19 收官），换成 Group 的「Task agent」；异构存在，但「Router/Worker/Watcher 三类角色异构」只有两类。

**判定：做到「个人助理级 Super-agent 后端」的近乎完整程度（可长期运行的真实系统），未必是「企业级 Super-agent 平台」所需的编排层。**

---

## 1. 系统一览

- 技术栈：Elixir/OTP（`systems/` 下 34 个目录）、Lean（步骤内核 + IFC + Session reducer）、TLA+（分布式协议）、Go（connector）、Rust（station native addon）、TypeScript/Effect（station 本体）。
- 规模（`HEAD` 实测）：2424 个 `.ex` 文件、**491 个 `.lean`**（`runtime/` 96 文件 19,067 行；`proofs/` 392 文件约 6.6 万行）、`tla/` 下 13 个 `.tla` 共 3,267 行（Salix 8 spec 约 2,673 行）、1219 个测试文件、`systems/` 34 个目录级单元。
- 产品双线：Comma（个人助理）+ Bridge For Teams（团队产品，组织/Project 模型）。`systems/Dockerfile` / `compose.yaml` 自托管单节点，单仓库 + Postgres + Redis + S3 + ClickHouse + Mailpit。
- 许可：GPL-3.0-AGPL 系，另有一份 CLA（`CLA.md`）与 AGPL 全文。

---

## 2. 它是什么：四层分工

| 层 | 内容 | 证据 |
| --- | --- | --- |
| 控制面（Salix） | Tenant/Group/Workspace/Task/Session/IFC/IM 的权威存储与调度；协调内流，=Salix（`Identity and scope`、`Tasks and background execution`、`architecture/DOMAIN_CONCEPTS.md` §1-4） | `systems/apps/salix_*` |
| 计算/设备面（Station/Salix） | 用户硬件上的 Station（iroh 点对点）、Group 的 Cloud VM（归档/恢复）、每 Task 一个 L4ES 沙箱 | `docs/compute-devices.md`、`docs/architecture/DOMAIN_CONCEPTS.md §7/§Station` |
| 执行核（Lean verified kernel） | Session/IFC/Loop 的步骤选择与决策都在 Lean 内核里；Elixir/TS 只管执行 effects | `systems/native/verified_kernel/README.md`、`docs/agent-runtime.md` |
| 客户端面 | Mac app / iOS / Watch / Web / TUI / BFT dashboard | `clients/apps/*` |

---

## 3. 核心机制（实证定级）

### 3.1 编排层：单 Router + 一 Task 一 Worker + 分段看门狗

- 角色白名单只有三种：`worker / router / meeting`（`agent_control.ex:1675`）。**无 `sub-agent` 代码**——README「Workers and Sub-agents」是营销话；且 BFT Workers 已于 **2026-10-19 retire**（`agents.ex:26-28` → `:workers_retired`，410）。
- 默认执行者：**Group 内一个 Salix 预分配的 Task agent**（固定 ID、Group 内预建；`task_agent.ex:3-6,109-121`）。Router 无权管理 Worker（tool 侧禁用 `agent.*`，`tool_policy.ex:517`）。
- **Router 的「决策权」不在运行时**：委派入口只有一条 `im_api.internal.task.create`（`provider/internal.ex:74-82`），（`task.create` 的目标是单 Agent；任务图已退役）：Worker id / model / `runs_on` 都由 **Router prompt 提示词**（`tool_policy.ex`）决定，运行时只做「Task 类型检查（one-shot/Loop 校验）」。Router 是有限的规则上限，不是 agent 间协商编排。
- **委派面**：participant 模型 —— delegator（通知过滤）+ worker（物化新 Session + pin 模型）；Router canonical Session 是唯一长期执行上下文（多对话共享）。`wait_for` 是 Lean 内核的**可持久化休眠状态**（timers 驱动探针续等），不耗轮次（`agent-runtime.md:55`「Waits consume no rounds」）；算力预算 `input_round_cap` 120 轮（`internal_session/state.ex:42`）。
- **Watchdog 语义由 Runtime Actor 承担**：`TaskWorkerWatch`（1 分钟后提醒 Worker 一次、再通知 Router）与 `StationTaskWatch`（7 阶段与各自阈值，`vm_not_ready/station_offline/not_given/running/idle_no_reply/cannot_start/given_no_reply`）。**它们是运行时 Actor，不是独立只读 agent**——「只是运行时 Actor，永不执行」。
- **主动式（proactive）**四条链：Routines（15 分钟检查）、按消息准入的 Triage（通过性/准入式而非架构式）（Slack 专用，含 durable bucket）、Loops（Agent 写代码的侦听程序）、`proactive.watch`（有 owner 才开）。**没有通用 Trigger 框架**；`triage/pipeline.ex` 只是 Slack 接线。Triage 本身是一套完整的「通过性」准入：Slack receipt → durable bucket → 五段 decision → 有界评估（bounded eval），证据扎实。

### 3.2 设备面：Station on-Device 双模型（我们的「执行节点」前例）

这是对我们最有参照分量的部分：

- **双运行模型**：Station 是「用户自己机器上的常驻 agent 进程」（`systems/station/README.md:3-4` 写「replaces the Go salix-connect connector」），与 Cloud VM **双向转发**（`docs/compute-devices.md` "Execution environments"、Station invite 机制）：「A Station on the user's or Group's own hardware … and a Sandbox the platform manages」と「A sandbox disk is a cache. Durable data lives in Salix, VFS, Drive and pushed branches」。**「沙箱磁盘不存账本」与我们「移交包只留摘要」同源。**
- **Task 的执行面选择（`runs_on`）**：`{kind: salix | runtime | sandbox | device.station:<id> | cloud_vm}`——这就是我们的「任务派发 + BYOM 落点」。装置：sandbox 是真隔离（L4ES VM one Task、零 GitHub token、GROUP token 只在 L4ES 节点的代理、每启动轮换）；station 是用户机器（read-only by default，opt-in 才执行）。
- **客户机替身架构**：station/`salix-connect`（Go 连接器，`systems/connector/salix-connect`，含 `claude_runtime.go` 等）从 **2026-08 起被 station TypeScript 根源重写**（Effect TS、Rust native）；主要负责：沙箱运行时托管、CLI 运行时（`claude_runtime.go`）、archive/restore、设备访问。**注意**：这部分正在被重写；`connector` 是连接面不是身份面（`docs/compute-devices.md` "Installation and Runner"）。
- **网络穿透是 iroh 中继，而不是反向隧道**：Station/connector **直接出站**到对象 Group；Station invite 走「已建的连接」（`tasks.md`），设备连上后先说 `task.hello`（报名）。这与我们推演的「执行节点只出站、节点主动连」**同构**，用于参考 C1/C2 的形态约束一点问题没有。
- **「桌面 station 第一登录不自动导入本地 CLI 登录」**（`docs/compute-devices.md` "Comma desktop machine accounts"）：BYOM 的账号模型是**显式选源、优先降级、按 profile 隔离**；这是一个比「直接继承本地登录」更干净的账号面，也是值得抄的细节。

### 3.3 Session/Event 可靠性：Lean 步骤内核 + TLA+ 分布式协议

- **「哪些不用运行时保证」由 LEAN 内核自身保证**：491 `.lean` 经构建进入把可执行核链接成 `.so`，再经 ETF NIF 进入 Elixir（`salix_verified_kernel.ex:3-8`，`verified_kernel_nif.c:214,230`），**可执行内核不是规格**；Session reducers、IFC、loop 分支全部归 Lean 决策，证据独立于文档（`systems/kernel_agent/README.md:3-4`「Its only dependency is the verified kernel … The kernel decides every branch of the agent loop. A host that only moves bytes can run a correct agent.」）。
- **TLA+ 系统级协议**：Salix 的 8 spec 覆盖 lease/epoch、head commit、session epoch fence、RPC 交付恰一次、hot archive、容量动作；违反检查（如 `Lease_BeliefExclusion`）是**预期反例**，且有显式映射表（`tla/salix/README.md:12-16`）。
- **继续留下的缺口（官方自承）**：`WorkLeanBoundary` 的完整 Actor→product refinement 仍 open（#1799）；外部 reports/letters 语义依赖假设；多数查询无功能证明；**仓库不附 `.github/` ci 配置**，核查时无法验证构建进 CI。

这是目前业界在 agent 运行时安全保证上最重的一块实现，**但它保证的是「运行时行为符合规则」，不是「模型判断对任务的策略**（他们自己明说）。

### 3.4 信息流控制（IFC）——企业治理条目可参照

- `apps/salix_ifc` + Lean `VerifiedKernel.IFC.*` 已验证：受控外溢（`declassification` 形态）、密封原子（`sealed_atoms`，永不外流）、外部主体（own_thread_only/deny/as_internal）、公共出口——**且决策路径走 Lean 内核，输入为显式数据，「Unknown permission is not authorization」**（`salix_ifc.ex:1-11`）。这是「数据只在被显式允许的边界流动」的实现形态，和我们 IFC 三层授权（调用身份/Mandate/工具）正交但同向。
- 治理层是 **策略在内核里求值、数据流按 label 裁断、失败关闭**，不是在 UI 层拦截——对「三类事实：制度/认知/运行各入其位」是同构的呼应，可一一映射参考。

### 3.5 記憶/Storage 面

- 文档层：S3 canonical + Postgres「可重建的投影」（并非会话真值来源），sealing/recovery、心智格式 v3 带 `accepted_input`。**Context continuity 由 Conversation+Task+VFS 三者合记**，不走 BlueCortex 那种「记忆插件」路线。
- runtime 事实面：`Accepted pending input must survive owner restart and compaction`（`agent-runtime.md:35`）——sessionless 的实质：可恢复的已受理输入与 sealed 历史。
- **注意**：其记忆/知识面是「跨设备连续性」服务于个人工作流；没有我们那条「组织知识不进入记忆模块」的规矩（制度事实与认知事实留给 BOS/RAG），这是两者设计域的边界差异。

---

## 4. 与 DeepSeek Super-agent / 我们项目的对照

### 4.1 它确实做了文章想要的（至多是「部分」）

| DeepSeek 文章概念 | Comma 对应 | 证据 | 判定 |
| --- | --- | --- | --- |
| Session 是界面，Task/状态才是连续的 | literally Sessionless：Conversation/Session 接口，状态在 S3+Task | README:32「Conversations are just interfaces. Tasks are the persistent execution state.」 | **无疑问（实现强于文章）** |
| Router/Worker/Watcher 三类角色 | Router（当前协调者）+ Worker（当前配置的）+ Meeting roles + Task agent（默认执行者） | role whitelist（`agent_control.ex:1675`）、task_agent.ex | **角色部分同构，数量面简化** |
| Watcher（运行时 Actor）盯进展 | TaskWorkerWatch + StationTaskWatch（分段阈值） | `task_worker_watch.ex:1-78`、`tasks-background-execution.md` StationTaskWatch 阶段表 | **机制在，角色化不在**（它不是 agent） |
| Meta/工作流：Task/Messages/Loops（通过性准入） | Triage pipeline（Slack 入线专用）、Loops（代码侦听）、Routines、task/status 推进 | `triage/*`（实目录）、`PRODUCT_MODEL.md:87-112` | **四条机制俱全，框架只有 Triage 一条** |
| 进程隔离关键角色 | seed：OTP 进程存活 per agent；sandbox 即沙箱 | README「where device for」，沙箱说明 | **有隔离，粒度与我们的任务域可类比但不同生** |
| BYOM/主动任务 | Salix/Connector + Station 同步成熟制品链（`salix-connect` Go 连入层）、机器账号本地源选购 | `systems/connector/salix-connect`、mac accounts 段 | **设备面同构，账号面互补**（Comma 用「bring your account」模型——BYOM 直接接入的是人的使用环境、本地登录与个人 Agent 进程） |

### 4.2 它超出/弱于文章实现的部分

- **验证是硬伤（优势定位）**：文章的「架构」没有验证。这块 Comma 是领先且自带边界自承的——IFC 已验证，Lean 内核可执行。
- **编排层在它的弱项**：没有 Swarm 并行编排原语、没有 agent 间可靠组建（任务图退役）、没有通用触发准入、Watcher 不是可插拔 agent。文章的「Fast/Slow path、异步 Loop、投机执行静默修正」这些决策形态，在 Comma 里都只有低优先级的具体形态（Triage 是 Streamlining；Loops 是执行形态；投机没对应物）。
- **任务图主动退役**：task graph creation retired——明确承认不做多步工作流编排，这恰好踩在我们「反对巨石」的假设上值得记住。

---

## 5. 对我们项目的直接结论

1. **修正「没有现成的东西可用」的判断**——准确表述应为：Com<MASKED_PHONE_1> 这类系统存在，且已到可借鉴的阶段；「可复用」尚须实证（独立复用不由我们掌握）；但它实现的是「个人助理级」Super-agent（以 Loops 的定时侦听 + Triage 的入线准入「主动」），不是「企业级 Super-agent 宪章」的完整载体。

2. **它可借鉴的四条**：
   - **沙箱作为任务 execution 的根**：一 Task 一沙箱，持久数据在外，沙箱磁盘只是 cache——正是我们任务域/移交包要的。一个可用的实现参考已经存在。
   - **设备侧维持（出站连接 + 送达回执）**：iroh 中继式、station invite + task.put/hello 的有界心跳——与我们的「节点只出站」约束相容，部分机制细节（如 `task.hello` 对 `fetched` 的回放校正）可直接参照。
   - **若把 IFC 做进 Lean 内核**：把「三层授权/信息流」放进验证内核——我们的「授权/执行权限」这一层可以找一个同样硬核又不必高强度的落点。
   - **Task 的到期推进与升级（escalation）解急闭环**（`escalated` / `active` / review acceptance）：人的回复走状态机解环（escalated→active/review），而不是聊天解环——该闭环已有生产形态。

3. **它不能解决的（仍需自建）**：
   - 任务图 / 多级工作流编排（明确退役）；
   - 通用触发准入（只有 Slack Triage + 定时 Loops）；
   - agent 间临时组建/并行校验的「异构 agent 协商」；
   - 组织级治理与审计（我们《企业级盲区》里的制度/认知/运行三类事实）；
   - 在「员工已装 Claude Code/Codex 账号」的既有生态下把节点设备变成授权执行面（他们用显式选源；BYOM 账号模型值得单列）。

4. **建议动作**：
   - 把 Comma 加入「可复用的运行事实研究」材料（与 BOS/原型并列）；
   - 若讨论「异构 agent 通信原语」与「任务域信封」——station/`tasks.md`（`task.invite/put/post/hello/status` 那套）就是现成的生产可比实现，建议作为 **11.2 提案的实体原型参照**（Comma 的站点协议），重点看「sent/answered/fetched 水位 + 重进补发 + 停靠还账」三条送达规则；
   - 若评估设备接入——它本身可能就是最直接的样例：station（Effect TS）正在替换 connector（Go），自 2026-08 以来组件正在重写（station TS 接替）；但它最大的风险是**复用不由我们掌握**：station 发布链是 Comma 自己的 bundle（pin still.fail manifest），独立复用与升级不由我们决定。

---

## 6. 引用

- README、docs/agent-runtime.md、docs/compute-devices.md、docs/architecture/DOMAIN_CONCEPTS.md、docs/architecture/PRODUCT_MODEL.md、docs/verification.md、docs/storage-search.md、docs/identity-security.md
- systems/station/README.md、systems/station/docs/tasks.md、systems/apps/salix_im/lib/salix_im/provider/internal.ex、systems/apps/salix_agent/lib/salix_agent/{agent_control.ex,task_agent.ex,tool_policy.ex}、systems/apps/bridge_for_teams_core/lib/bridge_for_teams/agents.ex、systems/apps/salix_im/lib/salix_im/triage/*.ex、systems/apps/salix_ifc/lib/salix_ifc/policy.ex、systems/apps/salix_ifc/lib/salix_ifc.ex、systems/native/verified_kernel/{README.md,lib/salix_verified_kernel.ex,c/verified_kernel_nif.c}、tla/salix/{*.tla,*.cfg,README.md}
- 子核查产物：编排侧（含 `wait_for` 内核语义、委派链 `im_api.internal.task.create → TaskConversationInput → ConversationServer.create_task`）、验证侧（含 4,225 theorems、H1–H4 约束）

---

## 7. BYOM 判定（含两处拓扑修正）

先行概念澄清：**DeepSeek 官方文章的 BYOM = Bring Your Own Machine**（原文：「即把用户日常使用的开发机或个人电脑接入云端 Agent」，第 212 行，归档副本），可能间歇在线、有未提交修改与本地凭据。它不是 bring-your-own-model；「cloud agents harness 保持无状态、会话日志在 harness 之外、按需接入执行环境」是 harness 侧的无状态化设计（与 Anthropic「脑手分离」对齐）。我们的项目里再加一层：节点可以是云端、也可以是员工电脑，而**云端节点里的 agent 仍可把「手」放到员工本地电脑**（任务域绑定的是执行环境，不是「脑在哪」）。

**Comma 没写过 BYOM 这个词**（docs 全仓 `BYOM|bring your own` 零命中），但它同时实现了两种拓扑，覆盖了上述两种落点：

| 拓扑 | 谁跑 agent loop（「脑」） | 谁是「手」 | 证据 |
| --- | --- | --- | --- |
| **A. 设备自跑**（station-hosted Task） | 设备上的 station 自己跑 `stillfail-runner` → claude/codex 子进程；模型调用从设备用设备自己的账号发出 | 设备本地文件系统 | `systems/station/README.md:3-4`；`systems/station/src/agents/runner.ts:1-20` |
| **B. 云端脑、设备手**（connector `env.exec`） | 云端 Salix 的 Worker Session | 设备：connector 暴露文件系统/进程操作，云端 `env.exec` 经 EnvDispatch → Bridge → WebSocket 落到设备执行 | `systems/connector/README.md:4-16`（链路图）；`salix_web/env_dispatch.ex` |

B 才是 DeepSeek 意义上的 BYOM（云端 agent 的「手」在员工/个人的本地电脑上）：连接只读起步、用户先在 Settings 授权才允许操作（`connector/README.md`「A device connection starts read-only…the user enables operations」）；A 则更像「脑也在设备上」，是 Comma 特有的延伸。两处**共享同一套 BYOM 纪律**：机器接入、凭据不落云端、连接可断可续（`connector_run_id` 轮换、`connector_token` 短期）、沙箱按需（磁盘只是缓存、持久数据在外，`docs/compute-devices.md` "Execution environments"）。

| 维度 | DeepSeek BYOM 原文 | Comma 实际 | 判定 |
| --- | --- | --- | --- |
| 接入面 | 用户的日常开发机/个人电脑 | iroh 组网 Station + connector（`systems/connector/`、`docs/compute-devices.md`） | ✅ 两种拓扑都覆盖 |
| 间歇性 | 可能间歇在线 | 设计容忍重连（`connector_run_id` 轮换、reconnect 修订路线） | ✅ 同构 |
| 本地凭据隔离 | 本地凭据在终端 | 「凭证不自动导入，显式选源、按 profile 降级」（`docs/compute-devices.md` "Desktop machine accounts"） | ✅ 已实现，形态更细 |
| 执行面 | harness 无状态、会话在外部 | Sandbox 磁盘只是 cache，持久数据（Task Messages/VFS/Drive/pushed branches）在外 | ✅ 已实现 |
| 权限治理 | （企业形态要求） | 连接只读起步、Settings 授权才允许操作；但无「看/接/批」三层人工介入（我们的 §8） | ⚠️ 有操作面授权，无三层介入 |
| 云端面 | harness（云端）↔ 终端 间歇接入 | Salix 中央控制 + VMM 沙箱（L4ES 按需沙箱） | ✅ 同构 |

**小结**：Comma 功能上就是 BYOM，且**同时**有「脑在云端、手在设备」（connector/env.exec，与 DeepSeek 原文同形）和「脑也在设备」（station-hosted Task）两种拓扑。它缺的不是 BYOM 形态，而是 DeepSeek 企业语境的治理层（共享机器、权限治理、审计、三层人工介入）；它的 BYOM 是**个人助理式的 BYOM**——「Cloud for work. Your device for identity.」（README Philosophy）。**对我们的直接意义**：我们的「节点可以是云端也可以是员工电脑、任务域绑定执行环境」恰好允许这两种拓扑并存；Comma 用 connector 的 `env.exec` 实现了前者、用 station 实现了后者——两种形态各有一个可参照的生产实现。
