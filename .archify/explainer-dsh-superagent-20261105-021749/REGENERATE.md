# 重新生成这份 explainer

本目录包含一个本地 CSS 补丁，用来提高生命周期图里虚线的对比度。它不修改 archify renderer 或技能本体。以下命令在仓库根目录执行。

## 第 1 步：生成

```bash
node ~/.agents/skills/archify/bin/archify.mjs finalize explainer \
  .archify/explainer-dsh-superagent-20261105-021749/candidate.archify.md \
  .archify/explainer-dsh-superagent-20261105-021749/dsh-superagent.html \
  --repo-root . --quality showcase --json \
  --out-dir .archify/explainer-dsh-superagent-20261105-021749/review-<编号>
```

## 第 2 步：应用本地 CSS 补丁

```bash
node .archify/explainer-dsh-superagent-20261105-021749/tools/apply-lifecycle-contrast.mjs
```

该脚本会：

- 读取 `patches/lifecycle-contrast.css`；
- 把它以内联 `<style data-archify-patch="lifecycle-contrast">` 注入 `dsh-superagent.html`（先移除旧补丁块，可重复执行）；
- 同步 `dsh-superagent.delivery.json` 的 `artifact.sha256` 与 `bytes`，避免 provenance mismatch。

**不要跳过这一步。** 漏掉第 2 步会退回 renderer 默认的低对比度虚线（light ≈ 1.32:1，dark ≈ 1.74:1），而 `browser-check` / `visual-check` 仍会通过，因为它们不测前景/背景对比度。

## 第 3 步：检查并核对 artifact

```bash
node .archify/explainer-dsh-superagent-20261105-021749/tools/check-contrast.mjs

node ~/.agents/skills/archify/bin/archify.mjs browser-check \
  .archify/explainer-dsh-superagent-20261105-021749/dsh-superagent.html \
  --require-provenance --json \
  --out-dir .archify/explainer-dsh-superagent-20261105-021749/review-<编号>/browser-check

node ~/.agents/skills/archify/bin/archify.mjs visual-check \
  .archify/explainer-dsh-superagent-20261105-021749/dsh-superagent.html \
  --require-provenance --json \
  --out-dir .archify/explainer-dsh-superagent-20261105-021749/visual-check-round-<编号>

shasum -a 256 .archify/explainer-dsh-superagent-20261105-021749/dsh-superagent.html

node -e '
const fs = require("node:fs");
const crypto = require("node:crypto");
const dir = ".archify/explainer-dsh-superagent-20261105-021749/";
const actual = crypto.createHash("sha256").update(fs.readFileSync(dir + "dsh-superagent.html")).digest("hex");
const receipt = JSON.parse(fs.readFileSync(dir + "dsh-superagent.delivery.json", "utf8"));
console.log(actual === receipt.artifact.sha256 ? "artifact sha: PASS" : "artifact sha: FAIL");
'
```

`check-contrast.mjs` 的取值方式与局限：它读取补丁里的 CSS token 和生命周期预览的 `--bg` 声明，按 WCAG 2.x 相对亮度公式计算，阈值 4.5:1；它**不测渲染后的抗锯齿像素或局部面板底色**，`browser-check` 目前也没有对比度检查。这个脚本的目的，是把“只测字号导致低对比度仍为绿”的缺口补上。
