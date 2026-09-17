# 2026-09-17 · 提交身份修正

用户明确要求使用 GitHub `bingjiang0611` 身份重新提交、推送并发布。此次仅重建两条已有公开提交和其后四条尚未推送提交，作者和提交者均为 `bingjiang0611 <307659028+bingjiang0611@users.noreply.github.com>`。逐条比较 Git tree object，六组内容完全相同；已有 release tags 不变。

| 原提交 | 新公开提交 |
|---|---|
| `9553f212c9d04b3216b10bdda14b63c2c944a946` | `78ac9297b9f113041ef2d60ef3408d0a94b72777` |
| `dbe9732c1a8633142fdfeda280737d263f92ff18` | `03ca4570020a4e4789e1ccc2f064b552535f6443` |
| `465d0b05683a35957bd5236ab3732308282d494a` | `13a6101167df7ea65c73b7fcec42213064443ff9` |
| `a733c9e4d2b09045b470c9274179dd581fca1495` | `9d5d7f17d066fc624b6f4af61e087cd7db85730b` |
| `0f42721c967ddabf37ad67fc8e43a0c9ec8b6a13` | `b34e9057bbc83ec5badc0dbf9b774baefa969b01` |
| `3fee4cd6a49ac72b1d94bc675f44b43c48524bc4` | `6e63e675db5721e20557827ce977b0409617de76` |

评测报告中的原 commit SHA 是当时实际执行的来源，保留而不回写；可通过上述映射定位内容相同的新公开提交。原历史备份仅在本机私有目录保存，不作为发布 refs 上传。

此次历史替换使用用户授权、绑定原远端 SHA 的 `--force-with-lease`，不新增邮箱审计例外，不放宽凭据/文件/其余历史检查。重建后的 tree + all-refs history 审计通过。此后发布元数据和 release tag 仍使用正常 fast-forward 流程。

GitHub 可能仍通过缓存、提交直链或已有 clone 保留旧对象；重建分支不等于撤销已公开邮箱，也不声称抹除了全部副本。
