# Computer Use v2 live check (2026-11-07T04:19:24.636Z)

Rows: 36 · Failures: 0

本次运行存档：`runs/2026-11-07T04-19-24-636Z-live-check.md`

| Area | Action | Result | Note |
| --- | --- | --- | --- |
| helper | diagnostics | pass | protocol=9 expected=9 |
| helper | permissions | pass | accessibility=true screenRecording=true executable=~/cu-v2-test/pi-computer-use.app/Contents/MacOS/bridge |
| helper | userActivity | pass | idle=1130.8s userEvents=106 agentEvents=0 |
| app | launch | pass | already running, pid=5269 bundle=com.example.cu-fixture |
| app | present | pass | pid=5269 bundle=com.example.cu-fixture |
| root | listRoots | pass | windowId=2365 frame={"x":339,"y":286,"w":852,"h":450} |
| observe | window | pass | lookId=look_40 imageWidth=1704 nodes=39 |
| outline | find text | pass | e1540 |
| outline | find checkbox | pass | e1543 |
| outline | find slider | pass | e1544 |
| outline | find row | pass | e1557 |
| outline | find tree | pass | e1545 |
| act | focus | pass | outcome=worked delivery=ax mechanism=- |
| act | setText | pass | outcome=worked delivery=ax mechanism=- |
| act | clear | pass | outcome=worked delivery=ax mechanism=- |
| act | setChecked | pass | outcome=worked delivery=ax mechanism=- |
| act | setValue | pass | outcome=worked delivery=ax mechanism=- |
| act | select | pass | outcome=worked delivery=ax mechanism=- |
| act | collapse | pass | outcome=worked delivery=ax mechanism=axPress |
| act | expand | pass | outcome=worked delivery=ax mechanism=axPress |
| act | manageWindow.move | pass | outcome=worked delivery=? mechanism=- |
| manageWindow | moved | pass | {"x":339,"y":286,"w":852,"h":450} → {"x":383,"y":330,"w":852,"h":450} |
| act | manageWindow.resize | pass | outcome=worked delivery=? mechanism=- |
| manageWindow | resized | pass | asked {"w":804,"h":450}; got {"x":366,"y":313,"w":804,"h":450} |
| clipboard | set+get | pass | changeCount 80 → 81 |
| clipboard | clear | pass | cleared after probe |
| systemSurfaces | notifications | pass | roots=3 |
| systemSurfaces | menu_bar_extras | pass | roots=0 |
| systemSurfaces | control_center | pass | roots=0 |
| systemSurfaces | dock | pass | roots=0 |
| background | cursor unchanged | skipped | not judged in a --with-hid run: HID delivery moves the session cursor by design |
| background | frontmost app unchanged | skipped | not judged in a --with-hid run: HID delivery raises the target window by design |
| background | agent events marked | pass | agentEvents 0 → 2 |
| background | user events exclude agent input | pass | userEvents 106 → 106 (human input during the run) |
| act | click (HID delivery) | pass | outcome=unknown delivery=hid |
| background | frontmost restored | inconclusive | Scry → CU Fixture; bring your app back manually |

## Log

```
2026-11-07T04:19:19.432Z helper diagnostics pass protocol=9 expected=9
2026-11-07T04:19:19.432Z helper permissions pass accessibility=true screenRecording=true executable=~/cu-v2-test/pi-computer-use.app/Contents/MacOS/bridge
2026-11-07T04:19:19.432Z helper userActivity pass idle=1130.8s userEvents=106 agentEvents=0
2026-11-07T04:19:19.458Z app launch pass already running, pid=5269 bundle=com.example.cu-fixture
2026-11-07T04:19:19.458Z app present pass pid=5269 bundle=com.example.cu-fixture
2026-11-07T04:19:19.475Z root listRoots pass windowId=2365 frame={"x":339,"y":286,"w":852,"h":450}
2026-11-07T04:19:19.642Z observe window pass lookId=look_40 imageWidth=1704 nodes=39
2026-11-07T04:19:19.642Z outline find text pass e1540
2026-11-07T04:19:19.642Z outline find checkbox pass e1543
2026-11-07T04:19:19.642Z outline find slider pass e1544
2026-11-07T04:19:19.642Z outline find row pass e1557
2026-11-07T04:19:19.642Z outline find tree pass e1545
2026-11-07T04:19:20.077Z act focus pass outcome=worked delivery=ax mechanism=-
2026-11-07T04:19:20.560Z act setText pass outcome=worked delivery=ax mechanism=-
2026-11-07T04:19:21.018Z act clear pass outcome=worked delivery=ax mechanism=-
2026-11-07T04:19:21.458Z act setChecked pass outcome=worked delivery=ax mechanism=-
2026-11-07T04:19:21.901Z act setValue pass outcome=worked delivery=ax mechanism=-
2026-11-07T04:19:22.360Z act select pass outcome=worked delivery=ax mechanism=-
2026-11-07T04:19:22.907Z act collapse pass outcome=worked delivery=ax mechanism=axPress
2026-11-07T04:19:23.449Z act expand pass outcome=worked delivery=ax mechanism=axPress
2026-11-07T04:19:23.463Z act manageWindow.move pass outcome=worked delivery=? mechanism=-
2026-11-07T04:19:23.471Z manageWindow moved pass {"x":339,"y":286,"w":852,"h":450} → {"x":383,"y":330,"w":852,"h":450}
2026-11-07T04:19:23.512Z act manageWindow.resize pass outcome=worked delivery=? mechanism=-
2026-11-07T04:19:23.559Z manageWindow resized pass asked {"w":804,"h":450}; got {"x":366,"y":313,"w":804,"h":450}
2026-11-07T04:19:23.560Z clipboard set+get pass changeCount 80 → 81
2026-11-07T04:19:23.561Z clipboard clear pass cleared after probe
2026-11-07T04:19:23.577Z systemSurfaces notifications pass roots=3
2026-11-07T04:19:23.581Z systemSurfaces menu_bar_extras pass roots=0
2026-11-07T04:19:23.585Z systemSurfaces control_center pass roots=0
2026-11-07T04:19:23.589Z systemSurfaces dock pass roots=0
2026-11-07T04:19:23.594Z background cursor unchanged skipped not judged in a --with-hid run: HID delivery moves the session cursor by design
2026-11-07T04:19:23.594Z background frontmost app unchanged skipped not judged in a --with-hid run: HID delivery raises the target window by design
2026-11-07T04:19:23.808Z background agent events marked pass agentEvents 0 → 2
2026-11-07T04:19:23.808Z background user events exclude agent input pass userEvents 106 → 106 (human input during the run)
2026-11-07T04:19:23.808Z act click (HID delivery) pass outcome=unknown delivery=hid
2026-11-07T04:19:24.635Z background frontmost restored inconclusive Scry → CU Fixture; bring your app back manually
```
