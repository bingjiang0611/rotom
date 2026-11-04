# Computer Use v2 live check (2026-11-04T12:41:35.952Z)

Rows: 34 · Failures: 0

| Area | Action | Result | Note |
| --- | --- | --- | --- |
| helper | diagnostics | pass | protocol=8 |
| helper | permissions | pass | accessibility=true screenRecording=true executable=./pi-computer-use.app/Contents/MacOS/bridge |
| helper | userActivity | pass | idle=1.3s userEvents=17489 agentEvents=12 |
| app | launch | pass | already running, pid=74329 bundle=com.example.cu-fixture |
| app | present | pass | pid=74329 bundle=com.example.cu-fixture |
| root | listRoots | pass | windowId=23285 frame={"x":796,"y":702,"w":716,"h":576} |
| observe | window | pass | lookId=look_27 imageWidth=1432 nodes=36 |
| outline | find text | pass | e4671 |
| outline | find checkbox | pass | e4672 |
| outline | find slider | pass | e4673 |
| outline | find row | pass | e4685 |
| outline | find tree | pass | e4674 |
| act | focus | pass | outcome=worked delivery=ax mechanism=- |
| act | setText | pass | outcome=worked delivery=ax mechanism=- |
| act | clear | pass | outcome=worked delivery=ax mechanism=- |
| act | setChecked | pass | outcome=worked delivery=ax mechanism=- |
| act | setValue | pass | outcome=worked delivery=ax mechanism=- |
| act | select | pass | outcome=worked delivery=ax mechanism=- |
| act | collapse | pass | outcome=worked delivery=ax mechanism=axPress |
| act | expand | pass | outcome=worked delivery=ax mechanism=axPress |
| act | manageWindow.move | pass | outcome=worked delivery=? mechanism=- |
| manageWindow | moved | pass | {"x":796,"y":702,"w":716,"h":576} → {"x":840,"y":746,"w":716,"h":576} |
| act | manageWindow.resize | pass | outcome=worked delivery=? mechanism=- |
| manageWindow | resized | pass | asked {"w":668,"h":576}; got {"x":833,"y":740,"w":668,"h":576} |
| clipboard | set+get | pass | changeCount 1439 → 1440 |
| clipboard | clear | pass | cleared after probe |
| systemSurfaces | notifications | pass | roots=3 |
| systemSurfaces | menu_bar_extras | pass | roots=0 |
| systemSurfaces | control_center | pass | roots=0 |
| systemSurfaces | dock | pass | roots=0 |
| background | agent events marked | pass | agentEvents 12 → 14 |
| background | user events exclude agent input | pass | userEvents 17762 → 17762 (human input during the run) |
| act | click (HID delivery) | pass | outcome=unknown delivery=hid |
| background | frontmost restored | inconclusive | Google Chrome → Qoder; bring your app back manually |

## Log

```
2026-11-04T12:41:30.432Z helper diagnostics pass protocol=8
2026-11-04T12:41:30.433Z helper permissions pass accessibility=true screenRecording=true executable=./pi-computer-use.app/Contents/MacOS/bridge
2026-11-04T12:41:30.433Z helper userActivity pass idle=1.3s userEvents=17489 agentEvents=12
2026-11-04T12:41:30.491Z app launch pass already running, pid=74329 bundle=com.example.cu-fixture
2026-11-04T12:41:30.491Z app present pass pid=74329 bundle=com.example.cu-fixture
2026-11-04T12:41:30.570Z root listRoots pass windowId=23285 frame={"x":796,"y":702,"w":716,"h":576}
2026-11-04T12:41:30.896Z observe window pass lookId=look_27 imageWidth=1432 nodes=36
2026-11-04T12:41:30.896Z outline find text pass e4671
2026-11-04T12:41:30.896Z outline find checkbox pass e4672
2026-11-04T12:41:30.896Z outline find slider pass e4673
2026-11-04T12:41:30.896Z outline find row pass e4685
2026-11-04T12:41:30.896Z outline find tree pass e4674
2026-11-04T12:41:31.338Z act focus pass outcome=worked delivery=ax mechanism=-
2026-11-04T12:41:31.808Z act setText pass outcome=worked delivery=ax mechanism=-
2026-11-04T12:41:32.240Z act clear pass outcome=worked delivery=ax mechanism=-
2026-11-04T12:41:32.676Z act setChecked pass outcome=worked delivery=ax mechanism=-
2026-11-04T12:41:33.136Z act setValue pass outcome=worked delivery=ax mechanism=-
2026-11-04T12:41:33.568Z act select pass outcome=worked delivery=ax mechanism=-
2026-11-04T12:41:34.103Z act collapse pass outcome=worked delivery=ax mechanism=axPress
2026-11-04T12:41:34.661Z act expand pass outcome=worked delivery=ax mechanism=axPress
2026-11-04T12:41:34.681Z act manageWindow.move pass outcome=worked delivery=? mechanism=-
2026-11-04T12:41:34.695Z manageWindow moved pass {"x":796,"y":702,"w":716,"h":576} → {"x":840,"y":746,"w":716,"h":576}
2026-11-04T12:41:34.743Z act manageWindow.resize pass outcome=worked delivery=? mechanism=-
2026-11-04T12:41:34.775Z manageWindow resized pass asked {"w":668,"h":576}; got {"x":833,"y":740,"w":668,"h":576}
2026-11-04T12:41:34.777Z clipboard set+get pass changeCount 1439 → 1440
2026-11-04T12:41:34.778Z clipboard clear pass cleared after probe
2026-11-04T12:41:34.796Z systemSurfaces notifications pass roots=3
2026-11-04T12:41:34.809Z systemSurfaces menu_bar_extras pass roots=0
2026-11-04T12:41:34.826Z systemSurfaces control_center pass roots=0
2026-11-04T12:41:34.837Z systemSurfaces dock pass roots=0
2026-11-04T12:41:35.036Z background agent events marked pass agentEvents 12 → 14
2026-11-04T12:41:35.036Z background user events exclude agent input pass userEvents 17762 → 17762 (human input during the run)
2026-11-04T12:41:35.036Z act click (HID delivery) pass outcome=unknown delivery=hid
2026-11-04T12:41:35.952Z background frontmost restored inconclusive Google Chrome → Qoder; bring your app back manually
```
