# npm 0.2.0 · 已发布

2026-11-12，维护者在前台终端发布 `@bingjiang0611/rotom@0.2.0`，dist-tag 为 `latest`。Agent 没有执行 npm 登录、whoami 或 publish；公开 registry 的版本、tag、摘要和实际下载字节均与唯一最终 tgz 一致。

构建源、完整摘要及验收结果见 [机器可读证据](npm-0.2.0-verification.json)。发布前的失败与后续通过记录见[验收报告](https://github.com/bingjiang0611/rotom/blob/a884a27f6281a1c734a6080242de68b857273288/docs/agent/computer-use-v2/STATUS-7-artifact-acceptance.md)，不以成功覆盖失败历史。

## 产物与验证

| 项目 | 结果 |
|---|---|
| 唯一产物 | `bingjiang0611-rotom-0.2.0.tgz`；未重新打包 |
| 文件数 / 压缩大小 / 解包大小 | 19,049 / 34,088,284 bytes / 147,162,933 bytes |
| 实际 tgz 审计 | 0 findings |
| 主测试 / Goal | 597/597、99/99，0 fail/skip |
| Provider 离线门 | 9 组 PASS；不代表 live Provider 验收 |
| 实际安装 default/full smoke | 26/33 active tools，0 lifecycle errors |
| 升级与卸载 | 隔离 0.1.27 → 0.2.0；版本、文件字节与卸载回验通过 |
| 受管 Mac helper | 用户批准两步安装、签名；系统 codesign 独立验签，真实启动返回协议 11，PID 与隔离 executable 映射一致；一次 shutdown 后确认退出 |
| registry | 精确 version/tag/integrity/shasum/tarball URL 和下载字节核验通过 |

## 本机全局安装

维护者在看到精确命令后，另行明确授权 Agent 执行全局安装，并要求不退出其他会话。

Agent 将旧命令软链接备份，保留它指向的独立旧发行目录，再将同一已验证 tgz 安装到当前 Node 24.18.0 的 npm global prefix。没有覆盖活跃旧发行目录，没有使用 `--force`，安装脚本由 `--ignore-scripts` 禁用。

回读结果为 `rotom 0.2.0` / `Pi fork 1.4.0-rotom.4`；全局入口指向新 npm package，19,049 个普通文件与最终 tgz 逐个匹配。日常 helper 的二进制摘要、PID、启动时间未改变。已有会话不热升级；新启动命令使用 0.2.0。

## 保留的边界

- 原生验收采用用户明确批准的两步路径：先在隔离 HOME 安装但不启动 ad-hoc 副本，再用正常 HOME 的真实 `/usr/bin/codesign` 签名隔离 app。没有修改产品、钥匙串、搜索列表或证书；不宣称 updater 内建签名在隔离 HOME 下通过。
- L2 仍为 0 成功 / 5 失败，pid 定向输入没有真实成功，B1–B6 未通过。本次 PID 核对只证明实例身份，不证明输入派发。
- 没有新增真实模型、Browser/Phone、跨平台或完整 GUI 任务验收。内置 `rotom update` 不在本次实测范围。
- 历史超时的唯一根因没有全部确定。维护依赖按锁文件补齐，未改测试和 timeout，当前版本完整 gate 正常通过。
- 隔离验收 HOME、签名 helper 与缓存已在进程退出后清理；本机全局安装和旧版本入口备份保留。临时 npm 认证由维护者在原终端注销和删除，Agent 不读取凭据。
