# Chrome Web Store 上架材料（草稿）

状态：**草稿完成，未提交**。提交需要用户的开发者账号，本仓库不代为上传，也不代替用户点「发布」。审阅通过后再补一次 native host 的 `allowed_origins`（见文末）。

## 打包

```bash
node rotom/scripts/pack-chrome-extension.mjs /absolute/output-dir
```

产出 `rotom-browser-relay.zip`，并输出字节数、SHA-256 与文件清单。当前源（manifest `0.12.0`）实测：

| 项 | 值 |
|---|---|
| 文件数 | 34 |
| 大小 | 82 735 bytes |
| SHA-256 | `b17e294c98977b6f8be5e09a0a3df212067cb105f4dfb3c318959fc0b868f1ec` |
| `unzip -t` | No errors detected |

打包脚本会去掉 `manifest.json` 的 `key` 字段（那是本机开发用的固定 id），并固定时间戳与权限位，所以同一份源码重复打包得到完全相同的字节。`pack-chrome-extension.test.mjs` 用独立读取器解包校验 CRC、长度、可复现性与 symlink 拒绝。

## 单一用途说明（single purpose）

> Rotom Browser Relay 只做一件事：把本机 Rotom 客户端与当前用户的 Chrome 标签页连起来，让本机的 AI 客户端可以读取标签页内容并代替用户执行点击、输入、导航等操作，并把结果返回给本机客户端。

判定依据：扩展没有第二用途，不注入广告、不做分析、不同步、不改搜索引擎/新标签页、不代理任意网络请求。

## 每项权限的理由

| 权限 | 为什么需要 |
|---|---|
| `debugger` | 通过 Chrome DevTools Protocol 读取无障碍树、合成输入、截图、读取控制台与网络元数据、设置设备视口、采集性能 trace 与录屏。这是实现「按 ref/坐标精确操作页面」的唯一途径；普通 content script 无法提供 AX 树、可信输入事件或 CDP。 |
| `nativeMessaging` | 与本机原生 host 通信；AI 客户端在本地进程中运行，只有 native messaging 能在 sandbox 扩展与本地进程之间传消息。 |
| `tabs` | 枚举标签页、读取标题/URL/状态以确认「这是哪个 agent 的哪个标签」，并在 Agent 自建的后台标签之间切换。 |
| `tabGroups` | 把每个 Agent 的标签页放进独立标签组，避免多个 agent 互相踩踏，也便于用户一眼看清哪些标签由程序控制。 |
| `storage` | 保存 Agent/标签归属与连接状态的本地持久化数据（不写远端）。 |
| `alarms` | service worker 被回收后按计划唤醒并做连接清理；没有它，agent 标签可能残留。 |
| `downloads` | 把 Agent 触发的下载归档到 `Downloads/rotom/<agentId>/` 并向本机客户端报告文件名与摘要；未声明的下载会被取消。 |

不申请的权限：`<all_urls>` / `host_permissions`（扩展不注入页面脚本，全部操作走 `debugger`）、`webRequest`、`cookies`、`history`、`bookmarks`、`identity`。

## 隐私说明（提交时粘贴到 Privacy practices 标签）

- **数据收集：不收集**。扩展不向任何服务器发送数据；没有分析、遥测、崩溃上报、广告 SDK。
- **数据流向**：页面内容、控制台与网络元数据、截图、trace 与录屏只经 native messaging 传给同一台机器上、由同一用户在本地启动的 Rotom 进程。传输在本机完成，不经过 Rotom 的任何服务端。
- **数据存储**：标签归属与队列状态存在扩展的 `chrome.storage.local`；截图/trace/录屏由本机客户端写入用户自己的临时目录。扩展自身不上传、不备份、不同步。
- **凭据**：扩展不读取 cookie、不读取密码、不读取 `Authorization` 头，也不保存任何账号凭据。网络日志只保留元数据（方法、URL、状态、耗时、大小），不保留请求/响应体。
- **用户控制**：只操作用户通过客户端显式打开或认领的标签；用户自己的标签不会被关闭或改写；`/browser uninstall` 移除本机注册。
- **合规声明**：不用于「绕过站点条款」或「代替用户完成需要本人身份的动作」，所有写操作由用户在本地客户端确认。

## 提交时的一次性注意

1. **扩展 id 会变**：开发包用 `manifest.json` 的 `key` 固定 id `kgadcllokaodnoknakblocmhidemimdi`；商店包去掉 `key`，审阅通过后由商店分配新 id。
2. 审阅通过后，把新 id 与现有 id **一起**写进 native host manifest 的 `allowed_origins`（现有 `install-chrome-relay.mjs` 只写开发 id，需要一次小改动），否则商店版扩展连不上本机 host。
3. 商店版扩展仍需用户在本机运行 `rotom` 并执行 `/browser install` 注册 native host；扩展本身不能自带 host。
4. 截图与文案：需要 128×128 图标、至少 1 张 1280×800 或 640×400 的截图。当前扩展**没有图标文件**，`manifest.json` 也没有 `icons` 字段；提交前需要补图标，否则会被退回。
5. 版本号：`manifest.json` 的 `version` 必须单调递增（当前 `0.12.0`）。

## 待用户执行（本仓库不代做）

- 用自己的开发者账号创建条目、上传上面那个 zip、填写 privacy practices。
- 提交审核，并在审核通过后回填新扩展 id。
