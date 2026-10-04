"""Local laboratory: real Biscuit/Ed25519 verification, simulated operators and credits."""
from __future__ import annotations

import base64
import hashlib
import json
import re
import sqlite3
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from uuid import uuid4

from biscuit_auth import AuthorizerBuilder, Biscuit, BiscuitBuilder, BlockBuilder, KeyPair, Rule
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat


OPERATORS = {"planner": "PlannerCo", "research": "ResearchCo", "search": "SearchCo", "compute": "ComputeCo"}
DEFAULT_EDGES = [["planner", "research"], ["research", "search"], ["planner", "compute"]]
SCENARIOS = {"happy", "payer_swap", "forbidden", "untrusted", "overspend", "retry", "failure"}


class Rejected(Exception):
    def __init__(self, message, decision=None, trace=None):
        super().__init__(message)
        self.decision = decision
        self.trace = trace


class InsufficientCredits(Rejected):
    def __init__(self, requested, available):
        super().__init__(f"Insufficient credits: {requested} requested, {available} available")
        self.requested = requested
        self.available = available


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


class Identity:
    def __init__(self, name):
        self.name = name
        self._key = Ed25519PrivateKey.generate()
        self.public = self._key.public_key()

    def sign(self, payload):
        return {"payload": payload, "signature": base64.b64encode(self._key.sign(canonical(payload))).decode()}


def verify(public, signed):
    try:
        public.verify(base64.b64decode(signed["signature"], validate=True), canonical(signed["payload"]))
    except Exception as exc:
        raise Rejected("Ed25519 signature verification failed") from exc
    return signed["payload"]


class Clearinghouse:
    """An isolated per-demo ledger. A lock + SQL transaction serializes reservations."""
    def __init__(self, budget, request_id, payer, identity, operator_keys):
        self.budget, self.request_id, self.payer = budget, request_id, payer
        self.identity, self.operator_keys = identity, operator_keys
        self.lock = threading.Lock()
        self.db = sqlite3.connect(":memory:", check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute("CREATE TABLE operations (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, provider TEXT NOT NULL, amount INTEGER NOT NULL CHECK(amount > 0), status TEXT NOT NULL, grant TEXT NOT NULL, receipt TEXT)")

    def reserve(self, payload):
        if payload["payer"] != self.payer or payload["request_id"] != self.request_id:
            raise Rejected("Clearinghouse: payer or original request does not match the funded account")
        amount = payload["amount"]
        if type(amount) is not int or amount <= 0:
            raise Rejected("Price must be a positive integer number of credits")
        fingerprint = digest(payload)
        with self.lock:
            self.db.execute("BEGIN IMMEDIATE")
            try:
                previous = self.db.execute("SELECT * FROM operations WHERE id = ?", (payload["operation_id"],)).fetchone()
                if previous:
                    if previous["fingerprint"] != fingerprint:
                        raise Rejected("Idempotency conflict: operation ID reused with different billing details")
                    if previous["status"] == "released":
                        raise Rejected("This operation was released; create a new operation ID")
                    self.db.commit()
                    return json.loads(previous["grant"]), True, previous["status"]
                used = self.db.execute("SELECT COALESCE(SUM(amount), 0) FROM operations WHERE status IN ('reserved', 'settled')").fetchone()[0]
                if used + amount > self.budget:
                    raise InsufficientCredits(amount, self.budget - used)
                grant = self.identity.sign({"operation_id": payload["operation_id"], "request_id": self.request_id, "payer": self.payer, "provider": payload["provider"], "amount": amount, "fingerprint": fingerprint, "available_before": self.budget - used})
                self.db.execute("INSERT INTO operations VALUES (?, ?, ?, ?, 'reserved', ?, NULL)", (payload["operation_id"], fingerprint, payload["provider"], amount, json.dumps(grant)))
                self.db.commit()
                return grant, False, "reserved"
            except Exception:
                self.db.rollback()
                raise

    def settle(self, receipt):
        provider = receipt["payload"]["provider"]
        if provider not in self.operator_keys:
            raise Rejected("Unknown receipt signer")
        proof = verify(self.operator_keys[provider], receipt)
        if proof.get("result") != "completed":
            raise Rejected("Receipt does not prove completion")
        with self.lock, self.db:
            row = self.db.execute("SELECT * FROM operations WHERE id = ?", (proof["operation_id"],)).fetchone()
            if not row or row["provider"] != provider or proof.get("grant_hash") != digest(json.loads(row["grant"])):
                raise Rejected("Receipt is not bound to this provider and reservation")
            if row["status"] == "released":
                raise Rejected("Cannot settle a released reservation")
            self.db.execute("UPDATE operations SET status = 'settled', receipt = ? WHERE id = ?", (json.dumps(receipt), proof["operation_id"]))

    def release(self, operation_id):
        with self.lock, self.db:
            self.db.execute("UPDATE operations SET status = 'released' WHERE id = ? AND status = 'reserved'", (operation_id,))

    def snapshot(self):
        with self.lock:
            rows = [dict(row) for row in self.db.execute("SELECT * FROM operations ORDER BY rowid")]
        for row in rows:
            row["grant"] = json.loads(row["grant"])
            row["receipt"] = json.loads(row["receipt"]) if row["receipt"] else None
        settled = sum(row["amount"] for row in rows if row["status"] == "settled")
        reserved = sum(row["amount"] for row in rows if row["status"] == "reserved")
        return {"budget": self.budget, "settled": settled, "reserved": reserved, "available": self.budget - settled - reserved, "operations": rows,
                "balances": {name: sum(row["amount"] for row in rows if row["provider"] == name and row["status"] == "settled") for name in OPERATORS}}


AUTHORITY = '''requester({requester});
payer({payer});
request_id({request_id});
right("research"); right("search"); right("compute");
check if billing_payer($p), payer($p);
check if current_request($r), request_id($r);
check if action($a), right($a);
check if time($t), $t < {expiry};'''

POLICY = '''allow if requester($r), accepts_requester($r),
    caller($c), service($s), trusts_caller($c, $s),
    payer($p), billing_payer($p),
    request_id($id), current_request($id),
    action($a), right($a), offers($a);'''

# The inspector uses Biscuit's own query engine to collect the scoped facts that
# the receiving authorizer can see. These rows explain a decision; authorize()
# remains the sole source of the actual permit/deny result.
FACT_ARITY = {
    'requester': 1, 'accepts_requester': 1, 'caller': 1, 'service': 1,
    'trusts_caller': 2, 'payer': 1, 'billing_payer': 1,
    'request_id': 1, 'current_request': 1, 'action': 1,
    'right': 1, 'offers': 1,
}


def visible_facts(authorizer):
    found = {}
    for name, arity in FACT_ARITY.items():
        variables = ', '.join(f'$v{i}' for i in range(arity))
        rule = Rule(f'inspected({variables}) <- {name}({variables})')
        found[name] = [list(fact.terms) for fact in authorizer.query(rule)]
    return found


def ground(name, values):
    return name + '(' + ', '.join(json.dumps(value) for value in values) + ')'


class Demo:
    def __init__(self, config=None):
        config = config or {}
        self.scenario = config.get("scenario", "happy")
        if self.scenario not in SCENARIOS:
            raise ValueError("Unknown scenario")
        self.budget = config.get("budget", 100)
        if type(self.budget) is not int or not 1 <= self.budget <= 10000:
            raise ValueError("Budget must be an integer from 1 to 10000")
        self.requester = config.get("requester", "alice")
        if self.requester not in ("alice", "bob"):
            raise ValueError("Choose Alice or Bob")
        self.payer = "alice-org" if self.requester == "alice" else "bob-org"
        self.edges = config.get("edges", DEFAULT_EDGES)
        if not isinstance(self.edges, list) or len(self.edges) > 16 or any(not isinstance(e, list) or len(e) != 2 or any(v not in OPERATORS for v in e) or e[0] == e[1] for e in self.edges):
            raise ValueError("Trust edges must connect two different known operators")
        self.accepts = config.get("accepts", {op: ["alice", "bob"] for op in OPERATORS})
        if not isinstance(self.accepts, dict) or any(not isinstance(self.accepts.get(op), list) or any(r not in ("alice", "bob") for r in self.accepts[op]) for op in OPERATORS):
            raise ValueError("Each operator must list its accepted requesters")
        self.request_id = "req-" + uuid4().hex[:8]
        self.root = KeyPair()
        self.identities = {name: Identity(name) for name in OPERATORS}
        self.clearing_identity = Identity("clearinghouse")
        self.ledger = Clearinghouse(self.budget, self.request_id, self.payer, self.clearing_identity, {n: i.public for n, i in self.identities.items()})
        self.events, self.tasks = [], []
        self.event_lock = threading.Lock()
        self.expiry = datetime.now(timezone.utc) + timedelta(minutes=15)
        self.root_token = BiscuitBuilder(AUTHORITY, {"requester": self.requester, "payer": self.payer, "request_id": self.request_id, "expiry": self.expiry}).build(self.root.private_key)

    def event(self, kind, operator, message, **extra):
        with self.event_lock:
            self.events.append({"index": len(self.events) + 1, "kind": kind, "operator": operator, "message": message, **extra})

    def delegate(self, parent_token, caller, provider, actions, parent_task="root", parent_proof=None):
        # Attenuation is a restriction, never evidence of which actor added a block.
        clause = " or ".join(f'action("{a}")' for a in actions)
        token = parent_token.append(BlockBuilder("check if " + clause + ";"))
        task_id = "task-" + uuid4().hex[:8]
        proof = self.identities[caller].sign({"request_id": self.request_id, "task_id": task_id, "parent_task": parent_task, "caller": caller, "provider": provider, "allowed_actions": actions, "token_hash": digest(token.to_base64()), "token": token.to_base64(), "parent_proof_hash": digest(parent_proof) if parent_proof else None})
        return token, proof

    def explain(self, authorizer, payload, proof_chain, verified, now):
        facts = visible_facts(authorizer)
        requester = facts['requester'][0][0] if facts['requester'] else None
        rows = []

        def add(name, values, source):
            matches = facts[name]
            rows.append({
                'logic': ground(name, values),
                'present': list(values) in matches,
                'source': source,
                'available': [ground(name, match) for match in matches],
            })

        add('requester', [requester], 'Biscuit authority')
        add('accepts_requester', [requester], f'{OPERATORS[payload["provider"]]} policy')
        add('caller', [payload['caller']], 'verified caller signature')
        add('service', [payload['provider']], 'receiving operator')
        add('trusts_caller', [payload['caller'], payload['provider']], f'{OPERATORS[payload["provider"]]} policy')
        add('payer', [payload['payer']], 'Biscuit authority')
        add('billing_payer', [payload['payer']], 'verified call')
        add('request_id', [payload['request_id']], 'Biscuit authority')
        add('current_request', [payload['request_id']], 'verified call')
        add('action', [payload['action']], 'verified call')
        add('right', [payload['action']], 'Biscuit authority')
        add('offers', [payload['action']], f'{OPERATORS[payload["provider"]]} policy')
        restrictions = []
        for index, proof in enumerate(proof_chain, start=1):
            allowed = proof['payload']['allowed_actions']
            restrictions.append({
                'block': index,
                'logic': 'check if ' + ' or '.join(ground('action', [action]) for action in allowed),
                'action': payload['action'],
                'passed': payload['action'] in allowed,
            })
        expiry_text = re.search(r'check if time\(\$t\), \$t < ([^;]+);', verified.block_source(0)).group(1)
        expiry = datetime.fromisoformat(expiry_text.replace('Z', '+00:00'))
        return {
            'phase': 'datalog',
            'issuer_values': {'requester': requester, 'payer': facts['payer'][0][0] if facts['payer'] else None,
                              'request_id': facts['request_id'][0][0] if facts['request_id'] else None,
                              'rights': [item[0] for item in facts['right']]},
            'call_values': {'caller': payload['caller'], 'service': payload['provider'], 'payer': payload['payer'],
                            'request_id': payload['request_id'], 'action': payload['action'], 'amount': payload['amount']},
            'rows': rows, 'restrictions': restrictions,
            'token_checks': [
                {'logic': 'check if billing_payer($p), payer($p)', 'passed': rows[5]['present'] and rows[6]['present']},
                {'logic': 'check if current_request($r), request_id($r)', 'passed': rows[7]['present'] and rows[8]['present']},
                {'logic': 'check if action($a), right($a)', 'passed': rows[9]['present'] and rows[10]['present']},
                {'logic': f'check if time($t), $t < {expiry_text}', 'passed': now < expiry},
            ],
        }

    def authorize(self, token_string, signed_call, proof_chain):
        caller = signed_call["payload"]["caller"]
        if caller not in self.identities:
            raise Rejected("Unknown caller")
        payload = verify(self.identities[caller].public, signed_call)
        if payload["token_hash"] != digest(token_string):
            raise Rejected("Signed call does not match the presented Biscuit")
        if not proof_chain:
            raise Rejected("Delegation evidence missing")
        previous = None
        previous_blocks = self.root_token.revocation_ids
        for proof in proof_chain:
            entry = proof["payload"]
            if entry["caller"] not in self.identities:
                raise Rejected("Unknown delegation signer")
            verify(self.identities[entry["caller"]].public, proof)
            try:
                hop_token = Biscuit.from_base64(entry["token"], self.root.public_key)
            except Exception as exc:
                raise Rejected("Biscuit signature rejected: issuer is not the trusted clearinghouse") from exc
            if digest(entry["token"]) != entry["token_hash"]:
                raise Rejected("Delegation evidence does not match its token")
            blocks = hop_token.revocation_ids
            if len(blocks) <= len(previous_blocks) or blocks[:len(previous_blocks)] != previous_blocks:
                raise Rejected("Child Biscuit must extend the parent token without dropping restrictions")
            previous_blocks = blocks
            if entry["request_id"] != self.request_id or entry["parent_proof_hash"] != (digest(previous) if previous else None):
                raise Rejected("Delegation chain is not bound to the original request")
            if previous:
                if entry["caller"] != previous["payload"]["provider"] or entry["parent_task"] != previous["payload"]["task_id"]:
                    raise Rejected("Delegation parent does not match the upstream task")
            elif entry["caller"] != "planner" or entry["parent_task"] != "root":
                raise Rejected("Delegation must start at the authorized planner")
            previous = proof
        last = previous["payload"]
        if any(last[k] != payload[k] for k in ("caller", "provider", "task_id", "request_id", "token_hash")):
            raise Rejected("Call does not match the signed delegation")
        try:
            verified = Biscuit.from_base64(token_string, self.root.public_key)
        except Exception as exc:
            raise Rejected("Biscuit signature rejected: issuer is not the trusted clearinghouse") from exc
        provider = payload["provider"]
        builder = AuthorizerBuilder(POLICY)
        now = datetime.now(timezone.utc)
        builder.add_code('caller({caller}); service({service}); billing_payer({payer}); current_request({request}); action({action}); offers({offer}); time({now});', {"caller": caller, "service": provider, "payer": payload["payer"], "request": payload["request_id"], "action": payload["action"], "offer": provider, "now": now})
        for who in self.accepts[provider]:
            builder.add_code("accepts_requester({who});", {"who": who})
        for source, target in self.edges:
            if target == provider:
                builder.add_code("trusts_caller({source}, {target});", {"source": source, "target": target})
        # The inspector makes several read-only fact queries before authorize().
        # Give that combined work a bounded window while retaining fact limits.
        limits = builder.limits()
        limits.max_time = timedelta(milliseconds=250)
        builder.set_limits(limits)
        authorizer = builder.build(verified)
        decision = self.explain(authorizer, payload, proof_chain, verified, now)
        try:
            authorizer.authorize()
        except Exception as exc:
            decision['permitted'] = False
            decision['summary'] = 'Biscuit authorization denied this call. Red rows show facts that did not match.'
            raise Rejected("Datalog denied this call: " + str(exc), decision, str(authorizer)) from exc
        decision['permitted'] = True
        decision['summary'] = 'Biscuit authorization passed: all required facts and token checks matched.'
        return payload, str(authorizer), decision

    def execute(self, token, proof_chain, action, amount, operation_id=None, payer=None, fail=False, repeat=False):
        proof = proof_chain[-1]["payload"]
        provider, caller = proof["provider"], proof["caller"]
        payload = {"caller": caller, "provider": provider, "action": action, "amount": amount, "payer": payer or self.payer, "request_id": self.request_id, "task_id": proof["task_id"], "operation_id": operation_id or "op-" + uuid4().hex[:8], "token_hash": digest(token.to_base64())}
        call = self.identities[caller].sign(payload)
        task = {**payload, "parent_task": proof["parent_task"], "status": "pending", "blocks": [token.block_source(i) for i in range(token.block_count())], "token": token.to_base64(), "proof_chain": proof_chain, "call": call, "policy": POLICY}
        with self.event_lock:
            self.tasks.append(task)
        self.event("delegated", provider, f"{OPERATORS[caller]} → {OPERATORS[provider]}: {action}", task_id=payload["task_id"])
        try:
            checked, trace, decision = self.authorize(token.to_base64(), call, proof_chain)
            task["authorizer"], task["decision"] = trace, decision
            self.event("authorized", provider, "Biscuit, caller signature and requester policy verified")
            # The clearinghouse independently repeats verification at its boundary.
            self.authorize(token.to_base64(), call, proof_chain)
            grant, duplicate, status = self.ledger.reserve(checked)
            verify(self.clearing_identity.public, grant)
            if grant["payload"]["fingerprint"] != digest(payload):
                raise Rejected("Reservation does not match the authorized call")
            task["grant"] = grant
            task["decision"]["billing"] = {"requested": amount, "available_before": grant['payload']['available_before'], "passed": True,
                                             "reason": 'Existing reservation reused' if duplicate else f'{amount} ≤ {grant["payload"]["available_before"]} available credits'}
            if duplicate and status == "settled":
                task["status"] = "reused"
                task['decision']['summary'] = 'Biscuit allowed the call; the clearinghouse reused the existing settlement for this operation ID.'
                self.event("reused", provider, "Retry returned the existing settlement; no additional work or charge")
                return task
            self.event("reserved", provider, f"{amount} credits reserved against {self.payer}")
            if fail:
                self.ledger.release(payload["operation_id"])
                task["status"] = "released"
                task['decision']['summary'] = 'Biscuit allowed the call; simulated execution failed and the clearinghouse released its reservation.'
                self.event("released", provider, f"Simulated operation failed; {amount} credits released")
                return task
            receipt = self.identities[provider].sign({"operation_id": payload["operation_id"], "provider": provider, "grant_hash": digest(grant), "result": "completed"})
            self.ledger.settle(receipt)
            task["status"], task["receipt"] = "settled", receipt
            self.event("settled", provider, f"{amount} credits charged to {self.payer}; signed receipt verified")
            if repeat:
                self.execute(token, proof_chain, action, amount, payload["operation_id"])
        except Rejected as exc:
            task["status"], task["error"] = "denied", str(exc)
            if exc.decision:
                task['decision'] = exc.decision
            elif not task.get('decision'):
                task['decision'] = {'phase': 'verification', 'permitted': False, 'summary': str(exc), 'rows': [], 'restrictions': [], 'token_checks': []}
            if exc.trace:
                task['authorizer'] = exc.trace
            if isinstance(exc, InsufficientCredits):
                task['decision']['billing'] = {'requested': exc.requested, 'available_before': exc.available, 'passed': False,
                                                'reason': f'{exc.requested} > {exc.available} available credits'}
                task['decision']['summary'] = 'Biscuit allowed the call; the clearinghouse denied its credit reservation.'
            self.event("denied", provider, str(exc))
        return task

    def run(self):
        self.event("issued", "clearinghouse", f"{self.requester.title()} authorized {self.budget} credits from {self.payer}")
        planner_policy = AuthorizerBuilder('allow if requester($r), accepts_requester($r);')
        for who in self.accepts['planner']:
            planner_policy.add_code('accepts_requester({who});', {'who': who})
        # The root grant's operation/billing checks still apply at ingress.
        planner_policy.add_code('billing_payer({payer}); current_request({request}); action("research"); time({now});', {'payer': self.payer, 'request': self.request_id, 'now': datetime.now(timezone.utc)})
        self.root_decision = {
            'phase': 'ingress', 'permitted': False,
            'issuer_values': {'requester': self.requester, 'payer': self.payer, 'request_id': self.request_id},
            'rows': [
                {'logic': ground('requester', [self.requester]), 'present': True, 'source': 'Biscuit authority', 'available': [ground('requester', [self.requester])]},
                {'logic': ground('accepts_requester', [self.requester]), 'present': self.requester in self.accepts['planner'], 'source': 'PlannerCo policy',
                 'available': [ground('accepts_requester', [who]) for who in self.accepts['planner']]},
            ],
            'token_checks': [], 'restrictions': [],
        }
        try:
            planner_policy.build(Biscuit.from_base64(self.root_token.to_base64(), self.root.public_key)).authorize()
        except Exception:
            self.root_decision['summary'] = 'PlannerCo denied the original request because its acceptance rule did not match.'
            self.event('denied', 'planner', 'PlannerCo does not accept this original requester; no downstream tasks were created')
            return self.result()
        self.root_decision['permitted'] = True
        self.root_decision['summary'] = 'PlannerCo accepted the original requester and started delegation.'
        research_token, research_proof = self.delegate(self.root_token, "planner", "research", ["research", "search"])
        research = self.execute(research_token, [research_proof], "research", 5)
        search_token, search_proof = self.delegate(research_token, "research", "search", ["search"], research_proof["payload"]["task_id"], research_proof)
        compute_token, compute_proof = self.delegate(self.root_token, "planner", "compute", ["compute"])
        if self.scenario == "untrusted":
            rogue = KeyPair()
            rogue_token = BiscuitBuilder(AUTHORITY, {"requester": self.requester, "payer": self.payer, "request_id": self.request_id, "expiry": self.expiry}).build(rogue.private_key)
            search_token, search_proof = self.delegate(rogue_token, "research", "search", ["search"], research_proof["payload"]["task_id"], research_proof)
        if research["status"] != "settled":
            self.event("skipped", "search", "Search task skipped because its parent research task was denied")
        elif self.scenario == "overspend":
            barrier = threading.Barrier(2)
            def parallel(token, chain, action):
                barrier.wait(timeout=10)
                return self.execute(token, chain, action, 60)
            with ThreadPoolExecutor(max_workers=2) as pool:
                futures = [pool.submit(parallel, search_token, [research_proof, search_proof], "search"), pool.submit(parallel, compute_token, [compute_proof], "compute")]
                for future in futures:
                    future.result()
        else:
            self.execute(search_token, [research_proof, search_proof], "delete" if self.scenario == "forbidden" else "search", 10, payer="mallory-org" if self.scenario == "payer_swap" else None, repeat=self.scenario == "retry", fail=self.scenario == "failure")
        if self.scenario != "overspend" or research["status"] != "settled":
            self.execute(compute_token, [compute_proof], "compute", 25)
        return self.result()

    def result(self):
        public_keys = {name: identity.public.public_bytes(Encoding.Raw, PublicFormat.Raw).hex() for name, identity in {**self.identities, 'clearinghouse': self.clearing_identity}.items()}
        verified_root = Biscuit.from_base64(self.root_token.to_base64(), self.root.public_key)
        root_facts = AuthorizerBuilder('allow if true;').build(verified_root)
        rights = sorted(fact.terms[0] for fact in root_facts.query(Rule('issued_right($right) <- right($right)')))
        authority = verified_root.block_source(0)
        expiry = re.search(r'check if time\(\$t\), \$t < ([^;]+);', authority).group(1)
        grant = {'requester': self.requester, 'payer': self.payer, 'request_id': self.request_id, 'rights': rights, 'expires': expiry}
        result = {"request_id": self.request_id, "requester": self.requester, "payer": self.payer, "scenario": self.scenario, "grant": grant, "root_public_key": str(self.root.public_key), "identity_public_keys_ed25519": public_keys, "authority": authority, "root_decision": self.root_decision, "events": self.events, "tasks": self.tasks, "ledger": self.ledger.snapshot(), "edges": self.edges, "accepts": self.accepts}
        self.ledger.db.close()
        return result
