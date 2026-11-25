# 本仓库约定

## 术语纪律（最高优先级）

`docs/drafts/enterprise-superagent-architecture.md` §0.4 术语速览 + §0.6 外来词映射表是**唯一真源**。

- 写任何文档、图表、代码、注释、schema 字段、测试名之前，**先查表**。
- 从外部系统（原型、BOS、A2A、UHP、Herdr、客户材料）引入概念时**必须换名**并登记进 §0.6；不得沿用来源系统的名字。
- 一词一义、一义一词；发现不一致时**改称呼，不改定义**。
- 已登记的坑：原型 `Thread`（`${source}:${id}`）是**来源轨道**，不是本项目的 thread；不存在「Case 服务」；A2A 的 `Task` 不得冒充本项目 Ticket。

## 文档写作约定

- 中文；面向冷读者，术语首次出现给一句话解释。
- **TL;DR 先行**：每份文档、文档中每个大节的讨论段，先给一段加粗的 TL;DR 总结（结论 + 关键理由），再做必要展开——不绕来绕去；展开部分每段首句也给该段结论。
- 结论性表述必须有出处（代码路径、文档章节、实测数据）；没有核查过的话不写成「肯定」。
- 跨仓库引用用相对路径（BOS 仓库：`../../../../wubuku/AI-Native-Business-Operating-System/docs/drafts/`）。

## 调研报告入口

- `docs/drafts/README.md` 是 `docs/drafts/` 的 agent 阅读入口；新增草稿应在那里登记。
- 涉及 WorkBuddy 桌面 app、内置 CLI、CodeBuddy CLI、ACP、session resume/fork、TUI、`~/.workbuddy` 与 `~/.codebuddy` 的问题，先读 `../../../../wubuku/enterprise-superagent/docs/drafts/workbuddy-codebuddy-cli-deep-research-report.md`（2026-11-24 本机实测 + 官方文档交叉验证；**2026-11-25 自本仓 `57d2729` 迁入 `enterprise-superagent`，后续只更新该副本**——本仓同名文件只留占位注解）。

## 仓库边界

- 本仓库是 **public**：客户材料、pitch、内部商务信息一律**不提交**到这里（放 BOS 私有仓库）。
- 提交信息结尾：`Co-Authored-By: Claude Code <noreply@anthropic.com>`
