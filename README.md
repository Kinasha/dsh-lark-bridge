# @open-aiden/dsh-lark-bridge

[![License: MIT](https://img.shields.io/badge/license-MIT-green?style=flat-square)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-339933?style=flat-square&logo=nodedotjs)](package.json)

把飞书机器人接入本地运行的 DeepSeek Harness（DSH）。插件直接使用飞书 Node SDK
建立长连接、接收消息和发送回复，不要求安装或初始化 `lark-cli`。

如果本地 DSH 已经可以正常调用模型，飞书侧只需要配置两个环境变量：

```bash
export LARK_APP_ID=cli_xxx
export LARK_APP_SECRET=xxx
```

```text
飞书私聊 -> dsh-lark-bridge -> DSH Session <-> DSH Web UI
     ^                              |
     +------ 飞书回复 / Web 同步 ----+
```

## 你会得到什么

- 默认把机器人对一条私聊消息的首次回复创建为飞书话题，并在话题下继续回复。
- 收到消息后先添加 `Get` 表情作为处理回执；COT 消息创建成功后自动移除。
- 在飞书原生 COT 消息中实时展示安全的分析状态和工具调用进度，最终答案仍回复在同一话题下。
- 每个飞书话题对应一个稳定的 DSH Session；同一私聊中的不同话题相互隔离。
- 飞书 Session 和浏览器 Session 使用同一个 DSH Host；Web UI 可以看到完整对话、
  推理过程、工具调用和最终回复。
- 在 Web UI 中继续飞书 Session 时，Web 用户消息和最终回复会同步显示在原飞书话题中；
  完成用户授权后，Web 输入以本人飞书身份发送；未授权或授权失效时自动降级为
  “【来自用户在 Web 上的输入】”引用消息。飞书入站轮次不会重复显示。
- 最终回复使用飞书原生 CommonMark/GFM 富文本展示表格、任务列表和代码块；常见
  Mermaid 流程图、时序图、状态图、类图、ER 图和 XY 图会在本地渲染为 PNG 并
  嵌入飞书富文本，不支持的类型或图片上传失败时保留文本预览或源码。
- 新建飞书 Session 继承 DSH 当前的默认 Agent 配置，不再安装或强制选择额外 preset。
- 插件负责飞书鉴权、WebSocket 自动重连、事件规范化、幂等回复和优雅退出。
- COT 不包含模型隐藏推理、工具参数或文件内容；COT/表情接口不可用时会降级为普通文本回复。

当前 `0.0.8` 兼容 `@deepseek-ai/dsh@0.1.0-rc.7`。DSH 仍处于 developer
preview，升级 DSH 后请重新执行本文的验证步骤。

## 1. 准备飞书应用

在飞书开放平台创建企业自建应用，然后完成以下配置：

1. 开启机器人能力。
2. 为应用开通 `im:message.p2p_msg:readonly`、
   `im:message.group_at_msg:readonly`、`im:message:send_as_bot`、`im:resource`，以及
   添加和删除消息表情回复所需的权限。
   若要让 Web 输入显示为用户本人，还需开通 `im:message` 和
   `im:message.send_as_user`。插件在用户 OAuth 时还会申请 `offline_access`，用于
   自动刷新用户访问凭证。

   以下为可选能力所需的额外权限，未开通时插件自动降级、不会失败：

   | 能力 | 权限 | 未开通时的行为 |
   | --- | --- | --- |
   | 流式卡片回复（`replyMode=card`） | `cardkit:card:write` | 回退到 COT 或 post 回复 |
   | 读取用户发送的图片 | `im:message`、`im:message:readonly` 或 `im:message.history:readonly` | 图片被忽略，正文照常处理 |
   | 表情指令（如 ❌ 中断） | `im:message.reactions:read` | 表情事件不触发任何操作 |

3. 在事件订阅中选择“使用长连接接收事件”，订阅
   `im.message.receive_v1`。按需再订阅
   `im.message.reaction.created_v1`（表情指令）与
   `application.bot.menu_v6`（机器人菜单，仅单聊）。卡片按钮回调
   `card.action.trigger` 走同一条长连接，无需公网 webhook，也不需要额外权限。
4. 发布应用版本，并确保当前测试用户可以使用该应用。

用户身份授权还要求在“安全设置”中添加重定向 URL。默认 Web 端口下为：

```text
http://127.0.0.1:3080/dsh-lark/auth/callback
```

如果 Web Host 使用其他端口，通过 `DSH_LARK_USER_AUTH_REDIRECT_URI` 显式指定，并在
飞书开放平台登记完全一致的地址。

从应用的“凭证与基础信息”页面取得 App ID 和 App Secret。不要把 App Secret
提交到仓库。

## 2. 安装插件

### 从源码安装

公开仓库用户可以构建本地 tarball，再把它安装到 DSH 的 `web` profile：

```bash
git clone https://github.com/Kinasha/dsh-lark-bridge.git
cd dsh-lark-bridge
npm ci
npm pack
dsh plugin --profile web add ./open-aiden-dsh-lark-bridge-0.0.8.tgz \
  --allow-build=protobufjs
```

### 从 ByteDance 内部 registry 安装

可以访问 bnpm 的用户也可以直接安装已发布的包：

```bash
dsh plugin --profile web add @open-aiden/dsh-lark-bridge@0.0.8 \
  --registry=https://bnpm.byted.org \
  --allow-build=protobufjs
```

`protobufjs` 是飞书 SDK 的传递依赖，并声明了 `postinstall`。DSH 的 pnpm 供应链
门禁要求安装者显式允许这个脚本，因此首次安装需要上述 `--allow-build` 参数；这不
会增加运行时配置项。

设置飞书凭证。建议在启动 DSH 的同一个终端中执行：

```bash
export LARK_APP_ID=cli_xxx
export LARK_APP_SECRET=xxx
```

运行自检：

```bash
dsh plugin --profile web exec dsh-lark-bridge doctor
```

成功输出包含：

```json
{
  "larkBot": "ready",
  "larkAppId": "present",
  "larkAppSecret": "present"
}
```

`doctor` 会用 App ID 和 App Secret 请求当前 bot identity，但不会输出 App
Secret；同时会报告当前进程是否能看到 `DEEPSEEK_API_KEY`。

## 3. 启动 DSH

进入希望飞书 Agent 查看文件的项目目录，在同一个终端启动 DSH：

```bash
cd /path/to/your/project
dsh web
```

如果 DSH 尚未配置模型提供方，还需要按 DSH 的方式提供模型凭证；使用 DeepSeek
API 时通常是：

```bash
export DEEPSEEK_API_KEY=sk-...
```

启动日志中出现 `event=lark_consumer.ready` 和 `status=ready`，才表示飞书长连接与
DSH 插件都已就绪。然后打开 DSH 输出的 Web 地址，通常是
[http://127.0.0.1:3080](http://127.0.0.1:3080)。

## 4. 从飞书验证

给机器人发送一条私聊，或在群聊中明确 `@机器人`，例如：

```text
请读取 README.md，总结这个项目，并说明使用了什么工具。
```

正常情况下：

1. 源消息先出现 `Get` 表情，COT 创建成功后表情消失。
2. 机器人为首条消息创建话题；话题中的 COT 消息展示分析状态和 `read`、`glob`、
   `grep` 等工具调用进度。
3. DSH Web UI 中出现一个标题以 `飞书 ·` 开头的新 Session。
4. Session 继承 DSH 当前默认 Agent 配置，时间线中可以看到完整的真实工具调用与结果。
5. DSH 完成 Turn 后，最终答案回复在同一话题下。
6. 在该话题内继续发送消息，会复用同一个 DSH Session；另起一条私聊消息则创建
   新话题和新 Session。
7. 点击 Web 页面右下角的“飞书用户授权”；授权页会显示需要登记的完整回调地址，
   确认飞书应用安全设置中已有该地址后完成 OAuth 授权。
8. 打开 `Settings → Plugins → Plugin configuration`，展开“飞书桥接”即可编辑完整
   插件配置。配置写入 DSH Settings，使用 revision 校验避免覆盖并发修改，并在重启
   DSH 后生效。
9. 在 Web UI 中打开该 Session 并继续发送消息，原飞书话题会以本人身份显示用户
   输入；如果授权尚未完成或已经失效，则显示机器人发送的引用格式，并继续正常执行。
10. 将 `replyMode` 设为 `card` 并保持 `enableQuestions=true` 后，Agent 发起
    `AskUserQuestion` 时，当前流式卡片会插入问题和选项按钮。单选直接提交；多选先
    逐项选择，再点“提交选择”；没有选项或需要自定义答案时，直接在当前飞书话题中
    回复文本。一个请求包含多个问题时，插件会收齐整批答案，再使用原始 `rpcId`
    一次性回复 DSH。

问题按钮只接受发起该话题的飞书用户操作，并校验卡片消息 ID 与一次性 nonce。其他
用户、其他卡片或重复点击不会获得回答能力。`card.action.trigger` 通过与消息相同的
长连接处理，不需要公网 webhook；CardKit 不可用时仍可继续执行普通回复，但不能在
飞书侧回答等待中的 `AskUserQuestion`，此时应在 DSH Web UI 中处理。

当前插件接收私聊中的 `text` 和 `post` 消息；群聊只处理明确 `@机器人` 的这两类
消息，未提及机器人的群消息和其他消息类型会被忽略。

飞书原生 COT 需要支持该能力的租户和客户端版本；当前 ByteDance 租户要求桌面端
不低于 7.70、移动端不低于 7.74。若 COT 或表情权限未开通，启动日志会记录失败，
但 DSH 执行和最终文本回复不受影响。

Agent 知道 DSH Session 的准确 Workspace 路径；询问“你的工作区在哪”时会直接
回答，不会为了发现路径执行全量 `glob`。仍应从具体项目目录启动 DSH，避免把家目录
等大型目录作为 Workspace 后再请求宽泛文件搜索。

## 可选配置

| Option | Type | Default | Example | Description |
| --- | --- | --- | --- | --- |
| `LARK_APP_ID` | `string` | 无，必填 | `cli_xxx` | 飞书应用 App ID |
| `LARK_APP_SECRET` | `string` | 无，必填 | `your-secret` | 飞书应用 App Secret |
| `DSH_LARK_ENABLED` | `string` | `1` | `0` | 设为 `0` 时不启动飞书消费者 |
| `DSH_LARK_WORKSPACE` | `string` | DSH 启动目录 | `/path/to/project` | 飞书 Session 使用的 Workspace |
| `DSH_LARK_WORKSPACE_TITLE` | `string` | 保留 DSH 标题 | `MyProject` | 显式覆盖 Web UI 中的 Workspace 名称 |
| `DSH_LARK_ALLOWED_SENDERS` | `string` | 空，允许所有可访问应用的用户 | `ou_a,ou_b` | 逗号分隔的飞书 sender open ID allowlist |
| `DSH_LARK_BLOCKED_SENDERS` | `string` | 空 | `ou_bad_a,ou_bad_b` | 逗号分隔的 sender open ID blocklist；优先于 allowlist |
| `DSH_LARK_MAX_CONCURRENT_TOPICS` | `number` | `4` | `8` | 不同话题可同时运行的最大 DSH Turn 数；同一话题始终串行 |
| `DSH_LARK_MAX_PENDING_MESSAGES` | `number` | `256` | `128` | 传输和调度层允许保留的入站消息上限；超限时拒绝并等待上游重投 |
| `DSH_LARK_TURN_TIMEOUT_MS` | `number` | `0` | `900000` | 单个 DSH Turn 的总时长保护；`0` 表示不超时，等待真实 `turn/end` 或服务关闭信号 |
| `DSH_LARK_EVENT_STATE_PATH` | `string` | `$DSH_HOME/.dsh-lark-bridge/events.json` | `/secure/state/events.json` | admission checkpoint 与飞书话题关联文件；以 `0600` 原子写入 |
| `DSH_LARK_EVENT_RETENTION_MS` | `number` | `604800000`（7 天） | `86400000` | 已回复事件去重记录的保留时间 |
| `DSH_LARK_USER_AUTH_ENABLED` | `string` | `1` | `0` | 设为 `0` 时关闭 Web 用户身份授权，并始终使用引用格式降级 |
| `DSH_LARK_USER_AUTH_STATE_PATH` | `string` | `$DSH_HOME/dsh-lark-bridge/user-auth.json` | `/secure/state/user-auth.json` | 用户 OAuth Token 状态文件；以 `0600` 原子写入并自动刷新 |
| `DSH_LARK_USER_AUTH_REDIRECT_URI` | `string` | 当前回环 Web Host 的 `/dsh-lark/auth/callback` | `http://127.0.0.1:3080/dsh-lark/auth/callback` | 必须与飞书开放平台登记的重定向 URL 完全一致 |
| `DSH_LARK_DOMAIN` | `string` | `feishu` | `lark` | 开放平台域：`feishu`（中国）或 `lark`（国际） |
| `DSH_LARK_REPLY_MODE` | `string` | `post` | `card` | `card` 使用 CardKit 流式卡片；`post` 为一条富文本回复 |
| `DSH_LARK_CARDKIT_ENABLED` | `string` | `1` | `0` | 关闭流式卡片这一层 |
| `DSH_LARK_COT_ENABLED` | `string` | `1` | `0` | 关闭原生 COT 这一层（仅字节租户可用） |
| `DSH_LARK_ALWAYS_POST_FINAL` | `string` | `0` | `1` | 卡片之外再发一条纯文本回复，兼容 7.20 以下客户端 |
| `DSH_LARK_STREAM_PRINT_FREQUENCY_MS` | `number` | `70` | `40` | 打字机间隔；飞书 7.23 起生效 |
| `DSH_LARK_STREAM_PRINT_STEP` | `number` | `1` | `2` | 每次显示的字符数 |
| `DSH_LARK_STREAM_ELEMENT_MAX_CHARS` | `number` | `30000` | `20000` | 单个卡片组件的字符上限，超出后滚动到新组件 |
| `DSH_LARK_HTML_REPORTS_ENABLED` | `string` | `1` | `0` | 关闭 HTML 报告的本地托管与卡片按钮 |
| `DSH_LARK_HTML_REPORT_ORIGIN` | `string` | 当前回环 Web Host | `http://192.168.1.10:3080` | 飞书客户端与 DSH 不同机时覆盖报告地址 |
| `DSH_LARK_HTML_REPORT_TTL_MS` | `number` | `86400000`（24 小时） | `3600000` | 已托管报告的保留时长 |
| `DSH_LARK_CARD_ACTIONS_ENABLED` | `string` | `1` | `0` | 关闭卡片按钮回调 |
| `DSH_LARK_APPROVALS_ENABLED` | `string` | `0` | `1` | 允许飞书用户批准工具调用；默认关闭，见 ADR-0008 |
| `DSH_LARK_QUESTIONS_ENABLED` | `string` | `1` | `0` | 关闭以卡片按钮呈现助手提问 |
| `DSH_LARK_INBOUND_RESOURCES_ENABLED` | `string` | `1` | `0` | 关闭读取消息中的图片 |
| `DSH_LARK_MAX_INBOUND_IMAGES` | `number` | `4` | `1` | 单条消息最多读取的图片数 |
| `DSH_LARK_MAX_INBOUND_IMAGE_BYTES` | `number` | `5000000` | `2000000` | 单张图片的字节上限，超限即中断下载 |
| `DSH_LARK_BOT_MENU_ENABLED` | `string` | `1` | `0` | 关闭机器人菜单事件处理 |
| `DSH_LARK_REACTION_COMMANDS_ENABLED` | `string` | `1` | `0` | 关闭表情指令 |
| `DSH_LARK_INTERRUPT_EMOJI` | `string` | `X` | `DONE` | 用于中断当前 Turn 的 `emoji_type` |
| `DSH_LARK_EVENT_STREAM_ENABLED` | `string` | `1` | `0` | 设为 `0` 时回退到轮询 `session.history` |
| `DSH_LARK_ALLOW_SLASH_COMMANDS` | `string` | `0` | `1` | 允许以 `/` 开头的飞书消息执行 DSH 斜杠命令；默认关闭并转义 |

例如，显式指定 Workspace：

```bash
export DSH_LARK_WORKSPACE=/absolute/path/to/project
export DSH_LARK_WORKSPACE_TITLE=MyProject
dsh web
```

生产使用建议设置 sender allowlist；如需拒绝其中的个别用户，再设置 blocklist：

```bash
export DSH_LARK_ALLOWED_SENDERS=ou_trusted_user_1,ou_trusted_user_2
export DSH_LARK_BLOCKED_SENDERS=ou_revoked_user
```

统一 Settings 页面中的“飞书桥接”卡片覆盖上表中的 `DSH_LARK_*` 运行配置。环境变量构成
DSH Settings 的基础层，Web 保存的用户层覆盖它；重置字段后会重新继承环境变量。出于与
DSH 配置面相同的安全约束，设置 API 仅在 Host 绑定 `127.0.0.1` 时注册。

**机器人凭证也可以在这里配置。** App Secret 存放在 harness 的凭证层
（`ctx.credentials`，ref 为 `LARK_APP_SECRET`），设置界面只显示“是否已配置 / 来源 /
是否可写”，永远不回显值。凭证层自身的优先级是：

```
进程环境变量（只读，最高）
> $DSH_HOME/.credentials.yaml（可写）
> <启动目录>/.env  >  $DSH_HOME/.env
```

所以 `LARK_APP_SECRET=… dsh web` 的行为与以前完全一致；此时界面上的密钥输入框会禁用
并标注“由环境变量提供”，尝试保存会返回 409。轮换密钥后插件会自动重连，无需重启 DSH。
App ID 不是密钥，作为普通设置项 `appId` 保存。

插件按话题调度消息：同一话题的消息按顺序执行，不同话题在
`DSH_LARK_MAX_CONCURRENT_TOPICS` 上限内并行。关闭插件时，正在运行的 Turn 会收到取消
信号，排队任务会停止，消费者在退出前等待已启动任务收敛。传输与调度层都会限制待处理
任务数量，过载时拒绝新增工作而不是无限增长内存。

事件处理采用带持久 checkpoint 的 at-least-once 语义。已回复事件会在七天保留期内
去重；prompt 后中断的事件会从保存的 Session sequence 继续等待，不会主动再次
prompt。DSH 当前不接受 prompt idempotency key，因此进程在“prompt 已成功、checkpoint
尚未写入”的极小窗口崩溃时，仍可能重复 prompt；插件不宣称严格 exactly-once。

## 写入 `~/.zshrc` 后仍显示 not_in_env

`~/.zshrc` 只会在新的交互式 zsh 中自动加载。写入后，要么打开一个新终端，要么
在当前终端执行：

```bash
source ~/.zshrc
```

不打印 Secret 内容也可以验证变量是否已导出：

```bash
[[ -n "$LARK_APP_ID" ]] && echo 'LARK_APP_ID=present'
[[ -n "$LARK_APP_SECRET" ]] && echo 'LARK_APP_SECRET=present'
[[ -n "$DEEPSEEK_API_KEY" ]] && echo 'DEEPSEEK_API_KEY=present'
```

注意，必须写成 `export NAME=value`；只有 `NAME=value` 时，子进程看不到该变量。

## 升级与卸载

升级：

```bash
dsh plugin --profile web update @open-aiden/dsh-lark-bridge \
  --registry=https://bnpm.byted.org
```

卸载：

```bash
dsh plugin --profile web remove @open-aiden/dsh-lark-bridge
```

卸载不会删除已有 DSH Session。

## 常见问题

### 提示缺少 LARK_APP_ID 或 LARK_APP_SECRET

确认两项都使用 `export` 设置，并从设置变量的同一个终端执行 `doctor` 和
`dsh web`。插件要求两项同时存在，不会回退到本机其他飞书账号或配置文件。

### 提示另一个事件消费者正在运行

同一个飞书应用的 `im.message.receive_v1` 应只运行一个消费者。先通过 `Ctrl-C` 或
`SIGTERM` 优雅停止旧的 DSH 进程，再重新启动；不要使用 `kill -9`。

### Web UI 中没有出现 Session

确认：

- 启动日志包含 `event=lark_consumer.ready`；
- 消息是发给机器人的私聊；
- 消息类型是文本或富文本；
- 启动 DSH 的 profile 正是安装插件的 `web` profile。

## 安全边界

插件不再安装或强制选择 Agent preset；飞书 Session 拥有的工具与权限完全继承 DSH
当前默认 Agent 配置。请在 DSH 侧按部署需要配置权限，不要把 DSH Web UI 直接暴露到
公网，也不要在日志中输出 App Secret。

## 开发

```bash
npm ci
npm run build
npm test
npm pack --dry-run
npm run verify
```

测试使用假的飞书和 DSH 边界，不需要真实 App Secret。提交问题或改动前，请先确保
`npm run verify` 通过；它统一执行源码与测试类型检查、行为测试、覆盖率门槛和 package
内容检查。

## 支持与贡献

问题和改进建议请提交到 [GitHub Issues](https://github.com/Kinasha/dsh-lark-bridge/issues)。
Pull Request 应保持改动聚焦，并附带与行为变化对应的测试。

## 项目状态

本项目处于实验阶段，并与 `@deepseek-ai/dsh@0.1.0-rc.7` 对齐。飞书原生 COT 当前
使用 ByteDance 租户接口；其他租户无法使用 COT 时，普通文本回复仍可继续工作。

## License

[MIT](LICENSE)
