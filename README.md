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
- [Payouts](#payouts)
- [Verification](#verification)
- [Project layout](#project-layout)
- [Configuration](#configuration)
- [Limitations](#limitations)
- [Platform notes for GenLayer developers](#platform-notes-for-genlayer-developers)
- [Status](#status)

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

| Network | Address | Artifact |
|---|---|---|
| GenLayer Studio | [`0x0E78A40BEf6d0Fe85375648aFE0B3bF787A26238`](https://explorer-studio.genlayer.com/address/0x0E78A40BEf6d0Fe85375648aFE0B3bF787A26238) | `reputation_oracle.py` |
| Testnet Bradbury | [`0x2b11d8CbcFE853451e72abfC6cF24bb296915DD5`](https://explorer-bradbury.genlayer.com/address/0x2b11d8CbcFE853451e72abfC6cF24bb296915DD5) | `reputation_oracle.min.py` |

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
140,044 bytes become 48,180, and `ast.dump` on both files is compared before
either is written.

Verify any deployment before trusting it:

```bash
cd web
npm run verify-deployment     # deployed bytes are this repository's, hashed
npm run agreement             # the consensus rule, checked on-chain
python ../tools/audit_review.py   # every review item, against the live bytes
```

---

## Quick start

```bash
git clone https://github.com/Ritapossible/credent
cd credent

python -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt
python -m pytest                  # 364 tests, no network

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

---

## Payouts

This is the part of the system a reviewer should read first, because it is the
part where money can be lost.

### Entitlements, not pushed transfers

`emit_transfer` credits a contract and does **not** credit an externally owned
account. Every ordinary party here — provider, client, attester — is a wallet,
so an earlier revision that pushed value at them at settlement moved nothing at
all.

| Recipient | Credited | Sender debited |
|---|---|---|
| Any contract — `__receive__` working, raising, or absent | **yes** | yes |
| Externally owned account | **no** | studionet yes, bradbury no |

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
six lines of it.

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
def resolve_withdrawal(*, elapsed_seconds, held, obligations, settle_seconds) -> str
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

## Verification

### Offline — no network, runs in CI

```bash
python -m pytest                 # 364 tests: engine, prompts, contract, parity
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
./run_direct_tests.sh          # nine tests, well under a second
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

### The review's scenario, on a deployed contract

`npm run recovery` drives the reported sentence clause by clause against the
Bradbury deployment, printing a transaction for every step. The run behind this
table is
[`0xb08f12dA`](https://explorer-bradbury.genlayer.com/address/0x2b11d8CbcFE853451e72abfC6cF24bb296915DD5),
with an ordinary wallet at `0xF9dF362E` and a recipient contract at
[`0xf58470D8`](https://explorer-bradbury.genlayer.com/address/0xf58470D859D4C85c22aeBc978CBC50EC9c1AF965):

| Step | Transaction |
|---|---|
| `accept_engagement` — the wallet's entitlement is created | [`0xc067fa41`](https://explorer-bradbury.genlayer.com/tx/0xc067fa41e1ca1c542dd5eb19cd9264bbacbe253bb8b77e19b473870a02373bd9) |
| **`prove_recipient` from the wallet — refused** | [`0x021399ad`](https://explorer-bradbury.genlayer.com/tx/0x021399ad19e73ff1171044655b3d82e993210fffbc753370c9557e363c6091d5) |
| **`confirm_recipient` from the wallet — refused** | [`0x828f128b`](https://explorer-bradbury.genlayer.com/tx/0x828f128b854293ee4a0fc6dab4af4efca1d3c32d4b02a5601e8565d86b72f7a9) |
| **`withdraw` from the wallet — refused, entitlement untouched** | [`0xf46712b1`](https://explorer-bradbury.genlayer.com/tx/0xf46712b1c45cf6dd2de7cafc337c16209365d5c390372fc0159968cfe246881a) |
| `assign_to` — the wallet routes it to a recipient contract | [`0xf480cbb8`](https://explorer-bradbury.genlayer.com/tx/0xf480cbb8547a461e2ef72ea43666987b336fec8ae6c8aac05779073e382edf26) |
| `prove_recipient` — the handshake, moving no value | [`0xd4227699`](https://explorer-bradbury.genlayer.com/tx/0xd4227699f811ade63004218b40881680d7f691335ceac51dcb84854813bbdeec) |
| `confirm_recipient` | [`0xc4b22a45`](https://explorer-bradbury.genlayer.com/tx/0xc4b22a452272a1f11982c3313f6a013711e2db01b8f5dcb05bae06682b25a9c2) |
| `withdraw` — parked in flight, not cleared | [`0x5b222717`](https://explorer-bradbury.genlayer.com/tx/0x5b2227175f9a847fe368de1e484ac50cdddb0a42c98f2a617426c5d159811e17) |
| `reclaim` from an address with nothing in flight — refused | [`0x1c2b20c6`](https://explorer-bradbury.genlayer.com/tx/0x1c2b20c69c3e7bfa899751e90f58da5dbca9350c2511b66931c9f2d1d647d811) |
| `reclaim` — the withdrawal resolved after the settle window | [`0x2fe4eeb1`](https://explorer-bradbury.genlayer.com/tx/0x2fe4eeb1e7cb518d08de5624c9a46ef363892d47b482f0383280628a053f4730) |
| `reclaim` again — credited nothing | [`0x05fbe2bc`](https://explorer-bradbury.genlayer.com/tx/0x05fbe2bc2db81aedc16e7fba9611f0acbb9204e503a07e7c66dcafdf68b9dcd8) |

The three bold rows are the first clause of the review. Neither network reports
a reason string for a transaction that does not complete, so each is judged on
what the contract state says afterwards: `is_proven` never turns true, and the
wallet's 0.02 GEN is still in `owed_to` when all three are done.

What this run cannot show is a transfer failing, because none does — every
contract is credited. That branch is the sixth row of the direct-mode table
above.

### On-chain — network, but no key and no gas

```bash
npm run verify-deployment        # deployed bytes are this repository's, hashed
npm run agreement                # agreement preserves the bond and collateral outcomes
python ../tools/audit_review.py  # every review item, against the live bytes
```

`audit_review` reads both *deployed* contracts over `gen_getContractCode`,
parses them, and checks each item against the bytes that are live rather than
the ones that are committed — the two have come apart in this project before.

### End-to-end — needs keys and gas

```bash
export CREDENT_KEYDIR=/path/outside/the/repo     # client.key, provider.key
cd web
VITE_GENLAYER_NETWORK=studionet npm run settlement   # a throwaway oracle, every path
VITE_GENLAYER_NETWORK=studionet npm run livedemo     # the submitted deployment
npm run recovery                                     # bradbury: the payout guard, end to end
```

`npm run settlement` deploys its own oracle with `bond_lock_seconds` and
`withdrawal_settle_seconds` at zero so a single pass can reach every path, then
runs release, claim, both refund paths and bond reclaim, asserting each
entitlement to the wei. Every payout is then resolved: it asserts the amount is
parked in `in_flight`, calls `reclaim`, and asserts the withdrawal closed
without crediting anything back.

Refusals are judged on contract state as well as on the error text, because they
have to be. Neither network reports a reason string for a transaction that does
not complete, and a node that stops answering while a refused transaction
settles produces a receipt timeout that reads exactly like a real failure. Each
refused call names a figure it would have moved, and an unchanged figure settles
the question without the node having to come back.

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

The contract takes fourteen policy parameters, in constructor order:

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

Deploying without them takes the contract defaults, and the seventh of those is
`min_bond = 0`, which switches the bond off entirely.

Site configuration is `web/.env`:

```bash
VITE_CONTRACT_ADDRESS=0x0E78A40BEf6d0Fe85375648aFE0B3bF787A26238
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

**The restore branch is not reachable in normal operation.** Every contract is
credited by `emit_transfer` whatever its code does, and after the recipient
guard the only addresses `withdraw` emits at are contracts. The branch is kept
and tested because "cannot happen" is a claim about the platform rather than
about this contract: a network can route a transfer somewhere the contract
cannot foresee. It is exercised by `TestResolveWithdrawal` rather than on-chain,
and that is stated here rather than implied.

**A restore can, in one case, be paid out of money nobody is owed.** If the
contract holds more than everything it is committed to, plus the withdrawal, a
delivered claim can still satisfy the test and be paid a second time out of the
difference. Slashed bonds used to be that difference, which made it worth
attacking; they are now counted, so what remains is value somebody sent the
contract for no reason — and taking it back returns exactly what it cost to put
there, which is an expensive way to break even. It can never reach an
entitlement, a locked bond or a posted collateral.

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

Offline the project carries 364 tests and 3,421 parity vectors, plus nine
direct-mode tests that execute the contract itself, and `genvm-lint` validates
the rebuilt schema at 29 methods and 14 constructor parameters.

The review's sentence — a wallet marking itself proven, `withdraw` clearing an
owed balance before an undeliverable transfer, no restoration path — is now
false in all three of its clauses, and each clause is checked in three places:
by a test that runs the contract, by a test that runs the arithmetic, and by a
transaction on a deployed contract you can open in an explorer.
