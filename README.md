# <img src="./assets/readme/heat-rotom-mark.png" width="40" height="25" alt="Heat Rotom"> rotom

基于 Pi fork 的个人编程助手。在你的项目目录中读写代码、执行命令、操作浏览器，并按需委派子任务。Pi 运行时随包提供，无需另装。

## 核心特性

- **结果必须有证据**：证据不足就返回 `unknown`，不会重放可能已经发生的写操作。避免点错位置、重复输入或重复任务，减少纠错浪费的 token 与等待时间。
- **编码过程有固定规则**：执行前先确认仓库、路径、脚本和编辑位置，失败后先读取当前状态再修复。减少改错仓库、无效命令和长任务重跑，节省返工的 token 和开发时间。
- **工具按需加载**：默认只保留常用工具，Subagent 等专用能力需要时再加入。减少无关 schema 和工具误调用，为代码与任务信息留出更多上下文。
- **内置 Qoder 支持**：默认启用原生 Qoder provider，可直接通过浏览器授权登录、读取当前账号的模型目录并选择已适配模型，无需安装 Qoder CLI。
- **新增本地可观测性**：通过 trace 和 dashboard 串联模型请求、工具调用与上下文压缩。快速定位慢在哪里、失败在哪一层和用了多少资源，同时不保存 prompt、模型输出或工具正文。

查看本地执行记录：

```sh
rotom --trace
```

`--trace` 必须单独运行。命令会输出带随机访问 token 的本地 dashboard 地址和 trace 数据目录；在浏览器中打开该地址即可查看已持久化会话的耗时、状态和用量。它不会启动普通 agent 会话，`--no-session` 会话也不会产生 trace。

## 怎么用

需要 **Node.js 24+**。直接通过 npm 安装（已包含 Pi 运行时）：

```sh
npm install -g --ignore-scripts @bingjiang0611/rotom
```

安装后进入任意项目目录运行 `rotom`。检测到新版时，先退出所有 rotom 会话，再运行 `rotom update`；它会从 npm 官方 registry 读取 latest、固定精确版本并更新产品及内置 Pi fork。

启动后：

1. 用 `/login` 登录模型服务，或自行配置 API key。
2. 用 `/model` 选择模型和支持的思考档位。
3. 直接描述任务，例如：“检查这个项目，修复失败的测试，并说明修改。”

## 使用 Qoder

Qoder provider 已内置并默认启用，无需安装或登录 Qoder CLI。在 rotom 内执行 `/login qoder`，打开显示的链接并在 Qoder 网页完成授权；随后执行 `/new`，再用 `/qoder-models` 刷新当前账号的模型目录、用 `/model` 选择模型。以后也可以直接指定：

```sh
rotom --provider qoder --model lite
```

这是 rotom 对 Qoder 接口的产品集成，不代表 Qoder 官方支持。认证方式、模型与 Thinking 档位、Credit 显示和兼容模式等边界见 [Qoder 详细说明](docs/usage.md#qoder原生-provider默认启用)。如需关闭内置 provider，设置 `ROTOM_QODER=0`。

## 安装扩展

rotom 支持 Pi 原生 package 与 extension 发现机制。第三方 package 会以当前用户权限执行任意代码，安装前请先审查来源：

```sh
rotom install npm:@foo/bar@1.0.0       # 用户级
rotom install -l ./local-package       # 当前项目；需信任项目
rotom list
rotom update --extensions
rotom remove npm:@foo/bar
```

package 可包含 extension、skill、prompt template 和 theme；使用 `rotom config` 调整已安装资源。临时试用单个扩展可运行 `rotom -e ./extension.ts`，也可以使用 Pi 的 `~/.pi/agent/extensions/` 和受信项目 `.pi/extensions/` 目录。rotom 自带的五个产品扩展仍固定加载，不能通过 `--no-extensions` 移除。

`rotom update` 更新产品及内置 Pi fork；写入前会要求确认其他 rotom 会话和 worker 已退出。只更新扩展时使用 `rotom update --extensions` 或 `rotom update --extension <source>`；两类更新需分别执行。

## 配置浏览器

当前安装器支持 **macOS + Google Chrome 125+**，不会自动安装或加载扩展。

在 rotom 会话内输入 **`/browser`** 并回车，直接填写浏览器任务；输入 `/browser `（尾随空格）可补全子命令。首次配置：

1. **`/browser install`**：确认后将浏览器组件写入固定目录，注册连接程序并显示扩展目录。
2. **加载 Chrome 扩展**：打开 `chrome://extensions`，开启「开发者模式」，点击「加载已解压的扩展」，选择上一步显示的目录。保持 Chrome 开启。
3. **`/browser status`**：分别检查注册和连接；不调用模型、不读取网页。注册匹配不等于连接可用。
4. **`/browser 打开 example.com，读取页面标题`**：手动提交浏览器任务，使用当前模型。

若安装版尚无 `/browser`，需升级到包含该入口的构建；旧版脚本配置与命令边界见[浏览器命令](docs/usage.md#浏览器命令)。

**只需首次加载一次**：固定目录跨 rotom 发行版本不变。之后升级时执行 `/browser install`：若浏览器组件内容有变化，它会原子更新固定目录并提示你到 `chrome://extensions` 点扩展卡片的**刷新（↻）**一次即可，无需 Remove 或重选目录；内容无变则 Chrome 端零操作。只有 Node 路径变化需重新注册 native host。详见[升级边界](docs/usage.md#浏览器命令)。

## 有哪些能力

| 能力 | 可以做什么 |
|---|---|
| **编码** | 读取和编辑文件、执行命令、运行测试、排查问题。 |
| **浏览器与桌面** | 读取页面，基于当前观测操作浏览器或桌面；Chrome relay 需手动设置。 |
| **任务委派** | 按需加载 Subagent，把边界清晰的子任务交给其他 agent。 |
| **模型切换** | 登录模型服务、切换模型，并选择该模型支持的思考档位。 |
| **本地观测** | 查看执行状态、耗时和用量，不在 trace 中记录 prompt 或工具正文。 |

## 许可说明

本仓库及 npm 包不提供统一的开源许可，当前标记为 `UNLICENSED`。此前已经授予的 MIT 权利不受影响；源码和安装包公开不代表获得新的统一开源许可。

Heat Rotom 图像来自 Pokémon Database，其相关权利不随本项目源码授予。
