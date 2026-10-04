---
title: 'Local policy, shared facts: the receiver''s Datalog authorizer'
published: false
<<<<<<< HEAD
devto: true
description: "How each independent operator combines issuer facts, verified call facts, and its own trust settings in one Biscuit Datalog policy, and how each denial scenario fails."
tags: security, authorization, datalog, javascript
=======
description: >-
  How each independent operator combines issuer facts, verified call facts, and
  its own trust settings in one Biscuit Datalog policy, and how each denial
  scenario fails.
tags: 'security, authorization, datalog, javascript'
>>>>>>> 209d4e722a199a900fb2f7e53b16ae376f2837d6
series: Biscuit Trust Lab
cover_image: >-
  https://raw.githubusercontent.com/darkedges/biscuit-trust-lab/main/docs/playground-screenshot.png
devto_id: 4794603
---

So far in this series we've minted a root grant, narrowed it at each hop, and wrapped every delegation in a signed envelope. All of that tells the receiver what was delegated and by whom. It doesn't decide whether the receiver should do the work. That decision belongs to the receiver alone.

In [Biscuit Trust Lab](https://github.com/darkedges/biscuit-trust-lab), each operator makes that decision with its own Biscuit authorizer.

{% embed https://github.com/darkedges/biscuit-trust-lab %}

## One policy, four sources of facts

Every operator runs the same policy:

```
allow if requester($r), accepts_requester($r),
    caller($c), service($s), trusts_caller($c, $s),
    payer($p), billing_payer($p),
    request_id($id), current_request($id),
    action($a), right($a), offers($a);
```

It's the same rule everywhere, but each operator evaluates it against different facts. Every predicate has a clear origin:

| Fact | Comes from | Meaning |
| --- | --- | --- |
| `requester`, `payer`, `request_id`, `right` | **Biscuit authority block** (signed by the clearinghouse) | What the original grant says |
| `caller`, `billing_payer`, `current_request`, `action` | **Verified call** (caller's Ed25519 signature checked) | What this call asks for |
| `service` | **Receiving operator** | Who I am |
| `accepts_requester`, `trusts_caller`, `offers` | **Receiver's local policy** | Whom I serve, whom I trust, what I do |

Restrictions appended during delegation don't add facts. They add `check if` rules that must also pass (see part 2).

The policy reads almost like English. Allow the call if the original requester is someone I accept, the caller is someone I trust to send me work, the payer on the call is the payer on the grant, the call belongs to the granted request, and the action was granted and is something I offer.

## Building the authorizer

Here's how the receiver assembles the authorizer in `lib/relay.js`:

```js
const builder = new AuthorizerBuilder();
builder.addCode(POLICY);
// The policy is fixed source code. All added values come from validated names or JSON-quoted strings.
builder.addCode(`caller(${JSON.stringify(caller)}); service(${JSON.stringify(provider)});
  billing_payer(${JSON.stringify(payload.payer)});
  current_request(${JSON.stringify(payload.request_id)}); action(${JSON.stringify(payload.action)});
  offers(${JSON.stringify(provider)});`);
builder.merge(authorizer`time(${new Date()});`);
for (const who of this.accepts[provider]) builder.addCode(`accepts_requester(${JSON.stringify(who)});`);
for (const [source, target] of this.edges)
  if (target === provider) builder.addCode(`trusts_caller(${JSON.stringify(source)}, ${JSON.stringify(target)});`);

const built = builder.buildAuthenticated(verified);
built.authorizeWithLimits({ max_facts: 1000, max_iterations: 100, max_time_micro: 250000 });
```

A few things to notice:

- **`buildAuthenticated(verified)`** only runs on a token that has already passed root-key verification and the chain checks from part 2.
- **`authorizeWithLimits`** caps facts, iterations and time. Every authorizer that evaluates input from outside should do this.
- **Trust is local data.** `trusts_caller` and `accepts_requester` come from each operator's own settings. In the UI you edit them in the trust graph and the requester checkboxes. The token never carries them.
- The lab keeps `offers` simple: each operator offers exactly one action with the same name as itself (`SearchCo` offers `search`). A real operator would list its catalogue.

## Reading the decision

`authorize()` returns allow or deny. For teaching, that isn't enough, so the lab asks Biscuit for the facts the authorizer can actually see, using a query rule for each predicate:

```js
const rule = Rule.fromString(`inspected(${vars}) <- ${name}(${vars})`);
built.queryWithLimits(rule, LIMITS).map(fact => fact.terms());
```

It then compares the facts the call needed with the facts that are present, and labels each with its origin. That table is what you see when you click an operator under **Granted permissions**. A missing fact shows in red.

One caveat: the table is an *explanation*. Biscuit's own `authorize()` result is the only thing that decides permit or deny. The table is rebuilt from queried facts so a human can see why.

## How each scenario fails

### Change payer

ResearchCo signs a search call that names `mallory-org` as the payer:

```
payer("alice-org")            // authority block
billing_payer("mallory-org")  // from the verified call
```

This fails twice. The policy needs `payer($p), billing_payer($p)` to unify, and they don't. The root token's own `check if billing_payer($p), payer($p)` fails too. Even an operator with a careless policy would be stopped by the issuer's check. Search is denied before billing, so the ledger settles 30 instead of 40.

### Forbidden operation

SearchCo receives `action("delete")`. The grant has no `right("delete")`, and SearchCo doesn't offer delete. ResearchCo's block `check if action("search")` also fails. Three independent reasons, one denial.

### Missing caller trust

Remove the `ResearchCo → SearchCo` edge in the trust graph and run again. SearchCo's authorizer no longer has `trusts_caller("research", "search")`, so no policy matches:

```
{"FailedLogic":{"NoMatchingPolicy":{...}}}
```

ComputeCo is unaffected, because it trusts PlannerCo, which delegated compute directly. Changing trust at one operator only changes that operator's decisions.

### Requester not accepted

Untick Alice for SearchCo, and `accepts_requester("alice")` disappears from SearchCo's authorizer. If PlannerCo stops accepting Alice, the run stops at ingress. PlannerCo runs a small authorizer of its own before delegating anything:

```js
const planner = authorizer`allow if requester($r), accepts_requester($r);`;
```

When that fails, no tasks are created at all.

### Untrusted issuer

As covered in part 2, a token minted with a different root key fails `Biscuit.fromBase64(token, rootPublic)` and never reaches Datalog. The decision view shows **phase: verification** rather than **phase: datalog**.

## Two authorization boundaries

Every billable call is authorized **twice**: once by the receiving operator, and again on behalf of the clearinghouse before it reserves credits. The **Debug** tab shows them as separate entries. In the lab, the clearinghouse re-runs the same verification and the receiver's policy. In a real deployment it would hold its own policy, for example "only reserve for providers registered for this payer".

The tests check that a denied call never reaches billing:

```js
const denied = await runDemo({ scenario: 'payer_swap' });
const search = denied.debug.filter(entry => entry.task_index === 1);
assert.equal(search.length, 1, 'Denied operator call must not reach billing');
assert.equal(search[0].outcome, 'denied');
```

## Next

Authorization says the call is allowed. It doesn't say the payer can afford it. In the final part we look at the clearinghouse: why the balance can't live in the token, how reservations stay safe under concurrency, how retries avoid double charging, and what a production version would need.

Code: **[github.com/darkedges/biscuit-trust-lab](https://github.com/darkedges/biscuit-trust-lab)** · Demo: **[biscuits.demos.darkedges.com](https://biscuits.demos.darkedges.com/#biscuit)**
