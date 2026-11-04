# Computer Use v2 acceptance run, PLAN §10 (2026-11-04T15:33:22.396Z)

Rows: 47 · Failures: 0

Three fixture instances under distinct bundle identifiers work in the background while a
user simulator types 79 fixed characters into a new TextEdit document at 300/min and moves the real cursor.

| Area | Check | Result | Note |
| --- | --- | --- | --- |
| helper | diagnostics | pass | protocol=8 accessibility=true screenRecording=true |
| environment | operator app | pass | Google Chrome pid=587 |
| environment | TextEdit state | pass | not running |
| agent 1 | launch | pass | pid=94327 bundle=com.example.cu-fixture-instance1 |
| agent 2 | launch | pass | pid=94403 bundle=com.example.cu-fixture-instance2 |
| agent 3 | launch | pass | pid=94464 bundle=com.example.cu-fixture-instance3 |
| environment | fixture windows | pass | 3/3 instances up |
| simulator | TextEdit frontmost | pass | TextEdit pid=94502 |
| simulator | baseline windows | pass | window:25849,window:25842 |
| simulator | started | pass | 79 chars at 300/min for up to 22s |
| agent 3 | outline | pass | windowId=25833 missing=none |
| agent 1 | outline | pass | windowId=25815 missing=none |
| agent 2 | outline | pass | windowId=25824 missing=none |
| agent 2 | setText | pass | outcome=worked delivery=ax |
| agent 3 | setText | pass | outcome=worked delivery=ax |
| agent 1 | setText | pass | outcome=worked delivery=ax |
| agent 2 | setChecked | pass | outcome=worked delivery=ax |
| agent 3 | setChecked | pass | outcome=worked delivery=ax |
| agent 1 | setChecked | pass | outcome=worked delivery=ax |
| agent 2 | setValue | pass | outcome=worked delivery=ax |
| agent 1 | setValue | pass | outcome=worked delivery=ax |
| agent 3 | setValue | pass | outcome=worked delivery=ax |
| agent 3 | select | pass | outcome=worked delivery=ax |
| agent 1 | select | pass | outcome=worked delivery=ax |
| agent 2 | select | pass | outcome=worked delivery=ax |
| agent 3 | click | inconclusive | outcome=unknown delivery=ax |
| agent 1 | click | inconclusive | outcome=unknown delivery=ax |
| agent 2 | click | inconclusive | outcome=unknown delivery=ax |
| agent 3 | tab switched (readback) | pass | e5418,e5422 → e5520,e5524 |
| agent 1 | tab switched (readback) | pass | e5420,e5425 → e5536,e5541 |
| agent 2 | tab switched (readback) | pass | e5431,e5434 → e5544,e5548 |
| agent 2 | expand | pass | outcome=worked delivery=ax |
| agent 3 | expand | pass | outcome=worked delivery=ax |
| agent 1 | expand | pass | outcome=worked delivery=ax |
| simulator | typed all characters | pass | exit=0 userEvents 63211 → 63383 agentEvents 0 → 0 |
| simulator | log | pass | chars=79 moves=14 |
| assert | 1 typed text matches document | pass | 79 chars |
| assert | 2 frontmost app unchanged | pass | TextEdit → TextEdit |
| assert | 2 focused windows unchanged | pass | window:25849,window:25842 → window:25849,window:25842 |
| assert | 3 cursor only moved by simulator | pass | 9 movements observed, all matched a simulator move |
| assert | 4 tasks completed or explicit | pass | 15 worked, 0 foreground_required, 0 failed |
| cleanup | test document closed | pass | saving no |
| cleanup | TextEdit quit | pass | it was not running before the run |
| cleanup | fixture 1 quit | pass | pid=94327 |
| cleanup | fixture 2 quit | pass | pid=94403 |
| cleanup | fixture 3 quit | pass | pid=94464 |
| cleanup | operator app restored | pass | Google Chrome → Google Chrome; bring your app back manually if this says inconclusive |

## Log

```
2026-11-04T15:32:54.022Z helper diagnostics pass protocol=8 accessibility=true screenRecording=true
2026-11-04T15:32:54.067Z environment operator app pass Google Chrome pid=587
2026-11-04T15:32:54.067Z environment TextEdit state pass not running
2026-11-04T15:32:56.812Z agent 1 launch pass pid=94327 bundle=com.example.cu-fixture-instance1
2026-11-04T15:32:58.467Z agent 2 launch pass pid=94403 bundle=com.example.cu-fixture-instance2
2026-11-04T15:32:59.297Z agent 3 launch pass pid=94464 bundle=com.example.cu-fixture-instance3
2026-11-04T15:32:59.497Z environment fixture windows pass 3/3 instances up
2026-11-04T15:33:03.514Z simulator TextEdit frontmost pass TextEdit pid=94502
2026-11-04T15:33:03.523Z simulator baseline windows pass window:25849,window:25842
2026-11-04T15:33:03.524Z simulator started pass 79 chars at 300/min for up to 22s
2026-11-04T15:33:03.612Z agent 3 outline pass windowId=25833 missing=none
2026-11-04T15:33:03.613Z agent 1 outline pass windowId=25815 missing=none
2026-11-04T15:33:03.614Z agent 2 outline pass windowId=25824 missing=none
2026-11-04T15:33:04.106Z agent 2 setText pass outcome=worked delivery=ax
2026-11-04T15:33:04.119Z agent 3 setText pass outcome=worked delivery=ax
2026-11-04T15:33:04.130Z agent 1 setText pass outcome=worked delivery=ax
2026-11-04T15:33:04.645Z agent 2 setChecked pass outcome=worked delivery=ax
2026-11-04T15:33:04.666Z agent 3 setChecked pass outcome=worked delivery=ax
2026-11-04T15:33:04.672Z agent 1 setChecked pass outcome=worked delivery=ax
2026-11-04T15:33:05.120Z agent 2 setValue pass outcome=worked delivery=ax
2026-11-04T15:33:05.145Z agent 1 setValue pass outcome=worked delivery=ax
2026-11-04T15:33:05.152Z agent 3 setValue pass outcome=worked delivery=ax
2026-11-04T15:33:05.627Z agent 3 select pass outcome=worked delivery=ax
2026-11-04T15:33:05.627Z agent 1 select pass outcome=worked delivery=ax
2026-11-04T15:33:05.628Z agent 2 select pass outcome=worked delivery=ax
2026-11-04T15:33:06.257Z agent 3 click inconclusive outcome=unknown delivery=ax
2026-11-04T15:33:06.262Z agent 1 click inconclusive outcome=unknown delivery=ax
2026-11-04T15:33:06.265Z agent 2 click inconclusive outcome=unknown delivery=ax
2026-11-04T15:33:06.298Z agent 3 tab switched (readback) pass e5418,e5422 → e5520,e5524
2026-11-04T15:33:06.302Z agent 1 tab switched (readback) pass e5420,e5425 → e5536,e5541
2026-11-04T15:33:06.304Z agent 2 tab switched (readback) pass e5431,e5434 → e5544,e5548
2026-11-04T15:33:06.825Z agent 2 expand pass outcome=worked delivery=ax
2026-11-04T15:33:06.826Z agent 3 expand pass outcome=worked delivery=ax
2026-11-04T15:33:06.840Z agent 1 expand pass outcome=worked delivery=ax
2026-11-04T15:33:19.702Z simulator typed all characters pass exit=0 userEvents 63211 → 63383 agentEvents 0 → 0
2026-11-04T15:33:19.702Z simulator log pass chars=79 moves=14
2026-11-04T15:33:19.899Z assert 1 typed text matches document pass 79 chars
2026-11-04T15:33:19.920Z assert 2 frontmost app unchanged pass TextEdit → TextEdit
2026-11-04T15:33:19.920Z assert 2 focused windows unchanged pass window:25849,window:25842 → window:25849,window:25842
2026-11-04T15:33:19.920Z assert 3 cursor only moved by simulator pass 9 movements observed, all matched a simulator move
2026-11-04T15:33:19.921Z assert 4 tasks completed or explicit pass 15 worked, 0 foreground_required, 0 failed
2026-11-04T15:33:20.178Z cleanup test document closed pass saving no
2026-11-04T15:33:20.431Z cleanup TextEdit quit pass it was not running before the run
2026-11-04T15:33:20.662Z cleanup fixture 1 quit pass pid=94327
2026-11-04T15:33:20.824Z cleanup fixture 2 quit pass pid=94403
2026-11-04T15:33:20.923Z cleanup fixture 3 quit pass pid=94464
2026-11-04T15:33:22.396Z cleanup operator app restored pass Google Chrome → Google Chrome; bring your app back manually if this says inconclusive
```
