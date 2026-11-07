# dori-superagent 深度调研报告（脚注级）

对象：sisyphuslabs/dori-superagent。  
远端：`https://github.com/sisyphuslabs/dori-superagent`（~191 ★，MIT）。  
基线：HEAD `e15c01d20785`（2026-11-07 前后）。调研方式：README 对照表 + `src/harness.ts` / `store.ts` / `loop.ts`。关键断言附 [文档] / [代码]。

> **定位**：与 DSH 原型**同构对照**的又一份主动式 coding harness；**脚注级**，**不升主参照**。完整结构仍按深查体例书写，篇幅收敛。

## 0. 一句话结论

dori 用约 1.6k 行 TypeScript（Bun）在 herdr + omo 上实现 **Lead / Lane / Duty / merge gate / inbox 批处理 / hourly loop**：与 DeepSeek dsh-superagent-prototype 的 Router/Worker/Watchdog/Trigger 批处理在结构上一一对应，并多了证据化 READY 与 PR merge gate。它验证「三角色 + 忙时收件箱 + 值班升级」可在极小代码量落地，但绑定个人 coding 终端拓扑，**无企业租户、无通用 Eval/Mandate、无任务域焚毁**。

**判定：主动式角色切分的脚注对照；三空位皆无；勿升主参照。**

---

## 1. 系统一览

| 项 | 内容 |
| --- | --- |
| 形态 | CLI harness + prompts；状态 JSON 于 `~/.dori` |
| 运行时依赖 | Bun；herdr（窗格/agent 状态）；omo（coding agent）；`gh`（PR/检查/合并） |
| 角色 | Lead（唯一对人对话）；Lane（一任务一会话一 tab）；Duty loop（刷收件箱/催促/升级/丢失） |
| 许可 | MIT |
| 自述 | [文档] README「What this is not」：最小实验，非生产全栈（无跨机 mesh、无重型调度、无完整聊天桥） |

---

## 2. 它做到了什么（实证）

### 2.1 与 DSH 的显式同构

README 给出映射表：[文档]「Mapping to DeepSeek's super-agent」。

| DSH | dori | 代码 |
| --- | --- | --- |
| Router | Lead | `prompts/lead.md`；`up()` in `cli.ts` |
| Worker / 每票一会话 | Lane | `startLane()` in `harness.ts` |
| Ticket + Mandate | brief 文件 + lane footer；READY 必须带 evidence | `ready()` |
| Trigger 批处理 | pane inbox：忙则排队，idle 一次刷出 | `send` / `flushInbox` |
| Watchdog | Duty：10/20 分催促，40 分升级，pane 消失 → LOST | `dutyTick`；`NUDGE_MINUTES=[10,20,40]` |
| Admission / maxWorkers | hourly loop 预算 `--max-lanes` / `--max-starts` | `loop.ts` |

### 2.2 证据化完工与 merge gate（DSH 原型所无、dori 加强）

- `ready()`：无 evidence 或无最终文本 → `Refusal`；写入 `lane.final`。[代码] `harness.ts` `ready()`。
- `done()`：非 `ready` 状态拒绝关闭。[代码] 同文件。
- `mergeGate()`：要求该 head SHA 上 `CLEAR` receipt + `gh pr checks` 非空且存在 pass、无红灯；空检查列表显式拒绝「never green」。[代码] `mergeGate` / `gateRefusal`。

### 2.3 Duty 与投递纪律

- Kill switch：`duty stop` 后只打印 stopped，不 flush/nudge。[代码] `dutyTick` 头部。
- 投递歧义不重发；`[DELIVERY-AMBIGUOUS]`；inbox lock 防双刷。[文档] README「What the harness enforces」；[代码] store lock 叙述。

### 2.4 测试密度（相对其体量）

- 76 harness 测试（含 merge gate 全分支、duty、loop）；不调模型。[文档] README Tests。

---

## 3. 它没有什么

| 本设计概念 | dori | 判定 |
| --- | --- | --- |
| 通用 Trigger→Eval→Mandate | 人在 chat 下任务 / backlog；brief ≠ Mandate；无 BOS | ❌ |
| 任务域焚毁 | herdr tab + 工作区；关 pane ≠ 焚毁执行域 | ❌ |
| 组织治理 / 多租户 | 单机 `~/.dori` | ❌ |
| 异构厂商 agent 进程隔离 | 依赖 omo/herdr 同生态 | ❌ |
| 企业通道（只出站节点、C 类账本） | 本地窗格 IPC 级别 | ❌ |

---

## 4. 可借 / 不可借

### 4.1 可借（小而锋利）

1. **角色提示词分文件 + 单声道规则**：只有 Lead 对人对话——产品规则可抄到 Router 提示词纪律。[文档] prompts 叙述。
2. **BUSY 收件箱批处理**：对应「事件批到下一 turn」的可运行实现，作 DSH Trigger 批处理的对照。[代码] inbox。
3. **值班时间表常量**：`[10,20,40]` 催促/升级——Watchdog 策略参数化示例。[代码] `NUDGE_MINUTES`。
4. **READY 强制证据 + merge gate**：验收门形状；企业侧应升格为治理账本上的验收记录，而非仅本地 receipt 文件。[代码] `ready` / `mergeGate`。
5. **hourly loop 预算与主机负载门**：admission 外形的微实现。[代码] `loop.ts`。

### 4.2 不可借

- 升为架构主参照或替代本仓库 DSH 原型深挖。
- 把 brief 文件叫成 Mandate。
- 复制 herdr/omo 绑定当企业执行面。

---

## 5. 建议

1. **材料库**：附在 DSH 原型条目下作「同构第二样本」脚注；审计时间boxed（读 README 映射表 + `harness.ts` duty/ready/merge 三段即可）。
2. **比较句式**：写设计文档时可用「dori 证明最小三角色可运行；企业增量在 Eval/Mandate/租户/焚毁」。
3. **三空位不变**。

---

## 6. 引用

- [文档] `README.md`（结构表、philosophy 表、mapping 表、enforces、tests）
- [代码] `src/{harness.ts,cli.ts,store.ts,loop.ts,herdr.ts}`；`prompts/{lead,duty,lane-footer,nudge,review}.md`
- 坐标系：入口综述 / borrowable survey「dori 脚注」；本仓库 DSH 原型为主参照
