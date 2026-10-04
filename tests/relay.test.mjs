import test from 'node:test';
import assert from 'node:assert/strict';
import { runDemo } from '../lib/relay.js';

test('valid delegation settles across three independent operators', async () => {
  const run = await runDemo({ scenario: 'happy' });
  assert.equal(run.root_decision.permitted, true);
  assert.deepEqual(run.tasks.map(task => task.status), ['settled', 'settled', 'settled']);
  assert.equal(run.ledger.settled, 40);
  assert.deepEqual(run.grant.rights, ['compute', 'research', 'search']);
  assert.equal(run.tasks[1].decision.rows.find(row => row.logic === 'trusts_caller("research", "search")').present, true);
});

test('payer change and forbidden action fail Biscuit checks before billing', async () => {
  for (const scenario of ['payer_swap', 'forbidden']) {
    const run = await runDemo({ scenario });
    const denied = run.tasks.find(task => task.status === 'denied');
    assert.equal(denied.provider, 'search');
    assert.equal(denied.decision.phase, 'datalog');
    assert.equal(denied.decision.permitted, false);
    assert.ok(denied.decision.rows.some(row => !row.present));
    assert.equal(run.ledger.settled, 30);
  }
});

test('untrusted issuer is rejected before Datalog evaluation', async () => {
  const run = await runDemo({ scenario: 'untrusted' });
  const denied = run.tasks.find(task => task.status === 'denied');
  assert.equal(denied.decision.phase, 'verification');
  assert.match(denied.error, /trusted clearinghouse/);
});

test('custom caller trust and original requester acceptance affect the receiver', async () => {
  const noEdge = await runDemo({ edges: [['planner', 'research'], ['planner', 'compute']] });
  const search = noEdge.tasks.find(task => task.provider === 'search');
  assert.equal(search.status, 'denied');
  assert.equal(search.decision.rows.find(row => row.logic === 'trusts_caller("research", "search")').present, false);
  const rejectedRoot = await runDemo({ requester: 'bob', accepts: { planner: ['alice'], research: ['alice', 'bob'], search: ['alice', 'bob'], compute: ['alice', 'bob'] } });
  assert.equal(rejectedRoot.root_decision.permitted, false);
  assert.equal(rejectedRoot.tasks.length, 0);
});

test('concurrent reservations cannot spend more than the budget', async () => {
  const run = await runDemo({ scenario: 'overspend', budget: 100 });
  assert.equal(run.ledger.settled, 65);
  assert.equal(run.tasks.filter(task => task.status === 'denied').length, 1);
  assert.equal(run.tasks.find(task => task.status === 'denied').decision.billing.passed, false);
});

test('retry reuses settlement and failed work releases its reservation', async () => {
  const retry = await runDemo({ scenario: 'retry' });
  assert.equal(retry.tasks.filter(task => task.status === 'reused').length, 1);
  assert.equal(retry.ledger.operations.length, 3);
  assert.equal(retry.ledger.settled, 40);
  const failure = await runDemo({ scenario: 'failure' });
  assert.equal(failure.tasks.find(task => task.provider === 'search').status, 'released');
  assert.equal(failure.ledger.settled, 30);
  assert.equal(failure.ledger.available, 70);
});

test('invalid settings are rejected', async () => {
  await assert.rejects(runDemo({ budget: -1 }), /Budget must/);
  await assert.rejects(runDemo({ edges: [['planner', 'unknown']] }), /Trust edges/);
});

test('debug captures both authorization boundaries and immutable results', async () => {
  const run = await runDemo({ scenario: 'happy' });
  assert.equal(run.debug.length, 13);
  assert.equal(run.debug.filter(entry => entry.stage === 'authorization').length, 7);
  const auth = run.debug.find(entry => entry.operator === 'search');
  assert.equal(auth.transport, 'internal');
  assert.deepEqual(auth.request.signed_call, run.tasks[auth.task_index].call);
  assert.equal(auth.response.permitted, true);
  assert.equal(auth.response.decision.billing, undefined, 'Later billing must not mutate the recorded authorization response');
  assert.ok(run.debug.every(entry => Number.isFinite(entry.duration_ms) && entry.duration_ms >= 0));
  assert.ok(run.debug.every(entry => entry.response && entry.outcome !== 'pending'));
  assert.ok(!JSON.stringify(run.debug).includes('privateKey'));
});

test('debug records denials at the actual boundary and correlates retry attempts', async () => {
  const denied = await runDemo({ scenario: 'payer_swap' });
  const search = denied.debug.filter(entry => entry.task_index === 1);
  assert.equal(search.length, 1, 'Denied operator call must not reach billing');
  assert.equal(search[0].outcome, 'denied');
  assert.equal(search[0].response.decision.permitted, false);
  const overspend = await runDemo({ scenario: 'overspend' });
  const budgetDenial = overspend.debug.find(entry => entry.outcome === 'denied');
  assert.equal(budgetDenial.stage, 'reserve');
  assert.equal(budgetDenial.response.available, 35);
  const retry = await runDemo({ scenario: 'retry' });
  const reservations = retry.debug.filter(entry => entry.stage === 'reserve' && entry.request.provider === 'search');
  assert.equal(reservations.length, 2);
  assert.notEqual(reservations[0].task_index, reservations[1].task_index);
  assert.equal(reservations[1].response.duplicate, true);
});

test('replay snapshots preserve reservation and release balances without later mutation', async () => {
  const run = await runDemo({ scenario: 'failure' });
  const reserved = run.events.find(event => event.kind === 'reserved' && event.operator === 'search');
  const released = run.events.find(event => event.kind === 'released');
  assert.equal(reserved.snapshot.ledger.reserved, 10);
  assert.equal(reserved.snapshot.operator_states.search, 'reserved');
  assert.equal(released.snapshot.ledger.reserved, 0);
  assert.equal(released.snapshot.ledger.available - reserved.snapshot.ledger.available, 10);
  for (const event of run.events) {
    const ledger = event.snapshot.ledger;
    assert.equal(ledger.available + ledger.settled + ledger.reserved, ledger.budget);
  }
  assert.equal(run.events.at(-1).snapshot.ledger.settled, run.ledger.settled);
});
