import { Biscuit, KeyPair, SignatureAlgorithm, AuthorizerBuilder, Rule, biscuit, block, authorizer } from '@smithery/biscuit';

const OPERATORS = { planner: 'PlannerCo', research: 'ResearchCo', search: 'SearchCo', compute: 'ComputeCo' };
const DEFAULT_EDGES = [['planner', 'research'], ['research', 'search'], ['planner', 'compute']];
const SCENARIOS = new Set(['happy', 'payer_swap', 'forbidden', 'untrusted', 'overspend', 'retry', 'failure']);
const POLICY = `allow if requester($r), accepts_requester($r),
    caller($c), service($s), trusts_caller($c, $s),
    payer($p), billing_payer($p),
    request_id($id), current_request($id),
    action($a), right($a), offers($a);`;
const LIMITS = { max_facts: 1000, max_iterations: 100, max_time_micro: 250000 };
const FACT_ARITY = { requester: 1, accepts_requester: 1, caller: 1, service: 1, trusts_caller: 2,
  payer: 1, billing_payer: 1, request_id: 1, current_request: 1, action: 1, right: 1, offers: 1 };
const encoder = new TextEncoder();

class ValidationError extends Error { constructor(message) { super(message); this.name = 'ValidationError'; } }
class Rejected extends Error { constructor(message, decision, trace) { super(message); this.decision = decision; this.trace = trace; } }
class InsufficientCredits extends Rejected {
  constructor(requested, available) { super(`Insufficient credits: ${requested} requested, ${available} available`); this.requested = requested; this.available = available; }
}
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function hex(bytes) { return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join(''); }
async function digest(value) { return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(stable(value))))); }
function base64(bytes) { return btoa(String.fromCharCode(...bytes)); }
function unbase64(text) { return Uint8Array.from(atob(text), char => char.charCodeAt(0)); }
function id(prefix) { return `${prefix}-${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`; }
function ground(name, values) { return `${name}(${values.map(value => JSON.stringify(value)).join(', ')})`; }
function sourceRows(name, values, available, source) {
  return { logic: ground(name, values), present: available.some(row => stable(row) === stable(values)), source,
    available: available.map(row => ground(name, row)) };
}
function visibleFacts(built) {
  return Object.fromEntries(Object.entries(FACT_ARITY).map(([name, arity]) => {
    const vars = Array.from({ length: arity }, (_, index) => `$v${index}`).join(', ');
    const rule = Rule.fromString(`inspected(${vars}) <- ${name}(${vars})`);
    return [name, built.queryWithLimits(rule, LIMITS).map(fact => fact.terms())];
  }));
}

class Identity {
  static async create() {
    const keys = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
    return new Identity(keys.privateKey, keys.publicKey);
  }
  constructor(privateKey, publicKey) { this.privateKey = privateKey; this.publicKey = publicKey; }
  async sign(payload) {
    const signature = await crypto.subtle.sign('Ed25519', this.privateKey, encoder.encode(stable(payload)));
    return { payload, signature: base64(new Uint8Array(signature)) };
  }
  async publicHex() { return hex(new Uint8Array(await crypto.subtle.exportKey('raw', this.publicKey))); }
}
async function verify(identity, signed) {
  const valid = await crypto.subtle.verify('Ed25519', identity.publicKey, unbase64(signed.signature), encoder.encode(stable(signed.payload)));
  if (!valid) throw new Rejected('Ed25519 signature verification failed');
  return signed.payload;
}

class Clearinghouse {
  constructor(budget, requestId, payer, identity, identities) {
    Object.assign(this, { budget, requestId, payer, identity, identities });
    this.operations = new Map();
    this.reservationQueue = Promise.resolve();
  }
  reserve(payload) {
    const pending = this.reservationQueue.then(() => this.reserveLocked(payload));
    this.reservationQueue = pending.catch(() => {});
    return pending;
  }
  async reserveLocked(payload) {
    if (payload.payer !== this.payer || payload.request_id !== this.requestId) throw new Rejected('Clearinghouse: payer or original request does not match the funded account');
    if (!Number.isInteger(payload.amount) || payload.amount <= 0) throw new Rejected('Price must be a positive integer number of credits');
    const fingerprint = await digest(payload);
    const previous = this.operations.get(payload.operation_id);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new Rejected('Idempotency conflict: operation ID reused with different billing details');
      if (previous.status === 'released') throw new Rejected('This operation was released; create a new operation ID');
      return { grant: previous.grant, duplicate: true, status: previous.status };
    }
    const used = [...this.operations.values()].filter(row => row.status !== 'released').reduce((total, row) => total + row.amount, 0);
    if (used + payload.amount > this.budget) throw new InsufficientCredits(payload.amount, this.budget - used);
    const grant = await this.identity.sign({ operation_id: payload.operation_id, request_id: this.requestId, payer: this.payer,
      provider: payload.provider, amount: payload.amount, fingerprint, available_before: this.budget - used });
    this.operations.set(payload.operation_id, { id: payload.operation_id, fingerprint, provider: payload.provider, amount: payload.amount,
      status: 'reserved', grant, receipt: null });
    return { grant, duplicate: false, status: 'reserved' };
  }
  async settle(receipt) {
    const provider = receipt.payload.provider;
    if (!this.identities[provider]) throw new Rejected('Unknown receipt signer');
    const proof = await verify(this.identities[provider], receipt);
    if (proof.result !== 'completed') throw new Rejected('Receipt does not prove completion');
    const row = this.operations.get(proof.operation_id);
    if (!row || row.provider !== provider || proof.grant_hash !== await digest(row.grant)) throw new Rejected('Receipt is not bound to this provider and reservation');
    if (row.status === 'released') throw new Rejected('Cannot settle a released reservation');
    row.status = 'settled'; row.receipt = receipt;
  }
  release(operationId) { const row = this.operations.get(operationId); if (row?.status === 'reserved') row.status = 'released'; }
  snapshot() {
    const operations = [...this.operations.values()];
    const settled = operations.filter(row => row.status === 'settled').reduce((sum, row) => sum + row.amount, 0);
    const reserved = operations.filter(row => row.status === 'reserved').reduce((sum, row) => sum + row.amount, 0);
    return { budget: this.budget, settled, reserved, available: this.budget - settled - reserved, operations,
      balances: Object.fromEntries(Object.keys(OPERATORS).map(name => [name, operations.filter(row => row.provider === name && row.status === 'settled').reduce((sum, row) => sum + row.amount, 0)])) };
  }
}

class Demo {
  static async create(config = {}) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new ValidationError('Settings must be an object');
    const demo = new Demo(config);
    demo.identities = Object.fromEntries(await Promise.all(Object.keys(OPERATORS).map(async name => [name, await Identity.create()])));
    demo.clearingIdentity = await Identity.create();
    demo.ledger = new Clearinghouse(demo.budget, demo.requestId, demo.payer, demo.clearingIdentity, demo.identities);
    const root = new KeyPair(SignatureAlgorithm.Ed25519);
    demo.rootPrivate = root.getPrivateKey(); demo.rootPublic = root.getPublicKey();
    demo.expiry = new Date(Date.now() + 15 * 60_000);
    demo.rootToken = demo.mint(demo.rootPrivate);
    return demo;
  }
  constructor(config) {
    this.scenario = config.scenario ?? 'happy';
    if (!SCENARIOS.has(this.scenario)) throw new ValidationError('Unknown scenario');
    this.budget = config.budget ?? 100;
    if (!Number.isInteger(this.budget) || this.budget < 1 || this.budget > 10000) throw new ValidationError('Budget must be an integer from 1 to 10000');
    this.requester = config.requester ?? 'alice';
    if (!['alice', 'bob'].includes(this.requester)) throw new ValidationError('Choose Alice or Bob');
    this.payer = this.requester === 'alice' ? 'alice-org' : 'bob-org';
    this.edges = config.edges ?? DEFAULT_EDGES;
    if (!Array.isArray(this.edges) || this.edges.length > 16 || this.edges.some(edge => !Array.isArray(edge) || edge.length !== 2 || edge.some(value => !Object.hasOwn(OPERATORS, value)) || edge[0] === edge[1])) throw new ValidationError('Trust edges must connect two different known operators');
    this.accepts = config.accepts ?? Object.fromEntries(Object.keys(OPERATORS).map(name => [name, ['alice', 'bob']]));
    if (!this.accepts || typeof this.accepts !== 'object' || Object.keys(OPERATORS).some(name => !Array.isArray(this.accepts[name]) || this.accepts[name].some(value => !['alice', 'bob'].includes(value)))) throw new ValidationError('Each operator must list its accepted requesters');
    this.requestId = id('req'); this.events = []; this.tasks = []; this.debug = [];
  }
  mint(privateKey) {
    return biscuit`requester(${this.requester}); payer(${this.payer}); request_id(${this.requestId});
      right("research"); right("search"); right("compute");
      check if billing_payer($p), payer($p);
      check if current_request($r), request_id($r);
      check if action($a), right($a);
      check if time($t), $t < ${this.expiry};`.build(privateKey);
  }
  event(kind, operator, message, extra = {}) {
    const ledger = this.ledger.snapshot();
    const states = { ...Object.fromEntries(Object.keys(OPERATORS).map(name => [name, 'waiting'])), ...this.events.at(-1)?.snapshot.operator_states };
    if (Object.hasOwn(states, operator)) states[operator] = kind;
    this.events.push({ index: this.events.length + 1, kind, operator, message, ...extra,
      task_index: this.tasks.findLastIndex(task => task.provider === operator),
      snapshot: { operator_states: states, ledger: { budget: ledger.budget, settled: ledger.settled, reserved: ledger.reserved, available: ledger.available } } });
  }
  async delegate(parentToken, caller, provider, actions, parentTask = 'root', parentProof = null) {
    const check = `check if ${actions.map(action => ground('action', [action])).join(' or ')};`;
    const restriction = block``; restriction.addCode(check);
    const token = parentToken.appendBlock(restriction);
    const tokenText = token.toBase64();
    const proof = await this.identities[caller].sign({ request_id: this.requestId, task_id: id('task'), parent_task: parentTask,
      caller, provider, allowed_actions: actions, token_hash: await digest(tokenText), token: tokenText,
      parent_proof_hash: parentProof ? await digest(parentProof) : null });
    return [token, proof];
  }
  explain(built, payload, proofChain, verified, now) {
    const facts = visibleFacts(built);
    const issuer = { requester: facts.requester[0]?.[0] ?? null, payer: facts.payer[0]?.[0] ?? null,
      request_id: facts.request_id[0]?.[0] ?? null, rights: facts.right.map(row => row[0]) };
    const rows = [];
    const add = (name, values, available, source) => rows.push(sourceRows(name, values, available, source));
    add('requester', [issuer.requester], facts.requester, 'Biscuit authority');
    add('accepts_requester', [issuer.requester], facts.accepts_requester, `${OPERATORS[payload.provider]} policy`);
    add('caller', [payload.caller], facts.caller, 'verified caller signature');
    add('service', [payload.provider], facts.service, 'receiving operator');
    add('trusts_caller', [payload.caller, payload.provider], facts.trusts_caller, `${OPERATORS[payload.provider]} policy`);
    add('payer', [payload.payer], facts.payer, 'Biscuit authority');
    add('billing_payer', [payload.payer], facts.billing_payer, 'verified call');
    add('request_id', [payload.request_id], facts.request_id, 'Biscuit authority');
    add('current_request', [payload.request_id], facts.current_request, 'verified call');
    add('action', [payload.action], facts.action, 'verified call');
    add('right', [payload.action], facts.right, 'Biscuit authority');
    add('offers', [payload.action], facts.offers, `${OPERATORS[payload.provider]} policy`);
    const restrictions = proofChain.map((proof, index) => ({ block: index + 1,
      logic: `check if ${proof.payload.allowed_actions.map(action => ground('action', [action])).join(' or ')}`,
      action: payload.action, passed: proof.payload.allowed_actions.includes(payload.action) }));
    const expiryText = verified.getBlockSource(0).match(/check if time\(\$t\), \$t < ([^;]+);/)?.[1] ?? this.expiry.toISOString();
    return { phase: 'datalog', issuer_values: issuer,
      call_values: { caller: payload.caller, service: payload.provider, payer: payload.payer, request_id: payload.request_id, action: payload.action, amount: payload.amount },
      rows, restrictions,
      token_checks: [
        { logic: 'check if billing_payer($p), payer($p)', passed: rows[5].present && rows[6].present },
        { logic: 'check if current_request($r), request_id($r)', passed: rows[7].present && rows[8].present },
        { logic: 'check if action($a), right($a)', passed: rows[9].present && rows[10].present },
        { logic: `check if time($t), $t < ${expiryText}`, passed: now < new Date(expiryText) },
      ] };
  }
  async traceCall(stage, operator, request, action, taskIndex = null, project = value => value) {
    const started = performance.now();
    const entry = { id: `${this.requestId}-${this.debug.length + 1}`, transport: 'internal', stage, operator,
      task_index: taskIndex, started_at: new Date().toISOString(), request: structuredClone(request), outcome: 'pending' };
    this.debug.push(entry);
    try {
      const value = await action();
      entry.response = structuredClone(project(value) ?? null);
      entry.outcome = 'allowed';
      return value;
    } catch (error) {
      entry.outcome = error instanceof Rejected ? 'denied' : 'error';
      entry.response = { error: error.message ?? JSON.stringify(error), decision: structuredClone(error.decision ?? null),
        authorizer: error.trace ?? null };
      if (error instanceof InsufficientCredits) Object.assign(entry.response, { requested: error.requested, available: error.available });
      throw error;
    } finally {
      entry.duration_ms = Math.max(0, Math.round((performance.now() - started) * 100) / 100);
    }
  }
  async authorize(tokenText, signedCall, proofChain, boundary, taskIndex) {
    const provider = signedCall.payload.provider;
    return this.traceCall('authorization', boundary, {
      token: tokenText, signed_call: signedCall, proof_chain: proofChain, trusted_issuer: this.rootPublic.toString(),
      policy: POLICY, accepts_requester: this.accepts[provider], trusts_caller: this.edges.filter(edge => edge[1] === provider),
    }, () => this.evaluateAuthorization(tokenText, signedCall, proofChain), taskIndex,
    ([payload, authorizer, decision]) => ({ permitted: true, payload, authorizer, decision }));
  }
  async evaluateAuthorization(tokenText, signedCall, proofChain) {
    const caller = signedCall.payload.caller;
    if (!this.identities[caller]) throw new Rejected('Unknown caller');
    const payload = await verify(this.identities[caller], signedCall);
    if (payload.token_hash !== await digest(tokenText)) throw new Rejected('Signed call does not match the presented Biscuit');
    if (!proofChain.length) throw new Rejected('Delegation evidence missing');
    let previous = null;
    let previousBlocks = this.rootToken.getRevocationIdentifiers();
    for (const proof of proofChain) {
      const entry = proof.payload;
      if (!this.identities[entry.caller]) throw new Rejected('Unknown delegation signer');
      await verify(this.identities[entry.caller], proof);
      let hopToken;
      try { hopToken = Biscuit.fromBase64(entry.token, this.rootPublic); }
      catch { throw new Rejected('Biscuit signature rejected: issuer is not the trusted clearinghouse'); }
      if (await digest(entry.token) !== entry.token_hash) throw new Rejected('Delegation evidence does not match its token');
      const blocks = hopToken.getRevocationIdentifiers();
      if (blocks.length <= previousBlocks.length || previousBlocks.some((value, index) => value !== blocks[index])) throw new Rejected('Child Biscuit must extend the parent token without dropping restrictions');
      previousBlocks = blocks;
      if (entry.request_id !== this.requestId || entry.parent_proof_hash !== (previous ? await digest(previous) : null)) throw new Rejected('Delegation chain is not bound to the original request');
      if (previous) {
        if (entry.caller !== previous.payload.provider || entry.parent_task !== previous.payload.task_id) throw new Rejected('Delegation parent does not match the upstream task');
      } else if (entry.caller !== 'planner' || entry.parent_task !== 'root') throw new Rejected('Delegation must start at the authorized planner');
      previous = proof;
    }
    if (['caller', 'provider', 'task_id', 'request_id', 'token_hash'].some(key => previous.payload[key] !== payload[key])) throw new Rejected('Call does not match the signed delegation');
    let verified;
    try { verified = Biscuit.fromBase64(tokenText, this.rootPublic); }
    catch { throw new Rejected('Biscuit signature rejected: issuer is not the trusted clearinghouse'); }
    const provider = payload.provider;
    const builder = new AuthorizerBuilder();
    builder.addCode(POLICY);
    // The policy is fixed source code. All added values come from validated names or JSON-quoted strings.
    builder.addCode(`caller(${JSON.stringify(caller)}); service(${JSON.stringify(provider)}); billing_payer(${JSON.stringify(payload.payer)});
      current_request(${JSON.stringify(payload.request_id)}); action(${JSON.stringify(payload.action)}); offers(${JSON.stringify(provider)});`);
    builder.merge(authorizer`time(${new Date()});`);
    for (const who of this.accepts[provider]) builder.addCode(`accepts_requester(${JSON.stringify(who)});`);
    for (const [source, target] of this.edges) if (target === provider) builder.addCode(`trusts_caller(${JSON.stringify(source)}, ${JSON.stringify(target)});`);
    const built = builder.buildAuthenticated(verified);
    const decision = this.explain(built, payload, proofChain, verified, new Date());
    try { built.authorizeWithLimits(LIMITS); }
    catch (error) { decision.permitted = false; decision.summary = 'Biscuit authorization denied this call. Red rows show facts that did not match.';
      throw new Rejected(`Datalog denied this call: ${typeof error === 'string' ? error : JSON.stringify(error)}`, decision, built.toString()); }
    decision.permitted = true; decision.summary = 'Biscuit authorization passed: all required facts and token checks matched.';
    return [payload, built.toString(), decision];
  }
  async execute(token, proofChain, action, amount, options = {}) {
    const proof = proofChain.at(-1).payload;
    const { provider, caller } = proof;
    const payload = { caller, provider, action, amount, payer: options.payer ?? this.payer, request_id: this.requestId,
      task_id: proof.task_id, operation_id: options.operationId ?? id('op'), token_hash: await digest(token.toBase64()) };
    const call = await this.identities[caller].sign(payload);
    const task = { ...payload, parent_task: proof.parent_task, status: 'pending',
      blocks: Array.from({ length: token.countBlocks() }, (_, index) => token.getBlockSource(index)),
      token: token.toBase64(), proof_chain: proofChain, call, policy: POLICY };
    this.tasks.push(task);
    const taskIndex = this.tasks.length - 1;
    this.event('delegated', provider, `${OPERATORS[caller]} → ${OPERATORS[provider]}: ${action}`, { task_id: proof.task_id });
    try {
      const [checked, trace, decision] = await this.authorize(token.toBase64(), call, proofChain, provider, taskIndex);
      task.authorizer = trace; task.decision = decision;
      this.event('authorized', provider, 'Biscuit, caller signature and requester policy verified');
      await this.authorize(token.toBase64(), call, proofChain, 'clearinghouse', taskIndex);
      const { grant, duplicate, status } = await this.traceCall('reserve', 'clearinghouse', checked, () => this.ledger.reserve(checked), taskIndex);
      await verify(this.clearingIdentity, grant);
      if (grant.payload.fingerprint !== await digest(payload)) throw new Rejected('Reservation does not match the authorized call');
      task.grant = grant;
      task.decision.billing = { requested: amount, available_before: grant.payload.available_before, passed: true,
        reason: duplicate ? 'Existing reservation reused' : `${amount} ≤ ${grant.payload.available_before} available credits` };
      if (duplicate && status === 'settled') {
        task.status = 'reused'; task.decision.summary = 'Biscuit allowed the call; the clearinghouse reused the existing settlement for this operation ID.';
        this.event('reused', provider, 'Retry returned the existing settlement; no additional work or charge'); return task;
      }
      this.event('reserved', provider, `${amount} credits reserved against ${this.payer}`);
      this.event('executing', provider, 'Provider starts the simulated operation');
      if (options.fail) {
        await this.traceCall('release', 'clearinghouse', { operation_id: payload.operation_id }, () => {
          this.ledger.release(payload.operation_id); return { status: 'released', amount };
        }, taskIndex); task.status = 'released';
        task.decision.summary = 'Biscuit allowed the call; simulated execution failed and the clearinghouse released its reservation.';
        this.event('released', provider, `Simulated operation failed; ${amount} credits released`); return task;
      }
      const receipt = await this.identities[provider].sign({ operation_id: payload.operation_id, provider,
        grant_hash: await digest(grant), result: 'completed' });
      await this.traceCall('settle', 'clearinghouse', receipt, async () => {
        await this.ledger.settle(receipt); return { status: 'settled', operation_id: payload.operation_id, amount };
      }, taskIndex);
      task.status = 'settled'; task.receipt = receipt;
      this.event('settled', provider, `${amount} credits charged to ${this.payer}; signed receipt verified`);
      if (options.repeat) await this.execute(token, proofChain, action, amount, { operationId: payload.operation_id });
    } catch (error) {
      if (!(error instanceof Rejected)) throw error;
      task.status = 'denied'; task.error = error.message;
      task.decision = error.decision ?? task.decision ?? { phase: 'verification', permitted: false, summary: error.message,
        rows: [], restrictions: [], token_checks: [] };
      if (error.trace) task.authorizer = error.trace;
      if (error instanceof InsufficientCredits) {
        task.decision.billing = { requested: error.requested, available_before: error.available, passed: false,
          reason: `${error.requested} > ${error.available} available credits` };
        task.decision.summary = 'Biscuit allowed the call; the clearinghouse denied its credit reservation.';
      }
      this.event('denied', provider, error.message);
    }
    return task;
  }
  async run() {
    this.event('issued', 'clearinghouse', `${this.requester[0].toUpperCase()}${this.requester.slice(1)} authorized ${this.budget} credits from ${this.payer}`);
    const planner = authorizer`allow if requester($r), accepts_requester($r);`;
    for (const who of this.accepts.planner) planner.addCode(`accepts_requester(${JSON.stringify(who)});`);
    planner.addCode(`billing_payer(${JSON.stringify(this.payer)}); current_request(${JSON.stringify(this.requestId)}); action("research");`);
    planner.merge(authorizer`time(${new Date()});`);
    this.rootDecision = { phase: 'ingress', permitted: false,
      issuer_values: { requester: this.requester, payer: this.payer, request_id: this.requestId },
      rows: [sourceRows('requester', [this.requester], [[this.requester]], 'Biscuit authority'),
        sourceRows('accepts_requester', [this.requester], this.accepts.planner.map(who => [who]), 'PlannerCo policy')],
      token_checks: [], restrictions: [] };
    try {
      await this.traceCall('authorization', 'planner', { token: this.rootToken.toBase64(), trusted_issuer: this.rootPublic.toString(),
        authorizer: planner.toString(), requester: this.requester, payer: this.payer }, () => {
        try { planner.buildAuthenticated(Biscuit.fromBase64(this.rootToken.toBase64(), this.rootPublic)).authorizeWithLimits(LIMITS); }
        catch (error) { throw new Rejected(`Root authorization denied: ${JSON.stringify(error)}`, { ...this.rootDecision, permitted: false }); }
        return { permitted: true, decision: { ...this.rootDecision, permitted: true } };
      });
    }
    catch (error) {
      this.rootDecision.summary = 'PlannerCo denied the original request because its acceptance rule did not match.';
      this.event('denied', 'planner', 'PlannerCo does not accept this original requester; no downstream tasks were created');
      return this.result();
    }
    this.rootDecision.permitted = true;
    this.rootDecision.summary = 'PlannerCo accepted the original requester and started delegation.';
    this.event('accepted', 'planner', 'PlannerCo accepted the original requester and can delegate work');
    const [researchToken, researchProof] = await this.delegate(this.rootToken, 'planner', 'research', ['research', 'search']);
    const research = await this.execute(researchToken, [researchProof], 'research', 5);
    let [searchToken, searchProof] = await this.delegate(researchToken, 'research', 'search', ['search'], researchProof.payload.task_id, researchProof);
    const [computeToken, computeProof] = await this.delegate(this.rootToken, 'planner', 'compute', ['compute']);
    if (this.scenario === 'untrusted') {
      const rogue = new KeyPair(SignatureAlgorithm.Ed25519);
      [searchToken, searchProof] = await this.delegate(this.mint(rogue.getPrivateKey()), 'research', 'search', ['search'], researchProof.payload.task_id, researchProof);
    }
    if (research.status !== 'settled') this.event('skipped', 'search', 'Search task skipped because its parent research task was denied');
    else if (this.scenario === 'overspend') {
      await Promise.all([
        this.execute(searchToken, [researchProof, searchProof], 'search', 60),
        this.execute(computeToken, [computeProof], 'compute', 60),
      ]);
    } else await this.execute(searchToken, [researchProof, searchProof], this.scenario === 'forbidden' ? 'delete' : 'search', 10,
      { payer: this.scenario === 'payer_swap' ? 'mallory-org' : undefined, repeat: this.scenario === 'retry', fail: this.scenario === 'failure' });
    if (this.scenario !== 'overspend' || research.status !== 'settled') await this.execute(computeToken, [computeProof], 'compute', 25);
    return this.result();
  }
  async result() {
    const keys = Object.fromEntries(await Promise.all(Object.entries({ ...this.identities, clearinghouse: this.clearingIdentity })
      .map(async ([name, identity]) => [name, await identity.publicHex()])));
    const authority = this.rootToken.getBlockSource(0);
    const verifiedRoot = Biscuit.fromBase64(this.rootToken.toBase64(), this.rootPublic);
    const rootFacts = authorizer`allow if right("research");`.buildAuthenticated(verifiedRoot);
    const rights = rootFacts.queryWithLimits(Rule.fromString('issued_right($right) <- right($right)'), LIMITS)
      .map(fact => fact.terms()[0]).sort();
    const expires = authority.match(/check if time\(\$t\), \$t < ([^;]+);/)?.[1] ?? this.expiry.toISOString();
    return { request_id: this.requestId, requester: this.requester, payer: this.payer, scenario: this.scenario,
      grant: { requester: this.requester, payer: this.payer, request_id: this.requestId,
        rights, expires },
      root_public_key: this.rootPublic.toString(), identity_public_keys_ed25519: keys, authority,
      root_decision: this.rootDecision, events: this.events, tasks: this.tasks, ledger: this.ledger.snapshot(), edges: this.edges, accepts: this.accepts,
      debug: this.debug };
  }
}

export async function runDemo(config) { return (await Demo.create(config)).run(); }
