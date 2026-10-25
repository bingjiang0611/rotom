import { COPY } from "./copy.mjs";
export const evalMarkup = '<section id="eval-workspace" hidden></section>';
export const evalStyles = `
[hidden]{display:none!important}
body.eval-active .signal-region,body.eval-active .workspace{display:none}
body.eval-active .app-shell{grid-template-rows:58px minmax(0,1fr) 28px}
#eval-workspace{min-height:0;display:grid;grid-template-columns:340px minmax(0,1fr);background:#101112}
.eval-sidebar{border-right:1px solid #424744;overflow:auto;padding:20px}
.eval-heading{font-size:20px;margin:0 0 6px;font-weight:600;letter-spacing:-.02em}
.eval-muted{overflow-wrap:anywhere;color:#aab1ad;font-size:12px;line-height:1.7}
.eval-filter,.eval-note{width:100%;background:#181c1a;color:#e6ede7;border:1px solid #68716b;padding:10px;margin:10px 0;font:inherit;border-radius:3px}
.eval-session{display:block;width:100%;text-align:left;background:transparent;color:inherit;border:0;border-bottom:1px solid #424744;padding:16px 8px;cursor:pointer;font:inherit}
.eval-session:hover,.eval-session[aria-current=true]{background:#252e27;border-left:3px solid #b5e57a;padding-left:5px}
.eval-request{font-size:14px;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere;margin:8px 0}
.eval-detail{overflow:auto;min-width:0;padding:28px clamp(20px,4vw,64px)}
.eval-detail h2{font-size:22px;margin:0 0 18px}.eval-detail h3{font-size:15px;margin:24px 0 12px}
.eval-button{padding:9px 14px;border:1px solid #68716b;border-radius:3px;background:#1b211d;color:#e6ede7;font:inherit;cursor:pointer;margin:4px 8px 4px 0}
.eval-button.primary,.eval-button[aria-pressed=true]{background:#b5e57a;color:#13200e;border-color:#b5e57a}.eval-button:disabled{opacity:.45;cursor:not-allowed}
.eval-button:focus-visible,.eval-session:focus-visible{outline:2px solid #b5e57a;outline-offset:3px}
.eval-review{padding:18px;border:1px solid #59645c;background:#181e19;margin-bottom:24px;max-width:900px}
.eval-review label{display:block}.eval-review input[type=checkbox]{margin-right:8px}.eval-note{min-height:64px;resize:vertical}
.eval-text{white-space:pre-wrap;overflow-wrap:anywhere;margin:8px 0;color:#dbe3dc;line-height:1.75;max-width:960px}
.eval-event{border-left:2px solid #536358;padding:0 0 18px 18px;margin:16px 0}.eval-event.error{border-color:#ee8c7e}.eval-error{color:#ffac9f}.eval-event pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.6 var(--mono);max-height:360px;overflow:auto;background:#090c0a;padding:12px}.eval-event summary{cursor:pointer;color:#b8c9bd;padding:6px 0}
.eval-status{min-height:22px}.eval-badges{display:flex;gap:8px;flex-wrap:wrap}.eval-badge{padding:2px 7px;background:#252e27;color:#c8ddb2;border-radius:3px;font-size:11px}
@media(max-width:800px){#eval-workspace{grid-template-columns:1fr}.eval-sidebar{max-height:45vh;border-bottom:1px solid #424744}.eval-detail{overflow:visible}.eval-active .app-shell{display:block}.eval-active .top-context,.eval-active .key-hint{display:none}.eval-active .topbar{height:auto;min-height:60px;flex-wrap:wrap}.eval-active .top-actions{margin-left:0;min-width:0;flex-wrap:wrap}.eval-active .view-switch{flex-wrap:wrap}.eval-active .app-footer{height:auto;min-height:28px;flex-wrap:wrap;overflow-wrap:anywhere}.eval-active .security{white-space:normal}}
`;

export const evalScript = `(() => {
    'use strict';
    const C = ${JSON.stringify(COPY)};
    const traceSecurity = document.querySelector('.security').textContent;
    const token = new URLSearchParams(location.hash.slice(1)).get('token') || '';
    const root = document.getElementById('eval-workspace');
    const header = document.querySelector('.topbar');
    header.after(root);
    const make = (tag, cls, text) => { const node = document.createElement(tag); if (cls)
        node.className = cls; if (text !== undefined)
        node.textContent = String(text); return node; };
    const button = (text, action, cls = '') => { const node = make('button', 'eval-button ' + cls, text); node.type = 'button'; node.onclick = action; return node; };
    const tab = make('button', 'view-button', C.tab);
    tab.id = 'view-eval';
    tab.type = 'button';
    tab.setAttribute('aria-pressed', 'false');
    document.querySelector('.view-switch').append(tab);
    let enabled = false, rows = [], cursor = null, selected = null, filter = 'all', generation = 0, detailGeneration = 0;
    const sidebar = make('aside', 'eval-sidebar'), detail = make('main', 'eval-detail');
    root.append(sidebar, detail);
    sidebar.append(make('h2', 'eval-heading', C.title), make('div', 'eval-muted', C.subtitle));
    const select = make('select', 'eval-filter');
    select.id = 'eval-filter';
    select.setAttribute('aria-label', C.filters);
    for (const key of ['all', 'unlabeled', 'fail', 'failSet', 'hits']) {
        const option = make('option', '', C[key]);
        option.value = key;
        select.append(option);
    }
    sidebar.append(select);
    const status = make('div', 'eval-status eval-muted');
    status.setAttribute('role', 'status');
    const list = make('div', 'eval-list');
    sidebar.append(status, list);
    const more = button(C.more, () => loadList(false));
    more.id = 'eval-more';
    sidebar.append(more);
    detail.append(make('p', 'eval-muted', C.choose));
    const label = row => row.annotation?.failSet ? C.failSet : row.annotation?.verdict === 'fail' ? C.fail : row.annotation?.verdict === 'pass' ? C.pass : C.noLabel;
    const number = value => value === null || value === undefined ? C.unknown : new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value);
    const metricText = row => C.tools + ' ' + number(row.metrics?.toolCalls) + ' / ' + number(row.metrics?.toolErrors) + ' · ' + C.duration + ' ' + number(row.metrics?.durationMs == null ? null : row.metrics.durationMs / 60000) + ' · ' + C.cost + ' ' + number(row.metrics?.costUsd);
    async function get(path) { const response = await fetch(path, { headers: { authorization: 'Bearer ' + token }, cache: 'no-store' }); if (!response.ok)
        throw new Error(C.readError + ' (HTTP ' + response.status + ')'); return response.json(); }
    function renderList() { list.replaceChildren(); for (const row of rows) {
        if ((filter === 'unlabeled' && row.annotation) || (filter === 'fail' && row.annotation?.verdict !== 'fail') || (filter === 'failSet' && !row.annotation?.failSet))
            continue;
        const node = make('button', 'eval-session');
        node.type = 'button';
        node.dataset.sessionId = row.id;
        node.setAttribute('aria-current', String(selected === row.id));
        node.append(make('div', 'eval-muted', row.started + ' · ' + row.state), make('p', 'eval-request', row.request || C.unavailable), make('div', 'eval-muted', metricText(row)));
        const badges = make('div', 'eval-badges');
        badges.append(make('span', 'eval-badge', label(row)));
        for (const hit of row.findings.filter(x => x.status === 'hit'))
            badges.append(make('span', 'eval-badge', hit.rule));
        node.append(badges);
        node.onclick = () => openSession(row.id);
        list.append(node);
    } if (!rows.length)
        list.append(make('p', 'eval-muted', C.empty)); more.hidden = !cursor; }
    async function loadList(reset) { const seq = ++generation; more.disabled = true; select.disabled = true; status.textContent = C.loading; if (reset) {
        rows = [];
        cursor = null;
    } try {
        let data;
        do {
            data = await get('/api/eval/sessions?filter=' + encodeURIComponent(filter) + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
            if (seq !== generation)
                return;
            rows.push(...data.items);
            cursor = data.nextCursor;
        } while (!rows.length && cursor);
        status.textContent = C.listCount + ' ' + rows.length + ' / ' + data.total + ' · ' + C.states + ' ' + C.activeShort + ' ' + data.states.active + ' / ' + C.idleShort + ' ' + data.states.idle + ' / ' + C.unknown + ' ' + data.states.unknown + (data.limited ? ' · ' + C.partial : '');
        renderList();
    }
    catch (error) {
        status.textContent = error.message;
    }
    finally {
        more.disabled = false;
        select.disabled = false;
    } }
    function textBlock(title, value) { const box = make('section'); box.append(make('h3', '', title), make('p', 'eval-text', value.text)); if (value.truncated)
        box.append(make('span', 'eval-muted', C.truncated)); return box; }
    function timeline(data) { const section = make('section'); section.id = 'eval-timeline'; section.append(make('h3', '', C.timeline), make('p', 'eval-muted', C.pageEvents + ' ' + data.timeline.items.length + ' / ' + data.timeline.total)); for (const event of data.timeline.items) {
        const box = make('article', 'eval-event' + (event.failed ? ' error' : ''));
        box.dataset.index = event.index;
        if (event.kind === 'tool') {
            box.append(make('strong', event.failed ? 'eval-error' : '', event.name + ' · ' + event.outcome));
            if (event.firstError)
                box.append(make('p', 'eval-error', C.firstError));
            for (const key of ['args', 'result']) {
                const folded = make('details');
                folded.append(make('summary', '', C[key]), make('pre', '', event[key].text));
                if (event[key].truncated)
                    folded.append(make('span', 'eval-muted', C.truncated));
                box.append(folded);
            }
        }
        else {
            box.append(make('strong', '', C[event.kind]), make('p', 'eval-text', event.content.text));
            if (event.firstError)
                box.append(make('p', 'eval-error', C.firstError));
            if (event.content.truncated)
                box.append(make('span', 'eval-muted', C.truncated));
        }
        section.append(box);
    } if (data.timeline.nextCursor)
        section.append(button(C.moreEvents, () => openSession(data.id, data.timeline.nextCursor))); return section; }
    function reviewForm(data) {
        const form = make('section', 'eval-review');
        form.append(make('h3', '', C.annotation));
        let verdict = data.annotation?.verdict || '', saving = false;
        const pass = button(C.pass, () => choose('pass')), fail = button(C.fail, () => choose('fail'));
        pass.id = 'eval-pass';
        fail.id = 'eval-fail';
        form.append(pass, fail);
        const noteLabel = make('label', '', C.reason), note = make('textarea', 'eval-note');
        note.id = 'eval-note';
        note.maxLength = 500;
        note.placeholder = C.reasonPlaceholder;
        note.value = data.annotation?.note || '';
        noteLabel.htmlFor = note.id;
        form.append(noteLabel, note);
        const checkLabel = make('label'), check = make('input');
        check.type = 'checkbox';
        check.id = 'eval-failset';
        check.checked = data.annotation?.failSet === true;
        checkLabel.append(check, document.createTextNode(C.addFailSet));
        form.append(checkLabel);
        const message = make('p', 'eval-status eval-muted');
        message.setAttribute('role', 'status');
        const save = button(C.save, async () => { if (saving)
            return; saving = true; update(); message.textContent = C.loading; try {
            const response = await fetch('/api/eval/annotation', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: data.id, verdict, note: note.value, failSet: check.checked }) });
            if (!response.ok) {
                message.textContent = response.status >= 500 ? C.saveUnknown : C.readError + ' (HTTP ' + response.status + ')';
                return;
            }
            const written = await response.json();
            data.annotation = written;
            for (const row of rows)
                if (row.id === data.id)
                    row.annotation = written;
            renderList();
            saving = false;
            update();
            message.textContent = C.saved;
        }
        catch {
            message.textContent = C.saveUnknown;
        } }, 'primary');
        save.id = 'eval-save';
        form.append(save, message);
        function update() { const blocked = data.state !== 'idle' || saving; pass.disabled = blocked; fail.disabled = blocked; note.disabled = blocked || verdict !== 'fail'; check.disabled = blocked || verdict !== 'fail'; save.disabled = blocked || !verdict; pass.setAttribute('aria-pressed', String(verdict === 'pass')); fail.setAttribute('aria-pressed', String(verdict === 'fail')); noteLabel.hidden = note.hidden = verdict !== 'fail'; checkLabel.hidden = verdict !== 'fail'; }
        function choose(value) { verdict = value; if (value === 'pass') {
            check.checked = false;
            note.value = '';
        } update(); }
        if (data.state !== 'idle')
            message.textContent = data.state === 'active' ? C.active : C.unknownState;
        update();
        return form;
    }
    async function openSession(id, page) { const request = ++detailGeneration; selected = id; renderList(); detail.replaceChildren(make('p', 'eval-muted', C.loading)); try {
        const data = await get('/api/eval/session?id=' + encodeURIComponent(id) + (page ? '&cursor=' + encodeURIComponent(page) : ''));
        if (request !== detailGeneration)
            return;
        detail.replaceChildren(make('h2', '', C.title), make('p', 'eval-muted', data.started + ' · ' + data.state), reviewForm(data), textBlock(C.request, data.summary.request), textBlock(C.final, data.summary.final));
        const rules = make('section');
        rules.append(make('h3', '', C.rules));
        for (const rule of data.findings)
            rules.append(make('div', 'eval-muted', rule.rule + ' · ' + rule.status + ' · ' + rule.count));
        detail.append(rules, make('h3', '', C.metrics), make('p', 'eval-muted', metricText(data)), make('p', 'eval-muted', C.tokenCount + ' ' + number(data.metrics?.tokens ? data.metrics.tokens.input + data.metrics.tokens.output : null)), timeline(data));
        if (page)
            detail.querySelector('#eval-timeline').scrollIntoView({ block: 'start' });
        else
            detail.scrollTop = 0;
    }
    catch (error) {
        if (request === detailGeneration)
            detail.replaceChildren(make('p', 'eval-error', error.message));
    } }
    function switchEval(value) { enabled = value; root.hidden = !value; document.body.classList.toggle('eval-active', value); tab.setAttribute('aria-pressed', String(value)); tab.classList.toggle('active', value); document.querySelector('.security').textContent = value ? C.security : traceSecurity; if (value) {
        for (const id of ['view-stats', 'view-trace']) {
            document.getElementById(id).classList.remove('active');
            document.getElementById(id).setAttribute('aria-pressed', 'false');
        }
        loadList(true);
    } }
    tab.onclick = () => switchEval(true);
    for (const id of ['view-stats', 'view-trace'])
        document.getElementById(id).addEventListener('click', () => switchEval(false));
    select.onchange = () => { filter = select.value; loadList(true); };
    document.getElementById('refresh').addEventListener('click', event => { if (enabled) {
        event.stopImmediatePropagation();
        loadList(true);
        if (selected)
            openSession(selected);
    } }, true);
})();
`;
