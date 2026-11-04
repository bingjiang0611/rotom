# Computer Use v2 acceptance run, PLAN §10 (2026-11-04T15:17:44.827Z)

Rows: 47 · Failures: 0

Three fixture instances under distinct bundle identifiers work in the background while a
user simulator types 79 fixed characters into a new TextEdit document at 300/min and moves the real cursor.

| Area | Check | Result | Note |
| --- | --- | --- | --- |
| helper | diagnostics | pass | protocol=8 accessibility=true screenRecording=true |
| environment | operator app | pass | Scry pid=72651 |
| environment | TextEdit state | pass | not running |
| agent 1 | launch | pass | pid=39848 bundle=com.example.cu-fixture-instance1 |
| agent 2 | launch | pass | pid=39938 bundle=com.example.cu-fixture-instance2 |
| agent 3 | launch | pass | pid=40013 bundle=com.example.cu-fixture-instance3 |
| environment | fixture windows | pass | 3/3 instances up |
| simulator | TextEdit frontmost | pass | TextEdit pid=40208 |
| simulator | baseline windows | pass | window:25653,window:25655 |
| simulator | started | pass | 79 chars at 300/min for up to 22s |
| agent 2 | outline | pass | windowId=25631 missing=none |
| agent 3 | outline | pass | windowId=25633 missing=none |
| agent 1 | outline | pass | windowId=25622 missing=none |
| agent 2 | setText | pass | outcome=worked delivery=ax |
| agent 3 | setText | pass | outcome=worked delivery=ax |
| agent 1 | setText | pass | outcome=worked delivery=ax |
| agent 2 | setChecked | pass | outcome=worked delivery=ax |
| agent 3 | setChecked | pass | outcome=worked delivery=ax |
| agent 1 | setChecked | pass | outcome=worked delivery=ax |
| agent 2 | setValue | pass | outcome=worked delivery=ax |
| agent 3 | setValue | pass | outcome=worked delivery=ax |
| agent 1 | setValue | pass | outcome=worked delivery=ax |
| agent 2 | select | pass | outcome=worked delivery=ax |
| agent 3 | select | pass | outcome=worked delivery=ax |
| agent 1 | select | pass | outcome=worked delivery=ax |
| agent 2 | click | inconclusive | outcome=unknown delivery=ax |
| agent 2 | tab switched (readback) | pass | e1192:,e1193: → e1303:,e1304: |
| agent 3 | click | inconclusive | outcome=unknown delivery=ax |
| agent 3 | tab switched (readback) | pass | e1229:,e1231: → e1377:,e1378: |
| agent 1 | click | inconclusive | outcome=unknown delivery=ax |
| agent 1 | tab switched (readback) | pass | e1266:,e1267: → e1441:,e1443: |
| agent 2 | expand | pass | outcome=worked delivery=ax |
| agent 3 | expand | pass | outcome=worked delivery=ax |
| agent 1 | expand | pass | outcome=worked delivery=ax |
| simulator | typed all characters | pass | exit=0 userEvents 54785 → 54957 agentEvents 0 → 0 |
| simulator | log | pass | chars=79 moves=14 |
| assert | 1 typed text matches document | pass | 79 chars |
| assert | 2 frontmost app unchanged | pass | TextEdit → TextEdit |
| assert | 2 focused windows unchanged | pass | window:25653,window:25655 → window:25653,window:25655 |
| assert | 3 cursor only moved by simulator | pass | 8 movements observed, all matched a simulator move |
| assert | 4 tasks completed or explicit | pass | 15 worked, 0 foreground_required, 0 failed |
| cleanup | test document closed | pass | saving no |
| cleanup | TextEdit quit | pass | it was not running before the run |
| cleanup | fixture 1 quit | pass | pid=39848 |
| cleanup | fixture 2 quit | pass | pid=39938 |
| cleanup | fixture 3 quit | pass | pid=40013 |
| cleanup | operator app restored | pass | Scry → Scry; bring your app back manually if this says inconclusive |

## Log

```
2026-11-04T15:17:18.037Z helper diagnostics pass protocol=8 accessibility=true screenRecording=true
2026-11-04T15:17:18.046Z environment operator app pass Scry pid=72651
2026-11-04T15:17:18.074Z environment TextEdit state pass not running
2026-11-04T15:17:19.076Z agent 1 launch pass pid=39848 bundle=com.example.cu-fixture-instance1
2026-11-04T15:17:21.176Z agent 2 launch pass pid=39938 bundle=com.example.cu-fixture-instance2
2026-11-04T15:17:21.334Z agent 3 launch pass pid=40013 bundle=com.example.cu-fixture-instance3
2026-11-04T15:17:21.458Z environment fixture windows pass 3/3 instances up
2026-11-04T15:17:25.593Z simulator TextEdit frontmost pass TextEdit pid=40208
2026-11-04T15:17:25.607Z simulator baseline windows pass window:25653,window:25655
2026-11-04T15:17:25.608Z simulator started pass 79 chars at 300/min for up to 22s
2026-11-04T15:17:25.722Z agent 2 outline pass windowId=25631 missing=none
2026-11-04T15:17:25.728Z agent 3 outline pass windowId=25633 missing=none
2026-11-04T15:17:25.734Z agent 1 outline pass windowId=25622 missing=none
2026-11-04T15:17:26.203Z agent 2 setText pass outcome=worked delivery=ax
2026-11-04T15:17:26.226Z agent 3 setText pass outcome=worked delivery=ax
2026-11-04T15:17:26.256Z agent 1 setText pass outcome=worked delivery=ax
2026-11-04T15:17:26.717Z agent 2 setChecked pass outcome=worked delivery=ax
2026-11-04T15:17:26.751Z agent 3 setChecked pass outcome=worked delivery=ax
2026-11-04T15:17:26.821Z agent 1 setChecked pass outcome=worked delivery=ax
2026-11-04T15:17:27.189Z agent 2 setValue pass outcome=worked delivery=ax
2026-11-04T15:17:27.229Z agent 3 setValue pass outcome=worked delivery=ax
2026-11-04T15:17:27.263Z agent 1 setValue pass outcome=worked delivery=ax
2026-11-04T15:17:27.630Z agent 2 select pass outcome=worked delivery=ax
2026-11-04T15:17:27.681Z agent 3 select pass outcome=worked delivery=ax
2026-11-04T15:17:27.749Z agent 1 select pass outcome=worked delivery=ax
2026-11-04T15:17:28.249Z agent 2 click inconclusive outcome=unknown delivery=ax
2026-11-04T15:17:28.298Z agent 2 tab switched (readback) pass e1192:,e1193: → e1303:,e1304:
2026-11-04T15:17:28.347Z agent 3 click inconclusive outcome=unknown delivery=ax
2026-11-04T15:17:28.392Z agent 3 tab switched (readback) pass e1229:,e1231: → e1377:,e1378:
2026-11-04T15:17:28.396Z agent 1 click inconclusive outcome=unknown delivery=ax
2026-11-04T15:17:28.447Z agent 1 tab switched (readback) pass e1266:,e1267: → e1441:,e1443:
2026-11-04T15:17:28.806Z agent 2 expand pass outcome=worked delivery=ax
2026-11-04T15:17:28.888Z agent 3 expand pass outcome=worked delivery=ax
2026-11-04T15:17:28.929Z agent 1 expand pass outcome=worked delivery=ax
2026-11-04T15:17:41.930Z simulator typed all characters pass exit=0 userEvents 54785 → 54957 agentEvents 0 → 0
2026-11-04T15:17:41.931Z simulator log pass chars=79 moves=14
2026-11-04T15:17:42.147Z assert 1 typed text matches document pass 79 chars
2026-11-04T15:17:42.173Z assert 2 frontmost app unchanged pass TextEdit → TextEdit
2026-11-04T15:17:42.173Z assert 2 focused windows unchanged pass window:25653,window:25655 → window:25653,window:25655
2026-11-04T15:17:42.173Z assert 3 cursor only moved by simulator pass 8 movements observed, all matched a simulator move
2026-11-04T15:17:42.173Z assert 4 tasks completed or explicit pass 15 worked, 0 foreground_required, 0 failed
2026-11-04T15:17:42.455Z cleanup test document closed pass saving no
2026-11-04T15:17:42.775Z cleanup TextEdit quit pass it was not running before the run
2026-11-04T15:17:43.155Z cleanup fixture 1 quit pass pid=39848
2026-11-04T15:17:43.513Z cleanup fixture 2 quit pass pid=39938
2026-11-04T15:17:43.622Z cleanup fixture 3 quit pass pid=40013
2026-11-04T15:17:44.827Z cleanup operator app restored pass Scry → Scry; bring your app back manually if this says inconclusive
```
