---
title: WorkBuddy 桌面 app / 内置 CLI / CodeBuddy CLI 深度调研
date: 2026-11-24
status: final
tags: [workbuddy, codebuddy, cli, acp, session, resume, fork, tui, codebuddy-lite-wb, workbuddy-config-dir]
agent_read_first: true
---

# WorkBuddy 桌面 app / 内置 CLI / CodeBuddy CLI 深度调研报告

**TL;DR：WorkBuddy 桌面 app 确实自带一套 CLI，但它是 CodeBuddy Code 内核的 WorkBuddy 定制 lite/headless 发行版（`@genie/agent-cli` v2.176.0，入口 `codebuddy-lite-wb.mjs`），不是另起炉灶的产品，也不是只给人用的“简化版”。桌面 app 通过 ACP 驱动它；内置 CLI 产生的会话就是桌面 app 的会话，天然可接续。PATH 里的独立全局 `codebuddy`（`@tencent-ai/codebuddy-code` v2.186.0）是另一份安装，默认与桌面 app 的会话目录和登录态隔离：独立 CLI 的 session 桌面 app 看不到；桌面 session 技术上能被独立 CLI 发现并 resume/fork，但默认不通、无官方支持。内置 CLI 没有交互式 TUI，但并非只有 ACP——它还提供 `--serve`（HTTP/Web UI/REST/ACP over SSE）、`-p/--print`、`--a2a`、`daemon` 等非交互接口。**

> 本文是**工具链与运行环境调研**，不参与 `enterprise-superagent` 的术语体系；文中 `session / resume / fork / ACP` 均指 CodeBuddy/WorkBuddy 产品语义，不得冒充本项目的 Ticket、Mandate 或任务域。
>
> 证据分级：`[本机文件]` 本机安装产物与配置文件；`[运行实测]` 2026-11-24 在本机执行并观察；`[代码/产物]` CLI bundle 或 app asar 内的代码/字符串；`[官方]` WorkBuddy/CodeBuddy 官方文档；`[推断]` 由前述证据推出、原文未直述。所有结论尽量给出其中至少两类证据；没有证据的部分明确写“未证实”。

---

## 0. 一页结论表

> **TL;DR：先按“谁发起的 session”分，再按“哪种 CLI”分；不要笼统问“CLI 能不能接续”。**

| 问题 | 结论 | 关键理由 | 证据 |
|---|---|---|---|
| 桌面 app 是否自带 CLI？ | **是** | `/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/` 是完整 CLI 目录；app 主进程通过 ACP 拉起它 | `[本机文件]` `[代码/产物]` `[运行实测]` |
| 内置 CLI 是 CodeBuddy CLI 的简化版吗？ | **同一内核的 WorkBuddy 定制发行版；不只是简化** | 同源不同版本/不同 bundle；品牌、配置根、工具注入、沙箱、受保护数据都换成 WorkBuddy 的 | `[本机文件]` `[代码/产物]` `[运行实测]` |
| 内置 CLI session → 桌面 app | **可以，而且本来就是同一批** | 内置 CLI 写入 `~/.workbuddy/projects/...`；桌面 app 用 ACP `session/load|resume|fork` 驱动它 | `[运行实测]` `[代码/产物]` |
| 独立全局 CLI session → 桌面 app | **不可以，默认无桥接** | 独立 CLI 写 `~/.codebuddy/projects/...`；两套 sessionId 交集为 0；官方跨端续聊是手机↔桌面 | `[运行实测]` `[官方]` |
| 桌面 app session → 独立 CLI | **技术上可以，默认不通、无官方支持** | transcript 格式兼容；控制实验可越过会话发现；但 config dir/cwd/登录态隔离 | `[运行实测]` `[推断]` |
| 桌面 app session → 独立 CLI fork | **技术前提同上，默认同样不支持** | 能被 resume 的 session 理论上可被 `--fork-session` 派生；未做真实写回实验，故标 `[推断]` | `[代码/产物]` `[推断]` |
| 内置 CLI 有交互 TUI 吗？ | **没有** | bundle 无 TUI 产物；去掉 force 变量报 `Cannot find module '../dist/codebuddy'`；渲染栈被排除 | `[本机文件]` `[运行实测]` `[代码/产物]` |
| 内置 CLI 只有 ACP 吗？ | **不是** | 还有 `--serve`、`-p/--print`、`--a2a`、`daemon` 等；桌面 app 只用了 ACP 通道 | `[运行实测]` `[代码/产物]` |

---

## 1. 调研范围与方法

> **TL;DR：这轮结论来自本机安装产物、运行状态、bundle 代码、隔离控制实验和官方文档交叉验证；没有搬运真实凭据，也没有改写真实 session 数据。**

### 1.1 对象

- **WorkBuddy 桌面 app**：本机 `/Applications/WorkBuddy.app`。
- **app 内置 CLI**：`/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/`。
- **PATH 中的独立 CLI**：`~/.nvm/.../bin/codebuddy`，对应全局 npm 包 `@tencent-ai/codebuddy-code`。
- **会话数据**：`~/.workbuddy/`（桌面 app 侧）与 `~/.codebuddy/`（独立 CLI 默认侧）。

### 1.2 方法

1. **安装产物核对**：读 `package.json`、`bin/codebuddy`、`dist/` 目录，确认版本、入口、bundle 组成。
2. **运行状态核对**：从当前 WorkBuddy 会话的环境变量与 transcript 路径确认“当前会话由谁跑起来、写在哪里”。
3. **app 主进程核对**：从 `app.asar` 中的 `main/acp.js`、`main/server.js`、`daemon-bootstrap.js` 判断 app 如何启动 CLI、使用什么协议。
4. **bundle 字符串/逻辑核对**：定位 `getWorkbuddyConfigDir()`、`resolveHomeDir()`、`WORKBUDDY_PLATFORM_OWNED_PROJECT_FILE_PATTERNS`、`TuiModeService.isTuiMode()` 等关键逻辑。
5. **隔离控制实验**：把桌面 transcript 和资源子目录复制到隔离 config dir，对齐 cwd，使用独立 CLI 的 `-p --resume` 做“有/无有效 sessionId”的对照；全程不复制真实 token。
6. **官方文档交叉验证**：检索 WorkBuddy/CodeBuddy 官方文档中关于 CLI session、跨端续聊、多端协同和“在 CodeBuddy 打开”的表述。

### 1.3 限制与边界

- 本轮未使用进程列表作为证据（被沙箱策略拦截），因此“app 主进程启动 CLI”主要靠 asar 代码和当前会话环境变量证明。
- 曾尝试用软链方式向隔离目录补登录态，被安全策略拦截后停止；**没有复制或改写真实凭据**。
- 尝试写入真实 `~/.codebuddy` 的实验也被拦截后停止；真实两套 session 数据未被修改。
- 版本号、目录计数与官方文档会随更新变化；本文记录的是 **2026-11-24 本机状态**。session 计数在两次抽查中因会话增删略有变化，因此本文只保留“交集为 0”这一稳定结论，不把具体计数当成不变量。

---

## 2. 三个对象，别混成一个

> **TL;DR：桌面 app 是 ACP 宿主；内置 CLI 是被宿主驱动的引擎；PATH 里的全局 CLI 是另一份独立安装。三者共用 CodeBuddy Code 内核，但身份、版本、配置根和用途不同。**

| 角色 | 本机位置 / 标识 | 版本 | 配置根 | 面向谁 | 是否可终端交互 |
|---|---|---|---|---|---|
| **WorkBuddy 桌面 app** | `/Applications/WorkBuddy.app` | app 版本另行维护 | `~/.workbuddy`（由 env 指向） | 桌面用户 | 是（app UI） |
| **app 内置 CLI** | `.../app.asar.unpacked/cli/`，入口 `dist/codebuddy-lite-wb.mjs` | `@genie/agent-cli` **2.176.0** | `CODEBUDDY_CONFIG_DIR` / `WORKBUDDY_CONFIG_DIR` → `~/.workbuddy` | WorkBuddy 宿主 | **否，无 TUI** |
| **独立全局 CLI** | `~/.nvm/.../bin/codebuddy`，包 `@tencent-ai/codebuddy-code` | **2.186.0** | 默认 `CODEBUDDY_CONFIG_DIR || ~/.codebuddy` | 终端用户 / CI | 是（完整 TUI bundle） |

`[本机文件]` 内置 CLI 的 `package.json` 声明 `@genie/agent-cli` v2.176.0，bin 名为 `codebuddy` / `cbc` / `codebuddy-code`；但它不在 PATH 中，普通终端敲 `codebuddy` 命中的是全局 2.186.0。`[运行实测]` 两者 `--version` 分别为 2.176.0 与 2.186.0，`--help` 都显示 `Usage: codebuddy|cbc` 和 “CodeBuddy Code”。

`[代码/产物]` app 的 `main/acp.js` 是 ACP 协议客户端，方法枚举包含 `session/new`、`session/load`、`session/resume`、`session/fork`、`session/list`；`daemon-bootstrap.js` 负责从 bundle 解压并拉起 CLI。也就是说：**桌面 app 不自己实现 agent 内核，而是作为宿主用 ACP 驱动内置 CLI。**

---

## 3. 桌面 app 是否自带 CLI？

> **TL;DR：是。最硬的证据不是目录存在，而是当前 WorkBuddy 会话本身的环境变量和 transcript 路径都指向这份内置 CLI。**

### 3.1 安装产物证据

`[本机文件]`

- `cli/package.json`：`"name": "@genie/agent-cli"`，`"version": "2.176.0"`。
- `cli/bin/codebuddy`：根据 `CODEBUDDY_FORCE_LITE_WB_BUNDLE` 等开关选择加载哪份 bundle。
- `cli/dist/`：只有 `codebuddy-lite-wb.mjs`（约 12 MB）与 `lazy-lite-wb/`；没有完整 TUI bundle `codebuddy`，也没有独立 headless bundle。

### 3.2 运行状态证据

`[运行实测]` 当前 WorkBuddy 会话环境变量包含：

- `CODEBUDDY_FORCE_LITE_WB_BUNDLE=1`
- `CODEBUDDY_FORCE_HEADLESS_BUNDLE=1`
- `CODEBUDDY_HOST=workbuddy-desktop`
- `CLIENT_INFO_IDE_TYPE=WorkBuddy`
- `WORKBUDDY_CONFIG_DIR=/Users/yangjiefeng/.workbuddy`
- `CODEBUDDY_SESSION_ID=e02cdbcd-...`

且当前会话 transcript 落在：

```text
~/.workbuddy/projects/Users-yangjiefeng-Documents-deepseek-ai-dsh-superagent-prototype/e02cdbcd-....jsonl
```

这形成闭环：**WorkBuddy 桌面 app → 内置 lite-wb CLI → `~/.workbuddy` transcript**。

### 3.3 官方口径的边界

`[官方]` 官方文档把 WorkBuddy 列为 CodeBuddy Code 的 ACP 宿主之一（见 `https://www.workbuddy.cn/docs/cli/release-notes/v2.110.0`），但 CLI 安装文档只讲独立安装 `@tencent-ai/codebuddy-code`，**没有明文写“桌面 app 自带 CLI”**。因此“自带”这一事实以本机安装产物和运行状态为准，不冒充官方承诺。

---

## 4. 内置 CLI 与 CodeBuddy CLI 是什么关系？

> **TL;DR：同一 CodeBuddy Code 内核、不同版本、不同构建变体。内置版是 WorkBuddy 宿主任制的 lite/headless 发行版；说它“只是简化版”会漏掉品牌、配置根、工具集和沙箱的替换。**

### 4.1 同源证据

`[运行实测]` 两份 CLI 的 `--help` 都自报 CodeBuddy Code，命令名同为 `codebuddy|cbc`，resume/fork 参数也一致：`-r/--resume`、`-c/--continue`、`--fork-session`、`--session-id`。

`[代码/产物]` 内置 `bin/codebuddy` 的注释写明：`CODEBUDDY_FORCE_LITE_WB_BUNDLE=1` 时加载 `dist/codebuddy-lite-wb.mjs`，该 bundle 是在 headless 基础上进一步剔除 WorkBuddy 结构性不用的桶（TUI 视图、lsp、update、record-replay、channel 等）。

### 4.2 定制证据

`[代码/产物]`

- `getWorkbuddyConfigDir()` 读取 `WORKBUDDY_CONFIG_DIR`，默认 `~/.workbuddy`。
- `WORKBUDDY_PLATFORM_OWNED_PROJECT_FILE_PATTERNS` 把 `projects/*/*.jsonl` 等列为平台托管、受保护的数据。
- WorkBuddy 内置 skill/MCP 通过 `CODEBUDDY_MCP_CONFIG` 注入。
- 本环境还存在 WorkBuddy 的 safe-delete broker（由 `NODE_OPTIONS` 注入 node-language-shim 与此前 archify 实验佐证）。

`[推断]` 因此更准确的定位是：**面向 WorkBuddy 宿主的定制 CodeBuddy Code 引擎**，不是给人在终端敲的轻量交互版；也不是与 CodeBuddy CLI 无关的“另一个东西”。

---

## 5. Session 接续：四个方向逐一判定

> **TL;DR：session 存储随宿主走。谁写下的 transcript，谁默认能读；共用格式不等于默认互通。**

### 5.1 存储模型

`[代码/产物]` 两类 transcript 路径结构同构：

```text
{configDir}/projects/{workspace}/{sessionId}.jsonl
{configDir}/projects/{workspace}/{sessionId}/   # 同名资源子目录
```

`[代码/产物]` resume 时 transcript 路径由 `sessionStore.getSessionFilePath()` 解析，最终落到 `resolveHomeDir()` → `CODEBUDDY_CONFIG_DIR || ~/.codebuddy`（`USER_DATA_DIR_NAME=".codebuddy"`）。桌面 app 之所以写到 `~/.workbuddy`，是因为启动时把 `CODEBUDDY_CONFIG_DIR` / `WORKBUDDY_CONFIG_DIR` 都设成该目录。

`[运行实测]` app 侧另有 `~/.workbuddy/app/sessions.json`，使用 `conversationId`（UUID v4）；transcript 使用 `sessionId`（UUID v7 风格）。两套 ID 通过 ACP 关联，**不要把 conversationId 当成 transcript sessionId**。

### 5.2 方向 A：CLI session → 桌面 app

#### 5.2.1 内置 CLI session

**结论：可以，而且这些 session 本来就是桌面 app 的 session。**

`[运行实测]` 当前会话由内置 lite-wb CLI 运行，transcript 直接在 `~/.workbuddy/projects/...` 下。`[代码/产物]` app 的 ACP 客户端支持 `session/load`、`session/resume`、`session/fork`，因此桌面 app 对内置 CLI 会话的“接续”不是跨产品迁移，而是宿主对自身引擎会话的常规操作。

#### 5.2.2 独立全局 CLI session

**结论：不可以，默认无桥接。**

- `[运行实测]` `~/.codebuddy/projects` 与 `~/.workbuddy/projects` 下都有会话，但 sessionId 交集为 0。
- `[官方]` 官方跨端续聊文档讲的是**手机↔桌面**（`https://www.workbuddy.cn/docs/workbuddyapp/features/Multidevice`），不是 CLI↔桌面。
- `[官方]` “在 CodeBuddy 打开”打开的是**本地工作空间文件夹**，不是接管某个 CLI session（`https://www.workbuddy.cn/docs/workbuddy/Task-Management`）。
- `[官方]` CLI 的 `--resume/--continue` 文档口径是“对话历史存储在本地计算机上”（`https://www.workbuddy.cn/docs/cli/daemon`），没有桌面导入入口。
- `[推断]` `/export` 导出的是对话记录材料，可用于重新开任务，但不是 session 级 resume/fork。

### 5.3 方向 B：桌面 app session → CLI

> **TL;DR：格式兼容已被控制实验证明；默认不通来自目录、cwd 和登录态隔离，而不是格式不兼容。**

#### 5.3.1 控制实验

`[运行实测]` 在隔离 config dir 中做了一组对照：

1. 把桌面会话 `e02cdbcd` 的 transcript 与同名资源子目录复制到隔离目录，并让 cwd 与 transcript 所在 workspace 对齐。
2. 用独立 CLI 执行 `-p --resume <桌面 sessionId>`。
3. 结果：**越过 `No conversation found`，到达 `Authentication required`**——说明会话已被发现并识别，只是隔离目录没有登录态。
4. 对照组：同样目录与 cwd，换成随机不存在的 sessionId → 仍是 `No conversation found`。
5. 第一次把 transcript 放在项目 A 但 cwd 在项目 B 时 → `No conversation found`；说明 **cwd 对齐是会话发现条件之一**。
6. `history.jsonl` 字段只有 `display/timestamp/project`，不含 sessionId；因此它不是这里的发现依据，发现主要靠 transcript 文件与 cwd 对齐。

`[推断]` 既然 `--resume` 能识别桌面 transcript，`--fork-session` 也能基于它派生新 session；但本轮没有在真实登录态下完成 fork 写回，因此 fork 只标技术可行性，不标“已实测成功”。

#### 5.3.2 为什么默认仍然不通

- 两套 CLI 的默认 config dir 不同：`~/.codebuddy` vs `~/.workbuddy`。
- 登录态随 config dir 走；隔离实验缺少独立 CLI 的登录态。
- 需要手动搬运 transcript + 资源子目录、对齐 cwd、并保证目标 config dir 有登录态。
- 官方文档没有把这条路径写成产品能力；所以它属于**绕过隔离**，不是支持的工作流。

### 5.4 接续判定速查

| 起点 | 目标 | 默认可用？ | 说明 |
|---|---|---|---|
| 桌面 app 内发起的任务 | 桌面 app 继续聊 | **是** | 底层就是内置 lite-wb CLI |
| 独立全局 CLI 会话 | 桌面 app 继续聊 | **否** | 会话目录/ID 隔离，无官方桥接 |
| 桌面 app 会话 | 独立 CLI resume | **默认否；技术上是** | 需搬运 transcript + 资源目录、对齐 cwd、补登录态 |
| 桌面 app 会话 | 独立 CLI fork | **默认否；技术上可行 `[推断]`** | 未做真实写回实验 |
| 内置 lite-wb CLI 会话 | 桌面 app | **是** | 内置 CLI 的会话就是桌面会话 |

---

## 6. 内置 CLI 有 TUI 吗？是不是只有 ACP？

> **TL;DR：没有交互式 TUI，这一点证据闭合；但“只有 ACP”不准确——lite-wb 暴露多种非交互入口，桌面 app 只是选择 ACP 通道。**

### 6.1 没有交互 TUI：三层证据

`[本机文件]` 内置包 `dist/` 只有 `codebuddy-lite-wb.mjs` 与 `lazy-lite-wb/`，**没有** TUI bundle `codebuddy`，也没有可回退的 headless bundle。

`[运行实测]` 去掉 `CODEBUDDY_FORCE_LITE_WB_BUNDLE` 直接启动内置 CLI：

```text
Cannot find module '../dist/codebuddy'
```

立即失败；说明“启动脚本里逐级回退到 headless/full”的描述在这个 app bundle 里没有对应产物可退。

`[代码/产物]`

- lite-wb 的依赖排除白名单包含：`ink:!1`、`ink-spinner:!1`、`react:!1`、`react-reconciler:!1`、`yoga-wasm-web:!1`——TUI 渲染栈被明确排除。
- 未见 `useInput`，未见 `from"ink"`。
- `TuiModeService.isTuiMode()` 条件含 `!isHeadless() && !!process.stdout.isTTY && ...`；lite-wb 派生自 headless，`isHeadless()` 恒真，故 TUI 模式恒 false。
- 强制 lite-wb、无 flag、无 TTY 时直接无输出退出，不渲染界面。

启动脚本注释已直说：lite-wb 在 headless 基础上进一步剔除“TUI 视图”等桶。

### 6.2 不是只有 ACP：实测存在的接口

`[运行实测]`

| 接口 | 参数/命令 | 说明 |
|---|---|---|
| ACP | `--acp`（stdio）、`--acp-transport streamable-http` | `session/new`、`session/load` 等；桌面 app 使用这条 |
| HTTP Server | `--serve` | 实测成功起服务，提供 Web UI + REST API + ACP over HTTP SSE |
| Headless 打印 | `-p/--print`，配合 `--input-format` / `--output-format`（含 `stream-json`） | 本轮 resume 控制实验使用此模式 |
| A2A | `--a2a` | stdio 上的 JSON-RPC |
| 进程/会话管理 | `daemon`、`ps`、`logs`、`attach`、`kill` | 宿主侧运维接口 |
| 配置与扩展 | `config`、`mcp`、`sandbox`、`plugin`、`project`、`doctor`、`update`、`cleanup` | 管理子命令 |

`[运行实测]` `--help` 第一句仍写 “CodeBuddy Code - starts an interactive session by default”，这是从完整 CLI 继承的文案；**不能据此判断它有 TUI**，因为 bundle 证据与启动实测都推翻了这句话在本变体中的适用性。

---

## 7. 给 agent / 工程师的可执行建议

> **TL;DR：想要“终端开、桌面接着聊”，目前没有官方支持；想要稳定自动化，就明确选定一套 CLI 和它的 config dir。**

1. **从桌面 app 发起、需要继续在桌面聊**：正常用即可；底层是内置 lite-wb CLI，会话天然连续。
2. **从终端独立 CLI 发起、想桌面接续**：不要承诺可行。可把 `/export` 的对话记录作为新材料在桌面重开任务，但这不是 session 级接续。
3. **要把桌面会话拿到终端**：知道技术上能搬 transcript，但这是非支持路径；需要同时处理 cwd、资源子目录、config dir 和登录态，且可能随版本升级失效。
4. **需要交互 TUI**：用 PATH 里的独立全局 `codebuddy`；内置 CLI 没有 TUI 产物。
5. **需要被程序驱动**：内置 lite-wb 可用 ACP / `--serve` / `-p` / `--a2a`；但若要脱离 WorkBuddy 宿主独立部署，优先选官方独立 CLI，避免依赖 `WORKBUDDY_*` 私有开关。
6. **排查同类问题时**：先问“session 是谁写的、写在哪个 config dir、cwd 是否对齐”，再问“格式是否兼容”；后者通常不是瓶颈。

---

## 8. 证据清单

> **TL;DR：以下是便于复核的入口；不要在报告里补写没有来源的“官方支持”说法。**

### 8.1 本机路径

- `/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/package.json`
- `/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy`
- `/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/dist/codebuddy-lite-wb.mjs`
- `~/.workbuddy/projects/{workspace}/{sessionId}.jsonl`
- `~/.workbuddy/app/sessions.json`
- `~/.codebuddy/projects/{workspace}/{sessionId}.jsonl`

### 8.2 官方文档（2026-11-24 检索）

- CLI daemon / session 存储：`https://www.workbuddy.cn/docs/cli/daemon`
- CodeBuddy Code 与 ACP 宿主关系：`https://www.workbuddy.cn/docs/cli/release-notes/v2.110.0`
- 手机↔桌面多端续聊：`https://www.workbuddy.cn/docs/workbuddyapp/features/Multidevice`
- “在 CodeBuddy 打开”的语义：`https://www.workbuddy.cn/docs/workbuddy/Task-Management`

### 8.3 本仓库关联记录

- `.workbuddy/memory/2026-11-24.md`：本轮调研的过程结论与实验边界。
- `docs/drafts/README.md`：drafts 目录入口与 agent 阅读顺序。

---

## 9. Agent 检索关键词

`WorkBuddy 内置 CLI` · `WorkBuddy desktop ACP` · `codebuddy-lite-wb` · `@genie/agent-cli` · `@tencent-ai/codebuddy-code` · `session resume` · `session fork` · `conversationId` · `sessionId` · `~/.workbuddy` · `~/.codebuddy` · `WORKBUDDY_CONFIG_DIR` · `CODEBUDDY_CONFIG_DIR` · `TUI` · `--serve` · `--print` · `--a2a`

**若未来 app 版本升级，请优先重测三件事：内置 bundle 版本与 `dist/` 组成；`resolveHomeDir()` 使用的 config dir；桌面 app 是否新增 CLI session 导入/桥接入口。**
