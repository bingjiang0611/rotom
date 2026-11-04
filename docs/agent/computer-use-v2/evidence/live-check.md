# Computer Use v2 live check

Status: **未运行**。本机执行策略会 `SIGKILL` 本地编译的产物，且未授予 Accessibility / Screen Recording，所以 `scripts/check-cu-v2-live.mjs` 只能做“跳过”验证（见 STATUS 的 M7 记录）。

运行方式（macOS 真机、已授权、已装 v2 helper、独立 socket）：

```bash
cd packages/rotom-computer-use
PI_CU_LIVE=1 PI_CU_SOCKET_PATH=/tmp/cu-v2-helper.sock \
  node scripts/check-cu-v2-live.mjs --fixture /tmp/cu-fixture
```

脚本会覆盖：

1. helper 协议为 8、Accessibility 已授予、用户活动 tap 在监听。
2. fixture 后台启动（`activates=false`）后能在 `listApps`/`listRoots` 里找到。
3. `observe` 能返回带截图的 outline，且能定位文本框、复选框、滑块、列表、树、tab。
4. `focus`/`setText`/`setChecked`/`setValue`/`select`/`collapse`/`expand` 逐个返回 `worked`。
5. 全程前台 App 与系统光标坐标不变，且没有任何一步报告 `interferedWithUser`。

脚本不会、也无法证明：别的 App 没被影响、不在白名单里的 App 能用 L2、用户数据和私人窗口的行为。
