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

## 2026-11-03 · Goal 自动续跑提交身份修正

用户明确授权修正公开 `main` 上连续八条使用非 GitHub noreply 身份的提交，并以绑定旧远端 tip `4d57af71ad215760002887a87fde3990b98453f9` 的 `--force-with-lease` 推送。重建提交的作者和提交者均为 `bingjiang0611 <307659028+bingjiang0611@users.noreply.github.com>`；逐条比较 Git tree object，八组内容完全相同。旧提交只由公开 `main` 引用，已有 release tags 与其他远端分支不变。

| 原公开提交 | 新公开提交 |
|---|---|
| `2da8ac57233b028e949032198e17d5d6b0cbf777` | `cd851920f29e47876105cd048ce6ef5ca81cc6f7` |
| `95bde9830fee081c5e11b47a39e1a388164c6cd0` | `d09be12959b92557c8788a77a4c2cccc089f6c1c` |
| `5a96b02e85ba95b9b7785207cc9fc069680f2a97` | `994f1a0a86b633b174e8d766c7b88b745bd9dfce` |
| `0058a5ee97c55bfd9bcca9c72de4ccd1ca75f833` | `49a72df9c8c8f4dc8e3de544ae8f347c11e64bf6` |
| `ca6ece322d23caa29eb9b90e8d41df4f088a8ada` | `dbd381df1ae7889215ca1c59372c13675d5af674` |
| `33186b4cea2843f97af2c18672841400ffcd589d` | `0a6e4b5ee554b59c9f3f5e427fe0538cde024da5` |
| `c743fd6c29ff5febc0074b2daaaf5c6be83fa4c5` | `0cd0de93fc16744b042dd230876a92a848283ec8` |
| `4d57af71ad215760002887a87fde3990b98453f9` | `bed47b6ce850a47fcf66167729808b1b781313ec` |

身份修正后以正常新提交 `b7371410175cc365436aff3dc0c23f840014769d` 交付 Qoder 模型请求无固定超时修复。远端回读确认 `main` 指向该提交，旧 tip 不再由任何远端分支引用；独立公开 clone 的 tracked tree 与完整 history 审计均通过。
