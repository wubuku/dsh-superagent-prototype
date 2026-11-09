# Herdr 深度调研报告

对象：`/Users/yangjiefeng/Documents/herdrdev/herdr`（本地代码库，Apache-2.0）。
基线：HEAD `5da0a01e`（v0.9.3，2026-10-03 前后活跃）。规模：约 30.6 万行 Rust、417 个文件、1798 commits。
调研方式：README / CLAUDE.md（工程原则）/ `skills/herdr/SKILL.md`（214 行 agent 操作手册）/ `docs/next/api/herdr-api.schema.json`（协议 22 的正式 JSON Schema）/ 检测清单与源码（`src/detect/`、`src/api/wait.rs`、`src/persist/`、`src/remote/`）逐项核对。
坐标：`enterprise-superagent-node-daemon-plan.md`（byomd，BOS 仓库）的 Driver B（harness）与共设核心；`enterprise-superagent-architecture.md` §11（agent 异构）。

## 0. 一句话结论

Herdr 是一个 **「给 coding agent 用的终端复用器 + agent 运行时」**：tmux 形状的 workspace/tab/pane 拓扑 + 一套**数据驱动的 agent 检测引擎**（22 份 agent 检测清单 + agent 自报状态）+ 四态生命周期（idle / working / blocked / unknown，另有一个由 server seen 状态派生的 done）+ 可靠的 prompt 提交与等待语义 + agent 原生的 CLI/socket API（agent 之间可以互相派活、等对方真正 blocked）+ 会话持久化与按 agent 自报命令的 resume。**判定：它是 Driver B（驱动员工已有 agent）方向上最完整的工程参照——「怎么识别、怎么喂活、怎么等、怎么记账」四个问题它都给出了生产级答案；但它完全没有云端治理（无多租户、无准入、无对账、无台账），这些仍归我们。**

## 1. 系统一览

| 项 | 内容 |
| --- | --- |
| 技术栈 | 纯 Rust 单体：Tokio（multi-thread + process）+ ratatui/crossterm（TUI）+ 自研 `ghostty-vt`（VT 解析）+ `portable-pty`（vendor 并本地 patch，锁 `=0.9.0`）+ `interprocess`（本地 socket IPC） |
| 工程结构 | 单 crate + 一个 VT 子 crate；模块：`server/`（常驻服务端）、`client/`（TUI）、`pane/`、`pty/`、`detect/`、`remote/`（SSH 多机器）、`persist/`（保存/恢复）、`api/`（socket API） |
| 架构原则 | **State separated from runtime**：`AppState` 纯数据、无需 PTY/async 即可测试；`PaneState` 与 `PaneRuntime` 分离（写在 CLAUDE.md 首条） |
| 对外 API | 本地 socket 上的 JSON API，**协议版本化（protocol 22）且有正式 JSON Schema**（schemars 从 Rust 类型生成）；支持 `events.subscribe` 订阅 + 保留历史重放 |
| 测试 | 72 个测试文件：detach/reattach、host_shutdown、auto_detect、broken_pipe 等**真实场景集成测试** |

## 2. 它做到了什么（实证）

### 2.1 Agent 检测：数据驱动的规则清单，不是硬编码

- `src/detect/manifests/*.toml`——**实测 22 份清单**（amp、antigravity、claude、cline、codex、cursor、devin、droid、gemini、github-copilot、grok、hermes、kilo、kimi、kiro、letta、maki、muse、opencode、pi、qodercli、qwen），`include_str!` 编译进二进制；三级来源：bundled / remote / 本地 override。官方文档另列 25 种「受支持」agent 与 5 种「自报状态」型 agent（自报型不需要清单）。
- 规则语法：按屏幕区域（`osc_title` / `bottom_non_empty_lines(N)` / `after_last_horizontal_rule` / `prompt_box_body`…）+ 正则/contains 组合，带 **priority**（OSC 序列 1100 > 底部强信号 980 > 弱信号 600）、**`not` 反证**（如「出现 'esc to cancel' 就不是 working」）、**`skip_state_update`**（transcript 查看器等「看见了但别改状态」的场景）。
- 输入三路：屏幕快照 + OSC title + OSC progress（`DetectionInput`）；输出带完整**可解释性**（`DetectionExplain`：命中哪条规则、为何跳过、fallback 原因、清单版本）。
- **官方文档的口径**：「When an integration also reports state, Herdr uses those reports instead of reading the screen」——**agent 自报状态优先，屏幕读取兜底**；这正是我们要借的「信号优先」原则。
- 例（claude.toml）：working = 标题栏盲文转轮正则 + 「esc to interrupt」行 + MCP 后台任务正则（带 not 反证防止用户 prompt 冒充）；blocked = 权限弹窗（「do you want to proceed?」+ yes/❯ 分支，注释里连 issue #2650/#3283 的回归原因都写了）。

### 2.2 生命周期五态与「seen」语义

- `AgentState`：`Idle / Working / Blocked / Unknown`（`done` 是 CLI/API 层用 server 的 **seen 状态**从 Idle 区分出来的——每个 TUI 客户端独立跟踪自己看没看过，所以 Done 徽章可以因人而异）。
- `blocked` = 检测到「审批或提问 UI」——**这正是我们人工介入层需要的信号**。

### 2.3 Prompt 提交的可靠性设计（Driver B 最该抄的一段）

- 提交 = **bracketed-paste 包裹文本 + 编码后的 Enter，作为一个有序提交**写入；Windows Codex 特殊处理（先发 paste 边界再发 Enter，不依赖提示符宽度）。
- **三重拒绝**：agent 已 blocked → 直接拒发（`agent_blocked`），让人先看 UI；非工作态提交后 **5 秒内必须观察到 working/blocked 活动**（activity gate），否则 `agent_prompt_stalled`；调用方超时则 `timeout`。
- **明确告诫（写进 SKILL）**：「超时/stalled ≠ 提示没送达；不要盲目重发」——先 `agent get` / `agent read` 再决定。
- `--wait` 等的是**settled 状态**（第一次稳定到 idle/done/blocked），且被「activity gate」终止条件保护（`src/api/wait.rs`，854 行）。

### 2.4 Agent-native：agent 之间可以互相派活

- `herdr agent prompt <name> "..." --wait` —— 一个 agent 可以**派活给另一个 agent 并等到对方真正 blocked/idle**；SKILL 明确了「neighbor pane 探查、split 布局规则、--no-focus 礼仪、ID 从 JSON 响应解析」等协作纪律。
- 这就是「agent-to-agent 委派」在**本地、单机、同一 daemon**尺度上的最小实现。

### 2.5 会话持久化与 resume

- `persist/`：workspace/tab/pane 布局快照存 `session.json`；屏幕历史另存；**重启后恢复布局**。
- **Agent resume 是「agent 自报命令」**：`ReportedAgentResume`——agent 通过 OSC 序列自报自己的恢复命令（如 `--continue`），server 重启后在恢复的 pane 里执行；同一命令在不同目录指向不同 session，**目录参与去重键**（`dedupe_key`）。`resume_agents_on_restore` 控制是否自动恢复。
- 原进程**不复活**——恢复的是「会话引用」，不是进程。

### 2.6 多机器与 API 契约

- `--machine <label>`：同一 CLI 控制多台已保存的 SSH 机器（SSH stdio 桥 + 远端 server 自动拉起检查 + machine API 转发；两端都要装 Herdr 且 API 兼容；**连接失败≠操作未生效，重试前先查远端状态**）。
- socket API：JSON Schema 版本化（protocol 22），`events.subscribe` 支持**保留历史重放 + 追赶失败显式报错**（「fell behind retained history; resubscribe and resync with session.snapshot」）——事件订阅的可靠性语义写得很清楚。

### 2.7 工程纪律（对 vibe coding 团队的参照）

- CLAUDE.md 首条原则即「State separated from runtime」（纯数据可测）；分层指令（universal / maintainer / external guardrail）。
- manifest 有双向守卫测试；检测引擎带 785 行测试；「文案/事实任一改动失配会红」的守卫模式。

## 3. 它没有什么（对照我们的节点与编排）

| 我们的概念 | Herdr | 判定 |
| --- | --- | --- |
| 多租户 / 准入链 / Mandate | 无——本地单用户工具 | ❌ 归我们 |
| 台账（编排事实）与对账三态 | 无（只有本地执行日志） | ❌ 归我们 |
| 任务域（独立目录/凭据/出口策略/焚毁/移交包） | 无——pane 就是真终端，无隔离概念 | ❌ 归我们（byomd core） |
| 凭据代理（agent 不接触凭据） | 无——agent 用员工自己的订阅与凭据 | ❌ 归我们；且引出 B 方向特有治理（用量/责任归属） |
| 云端编排 / Router / Watchdog | 无（`--wait` 只等本地单 pane 状态） | ❌ 归我们 |
| 「对应员工的助理」路由 | 无此概念 | ❌ 归我们 |

## 4. 可借 / 不可借

### 可借（对 byomd Driver B 的四条直接输入）

1. **Manifest 驱动的 harness 识别与状态检测**：把「每个 harness 的事件解析规则」做成数据文件（TOML/清单）而非硬编码——新增 harness = 加一份清单；规则带 priority/not/skip 三件套；检测输出带可解释性。→ 替代 daemon plan §4.1 里「逐个写驱动器」的粗糙表述。
2. **Prompt 提交可靠性三件套**：有序提交（paste+Enter 原子写入）→ 活动门（提交后必须观察到 working，否则 stalled）→ 「stalled ≠ 未送达，禁止盲目重发」。→ Driver B 喂任务的**提交语义**照此实现。
3. **Settled-state 等待语义**：`--wait` 等稳定态、`--until` 等特定态、seen 状态按客户端独立——这套等待语义可直接成为我们「助理等待 agent」的接口契约。
4. **Blocked 信号 = 人工介入触发器**：Herdr 的 `blocked`（审批/提问 UI）正是我们「编排层人工介入」在 Driver B 场景下的探针——blocked 上抛 = 该节点提示人介入。
5. **控制面的 JSON 契约设计**：正式 schema（schemars 从 Rust 类型生成）+ **协议版本号（protocol 22）** + `events.subscribe` 的**保留历史回放**与**追赶失败显式报错**——证明「JSON 控制面 + 强 schema + 明确回放语义」足以管理 agent 运行时；我们的 daemon 契约照此形状（byomd 方案 §2.2、开发规划 §2.1）。
6. **单执行路径模型的产品验证**：Herdr 永远跑 PTY + TUI（它根本没有「无头模式」），「有头」只是有人 attach，「无头」只是没人 attach——detach/reattach 证明「进程不随查看器生灭」。这直接支持 byomd Driver B 的单路径设计（daemon 方案 §4.0）：有头/无头不是两种执行模式，而是观察器在不在。

### 不可借

- 单用户本地工具的全部假设（无租户、无准入、无台账、无对账、无云端）。
- 「屏幕 OCR 式检测」的局限：靠正则匹配 UI 文案，agent 改版即失效（Herdr 用清单热更新缓解）——我们的台账/编排事实才是权威，**检测状态只能当「非权威进度流」**（与 C4 语义一致）。

## 5. 对 byomd 方案的修订建议

1. §4.1「驱动范式」补一条：harness 事件解析采用 **manifest 驱动**（参照 Herdr `detect/manifests` + `DetectionExplain` 可解释性）。
2. §4.1 提交语义补：paste+Enter 有序提交、activity gate、stalled 不重发。
3. §4.3 G5（agent 掉了）补：检测态 `blocked` 上抛为「编排层人工介入」信号；`idle/done` 区分依赖 server 侧 seen 状态（与「进度流非权威」兼容）。
4. B 方向商业叙事补一句先例：Herdr 证明「员工已有的 agent + 一层管理面」是成立的产品形态（23+ agent 生态）；我们不替代它，我们给它**制度与台账**。

## 6. 引用

- `README.md`、`CLAUDE.md`、`skills/herdr/SKILL.md`（214 行）
- `src/detect/manifest.rs` + `src/detect/manifests/*.toml`（23+ 份）+ `src/detect/manifest/tests.rs`（785 行）
- `src/api/wait.rs`（854 行，settled-state 与 activity gate）、`src/api/{server.rs,subscriptions.rs,event_hub.rs,schema.rs}`
- `docs/next/api/herdr-api.schema.json`（protocol 22）
- `src/persist/{restore.rs,snapshot.rs}`、`src/agent_resume.rs`（ReportedAgentResume / dedupe_key）
- `src/remote/{host.rs,saved.rs,restart_policy.rs}`（SSH 桥与机器转发）
- 相关本仓库文档：`enterprise-superagent-node-daemon-plan.md`（BOS 仓库）§4；`enterprise-superagent-architecture.md` §11；`Flowable-BOS人工与Agent协同节点及本地Agent接入设计`（BOS 仓库）
- **本文 §5 第 5 条的落地物**：byomd 契约 v0.1 初稿（BOS 仓库 `docs/drafts/byomd-contract-v0.1/`；控制面 JSON 契约 + 协议版本号 + SSE 追赶显式 `FELL_BEHIND`，均照本文 §2.6 的 Herdr 语义）

## 7. 如果借鉴它实现 Driver B：取舍与规模估算（306k 行的去向）

实测行数分布（`find <dir> -name '*.rs' | xargs wc -l`，基线 `5da0a01e`，总计约 30.6 万行含测试）：

| 模块 | 行数 | Driver B 需要吗 |
| --- | --- | --- |
| `src/client`（TUI：渲染/鼠标/剪贴板/图形协议） | 61.8k | ❌ |
| `src/app`（应用状态/布局/焦点） | 36.8k | ❌ |
| `src/server`（他们的会话服务端） | 29.0k | ❌（用我们自己的 byomd 服务端） |
| 顶层杂项（render、copy_mode、selection、kitty_graphics、popup、sound…） | ~28.6k | ❌ |
| `src/platform` | 13.8k | ⚠️ 只有进程/Job Object 一小块 |
| `src/pane` | 12.3k | ⚠️ 部分（PTY+状态推进） |
| `crates/ghostty-vt`（VT 终端仿真） | 12.2k | ⚠️ **分水岭，见下** |
| `src/integration` | 11.7k | ⚠️ resume 部分 |
| `src/cli` | 10.3k | ❌ |
| `src/api`（socket API） | 9.2k | ⚠️ 订阅/回放语义 |
| `src/terminal`（屏幕状态提取） | 9.1k | ⚠️ 依赖 VT |
| `src/config` | 7.9k | ❌ |
| `src/remote`（SSH 多机） | 6.5k | ❌（C1 通道已覆盖） |
| **`src/detect`（检测引擎+23 份清单）** | **5.4k** | ✅ 核心可借 |
| `src/persist` | 5.1k | ⚠️ 我们有自己的状态与 outbox |
| `src/input` | 4.4k | ⚠️ bracketed paste 一小块 |
| `src/pty` | 3.1k | ✅ 概念可借 |
| `api/wait.rs` | 0.85k | ✅ |
| 测试 | ~35k | — |

**结论：直接相关的约 15–20%；Driver B 的 Go 实现估算 7–12k 行（约 Herdr 的 3–4%）。**

**分水岭——要不要 VT 屏幕仿真**：Herdr 的检测 = PTY 字节 → VT 仿真出屏幕 → 屏幕文本跑正则（ghostty-vt 12.2k + terminal 9.1k + 每 agent 的屏幕规则清单）。我们**不以这条路为首选**：按 daemon 方案 §4.0 的单路径模型，永远跑 PTY + 真 harness，状态信号来自 agent 自报（OSC / hooks / status 行，Herdr 官方也是「自报优先、屏幕兜底」），屏幕规则只作**兜底**——只有走到兜底时才需要 VT 仿真。因此我们**不使用** harness 的 `--print` / `--output-format stream-json` 这类 headless/JSON 专用模式（Claude Code 确有 `--print/-p` 与 `--output-format text|json|stream-json`，`stream-json` 需 `--verbose`、输出 JSONL——但那条路是「另一种执行模式」，与单路径模型冲突）。兜底结果只当「非权威进度流」（架构文档 C4 语义），避免「agent 改版即失效」的维护债。

**要借的是语义，不是体量**：Herdr 的 1798 个 commit 换来的是规则与边界条件（提交可靠性、blocked 判定、seen、resume 去重），抄进设计的成本是几页纸；我们没有理由重写一个 TUI 产品。
