<p align="center">
  <img src="./assets/readme/hero.svg" width="100%" alt="rotom：终端里的个人编程助手，支持编码、浏览器操作和按需任务委派。">
</p>

# rotom

基于 Pi fork 的个人编程助手。在你的项目目录中读写代码、执行命令、操作浏览器，并按需委派子任务。Pi 运行时随包提供，无需另装。

## 怎么用

需要 **Node.js 24+**。目前是 private alpha，尚未发布到 npm，请使用本地 `.tgz` 安装包：

```sh
npm install -g --ignore-scripts '/absolute/path/to/rotom-<version>.tgz'
cd /path/to/your/project
rotom
```

启动后：

1. 用 `/login` 登录模型服务，或自行配置 API key。
2. 用 `/model` 选择模型和支持的思考档位。
3. 直接描述任务，例如：“检查这个项目，修复失败的测试，并说明修改。”

没有安装包？见[构建与安装](docs/agent/distribution.md)。升级时保留仍有会话使用的旧安装，不原地覆盖。

## 有哪些能力

| 能力 | 可以做什么 |
|---|---|
| **编码** | 读取和编辑文件、执行命令、运行测试、排查问题。 |
| **浏览器与桌面** | 读取页面，基于当前观测操作浏览器或桌面；Chrome relay 需手动设置。 |
| **任务委派** | 按需加载 Subagent，把边界清晰的子任务交给其他 agent。 |
| **模型切换** | 登录模型服务、切换模型，并选择该模型支持的思考档位。 |
| **本地观测** | 查看执行状态、耗时和用量，不在 trace 中记录 prompt 或工具正文。 |

**可选 Qoder：** 用 `ROTOM_QODER=1 rotom` 启动，执行 `/login qoder-experimental` 登录，再用 `/new` 开启会话、`/model` 选择模型。仍属 experimental，支持范围与费用限制见 [Qoder 说明](docs/usage.md#qoder原生-provider显式启用)。

> 工具使用本机用户权限，**不是安全沙箱**。macOS arm64 已有安装验证；其他平台的验证状态和使用边界见详细指南。

[详细用法](docs/usage.md) · [构建与升级](docs/agent/distribution.md) · [Pi fork](docs/agent/pi-fork.md) · [许可说明](docs/usage.md#许可与发布状态)
