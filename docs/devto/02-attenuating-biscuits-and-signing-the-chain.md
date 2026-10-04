---
title: "Attenuating Biscuit tokens and signing the delegation chain"
published: false
devto: true
description: "Minting a Biscuit root grant in JavaScript, narrowing it at each hop, and adding signed delegation envelopes so receivers know who delegated what."
tags: security, authorization, javascript, webassembly
series: Biscuit Trust Lab
cover_image: https://raw.githubusercontent.com/darkedges/biscuit-trust-lab/main/docs/playground-screenshot.png
---

In part 1 I introduced the network: Alice's request flows through PlannerCo to ResearchCo, SearchCo and ComputeCo, and every billable call goes through a clearinghouse. This post covers the token side: how the root grant is minted, how each hop narrows it, and why Biscuit alone isn't enough to prove *who* delegated.

All code is from [`lib/relay.js`](https://github.com/darkedges/biscuit-trust-lab/blob/main/lib/relay.js).

{% embed https://github.com/darkedges/biscuit-trust-lab %}

## Minting the root grant

The clearinghouse issues one root Biscuit for each request. Its authority block holds facts about the request and checks that every later use must pass:

```js
mint(privateKey) {
  return biscuit`requester(${this.requester}); payer(${this.payer}); request_id(${this.requestId});
    right("research"); right("search"); right("compute");
    check if billing_payer($p), payer($p);
    check if current_request($r), request_id($r);
    check if action($a), right($a);
    check if time($t), $t < ${this.expiry};`.build(privateKey);
}
```

The **facts** describe the grant: Alice is the requester, alice-org pays, the request has an ID, and three rights are granted.

The **checks** tie those facts to each call. The receiver supplies `billing_payer`, `current_request`, `action` and `time` from the verified call it's handling. If the call claims a different payer, a different request, an action outside the granted rights, or arrives after expiry, a check fails and Biscuit denies the call. The receiver's own policy can't override that.

The tagged template (`` biscuit`...` ``) comes from the JavaScript Biscuit bindings. Interpolated values are passed as typed parameters, not pasted into the source, so a requester name can't inject Datalog.

The keys are real Ed25519 keys:

```js
const root = new KeyPair(SignatureAlgorithm.Ed25519);
demo.rootPrivate = root.getPrivateKey();
demo.rootPublic = root.getPublicKey();
demo.expiry = new Date(Date.now() + 15 * 60_000);
demo.rootToken = demo.mint(demo.rootPrivate);
```

Each operator gets the clearinghouse's **public** key and only accepts tokens whose signature chain leads back to it.

## Attenuating at each hop

When PlannerCo delegates research, it appends a block that limits which actions the token can still be used for:

```js
async delegate(parentToken, caller, provider, actions, parentTask = 'root', parentProof = null) {
  const check = `check if ${actions.map(action => ground('action', [action])).join(' or ')};`;
  const restriction = block``;
  restriction.addCode(check);
  const token = parentToken.appendBlock(restriction);
  // ... signed envelope, see below
}
```

The network makes three delegations:

| Hop | Appended block |
| --- | --- |
| PlannerCo → ResearchCo | `check if action("research") or action("search")` |
| ResearchCo → SearchCo | `check if action("search")` |
| PlannerCo → ComputeCo | `check if action("compute")` |

SearchCo's token therefore carries the authority block plus **two** restriction blocks. Every check in every block must pass. Even though the root grants `compute`, SearchCo can't use its token for compute, because ResearchCo's block forbids it.

Appending needs no private key and no call to the issuer. Each block is chained to the one before it with a fresh ephemeral key, so any block can be added but none can be removed. In part 1 I also showed that a `right("delete")` fact in an appended block is ignored by the authorizer. Blocks can narrow authority but can't widen it.

## The gap: who appended this block?

Here is the problem. A Biscuit tells SearchCo which restrictions apply. It doesn't tell SearchCo who added them. An attenuation block isn't signed by an identity that SearchCo knows.

That matters in a delegation network. SearchCo's policy says "I accept work from ResearchCo". To enforce that, SearchCo needs proof that:

1. ResearchCo is the one calling.
2. ResearchCo got this task from PlannerCo, which got it from the original request.
3. Each token in the chain extends the token before it, with nothing dropped.

So the lab adds a **delegation envelope** at each hop, signed with the delegator's own Ed25519 identity key (via WebCrypto):

```js
const proof = await this.identities[caller].sign({
  request_id: this.requestId,
  task_id: id('task'),
  parent_task: parentTask,
  caller, provider,
  allowed_actions: actions,
  token_hash: await digest(tokenText),
  token: tokenText,
  parent_proof_hash: parentProof ? await digest(parentProof) : null,
});
```

Each envelope names the delegator and the receiver, binds to the exact token by hash, and links to its parent envelope by hash. The envelopes form a hash chain alongside the token's block chain.

## The signed operation request

When ResearchCo finally calls SearchCo, it signs the call itself:

```js
const payload = { caller, provider, action, amount,
  payer: options.payer ?? this.payer, request_id: this.requestId,
  task_id: proof.task_id, operation_id: options.operationId ?? id('op'),
  token_hash: await digest(token.toBase64()) };
const call = await this.identities[caller].sign(payload);
```

The call states the action, the price, and the payer, and it binds to the token by hash.

## Verifying the chain

Before any Datalog runs, the receiver checks the evidence in `evaluateAuthorization`:

```js
const payload = await verify(this.identities[caller], signedCall);
if (payload.token_hash !== await digest(tokenText))
  throw new Rejected('Signed call does not match the presented Biscuit');

let previous = null;
let previousBlocks = this.rootToken.getRevocationIdentifiers();
for (const proof of proofChain) {
  const entry = proof.payload;
  await verify(this.identities[entry.caller], proof);              // envelope signature
  const hopToken = Biscuit.fromBase64(entry.token, this.rootPublic); // issuer signature
  const blocks = hopToken.getRevocationIdentifiers();
  if (blocks.length <= previousBlocks.length ||
      previousBlocks.some((value, index) => value !== blocks[index]))
    throw new Rejected('Child Biscuit must extend the parent token without dropping restrictions');
  // ... request binding, parent hash, caller == previous provider, chain starts at planner
  previous = proof;
}
```

Revocation identifiers make the "extends" check cheap. Each block has a unique identifier, so a child token extends its parent exactly when the parent's identifiers form a strict prefix of the child's.

The loop also checks that:

- every envelope belongs to this request;
- each envelope's `parent_proof_hash` matches the previous envelope;
- each hop's caller is the previous hop's provider, and its `parent_task` is the previous hop's `task_id`;
- the chain starts at PlannerCo, with parent `root`;
- the final envelope matches the signed call's caller, provider, task, request and token hash.

Only after all of that does `Biscuit.fromBase64(tokenText, this.rootPublic)` verify the presented token and hand it to the authorizer.

## The untrusted-issuer scenario

The **Untrusted issuer** scenario mints a lookalike token with a rogue key and delegates it to SearchCo with a correctly signed envelope:

```js
const rogue = new KeyPair(SignatureAlgorithm.Ed25519);
[searchToken, searchProof] = await this.delegate(this.mint(rogue.getPrivateKey()), 'research', 'search', ...);
```

The facts are identical. The envelope is validly signed by ResearchCo. But `Biscuit.fromBase64(entry.token, this.rootPublic)` fails, because the token's root signature doesn't come from the clearinghouse. The call is rejected in the **verification** phase. No Datalog runs, and no credits are reserved.

## A practical note: Biscuit WASM in Cloudflare Workers

The lab uses `@smithery/biscuit`, which wraps `@biscuit-auth/biscuit-wasm`. For Wrangler to bundle the `.wasm` file into a Pages Worker, the WASM package has to expose its module files in `exports`. The repo carries a small pnpm patch for this:

```diff
   "exports": {
-    "import": "./module/biscuit.js"
+    ".": { "import": "./module/biscuit.js" },
+    "./module/biscuit_bg.js": "./module/biscuit_bg.js",
+    "./module/biscuit_bg.wasm": "./module/biscuit_bg.wasm"
   },
```

It's registered under `patchedDependencies` in `pnpm-workspace.yaml`, so `pnpm install` applies it automatically.

## Next

The token and the chain prove **what was delegated, and by whom**. In part 3 we look at how each receiver decides whether to **accept** the call, using one Datalog policy that combines facts from the issuer, the call, and its own local trust settings.

Code: **[github.com/darkedges/biscuit-trust-lab](https://github.com/darkedges/biscuit-trust-lab)** · Demo: **[biscuits.demos.darkedges.com](https://biscuits.demos.darkedges.com/#biscuit)**
