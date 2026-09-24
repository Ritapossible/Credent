# Credent

An on-chain reputation oracle for autonomous agents, built as a GenLayer
Intelligent Contract. Agents take on work under an explicit engagement, post
collateral priced from their own reputation, and are graded by an LLM inside
GenLayer's consensus. The grade moves a score, settles a bond and a collateral,
and credits an entitlement that the party owed can take out.

The problem it addresses: an agent's word about its own past work is worth
nothing, and a client's word about an agent is worth little more. Credent makes
both parties stake money on their claims, has validators agree on the grade
rather than on the prose, and prices the next job from what the record says.

---

## Contents

- [How it works](#how-it-works)
- [Deployments](#deployments)
- [Quick start](#quick-start)
- [Walkthrough](WALKTHROUGH.md)
- [Payouts](#payouts)
- [Binding an attestation to the work](#binding-an-attestation-to-the-work)
- [Verification](#verification)
- [Project layout](#project-layout)
- [Configuration](#configuration)
- [Limitations](#limitations)
- [Platform notes for GenLayer developers](#platform-notes-for-genlayer-developers)
- [Status](#status)
- [License](#license)

---

## How it works

### The engagement lifecycle

```text
open_engagement     a client proposes a scope, a provider and a stake  → proposed
accept_engagement   the named provider agrees, posting collateral      → open
close_engagement    either party marks the work finished               → closed
attest              a counterparty grades the other, posting a bond
reclaim_bond        the attester takes the bond back after the lock
release_collateral  the provider takes their collateral back
claim_collateral    the client takes it instead, if the work was forfeited
```

Acceptance is load-bearing twice. It is the **consent gate**: without it anyone
could name a victim as their provider, close the engagement alone, and have them
graded on work they never agreed to. Only the named provider can accept, and
they accept a scope whose digest is already committed.

It is also the only place reputation costs money. Collateral is priced from the
provider's score at the moment they accept and frozen into storage, so a later
review cannot retroactively change what an earlier job cost them.
`collateral_quote(provider, stake)` returns the score, the rate it buys and the
amount owed; `get_engagement` carries all three back afterwards, so the figure
can be re-derived rather than trusted.

### Grading

`attest` runs a non-deterministic block. The leader prompts an LLM for a
structured grade; every validator prompts independently and compares. The
comparison is not "does this read the same" — it is the engine's own
`grades_agree`, which allows a per-field numeric tolerance and, crucially,
**requires that both grades settle the bond and the collateral identically**.
Two grades that differ by a point but would slash one bond and release the other
do not agree. `errors_agree` does the same job for failures, so validators agree
about *failing* too.

`agreement_check(mine, theirs)` exposes that rule as a view, so the consensus
rule can be checked from outside the consensus round.

### Scoring

A score is a weighted aggregate of attestations about a subject, where weight
decays with age (`half_life_seconds`), is damped for a repeat attester
(`repeat_shift_cap`), and is zero below `min_substantiated` or `min_confidence`.
A neutral prior of `prior_weight` keeps a single attestation from moving a score
far. All of it is integer arithmetic in `reputation_core.py`, with 3,421 parity
vectors pinning the TypeScript port used by the site to the same answers.

---

## Deployments

| Network | Address | Artifact | Version |
|---|---|---|---|
| GenLayer Studio | [`0x772EbDBF33fBc2ac43ca0A586e7BAcB9e6c15901`](https://explorer-studio.genlayer.com/address/0x772EbDBF33fBc2ac43ca0A586e7BAcB9e6c15901) | `reputation_oracle.py` | current |
| Testnet Bradbury | [`0xaE321ADbd5d8769bFFd5d25d39251BB53E418524`](https://explorer-bradbury.genlayer.com/address/0xaE321ADbd5d8769bFFd5d25d39251BB53E418524) | `reputation_oracle.min.py` | **previous — see below** |

**Bradbury is one version behind, and not by choice.** It currently refuses to
finalize *any* contract deployment. That was measured rather than assumed: the
current artifact reverts, the previous 48,215-byte artifact that is already
running there reverts identically when redeployed today, and a 751-byte
two-method probe was accepted and then never finalized, timing out at status 5.
A per-transaction gas ceiling also moved — a deploy is refused as `gas limit
too high` at 20,000,000 and accepted at 15,000,000, where `scripts/gasProxy.ts`
had long used 30,000,000. So the Bradbury address above runs the contract as it
stood before the delivery binding, and `npm run verify-deployment` reports it
as `DIFFERS` on purpose rather than being quietly hidden. Studio carries the
current contract and every walkthrough in this README was run against it.

Both run the **production policy**, which is deliberately not the constructor's
defaults: the defaults leave `min_bond` at zero, which makes attestations free
to write and switches off the cost the anti-sybil argument rests on.

Bradbury carries the minified artifact because it refuses the full-size source
on transaction pubdata rather than on gas — a limit on the *bytes* a block will
take, which no amount of gas gets past. `minify_contract.py` removes prose and
whitespace and nothing else: comments and docstrings are cut, indentation is
rewritten as one space per level, and continuation lines inside brackets go
flush left. Every row covered by a multi-line string is preserved byte for byte,
because the grading prompts are triple-quoted and validators grade against them.
166,840 bytes become 56,003 and `ast.dump` on both files is compared before
either is written.

Verify any deployment before trusting it:

```bash
cd web
npm run verify-deployment     # deployed bytes are this repository's, hashed
npm run agreement             # the consensus rule, checked on-chain
npm run binding               # a false accusation, against a committed artifact
python ../tools/audit_review.py   # every review item, against the live bytes
```

---

## Quick start

```bash
git clone https://github.com/Ritapossible/credent
cd credent

python -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt
python -m pytest                  # 410 tests, no network

cd web
npm install
cp .env.example .env              # points at the studionet deployment
npm run dev                       # http://localhost:5173
```

Building the contract:

```bash
python build_contract.py          # reputation_core + prompts + shell → reputation_oracle.py
python minify_contract.py         # → reputation_oracle.min.py, for pubdata-limited networks
genvm-lint check reputation_oracle.py
```

`reputation_oracle.py` is generated. Editing it directly is a mistake — it is
overwritten, and the test suite fails when it drifts from its sources.

**To drive the whole lifecycle through the site**, see
[`WALKTHROUGH.md`](WALKTHROUGH.md): copy-paste scope, claim and evidence for one
full pass through `/attest`, and what each step should cost. It needs two funded
accounts, because only the named provider can accept an engagement and a client
cannot name themselves.

---

## Payouts

This is the part of the system a reviewer should read first, because it is the
part where money can be lost.

### Entitlements, not pushed transfers

`emit_transfer` credits a contract and does **not** credit an externally owned
account. Every ordinary party here — provider, client, attester — is a wallet,
so an earlier revision that pushed value at them at settlement paid nobody.

| Recipient | Credited | Sender debited |
|---|---|---|
| Any contract — `__receive__` working, raising, or absent | **yes** | yes |
| Externally owned account | **no** | studionet yes, bradbury no |

**Read that last row carefully: on studionet the value is destroyed.** The
sender is debited and the wallet is credited nothing, so the difference is not
refused, not refunded, and not held anywhere — it is gone. Measured with a
two-method probe at
[`0x5664DF1C`](https://explorer-studio.genlayer.com/address/0x5664DF1C350B062Df020230F1d7CB7976B653Da6),
funded with 0.1 GEN and asked to pay 0.05 GEN to the wallet that called it
([`0x19764795`](https://explorer-studio.genlayer.com/tx/0x19764795ced565f2e82f97b0035d88d106a39790ede9dc5b261e73c549f893b6)):

```text
before    contract 0.100000 GEN   wallet 44.977500 GEN
after     contract 0.050000 GEN   wallet 44.977500 GEN
contract debited  0.050000 GEN
wallet   credited  0.000000 GEN
```

Bradbury refuses the same transfer instead, so nothing is lost there. This is
a platform difference, not something a contract can catch — there is no failure
to handle, because from the contract's side the transfer succeeded.

It is also the reason the payout design is shaped the way it is, and worth
being blunt about why. `reclaim` decides whether a withdrawal was delivered by
comparing what this contract *holds* against what it has *committed*. A
destroyed transfer and a delivered one look identical to that test — `held`
drops either way — so the accounting would ratify the loss and close the claim
as paid. **No check placed after the fact can recover from this. Only never
emitting at a wallet can**, which is what the recipient guard is for, and why
it is an exact test rather than a heuristic.

Being a contract is the entire condition; nothing in the recipient's code can
defeat it. So settlement **credits an entitlement** rather than pushing value.
`owed_to(address)` reads it. Moving it out is a separate, later step.

### The payout surface

| Method | Moves value | Who uses it |
|---|---|---|
| `owed_to(address)` | — | anyone, a view |
| `in_flight_to(address)` | — | anyone, a view |
| `withdrawal_of(address)` | — | anyone, a view |
| `is_proven(address)` | — | anyone, a view |
| `liabilities()` | — | anyone, a view |
| `get_policy()` | — | anyone, a view |
| `assign_to(recipient)` | **no** | a wallet directing its own credit |
| `prove_recipient()` / `confirm_recipient()` | **no** | a recipient contract, once |
| `withdraw()` | **yes** | a proven recipient contract |
| `reclaim()` | sometimes | a recipient resolving its own withdrawal |

**`assign_to` carries no claim of any kind.** It debits `owed[caller]` and
credits `owed[recipient]` — both pure storage — and the contract's balance does
not change, so there is no transfer to fail. If the recipient turns out to be
unable to collect, the credit still sits under its address, readable and
assignable onward. The debited key is always `gl.message.sender_address`, so
naming a recipient decides *where* an entitlement goes and never *whose* it is.

**`withdraw` is the only method that emits value.** It is refused unless the
caller has been established as a recipient contract, and it parks the
entitlement rather than clearing it.

### Recipient verification

Two guards. The first is exact on both networks and decides the question; the
second is independent, free, and kept for that reason.

**1. The caller must answer `credent_recipient()`.** Before it will open the
handshake, close it, or pay, the contract makes a view call into the caller's
*own* address for that method and compares the string it returns. A wallet has
no code to answer with. A contract that is not a Credent recipient has no such
method to resolve. Either way the call does not return.

The failure is **not catchable**, and that is the mechanism rather than a
limitation. Measured on both networks with `try` / `except Exception` wrapped
around the call:

```text
                                    catchable form         strict form
studionet  a contract with it       SUCCESS, marker read   SUCCESS, marker read
           a contract without it    ERROR, state untouched ERROR, state untouched
           a wallet                 ERROR, state untouched ERROR, state untouched
bradbury   a contract with it       state moved            state moved
           a contract without it    refused, untouched     refused, untouched
           a wallet                 refused, untouched     refused, untouched
```

The `except` clause never runs. There is no branch for a caller to route around:
the transaction either reaches the next line with the caller established as a
Credent recipient, or it does not reach it at all.

The cost is that a push recipient must be a Credent recipient contract, not
merely any contract. `assign_to` is the route for everybody else.
`web/scripts/claimant.py` is the reference implementation; the marker method is
three lines of it — a decorator, a signature, and a returned string.

**2. The transaction's own entry point is refused.** Only an entry point can
have an externally owned account as `sender_address`; every deeper frame is one
contract calling another. So where `origin_address` carries the initiator,
`sender != origin` proves the caller is a contract. Measured with a reporter
contract called once directly and once through a relay:

```text
studionet  direct   sender 0xaA34…02Bd   origin 0xaA34…02Bd      equal
           relayed  sender <relay>       origin 0xaA34…02Bd      differ
bradbury   direct   sender 0xaA34…02Bd   origin 0x9F6aa736…      differ
           direct   sender 0xaA34…02Bd   origin 0x2d012a29…      differ
           direct   sender 0xaA34…02Bd   origin 0xB93a46B8…      differ
```

On studionet the equality holds for a wallet and the check is exact. On bradbury
every transaction reports a different unrelated origin, so it never fires. It is
written as a **refusal and never consulted as a proof** — inert is the right
failure mode for a refusal, and guard 1 is what covers bradbury.

The `prove_recipient` / `confirm_recipient` handshake is a two-transaction
opt-in on top of those guards. It moves no value. An earlier build had it emit a
token transfer debited from the caller's own entitlement so the confirmation
could watch a balance rise; that was removed because it cleared owed value and
then emitted a transfer with no way to recover it — the same shape as the defect
this design exists to remove — in order to re-confirm a platform property that
was already measured.

### Recovering an undelivered withdrawal

`withdraw` moves the entitlement out of `owed` so it cannot be spent twice, and
into `in_flight` rather than into nothing. `in_flight_to` and `withdrawal_of`
read it for as long as it is outstanding. `reclaim` decides what became of it.

The decision is `resolve_withdrawal` in `reputation_core.py` — pure arithmetic
over four numbers, and the reason it lives in the engine rather than in the
contract is that the engine's tests can *run* it:

```python
def resolve_withdrawal(*, elapsed_seconds, held, committed, settle_seconds) -> str
```

| Outcome | When | Effect |
|---|---|---|
| `unsettled` | `elapsed_seconds < settle_seconds` | refused, nothing changes, retry later |
| `restored` | `held >= committed` | the value never left; the entitlement goes back |
| `delivered` | `held < committed` | the value left; the claim is closed |

`committed` is every wei a restore must not reach — entitlements, other
withdrawals in flight, locked bonds, posted collateral, and bonds this contract
has slashed and kept — **including the claim being judged**. That is what makes
the test immune to unrelated payments: money arriving raises `held` and
`committed` together and changes no answer. `liabilities()` reports every part
separately, so what is free is visible rather than inferred.

**Slashed bonds are counted even though they are owed to nobody**, and that
distinction is the whole of it. A slashed bond stays with the contract by
design, so it looks like surplus — and treating it as surplus is what would
make this mechanism's one wrong answer worth attacking: a recipient whose
payout *had* arrived could reclaim the claim as well and take the accumulated
slashings with it. Counted, the only free money left is what somebody
deliberately sent the contract for no reason, and taking that back returns
exactly what it cost to put there.

Three properties worth stating plainly:

- **Nothing is judged too early.** A transfer that has not had time to land or
  fail is a question with no answer, and answering it is the one way a recovery
  path can pay twice: restore the claim, then have the transfer arrive as well.
  `withdrawal_settle_seconds` (900 on both deployments) is the window, and
  `withdrawal_of` says when a claim becomes resolvable.
- **A restore never spends money owed to anyone else**, and cannot reach the
  slashings either. It is allowed only when the balance covers everything the
  contract is committed to with the claim back on the books.
- **No claim can get stuck.** Every outcome resolves the withdrawal except
  "unsettled", which is retryable by construction.

Earlier designs read the *recipient's* balance to decide this. Three of them
were wrong, each differently: comparing the contract balance to entitlements
alone counts locked bonds and posted collateral as free money; a `total_in -
total_out` ledger breaks on a single untracked transfer; and the recipient's
balance reads any unrelated payment as delivery and any spending recipient as
failure. The contract's own obligations move with the money, which is why they
are what the decision is made from.

### What the site exposes

Every payout lands in `owed_to(you)`, so `/payouts` reads `owed_to`,
`is_proven`, `in_flight_to` and `liabilities` for the connected account and
offers both routes with the difference stated rather than implied: `assign_to`
as the default, `withdraw` marked recipient-contracts-only and disabled with a
reason whenever the connected address has not completed the handshake — which a
browser wallet never can, because it has no code to answer `credent_recipient()`
with.

---

## Binding an attestation to the work

An attestation is written by one counterparty about the other, and a bad enough
grade forfeits the provider's collateral to the client. So the question that
decides whether any of this is safe is: **what is the grade made against?**

It used to be prose. `attest` took a `claim` and an `evidence` string, both
written by the party who stands to gain, and the model graded those. Nothing
was fetched. `substantiated` measured how well-evidenced the *writing* looked,
which a fluent liar clears — so a detailed, confident, entirely false account
of non-delivery bought the whole collateral for the price of one bond.

Two things now stand in front of that, and they are the two the review named.

### The signed event

`submit_delivery(engagement_id, uri, digest)` is the provider's own
transaction. GenLayer recovered their key to put `gl.message.sender_address` in
front of that function, so the commitment is **signed by construction** — no
signature-verification code has to exist in this contract, because the chain
already did it. It records where the finished work is and what its bytes hash
to, only the provider may write it, and it freezes when the engagement closes,
so the artifact cannot be swapped once the work is in dispute.

### The validator-retrievable artifact

Inside `attest`'s consensus block, **each validator fetches the committed URI
itself**, hashes the body, and compares it to the digest the provider signed.
The fetch is written out in both the leader and the validator closure on
purpose: one side taking the other's word for what it retrieved is not
consensus. A body that does not hash to the commitment is discarded rather than
graded — otherwise the decision would belong to whoever can write to that host.

What the model is then shown is labelled by provenance rather than by name:

| Block | Written by | Trust |
|---|---|---|
| `COMMITTED SCOPE` | agreed by both, before the work | the standard |
| `CLAIM` | the attester | untrusted |
| `EVIDENCE` | the attester | untrusted |
| `DELIVERABLE` | **fetched by the graders**, from the address the *provider* committed | the work itself |

### What a forfeit may stand on

`collateral_settlement` in `reputation_core.py` — pure arithmetic, executed by
the engine tests:

| Delivery | Meaning | A forfeiting grade |
|---|---|---|
| `verified` | retrieved, and it hashes to the provider's commitment | forfeits — judged on the work |
| `absent` | no commitment, and the provider had time to make one | forfeits — on an on-chain fact, not a claim |
| `foreclosed` | no commitment, because the engagement closed too soon | **releases** — the absence is the accuser's doing |
| `unverified` | committed, but unretrievable or hash-mismatched | **releases** — nobody established anything |

### The absence has to be the provider's

Binding a forfeit to a missing deliverable creates a second way to attack the
same money, and the first version of this shipped with it open. Either party
may close an engagement, and closing freezes the commitment. So a client could
open, wait for the provider to lock up collateral accepting it, close in the
next transaction, and leave the provider unable to commit the one thing that
would defend them — then attest, forfeit, and claim.

That was not theoretical. Run against the deployed contract before the fix,
with the same false accusation used above, the client was credited the
provider's entire 0.875 GEN from a provider the contract itself had refused to
let deliver, answering `engagement_closed_delivery_is_frozen`. Making a forfeit
rest on an objective absence is right; letting the accuser manufacture the
absence is not.

`delivery_window_seconds` is the provider's fair chance, measured from
acceptance to close. Below it a missing commitment is `foreclosed` rather than
`absent` and cannot forfeit. It is a floor and not an estimate of how long work
takes: a client who waits it out can still close on an undelivered engagement,
which is exactly what they should be able to do. What they cannot do is deny
the opportunity and then bill for its absence.

`unverified` releasing is deliberate and it costs something: a provider who
commits a deliberately unreachable artifact makes their collateral
unforfeitable. What it does not buy them is a clean record — the grade still
lands, still carries weight, and still moves the score that prices their next
engagement. A contract cannot tell a dead host from a dishonest one, so the
economic loop absorbs what a gate could not.

### The same accusation, twice

`npm run binding` runs it on the deployed contract. Both engagements use the
same claim, the same evidence, the same scope and the same grader; the only
difference is whether the provider committed a delivery.

| | delivery | `fulfilled` | `substantiated` | collateral |
|---|---|---|---|---|
| provider committed the artifact | `verified` | 8500bp | 78 | **releasable** |
| provider committed nothing, and had the window | `absent` | 0bp | 100 | **forfeit** |
| client closed at once, denying the chance | `foreclosed` | 0bp | — | **releasable** |

The first two rows are the binding itself: the same accusation, and the model
rated the work at 8500bp in the row where it could read it. The third is the
guard around it — the accusation is identical again, and the only difference is
that the client closed the engagement before the provider could commit, so the
absence is the accuser's doing and cannot be billed to the provider.

| Step | Transaction |
|---|---|
| `open_engagement` | [`0xe128abf1`](https://explorer-studio.genlayer.com/tx/0xe128abf1129f8a0574f0a1c6f0692092ffc686c6c8f88a7a1a39cd7b8befc3ed) |
| `accept_engagement` — 0.875 GEN of collateral | [`0xeab3e176`](https://explorer-studio.genlayer.com/tx/0xeab3e1760e35237f565e1ae0d2d46582c2be7ae442a73fa07af1da9176dafdb8) |
| **`submit_delivery` — the provider's signed commitment** | [`0x3bfd45da`](https://explorer-studio.genlayer.com/tx/0x3bfd45dace10f970cb5f01afdf724d4658031dc287dc790e06f37191693ba7af) |
| `close_engagement` | [`0xdcf69ea7`](https://explorer-studio.genlayer.com/tx/0xdcf69ea72e2df3f56e0cd577d80f46d6c5b539b526edf924bde6bad1d1b3c682) |
| **`attest` — the false accusation, graded against the fetched artifact** | [`0x27f5f3cc`](https://explorer-studio.genlayer.com/tx/0x27f5f3cc5cf4ef75da9742a5e8330b9361b329523b55d35203ba33c7316fb9cd) |
| `claim_collateral` — refused, the accuser credited nothing | [`0x60e8ad54`](https://explorer-studio.genlayer.com/tx/0x60e8ad5429f5922096d6cef8ce96e555118d93e091a8a30cd0e4ff90511ec977) |
| `open_engagement` — the control, with no delivery | [`0xfd9cd240`](https://explorer-studio.genlayer.com/tx/0xfd9cd2408f887440b21987b663436240bf02c4e80d995954dbfd599b34137a09) |
| `accept_engagement` | [`0x9ed07c95`](https://explorer-studio.genlayer.com/tx/0x9ed07c95ffb89bc8b01286d41ea2db02b4bc4432c8509f5df03dbb06e0d81d3b) |
| `close_engagement` — after the full 900s delivery window | [`0x5ffe1536`](https://explorer-studio.genlayer.com/tx/0x5ffe1536d6fa343fdea2e6d807af671af112c646df6d923d391a8cbe6c642c27) |
| **`attest` — the same accusation forfeits, with nothing committed** | [`0x7e4a2c8a`](https://explorer-studio.genlayer.com/tx/0x7e4a2c8a522666eb8ee9cc96e481cccbc9c4b09d3c27ac230abd4ac7fd66f225) |
| `open_engagement` — the grief attempt | [`0xd12ef4d3`](https://explorer-studio.genlayer.com/tx/0xd12ef4d3c46399fc4f7958ba8b2c6da204539b47aca2af7fc79c7858405aa649) |
| `accept_engagement` | [`0xbefd2897`](https://explorer-studio.genlayer.com/tx/0xbefd289748ce1f0899dcb148f632e3320cce49e1ec8996b975393134fcf1e8c7) |
| **`close_engagement` — immediately, before any delivery** | [`0xc93cd465`](https://explorer-studio.genlayer.com/tx/0xc93cd465d0392801c30a749014f11d0bb0a23353a83924dd28a6b6146163a431) |
| **`attest` — the same accusation, and the collateral stays put** | [`0x39402319`](https://explorer-studio.genlayer.com/tx/0x394023194ca8bf99903f82007f7da54052aa61ab873514442dde537e5d354cd5) |
| `claim_collateral` — refused | [`0xbb8bf895`](https://explorer-studio.genlayer.com/tx/0xbb8bf89591a383b6be36ce11325c4c595150515a501143bd8cd564cf1c4946b3) |

The artifact these runs point at is
[`examples/orders_clean.py`](examples/orders_clean.py), served over HTTPS from
this repository so the validators fetch exactly the bytes whose digest the
provider committed.

### In the app

The lifecycle page carries the commitment as its own step, between accepting
the engagement and closing it, because a provider who never reaches it has no
defence later. **Fetch and hash it** reads the URL in the browser and fills the
digest in, which also tells the provider something more useful than the number:
a URL the browser cannot read is one the graders may not be able to read
either, and that lands the engagement in `unverified`, where the work cannot
speak for itself. A digest computed elsewhere can still be pasted, since a host
may refuse a cross-origin read and serve the validators perfectly well.

Every attestation then shows **what it was graded against** beside the grade
itself — the retrieved deliverable, no commitment, or a commitment that could
not be checked. That line is the one a reader needs most, because an
attestation is one counterparty's account of the other and the grade moves the
other side's money.

### A check that could not fail

Also worth recording. `owed_to`, `is_proven`, `in_flight_to` and
`withdrawal_of` were annotated `recipient: str` and opened with
`if not isinstance(recipient, str): return 0`. Every other address-taking view
on this contract takes an `Address`, which is what the SDK helpers produce, so
a caller doing the obvious thing got a silent zero rather than their balance.

That is how a false line got into this document. The binding walkthrough
asserted *"the accuser was credited nothing"* by reading `owed_to` with a
`CalldataAddress` and comparing it to zero — and it passed on a run where the
accuser **had** been credited 0.875 GEN, because the view answers zero to that
argument whatever the books say. Measured on the same contract, same account:

```text
owed_to(client) as a plain string    : 0.875000 GEN
owed_to(client) as CalldataAddress   : 0.000000 GEN
```

A check that cannot fail is worse than no check, and this one was cited as
evidence. All four views now take either form and refuse anything else out
loud, rather than guessing; the walkthrough reads them the way the ABI
declares; and a direct-mode test asserts the three spellings of one address
agree.

### A prompt that gave the wrong answer away

Worth recording, because it fired on the deployed contract and not in any test.
The first version of the deliverable instructions told the grader that when no
deliverable was retrieved it had no work in front of it and should "say so
through low `confidence`". That reads as careful and it was wrong: a provider
who commits nothing is not an *uncertain* case, it is a clear one, and the
model dutifully returned `confidence` 24. The contract's own
`min_confidence` gate then released collateral that should have been forfeited
— so a provider could have escaped simply by never committing a delivery,
which is the opposite of what the binding is for.

The fix was in the prompt rather than the gate. An absent commitment is now
presented as a fact about the record, and only a commitment that could not be
*checked* is described as uncertainty, which is what it is. On the next run the
same accusation came back at `confidence` 70 and the collateral forfeited. The
gate was right; it was being fed a bad reading.

**What this does not claim.** A verified artifact does not make a forfeit
impossible — with the work in hand the decision is still the model's, made on
the work. What the binding buys is that the model is looking at the deliverable
rather than at prose the accuser wrote about it, that only the provider can say
what the deliverable is, and that an artifact nobody could establish cannot
forfeit at all.

---

## Verification

### Offline — no network, runs in CI

```bash
python -m pytest                 # 410 tests: engine, prompts, contract, parity
cd web
npm run parity                   # 3,421 vectors: the TS port agrees with the engine
npm run units                    # formatting, error text, calldata encoding
npm run uicheck                  # the site and the contract speak the same names
npm run typecheck && npm run build
```

`uicheck` fails if `deployments.json`, this README and `.env.example` ever name
different addresses, and if any page file mentions a contract method that does
not exist. Both guards exist because both failures have happened here.

The recovery mechanism is covered three ways, deliberately, because no one of
them is sufficient:

1. **The arithmetic.** `TestResolveWithdrawal` in `test_reputation_core.py`
   executes `resolve_withdrawal` through every branch with real numbers.
2. **The wiring.** `test_a_failed_transfer_leaves_the_entitlement_recoverable`
   in `test_build_contract.py` checks the contract calls it and passes the
   deployed policy's settle window rather than the module constant.
3. **The behaviour.** `tests/direct/` runs the contract itself — see below.

A structural test cannot tell you the arithmetic is right, an arithmetic test
cannot tell you the contract calls it, and neither can tell you what the
contract actually does.

Every structural check reads code with docstrings stripped. That is not
fussiness: three guards in this repository once passed against a deliberately
broken contract because the term they searched for appeared in the prose
explaining the rule.

### Direct mode — the contract executed, no node and no keys

```bash
./run_direct_tests.sh          # twenty-one tests, well under a second
```

GenLayer's own `genlayer-test` harness runs `reputation_oracle.py` in memory.
This is where the review's sentence is executed rather than argued:

| Test | What it drives |
|---|---|
| a wallet cannot open the handshake | `prove_recipient` refused, `is_proven` still false |
| a wallet cannot close one it never opened | `confirm_recipient` refused |
| a wallet cannot withdraw | all three refused, entitlement untouched, nothing emitted |
| withdraw parks the entitlement | `owed` → 0, the same amount in `in_flight_to`, `withdrawal_of` reporting when it resolves |
| nothing is judged too early | `reclaim` refused before the settle window |
| **an undelivered transfer restores the entitlement** | the money is still in the contract, so `reclaim` gives the claim back |
| a restored entitlement can be withdrawn again | restored means usable, not just booked |
| a delivered transfer is closed, not paid twice | the money left, so nothing is credited back |
| reclaim cannot be replayed | the second call is refused |

The sixth row is the one that matters most, and the one a live network cannot
produce: every contract is credited by `emit_transfer`, so a transfer to a
verified recipient always arrives. In direct mode the test states what the
contract's balance is, which is exactly the input `reclaim` decides from.

Two things the harness leaves to the test, both documented in
`tests/direct/conftest.py`: cross-contract calls are answered by a hook, which
is what makes "a wallet" and "a recipient contract" different things here; and
`direct_vm.warp` does not refresh the field this contract reads consensus time
from, so the fixture sets both.

Needs Python 3.12+ and a cached GenVM release tarball. The default
`python -m pytest` skips the directory when the harness is not importable, so a
contributor without it still gets a green run.

### A settlement on the deployed contract

`npm run livedemo` settles a real engagement against whatever `deployments.json`
names, under the production policy — nothing is stubbed and no throwaway
instance is used.

The Bradbury table below was produced on that network's deployment, which is
the contract as it stood before the delivery binding — Bradbury will not accept
a new deployment at present, for the reasons under [Deployments](#deployments).
The studionet run beneath it is on the current contract. On Testnet Bradbury,
[`0xaE321ADb`](https://explorer-bradbury.genlayer.com/address/0xaE321ADbd5d8769bFFd5d25d39251BB53E418524),
paying a recipient contract at
[`0xaFC36cef`](https://explorer-bradbury.genlayer.com/address/0xaFC36cef31Bb99779928e28e0D0716842f71FA35):

| Step | Transaction |
|---|---|
| `open_engagement` | [`0x241d98f2`](https://explorer-bradbury.genlayer.com/tx/0x241d98f289dd457e8213c73cf12d31e6807a37e90d321b6850d70eecccf3c2bb) |
| `accept_engagement` — 0.875 GEN of collateral posted | [`0x93a889b9`](https://explorer-bradbury.genlayer.com/tx/0x93a889b98ed2592ca679bc878a9534779d7ad97baa0f423d94c48bd6c023c6bf) |
| `close_engagement` | [`0x485472dd`](https://explorer-bradbury.genlayer.com/tx/0x485472dd35262ea3888cb1563ff04abefcc682179c3989106b91614a714166dd) |
| `attest` — a 1 GEN bond, graded by an LLM in consensus | [`0xf5f06593`](https://explorer-bradbury.genlayer.com/tx/0xf5f06593fd0d3409829ab719c15c47f590c95beed93759dcc10f0a401d89fb05) |
| `release_collateral` — the entitlement rises, no value moves | [`0x8faf1306`](https://explorer-bradbury.genlayer.com/tx/0x8faf1306a85f154d6159b3fd46f43c55df3b1012bc0924ce4043b9e634e6b8fc) |
| `prove_recipient` — the handshake, moving no value | [`0xaa5f3621`](https://explorer-bradbury.genlayer.com/tx/0xaa5f362183b33c0741f4d83bad645aa01ee869161efdd7a801e34e6dafde3874) |
| `confirm_recipient` | [`0xd14e64a9`](https://explorer-bradbury.genlayer.com/tx/0xd14e64a9574a06ba5c6943cff243671fa921633dd52afebe2e1fb84686186ef6) |
| **`withdraw` — 0.875 GEN leaves the contract** | [`0x1782ccee`](https://explorer-bradbury.genlayer.com/tx/0x1782ccee2563d04c4b9704e690ad06ab82196804578cdaa25d729199ad7c5f35) |
| **`reclaim` — resolved after the 900s settle window** | [`0x7c4ea510`](https://explorer-bradbury.genlayer.com/tx/0x7c4ea51019a519077a80759dcd6bedddf31e1ca13624bf724110827d857fdc95) |
| `assign_to` — the wallet routes its own 0.05 GEN | [`0x7553e0ec`](https://explorer-bradbury.genlayer.com/tx/0x7553e0ec2c551006e0d7de6a423e32326776cb3e3a27e09d4a0d7971f6aa9b92) |
| `withdraw` — 0.05 GEN delivered | [`0x04704769`](https://explorer-bradbury.genlayer.com/tx/0x04704769f5e262dacd8d43c176e5fb7c7a6d1315ba14e49fd41c4ffc80df5e3d) |
| wallet `withdraw`, refused | [`0x1bf11177`](https://explorer-bradbury.genlayer.com/tx/0x1bf11177357f0a3495542155c79be971996c3318e9d041a566250d0133bc429d) |
| wallet `prove_recipient`, refused | [`0xad0e5bc2`](https://explorer-bradbury.genlayer.com/tx/0xad0e5bc29392b3d8b7d518f71ed63dff93b484e04c7bf54718c9e56a94afafc9) |
| `assign_to` the zero address, refused | [`0x64ea2430`](https://explorer-bradbury.genlayer.com/tx/0x64ea24307fa1c167e9a2a718168db809801703c5a9899f997b012b1d208b1430) |

The claimant's balance went `0 GEN -> 0.875 GEN` on that `withdraw`, and the
`reclaim` fourteen minutes later closed the claim without crediting anything
back. The run ends with the books balanced:

```text
owed 0  in_flight 0.05  bonds 1  collateral 0.875  slashed 0
obligations 1.925   committed 1.925   held 1.875
ok   the contract covers everything it has not sent
```

The same script, same result, on the current studionet deployment
[`0x772EbDBF`](https://explorer-studio.genlayer.com/address/0x772EbDBF33fBc2ac43ca0A586e7BAcB9e6c15901),
paying [`0xCB3Bf2eA`](https://explorer-studio.genlayer.com/address/0xCB3Bf2eA7f66994453f2c0f9f7f3804de770DF48):
[`attest`](https://explorer-studio.genlayer.com/tx/0x2f9e38c64105bae745efa58b3898828245c9221ea983257cc4e315518b2ef5cc),
[`withdraw`](https://explorer-studio.genlayer.com/tx/0xf2d84c47fc279dd037b89afbc56f353935c1246af5d58af981e88ef3ea40587c)
(`0 GEN -> 0.875 GEN`),
[`reclaim`](https://explorer-studio.genlayer.com/tx/0x9557687b7ffd1e5e475b1e6385e0ea564310d2d832c537fee7e68afd8537aa68)
after the settle window,
[`withdraw`](https://explorer-studio.genlayer.com/tx/0x4ae39f7928e5afd8a4d70d99fc5c7feabcdee35f3e89740966fc75fd9f800568)
of the wallet's assigned credit, and a wallet's
[`withdraw` refused](https://explorer-studio.genlayer.com/tx/0xdfdee27e09d45b24e184230203eafc982802238ebbab3128d32b0bf64e47a0df).

The claimant finished that run holding **0.925 GEN against an entitlement of
0.925** — paid once. On the deployment before the exactness fix the same run
left it holding 1.8 for the same work.

That run now commits a delivery before it closes the engagement, because
without one it is graded against an absent deliverable and the provider's
collateral is forfeitable — which is what the binding is for, and what the
settlement script was quietly demonstrating against itself until it was
updated.

Studionet reports the classified reason behind each refusal, so that last
transaction reads `recipient_has_not_proven_it_can_receive` in the explorer,
the wallet's `prove_recipient` reads `caller_is_the_transaction_origin`, and
`assign_to` the zero address reads `recipient_is_the_zero_address`. Bradbury
returns no reason string, which is why the Bradbury rows above are judged on
contract state instead.

### The review's scenario, on a deployed contract

`npm run recovery` drives the reported sentence clause by clause against the
Bradbury deployment, printing a transaction for every step. The run behind this
table is
[`0xaE321ADb`](https://explorer-bradbury.genlayer.com/address/0xaE321ADbd5d8769bFFd5d25d39251BB53E418524),
with an ordinary wallet at `0xF9dF362E` and a recipient contract at
[`0x849Ac071`](https://explorer-bradbury.genlayer.com/address/0x849Ac071B0960926C76524d9c256F1e672a973AC):

| Step | Transaction |
|---|---|
| `open_engagement` | [`0xd17a078d`](https://explorer-bradbury.genlayer.com/tx/0xd17a078d729348724ef2cbc36cb38f68293cc00ef911b3c976afff11859d69f2) |
| `accept_engagement` — the wallet's entitlement is created | [`0x17b9f85f`](https://explorer-bradbury.genlayer.com/tx/0x17b9f85f81ade2dc06ad7cdf63bdf7944219dd6079d51d298bff77d00956019d) |
| **`prove_recipient` from the wallet — refused** | [`0xcadda61b`](https://explorer-bradbury.genlayer.com/tx/0xcadda61b657ae2a487553b2940a13726ce0043fccd73b17d149ea8df6d258649) |
| **`confirm_recipient` from the wallet — refused** | [`0x8b2990f1`](https://explorer-bradbury.genlayer.com/tx/0x8b2990f17d8241b50893e0a882057de0f1b5d2bb51eaed3b885424977d9a1be2) |
| **`withdraw` from the wallet — refused, entitlement untouched** | [`0x44e5689e`](https://explorer-bradbury.genlayer.com/tx/0x44e5689ea803a070f80a93059c1223e0b74e758535ffad62e4a20544a19b8da9) |
| `assign_to` — the wallet routes it to a recipient contract | [`0x5462d14c`](https://explorer-bradbury.genlayer.com/tx/0x5462d14cc542097ad09f1cceac52fa596a2f4e35e93da28c81df62112922fab1) |
| `prove_recipient` — the handshake, moving no value | [`0x45ed2bbe`](https://explorer-bradbury.genlayer.com/tx/0x45ed2bbea3062f475ce4045ad30f1f8aa95625038c030cc25d3ce4b03e4c9818) |
| `confirm_recipient` | [`0x968cd33b`](https://explorer-bradbury.genlayer.com/tx/0x968cd33b14e69103bd4096692ce32e6a54943a4d6048a787453caa4558c123ef) |
| `withdraw` — parked in flight, not cleared | [`0x6cbe6b97`](https://explorer-bradbury.genlayer.com/tx/0x6cbe6b9757d76e5d7f3edc62d3e4e7d10162a1adddf9a2a759804b7c22f69995) |
| `reclaim` from an address with nothing in flight — refused | [`0x1731b0c9`](https://explorer-bradbury.genlayer.com/tx/0x1731b0c95846b9ffa837c0b4fea8703601c4169fb4acd8a308f36fd272c125d5) |
| `reclaim` — the withdrawal resolved after the settle window | [`0x7a188ff3`](https://explorer-bradbury.genlayer.com/tx/0x7a188ff3de24ae0b37a79e4baf6126374282db3bc4b5f7c45211773146fe93d7) |
| `reclaim` again — credited nothing | [`0x18ad3fe3`](https://explorer-bradbury.genlayer.com/tx/0x18ad3fe363e25fc9769e102a28aae321142f5afaadb89b5bdef0d8c4597be196) |

The three bold rows are the first clause of the review. Bradbury reports no
reason string for a transaction that does not complete, so each is judged on
what the contract state says afterwards: `is_proven` never turns true, and the
wallet's 0.02 GEN is still in `owed_to` when all three are done. The run closes
with the contract still covering everything it has not sent — 1.918750 GEN held
against 1.968750 GEN committed, of which 0.05 GEN is in flight.

What this run cannot show is a transfer failing, because none does — every
contract is credited. That branch is the sixth row of the direct-mode table
above.

### On-chain — network, but no key and no gas

```bash
npm run verify-deployment        # deployed bytes are this repository's, hashed
npm run agreement                # agreement preserves the bond and collateral outcomes
npm run checkreadme              # every transaction this README cites is real
python ../tools/audit_review.py  # every review item, against the live bytes
```

`audit_review` reads both *deployed* contracts over `gen_getContractCode`,
parses them, and checks each item against the bytes that are live rather than
the ones that are committed — the two have come apart in this project before.

`checkreadme` resolves every transaction hash in the tables below and asserts
it ran against an address this README links, on the network it claims. The
tables and `deployments.json` drifted apart once, after a redeploy updated the
addresses but not the hashes beneath them, and the stale rows read as evidence
that a fix had never been deployed. This is the check that catches that.

### End-to-end — needs keys and gas

```bash
export CREDENT_KEYDIR=/path/outside/the/repo     # client.key, provider.key
cd web
VITE_GENLAYER_NETWORK=studionet npm run settlement   # a throwaway oracle, every path
VITE_GENLAYER_NETWORK=studionet npm run livedemo     # the submitted deployment
VITE_GENLAYER_NETWORK=studionet npm run binding      # the attestation binding, both halves
npm run recovery                                     # bradbury: the payout guard, end to end
VITE_GENLAYER_NETWORK=studionet npm run deploy       # redeploy, and record where it went
```

`npm run settlement` deploys its own oracle with `bond_lock_seconds` and
`withdrawal_settle_seconds` at zero so a single pass can reach every path, then
runs release, claim, both refund paths and bond reclaim, asserting each
entitlement to the wei. Every payout is then resolved: it asserts the amount is
parked in `in_flight`, calls `reclaim`, and asserts the withdrawal closed
without crediting anything back.

Refusals are judged on contract state as well as on the error text, because they
have to be. Studionet reports the classified reason a refusal carries, but
Bradbury reports no reason string at all, and a node that stops answering while
a refused transaction settles produces a receipt timeout that reads exactly like
a real failure. So each refused call also names a figure it would have moved,
and an unchanged figure settles the question without the node having to come
back.

---

## Project layout

```text
reputation_core.py        the deterministic engine: scoring, bonds, collateral,
                          grade agreement, and resolve_withdrawal. No GenLayer
                          imports, so it runs — and is tested — without a runtime.
reputation_prompts.py     the grading prompt, built from a salted scope
contract_shell.py         everything that talks to the chain and nothing that
                          decides a number
build_contract.py         splices the three into reputation_oracle.py
minify_contract.py        → reputation_oracle.min.py for pubdata-limited networks
deployments.json          the deployed addresses, in one place
WALKTHROUGH.md            a hands-on pass through the lifecycle, with values
examples/orders_clean.py  the deliverable the binding walkthrough grades, served
                          over HTTPS so validators fetch the committed bytes
parity_vectors.json       the vectors the TypeScript port is checked against
tools/audit_review.py     checks the live bytes against every review item
web/                      the React site, the TypeScript port of the engine, and
                          the end-to-end scripts
web/scripts/claimant.py   the reference recipient contract
tests/direct/             the contract executed in memory, via genlayer-test
run_direct_tests.sh       runs those, naming an interpreter that can
```

**Why the engine is split out.** It is pure integer arithmetic, covered by its
own test module, which runs with no GenLayer runtime present at all — no
harness, no download, no Python version floor. The shell needs the GenVM,
because `from genlayer import *` only resolves inside it; `tests/direct/`
supplies one in memory, at the cost of a heavier dependency. Keeping the
arithmetic in the part that needs neither is what makes every decision in this
contract reachable by the cheapest test that can reach it — and it is why the
recovery decision was moved there.

---

## Configuration

The contract takes fifteen policy parameters, in constructor order:

| Parameter | Production | Meaning |
|---|---|---|
| `half_life_seconds` | 7776000 | age at which an attestation's weight halves |
| `prior_weight` | 30000 | strength of the neutral prior |
| `min_substantiated` | 25 | below this an attestation carries no weight |
| `min_confidence` | 50 | likewise |
| `confidence_tol` | 20 | allowed leader/validator spread per graded field |
| `repeat_shift_cap` | 8 | largest repeat-attester damping |
| `min_bond` | 1 GEN | bond for a first attestation |
| `slash_floor` | 20 | substantiated below this slashes the bond |
| `release_floor` | 50 | at or above this releases it in full |
| `bond_lock_seconds` | 1209600 | how long a releasable bond stays locked |
| `withdrawal_settle_seconds` | 900 | how long `reclaim` waits before judging |
| `collateral_ceiling_bp` | 15000 | collateral at score 0, in bp of stake |
| `collateral_floor_bp` | 2500 | collateral at score 10000 |
| `collateral_forfeit_bp` | 2500 | `fulfilled` below this forfeits |
| `delivery_window_seconds` | 900 | the provider's fair chance to commit a delivery |

Deploying without them takes the contract defaults, and the seventh of those is
`min_bond = 0`, which switches the bond off entirely.

Site configuration is `web/.env`:

```bash
VITE_CONTRACT_ADDRESS=0x772EbDBF33fBc2ac43ca0A586e7BAcB9e6c15901
VITE_GENLAYER_NETWORK=studionet
```

On Vercel, set `VITE_CONTRACT_ADDRESS` as a **Config** variable rather than a
Secret; a Secret is not exposed to the build and the site loads with no address.

---

## Limitations

**A recipient must be a Credent recipient contract.** `withdraw` will only pay
an address that answers `credent_recipient()` by view. An arbitrary contract
cannot be pushed value by this oracle, only one built to receive from it.
Everyone else uses `assign_to`, which moves the entitlement into a recipient
contract's name without moving value and without being able to fail.

This is a real restriction and it is listed here as one, but it is not a
concession made for convenience — it is the mitigation for the measured
studionet behaviour above, where a transfer to a wallet debits the sender and
credits nobody. Loosening it does not make the contract more permissive; it
makes it capable of destroying value that `reclaim` would then read as
delivered. `test_the_only_transfer_pays_a_verified_recipient` pins it across
the whole artifact: exactly one emission, at the caller, behind the guard.

**The restore branch is not reachable in normal operation.** Every contract is
credited by `emit_transfer` whatever its code does, and after the recipient
guard the only addresses `withdraw` emits at are contracts. The branch is kept
and tested because "cannot happen" is a claim about the platform rather than
about this contract: a network can route a transfer somewhere the contract
cannot foresee. It is exercised by `TestResolveWithdrawal` rather than on-chain,
and that is stated here rather than implied.

**A second withdrawal in flight can cost a failed one its restore.** `reclaim`
asks whether the contract still covers everything it is committed to, with the
claim being judged still counted. One withdrawal outstanding is decided exactly.
A second that has already landed but has not been reclaimed lowers the balance
while still being counted, so a genuinely failed transfer beside it reads as
delivered and is closed rather than restored.

That is a real loss and it is the direction the rule errs in deliberately. The
obvious repair — judging against what is committed *minus* the other
outstanding withdrawals — fixes this case and opens a worse one: it restores
claims whose value did leave, which is a drain rather than a loss. Measured
over the same grid of concurrent amounts, the repair produces 598 double-pay
cases and the rule as written produces none. Given a choice between failing to
return value and returning it twice, a contract holding other people's money
takes the first. Both properties are pinned:
`test_it_never_gives_back_value_that_really_left` and
`test_a_second_withdrawal_can_cost_the_first_its_restore`.

**A restore is allowed only when the balance is exactly the books.** `reclaim`
used to ask whether the contract still *covered* everything it owed, which
reads as "so nothing can have left". That inference holds only at equality.
Let the contract hold one wei more than it is committed to and a delivered
withdrawal still satisfies it, because the surplus absorbs the gap the payout
left behind.

That fired. On a deployed contract carrying 0.125 GEN of residue from
half-finished runs, a 0.875 GEN payout arrived, `reclaim` restored it anyway,
and the recipient withdrew again — ending with 1.8 GEN in hand against an
entitlement of 0.925. A contract cannot tell its own surplus from its own
float: value arrives through payable entry points that each account for what
they took, and residue from a crashed run looks identical to a healthy
balance. So the test stopped inferring. A restore now requires `held ==
committed`, the one state in which nothing can have left unaccounted for.

The cost is a restore missed whenever any surplus exists, which loses value
rather than duplicating it — the same direction every other judgement here
fails in, and the one a contract holding other people's money has to prefer.

**One coincidence remains.** If the surplus equals the payout to the wei, the
payout's own gap is filled exactly and the balance lands back on the committed
figure, so a delivered claim is restored. Closing that needs the contract to
know its surplus, and it cannot — residue from a crashed run is
indistinguishable from float. The exposure went from *every* surplus to one
exact coincidence; it is asserted by
`test_a_surplus_equal_to_the_payout_is_the_one_case_left` rather than left to
be discovered.

**A provider must keep the artifact retrievable until the engagement settles.**
The digest is frozen at close, so a host that is down during the attestation
reads as `unverified`. That releases the collateral rather than forfeiting it,
so an outage cannot cost a provider their money — but it does mean the
protection of being judged on the work is only available while the work can be
fetched.

**No mainnet.** The SDK ships localnet, studionet and two testnet entries;
`connect()` answers `mainnet is not available yet`. Nothing built here holds
real value, which is also why `min_bond` is one token rather than a figure with
teeth.

**Studio is a shared sandbox.** Its state can be reset and its public RPC allows
30 requests a minute; reads retry with backoff. It also returns 503 under load,
which is not a contract failure and should not be read as one.

---

## Platform notes for GenLayer developers

Things that cost time here and are not in the documentation.

**The runner directive must be alone in the leading comment block.** GenVM reads
the *contiguous* comment block at the top of the file as its configuration and
parses every line of it as JSON. Line 1 is `# { "Depends": ... }`; line 2 must
be blank. A comment on line 2 makes the block unparseable and the node rejects
the contract with `contract_error: invalid_contract`.

**Acceptance is not success.** A transaction that the contract *rejected* still
reaches `ACCEPTED` — consensus agreeing on a refusal is a success for the
network. Read `consensus_data.leader_receipt` to find out what actually
happened. A test harness that treats `ACCEPTED` as a pass will report a refused
withdrawal as a completed one.

**Refusal reasons are not portable.** Studio returns the contract's
`[EXPECTED] …` message; bradbury reports only
`txExecutionResultName: "FINISHED_WITH_ERROR"` and serves no reason string at
all. Assert on state where the reason is not available.

**`emit_transfer` rejects a zero value** — `raises ValueError: If value is
zero` — so a zero-value probe is not a thing that can be built.

**`on="accepted"` versus `on="finalized"`.** The SDK warns that value transfers
on `accepted` "may lead to undesired results" and recommends `finalized`. This
contract uses `accepted` anyway, for one measured reason: on bradbury a transfer
emitted `on="finalized"` was recorded on the transaction and never dispatched.
`withdraw` runs no non-deterministic block, so an appeal re-runs pure
computation and agrees.

**Integers are typed, and large ones arrive as strings.** `u256` and friends are
`typing.Annotated[int, ...]` on this runner, so they annotate and do not call —
write `self.total = 0`, never `self.total = u256(0)`. Off-chain, anything above
`Number.MAX_SAFE_INTEGER` comes back as a string.

**`genvm-lint` rejects `__receive__`.** E019 wants a `@gl.public.write`
decorator on it, and E106 then refuses any public name beginning with `__`. The
two rules cannot both be satisfied, so a recipient contract can be lint-clean or
receive value quietly, not both.

**A view call into an address with no code hangs studio's leader.** It does not
fail fast: the leader runs to its 600-second execution limit and the
transaction finalises as `Leader Timeout` with `Contract Error: timeout` and
`Leader execution exceeded 600.000s` on stderr. Bradbury refuses the identical
call in seven to fourteen seconds. The refusal is correct on both — nothing
moves — but on studio it costs ten minutes of leader time per attempt, which is
a cheap way to waste a validator's day.

This matters to any contract that uses a view call as a guard, which is what
`_require_recipient_contract` does here. The fix is ordering: run every cheap,
classified refusal first, so nothing reaches the view call that a storage read
would have turned away. Measured on the deployed contract before and after:

```text
                        before          after
withdraw (wallet)       600s timeout    7.0s  classified rejection
prove_recipient         600s timeout    8.9s  classified rejection
confirm_recipient       600s timeout    4.7s  classified rejection
```

Reordering weakens nothing, and that is what makes it available: `proven` is
only true for an address that already answered the marker at
`confirm_recipient`, and `probing` is only set by `prove_recipient`, which
requires it. Nothing reaches the view call that had not already been
established. A test pins the order, because it reads like style until it isn't.

**Nodes rate-limit and the client does not retry.** Bradbury answers `-32005`
with a `retryAfterMs`; honour it with backoff or a long run will die halfway.

---

## Status

Working and verified on studionet and testnet-bradbury. The consent gate refuses
an unaccepted engagement and an acceptance by anyone but the provider. The bond
gate refuses an underfunded attestation before the model is paid to read
anything. The collateral gate refused an acceptance one wei short of its quote;
a correctly funded one posted 8.75 GEN against a 10 GEN stake at 8750bp, the
grade moved the provider to 6154, and the same job then quoted 7.308 GEN — one
well-evidenced attestation freeing 1.44 GEN of working capital.

The payout leg works end to end, with balances checked on both sides of every
transfer, against both throwaway instances and the submitted deployments. A
wallet cannot reach any part of it — not `withdraw`, not `confirm_recipient`,
not `prove_recipient` — on either network.

Offline the project carries 410 tests and 3,421 parity vectors, plus twenty-one
direct-mode tests that execute the contract itself, and `genvm-lint` validates
the rebuilt schema at 31 methods and 15 constructor parameters.

The review's sentence — a wallet marking itself proven, `withdraw` clearing an
owed balance before an undeliverable transfer, no restoration path — is now
false in all three of its clauses, and each clause is checked in three places:
by a test that runs the contract, by a test that runs the arithmetic, and by a
transaction on a deployed contract you can open in an explorer.

An attestation can no longer redirect collateral on the strength of the
accuser's own account, and the accuser cannot manufacture the absence it would
rest on either. A provider commits the finished work with a signed
transaction of their own, the validators fetch it inside consensus and check it
against the digest that transaction carried, and the grade is made against
those bytes. Run against the deployed contract, the same false accusation left
a delivered provider's collateral alone, took it from one who had the full
delivery window and committed nothing, and left it alone again against a
provider the client had closed out before they could commit — three outcomes
from one accusation, separated only by what the record says about the
deliverable.

---

## License

[MIT](LICENSE).
