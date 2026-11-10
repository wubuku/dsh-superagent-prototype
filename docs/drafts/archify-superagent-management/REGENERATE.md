# 重新生成「管理层版」explainer

本目录是给公司管理层与一般客户看的 explainer（`superagent-management.html`）。命令在仓库根目录执行。

## 生成与检查

```bash
node ~/.agents/skills/archify/bin/archify.mjs finalize explainer \
  docs/drafts/archify-superagent-management/candidate.archify.md \
  docs/drafts/archify-superagent-management/superagent-management.html \
  --repo-root . --quality showcase --json \
  --out-dir docs/drafts/archify-superagent-management/review-<编号>

node docs/drafts/archify-superagent-management/tools/apply-edge-contrast.mjs   # 补丁（勿跳过）
node docs/drafts/archify-superagent-management/tools/check-contrast.mjs        # 对比度

node ~/.agents/skills/archify/bin/archify.mjs browser-check \
  docs/drafts/archify-superagent-management/superagent-management.html \
  --require-provenance --json --out-dir docs/drafts/archify-superagent-management/review-<编号>

node ~/.agents/skills/archify/bin/archify.mjs visual-check \
  docs/drafts/archify-superagent-management/superagent-management.html \
  --require-provenance --json \
  --out-dir docs/drafts/archify-superagent-management/visual-check-<编号>
```

## 常见坑（本轮实测）

- **`@meta` 必须带 `repo_revision=<HEAD sha>`**，否则 finalize 直接 fail。
- **workflow 图不要用泳道（lane）**：3 条泳道会把流程折成 3 行、高度 1368px，缩放后文字 9.39px 不过 browser-check。单行分支流程（979×280）即可。
- `--meta repo_revision` 每次重新生成前确认是最新 HEAD（先 `git rev-parse HEAD` 再写进 candidate）。
- 改文案后重跑 finalize 会重算 artifact sha；**必须再跑 apply-edge-contrast**（它会把 sha 回写 receipt），否则 provenance mismatch。

## 诚实纪律

- BOS 是大型 PoC、尚未建成企业版；知识库已在生产使用；调度中心与信任层是新工程（「现状说实话」面板）。
- 「AI 交活必附副作用清单，没有清单不认完成」——这句不能弱化。
