# Computer Use v2.1 测试机方案（HANDOFF-3 第 1 步，待批准）

本文只写方案，**没有安装任何软件、没有下载镜像、没有创建虚拟机**。第 0 步的只读检查结果只贴给用户与审核者，
故意不写进本文件（涉及用户机器上的企业软件清单）。

方案 A（HANDOFF-3）：B 阶段改在专用测试机上跑，首选这台 Mac 上的 macOS 虚拟机。用户不用再离开电脑，
门禁在测试机里天然安静；同时给 REVIEW-9 的 X2 一个干净对照。

## 1. 虚拟化工具

选 **tart**（`brew install cirruslabs/cli/tart`），备选 **UTM**（`brew install --cask utm`）。

| 项 | tart | UTM |
| --- | --- | --- |
| 底层 | Apple Virtualization.framework | Apple Virtualization.framework（也支持 QEMU，本期不用） |
| 形态 | CLI，可脚本化，VM 在 `~/.tart/vms` | GUI App，额外 70 MB 左右 |
| 为什么 | 全部操作能从 SSH 一条条命令复现，和“冻结提交 + 可复现命令”的规矩一致 | 需要 GUI 点击，但多显示器/文件共享等设置更直观 |

装系统只用 **Apple 官方 IPSW**（tart 的 `fetch ipsw` 走 Apple 的 restore image 服务），不用第三方预装镜像。
下面出现的具体子命令与缓存路径按 tart 官方文档来写，**我还没装，所以没有在真机上验证过**；装完第一件事是对一遍 `tart --help`。

## 2. 系统版本

宿主实测 `macOS 27.3 (26C5035r)`。虚拟机的 macOS 版本取 Apple 当时能提供的、最接近宿主的 IPSW。

- 若拿到的就是 27.3：版本一致，结论可直接与宿主对照。
- 若只有更低的 26.x：写明差一个次要版本。以下结论**不能**从虚拟机外推到宿主（要标注未验证）：
  AppKit 首次点击是否只激活窗口、AX 树出现的时机、`SLEventPostToPid`/SkyLight 私有行为、
  HID 事件流的具体形态（`pid 0 / state 1` 的那些记录）。
- 反向也一样：虚拟机里“没有突发”只能说明突发不是我们的代码在干净系统上产生的，不能证明宿主上是什么产生的。

## 3. 资源

| 项 | 值 |
| --- | --- |
| 虚拟机配额 | 4 CPU / 8 GB 内存 / 64 GB 磁盘（宿主 10 CPU / 32 GB / 数据卷剩 202 GiB） |
| 磁盘占用 | 系统 ~25 GB + Xcode 命令行工具（如果装）+ 存档，峰值按 40 GB 估 |
| 存放位置 | 默认在 `~/.tart/vms/<name>`；不够可改到外置盘 |
| 不用时 | `tart stop` 或直接 `tart run` 的窗口关掉；不需要常驻 |
| 整体删除 | `tart delete <name>` 删虚拟机；再删下载的 IPSW 缓存（tart 自己的缓存目录，默认在 `~/.tart` 下，具体路径装完确认）；确认没有残留 LaunchAgent |

## 4. 怎么在虚拟机里跑命令（SSH 与图形会话）

关键点：helper 和 fixture 必须跑在**虚拟机的 Aqua 图形会话**里，否则拿不到窗口、AX 和 HID 事件。
SSH 登录拿到的是普通会话，所以分工如下。

1. 虚拟机里建一个专用测试账户（例如 `cutest`），在系统设置里开启**自动登录**到它。
   开机即进入图形会话，不需要任何人解锁。
2. 该账户下放一个 **LaunchAgent**（`~/Library/LaunchAgents/…plist`，`RunAtLoad` + `KeepAlive`），
   负责在登录后启动 `pi-computer-use` 的 bridge（`serve --socket …/b0.sock`）。
   这样 helper 天然属于图形会话，不需要 `launchctl asuser`/`bsexec` 这类提权技巧。
   （若 LaunchAgent 出问题，退路是 SSH 里 `sudo launchctl asuser <uid> …`。）
3. 系统设置里开启“远程登录”，宿主用 `ssh cutest@<vm-ip>` 进去，只用来跑 node 脚本。
4. fixture 由脚本经 helper 的 `manageApps`（`activates:true`）启动，因此自动落在图形会话里。
5. **运行时不许把宿主的焦点放进虚拟机窗口**：那样键鼠会进入虚拟机，被算作真实输入，门禁会 hold。
   这条写进每次运行的授权说明。
6. 2 分钟门禁用现有参数就行：`--require-idle-minutes 2`（脚本默认 10，已经支持，不需要改代码）。

## 5. 代码与存档

- 虚拟机里有自己的 `git checkout`（`git clone` + `git checkout <冻结提交>`）。
- `--expect-commit <sha>` 照常检查，脚本里的冻结校验不因为换了机器而放宽。
- `--runs-dir` 指向虚拟机内的绝对路径（例如 `/Users/cutest/cu-v2-runs/<日期>-<短SHA>`），
  存档先落在虚拟机里，事后用 `scp` 复制回宿主，再按需摘进 `docs/`。
- 冻结提交的代码必须先推送，虚拟机只按 SHA 取，不从宿主拷工作区。

## 6. 签名

- 先在虚拟机里试 **ad-hoc 签名**（`codesign --force --deep --sign -`）。干净系统一般允许本机构建的 ad-hoc App。
  现在的脚本已经会在副本会是 ad-hoc 且没有真实身份时退出 2（R8），所以这条路径有明确的拒绝行为，不会静默失败。
- **不把**用户的 Apple Development 证书或私钥导出到虚拟机。需要真实签名才能跑通时，停下来问用户。
- 若虚拟机里 ad-hoc 也被 amfid 拒绝（`Code=-423`），同样停下，先报告再决定。

## 7. 需要用户亲自做的事

只有系统层面无法用命令完成的几项，全部在虚拟机窗口里点：

| # | 事项 | 预计 |
| --- | --- | --- |
| 1 | 首次开机向导（语言、地区、跳过 Apple 账户） | 3–5 分钟 |
| 2 | 建测试账户 `cutest` 并设置密码 | 1–2 分钟 |
| 3 | 系统设置里开启自动登录到 `cutest` | 1 分钟 |
| 4 | 系统设置里开启“远程登录”（之后 SSH 可用） | 1 分钟 |
| 5 | 给 helper 授权“辅助功能”和“屏幕录制”（每次重新签名后可能需要重授权） | 3–5 分钟 |
| 6 | 确认公司 IT 政策允许（见第 8 节） | 你判断 |

其余（装工具、下载 IPSW、装系统、装 node、clone、跑冒烟）我来做。整体估 **1.5–2 小时**，
其中下载与装系统占大头，你亲自操作约 15–20 分钟。

## 8. 公司设备的风险（需要你确认）

这台 Mac 装有企业终端管理、办公客户端和安全代理（第 0 步只读检查里有具体清单，未写入本文件）。
在上述环境里运行 Virtualization.framework 虚拟机有这些风险：

1. **可能触发告警或违反 IT 规定**：企业 EDR 通常会上报虚拟化、内核扩展、异常进程等行为。
2. **可能被策略直接阻断**：有的策略禁止 `Virtualization.framework` 或禁止未登记的虚拟机。
3. **网络流量**：下载 IPSW 约 15 GB、以后拉代码与依赖，都会经过公司网络。
4. **同一个干净系统假设可能不成立**：如果企业代理也装进虚拟机（一般不会，但要看策略），
   “干净系统”这个前提就要写清楚。

如果 IT 不允许，退路是 HANDOFF-3 里的次选：一台闲置的 Mac（非公司管理），方案其余部分不变。

## 9. 批准后我会做什么（按顺序，先不做）

1. 装 tart、`tart fetch ipsw`、建虚拟机、装系统。
2. 按第 4 节配置自动登录、LaunchAgent、远程登录。
3. 在虚拟机里装 node，clone 冻结提交，跑第 2 步冒烟（helper `diagnostics` 协议/`accessibility`/`screenRecording`、
   `build-fixture.mjs` 的 `minos` 回读与 `source.sha256`、一次 `PI_CU_LIVE=1` 的 fixture 启动与退出）。
4. 冒烟全过之后，才申请第一个 B0 对照窗口（`--require-idle-minutes 2`）。

## 10. 暂缓

- REVIEW-9 的 **X1**（fixture“出窗口但不激活”模式）先不写代码，等虚拟机里的 B0 对照结果再决定。
- B1 及以后每一步的冻结提交仍然先经过审核。
- B5（前台接管）与 B6（`--with-hid`）在虚拟机里通过后，由审核者决定是否需要在用户 Mac 上补跑。
