# 贡献指南

感谢你愿意为 `@open-aiden/dsh-lark-bridge` 出一份力。本文说明本地开发、测试与提交
改动的方式。参与前请先阅读[行为准则](CODE_OF_CONDUCT.md)。

## 开发环境

- Node.js >= 22（仓库根目录的 `.nvmrc` 已固定版本，可用 `nvm use` 切换）
- npm（仓库提交 `package-lock.json`，请使用 `npm ci` 而不是 `npm install`）
- 运行测试不需要真实的飞书 App Secret 或 DSH 部署；测试使用假的飞书与 DSH 边界。

```bash
git clone https://github.com/Kinasha/dsh-lark-bridge.git
cd dsh-lark-bridge
npm ci
npm run build
```

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `npm run build` | TypeScript 编译 + 打包 Web 设置界面 |
| `npm run typecheck` | 只做类型检查，不产出文件 |
| `npm test` | 运行 `tests/` 下的行为测试 |
| `npm run coverage` | 带覆盖率门槛的测试（行 80%、分支 70%、函数 70%） |
| `npm run check:repo` | 跨文件一致性：环境变量、版本号、Node 版本、README 源码结构 |
| `npm run check:package` | 打出真实 tarball 并校验内容、依赖闭包与可加载性 |
| `npm run verify` | 上述检查的组合，**提交 PR 前必须通过** |

在真实飞书应用上手动验证时，参考 [README](README.md) 的“准备飞书应用”和
“从飞书验证”两节，并使用本地 profile：

```bash
npm run doctor
npm run web
```

## 源码与测试布局

`src/` 按职责分目录（`bridge/`、`dsh/`、`lark/`、`card/`、`html/`、`progress/`、
`settings/`、`standalone/`），完整说明见 [README 的“源码结构”](README.md#源码结构)。

`tests/` 与 `src/` 一一对应：`src/card/stream.ts` 的测试位于
`tests/card/stream.test.ts`，`src/plugin.ts` 等根模块的测试留在 `tests/` 根目录。
测试脚本递归发现 `tests/` 下的全部 `*.test.ts`（见 `scripts/run-tests.mjs`），
新增子目录不需要改动脚本。

领域名词（Message、Topic、Session、Turn、Admission、Reply Channel 等）的定义见
[CONTEXT.md](CONTEXT.md)。改动涉及这些概念时，请同步更新该文件。

## 持续集成

每个 PR 都会在 GitHub Actions 上运行：

- **CI**（`.github/workflows/ci.yml`）：Node 22、24、26 各跑一遍 `npm ci` →
  `typecheck` → `test` → `coverage` → `check:repo` → `check:package`，与本地
  `npm run verify` 是同一组命令。Node 22 的任务另外把覆盖率表写进运行摘要，并把
  打好的 tarball 作为 artifact 上传，方便直接安装验证。
- **Security**（`.github/workflows/security.yml`）：`npm audit --audit-level=high`
  与 CodeQL（`security-extended`），每周一还会定时重跑一次，捕捉与代码改动无关的
  新公告。
- **Dependabot**（`.github/dependabot.yml`）：每周检查 npm 与 GitHub Actions 依赖。
  `@deepseek-ai/dsh*` 被排除在外——它们必须与同一个 DSH release 对齐，升级是一次
  刻意的改动，不是依赖 bump。

CI 失败时先在本地复现：除 audit 与 CodeQL 外，其余检查 `npm run verify` 全部覆盖。

## 提交改动

1. 从 `main` 切出分支。
2. 保持改动聚焦：一个 PR 只做一件事。
3. 行为变化必须附带对应的测试。
4. 用户可见的行为、配置项或权限要求发生变化时，同步更新 `README.md`
   （必要时更新 `.env.example` 和 `CONTEXT.md`）。
5. 本地跑通 `npm run verify`。
6. 在 PR 描述中说明动机、做法，以及你如何验证。

### 提交信息

使用 [Conventional Commits](https://www.conventionalcommits.org/)，与现有历史保持
一致：

```text
feat(lark): add configurable progress and hot reload
fix(bridge): make turn timeout opt-in
chore: merge upstream main
```

常用 scope：`lark`、`bridge`、`card`、`dsh`、`settings`、`html`。

### 不要提交的内容

- `.env`、App Secret、用户 OAuth Token、DSH 凭证等任何密钥
- `dist/`、`node_modules/`、`*.tgz` 等构建产物（已在 `.gitignore` 中）
- 含真实 open ID、聊天内容或内部地址的日志与截图

发现密钥已被提交时，**先轮换密钥**，再处理仓库历史。

## 报告问题

- Bug 与需求：[GitHub Issues](https://github.com/Kinasha/dsh-lark-bridge/issues)。
  请附上复现步骤、期望行为、实际行为，以及脱敏后的日志。
- 安全漏洞：**不要**提交公开 issue，按 [SECURITY.md](SECURITY.md) 私下报告。

## 发布（仅维护者）

发布由标签触发，本地不执行 `npm publish`：

```bash
npm run verify
# 把 CHANGELOG.md 的 Unreleased 内容归入新版本小节
npm version <patch|minor|major>
git push --follow-tags
```

推送标签后 `.github/workflows/release.yml` 依次完成：复用 CI 门禁 → 校验标签与
`package.json` 版本一致 → 从 `CHANGELOG.md` 取出该版本小节作为发布说明 → 带
provenance 执行 `npm publish --access public` → 创建 GitHub Release 并附上 tarball。

发布需要仓库配置 `NPM_TOKEN`（npm automation token）。只想验证流程时，用
workflow_dispatch 手动触发并保留 `dry_run` 勾选，它只打包不发布。

`package.json` 的 `files` 漏掉新增的运行时目录，或 `CHANGELOG.md` 缺少该版本小节，
都会在门禁阶段失败，不会发布出去。
