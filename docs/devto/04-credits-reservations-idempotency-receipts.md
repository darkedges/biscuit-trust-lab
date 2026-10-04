---
title: 'Credits without a mutable token: reservations, idempotency and receipts'
published: false
description: >-
  Why a Biscuit can't carry a balance, and how a clearinghouse serializes
  reservations, deduplicates retries, releases failed work, and settles only
  against signed receipts.
tags: 'security, javascript, distributedsystems, cloudflare'
series: Biscuit Trust Lab
cover_image: >-
  https://raw.githubusercontent.com/darkedges/biscuit-trust-lab/main/docs/playground-screenshot.png
devto_id: 4794604
---

The first three parts of this series covered authority: who may do what, on whose behalf, and who decides. This last part covers money.

{% embed https://github.com/darkedges/biscuit-trust-lab %}

## Why the balance isn't in the token

It's tempting to put `budget(100)` in the Biscuit and have each hop append `spent(5)`. That doesn't work:

- **Tokens are immutable and copyable.** Two holders of the same token can each spend "the remaining 95". Nothing in the token stops concurrent use.
- **Appended blocks can't change facts.** A later block can't reduce an earlier balance. It can only add checks.
- **Spending is shared state.** Search and compute run in parallel under the same request, so the shared budget has to live in one place.

So the token carries **who pays and for which request** (`payer`, `request_id`). A **clearinghouse** holds the ledger for that request. Authorization is local, and accounting is coordinated. That's the line in the footer of the demo.

## Reserve → execute → settle (or release)

Each billable call goes through the same lifecycle:

1. The operator authorizes the call (part 3).
2. The clearinghouse authorizes it again, then **reserves** credits and returns a signed grant.
3. The operator does the work.
4. The operator signs a **completion receipt** bound to that grant, and the clearinghouse **settles**.
5. If the work fails, the clearinghouse **releases** the reservation instead.

Reserved and settled credits both count against the budget, so promised money can't be promised twice.

## Serializing reservations in single-threaded JavaScript

JavaScript is single-threaded, so it might seem that a race can't happen. But `reserveLocked` contains `await`s (SHA-256 fingerprinting and signing the grant) between reading the used total and recording the reservation. Two reservations can interleave at those points and both see the same available balance.

The lab chains reservations onto a promise queue:

```js
reserve(payload) {
  const pending = this.reservationQueue.then(() => this.reserveLocked(payload));
  this.reservationQueue = pending.catch(() => {});
  return pending;
}

async reserveLocked(payload) {
  // ... payer/request/amount validation, idempotency (below)
  const used = [...this.operations.values()]
    .filter(row => row.status !== 'released')
    .reduce((total, row) => total + row.amount, 0);
  if (used + payload.amount > this.budget) throw new InsufficientCredits(payload.amount, this.budget - used);
  const grant = await this.identity.sign({ operation_id: payload.operation_id, request_id: this.requestId,
    payer: this.payer, provider: payload.provider, amount: payload.amount, fingerprint,
    available_before: this.budget - used });
  this.operations.set(payload.operation_id, { /* ... */ status: 'reserved', grant });
  return { grant, duplicate: false, status: 'reserved' };
}
```

`.catch(() => {})` on the queue tail means one rejected reservation doesn't block the ones after it. The caller still receives the rejection through `pending`.

### The competing-reservations scenario

With a 100-credit budget, research settles 5. Search and compute then each ask for 60 **concurrently**:

```js
await Promise.all([
  this.execute(searchToken, [researchProof, searchProof], 'search', 60),
  this.execute(computeToken, [computeProof], 'compute', 60),
]);
```

Whichever reaches the queue first gets its 60. The other sees `Insufficient credits: 60 requested, 35 available` and is denied *after* passing Biscuit authorization. The decision view says so explicitly: "Biscuit allowed the call; the clearinghouse denied its credit reservation." Raise the budget to 125 and both succeed.

## Idempotency: retries don't double-charge

Networks retry. The clearinghouse keys reservations by `operation_id` and fingerprints the full signed payload:

```js
const fingerprint = await digest(payload);
const previous = this.operations.get(payload.operation_id);
if (previous) {
  if (previous.fingerprint !== fingerprint)
    throw new Rejected('Idempotency conflict: operation ID reused with different billing details');
  if (previous.status === 'released')
    throw new Rejected('This operation was released; create a new operation ID');
  return { grant: previous.grant, duplicate: true, status: previous.status };
}
```

There are three cases:

- **Same ID, same details.** Return the existing grant. If it's already settled, the operator returns the existing result, with no new work and no new charge.
- **Same ID, different details.** Conflict. Someone is trying to reuse an operation ID to change the amount, payer or action.
- **Same ID after release.** Refuse. A failed operation needs a fresh ID, so a stale retry can't revive it.

The **Retry** scenario sends the search call twice. The ledger shows 3 operations and 40 credits settled, not 50.

## Receipts: settle only what the provider claims it completed

Settlement needs evidence from the provider, bound to the specific reservation:

```js
const receipt = await this.identities[provider].sign({
  operation_id: payload.operation_id, provider,
  grant_hash: await digest(grant), result: 'completed' });
```

```js
async settle(receipt) {
  const provider = receipt.payload.provider;
  const proof = await verify(this.identities[provider], receipt);
  if (proof.result !== 'completed') throw new Rejected('Receipt does not prove completion');
  const row = this.operations.get(proof.operation_id);
  if (!row || row.provider !== provider || proof.grant_hash !== await digest(row.grant))
    throw new Rejected('Receipt is not bound to this provider and reservation');
  if (row.status === 'released') throw new Rejected('Cannot settle a released reservation');
  row.status = 'settled'; row.receipt = receipt;
}
```

A receipt from the wrong provider, for another reservation, or for a released reservation is rejected.

Be clear about what a receipt proves. It's the provider's **signed claim** that it completed the work. It doesn't prove the work was any good. That's a matter for disputes and reputation, not for cryptography.

### The operation-failure scenario

Search reserves 10 credits, and then its simulated execution fails. The clearinghouse releases the reservation. Settled is 30, available is 70, and replaying the timeline shows `reserved` rising to 10 and falling back to 0. A test checks that every replay snapshot balances:

```js
for (const event of run.events) {
  const ledger = event.snapshot.ledger;
  assert.equal(ledger.available + ledger.settled + ledger.reserved, ledger.budget);
}
```

## Running it on Cloudflare Pages

The lab deploys as a single Pages project. `web/_worker.js` (advanced mode) handles `/api/run` and `/api/health` and passes everything else to static assets:

```js
if (path === '/api/run' && request.method === 'POST') {
  const body = await request.text();
  if (body.length > 20_000) return Response.json({ error: 'Request is too large' }, { status: 413 });
  return Response.json(await runDemo(JSON.parse(body)));
}
```

Each request creates fresh keys, a new request ID and a request-local ledger. That keeps the demo stateless. It also means **nothing persists between requests or across Cloudflare locations**, which is fine for a lab and wrong for real money.

```sh
pnpm install
pnpm check          # node --test: real Biscuit decisions, concurrency, idempotency, release
pnpm run deploy     # wrangler pages deploy web
```

## What a production version would need

The lab deliberately stops short of being a payment system. To make it real you would need:

- **Durable, centralized accounting.** The serialized queue would become a transactional store, for example a Durable Object or a database row lock for each request.
- **Persistent issuer and operator keys,** with rotation and published key sets, instead of fresh keys on every run.
- **Authenticated transports** between operators, not in-process function calls.
- **Payer consent and quotes** before a reservation, not a fixed price list.
- **Revocation.** Biscuit revocation identifiers make this possible, but someone has to publish and check the list.
- **Reservation expiry,** so abandoned reservations free their credits.
- **Reconciliation and dispute handling,** because a receipt is a claim, not proof of quality.

## Wrapping up

Across the four parts, we covered:

1. A **Biscuit** root grant whose authority block binds requester, payer, request and rights, and whose checks every use must pass.
2. **Attenuation** at each hop, narrowing what downstream operators can do without contacting the issuer.
3. **Signed delegation envelopes** that fill in what Biscuit doesn't record: who delegated to whom.
4. A **local Datalog policy** at each receiver, combining issuer facts, verified call facts and its own trust settings.
5. A **clearinghouse** that keeps money out of the token, with serialized reservations, idempotent retries, releases and receipt-bound settlement.

Try to break it. Change the trust graph, swap payers, squeeze the budget, and watch the Debug tab. If you find a way to get SearchCo to do work it shouldn't, please open an issue.

Code: **[github.com/darkedges/biscuit-trust-lab](https://github.com/darkedges/biscuit-trust-lab)** · Demo: **[biscuits.demos.darkedges.com](https://biscuits.demos.darkedges.com/#biscuit)**
