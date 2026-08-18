# @aiden-ai/dsh-lark-bridge

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
飞书私聊 -> dsh-lark-bridge -> DSH Session -> DSH Web UI
     ^                              |
     +---------- 飞书回复 ----------+
```

## 你会得到什么

- 默认把机器人对一条私聊消息的首次回复创建为飞书话题，并在话题下继续回复。
- 收到消息后先添加 `Get` 表情作为处理回执；COT 消息创建成功后自动移除。
- 在飞书原生 COT 消息中实时展示安全的分析状态和工具调用进度，最终答案仍回复在同一话题下。
- 每个飞书话题对应一个稳定的 DSH Session；同一私聊中的不同话题相互隔离。
- 飞书 Session 和浏览器 Session 使用同一个 DSH Host；Web UI 可以看到完整对话、
  推理过程、工具调用和最终回复。
- 默认使用 `dsh-lark-safe` preset，只允许读取和搜索 Workspace 文件。
- 插件负责飞书鉴权、WebSocket 自动重连、事件规范化、幂等回复和优雅退出。
- COT 不包含模型隐藏推理、工具参数或文件内容；COT/表情接口不可用时会降级为普通文本回复。

当前 `0.0.7` 兼容 `@deepseek-ai/dsh@0.1.0-rc.6`。DSH 仍处于 developer
preview，升级 DSH 后请重新执行本文的验证步骤。

## 1. 准备飞书应用

在飞书开放平台创建企业自建应用，然后完成以下配置：

1. 开启机器人能力。
2. 为应用开通 `im:message.p2p_msg:readonly`、`im:message:send_as_bot`，以及
   添加和删除消息表情回复所需的权限。
3. 在事件订阅中选择“使用长连接接收事件”，订阅
   `im.message.receive_v1`。
4. 发布应用版本，并确保当前测试用户可以使用该应用。

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
dsh plugin --profile web add ./aiden-ai-dsh-lark-bridge-0.0.7.tgz \
  --allow-build=protobufjs
```


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

给机器人发送一条私聊，例如：

```text
请读取 README.md，总结这个项目，并说明使用了什么工具。
```

正常情况下：

1. 源消息先出现 `Get` 表情，COT 创建成功后表情消失。
2. 机器人为首条消息创建话题；话题中的 COT 消息展示分析状态和 `read`、`glob`、
   `grep` 等工具调用进度。
3. DSH Web UI 中出现一个标题以 `飞书 ·` 开头的新 Session。
4. Session 使用 `dsh-lark-safe` preset，时间线中可以看到完整的真实工具调用与结果。
5. DSH 完成 Turn 后，最终答案回复在同一话题下。
6. 在该话题内继续发送消息，会复用同一个 DSH Session；另起一条私聊消息则创建
   新话题和新 Session。

当前插件只接收 `p2p` 私聊中的 `text` 和 `post` 消息；群聊和其他消息类型会被
忽略。

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
| `DSH_LARK_AGENT_PRESET` | `string` | `dsh-lark-safe` | `dsh-lark-safe` | 新建飞书 Session 使用的 Agent preset |

例如，显式指定 Workspace：

```bash
export DSH_LARK_WORKSPACE=/absolute/path/to/project
export DSH_LARK_WORKSPACE_TITLE=MyProject
dsh web
```

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
dsh plugin --profile web update @aiden-ai/dsh-lark-bridge \
  --registry=https://bnpm.byted.org
```

卸载：

```bash
dsh plugin --profile web remove @aiden-ai/dsh-lark-bridge
```

卸载不会删除已有 DSH Session，也不会删除
`$DSH_HOME/.agent-presets/dsh-lark-safe`。

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

默认 preset 只注册以下工具：

- `read`：读取 Workspace 内的 UTF-8 文本文件；
- `glob`：在 Workspace 内查找文件；
- `grep`：在 Workspace 内搜索内容。

它不注册 Shell、文件写入、Skills、Jobs 或子代理。绝对路径和包含 `..` 的搜索
路径会被拒绝；`.env`、凭证文件、私钥和 VCS 元数据也会被硬阻断。`glob` 必须使用
带 `/` 的锚定 pattern 或显式 path，`grep` 必须指定 path 或 include filter，以免
无意遍历整个大型 Workspace。不要在日志中输出 App Secret，也不要把 DSH Web UI
直接暴露到公网。

## 开发

```bash
npm ci
npm run build
npm test
npm pack --dry-run
```

测试使用假的飞书和 DSH 边界，不需要真实 App Secret。提交问题或改动前，请先确保
构建和测试通过。

## 支持与贡献

问题和改进建议请提交到 [GitHub Issues](https://github.com/Kinasha/dsh-lark-bridge/issues)。
Pull Request 应保持改动聚焦，并附带与行为变化对应的测试。

## 项目状态

本项目处于实验阶段，并与 `@deepseek-ai/dsh@0.1.0-rc.6` 对齐。飞书原生 COT 当前
使用 ByteDance 租户接口；其他租户无法使用 COT 时，普通文本回复仍可继续工作。

## License

[MIT](LICENSE)
