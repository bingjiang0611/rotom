# Computer Use v2 live check (2026-11-04T15:12:29.636Z)

Rows: 33 · Failures: 0

| Area | Action | Result | Note |
| --- | --- | --- | --- |
| helper | diagnostics | pass | protocol=8 |
| helper | permissions | pass | accessibility=true screenRecording=true executable=./pi-computer-use.app/Contents/MacOS/bridge |
| helper | userActivity | pass | idle=173.3s userEvents=53168 agentEvents=0 |
| app | launch | pass | already running, pid=1325 bundle=com.example.cu-fixture |
| app | present | pass | pid=1325 bundle=com.example.cu-fixture |
| root | listRoots | pass | windowId=25305 frame={"x":833,"y":300,"w":668,"h":576} |
| observe | window | pass | lookId=look_1 imageWidth=1336 nodes=36 |
| outline | find text | pass | e10 |
| outline | find checkbox | pass | e11 |
| outline | find slider | pass | e12 |
| outline | find row | pass | e24 |
| outline | find tree | pass | e13 |
| act | focus | pass | outcome=worked delivery=ax mechanism=- |
| act | setText | pass | outcome=worked delivery=ax mechanism=- |
| act | clear | pass | outcome=worked delivery=ax mechanism=- |
| act | setChecked | pass | outcome=worked delivery=ax mechanism=axPress |
| act | setValue | pass | outcome=worked delivery=ax mechanism=- |
| act | select | pass | outcome=worked delivery=ax mechanism=- |
| act | collapse | pass | outcome=worked delivery=ax mechanism=axPress |
| act | expand | pass | outcome=worked delivery=ax mechanism=axPress |
| act | manageWindow.move | pass | outcome=worked delivery=? mechanism=- |
| manageWindow | moved | pass | {"x":833,"y":300,"w":668,"h":576} → {"x":877,"y":344,"w":668,"h":576} |
| act | manageWindow.resize | pass | outcome=worked delivery=? mechanism=- |
| manageWindow | resized | pass | asked {"w":620,"h":576}; got {"x":870,"y":338,"w":620,"h":576} |
| clipboard | set+get | pass | changeCount 1518 → 1519 |
| clipboard | clear | pass | cleared after probe |
| systemSurfaces | notifications | pass | roots=3 |
| systemSurfaces | menu_bar_extras | pass | roots=0 |
| systemSurfaces | control_center | pass | roots=0 |
| systemSurfaces | dock | pass | roots=0 |
| background | cursor unchanged | pass | (491.25,380.57421875) → (491.25,380.57421875) delta=0.0pt |
| background | frontmost app unchanged | pass | Electron (86640) → Electron (86640) |
| background | agent events marked | skipped | run with --with-hid to post real input events |

## Log

```
2026-11-04T15:12:24.785Z helper diagnostics pass protocol=8
2026-11-04T15:12:24.794Z helper permissions pass accessibility=true screenRecording=true executable=./pi-computer-use.app/Contents/MacOS/bridge
2026-11-04T15:12:24.798Z helper userActivity pass idle=173.3s userEvents=53168 agentEvents=0
2026-11-04T15:12:24.853Z app launch pass already running, pid=1325 bundle=com.example.cu-fixture
2026-11-04T15:12:24.853Z app present pass pid=1325 bundle=com.example.cu-fixture
2026-11-04T15:12:24.935Z root listRoots pass windowId=25305 frame={"x":833,"y":300,"w":668,"h":576}
2026-11-04T15:12:25.461Z observe window pass lookId=look_1 imageWidth=1336 nodes=36
2026-11-04T15:12:25.461Z outline find text pass e10
2026-11-04T15:12:25.461Z outline find checkbox pass e11
2026-11-04T15:12:25.461Z outline find slider pass e12
2026-11-04T15:12:25.461Z outline find row pass e24
2026-11-04T15:12:25.461Z outline find tree pass e13
2026-11-04T15:12:25.927Z act focus pass outcome=worked delivery=ax mechanism=-
2026-11-04T15:12:26.380Z act setText pass outcome=worked delivery=ax mechanism=-
2026-11-04T15:12:26.841Z act clear pass outcome=worked delivery=ax mechanism=-
2026-11-04T15:12:27.376Z act setChecked pass outcome=worked delivery=ax mechanism=axPress
2026-11-04T15:12:27.862Z act setValue pass outcome=worked delivery=ax mechanism=-
2026-11-04T15:12:28.312Z act select pass outcome=worked delivery=ax mechanism=-
2026-11-04T15:12:28.859Z act collapse pass outcome=worked delivery=ax mechanism=axPress
2026-11-04T15:12:29.397Z act expand pass outcome=worked delivery=ax mechanism=axPress
2026-11-04T15:12:29.410Z act manageWindow.move pass outcome=worked delivery=? mechanism=-
2026-11-04T15:12:29.434Z manageWindow moved pass {"x":833,"y":300,"w":668,"h":576} → {"x":877,"y":344,"w":668,"h":576}
2026-11-04T15:12:29.476Z act manageWindow.resize pass outcome=worked delivery=? mechanism=-
2026-11-04T15:12:29.505Z manageWindow resized pass asked {"w":620,"h":576}; got {"x":870,"y":338,"w":620,"h":576}
2026-11-04T15:12:29.509Z clipboard set+get pass changeCount 1518 → 1519
2026-11-04T15:12:29.510Z clipboard clear pass cleared after probe
2026-11-04T15:12:29.549Z systemSurfaces notifications pass roots=3
2026-11-04T15:12:29.581Z systemSurfaces menu_bar_extras pass roots=0
2026-11-04T15:12:29.602Z systemSurfaces control_center pass roots=0
2026-11-04T15:12:29.628Z systemSurfaces dock pass roots=0
2026-11-04T15:12:29.636Z background cursor unchanged pass (491.25,380.57421875) → (491.25,380.57421875) delta=0.0pt
2026-11-04T15:12:29.636Z background frontmost app unchanged pass Electron (86640) → Electron (86640)
2026-11-04T15:12:29.636Z background agent events marked skipped run with --with-hid to post real input events
```
