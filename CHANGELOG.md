# 更新日志

本文件记录本项目的重要变更，格式参考
[Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循
[语义化版本](https://semver.org/lang/zh-CN/)。

项目仍处于 `0.0.x` 实验阶段，次版本号未稳定前，补丁版本之间也可能出现行为变化。

## [Unreleased]

### Added

- `progressSurface`（`DSH_LARK_PROGRESS_SURFACE`）：选择思维链形态。`cot`（默认）使用
  飞书原生思维链，与 Web 侧呈现一致；`card` 在 CardKit 卡片内展示执行过程。属于展示类
  设置，修改后立即用于新 Turn，不重建运行时。
- CI 门禁扩展为 Node 22、24、26 三个版本的矩阵，覆盖率表写入运行摘要，并把打好的
  tarball 作为 artifact 上传。
- `npm run check:repo`：校验 bundle patch、README 与 `.env.example` 的环境变量三方
  一致，版本号与 `@deepseek-ai/dsh` rc 一致，`.nvmrc`、`engines.node` 与 CI matrix
  一致，README 源码结构与实际目录一致。
- `npm run check:package`：打出真实 tarball 并校验入口齐全、模块闭包完整、运行时不
  引用未声明的依赖、不泄漏源码与密钥，然后实际 import 插件入口并运行一次 `doctor`。
  两项检查都已并入 `npm run verify`。
- 标签触发的发布工作流：复用 CI 门禁，校验标签与 `package.json` 版本一致，从
  `CHANGELOG.md` 取出发布说明，带 provenance 发布到 npm 并创建 GitHub Release。
- 每周执行的 `npm audit` 与 CodeQL 工作流，以及 Dependabot 依赖更新配置。
- bundle patch 的 `inject` 与插件声明的必需 seam 现在由测试锁定。

### Changed

- 思维链默认改用飞书原生 COT，CardKit 卡片作为回退；新建话题的第一个 Turn 仍使用卡片，
  因为 COT 无法创建它要附着的话题。
- COT 与卡片改为读取同一份 Turn 进度投影（`src/progress/turn-progress.ts`），两个表面的
  工具标题、耗时与成败判定不再互相偏离。
- 源码与测试按模块目录组织（`bridge/`、`card/`、`dsh/`、`html/`、`lark/`、`progress/`、
  `settings/`、`standalone/`），`package.json` 的 `files` 相应改为按目录发布。
- 测试改为递归发现 `tests/**/*.test.ts`（`scripts/run-tests.mjs`），不再受两层 glob
  限制；`npm run pack:check` 由 `npm run check:package` 取代。
- 移除 `docs/` 目录；设计决策记录不再随仓库维护，历史内容可在 git 历史中查阅。
- 补齐开源项目根目录文件：`CONTRIBUTING.md`、`CODE_OF_CONDUCT.md`、`SECURITY.md`、
  `CHANGELOG.md`、`.env.example`、`.editorconfig`、`.nvmrc`。

### Fixed

- COT 事件读取补上嵌在 `message.content[]` 中的 `tool/result` 调用 id，工具不再一直显示
  为执行中；Turn 结束时会关闭仍打开的工具。
- 卡片层与 COT 层不再因一次打开失败就在本进程内停用，连续三次失败才停用；创建成功但
  启动失败的 COT 会被正常结束，不再停留在加载态。
- COT 写入：一批失败不再丢弃排在其后的批次，只对可重试的失败重试，积压有上限并在
  `flush()` 时报告。
- 只运行了工具、没有正文的 Turn 回退为状态文案：飞书拒绝空的 post 正文，此前会把已完成
  的 Turn 变成失败。
- Web 镜像：轮询失败按话题退避，反复失败的单个事件在三次尝试后放弃并推进游标，其后的
  事件不再被永久阻塞；进度渲染与提问清理的失败不再拖垮整个 Turn。
- 发布包补上 `dist/src/client.d.ts`：`exports["./client"]` 声明的类型入口此前不在
  `files` 中，安装后无法解析。

## [0.0.10] - 2026-08-19

### Added

- 可配置的执行过程展示：工具详情档位、布局、思维图标、条目上限，以及完成后是否
  折叠（`DSH_LARK_TOOL_DETAIL_MODE`、`DSH_LARK_PROGRESS_STYLE`、
  `DSH_LARK_THINKING_ICON`、`DSH_LARK_MAX_PROGRESS_ITEMS`、
  `DSH_LARK_COLLAPSE_PROGRESS_ON_FINISH`）。
- 设置热重载：展示与流式参数立即用于新 Turn，连接与路由等结构参数会优雅重建运行时，
  均无需重启 Web Host。

### Fixed

- 渲染前统一规范化展示视图，并对终端命令做脱敏。
- 运行时释放完成前保留旧的结构化快照，避免重载期间状态错乱。
- 生命周期失败后恢复重载队列。
- 历史视图只接受规范化的 `ToolEventView` 契约，丢弃事件内嵌的展示数据。

## [0.0.9] - 2026-08-19

### Added

- 交互式回复能力：CardKit 流式卡片、飞书原生 COT、HTML 报告、Session 事件推送流，
  以及 `AskUserQuestion` 的卡片问答（含自定义输入）。
- `DSH_LARK_TURN_TIMEOUT_MS` 配置项。

### Changed

- Turn 超时改为可选：默认等待真实的 `turn/end` 或关闭信号，`0` 表示不超时（此前为
  固定 5 分钟后失败）。
- CardKit 回复与 post 降级都保持在同一个飞书话题内；Web 侧 COT 与 replyMode 对齐；
  Turn 完成后折叠执行过程。
- 移除过时的 Agent preset：新建飞书 Session 继承 DSH 当前默认 Agent 配置。
- 设置与运行时集成对齐 `@deepseek-ai/dsh@0.1.0-rc.7`。

### Fixed

- 已回答的提问会被清理，长的交叉流式内容不再被截断。

## [0.0.8] - 2026-08-18

### Added

- 飞书与 Web 双向消息同步：Web 侧输入与最终回复同步回原飞书话题，完成用户 OAuth
  授权后以本人身份发送，未授权时降级为引用格式。

### Changed

- 移除 ByteDance 内部 registry 的安装说明，改为从源码构建 tarball 安装。

## 0.0.7 及更早

首次开源发布及其修订，未维护变更记录，详见 git 历史。

[Unreleased]: https://github.com/Kinasha/dsh-lark-bridge/compare/v0.0.10...HEAD
[0.0.10]: https://github.com/Kinasha/dsh-lark-bridge/compare/v0.0.9...v0.0.10
[0.0.9]: https://github.com/Kinasha/dsh-lark-bridge/compare/v0.0.8...v0.0.9
[0.0.8]: https://github.com/Kinasha/dsh-lark-bridge/releases/tag/v0.0.8
