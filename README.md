# <img src="./assets/readme/heat-rotom-mark.png" width="40" height="25" alt="Heat Rotom"> rotom

基于 Pi fork 的个人编程助手。在你的项目目录中读写代码、执行命令、操作浏览器，并按需委派子任务。Pi 运行时随包提供，无需另装。

## 怎么用

需要 **Node.js 24+**。直接通过 npm 安装（已包含 Pi 运行时）：

```sh
npm install -g --ignore-scripts @bingjiang0611/rotom
```

安装后进入任意项目目录运行 `rotom`。

启动后：

1. 用 `/login` 登录模型服务，或自行配置 API key。
2. 用 `/model` 选择模型和支持的思考档位。
3. 直接描述任务，例如：“检查这个项目，修复失败的测试，并说明修改。”

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
