import { tokens, curlCommand } from './debug-format.js';

const names = { planner: 'PlannerCo', research: 'ResearchCo', search: 'SearchCo', compute: 'ComputeCo', clearinghouse: 'Clearinghouse', browser: 'Browser' };
function node(tag, text, className) { const item = document.createElement(tag); if (text !== undefined) item.textContent = text; if (className) item.className = className; return item; }
function button(text, action, className = 'debug-button') { const item = node('button', text, className); item.type = 'button'; item.onclick = action; return item; }
function select(label, options, action) {
  const wrapper = node('label', undefined, 'debug-filter'); wrapper.append(node('span', label));
  const input = node('select'); input.setAttribute('aria-label', label);
  for (const [value, text] of options) { const option = node('option', text); option.value = value; input.append(option); }
  input.onchange = action; wrapper.append(input); return { wrapper, input };
}
function download(value, filename) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const link = node('a'); link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function copy(text, trigger) {
  try {
    if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
    else {
      const field = node('textarea'); field.value = text; field.className = 'copy-buffer'; document.body.append(field); field.select();
      const copied = document.execCommand('copy'); field.remove(); if (!copied) throw new Error('Select and copy the code below');
    }
    trigger.textContent = 'Copied';
  } catch { trigger.textContent = 'Select code to copy'; }
  setTimeout(() => { trigger.textContent = 'Copy'; }, 2000);
}
function codeBlock(title, value, language = 'json') {
  let text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (language === 'json' && typeof value === 'string') {
    try { text = JSON.stringify(JSON.parse(value), null, 2); } catch { /* Preserve non-JSON responses verbatim. */ }
  }
  const section = node('section', undefined, 'debug-code-section');
  const header = node('div', undefined, 'debug-code-header');
  const copyButton = button('Copy', () => copy(text, copyButton));
  const pre = node('pre', undefined, 'debug-code'); const code = node('code');
  const fold = button('Collapse', () => { pre.hidden = !pre.hidden; fold.textContent = pre.hidden ? 'Expand' : 'Collapse'; fold.setAttribute('aria-expanded', String(!pre.hidden)); });
  fold.setAttribute('aria-expanded', 'true'); fold.setAttribute('aria-label', `Toggle ${title}`);
  const actions = node('div', undefined, 'debug-code-actions'); actions.append(fold, copyButton);
  header.append(node('strong', title), actions);
  for (const part of tokens(text, language)) code.append(part.kind ? node('span', part.text, `syntax-${part.kind}`) : document.createTextNode(part.text));
  pre.append(code); section.append(header, pre); return section;
}

export function initDebug(target, inspectDecision) {
  let runs = [], selectedRun = null, selectedEntry = 'http', view = 'summary';
  const title = node('div', undefined, 'debug-heading');
  const intro = node('div'); intro.append(node('h2', 'Follow every authorization call'), node('p', 'HTTP traffic and internal checks, with the exact inputs and recorded results.'));
  const expand = button('Expand view ↗', () => {
    const expanded = document.body.classList.toggle('debug-expanded'); expand.textContent = expanded ? 'Exit expanded view ↙' : 'Expand view ↗';
    expand.setAttribute('aria-expanded', String(expanded));
  }); expand.setAttribute('aria-expanded', 'false'); title.append(intro, expand);
  const controls = node('div', undefined, 'debug-controls');
  const runFilter = select('Run history', [], () => { selectedRun = runs.find(run => run.id === runFilter.input.value); selectedEntry = 'http'; render(); });
  const operatorFilter = select('Operator', [['all', 'All operators'], ...Object.entries(names)], render);
  const stageFilter = select('Stage', [['all', 'All stages'], ['http', 'HTTP request'], ['authorization', 'Authorization'], ['reserve', 'Reserve'], ['settle', 'Settle'], ['release', 'Release']], render);
  const outcomeFilter = select('Outcome', [['all', 'All outcomes'], ['denied', 'Denied / error']], render);
  const exportButton = button('Export trace ↓', () => selectedRun && download(selectedRun, `relay-debug-${selectedRun.id}.json`));
  const clear = button('Clear history', () => { runs = []; selectedRun = null; selectedEntry = 'http'; render(); });
  controls.append(runFilter.wrapper, operatorFilter.wrapper, stageFilter.wrapper, outcomeFilter.wrapper, exportButton, clear);
  const summary = node('p', undefined, 'debug-summary'); summary.setAttribute('aria-live', 'polite');
  const workspace = node('div', undefined, 'debug-workspace');
  const list = node('div', undefined, 'debug-list'); list.setAttribute('aria-label', 'Recorded calls');
  const inspector = node('div', undefined, 'debug-inspector'); workspace.append(list, inspector);
  target.append(title, controls, summary, workspace, node('p', 'History stays in this page (latest 10 runs). Clearing history does not run tasks or change credits.', 'debug-footnote'));

  function entries() { return selectedRun ? [selectedRun.http, ...(selectedRun.data?.debug ?? [])] : []; }
  function label(entry) {
    if (entry.transport === 'http') return `${entry.request.method} /api/run`;
    const task = selectedRun.data.tasks[entry.task_index];
    return `${names[entry.operator]} · ${entry.stage}${task ? ` · ${task.action}` : ' · original request'}`;
  }
  function outcome(entry) {
    if (entry.transport === 'http') return entry.status ? `HTTP ${entry.status}` : entry.outcome === 'pending' ? 'Pending' : 'Network error';
    if (entry.outcome === 'allowed') return entry.stage === 'authorization' ? 'Allowed' : 'Succeeded';
    return entry.outcome === 'denied' ? 'Denied' : 'Error';
  }
  function render() {
    runFilter.input.replaceChildren();
    for (const run of runs) { const option = node('option', `${run.config.scenario} · ${new Date(run.http.started_at).toLocaleTimeString()} · ${run.id}`); option.value = run.id; runFilter.input.append(option); }
    if (selectedRun) runFilter.input.value = selectedRun.id;
    exportButton.disabled = !selectedRun; clear.disabled = !runs.length;
    const all = entries();
    const filtered = all.filter(entry => (operatorFilter.input.value === 'all' || entry.operator === operatorFilter.input.value)
      && (stageFilter.input.value === 'all' || entry.stage === stageFilter.input.value)
      && (outcomeFilter.input.value === 'all' || ['denied', 'error'].includes(entry.outcome)));
    summary.textContent = selectedRun ? `${filtered.length} of ${all.length} calls · 1 HTTP request · ${all.length - 1} internal evaluations / billing calls` : 'No captured requests. Run the network to begin.';
    if (!filtered.some(entry => entry.id === selectedEntry)) selectedEntry = filtered[0]?.id;
    list.replaceChildren();
    for (const entry of filtered) {
      const item = button('', () => { selectedEntry = entry.id; render(); }, `debug-call ${selectedEntry === entry.id ? 'selected' : ''}`);
      item.setAttribute('aria-pressed', String(selectedEntry === entry.id));
      const badges = node('div', undefined, 'debug-call-meta'); badges.append(node('span', entry.transport === 'http' ? 'HTTP' : 'INTERNAL', 'transport-badge'),
        node('span', outcome(entry), `outcome-${entry.outcome}`));
      item.append(badges, node('strong', label(entry)), node('small', `${new Date(entry.started_at).toLocaleTimeString()} · ${entry.duration_ms ?? '…'} ms`)); list.append(item);
    }
    if (!filtered.length) list.append(node('p', all.length ? 'No calls match these filters.' : 'Requests appear here.', 'debug-empty'));
    renderInspector(filtered.find(entry => entry.id === selectedEntry));
  }
  function renderInspector(entry) {
    inspector.replaceChildren();
    if (!entry) { inspector.append(node('p', 'Select a recorded call to inspect its request and response.', 'debug-empty')); return; }
    const header = node('div', undefined, 'debug-inspector-heading'); header.append(node('h3', label(entry)));
    inspector.append(header);
    const tabs = node('div', undefined, 'debug-detail-tabs'); tabs.setAttribute('aria-label', 'Call details');
    for (const [key, text] of [['summary', 'Summary'], ['request', 'Request'], ['response', 'Response'], ['curl', 'cURL']]) {
      const tab = button(text, () => { view = key; renderInspector(entry); }); tab.setAttribute('aria-pressed', String(view === key)); tabs.append(tab);
    }
    inspector.append(tabs);
    if (view === 'request') {
      if (entry.transport === 'http') {
        inspector.append(codeBlock('Request headers · set by this app', entry.request.headers), codeBlock('JSON request body', entry.request.body));
      } else inspector.append(codeBlock('Internal function input', entry.request));
    } else if (view === 'response') {
      if (entry.transport === 'http') inspector.append(codeBlock('Response headers · visible to the browser', entry.response_headers ?? {}), codeBlock('Response body', entry.response_text ?? 'Waiting for response…'));
      else inspector.append(codeBlock('Internal function result', entry.response));
    } else if (view === 'curl') {
      if (entry.transport === 'http') {
        inspector.append(node('p', 'Runs this scenario again with fresh keys and a fresh ledger. It does not replay the same signed tokens.', 'debug-note'),
          codeBlock('Bash', curlCommand(entry.request), 'shell'), codeBlock('PowerShell', curlCommand(entry.request, 'powershell'), 'shell'));
      } else inspector.append(node('p', 'This is an internal call inside /api/run, not an HTTP endpoint. Select the HTTP request to copy a runnable cURL command.', 'debug-note'));
    } else {
      const grid = node('dl', undefined, 'debug-facts');
      const task = selectedRun.data?.tasks[entry.task_index];
      const facts = [['Transport', entry.transport === 'http' ? 'Browser → Pages API' : 'Internal function call'], ['Result', outcome(entry)],
        ['Started', entry.started_at], ['Duration', `${entry.duration_ms ?? '…'} ms`], ['Run', selectedRun.id]];
      if (entry.transport === 'http') facts.push(['URL', entry.request.url], ['HTTP status', entry.status ?? 'No response']);
      else facts.push(['Policy boundary', names[entry.operator]], ['Task', task?.task_id ?? 'Original request']);
      if (task) facts.push(['Caller → receiver', `${names[task.caller]} → ${names[task.provider]}`], ['Payer / action', `${task.payer} / ${task.action}`]);
      for (const [key, value] of facts) grid.append(node('dt', key), node('dd', String(value)));
      inspector.append(grid);
      if (entry.transport === 'http') inspector.append(node('p', 'HTTP 200 means the scenario completed. Individual operations can still be denied. App-set request headers and browser-visible response headers are recorded.', 'debug-note'));
      else {
        inspector.append(node('p', entry.response?.error ?? entry.response?.decision?.summary ?? (entry.stage === 'authorization' ? 'Biscuit evaluated this call at the named policy boundary.' : 'Recorded directly from the clearinghouse operation.'), 'debug-note'));
        inspector.append(button('Inspect decision →', () => { document.body.classList.remove('debug-expanded'); expand.textContent = 'Expand view ↗'; expand.setAttribute('aria-expanded', 'false'); inspectDecision(selectedRun.data, entry.task_index); }));
      }
      if (entry.network_error) inspector.append(node('p', entry.network_error, 'debug-note outcome-error'));
    }
  }
  render();
  return {
    collapse() { document.body.classList.remove('debug-expanded'); expand.textContent = 'Expand view ↗'; expand.setAttribute('aria-expanded', 'false'); },
    async run(config) {
      const started = performance.now();
      const request = { method: 'POST', url: new URL('/api/run', location.href).href, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config) };
      const run = { id: `run-${Date.now()}`, config: structuredClone(config), http: { id: 'http', transport: 'http', stage: 'http', operator: 'browser',
        started_at: new Date().toISOString(), request, outcome: 'pending' } };
      runs.unshift(run); runs = runs.slice(0, 10); selectedRun = run; selectedEntry = 'http'; render();
      try {
        const response = await fetch(request.url, { method: request.method, headers: request.headers, body: request.body });
        run.http.status = response.status; run.http.response_headers = Object.fromEntries(response.headers);
        run.http.response_text = await response.text(); run.http.outcome = response.ok ? 'allowed' : 'error';
        let data;
        try { data = JSON.parse(run.http.response_text); } catch { throw new Error(`The API returned a non-JSON response (HTTP ${response.status}). See Debug for its body.`); }
        if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
        run.id = data.request_id; run.data = data;
        return data;
      } catch (error) {
        run.http.outcome = 'error'; run.http.network_error = error.message; throw error;
      } finally { run.http.duration_ms = Math.round((performance.now() - started) * 100) / 100; render(); }
    },
  };
}
