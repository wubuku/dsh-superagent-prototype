# 重新生成这份 explainer

本目录包含一个本地 CSS 补丁，用来把 light 主题下的边与箭头 token 提到 WCAG 4.5:1。它不修改 archify renderer 或技能本体。以下命令在仓库根目录执行。

## 第 1 步：生成

```bash
node ~/.agents/skills/archify/bin/archify.mjs finalize explainer \
  docs/drafts/archify-enterprise-superagent/candidate.archify.md \
  docs/drafts/archify-enterprise-superagent/enterprise-superagent.html \
  --repo-root . --quality showcase --json \
  --out-dir docs/drafts/archify-enterprise-superagent/review-<编号>
```

## 第 2 步：应用本地 CSS 补丁

```bash
node docs/drafts/archify-enterprise-superagent/tools/apply-edge-contrast.mjs
```

该脚本会：

- 读取 `patches/edge-contrast.css`；
- 把它以内联 `<style data-archify-patch="edge-contrast">` 注入 `enterprise-superagent.html`（先移除旧补丁块，可重复执行）；
- 同步 `enterprise-superagent.delivery.json` 的 `artifact.sha256` 与 `bytes`，避免 provenance mismatch。

**不要跳过这一步。** 漏掉第 2 步会退回 renderer 默认的 light 主题描边，其中 `--arrow` 4.36:1、`--arrow-emphasis` 3.45:1、`--security-stroke` 4.31:1，均低于 4.5:1；而 `browser-check` 与 `visual-check` 仍会通过，因为它们不测前景 / 背景对比度。

补丁块锚定在 `</body></html>` 上。不要改成只锚 `</body>`——页面里有一个内联脚本字符串也含 `</body>`，替换到那里会让页面在运行时报 `SyntaxError`。

## 第 3 步：检查并核对 artifact

```bash
node docs/drafts/archify-enterprise-superagent/tools/check-contrast.mjs

node ~/.agents/skills/archify/bin/archify.mjs browser-check \
  docs/drafts/archify-enterprise-superagent/enterprise-superagent.html \
  --require-provenance --json \
  --out-dir docs/drafts/archify-enterprise-superagent/review-<编号>

node ~/.agents/skills/archify/bin/archify.mjs visual-check \
  docs/drafts/archify-enterprise-superagent/enterprise-superagent.html \
  --require-provenance --json \
  --out-dir docs/drafts/archify-enterprise-superagent/visual-check-<编号>

node -e '
const fs = require("node:fs"), crypto = require("node:crypto");
const dir = "docs/drafts/archify-enterprise-superagent/";
const actual = crypto.createHash("sha256").update(fs.readFileSync(dir + "enterprise-superagent.html")).digest("hex");
const receipt = JSON.parse(fs.readFileSync(dir + "enterprise-superagent.delivery.json", "utf8"));
console.log(actual === receipt.artifact.sha256 ? "artifact sha: PASS" : "artifact sha: FAIL");
'
```

`check-contrast.mjs` 的取值方式与局限：它读取各 diagram 预览层的 CSS token 声明，按 last-wins 取值，再按 WCAG 2.x 相对亮度公式计算，阈值 4.5:1；它**不测渲染后的抗锯齿像素或局部面板底色**，也不测装饰性描边（`panel-border`、`grid`、`canvas-dot`），因为它们不承载信息。这个脚本的目的，是补上「只测字号导致低对比度仍为绿」的缺口。

## 事实来源

这份 explainer 的事实来源是 `docs/drafts/enterprise-superagent-architecture.md` 的设计决策，不是实现代码。`@answer scope` 与每个 `@source` 都指向该文档的章节行号；页面自称「设计基线 · 决策核对 · 尚未实现」。若该文档改动，需要重新核对 `candidate.archify.md` 里的 `lines=` 区间。
