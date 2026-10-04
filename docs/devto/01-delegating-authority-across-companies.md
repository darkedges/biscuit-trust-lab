---
title: "Delegating authority across companies with Biscuit tokens"
published: false
description: "A hands-on lab where independent operators accept delegated work, apply their own Datalog policies, and bill the original payer, using real Biscuit tokens and Ed25519 signatures."
tags: security, authorization, javascript, cloudflare
series: Biscuit Trust Lab
cover_image: https://raw.githubusercontent.com/darkedges/biscuit-trust-lab/main/docs/playground-screenshot.png
---

Alice wants a piece of work done. Her organization pays for it. She hands the job to a coordinator, and the coordinator splits it between other companies. Some of those companies pass part of the job on again.

Every company in that chain has to answer the same questions before doing any work:

- Who originally asked for this, and do I accept work for them?
- Who is calling me, and do I trust them to send me work?
- Who pays, and is that the payer who actually authorized it?
- Is this action within what was originally granted, and within what each step passed on?
- Is there still money left?

A plain bearer token or API key can't answer most of these. It can say "the holder may do X". It can't say "the holder may do X, on behalf of Alice, paid by alice-org, only as part of request 42, and only the search part of it". And once the token leaves your hands, you can't narrow it without going back to the issuer.

I built **[Biscuit Trust Lab](https://github.com/darkedges/biscuit-trust-lab)** to explore this problem with real cryptography and simulated companies. This series walks through how it works.

{% embed https://github.com/darkedges/biscuit-trust-lab %}

**Live demo:** [biscuits.demos.darkedges.com](https://biscuits.demos.darkedges.com/#biscuit)

## The network

```text
Alice (requester) / alice-org (payer)
  └─ PlannerCo (initial coordinator)
       ├─ ResearchCo [5 credits]
       │    └─ SearchCo [10 credits]
       └─ ComputeCo [25 credits]

All billable calls → shared clearinghouse
```

Four independent operators and a clearinghouse take part:

- The **clearinghouse** issues the original grant and keeps the request's credit ledger.
- **PlannerCo** accepts Alice's request and delegates research and compute.
- **ResearchCo** does research, then delegates search to **SearchCo**.
- **ComputeCo** does compute.

Each operator decides for itself whether to accept a call. No central service says yes or no to everyone. The clearinghouse only coordinates the money.

> **What's real and what's simulated.** The Biscuit tokens, Datalog authorization, and Ed25519 signatures are real. The operators, the work, and the credits are simulated, and everything runs inside a single request. This is a teaching lab, not a payment system.

## Why Biscuit?

[Biscuit](https://www.biscuitsec.org/) is a bearer token format with three properties that fit this problem.

**1. Offline attenuation.** Anyone holding a Biscuit can append a block that *restricts* it, without contacting the issuer. PlannerCo can take Alice's grant and pass ResearchCo a copy limited to research and search. ResearchCo can narrow it again to search only before passing it to SearchCo.

**2. Appended blocks can't widen authority.** A block can add checks that must pass. Facts it adds aren't trusted by the receiver's authorization policy. I tested this directly against the library used in the lab:

```js
const root = new KeyPair(SignatureAlgorithm.Ed25519);
const token = biscuit`right("search");`.build(root.getPrivateKey());

// Try to grant ourselves "delete" from an appended block
const sneaky = block``;
sneaky.addCode('right("delete");');
const widened = Biscuit.fromBase64(token.appendBlock(sneaky).toBase64(), root.getPublicKey());

const auth = new AuthorizerBuilder();
auth.addCode('action("delete"); allow if action($a), right($a);');
auth.buildAuthenticated(widened).authorize();
// throws: {"FailedLogic":{"NoMatchingPolicy":{"checks":[]}}}
```

The `right("delete")` fact from the appended block is ignored. Only facts from the authority block (signed by the issuer) and from the receiver's own authorizer count.

**3. Datalog policies.** Each receiver writes its policy as Datalog rules. It combines facts from the token, facts about the incoming call, and its own local facts (who it trusts, which requesters it accepts, what it offers). Part 3 of this series covers the policy in detail.

## What the lab adds on top of Biscuit

Biscuit handles "what is this token allowed to do?". A delegation network needs more than that:

- **Who appended this block?** A Biscuit attenuation block doesn't identify its author. The lab wraps each delegation in a separately signed **delegation envelope**, so a receiver can check the whole chain: PlannerCo → ResearchCo → SearchCo. (Part 2)
- **Who is calling right now?** The caller signs every operation request, and the receiver checks that signature against the presented token. (Part 2)
- **Is there money left?** Biscuits are immutable and don't store balances. A request-scoped clearinghouse reserves credits, prevents double spending, and settles only against a signed completion receipt. (Part 4)

## Try it

Open the [live demo](https://biscuits.demos.darkedges.com/#biscuit). It starts with an authorized run:

1. **Authorized delegation** settles 5 credits for research, 10 for search, and 25 for compute. alice-org pays 40 in total.
2. Open **Granted permissions** to see the root rights and each restriction that was appended. Click **SearchCo** to see the decision logic filled in with the real requester, payer, caller, action, and request values.
3. Remove the `ResearchCo → SearchCo` trust edge, or untick Alice for SearchCo, and run again. Search is denied. Compute still succeeds, because it never went through ResearchCo.
4. Try the other scenarios:

| Scenario | What happens | Credits settled |
| --- | --- | ---: |
| Authorized delegation | Three operations settle | 40 |
| Change payer | Search denied by a Biscuit check | 30 |
| Forbidden operation | Search attempts `delete` and is denied | 30 |
| Untrusted issuer | Search token's signature rejected | 30 |
| Competing reservations | One 60-credit child denied at budget 100 | 65 |
| Retry | Search's settlement is reused, not charged twice | 40 |
| Operation failure | Search's reservation is released | 30 |

The **Debug** tab (`/#debug`) records the browser's real `POST /api/run` call, plus every internal authorization and clearinghouse step. You can filter for denials and copy a cURL command to reproduce a run.

## Run it locally

You need Node.js 22+ and pnpm 11:

```sh
git clone https://github.com/darkedges/biscuit-trust-lab.git
cd biscuit-trust-lab
pnpm install
pnpm dev      # http://127.0.0.1:8795
pnpm check    # runs the test suite
```

The whole thing is a Cloudflare Pages project. `web/` holds the UI, `web/_worker.js` serves `/api/run`, and `lib/relay.js` holds all the token, policy, and ledger logic in under 400 lines. Biscuit runs as WebAssembly inside the Worker.

## Coming up in this series

1. **Delegating authority across companies with Biscuit tokens** (this post)
2. **Attenuating Biscuit tokens and signing the delegation chain**: minting the root grant, appending restrictions, and why each hop needs a signed envelope.
3. **Local policy, shared facts: the receiver's Datalog authorizer**: one policy, four sources of facts, and how each denial scenario fails.
4. **Credits without a mutable token: reservations, idempotency and receipts**: the clearinghouse, concurrent reservations, retries, and what a production system would still need.

The code is at **[github.com/darkedges/biscuit-trust-lab](https://github.com/darkedges/biscuit-trust-lab)**. Issues and PRs are welcome.
