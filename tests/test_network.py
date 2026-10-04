import copy
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

from biscuit_auth import BiscuitBuilder, BlockBuilder

from network import AUTHORITY, DEFAULT_EDGES, Demo, Rejected, digest


class NetworkTests(unittest.TestCase):
    def test_happy_path_settles_original_payer(self):
        result = Demo().run()
        self.assertEqual(result['grant']['rights'], ['compute', 'research', 'search'])
        self.assertEqual(result['grant']['requester'], 'alice')
        self.assertEqual(result['grant']['payer'], 'alice-org')
        self.assertEqual(result['grant']['request_id'], result['request_id'])
        self.assertEqual(result['ledger']['settled'], 40)
        self.assertEqual(result['ledger']['available'], 60)
        self.assertEqual(result['ledger']['balances']['search'], 10)
        self.assertTrue(all(row['grant']['payload']['payer'] == 'alice-org' for row in result['ledger']['operations']))
        self.assertEqual([len(t['blocks']) for t in result['tasks']], [2, 3, 2])

    def test_attacks_are_denied_without_search_charge(self):
        for scenario in ('payer_swap', 'forbidden', 'untrusted'):
            with self.subTest(scenario=scenario):
                result = Demo({'scenario': scenario}).run()
                self.assertEqual(result['ledger']['settled'], 30)
                self.assertEqual(result['ledger']['balances']['search'], 0)
                self.assertEqual(next(t for t in result['tasks'] if t['provider'] == 'search')['status'], 'denied')

    def test_explanation_uses_scoped_authorizer_facts(self):
        result = Demo({'scenario': 'payer_swap'}).run()
        search = next(task for task in result['tasks'] if task['provider'] == 'search')
        decision = search['decision']
        self.assertFalse(decision['permitted'])
        payer_row = next(row for row in decision['rows'] if row['logic'] == 'payer("mallory-org")')
        self.assertFalse(payer_row['present'])
        self.assertIn('payer("alice-org")', payer_row['available'])
        self.assertFalse(decision['token_checks'][0]['passed'])
        self.assertNotIn('billing', decision)

    def test_success_explains_local_trust_and_each_attenuation(self):
        result = Demo().run()
        search = next(task for task in result['tasks'] if task['provider'] == 'search')
        decision = search['decision']
        self.assertTrue(decision['permitted'])
        self.assertTrue(all(row['present'] for row in decision['rows']))
        self.assertIn('trusts_caller("research", "search")', [row['logic'] for row in decision['rows']])
        self.assertEqual([check['passed'] for check in decision['restrictions']], [True, True])
        self.assertEqual(decision['billing']['available_before'], 95)

    def test_budget_denial_keeps_authorization_distinct(self):
        result = Demo({'scenario': 'overspend'}).run()
        denied = next(task for task in result['tasks'] if task['status'] == 'denied')
        self.assertTrue(denied['decision']['permitted'])
        self.assertTrue(all(row['present'] for row in denied['decision']['rows']))
        self.assertEqual(denied['decision']['billing'], {'requested': 60, 'available_before': 35, 'passed': False, 'reason': '60 > 35 available credits'})

    def test_concurrent_reservations_do_not_overspend(self):
        result = Demo({'scenario': 'overspend'}).run()
        self.assertEqual(result['ledger']['settled'], 65)
        self.assertEqual(result['ledger']['available'], 35)
        self.assertEqual(sum(t['status'] == 'denied' for t in result['tasks']), 1)

    def test_race_with_sufficient_funds_allows_both(self):
        result = Demo({'scenario': 'overspend', 'budget': 125}).run()
        self.assertEqual(result['ledger']['settled'], 125)
        self.assertEqual(result['ledger']['available'], 0)

    def test_retry_is_only_charged_once(self):
        result = Demo({'scenario': 'retry'}).run()
        self.assertEqual(result['ledger']['settled'], 40)
        self.assertEqual(len(result['ledger']['operations']), 3)
        self.assertTrue(any(t['status'] == 'reused' for t in result['tasks']))

    def test_failure_releases_credit(self):
        result = Demo({'scenario': 'failure'}).run()
        self.assertEqual(result['ledger']['settled'], 30)
        self.assertEqual(result['ledger']['reserved'], 0)
        self.assertEqual(result['ledger']['available'], 70)
        self.assertEqual(result['ledger']['operations'][1]['status'], 'released')

    def test_local_trust_removal_denies_caller(self):
        result = Demo({'edges': [['planner', 'research'], ['planner', 'compute']]}).run()
        self.assertEqual(result['ledger']['balances']['search'], 0)
        self.assertEqual(result['ledger']['settled'], 30)
        search = next(task for task in result['tasks'] if task['provider'] == 'search')
        trust = next(row for row in search['decision']['rows'] if row['logic'] == 'trusts_caller("research", "search")')
        self.assertFalse(trust['present'])

    def test_forbidden_operation_shows_failed_attenuation(self):
        result = Demo({'scenario': 'forbidden'}).run()
        search = next(task for task in result['tasks'] if task['provider'] == 'search')
        self.assertFalse(search['decision']['permitted'])
        self.assertEqual([check['passed'] for check in search['decision']['restrictions']], [False, False])

    def test_untrusted_issuer_does_not_claim_a_datalog_result(self):
        result = Demo({'scenario': 'untrusted'}).run()
        search = next(task for task in result['tasks'] if task['provider'] == 'search')
        self.assertEqual(search['decision']['phase'], 'verification')
        self.assertEqual(search['decision']['rows'], [])

    def test_requester_rules_are_operator_specific(self):
        accepts = {op: ['alice'] for op in ('planner', 'research', 'search', 'compute')}
        accepts['search'] = ['bob']
        result = Demo({'accepts': accepts}).run()
        self.assertEqual(result['ledger']['settled'], 30)
        result = Demo({'requester': 'bob'}).run()
        self.assertEqual(result['payer'], 'bob-org')
        self.assertEqual(result['ledger']['settled'], 40)

    def test_failed_parent_prevents_child(self):
        result = Demo({'edges': [['research', 'search'], ['planner', 'compute']]}).run()
        self.assertEqual(result['ledger']['settled'], 25)
        self.assertFalse(any(t['provider'] == 'search' for t in result['tasks']))

    def test_planner_can_reject_original_requester(self):
        accepts = {op: ['alice', 'bob'] for op in ('planner', 'research', 'search', 'compute')}
        accepts['planner'] = ['bob']
        result = Demo({'accepts': accepts}).run()
        self.assertEqual(result['ledger']['settled'], 0)
        self.assertEqual(result['tasks'], [])
        self.assertFalse(result['root_decision']['rows'][1]['present'])

    def test_child_cannot_drop_parent_restrictions(self):
        demo = Demo()
        parent_token, parent_proof = demo.delegate(demo.root_token, 'planner', 'research', ['research'])
        # A holder tries to bind a root-derived token to a narrower parent task.
        token, proof = demo.delegate(demo.root_token, 'research', 'search', ['search'], parent_proof['payload']['task_id'], parent_proof)
        payload = {'caller': 'research', 'provider': 'search', 'action': 'search', 'amount': 10, 'payer': demo.payer, 'request_id': demo.request_id, 'task_id': proof['payload']['task_id'], 'operation_id': 'op-test', 'token_hash': digest(token.to_base64())}
        call = demo.identities['research'].sign(payload)
        with self.assertRaisesRegex(Rejected, 'extend the parent'):
            demo.authorize(token.to_base64(), call, [parent_proof, proof])
        demo.ledger.db.close()

    def make_call(self, demo, token=None):
        token, proof = demo.delegate(token or demo.root_token, 'planner', 'compute', ['compute'])
        payload = {'caller': 'planner', 'provider': 'compute', 'action': 'compute', 'amount': 25, 'payer': demo.payer, 'request_id': demo.request_id, 'task_id': proof['payload']['task_id'], 'operation_id': 'op-test', 'token_hash': digest(token.to_base64())}
        return token, [proof], payload, demo.identities['planner'].sign(payload)

    def test_tampering_with_signed_call_is_rejected(self):
        demo = Demo()
        token, chain, payload, call = self.make_call(demo)
        call['payload']['amount'] = 1
        with self.assertRaisesRegex(Rejected, 'signature'):
            demo.authorize(token.to_base64(), call, chain)
        demo.ledger.db.close()

    def test_tampering_with_delegation_is_rejected(self):
        demo = Demo()
        token, chain, payload, call = self.make_call(demo)
        chain[0]['payload']['parent_task'] = 'forged'
        with self.assertRaisesRegex(Rejected, 'signature'):
            demo.authorize(token.to_base64(), call, chain)
        demo.ledger.db.close()

    def test_appended_payer_fact_cannot_override_authority(self):
        demo = Demo()
        token = demo.root_token.append(BlockBuilder('payer("mallory-org");'))
        token, chain, payload, _ = self.make_call(demo, token)
        payload['payer'] = 'mallory-org'
        call = demo.identities['planner'].sign(payload)
        with self.assertRaisesRegex(Rejected, 'Datalog'):
            demo.authorize(token.to_base64(), call, chain)
        demo.ledger.db.close()

    def test_expired_token_is_rejected(self):
        demo = Demo()
        expired = BiscuitBuilder(AUTHORITY, {'requester': 'alice', 'payer': demo.payer, 'request_id': demo.request_id, 'expiry': datetime.now(timezone.utc) - timedelta(seconds=1)}).build(demo.root.private_key)
        demo.root_token = expired
        token, chain, payload, call = self.make_call(demo)
        with self.assertRaisesRegex(Rejected, 'Datalog'):
            demo.authorize(token.to_base64(), call, chain)
        demo.ledger.db.close()

    def test_idempotency_key_cannot_change_billing_details(self):
        demo = Demo()
        _, _, payload, _ = self.make_call(demo)
        demo.ledger.reserve(payload)
        payload['amount'] = 26
        with self.assertRaisesRegex(Rejected, 'Idempotency conflict'):
            demo.ledger.reserve(payload)
        self.assertEqual(demo.ledger.snapshot()['reserved'], 25)
        demo.ledger.db.close()

    def test_many_concurrent_reservations_are_atomic(self):
        demo = Demo({'budget': 100})
        _, _, payload, _ = self.make_call(demo)
        def reserve(i):
            try:
                demo.ledger.reserve({**payload, 'operation_id': f'op-{i}', 'amount': 10})
                return True
            except Rejected:
                return False
        with ThreadPoolExecutor(max_workers=16) as pool:
            results = list(pool.map(reserve, range(50)))
        self.assertEqual(sum(results), 10)
        self.assertEqual(demo.ledger.snapshot()['available'], 0)
        demo.ledger.db.close()

    def test_fake_or_wrong_provider_receipt_is_rejected(self):
        demo = Demo()
        _, _, payload, _ = self.make_call(demo)
        grant, _, _ = demo.ledger.reserve(payload)
        forged = demo.identities['search'].sign({'operation_id': payload['operation_id'], 'provider': 'compute', 'grant_hash': digest(grant), 'result': 'completed'})
        with self.assertRaisesRegex(Rejected, 'signature'):
            demo.ledger.settle(forged)
        wrong = demo.identities['search'].sign({'operation_id': payload['operation_id'], 'provider': 'search', 'grant_hash': digest(grant), 'result': 'completed'})
        with self.assertRaisesRegex(Rejected, 'bound'):
            demo.ledger.settle(wrong)
        self.assertEqual(demo.ledger.snapshot()['settled'], 0)
        demo.ledger.db.close()

    def test_input_validation(self):
        for config in ({'budget': -1}, {'budget': True}, {'budget': 1.5}, {'scenario': 'unknown'}, {'requester': 'eve'}, {'edges': [['planner', 'eve']]}):
            with self.subTest(config=config), self.assertRaises(ValueError):
                Demo(config)


if __name__ == '__main__':
    unittest.main()
