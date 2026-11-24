# docs/drafts 阅读入口

**TL;DR：agent 先读本页。若问题涉及 WorkBuddy 桌面 app、内置 CLI、CodeBuddy CLI、ACP、session resume/fork、TUI 或 `~/.workbuddy` vs `~/.codebuddy`，直接读 [WorkBuddy / CodeBuddy CLI 深度调研报告](workbuddy-codebuddy-cli-deep-research-report.md)；本目录其余多数文档是已迁移到 `enterprise-superagent` 仓库的历史快照。**

## 1. 先读这里

| 场景 | 先读文档 | 说明 |
|---|---|---|
| WorkBuddy / CodeBuddy / CLI / ACP / session 接续 / TUI | [`workbuddy-codebuddy-cli-deep-research-report.md`](workbuddy-codebuddy-cli-deep-research-report.md) | 2026-11-24 本机实测 + 官方文档交叉验证；含四个接续方向判定与控制实验 |
| 仓库写作纪律、术语纪律 | [`../../CLAUDE.md`](../../CLAUDE.md) | 术语与写作约定，优先级高于本目录单篇文档 |
| 本项目架构真源 | [`enterprise-superagent-architecture.md`](enterprise-superagent-architecture.md) §0.4 / §0.6 | 术语唯一真源；**该文件已标记迁移，只作历史快照** |

## 2. 本目录性质

- 这里保存的是调研草稿、历史快照、架构演进材料和 explainer 产物。
- 2026-11-22 起，多数架构/调研文档已迁入 `wubuku/enterprise-superagent` 仓库；文件顶部通常有“已迁移”标记，**不要在这些快照上继续更新**。
- 新增调研若需要被后续 agent 稳定发现，请遵循以下约定：
  1. 文件名使用 `*-deep-research-report.md` 或明确的产品关键词；
  2. 文首给 `TL;DR`、日期、状态与关键词；
  3. 在本页“先读这里”表中加一行入口；
  4. 必要时在 `../../CLAUDE.md` 增加一句指针。

## 3. 可发现性关键词

`WorkBuddy 内置 CLI` · `CodeBuddy CLI` · `codebuddy-lite-wb` · `ACP` · `session resume` · `session fork` · `TUI` · `~/.workbuddy` · `~/.codebuddy` · `enterprise-superagent` · `byomd` · `archify`
