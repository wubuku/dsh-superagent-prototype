# OpenMausBot 深度调研报告

对象：milind-soni/OpenMausBot，本地路径 `/Users/yangjiefeng/Documents/milind-soni/OpenMausBot`（远端 `https://github.com/milind-soni/OpenMausBot.git`）。
基线：HEAD `1bc4749aa`（chore(release): bump version to 0.1.146）。
调研方式：文档 ↔ 代码逐条核对，关键断言附文件路径；沙箱/运行时、多 bot 委派、计算面三条线由专项子核查补证据，全部结论已在撰写前回原文复核。

## 0. 一句话结论

OpenMausBot 是**一个真实运营的商业开源项目**：Apache 2.0 + 独立 source-available 企业层，2026-08-12 从零起步，约 3 个月 8685 个提交（近 30 天 4931 个），桌面应用里跑一支「AI bot 团队」，每个 bot 是本地 CLI（Claude/Codex/Grok）上的真 agent，各有模型、电脑、应用与记忆。它把**多 bot 委派**（统一 Assignment 运行时）与**进程级沙箱**（bot box）做到了生产级，但**不是** DeepSeek Super-agent 意义上的「企业级编排层」：角色是扁平 peer + 每部门一个 Chief of Staff，没有 Router/Worker/Watchdog，没有通用 Trigger 准入链，没有「每任务一域、用完即焚」的任务域模型。

**判定：做到「个人/小团队多 agent 协作平台」的近乎完整程度；「企业级 Super-agent 平台」所需的准入链、组织级治理与任务域模型，它没有。**

---

## 1. 系统一览

- **形态**：Electron 桌面应用（macOS/Windows/Ubuntu）+ 内嵌 harness server（127.0.0.1）+ 可选云（Fly.io 每客户一台常开 home 机）+ 手机/浏览器/headless CLI。
- **技术栈**：TypeScript strict + React 19 + Electron + SQLite（`node:sqlite`）；引擎是本地 CLI（claude/codex/grok/Gemini/OpenCode/ACP agents）。
- **规模**（实测）：`server/` 2586 个 `.ts`（**1348 个测试文件**，占 51.4%）、`src/` 1807 个 ts/tsx、`connector/src` 23 个 ts（4612 行）、`relay/src` 13 个 ts、bot-box 34 个文件 3665 行、runtime 子系统约 7.5k 行代码 + 约 11k 行测试。
- **活跃度**：近 30 天 4931 提交、近 7 天 1194 提交（截至 2026-11-07）。
- **许可**：核心 Apache 2.0；`enterprise/` 独立 source-available（Ed25519 许可证密钥控制功能，删掉即社区版）。

---

## 2. 它做到了什么（实证）

### 2.1 多 bot 委派：真委派，有统一运行时

- **唯一入口 `coordinate_bots`**（`server/drivers/agents-catalog.ts:224-241`）：任何 bot 可把活派给任何可达 bot（不限 Chief of Staff）；assignee 只能是 bot（`server/runtime/types.ts:36-41`），requester 四类（person / bot_turn / routine_run / external_runtime）。
- **统一 Assignment 记录**（`types.ts:80-156`）：树（rootId/parentId/depth，深度上限 4）、三种模式（work/consult/notify）、回复方式（resume/poll/none）、状态与结果、执行次数与重启记账、每 root 的预算。
- **生命周期**（`server/runtime/runtime.ts`，tick 循环 + SQLite 事件溯源，非 reducer 状态机）：`queued → running → completed/failed/cancelled`，`waiting → resume`（子任务全部落定后再跑一轮），`needs_input → running`（回答后继续）；重启对账（`:79-125`：needs_input 重新 park、已派发转 waiting、有 outward 行为直接 failed、切断两次不再重跑）。
- **同请求合并**（`server/same-request.ts` + `runtime-coordinator.ts:625-655`）：同一问题被两个 requester 问、且答案还在产出中时，第二个请求不跑自己的 turn，等第一个的答案（40 字符阈值、大小写/标点归一）。
- **子问题打断等待**：子任务 park 在「等人回答」时，父节点 resume 一次带着这个问题跑（`runtime.ts` 的 `asked` 输入），不重复问。
- **e2e 证据**：`server/direct-coordination.e2e.test.ts:44-60` 跑 Chief→Engineering lead→Reviewer 三级委派。

### 2.2 沙箱：bot box（仅 Cloud home 默认开启）

- **每个 engine 进程一个 bubblewrap 沙箱**（`server/bot-box/`）：`--unshare-user/ipc/uts/pid/net/cgroup-try` + seccomp + 私有挂载表（`/usr /etc /opt` 只读、数据目录 tmpfs 盖空、私有 PID/网络命名空间），见 `server/bot-box/plan.ts:222-230`。
- **两道门**：egress 门（`egress-gate.ts`）只放公网——本机/局域网/云元数据按地址拒绝、DNS 自解析并 pin 防重绑定；harness 门（`harness-gate.ts`）只放 `/api/internal/`，其余 403。
- **凭据 broker**（每轮能力令牌，四文件）、**登录回调中继**（`relay.ts` + `/run/omb/relay.sock`）、**自检**（`box-probe.ts` 在真实箱内跑两组检查：基础 23 + broker 6，文档称「29 in all」，为文档自称，未独立复核）、启动 5 秒后自检一次。
- **关键限定**：沙箱**只在 Cloud home 默认开**（`detect.ts:27-38`），桌面/自托管默认关——所以「生产级沙箱」仅对 Cloud 成立。

### 2.3 审批：provider 权限模式透传 + 应用层补刀

- 四级（Ask / Auto-accept edits / Approve for me / Full access）+ Custom，**默认 Full access**（`shared/approval-mode.ts:71` `DEFAULT_APPROVAL_MODE = "full"`）。
- **原则**：`shared/approval-mode.ts:1-3`「OpenMausBot never decides a permission itself (Full access aside)」——权限由 provider 的 reviewer 判，OMB 只补口子（`server/auto-approve.ts:73-122`）：Full access 自动批、外发工具与沙箱放宽挡、保存命令/读自己文件批、`auto` 且 web search 批、其余留卡片。
- **问题永不自动回答**（`auto-approve.ts:88-90`）；Chief 的等级沿委派链**只升不降**（`server/host/delegated-level.ts:29-89`）；bot 间联系也要审批卡（`server/peer-approval.ts`）。
- **bot 读自己的文件永不问**（`docs/approval-levels.md` 的规则细化到管道/重定向/通配符）。

### 2.4 记忆：纯文件 + FTS

- `~/.openmausbot/workspaces/<bot>/MEMORY.md` + `memory/<topic>.md` + `log/`（`docs/memory.md:19-27`），**每 bot 私有**，预算 200 行/24KB（`server/workspace.ts:30-32`）。
- 召回是 **SQLite FTS + bm25 关键词**（`server/message-db.ts:967-985`），**无向量、无 embedding**（全仓无 faiss/cosine）。
- 跨 bot 共享是文件级受控：团队记忆需 admin 审核（`server/team-memory.ts:1-6`）、人物偏好写进 About me（`server/host/person-preference.ts`）。
- 这与我们「组织知识不进记忆」的取向**同向但更朴素**：没有 BlueCortex 那种跨会话提炼，也没有知识生产线。

### 2.5 计算面：四种 surface，都不是「任务域」

统一定义 `shared/wire.ts:64` `Surface = "cloud" | "vm" | "local" | "browser"`：

| 计算面 | 隔离 | 生命周期 | 状态 |
| --- | --- | --- | --- |
| **Boat 云电脑**（第三方） | Boat 自有 sandbox（内部**无法核实**） | 按需 provision/wake，10 分钟空闲 stop，磁盘持久 | Boat 侧；box id 只缓存在内存 |
| **自托管 VPS** | Docker 容器加固（cap-drop ALL 等，`dockerSecurityIsHardened`） | sleep/start 保文件；remove 才清空；OMB 不自动删 | VPS Docker；别名在 config.json |
| **Local VM**（Docker/Podman + Cua XFCE 容器） | 容器加固；**shared 模式跨 bot 共用一个容器一个工作区**（弱隔离）；per-bot/pool 才独立 | 空闲 stop **保留文件**（不销毁） | 容器 + `vm-home(s)` + 停机记录 |
| **This computer**（host control） | **无隔离**：真实桌面 + TCC/权限 + opt-in + 逐动作审批 | 驱动随 Electron；内存 grant | 内存；Linux 仅 Xorg，Wayland fail-closed |

**connector/**（`connector/src/`，4612 行）是**「把你自己的服务器变成一台 Cloud home」的 daemon**——不是本机接入云。它只出站：一次性码 HTTPS 注册（Ed25519，Admin pin 密钥）、保持一条 WebSocket、Admin 签名下发 job、二进制走 yamux 流、**无 shell 无其他命令**（`connector/src/protocol.ts:1-14`）。
**relay/** 是**手机 ↔ 家里电脑**的 E2E 加密远程接入中继（distroless、cap-drop ALL），不是 per-bot 计算面。

### 2.6 对外互操作

- **本地 stdio MCP server**（`docs/mcp-server.md`）：外部 MCP 客户端可列出 bot/频道、读有限转录、建 bot/频道、派活、等 settle、打断 turn——这是它给「异构 agent 通信」的**唯一现成原语**。
- **headless CLI**（`docs/headless-cli.md`）：脚本/CI 可组队、派活、等完成、导出产物。
- **Bot API**（`docs/bot-api.md`）：每 bot 一个密钥，收外部消息回答复。
- **没有** A2A / ACP / Agent Card 作为对外 agent 协议（仓库检索无命中；ACP 只作为**被驱动的引擎**出现）。

---

## 3. 它没有什么（对照 DeepSeek Super-agent）

| DeepSeek 文章概念 | OpenMausBot | 判定 |
| --- | --- | --- |
| **通用 Trigger/Event 准入链**（谁有权发起工作） | **没有**。事件过滤后直接起 run（`server/app-triggers.ts`），无 Policy/Mandate/accept-mode；只有会话槽位准入（`server/admission.ts`）与「outside 血统不继承层级」的粗规则 | ❌ 无对应物 |
| **Router/Worker/Watchdog 三角色** | **扁平 peer + 每部门一个 Chief of Staff**（Chief 管工具与升级，不管路由）；无 Watchdog（`turn-watchdog.ts` 是卡死检测器，`sentinel.md` 是进程外健康扫描器，都不是 agent） | ❌ 角色不同构 |
| **任务域（每任务一域、用完即焚）** | **没有**。最接近的是 bot box（per-process 生命周期，仅 Cloud 默认开）；Local VM/VPS/Boat 都是**持久复用**、空闲 sleep 不销毁 | ❌ 无「焚毁」语义 |
| **主动式（proactive）** | **一条默认例程**「Keep an eye on my day」（15 分钟，先纯代码检查日历/邮件/运行，再按需一次 AI run）+ 无 AI 的 brief 卡 + 辅助模型分诊；**无后台模型跑日期检查** | ⚠️ 有主动，但形态是「日程表 + 过滤」，不是「事件流 + 授权评估」 |
| **Watchdog 盯进展** | 有卡死检测 + Sentinel 健康扫描 + 团队 incident 升级到 Chief（`docs/team-incidents.md`），但**都是 runtime 机制，不是独立只读 agent** | ⚠️ 机制在，角色不在 |
| **对账/三态** | 有审批卡与重启对账（outward 行为拒绝重跑），但**没有**「已确认/未发生/未知」三态对账语义 | ⚠️ 部分 |

---

## 4. 与我们企业级设计的对照

### 4.1 可以借鉴的（按分量）

1. **统一 Assignment 运行时契约**（`server/runtime/`，7.5k 行 + 11k 测试）：树、状态机、重启对账、同请求合并、子问题打断等待——**这是我们 C1/C2 与编排事实最直接的工程参照**，尤其「同一请求只答一次」与「重启不重复外发」。
2. **bot box 的双门 + 凭据 broker**：egress 按地址策略拒绝本机/局域网/元数据、harness 门只放内部路由、每轮能力令牌——与我们的「任务域信封」同构，可直接对照。
3. **审批分层与「问题永不自动回答」**：provider 权限模式透传 + 应用层补刀 + Chief 层级只升不降——与我们 §7.4 三层授权、§8 三层人工介入同向。
4. **connector 的「只出站 + 单连接」**：一次性码注册、Ed25519 pin、连接计数防密钥复制、yamux 流——**C1「节点只出站、中心复用连接」的生产实现**（比 Comma 的 iroh 更中心化）。
5. **fail-closed 纪律**：Wayland host control 因证据不足直接禁用；safety-floor-gate 在「无人看着」时挡自动允许。
6. **供应链 pinning**：digest-pinned 基础镜像 + SHA-256 校验的 wheel。
7. **纯文件记忆 + FTS**：朴素但可审计，与我们「组织知识不进记忆」同向。

### 4.2 不可借的

- **持久复用的计算模型**：Local VM/VPS/Boat 都可复用可持久，**没有「每任务一域、用完即焚」**；共享 Local VM 模式甚至跨 bot 共用容器与工作区（无隔离保证）。
- **无通用准入链**：事件过滤后直接起 run，没有「谁有权发起工作」的授权评估层——这正是我们三类事实里「制度事实归 BOS」要补的位。
- **无组织级治理**：没有租户化编排存储、没有对账三态、没有冻结/审计、没有知识生产线——这些是 BOS/RAG/编排存储各自的位置。
- **host control 无沙箱**：真实桌面权限 + 审批，不能当安全执行域；且只在 macOS/Ubuntu Xorg 可用。
- **Cloud home/connector 是整机级重模型**：对「执行节点/任务域」是过度设计。

---

## 5. 结论

1. **修正「没有现成的东西可用」的判断再次成立**：OpenMausBot 证明**多 agent 委派运行时 + 进程级沙箱 + 审批分层**在桌面/小团队尺度上是可以做到生产级的；Apache 2.0 也意味着**代码可借鉴**（不是只能读文档）。
2. **它仍不是「企业级 Super-agent 平台」**：没有通用 Trigger 准入链（制度事实）、没有任务域焚毁语义（运行事实的隔离面）、没有 Router/Worker/Watchdog 角色（只有扁平 peer + Chief）、没有组织治理（治理账本）。
3. **对我们的三条直接输入**：
   - **C1/C2 与编排事实**：`server/runtime/` 的 Assignment 契约 + connector 的只出站单连接，是 §11.2 提案的**两个生产原型**；
   - **任务域**：bot box 的双门/凭据 broker 可对照，但它**不焚毁**——「用完即焚」仍要我们自建；
   - **人工介入**：审批分层与「问题永不自动回答」可抄；三层「看/接/批」仍要我们定义。
4. **建议动作**：
   - 把 OpenMausBot 加入「可复用的运行事实研究」材料（与 BOS/Comma/原型并列）；
   - 精读 `docs/runtime-contract.md` + `server/runtime/`（我们 §11.2 与编排事实的直接参照）；
   - 精读 `docs/bot-box.md` + `server/bot-box/`（任务域双门/凭据 broker 的参照）；
   - 评估 connector 协议（`connector/src/protocol.ts`）作为 C1 只出站通道的候选实现。

---

## 6. 引用

- README.md、docs/runtime-contract.md、docs/bot-box.md、docs/approval-levels.md、docs/memory.md、docs/compute-devices.md、docs/cloud-pro.md、docs/byo-vps.md、docs/linux-desktop.md、docs/computer-use-integration.md、docs/mcp-server.md、docs/headless-cli.md、docs/proactive-routines.md、docs/sentinel.md、docs/team-cloud.md、docs/team-incidents.md
- server/runtime/{types.ts,runtime.ts,store.ts,invariants.ts,level.ts,tree.ts}、server/runtime-coordinator.ts、server/same-request.ts、server/bot-box/{plan.ts,egress-gate.ts,harness-gate.ts,relay.ts,detect.ts}、server/drivers/{agents-catalog.ts,agents-call.ts,claude.ts,chat-tool-approval.ts}、server/auto-approve.ts、server/host/{share-answer.ts,delegated-level.ts,proactive-owner.ts,room-jobs.ts}、server/peer-approval.ts、server/turn-watchdog.ts、server/sentinel/、server/workspace.ts、server/memory-store.ts、server/message-db.ts、server/container-computer.ts、server/local-vm-settings.ts、server/local-vm-seat-pool.ts、server/boat.ts、server/vps-computer.ts、server/desktop-computer.ts、server/your-computer-consent.ts、server/computer-control.ts、server/admission.ts、server/app-triggers.ts、server/peer-roster.ts、server/chief-level.ts
- connector/src/{main.ts,protocol.ts,agent.ts,mux.ts,home.ts,audit.ts,images.ts}、relay/src/{main.ts,server.ts,phone.ts,wire.ts}
- 子核查产物：沙箱/运行时（bot-box argv、双门、自检（文档自称 29 项）、runtime 7.5k 行 + 11k 测试）、多 bot 委派（coordinate_bots 唯一入口、树、同请求合并、e2e）、计算面（四 surface、connector/relay 性质、隔离对照）
