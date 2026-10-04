const names = { planner: 'PlannerCo', research: 'ResearchCo', search: 'SearchCo', compute: 'ComputeCo' };
const defaultEdges = [['planner', 'research'], ['research', 'search'], ['planner', 'compute']];
function el(tag, text, className) { const item = document.createElement(tag); if (text !== undefined) item.textContent = text; if (className) item.className = className; return item; }
function button(text, action) { const item = el('button', text, 'debug-button'); item.type = 'button'; item.onclick = action; return item; }

export function initPlayback(networkPanel, onBalance) {
  let current = null, index = -1, timer = null, mode = 'tasks', trust = defaultEdges;
  const network = networkPanel.querySelector('.network'); const svg = network.querySelector('svg');
  const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  svg.querySelectorAll(':scope > path').forEach(path => path.remove()); svg.append(group);
  const modes = el('div', undefined, 'network-modes');
  const taskMode = button('Task delegation', () => { mode = 'tasks'; draw(); });
  const trustMode = button('Caller trust', () => { mode = 'trust'; draw(); });
  modes.append(taskMode, trustMode); network.before(modes);
  const controls = el('div', undefined, 'playback');
  const controlsRow = el('div', undefined, 'playback-controls');
  const play = button('Replay ▶', () => {
    if (timer) { stop(); return; }
    if (!current) return;
    if (index >= current.events.length - 1) index = -1;
    step(index + 1); play.textContent = 'Pause Ⅱ';
    timer = setInterval(() => { if (index >= current.events.length - 1) stop(); else step(index + 1); }, 1100);
  });
  const back = button('← Back', () => { stop(); step(index - 1); });
  const next = button('Next →', () => { stop(); step(index + 1); });
  const reset = button('Reset', () => { stop(); step(0); });
  const final = button('Show result', () => { stop(); step(current.events.length - 1); });
  for (const control of [play, back, next, reset, final]) control.disabled = true;
  const count = el('span', '', 'playback-count'); count.setAttribute('aria-live', 'polite');
  controlsRow.append(play, back, next, reset, final, count);
  const message = el('p', 'Run a scenario to replay its recorded steps.', 'playback-message');
  controls.append(controlsRow, message, el('p', 'Replay changes the network and balances on this page. It does not send requests or repeat work; evidence below describes the completed run.', 'playback-note'));
  networkPanel.append(controls);
  const statusLabels = { waiting: 'Waiting', delegated: 'Delegated', accepted: 'Accepted', authorized: 'Authorized', reserved: 'Reserved', executing: 'Executing', settled: 'Settled', denied: 'Denied', released: 'Released', reused: 'Reused', skipped: 'Skipped' };

  function stop() { clearInterval(timer); timer = null; play.textContent = 'Replay ▶'; }
  function step(to) {
    if (!current) return;
    index = Math.max(0, Math.min(to, current.events.length - 1));
    const event = current.events[index];
    count.textContent = `Step ${index + 1} of ${current.events.length}${index === current.events.length - 1 ? ' · complete' : ''}`;
    message.textContent = event.message;
    back.disabled = index === 0; next.disabled = index === current.events.length - 1;
    for (const [operator, status] of Object.entries(event.snapshot.operator_states)) {
      const node = network.querySelector(`[data-operator="${operator}"]`);
      node.classList.remove('settled', 'denied', 'released', 'reused', 'replay-active');
      if (['settled', 'denied', 'released', 'reused'].includes(status)) node.classList.add(status);
      node.classList.toggle('replay-active', operator === event.operator && index < current.events.length - 1);
      node.querySelector('.node-state').textContent = statusLabels[status] ?? status;
    }
    onBalance(event.snapshot.ledger); draw();
  }
  function draw() {
    taskMode.setAttribute('aria-pressed', String(mode === 'tasks')); trustMode.setAttribute('aria-pressed', String(mode === 'trust'));
    const bounds = network.getBoundingClientRect(); if (!bounds.width || !bounds.height) return;
    svg.setAttribute('viewBox', `0 0 ${bounds.width} ${bounds.height}`);
    group.replaceChildren();
    const routes = mode === 'trust' ? trust : [['requester', 'planner'], ...defaultEdges];
    const selectedTask = current?.tasks[current.events[index]?.task_index];
    for (const [from, to] of routes) {
      const locate = name => network.querySelector(name === 'requester' ? '.requester-node .node-icon' : `[data-operator="${name}"] .node-icon`).getBoundingClientRect();
      const a = locate(from), b = locate(to);
      let x1 = a.x + a.width / 2 - bounds.x, y1 = a.y + a.height / 2 - bounds.y;
      let x2 = b.x + b.width / 2 - bounds.x, y2 = b.y + b.height / 2 - bounds.y;
      const dx = x2 - x1, dy = y2 - y1, length = Math.hypot(dx, dy) || 1;
      x1 += dx / length * 29; y1 += dy / length * 29; x2 -= dx / length * 32; y2 -= dy / length * 32;
      const path = document.createElementNS(svg.namespaceURI, 'path');
      path.setAttribute('d', `M ${x1} ${y1} Q ${(x1 + x2) / 2} ${(y1 + y2) / 2 + (from > to ? 12 : -12)} ${x2} ${y2}`);
      const trusted = from === 'requester' || trust.some(edge => edge[0] === from && edge[1] === to);
      path.setAttribute('class', `network-route ${mode === 'trust' ? 'trust-route' : ''} ${!trusted ? 'untrusted-route' : ''} ${selectedTask?.caller === from && selectedTask?.provider === to && index < (current?.events.length ?? 0) - 1 ? 'active-route' : ''}`);
      path.setAttribute('marker-end', 'url(#arrow)');
      const title = document.createElementNS(svg.namespaceURI, 'title'); title.textContent = `${names[from] ?? 'Requester'} → ${names[to]}${trusted ? '' : ' · caller trust missing'}`; path.append(title); group.append(path);
    }
    network.querySelector('.network-caption').textContent = mode === 'trust' ? 'Arrow: receiver trusts caller. Original requester policy still applies.' : 'Task routes are fixed. Red connections indicate missing caller trust.';
  }
  new ResizeObserver(draw).observe(network);
  draw();
  return {
    render(result) {
      stop(); current = result; trust = result.edges;
      if (result.events[0]?.snapshot) {
        for (const control of [play, back, next, reset, final]) control.disabled = false;
        step(result.events.length - 1);
      }
    },
    updateTrust(edges) { trust = edges; draw(); },
  };
}

export function renderComparison(target, current, previous) {
  target.replaceChildren();
  target.append(el('h2', 'What changed between runs?'), el('p', 'Compare settings and outcomes. Fresh token IDs, keys and timestamps are excluded.', 'code-caption'));
  if (!previous) { target.append(el('p', 'Run another scenario or change one setting to compare it with this run.', 'debug-empty')); return; }
  target.append(el('p', `Previous: ${previous.scenario} / ${previous.requester} · Current: ${current.scenario} / ${current.requester}`, 'decision-values'));
  const changes = [];
  if (current.scenario !== previous.scenario) changes.push(`Scenario: ${previous.scenario} → ${current.scenario}`);
  if (current.requester !== previous.requester) changes.push(`Requester: ${previous.requester} → ${current.requester}`);
  if (current.ledger.budget !== previous.ledger.budget) changes.push(`Budget: ${previous.ledger.budget} → ${current.ledger.budget} credits`);
  for (const [from, to] of previous.edges) if (!current.edges.some(edge => edge[0] === from && edge[1] === to)) changes.push(`Removed trust: ${names[from]} → ${names[to]}`);
  for (const [from, to] of current.edges) if (!previous.edges.some(edge => edge[0] === from && edge[1] === to)) changes.push(`Added trust: ${names[from]} → ${names[to]}`);
  for (const operator of Object.keys(names)) for (const who of ['alice', 'bob']) {
    if (previous.accepts[operator].includes(who) !== current.accepts[operator].includes(who)) changes.push(`${names[operator]} ${current.accepts[operator].includes(who) ? 'now accepts' : 'stopped accepting'} ${who}`);
  }
  target.append(el('h3', 'Changed inputs'));
  const list = el('ul', undefined, 'comparison-changes');
  for (const change of changes) list.append(el('li', change));
  if (!changes.length) list.append(el('li', 'Same settings; this is a fresh run. Concurrent reservation order may differ.'));
  target.append(list);
  const table = el('table', undefined, 'ledger-table comparison-table');
  const header = el('tr'); for (const name of ['Operator', 'Previous', 'Current', 'Credit change']) header.append(el('th', name));
  const head = el('thead'); head.append(header); table.append(head); const body = el('tbody');
  function state(run, operator) { return operator === 'planner' ? run.root_decision.permitted ? 'accepted' : 'denied' : run.tasks.filter(task => task.provider === operator).map(task => task.status).join(' / ') || 'skipped'; }
  for (const [operator, name] of Object.entries(names)) {
    const row = el('tr'); const before = state(previous, operator), after = state(current, operator);
    const diff = current.ledger.balances[operator] - previous.ledger.balances[operator];
    row.append(el('td', name), el('td', before), el('td', after, before !== after ? 'comparison-changed' : ''), el('td', `${diff > 0 ? '+' : ''}${diff} cr`)); body.append(row);
  }
  table.append(body); target.append(table, el('p', `Total charged: ${previous.ledger.settled} → ${current.ledger.settled} credits. Available: ${previous.ledger.available} → ${current.ledger.available}.`, 'decision-values'));
  const denied = current.tasks.filter(task => task.status === 'denied');
  for (const task of denied) {
    const reason = task.decision?.billing?.passed === false ? task.decision.billing.reason
      : task.decision?.rows?.filter(row => !row.present).map(row => `Missing ${row.logic}`).join('; ') || task.error;
    target.append(el('p', `${names[task.provider]}: ${reason}`, 'debug-note'));
  }
  if (!current.root_decision.permitted) target.append(el('p', current.root_decision.summary, 'debug-note'));
}

export const lessons = {
  free: { label: 'Free exploration', text: 'Change one setting, run the network, then use Compare to see its effect.' },
  payer: { label: '1. Protect the original payer', scenario: 'payer_swap', text: 'Search claims mallory-org. Expect a payer check to fail before any search reservation. Inspect the red payer row.' },
  trust: { label: '2. Remove a trust relationship', scenario: 'happy', text: 'ResearchCo can delegate a task, but SearchCo must trust its caller. Expect search to fail at trusts_caller.' },
  requester: { label: '3. Reject the original requester', scenario: 'happy', text: 'SearchCo trusts ResearchCo but rejects Alice. Expect accepts_requester to fail while compute succeeds.' },
  budget: { label: '4. Separate permission from budget', scenario: 'overspend', text: 'Both 60-credit calls have permission. Only one reservation fits. Debug shows the denial at reserve, after authorization.' },
  retry: { label: '5. Retry without charging twice', scenario: 'retry', text: 'Follow both search attempts in Debug. The second reservation returns duplicate: true and reuses the original settlement.' },
  failure: { label: '6. Release credits after failure', scenario: 'failure', text: 'Replay the search reservation and release. Reserved credits return to available without becoming a charge.' },
};
