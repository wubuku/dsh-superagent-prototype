# nono 深度调研报告

对象：nolabs-ai/nono，远端 `https://github.com/nolabs-ai/nono`。
基线：HEAD `e9796cca`（2026-11-06，fix(docker): create home directory for nono user）。
调研方式：README / docs ↔ crates 目录与关键路径核对；事实分 [文档] / [代码]；坐标系为 `enterprise-superagent-architecture.md` 三空位与三类事实。

## 0. 一句话结论

nono 是 **agent 运行时安全层（runtime security）**，不是控制平面，也不是任务域产品：它用可组合 profile 把「每个工具一次 ephemeral 命令沙箱 + 凭据代理注入 + L7/网络策略 + 审计/回滚」做到了生产可用的工程密度，与我们架构 §4.5 / §7.5「凭据不进模型上下文、随执行环境注入」**同向**。但隔离单元是 **工具/命令**，不是我们的 **任务域信封**；没有 Mandate、没有移交包、没有组织编排。

**判定：空位②的「安全原语」可裁剪借鉴；禁止当成任务域产品或准入链。**

---

## 1. 系统一览

| 项 | 内容 |
| --- | --- |
| 定位 | [文档]「complete agent runtime security tool」——保护 tools / credentials / network / supply-chain / audit / rollback |
| 技术栈 | Rust 单二进制；`crates/nono`、`nono-cli`、`nono-proxy`；FFI / Python bindings |
| 规模 / 活跃 | ~4.9k stars；Apache-2.0；近一年持续提交（HEAD 2026-11-06） |
| 运行面 | macOS / Linux / Windows(WSL2)；宣称无 root、可跑在 laptop / K8s / CI / container / microVM |
| 产品包装 | registry.nono.sh 的 agent packs；文档示例提及 Claude Code、Codex、OpenClaw、Hermes 等——**包装对象不是我们的推荐底座**，只说明它是宿主无关的安全壳 |
| 许可 | Apache-2.0 |

---

## 2. 它做到了什么（实证路径）

### 2.1 工具级 ephemeral 沙箱（命令中介）

[文档] `docs/cli/features/tool-sandbox.mdx`：

- 选中的命令进入 **command sandbox**：每次调用由 Capability Broker 启动 **fresh** 沙箱，不继承 session sandbox 的 `--allow`、CWD、凭据路径或网络策略。
- `command_policies.commands.<name>` 回答三问：session 可直接跑什么；一个已中介命令可链式调用什么（`can_use` / `from`）；该命令沙箱拿到什么 fs/network/credential 授权。
- 策略在 agent 控制之外（composable profiles）；例：`aws` 可用凭据而 `curl` 不可；`gh` 只读 issues/PRs、只允许发到指定 org。

这与 OpenMausBot bot-box「每进程一箱」同族，但粒度更细：**按工具/命令** 而非按 bot 进程。

### 2.2 凭据代理注入（密钥出进程）

[文档] `docs/cli/features/credential-injection.mdx`：

- **Proxy injection（推荐）**：agent 只见 `localhost:<port>/<service>/...`；proxy 剥前缀、注入真凭据头、TLS 转发上游；agent 环境/内存中无真密钥。
- 备选：keyring → 环境变量注入（更简单，但密钥可见于进程环境）。
- 支持系统 keystore、1Password `op://` URI。
- phantom tokens：把凭据使用限制在批准的工具上（README 明示）。

[代码] `crates/nono-proxy/src/`（`server.rs`、`config.rs`、`tls_intercept/`）与 `crates/nono-cli/src/proxy_runtime.rs` 支撑代理运行时——与我们「节点不持有租户凭据、凭据随域注入」的纪律同向，但是 **工具调用级 vault**，不是任务域级 vault。

### 2.3 网络 / 供应链 / 审计 / 回滚

- 网络：域名过滤 + HTTP method/path 规则（README + networking 文档）。
- 供应链：Sigstore 校验 skills / hooks / instructions（团队背景即 Sigstore）。
- 审计：tamper-evident session / security decision 记录。
- 回滚：文件变更快照与恢复（atomic rollbacks）。

这些是执行面 hygiene，不构成组织治理账本。

---

## 3. 它没有什么

| 我们需要的 | nono | 判定 |
| --- | --- | --- |
| **通用准入链** Trigger→Eval→Mandate | 无；它假设「某个 agent 已经在跑」，只管工具边界 | ❌ |
| **任务域信封**（一任务一域、用完即焚、移交包） | 隔离单元是命令沙箱；session 可长期存在；无移交包实体 | ❌ 粒度错位 |
| **组织级治理**（租户编排存储、对账三态、冻结、知识生产线） | 无 | ❌ |
| **Router/Worker/Watchdog 异构编排** | 无 | ❌ |
| **BOS 制度事实对接** | 无 | ❌ |

---

## 4. 与企业级设计的对照

### 4.1 可以借鉴

1. **凭据代理边界**：真密钥留在 proxy/keystore，agent 只拿 localhost 路由——可直接对照架构 §7.5，并与 OpenSandbox Credential Vault、OpenMausBot broker 并列作「密钥出进程」先例。
2. **每工具最小权限 + 链式授权图**：`can_use`/`from` 的「谁可再调用谁」比粗粒度 Full Access 更接近 Mandate≠无限工具权限。
3. **策略外置、agent 不可改**：与「制度事实不进 agent 上下文」同向（虽非 BOS）。
4. **审计 + 回滚**：执行侧可恢复痕迹，可作移交包「日志摘要」的工程启发（不是移交包本身）。
5. **无特权部署面**：单二进制、可嵌 K8s/CI——适合将来落在执行节点旁路，而不是中心巨石。

### 4.2 不可借 / 必须纠偏

- **不要把「工具沙箱」说成「任务域」**：任务域是信封（工作目录+凭据+egress+生命周期）；nono 是信封内的工具门禁。
- **不要因 README 列出 OpenClaw/Hermes 就把它们升为主推底座**：nono 是宿主无关壳；我们的硬排除不变。
- **不要指望它填空位①③**：它明确不碰开票权与组织账本。
- **不要把 session 级 profile 当租户隔离**：多租户仍须我们的编排存储 + 任务域纪律。

---

## 5. 结论与建议动作

1. **定位**：空位②基建层的 **工具级安全原语**；在 `enterprise-superagent-borrowable-oss-survey.md` 中保持「部分填空（粒度错位）」判断。
2. **建议动作**：
   - 精读 `docs/cli/features/tool-sandbox.mdx` + `credential-injection.mdx`，抽取「代理注入 + 命令策略图」到任务域设计备忘；
   - 与 OpenSandbox/Cube 的域级 vault 对照表：域级销毁 vs 工具级 ephemeral；
   - **不** fork nono 当控制平面；若执行节点需要本地工具门禁，再评估嵌入 CLI/FFI。
3. **三空位**：①无 ②部分（原语）③无。

---

## 6. 引用

- README.md；docs/cli/features/{tool-sandbox,credential-injection,networking,trust,audit,atomic-rollbacks}.mdx
- crates/{nono,nono-cli,nono-proxy}/
- 对照：`docs/drafts/enterprise-superagent-architecture.md` §4.5 / §7.4–7.5；`enterprise-superagent-borrowable-oss-survey.md` §3.2
