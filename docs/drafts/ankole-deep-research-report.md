# AgentBull/ankole 深度调研报告

对象：`AgentBull/ankole`（下称 **Ankole**），远端 `https://github.com/AgentBull/ankole`，本地 clone `/Users/yangjiefeng/Documents/AgentBull/ankole`。
基线：HEAD `09d9b6a3b`（2026-11-18 04:45 +08，`fix(ci): verify the packaged rclone with its version flag`），带 tag `v2.0.0-alpha.168`，分支 `main` 与 `origin/main` 一致、工作区干净。**注意版本仍是 alpha.168，但 README 自述「runs in production」——两处并存，按 [文档] 如实记录，不推断成熟度。**
调研方式：① 通读 README / `docs/README.md` / `docs/TradeoffsAndKnownLimits.md` / 关键 `design-docs`（BrainV3、Signals、AgentWorkers、Connectors、AuthZ、Tenants、Principal、HumanOffboarding、AutomationJobs、SkillLessons 等）；② 逐条回 `app/control_plane/lib`、`app/kernel`、`app/agent_computer/src`、`tools/formal` 的代码与模型核实；③ **web research** 交叉验证官方定位（agentbull.com）、外部技术文章（机器之心 2026-11-18）、GitHub 元数据与第三方活跃度。
事实标注：`[文档]` 仓库内文档/README；`[代码]` 代码或 schema；`[外部]` 官网/媒体/第三方站；`[推断]` 本文从结构性证据推出、原文未直述。所有路径除特别说明均相对 Ankole 仓库根。
术语纪律：按 `enterprise-superagent-architecture.md` §0.4/§0.6，Ankole 的 Principal、Pod、Worker、Session、Signal、Delivery、Runner、Claim、Company Brain、Automation Job、Applet Action、generation、access_version 均为**外部系统的词**，不得冒充本项目的租户、编排事实、Ticket、任务域、移交包、认知事实。本文用「本设计」指代 `enterprise-superagent-architecture.md` 的企业级方案。

## 0. 一句话结论

**TL;DR：Ankole 是目前考察对象里「组织侧治理与权限」做得最重的一个——多租户 + Actor/OTP 控制面 + 动态 PBAC + 权限版本号撤权 + 不可变审计 + 投递三态/未知态 + Lean 形式化模型，且 Company Brain 把「有来源、可推翻、权限化召回」的认知断言做成了一等公民。但它没有填满任何一个空位：空位①只做到「运行门禁」而非「开票授权」；空位②与焚毁哲学方向相反（每 Agent 一个常驻 Worker + 持久 Home + pause/resume 保留凭据）；空位③有最强外形与机制，却不做三类事实归位、无责任人字段、无独立「对账中」状态，知识写入多为直接落库而非人先确认。判定：组织治理机制的 S 级先例，准入链的 A 级裁剪源，任务域焚毁的反向警示；总判「没有一项填满三个空位」经核查仍成立。**

**建议：把 Ankole 作为本设计 §11「租户冻结/撤权」「知识生产线」「对账三态」三个未决项的首个可核对工程参照；不整包 fork，尤其不引入它的 Agent 级常驻执行域与 pause/resume 生命周期。**

---

## 1. 系统一览

> **TL;DR：Ankole 是一个自托管、Apache-2.0 的「企业 Pod 工作空间 + 多 Agent Harness」，技术栈跨 Elixir/OTP、Rust、Bun/TypeScript、PostgreSQL 18；与官网的产品线叙事一致，开源的是核心，商业版是 AI Associate 与云端模型/数据服务。**

| 项 | 内容 | 出处 |
| --- | --- | --- |
| **官方定位** | 「开源、自托管的 Agent Harness + Company Brain」；面向 Slack/Teams/飞书/钉钉/企微等；「Claude Tag 的开源替代」 | `[外部]` GitHub 仓库描述；agentbull.com 产品线；`README.md:7,20` |
| **商业边界** | Ankole 开源免费；AI Associate 为商业版（更高决策质量、私有部署）；BullXCloud 提供模型/搜索/Deep Research API；Bongard-mini 为开放判定模型 | `[外部]` agentbull.com 首页；与 `README.md:132`（核心 Apache-2.0、可选 AgentBull Cloud key）一致 |
| **许可** | Apache License 2.0 | `LICENSE`；`README.md:9,232`；`[外部]` GitHub 页面 |
| **技术栈** | 控制面 Elixir/Phoenix/OTP；Rust 内核（Rustler + Node-API）；Agent Computer Worker 为 Bun/TypeScript Linux 容器；Function Runtime 为无状态 isolate；PostgreSQL 18+ 与统一 Drive 对象存储 | `README.md:11,138-144` |
| **代码规模（本地实测）** | 控制面 lib ≈ 285.6k 行；Rust 内核 src ≈ 59.1k 行；agent_computer src ≈ 43.1k 行；libs ≈ 126.9k 行；plugins ≈ 107.9k 行；控制面 test 695 文件、agent_computer test 106 文件、formal test 15 文件 | `[代码]` `wc -l` 本地统计（2026-11-18）；规模只作工程投入旁证，不作质量证据 |
| **活跃度** | HEAD 2026-11-18，tag 已到 `v2.0.0-alpha.168`，提交密集（近期多为 fix/feat/test）；第三方聚合站显示 175 stars / 28 forks（截至 2026-11-05） | `[代码]` `git log`；`[外部]` srclog.com——stars 仅作发现度旁证，不作生产证据 |
| **部署形态** | Docker Compose 单机 / Helm on K8s / Cloudflare Containers / 源码构建；单站点可驻多租户，租户共享控制面、Function Runtime、模型池与 Worker provider | `README.md:32-37,84-90,136`；`docs/TradeoffsAndKnownLimits.md:5-9` |
| **版本成熟度张力** | README 称「runs in production」「formal verification checks critical code」；但版本仍 `v2.0.0-alpha`，公共 API 无兼容承诺、升级可能 breaking | `README.md:195-197`；`git tag` |

---

## 2. 它做到了什么（实证）

### 2.1 多租户 + Actor/OTP 控制面：把「谁在等谁」收敛到唯一事实源

**TL;DR：Ankole 用单站点多租户 + 每会话/每 Agent 一个 Actor（OTP 监督进程）+ PostgreSQL 权威事实，正面回应了「多人多 Agent 共用导致状态分裂」；这是与本设计「编排事实由编排层自持」最同向的一块。**

- `[文档]` Pod 是标准租户拥有的工作区，每个 Principal 恰属一个租户；每租户有自己的 Base 分片 `base_db_id`、People、Agent、Brain、Connectors、Conversations（`docs/design-docs/Tenants.md:3-7,49-58`）。物理 schema 为 `t_<tenant_hex>`，无租户上下文的查询直接失败（`Tenants.md:105-113`）。
- `[代码]` 隔离靠 `Ankole.Repo` 递归注入 tenant 谓词，**不是 PostgreSQL RLS**；raw SQL 需由所属域显式提供谓词（`docs/design-docs/Tenants.md:179-181,202-213,299-305`）。这一点是移植时必须注意的前提：换成没有同等框架的环境会留下越权缺口。
- `[文档]` 每个会话与每个专职 Agent 是独立 Actor，私有状态 + 收件箱封装在同一驻留单元，插话/改口/审批可入队、合并或中断重来，无需外挂锁；系统区分外部来信与 Agent 自身发言以防互相触发死循环（`[外部]` 机器之心 2026-11-18；`docs/design-docs/Sessions.md`、`docs/design-docs/Conversations.md` 有对应实现）。
- `[文档]` 外部投递以 `deliveries` + `delivery_previews` 为本地权威意图记录，平台确认的公共消息由 Mirror 记录；失败/未知意图不伪造公共会话行（`docs/design-docs/Conversations.md:14-36,1842-1851,1889-1897`）。

### 2.2 准入链：六道运行门禁，但没有「开票」

**TL;DR：从外部事件到 Agent 起跑之间有六道可核对的判定，工程严密（frozen snapshot + 再验证 + fail-closed + 幂等 + 未知态停机）；但没有 Eval 结果物化成的工单和 Mandate，授权是附着快照而非独立签发凭证。空位①在这里是「部分」。**

六道门禁（顺序按事件流）：

1. **传输/capability 边界**：CloudEvents 端点只靠 URL 能力令牌建立租户上下文（仅存 SHA-256 digest），body 校验先于任何写入（`docs/design-docs/Signals.md:526-529,546-549,559-565`）；raw callback 的能力 URL「只授权刺激送达，body/header 仍是不可信输入」（`Signals.md:590-608`）。
2. **身份准入（IdentityAdmission）**：外部 sender 按 subject 绑定 → 已验证邮箱 → 手机解析成 Principal；未匹配走 `manual_review`/`create_standalone`；**被禁用 Human 的消息静默丢弃**；捕获 `access_version` 并加入 `signal_source:<binding_id>` 组（`Signals.md:711-722,762-781`）。
3. **Binding CEL 过滤器**：写入时编译、运行时 fail-closed 求值，先于持久化 observation 与 Signal 插入（`Signals.md:345-351`）。
4. **Signal 一处 intake（One Intake）**：`(tenant_id, agent_uid, source, source_event_id)` 唯一约束，重投返回原 Signal；私有 `job:`/`wf_task:` target 被外部 Binding 定向时返回 `invalid_signal_target`（`Signals.md:62-75,179-182`；`app/control_plane/lib/ankole/signals.ex:569-576,596-638`）。
5. **source/target 独立授权 + WorkAccess 冻结快照**：源权限与目标 Page/Job/Routine 权限分别检查；快照记录 `authorization_kind`/`human_uid`/`human_access_version`，Sessions 在每次执行尝试前重验（`Signals.md:230-244,390-409`；`docs/design-docs/AutomationJobs.md:26-33`）。
6. **Sessions admission + ambient triage**：内核 ambient 输入先经一次无状态轻模型 triage，只有 `FOREGROUND_REPLY`/`NEW_WORK` 判定才进入普通 admission；`NOOP`/`HANDOFF` 同事务静默完成（`docs/design-docs/Sessions.md:272-330`）。文档明确「能读群消息不等于有消息作者的行动权限」（`Sessions.md:272-295`）。

- `[文档]` 最接近「先记录不执行」的是未定向群消息的 `record_only` 策略（默认）：放行 sender、记录公共 Message，但不唤醒 Agent（`Signals.md:748-756`）；`manual_review` 只写映射请求（`Signals.md:762-769`）。**这不是本设计的 accept-mode**：没有独立的工单态、没有可核验的授权凭证。
- `[文档]` fast path 是已发布的 Applet Action 在 Function Runtime 无状态 isolate 中按确定性代码执行，声明 `idempotent`/`concurrency`/`concurrencyKey(ctx)`/`maxSlices`，按 slice 快照 publication revision（`docs/design-docs/AutomationJobs.md:158-181,186-220`）。`[推断]` 「零 LLM token」是结构性推断（不经 Sessions/AIGateway），文档未字面写该词。
- `[文档]` 外部投递送达语义：能力键/read-back 对账、模糊发送停在 `unknown` 且**禁止盲目重试**、人工只能从 Console 手动 requeue 一次并标注可能重复（`docs/TradeoffsAndKnownLimits.md:32-39`）；`Delivery` 五态 `pending/sent/failed/expired/unknown`（`docs/design-docs/Conversations.md:1853-1859`），另有 `recovery_status ∈ blocked/permanent/exhausted`（`Conversations.md:1861-1868`）。

### 2.3 Company Brain：认知断言一等公民，但「人确认」只覆盖对象写

**TL;DR：Brain 把带来源、置信、持有者、时间、状态、可推翻的认知断言做成结构化数据，读取时按当前权限图实时过滤并做受众交集——这与本设计「认知事实有来源/置信/责任人、可推翻且留旧版」高度同构。但它没有责任人字段，Claim 级写入多为 Agent/后台直接落库，「提案→确认→落库」只覆盖知识对象写。**

- `[代码]` Claim schema 字段全集：`claim_type ∈ fact|take`、`kind`、`holder`、`author`、`source_node_id`、`provenance`（必填）、`confidence`、`weight`、`valid_from/until`、`superseded_by`、`consolidated_into`、`graded_*`、`resolved_*`、`embedding*`、时间戳（`app/control_plane/lib/ankole/brain/schemas/claim.ex:81-142`）。**注意：无 `epistemic_status` 字段**（详见 §3.1）。
- `[文档]` 推翻是事务内插入替代行 + 标记旧行；显式遗忘把 reason/caller/timestamp 追加进 provenance 与 revision history（`docs/design-docs/BrainV3.md:34,54,244-246`；`claim.ex:246-257,301-306`）。矛盾是独立不可变表 + 后台检测 + 一次性人工裁决（`docs/design-docs/BrainV3.md`；`app/control_plane/lib/ankole/brain/schemas/contradiction.ex:58-93,116-124`）。
- `[代码]` 读取侧权限是当前权限图现算，撤权后对已提取 claim 的读取立即生效（`docs/design-docs/BrainV3.md:30-32`；`app/control_plane/lib/ankole/brain/access.ex:212-224,250-261`）。披露模式 `strict/relaxed/workspace_public_fallback`：strict 的 recipients = 提问者 + 在场全员，relaxed 只 = 提问者（`brain/access.ex:9-13,75,377-380`）；disclosure 过滤发生在候选截断之前（`app/control_plane/lib/ankole/brain/recall.ex:5-10,73`）。
- `[代码]` `[文档]` 知识写入者：`remember`/`write_fact`/`write_take` 直接落库（status `inserted/duplicate/superseded`，`docs/design-docs/BrainV3.md:85`；`app/control_plane/lib/ankole/brain/tools.ex:136-173`）；SourceLearning 与 Dreaming 后台提取；「提案→人确认→落库」只在**写知识对象**时触发——Agent 与 requester 都有 edit 权才直接 `Pod.Knowledge` 保存，否则返回原生 Action Card proposal 由授权人批准（`docs/design-docs/BrainV3.md:83`；`app/control_plane/lib/ankole/brain/object_writes.ex:27-38,86-100`）。
- `[代码]` `ankole_brain` 是 system Principal：模型/embedding/rerank 调用以它执行，Dreaming 合并的 Take/timeline/分析页归它；但审计归属不改变 Drive 权限规则（`docs/design-docs/BrainV3.md:211-216,231-238`；`app/control_plane/priv/repo/migrations/20261101000000_add_system_service_principals.exs:9-19`）。
- `[文档]` Skill Lessons 是 Agent 自己的带日期 field notes，单条 lease、内容不可变、每人每 Skill 有条数上限（≤2/轮、≤10/Skill）、要求引用 ≥2 个 Job、人撤销永久免疫；以渲染后 notes 注入 Skill 视图而非改共享 SKILL.md（`docs/design-docs/SkillLessons.md:3-31,80-94,120-137`）。`[推断]` 这是可审计、可撤销的**软约束记忆**，不是强制执行的硬 guardrail。

### 2.4 执行域：Agent 级常驻 Worker，与「任务域焚毁」方向相反

**TL;DR：Ankole 的隔离单元是「每 Agent 一个常驻 Worker + 持久 Home」，不是每任务一域；同 Agent 的 Session/Job 共享 `/workspace` 且明说「不作安全边界」；memory-pause provider 空闲时优先暂停并保留 generation 与凭据。空位②在这里是「空」且部分反向。**

- `[文档]` 每 Agent 一个 dedicated Worker 与持久 `/workspace`，容器本身是 per-Agent 隔离边界（`docs/design-docs/AgentWorkers.md:12,353-355,372`）；Tradeoffs 明确「同一 Agent 的每个 Session 与 Background Job 共享 `/workspace`……用多个 Session 组织并发任务，**不是** Agent 内的安全边界」（`docs/TradeoffsAndKnownLimits.md:15-18`）。
- `[文档]` 容器内 root supervisor/rclone/Bun 进程为 uid 0 持凭据，命令/Codex/MCP/browser 子进程为 uid 1000 + `no-new-privs` + 私有 mount/PID namespace（`docs/TradeoffsAndKnownLimits.md:11-14`；`AgentWorkers.md:330-358`）。**但它明说 uid 1000 内不防自己的 Agent**（`TradeoffsAndKnownLimits.md:15`）。
- `[文档]` 四阶段 lock-free I/O + generation token（10 位小写 base32）+ 每 generation 一份新 32 字节凭据 + 常量时间 digest 校验，保证不会同时起两个写者；ambiguous create 必须**用同一 generation 重试**，宁可让 Agent 等待也不双挂载（`docs/design-docs/AgentWorkers.md:384,424-444,454-463,507-521`；`app/control_plane/lib/ankole/agent_workers/reconcile_job.ex:437-440`；`docs/TradeoffsAndKnownLimits.md:22-30`）。
- `[文档]` 空闲释放默认 15m，但 **memory-pause provider 先 pause 而非删**，且「pause/resume 保留 generation 与 incarnation_id」，generation 只在删实例时轮换——文档直说「它不是绝对凭据 TTL」（`AgentWorkers.md:649-672`；`app/control_plane/lib/ankole/agent_workers/decision.ex:46-68,151-154`）。Provider 差异实测：Cloudflare 备份到 R2、Vercel 持久 Drive、Lambda+EFS 挂起 MicroVM、阿里云 FC pause（含内存）；**ACS 因默认 hibernation 未验证内存保留而故意不注册**（`AgentWorkers.md:759-766,810-970`；`docs/TradeoffsAndKnownLimits.md:24-28`）。
- `[代码]` 最接近「移交包」的三样都不等价：`files_changed`/`artifacts` 有界路径清单（≤32 paths、8 KiB，`docs/design-docs/BackgroundAgentJob.md:1154-1168`）；`.ankole/execution-history.jsonl` 与 `handoff summary`（2 MiB 预算、`reveal: false` 密封，`BackgroundAgentJob.md:957-987`）；`/workspace` 空间回收是 14 天/LRU 整目录 `rm`，不保留摘要（`app/agent_computer/src/worker/workspace.ts:9-13,120-123,195`）。它们缺「任务域绑定 + 内容级只读移交 + 到期删」至少两项。
- `[文档]` 凭据卫生按类别分层：长期 SaaS/OAuth 留在控制面 vault，加密上下文含 purpose/tenant/row id（`docs/design-docs/Connectors.md:3-6,45-55`）；MCP 代理在控制面注入凭据，Worker 只拿绑定 RunRef/JobTurnRef 的短期内部 token（`docs/design-docs/RuntimeFabric.md:497-510`；`Connectors.md:322-344`）。但 Operator 配的 `WorkerEnv` secret 与短期 `git-askpass` token **故意在 uid 1000 shell 可读**（`docs/TradeoffsAndKnownLimits.md:20`；`app/agent_computer/scripts/git-askpass.ts:7-36`）。
- `[文档]` 有 BYOM 实现：成员在 Account → My devices 用一次性配对码连入自己的机器，`runner_devices`/`runner_bindings` 带独立 generation，本地卷留在用户机器上，设备 credential 留在 launcher；设备是 Background Job 的可选落点（`AgentWorkers.md:31-73`；`BackgroundAgentJob.md:144-161`）。但这是**长生命周期设备绑定**，不是每任务凭据生灭。

### 2.5 租户冻结、撤权、审计与形式化：本轮最有借鉴价值的一块

**TL;DR：Ankole 把「撤权」做成单调版本号 + 单点事务提交 + 不可变审计，并用 Lean 4 对协议模型做部分正确性验证；同时诚实地把「已准入 attempt 仍可完成」写成模型漂移而非生产 bug。这套「工程机制 + 显式未验证范围」的组合是本设计 §11 未决项最好的参照。**

- `[文档]` `access_version` 是单调撤销代次，所有登录方式与工作项共用；Human suspend vs offboard 是持久身份差异——suspend 保留个人凭证与联系方式，offboard 释放个人凭证/OAuth、email/phone 绑定，但保留 UID、不可变 subject ID、历史归因与审计（`docs/design-docs/Principal.md:45-48,133-141`；`docs/design-docs/HumanOffboarding.md:84-118`）。
- `[文档]` T0 单事务提交 disable + version + restriction + 不可变审计 + 清理 job；下游失败不回滚 disablement（HumanOffboarding.md:159-182,249-263）。在途规则：**已通过准入的执行照常完成，不逐步重检、不中断**；但 retry/resume/子任务/后续定时唤醒必须通过新准入因而被拒（HumanOffboarding.md:15-19,388-424）。文档明确「无法回滚已发出的外部副作用」（`HumanOffboarding.md:311-315`）。
- `[文档]` 租户级 suspend 阻断新工作与 OIDC 登录、保留数据、已准入工作照常完成（`docs/design-docs/Tenants.md:502-523`）。站点操作员来自唯一特权租户的 `siteadmin` 组，权限**始终从操作员 home tenant 加载**，切换数据租户不授予目标租户组成员身份（`Tenants.md:335-345,368-374`）。
- `[代码]` 权限是 allow-only、默认拒绝：principal active + grant 归属 + action 精确匹配 + resource pattern + CEL 条件为真，五条同时满足（AuthZ.md:108-117,15-17,523-533）。CEL 由 Rust 内核求值（NIF `authz_authorize_nif` 等，`app/kernel/src/nif_exports.rs:1080-1122`），内核不查库（`AuthZ.md:141-152`）。**纠正**：位图聚合在 PostgreSQL CTE（`app/control_plane/lib/ankole/pod/access/graph.ex:402-407`），按位与在 Elixir（`app/control_plane/lib/ankole/brain/access.ex:363-375`），不在 Rust 内核。
- `[文档]` `[代码]` 形式化用 Lynx + Lean 4：Lynx 把 BEAM Core Erlang 译成 Lean，Lean 检查 law 定理；**证明是 partial correctness（前件成功则后件成立），不是终止性**；状态协议在 `lean/` 显式建模，**不证明与 Ash/PostgreSQL/OTP/远端 Worker 的端到端等价**（`tools/formal/README.md:3-11`）。11 个 Lean 模型文件，含 AccessGraph、HumanAccess、AttemptAuthority、DeliveryIntent、SessionEpoch、BackgroundAgentJob 等。关键性质：`revoked_version_never_returns`、`replaced_attempt_cannot_write`、`unknown_requires_explicit_requeue`、`cycle_without_seed_denies`（`tools/formal/lean/HumanAccess.lean:76-80`、`AttemptAuthority.lean:57-89,97-104`、`DeliveryIntent.lean:19-25,231-238`、`AccessGraph.lean:11-21,45-46`）。`[文档]` 专门有 `EXPECTED_INCOMPLETENESS.md` 记录生产代码依赖但未内建防御的上游前提。

### 2.6 快慢路径：Published Applet Action 承担高频确定性工作

**TL;DR：Ankole 明确把高频、规则明确的日常流转交给模型自己写的脚本在 isolate 中执行，模型退居慢路径处理例外——这是与本设计 §11「tripwire 是代码，单次判断是一次性调用」同向的工程先例。**

- `[文档]` Routine 派生独立 Session，「长周期 routine turn 不阻塞交互 turn」（`docs/design-docs/Schedule.md:199-209`）；cron slot 有部分唯一索引、checkback 用复合幂等键，Oban 10 次尝试与失败历史（`Schedule.md:172-188,410-420`）。
- `[文档]` 知识侧 Dreaming 在后台跑提取、合并、矛盾检测，写入归属于 `ankole_brain`（`BrainV3.md`）；自动提取的 Claim 可开关与回滚（`BrainV3.md:87,91`）。
- `[文档]` 自承非目标：不接纳不可信第三方 Worker、不允许终端用户写外部 IM/Console 级 Signal 路由规则（Pod 成员只在自己的 Applet 设置里配触发）、不做嵌套 Workflow / 运行中热换脚本（TradeoffsAndKnownLimits.md:99-108）。

---

## 3. 外部核查：三处「说法 > 证据」的修正（高价值）

> **TL;DR：web research 拿到的官方叙事与本地 README 有三处被代码/模型收窄。这三处正是深查最容易夸大的地方，本文按「外部说法 / README / 代码实况」三栏并列，不替项目消解，也不照抄外部叙事。**

### 3.1 Claim 的「epistemic status 四分类」：README 有，schema 没有

- `[文档]` `README.md:103`：每条 claim 保留 source、timestamp、holder、audience 与 **epistemic status**，区分「客观事实 / 未验证假设 / AI 推断 / 人决策」。
- `[代码]` Claim schema 无 `epistemic_status` / `epistemicStatus` 字段（全仓 Grep 未命中；`brain/schemas/claim.ex:81-142` 字段全集见 §2.3）。实际靠 `claim_type(fact/take)` + `kind` 枚举（`event/preference/commitment/belief/fact`，`app/control_plane/lib/ankole/brain/claims.ex:26`；语义见 `learning_entities.ex:241-243`）+ `holder`/`author` + `confidence` + `provenance` 近似。
- **判定**：README 是概念性表述，不能据此说「四类状态是一等字段」。本设计若要映射「认知事实的可推翻/置信/责任人」，需自己加约定。

### 3.2 「Rust 内核微秒级按位求交」：外部文章有，代码路径不符

- `[外部]` 机器之心 2026-11-18：用 CTE 算每位成员可见范围并压缩为二进制位图，「交由嵌入控制面的 Rust 内核在微秒内完成按位求交」。
- `[代码]` 位图聚合在 PostgreSQL `bit_or`（`pod/access/graph.ex:402-407`）；按位与用 Elixir `band`（`brain/access.ex:363-375`）；Rust NIF 导出的是 CEL/条件求值（`app/kernel/src/nif_exports.rs:1080-1122`），不做 `band`。
- `[代码]` 全仓未见微秒级 benchmark 数据可核对。
- **判定**：「CTE → 位图 → 按位交集」这一机制真实存在且可核对，但「Rust 内核按位与」与「微秒级」两项在代码中未找到；引用时应说「位图交集 + CEL 在 Rust」，不得把形式化模型的 `intersection_no_escalation`（`AccessGraph.lean:45-46`，只是 `human ∧ agent` 的命题抽象）说成对交集实现的证明。

### 3.3 「证明越权读取与撤权后写回均不可能」：外部文章与 README 有，形式化边界更窄

- `[外部]` 机器之心 2026-11-18：「用 Lean 4 对核心权限状态机做了形式化验证，从数学上证明越权读取与撤权后写回均不可能发生。」
- `[文档]` `tools/formal/README.md:10-11`：partial correctness 而非终止性；模型验证协议转移，**不证明与 Ash/PostgreSQL/OTP/远端 Worker 的端到端等价**；README `:142-147` 明确靠 code review + 集成测试审计对齐，「而非通用精化证明」。
- `[代码]` `EXPECTED_INCOMPLETENESS.md:148-154`：撤权后已准入 attempt 的写回被允许，被标为 **model drift, not a production bug**；`AttemptAuthority.lean:97-104` 的 example 直接给出「撤权后 `mayAdmit` 变 false，但 `allowed`（写）仍 true」；`HumanOffboarding.md:311-315` 也承认无法回滚外部副作用。
- **判定**：「撤权**后新准入**不可能」成立；「**一切**撤权后写回不可能」不成立。本设计若要求「冻结后写回必须终止」，Ankole 恰好是反面案例，不能据此宣称已解决。

### 3.4 附带一处措辞张力：raw secrets「never enter」vs uid 1000 可读

- `[文档]` `README.md:105`：「raw connector secrets never enter Worker or Applet sandboxes」。
- `[文档]` `docs/TradeoffsAndKnownLimits.md:20`：`WorkerEnv` secret 与短期 `git-askpass` token **intentionally readable inside uid 1000 shells**。
- **判定**：按凭据类别不矛盾（前者指 vault 中长期 SaaS/OAuth，确有控制面代理与快照剔除佐证；后者指运维注入与短期换取），但「never enter」的全称字面与「intentionally readable」有张力。报告如实并列，不替项目消解。

---

## 4. 它没有什么（对照三空位与 DSH）

| 本设计概念 | Ankole 实况 | 判定 |
| --- | --- | --- |
| **① Trigger→Eval→Mandate（开票权）** | 六道运行门禁 + WorkAccess 冻结快照 + ambient triage + `record_only`；无独立 Eval 物化、无 Mandate 凭证、无 accept-mode 工单态；自承不做用户级路由规则 | ⚠️ **部分**（运行门禁强，制度开票空） |
| **② 任务域焚毁 + 只读移交包** | 每 Agent 常驻 Worker + 持久 Home；同 Agent Session/Job 共享 workspace；pause/resume 保留 generation 与凭据；`files_changed`/execution-history/handoff summary 都不等价 | ❌ **空，且部分反向** |
| **③ 租户化编排存储 + 对账三态 + 冻结/审计 + 知识生产线** | 多租户 + Actor/OTP + PBAC/CEL + 撤权版本 + 不可变审计 + Delivery `unknown` 与幂等/回执 + Lean 模型；但无独立 `RECONCILING` 状态、无责任人字段、Claim 写入多为直接落库、不做三类事实归位 | ⚠️ **部分（本轮最强）** |
| **三类事实归位** | 不区分制度/认知/编排；制度由 Pod ACL/CEL 与配置隐式承担，认知进 Brain，编排在 OTP 进程 + PostgreSQL，但无本设计的分层契约 | ❌ |
| **Router / Worker / Watchdog 三角色** | 无对应角色抽象。Principal 只有 `human/agent/system`；`agents.role` 是描述字段；有 `TurnWatchdog`（恢复守护进程）与 Worker（执行载体），但都不是权限/编排角色；「Router」作为角色术语未找到 | ❌ |
| **BYOM（员工机器）** | 有 paired device/Runner（一次性配对码、本地 launcher、本地卷留机器上），但凭据随 binding 撤销而非随任务销毁 | ⚠️ 机制有、纪律不同 |
| **移交包** | 无。最接近的是有界路径清单与 workspace evacuation（14 天 LRU 整目录删，不留摘要） | ❌ |

---

## 5. 与我们的企业级设计对照

### 5.1 可以借鉴的（按分量）

1. **`access_version` 单调撤销代次 + T0 单事务提交 + 不可变审计**（最高优先级）
   - 出处：Principal.md:133-141、HumanOffboarding.md:159-182,249-263。
   - 落点：本设计 §6.5 租户冻结 / §7.4 授权失效传播。关键细节：**所有登录方式与工作项共用同一版本**，下游失败不回滚 disablement。
2. **「已准入照常完成，新准入一律拒绝」的在途纪律**
   - 出处：HumanOffboarding.md:15-19,388-424。
   - 落点：与 §6.3 待对账集合、§6.4 代际管理对齐；但要明确写出「不回滚外部副作用」的诚实边界，不得表述成「冻结即终止一切写回」。
3. **授权快照 + 执行前再验证**
   - 出处：Signals.md:230-244、Sessions.md:272-295。
   - 落点：Mandate 与 Assignment 的绑定校验；「能读群消息 ≠ 有行动权限」可直接进 §7.4。
4. **Brain 的 source-gated recall + 受众交集先于截断**
   - 出处：BrainV3.md:30-32、brain/access.ex:212-224,363-375、recall.ex:5-10,73。
   - 落点：§5.2 KnowledgeQuery 的责任角色与 §9 知识生产线；「撤权后已提取断言的读取立即失效」比静态写死可见名单更优。
5. **投递 `unknown` 一等态 + 幂等键 + 回执 + 禁止盲目重试**
   - 出处：Conversations.md:1853-1888、TradeoffsAndKnownLimits.md:32-39。
   - 落点：§6.3 对账三态；注意 Ankole 无独立 `RECONCILING`，本设计仍需自建。
6. **generation + fencing + ambiguous-create 同 token 重试**
   - 出处：AgentWorkers.md:384,424-463,507-521、reconcile_job.ex:437-440。
   - 落点：任务域的单写者保护，把「每 Agent generation」改成「每任务域 generation」，任务结束即轮换/撤销。
7. **skill lessons 的「软约束 + 可撤销 + 不污染共享源」**
   - 出处：SkillLessons.md:3-31,80-94,120-137。
   - 落点：§9 知识生产线里「Agent 捕获的隐性知识」的落库前形态；不可当硬 guardrail。
8. **形式化分级方法**：partial correctness 模型 + 有界遍历 + 真实 DB 测试 + `EXPECTED_INCOMPLETENESS.md` 显式列未验证范围（tools/formal/README.md:3-11）。落点：本设计若做权限/对账不变量验证，照此写边界声明。

### 5.2 不可借的（禁借清单）

- **不把 per-Agent 常驻 Worker / 持久 `/workspace` 当任务域**：直接违背架构 §4.5「一任务一域、只留移交包」。
- **不把 pause/resume 或 hibernation 当默认生命周期**：memory-pause provider 保留 generation 与凭据，与「凭据随域生灭」反向；ACS 的 hibernation 被其自己拒绝注册（AgentWorkers.md:768-770）。
- **不把 uid 1000 / WorkerEnv secret「故意可读」当凭据卫生终点**：移交包必须无凭据。
- **不把 Claim 的 fact/take 当本设计的「认知事实」**：无责任人、无 epistemic status 一等字段、知识写入多为直接落库。
- **不把 Delivery `unknown`/`blocked/permanent/exhausted` 当对账三态**：无 `RECONCILING`，且失败态是终止分类而非「对账中」。
- **不把形式化结果表述为「越权读取/撤权写回已被数学证明不可能」**：见 §3.3。
- **不沿用 Ankole 的 Principal / Pod / Worker / Session / Signal / Delivery / Runner / Claim 等词描述本设计**（§0.5 命名纪律）；引用时写「Ankole 的 X」并标注差异。
- **不整包 fork 当 Control Plane**：不做三类事实归位、无 Mandate/Assignment 领域模型、无 Router/Worker/Watchdog 角色分工，且自承不接纳不可信第三方 Worker。

---

## 6. 结论与建议动作

1. **定位**：Ankole = 组织治理机制的 S 级先例、准入链的 A 级裁剪源、任务域焚毁的反向警示。它不是企业 Super-Agent 控制平面，也没有填满任何空位；**borrowable survey §1 的「没有一项填满三个空位」总判经本次核查仍成立**。
2. **对综述的影响（建议，待确认后回写）**：在 `enterprise-superagent-borrowable-oss-survey.md` §1 S 档加一行「AgentBull/ankole——③组织治理机制（PBAC/撤权版本/审计/形式化）」，并把 §8 材料索引加一行指向本报告；同时在 §1 表格里注明「②方向相反，禁借 pause/resume」。是否升 S 由架构决策定，本文只给证据。
3. **建议动作（按优先级）**：
   - P0 精读 `docs/TradeoffsAndKnownLimits.md`、`docs/design-docs/HumanOffboarding.md`、`docs/design-docs/BrainV3.md`、`tools/formal/README.md` 与 `EXPECTED_INCOMPLETENESS.md`。
   - P0 在本设计 §6.5 / §7.4 的草稿里，用 Ankole 的 `access_version` + T0 提交 + 在途纪律做一遍对照，明确写出「冻结后写回是否终止」的取舍——这是 Ankole 与本设计分歧最大的一点。
   - P1 草拟「认知断言」schema 对照表：把 Claim 的 `claim_type/kind/holder/provenance/superseded_by` 映射到本设计的认知事实字段，并补上 Ankole 缺的「责任人 / 谁有权推翻」。
   - P1 把 §3 的三处修正写进团队的「引用外部材料纪律」：README / 外部文章 / 代码三层不一致时，以代码为准并显式标注。
   - P2 若做形式化，沿用 Lynx + Lean 的 partial correctness + 模型边界声明方式，**不要**声称端到端证明。

---

## 7. 引用

**Ankole 仓库（本地基线 HEAD `09d9b6a3b`）**
- `README.md`；`docs/README.md`；`docs/TradeoffsAndKnownLimits.md`
- `docs/design-docs/`：BrainV3.md、Signals.md、AgentWorkers.md、Connectors.md、RuntimeFabric.md、AuthZ.md、Tenants.md、Principal.md、HumanOffboarding.md、AutomationJobs.md、Schedule.md、Sessions.md、Conversations.md、SkillLessons.md、MCPBackedSkills.md
- `app/control_plane/lib/ankole/brain/schemas/claim.ex`、`brain/access.ex`、`brain/recall.ex`、`pod/access/graph.ex`、`signals.ex`、`agent_workers/reconcile_job.ex`、`agent_workers/decision.ex`
- `app/agent_computer/scripts/git-askpass.ts`、`src/worker/workspace.ts`
- `app/kernel/src/nif_exports.rs`；`tools/formal/README.md`、`tools/formal/EXPECTED_INCOMPLETENESS.md`、`tools/formal/lean/*.lean`

**外部（web research，2026-11-18）**
- AgentBull 官网 `https://agentbull.com/`（产品线定位；中文版 `https://agentbull.com/zh-Hans-CN`）
- 机器之心《Agent 多人共用为何会失控？来自 Ankole 的 Business Agent 架构设计分享》，腾讯新闻转载 `https://news.qq.com/rain/a/20261118A09ELI00`（2026-11-18）
- GitHub 仓库页 `https://github.com/AgentBull/ankole`（描述、许可、最近提交）
- srclog.com `https://srclog.com/ankole`（stars/forks 第三方聚合，仅作发现度旁证）

**本仓库（坐标系）**
- `docs/drafts/enterprise-superagent-architecture.md`（§0 三类事实与术语、§4.5 任务域、§6 生命周期、§11 未决项）
- `docs/drafts/enterprise-superagent-borrowable-oss-survey.md`（§0 门槛、§1 S/A/B 分级、§8 材料索引）
- `docs/drafts/enterprise-superagent-reference-survey.md`（入口综述）
