import { initDebug } from './debug.js';
import { initPlayback, renderComparison, lessons } from './playground.js';
const $ = (selector) => document.querySelector(selector);
const names = { planner: 'PlannerCo', research: 'ResearchCo', search: 'SearchCo', compute: 'ComputeCo' };
const descriptions = {
  happy: 'Research, search and compute inherit the original grant. Three operations settle for 40 credits.',
  payer_swap: 'ResearchCo claims a different payer for search. The original Biscuit must reject the change.',
  forbidden: 'The search task attempts a delete operation beyond its delegated permissions.',
  untrusted: 'A search token is signed by a different issuer. SearchCo only accepts the clearinghouse key.',
  overspend: 'After 5 credits for research, search and compute both request 60 credits. Only one reservation can fit in a 100-credit budget.',
  retry: 'The search call is sent twice with the same operation ID. The ledger must charge it only once.',
  failure: 'Search reserves 10 credits, then fails. Its reservation is released without a charge.'
};
let edges = [['planner', 'research'], ['research', 'search'], ['planner', 'compute']];
let latest = null;
let runHistory = [];
const debuggerView = initDebug($('#debug'), (result, taskIndex) => {
  render(result); $('#task-select').value = taskIndex === null ? 'root' : String(taskIndex); showBiscuit(); switchTab('biscuit');
});
const playback = initPlayback($('.network-panel'), ledger => {
  for (const metric of ['budget', 'settled', 'reserved', 'available']) $(`#metric-${metric}`).replaceChildren(document.createTextNode(String(ledger[metric])), el('small', 'cr'));
});
$('.network-panel .playback').before($('.ledger-strip'));
const lessonBox = el('div', undefined, 'lesson-box');
const lessonLabel = el('label', 'Guided exercise'); lessonLabel.htmlFor = 'lesson';
const lessonSelect = el('select'); lessonSelect.id = 'lesson';
for (const [key, lesson] of Object.entries(lessons)) { const option = el('option', lesson.label); option.value = key; lessonSelect.append(option); }
const lessonText = el('p', lessons.free.text);
lessonBox.append(lessonLabel, lessonSelect, lessonText); $('.controls .panel-heading').after(lessonBox);
lessonSelect.onchange = () => {
  const lesson = lessons[lessonSelect.value]; lessonText.textContent = lesson.text;
  if (lessonSelect.value === 'free') return;
  $('#scenario').value = lesson.scenario; $('#budget').value = '100'; $('#requester').value = 'alice';
  edges = [['planner', 'research'], ['research', 'search'], ['planner', 'compute']];
  document.querySelectorAll('#accepts input').forEach(input => { input.checked = true; });
  if (lessonSelect.value === 'trust') edges = edges.filter(edge => edge[1] !== 'search');
  if (lessonSelect.value === 'requester') $('#accepts input[data-operator="search"][data-requester="alice"]').checked = false;
  renderEdges(); scenarioChanged();
};
function el(tag, text, className) { const item = document.createElement(tag); if (text !== undefined) item.textContent = text; if (className) item.className = className; return item; }
function renderEdges() {
  $('#edges').replaceChildren(...edges.map(([from, to], index) => {
    const row = el('div', undefined, 'edge');
    const remove = el('button', '×'); remove.type = 'button'; remove.setAttribute('aria-label', `Remove trust from ${names[from]} to ${names[to]}`);
    remove.onclick = () => { edges.splice(index, 1); renderEdges(); markChanged(); };
    row.append(el('span', names[from]), el('span', '→', 'arrow'), el('span', names[to]), remove); return row;
  }));
  playback.updateTrust(edges);
}
for (const [id, name] of Object.entries(names)) {
  for (const select of ['#edge-from', '#edge-to']) { const option = el('option', name); option.value = id; $(select).append(option); }
  const row = el('div', undefined, 'requester-row'); row.append(el('span', name));
  for (const requester of ['alice', 'bob']) { const label = el('label'); const check = el('input'); check.type = 'checkbox'; check.checked = true; check.dataset.operator = id; check.dataset.requester = requester; check.setAttribute('aria-label', `${name} accepts ${requester}`); check.onchange = markChanged; label.append(check); row.append(label); }
  $('#accepts').append(row);
}
$('#edge-to').value = 'research';
$('#add-edge').onclick = () => { const from = $('#edge-from').value, to = $('#edge-to').value; if (from !== to && !edges.some(e => e[0] === from && e[1] === to)) { edges.push([from, to]); renderEdges(); markChanged(); } };
function markChanged() { if (latest) { $('#run-status').textContent = 'Settings changed · run again'; $('#run-status').className = 'status-chip'; } }
function scenarioChanged() { $('#scenario-description').textContent = descriptions[$('#scenario').value]; markChanged(); }
$('#scenario').onchange = scenarioChanged; $('#budget').oninput = markChanged; $('#requester').onchange = markChanged;
function switchTab(id) {
  if (id !== 'debug') debuggerView.collapse();
  document.querySelectorAll('[data-tab]').forEach(button => button.setAttribute('aria-selected', String(button.dataset.tab === id)));
  document.querySelectorAll('.tab-panel').forEach(panel => panel.hidden = panel.id !== id);
  history.replaceState(null, '', `#${id}`);
}
const evidenceTabs = [...document.querySelectorAll('[data-tab]')];
evidenceTabs.forEach((button, index) => {
  button.id = `tab-${button.dataset.tab}`; button.setAttribute('aria-controls', button.dataset.tab);
  $(`#${button.dataset.tab}`).setAttribute('aria-labelledby', button.id);
  button.onclick = () => switchTab(button.dataset.tab);
  button.onkeydown = event => {
    const target = event.key === 'ArrowRight' ? (index + 1) % evidenceTabs.length : event.key === 'ArrowLeft' ? (index + evidenceTabs.length - 1) % evidenceTabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? evidenceTabs.length - 1 : null;
    if (target !== null) { event.preventDefault(); evidenceTabs[target].focus(); switchTab(evidenceTabs[target].dataset.tab); }
  };
});
function codeSection(target, title, code, caption) { target.append(el('h3', title)); if (caption) target.append(el('p', caption, 'code-caption')); target.append(el('pre', code)); }
function details(target, title, value) { const disclosure = el('details'); disclosure.append(el('summary', title), el('pre', typeof value === 'string' ? value : JSON.stringify(value, null, 2))); target.append(disclosure); }
function showDecision(target, task) {
  const decision = task.decision;
  if (!decision) return;
  const headline = decision.phase === 'ingress' ? (decision.permitted ? 'Root request accepted' : 'Root request denied') : task.status === 'denied' ? (decision.phase === 'verification' ? 'Verification denied' : decision.permitted ? 'Credit reservation denied' : 'Biscuit denied') : task.status === 'released' ? 'Authorized · credits released' : task.status === 'reused' ? 'Authorized · original charge reused' : 'Authorized and settled';
  const banner = el('div', undefined, `decision-banner ${task.status === 'denied' ? 'decision-fail' : 'decision-pass'}`);
  banner.append(el('strong', headline), el('span', decision.summary)); target.append(banner);
  if (decision.phase === 'verification') {
    target.append(el('p', 'The token or delegation failed verification, so the Datalog policy was never evaluated.', 'code-caption'));
    return;
  }
  const issuer = decision.issuer_values, call = decision.call_values;
  const values = decision.phase === 'ingress' ? `Root grant: requester ${issuer.requester}, payer ${issuer.payer}, request ${issuer.request_id}.` : `Issuer says: requester ${issuer.requester}, payer ${issuer.payer}, request ${issuer.request_id}. Signed call says: ${call.caller} → ${call.service}, payer ${call.payer}, action ${call.action}, ${call.amount} credits.`;
  target.append(el('p', values, 'decision-values'));
  target.append(el('h3', 'Allow rule · actual values'));
  const provenance = el('div', undefined, 'provenance-legend');
  for (const [origin, label] of [['issuer', 'Issuer · signed grant'], ['receiver', 'Receiver · local policy'], ['call', 'Caller · verified context']]) {
    const badge = el('span', label); badge.dataset.origin = origin; provenance.append(badge);
  }
  target.append(provenance);
  target.append(el('p', 'Each row was checked against facts visible to this operator’s Biscuit authorizer. A missing fact stops the allow rule.', 'code-caption'));
  const rule = el('div', undefined, 'grounded-rule'); rule.append(el('div', 'allow if', 'rule-prefix'));
  decision.rows.forEach((row, i) => {
    const item = el('div', undefined, `rule-row ${row.present ? 'rule-pass' : 'rule-fail'}`);
    const source = el('span', row.source, 'rule-source');
    source.dataset.origin = row.source.includes('authority') ? 'issuer' : row.source.includes('policy') || row.source === 'receiving operator' ? 'receiver' : 'call';
    source.title = source.dataset.origin === 'issuer' ? 'Signed by the root issuer' : source.dataset.origin === 'receiver' ? 'Supplied by the receiving operator’s own policy' : 'Taken from verified call context';
    item.append(el('span', row.present ? '✓' : '×', 'rule-mark'), el('code', row.logic + (i === decision.rows.length - 1 ? ';' : ',')), source);
    if (!row.present) item.append(el('span', row.available.length ? `Available: ${row.available.join(', ')}` : 'No matching fact from this source', 'rule-available'));
    rule.append(item);
  }); target.append(rule);
  if (decision.token_checks.length || decision.restrictions.length) {
    target.append(el('h3', 'Token checks'));
    const checks = el('div', undefined, 'grounded-checks');
    [...decision.token_checks, ...decision.restrictions].forEach(check => {
      const item = el('div', undefined, `check-row ${check.passed ? 'rule-pass' : 'rule-fail'}`);
      const source = el('span', check.block ? `block ${check.block} · delegation` : 'authority', 'rule-source'); source.dataset.origin = check.block ? 'delegation' : 'issuer';
      item.append(el('span', check.passed ? '✓' : '×', 'rule-mark'), el('code', check.logic), source);
      if (check.block) item.append(el('span', `Call action: ${JSON.stringify(check.action)}`, 'rule-available'));
      checks.append(item);
    }); target.append(checks);
  }
  if (decision.billing) {
    const billing = decision.billing; target.append(el('h3', 'Clearinghouse budget decision'));
    const card = el('div', undefined, `billing-decision ${billing.passed ? 'rule-pass' : 'rule-fail'}`);
    card.append(el('strong', `${billing.passed ? '✓' : '×'} ${billing.requested} credits requested · ${billing.available_before} available`), el('span', billing.reason)); target.append(card);
  } else if (!decision.permitted) target.append(el('p', 'No reservation was attempted because authorization failed.', 'code-caption'));
}
function showBiscuit() {
  if (!latest) return;
  const content = $('#biscuit-content'); content.replaceChildren();
  if ($('#task-select').value === 'root') {
    showDecision(content, {status: latest.root_decision.permitted ? 'settled' : 'denied', decision: latest.root_decision});
    codeSection(content, 'Authority · signed by the clearinghouse', latest.authority, 'The authority fixes the original requester, billing account, request ID, permissions and expiry. Each run uses fresh demo keys.');
    details(content, 'Trusted issuer public key', latest.root_public_key); return;
  }
  const task = latest.tasks[Number($('#task-select').value)];
  content.append(el('p', `${names[task.caller]} → ${names[task.provider]} · ${task.task_id} · ${task.status}`, 'code-caption'));
  showDecision(content, task);
  if (task.error) details(content, 'Detailed denial from Biscuit or clearinghouse', task.error);
  task.blocks.forEach((block, i) => details(content, i === 0 ? (task.decision?.phase === 'verification' ? 'Unverified block 0' : 'Block 0 · issuer authority') : `Block ${i} · delegated restriction`, block));
  details(content, 'Policy template with variables', task.policy);
  if (task.authorizer) details(content, 'Authorizer facts and evaluation', task.authorizer);
  details(content, 'Serialized Biscuit token', task.token);
  details(content, 'Signed delegation chain', task.proof_chain);
  details(content, 'Authenticated operation request', task.call);
}
$('#task-select').onchange = showBiscuit;
function renderGrant(result) {
  const grant = result.grant;
  const values = $('#grant-values'); values.replaceChildren();
  for (const [label, value] of [['Requester', grant.requester], ['Payer', grant.payer], ['Request', grant.request_id], ['Expires', grant.expires]]) {
    const row = el('div', undefined, 'grant-fact'); row.append(el('span', label), el('code', value)); values.append(row);
  }
  values.append(el('div', 'RIGHTS ISSUED BY THE ROOT TOKEN', 'grant-rights-label'));
  const rights = el('div', undefined, 'grant-rights'); grant.rights.forEach(right => rights.append(el('code', `right(${JSON.stringify(right)})`, 'grant-chip'))); values.append(rights);
  const list = $('#delegation-values'); list.replaceChildren();
  const shown = new Set();
  for (const task of result.tasks) {
    if (shown.has(task.task_id)) continue;
    shown.add(task.task_id);
    const group = el('div', undefined, 'grant-delegation');
    group.append(el('strong', `${names[task.caller]} → ${names[task.provider]}`));
    const effective = grant.rights.filter(right => task.proof_chain.every(proof => proof.payload.allowed_actions.includes(right)));
    group.append(el('div', `${task.decision?.phase === 'verification' ? 'Claimed rights · verification failed' : 'Rights remaining before receiver policy'}: ${effective.length ? effective.join(', ') : 'none'}`, 'grant-effective'));
    task.blocks.slice(1).forEach((block, index) => group.append(el('code', `Block ${index + 1}: ${block.trim()}`, 'grant-check')));
    list.append(group);
  }
  if (!shown.size) list.append(el('p', 'No tasks were delegated in this run.', 'muted'));
}
function render(result) {
  latest = result; $('#export').disabled = false;
  const denied = result.tasks.filter(t => t.status === 'denied').length + (result.events.some(e => e.kind === 'denied' && e.operator === 'planner') ? 1 : 0);
  $('#run-status').textContent = denied ? `Complete · ${denied} denied` : 'Run complete'; $('#run-status').className = 'status-chip done';
  $('#requester-name').textContent = result.requester === 'alice' ? 'Alice' : 'Bob'; $('.requester-node .node-icon').textContent = result.requester[0].toUpperCase();
  renderGrant(result);
  for (const metric of ['budget', 'settled', 'reserved', 'available']) $(`#metric-${metric}`).replaceChildren(document.createTextNode(String(result.ledger[metric])), el('small', 'cr'));
  for (const [operator] of Object.entries(names)) {
    const node = $(`.node[data-operator="${operator}"]`); const task = result.tasks.findLast(t => t.provider === operator);
    node.classList.remove('settled', 'denied', 'released', 'reused');
    if (task) { node.classList.add(task.status); node.querySelector('.node-state').textContent = task.status[0].toUpperCase() + task.status.slice(1); }
    else { node.querySelector('.node-state').textContent = operator === 'planner' ? (result.events.some(e => e.operator === 'planner' && e.kind === 'denied') ? 'Denied' : 'Root task') : 'Skipped'; }
  }
  $('#search-price').textContent = `Search · ${result.scenario === 'overspend' ? 60 : 10} cr`;
  $('#compute-price').textContent = `Compute · ${result.scenario === 'overspend' ? 60 : 25} cr`;
  const activity = el('div', undefined, 'activity-list');
  result.events.forEach(event => { const row = el('div', undefined, 'event'); const message = el('div', event.message, 'event-message'); message.append(el('small', names[event.operator] || 'Clearinghouse')); row.append(el('span', String(event.index).padStart(2, '0'), 'event-index'), el('span', event.kind, `event-type ${event.kind}`), message); activity.append(row); });
  $('#activity').replaceChildren(activity);
  const select = $('#task-select'); select.replaceChildren(); const root = el('option', 'Authority / original grant'); root.value = 'root'; select.append(root);
  result.tasks.forEach((task, i) => { const option = el('option', `${names[task.provider]} · ${task.action} · ${task.status}`); option.value = i; select.append(option); });
  const firstDenial = result.tasks.findIndex(t => t.status === 'denied');
  const searchTask = result.tasks.findIndex(t => t.provider === 'search');
  select.value = result.tasks.length ? String(firstDenial >= 0 ? firstDenial : searchTask >= 0 ? searchTask : 0) : 'root';
  showBiscuit(); renderLedger(); playback.render(result);
  const historyIndex = runHistory.findIndex(run => run.request_id === result.request_id);
  renderComparison($('#compare'), result, runHistory[historyIndex + 1]);
  if ($('#debug').hidden && $('#compare').hidden) switchTab('biscuit');
}
function renderLedger() {
  const content = $('#ledger-content'); content.replaceChildren();
  content.append(el('p', `Payer: ${latest.payer} · Original request: ${latest.request_id}`, 'code-caption'));
  const table = el('table', undefined, 'ledger-table'); const head = el('thead'); const header = el('tr'); ['Operation', 'Operator', 'Credits', 'State'].forEach(text => header.append(el('th', text))); head.append(header); table.append(head);
  const body = el('tbody'); latest.ledger.operations.forEach(operation => { const row = el('tr'); [operation.id, names[operation.provider], String(operation.amount), operation.status].forEach(text => row.append(el('td', text))); body.append(row); }); table.append(body); content.append(table);
  const balances = el('div', undefined, 'balance-pills'); Object.entries(latest.ledger.balances).forEach(([operator, amount]) => balances.append(el('span', `${names[operator]} +${amount} cr`))); content.append(balances);
  if (!latest.ledger.operations.length) content.append(el('p', 'No reservations or charges were made.', 'code-caption'));
  latest.ledger.operations.forEach(operation => details(content, `${names[operation.provider]} · reservation and receipt · ${operation.id}`, operation));
}
document.querySelectorAll('.node[data-operator]').forEach(node => node.onclick = () => { switchTab('biscuit'); if (latest) { const index = latest.tasks.findLastIndex(t => t.provider === node.dataset.operator); $('#task-select').value = index === -1 ? 'root' : String(index); showBiscuit(); } });
$('#run').onclick = async () => {
  if (!$('#budget').reportValidity()) return;
  const accepts = {}; for (const operator of Object.keys(names)) accepts[operator] = [...document.querySelectorAll(`#accepts input[data-operator="${operator}"]:checked`)].map(input => input.dataset.requester);
  const config = { scenario: $('#scenario').value, budget: Number($('#budget').value), requester: $('#requester').value, edges, accepts };
  $('#run').disabled = true; $('#run').textContent = 'Verifying & settling…'; $('#error').hidden = true;
  try { const result = await debuggerView.run(config); runHistory.unshift(result); runHistory = runHistory.slice(0, 10); render(result); }
  catch (error) { $('#error').textContent = error.message; $('#error').hidden = false; }
  finally { $('#run').disabled = false; $('#run').replaceChildren(document.createTextNode('Run network'), el('span', '↗')); }
};
$('#export').onclick = () => { const url = URL.createObjectURL(new Blob([JSON.stringify(latest, null, 2)], { type: 'application/json' })); const a = el('a'); a.href = url; a.download = `relay-${latest.request_id}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); };
renderEdges(); scenarioChanged();
if (['debug', 'compare'].includes(location.hash.slice(1))) switchTab(location.hash.slice(1));
$('#run').click();
