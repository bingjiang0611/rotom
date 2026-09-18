#!/usr/bin/env python3
"""Actual product CLI/PTY content check with synthetic saved state and isolated HOME.
No model prompt or credentials. Not a desktop layout/screenshot assertion.
Usage: python3 goal-pty.py /absolute/product /absolute/private/evidence
"""
import fcntl, json, os, pathlib, pty, re, select, signal, struct, subprocess, sys, termios, time, uuid
product = pathlib.Path(sys.argv[1]).resolve(strict=True)
evidence = pathlib.Path(sys.argv[2]).resolve(strict=True)
os.umask(0o077)
ansi = re.compile(r'\x1b\].*?(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]', re.S)
results = []
for used, cause, command in [(25, None, '/goal status'), (100, 'continuation_limit', '/goal')]:
    work = evidence / ('goal-pty-' + str(used)); work.mkdir()
    home = work / 'home'; home.mkdir()
    session = work / 'session.jsonl'
    goal = dict(id=str(uuid.uuid4()), text='Inspect synthetic receipt', status='paused', startedAt=1, updatedAt=1, iteration=2,
                tokensUsed=1234, timeUsedSeconds=60, baselineTokens=0, automaticModelTurns=used, toolFreeRepeatCount=0,
                lastContinuationAction='Inspect synthetic receipt without replaying the write')
    if cause: goal['safetyPauseCause'] = cause
    session.write_text('\n'.join(json.dumps(row) for row in [
        dict(type='session', version=3, id=str(uuid.uuid4()), timestamp='2026-01-01T00:00:00.000Z', cwd=str(work)),
        dict(type='custom', id='state', parentId=None, timestamp='2026-01-01T00:00:00.001Z', customType='goal-state', data=dict(goal=goal))]) + '\n')
    env = {**os.environ, 'HOME':str(home), 'PI_CODING_AGENT_DIR':str(home / '.pi/agent'), 'TERM':'xterm-256color',
           'PI_OFFLINE':'1', 'PI_SKIP_VERSION_CHECK':'1', 'PI_TELEMETRY':'0', 'ROTOM_OBSERVABILITY':'0', 'ROTOM_QODER':'0'}
    for key in ['ROTOM_PI', 'NODE_OPTIONS', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY']: env.pop(key, None)
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 48, 180, 0, 0))
    proc = subprocess.Popen([str(product / 'bin/rotom'), '--session', str(session)], cwd=work, env=env,
                            stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
    os.close(slave)
    raw = b''; sent = False; passed = False; sent_at = 0; opened_review = False
    try:
        deadline = time.monotonic() + 35
        while time.monotonic() < deadline:
            if select.select([master], [], [], .1)[0]:
                try: chunk = os.read(master, 65536)
                except OSError: break
                raw += chunk
                if b'\x1b[6n' in chunk: os.write(master, b'\x1b[1;1R')
            text = ansi.sub('', raw.decode('utf8', 'replace'))
            footer = ('75 left' in text) if used == 25 else ('automatic limit 100/100' in text)
            if footer and not sent:
                sent_at = len(raw); os.write(master, command.encode() + b'\r'); sent = True
            if sent:
                view = ansi.sub('', raw[sent_at:].decode('utf8', 'replace'))
                if used == 100 and not opened_review and 'Review and continue' in view:
                    os.write(master, b'\r'); opened_review = True
                passed = 'Last recorded next step (plan, not progress)' in view and 'Inspect synthetic receipt without replaying the write' in view
                if passed: break
            if proc.poll() is not None: break
        (work / 'terminal.private').write_bytes(raw)
    finally:
        # Drain while requesting normal CLI exit; waiting without reading the PTY
        # can deadlock a terminal redraw during shutdown. Never wait unbounded.
        if proc.poll() is None:
            os.write(master, b'\x1b\x04')
            until = time.monotonic() + 5
            while proc.poll() is None and time.monotonic() < until:
                if select.select([master], [], [], .1)[0]:
                    try: os.read(master, 65536)
                    except OSError: break
        os.close(master)
        if proc.poll() is None:
            proc.kill()
            try: proc.wait(timeout=2)
            except subprocess.TimeoutExpired: pass
    rows = [json.loads(line) for line in session.read_text().splitlines()]
    no_model = not any(row.get('message', {}).get('role') == 'assistant' for row in rows)
    results.append(dict(used=used, command=command, footer=footer, planDisplayed=passed, noAssistantResponses=no_model, pass_=passed and no_model))
(evidence / 'goal-pty-results.json').write_text(json.dumps(results, indent=2) + '\n')
print(json.dumps(results))
assert all(row['pass_'] for row in results)
