# Credent

**Reputation as collateral for autonomous agents.**

An agent's counterparties write attestations about completed work. A GenLayer
intelligent contract grades each one with an LLM *in consensus* — several
validators run the same prompt and must agree on the outcome — and aggregates
the graded results into a score. That score sets how much collateral the agent
must post before taking on the next job. Nobody is asked to trust a self-report,
and nobody has to trust a single model call either.

That is a gate in the contract, not a description of one. A client opens an
engagement declaring the work's value; when the named provider accepts,
`accept_engagement` reads their `get_report().score_bp`, converts it through
`collateral_required` into a share of that stake, and **refuses the acceptance
unless the transaction carries it** — 150% of the stake for an agent with a poor
record, 87.5% for one with no history, 25% for a spotless one. A substantiated
attestation that the work went undelivered forfeits that collateral to the
client; anything else returns it.

---

## Contents

- [Deployments](#deployments)
- [Quick start](#quick-start)
- [Architecture](#architecture)
- [Protocol](#protocol)
- [Settlement and payouts](#settlement-and-payouts)
- [Verification](#verification)
- [Limitations](#limitations)
- [Platform notes for GenLayer developers](#platform-notes-for-genlayer-developers)
- [Deploying](#deploying)
- [Project status](#project-status)

---

## Deployments

| Network | Address | Artifact |
|---|---|---|
| GenLayer Studio | [`0xf08076B2bAd42AAF8b293c8ea6f4e18170dB57db`](https://explorer-studio.genlayer.com/address/0xf08076B2bAd42AAF8b293c8ea6f4e18170dB57db) | `reputation_oracle.py` |
| Testnet Bradbury | [`0x3a5DdDBae57372762E61cc812b64107E950a2E5f`](https://explorer-bradbury.genlayer.com/address/0x3a5DdDBae57372762E61cc812b64107E950a2E5f) | `reputation_oracle.min.py` |

Bradbury carries the minified artifact because it refuses the full-size source
on transaction pubdata rather than on gas — a limit on the *bytes* a block will
take, which no amount of gas gets past. `minify_contract.py` removes prose and
whitespace and nothing else: comments and docstrings are cut, indentation is
rewritten as one space per level, and continuation lines inside brackets go
flush left. Every row covered by a multi-line string is preserved byte for byte,
because the grading prompts are triple-quoted and validators grade against them.
135,156 bytes become 47,411. `ast.dump` on both files is compared before either
is written, so the runner cannot tell them apart.

Both run the **production policy**, which is deliberately not the constructor's
defaults. The defaults leave `min_bond` at zero, which makes attestations free
to write and switches off the cost the anti-sybil argument rests on. Verify any
deployment before trusting it:

```bash
npm run verify-deployment    # deployed bytes are this repository's, hashed
npm run agreement            # the agreement rule, checked on-chain
python tools/audit_review.py # every review item, against live bytes
```

Both deployments have been driven through a full settlement — not merely
deployed. See [Live settlement](#live-settlement-on-the-deployments) for the
transaction hashes.

---

## Quick start

```bash
pip install -r requirements-dev.txt
python -m pytest                 # 353 tests: engine, prompts, contract, parity vectors
python build_contract.py         # regenerate reputation_oracle.py after an engine change

cd web
npm ci
cp .env.example .env.local       # then set the contract address
npm run dev
```

### Configuration

| Variable | Meaning |
| --- | --- |
| `VITE_CONTRACT_ADDRESS` | The deployed `ReputationOracle`. Changes on every redeploy. |
| `VITE_GENLAYER_NETWORK` | `localnet`, `studionet`, `testnet-asimov`, or `testnet-bradbury`. |

Both are public by construction. Vite inlines every `VITE_`-prefixed variable
into the client bundle, so **nothing secret can go here** — and nothing needs
to. The site never holds a key: every view it reads is unsigned, and every write
is signed by the visitor's own wallet.

---

## Architecture

The scoring arithmetic decides money, so it is written once and pinned twice.

```
reputation_core.py      the deterministic engine — every number the protocol produces
reputation_prompts.py   the grading prompt, built byte-identically by every validator
contract_shell.py       the chain-facing contract: storage, access rules, consensus
build_contract.py       splices the three into one deployable file
reputation_oracle.py    ← generated. Do not edit.
minify_contract.py      produces reputation_oracle.min.py for pubdata-limited networks
web/                    the site: reads the chain, and writes to it with your wallet
tools/audit_review.py   checks the review's items against the deployed bytes
```

GenVM's runner takes a **single** Python file, so the engine must live inside
the contract rather than be imported by it. Concatenating by hand would mean two
copies of arithmetic that 353 tests are pinned to, and the copy that drifts is
always the one nobody runs. `build_contract.py` inlines the engine verbatim, and
`test_build_contract.py` fails the suite if the checked-in artifact is stale.

The site ports the same arithmetic to TypeScript, because it explains *how* each
weight was reached while the contract returns only the result. That port is
pinned to the engine by 3,421 generated parity vectors across 13 families; if
they disagree, `npm run parity` fails the build.

---

## Protocol

### The engagement lifecycle

```
open_engagement    client proposes a scope, a provider, and a stake → proposed
accept_engagement  the provider agrees, posting collateral          → open
close_engagement   either party marks the work finished             → closed
attest             a counterparty grades the other, posting a bond
reclaim_bond       the attester takes the bond back after the lock
release_collateral the provider takes their collateral back
claim_collateral   the client takes it instead, if the work was forfeited
```

The acceptance step is load-bearing twice over. It is the **consent gate**:
without it anyone could name a victim as their provider, close the engagement
alone, and have them graded on work they never agreed to. Only the named
provider can accept, and they accept a scope whose digest is already committed.

It is also the only place reputation costs money. Collateral is priced from the
provider's own score at the moment they accept and frozen into storage, so a
later review cannot retroactively change what an earlier job cost them.
`collateral_quote(provider, stake)` returns the score, the rate it buys and the
amount owed; `get_engagement` carries all three back afterwards so the figure
can be re-derived rather than trusted.

### Settlement timing

Settlement runs on explicit calls, never during grading. The attestation marks
the collateral `releasable` or `forfeit` — forfeiting only on a grade
substantiated and confident enough to carry weight in the score, so an
unevidenced accusation moves nothing — and the money follows in
`release_collateral` or `claim_collateral`.

A client who never attests cannot strand the provider's capital: once the
engagement has been closed for `bond_lock_seconds`, the provider releases it
ungraded. On the production policy that dispute window is fourteen days.

### Validator agreement

Grading runs inside `gl.vm.run_nondet`. The leader produces a grade; each
validator **independently re-runs the same prompt** and compares its own result
against the leader's, which is the comparative validation GenLayer's
`write-contract` guidance calls for — not a schema check on the leader's output.

Agreement is not decided on the numbers alone. `confidence_tol` is 20 on a 0–100
scale and `slash_floor` is also 20, so a leader reporting `substantiated` 10 and
a validator computing 30 are within tolerance while one confiscates the
attester's bond and the other returns it. `grades_agree` therefore compares the
derived **bond and collateral outcomes** as well:

```python
if bond_outcome(mine, policy) != bond_outcome(theirs, policy):
    return False
if collateral_outcome(mine, policy) != collateral_outcome(theirs, policy):
    return False
```

Two grades may differ freely as long as they land on the same side of every line
that moves money. A rule that rejected any difference at all would fail every
honest round.

That comparison is only reached when validators genuinely disagree, which a
caller cannot arrange — so `agreement_check` exposes the same rule as a view and
`npm run agreement` exercises it against every deployment:

```text
studionet  0xf08076B2bAd42AAF8b293c8ea6f4e18170dB57db
  substantiated 10 vs 30 (tolerance 20, slash_floor 20)
    bond: slashed vs releasable
  ok   the two grades settle the bond differently
  ok   so they do not count as agreement
  fulfilled 1500 vs 3500 (forfeit at 2500bp)
    collateral: forfeit vs releasable
  ok   the two grades settle the collateral differently
  ok   so they do not count as agreement
  substantiated 60 vs 70, fulfilled 5000 vs 5400 (same side of both lines)
  ok   both outcomes match
  ok   so they do count as agreement
  ok   a differing verdict is not agreement, whatever the numbers
```

A structural test holds the view to delegating to the same `grades_agree` the
consensus path uses. A view that reimplemented the rule would agree with the
tests, disagree with the contract, and read as proof either way.

---

## Settlement and payouts

### Why entitlements rather than direct transfers

`emit_transfer` credits a contract and does **not** credit an externally owned
account. Every ordinary party in this protocol — provider, client, attester — is
a wallet, so an earlier revision that pushed value at them at the moment of
settlement moved nothing at all.

The behaviour is exact, and measured rather than assumed:

| Recipient | Credited | Sender debited |
|---|---|---|
| Any contract — `__receive__` working, raising, or absent | **yes** | yes |
| Externally owned account | **no** | studionet yes, bradbury no |

Being a contract is the entire condition; nothing in the recipient's code can
defeat it. See [Appendix: measurements](#appendix-measurements) for the runs.

So settlement **credits an entitlement** rather than pushing value.
`_credit(recipient, amount)` is pure storage: it cannot fail, cannot be dropped
by a consensus round, and is readable through `owed_to`. Value moves in a
separate call the recipient makes when it can receive it, so the part that must
not fail no longer depends on the part that can.

### The payout surface

| Method | Moves value | Can fail | Who uses it |
|---|---|---|---|
| `owed_to(address)` | — | — | anyone, a view |
| `is_proven(address)` | — | — | anyone, a view |
| `liabilities()` | — | — | anyone, a view |
| `in_flight_to(address)` | — | — | anyone, a view |
| `agreement_check(mine, theirs)` | — | — | anyone, a view |
| `assign_to(recipient)` | **no** | no | a wallet directing its own credit |
| `prove_recipient()` / `confirm_recipient()` | yes, a token amount | yes | a Credent recipient contract, once |
| `withdraw()` | **yes** | yes | a proven Credent recipient contract |
| `reclaim()` | sometimes | yes | a recipient resolving its own withdrawal |

**`assign_to` is the path that carries no claim of any kind.** It debits
`owed[caller]` and credits `owed[recipient]` — both pure storage — and the
contract's balance does not change; there is no transfer to fail. If the
recipient turns out to be unable to collect, the credit still sits under its
address, readable and assignable onward. Authorisation is preserved by
construction: the debited key is always `gl.message.sender_address`, so naming a
recipient decides *where* an entitlement goes and never *whose* it is.

This replaced a worse answer. The first fix was `withdraw_to(recipient)`, which
pushed value at an address the caller named — replacing a stranded entitlement
with a destroyed one, since an undeliverable transfer is not refunded. It is
gone.

**`withdraw()` establishes the recipient before it emits, and parks the
entitlement rather than dropping it.** The guard is described in the next
section; the important property is that it runs *before* any value moves. The
entitlement then leaves `owed` — so it cannot be withdrawn twice while the
transfer is outstanding — and lands in `in_flight`, where `in_flight_to` can
read it and `reclaim` can resolve it.

**`reclaim()` is what makes a failed transfer survivable.** It settles the
caller's own outstanding withdrawal against the recipient's balance: closed if
the value arrived, credited back to the same key if it did not. The restore is
refused unless the contract still covers *every* obligation — entitlements,
other withdrawals in flight, locked bonds and posted collateral alike — which is
what stops a recipient that was paid and then emptied itself from being paid a
second time out of other people's money.

### Recipient verification

Three guards. The first is exact on both networks and is the one that decides
the question; the other two are independent, cheap, and kept because neither
costs anything to check twice.

**1. The caller must answer `credent_recipient()`.** Before it will probe,
confirm or pay, the contract makes a view call into the caller's *own* address
for that method and compares the string it returns. A wallet has no code to
answer with. A contract that is not a Credent recipient has no such method to
resolve. Either way the call does not return.

**The failure is not catchable, and that is the mechanism rather than a
limitation.** Measured on both networks with `try` / `except Exception` wrapped
around the call:

```text
studionet  a contract implementing it   returned the marker, execution SUCCESS
           a contract without it        execution ERROR, calling state untouched
           a wallet                     execution ERROR, calling state untouched
bradbury   a contract implementing it   returned the marker, calling state moved
           a contract without it        refused, calling state untouched
           a wallet                     refused, calling state untouched
```

The `except` never runs. There is no branch for a caller to route around: the
transaction either reaches the next line with the caller established as a
Credent recipient, or it does not reach it at all.

An earlier build did not use this. It was looked at as a way to *detect* a
contract, found to be uncatchable, and set aside — the README even said so. Read
as a refusal instead of as a predicate, uncatchable is the stronger property,
and missing that is what left the second review with something to find.

The cost is that a push recipient must be a Credent recipient contract, not
merely any contract. `assign_to` is the route for everybody else, moves no
value, and cannot fail. `web/scripts/claimant.py` is the reference
implementation — sixteen lines of it are the marker method.

**2. The transaction's own entry point is refused.** Only an entry point can
have an externally owned account as `sender_address`; every deeper frame is one
contract calling another. So where `origin_address` carries the initiator,
`sender != origin` *proves* the caller is a contract. Measured with a reporter
contract called once directly and once through a relay:

```text
studionet  direct   sender 0xaA34…02Bd   origin 0xaA34…02Bd      equal
           relayed  sender <relay>       origin 0xaA34…02Bd      differ
bradbury   direct   sender 0xaA34…02Bd   origin 0x9F6aa736…      differ
           direct   sender 0xaA34…02Bd   origin 0x2d012a29…      differ
           direct   sender 0xaA34…02Bd   origin 0xB93a46B8…      differ
```

On studionet the equality holds for a wallet and the check is exact. On bradbury
every transaction reports a different unrelated origin, so the equality never
holds and the check cannot fire. It is therefore written as a **refusal and
never consulted as a proof** — inert is the right failure mode, because it can
never admit a caller that would otherwise be rejected. Guard 1 is what covers
bradbury, and it is not weaker there.

**3. The probe must actually be paid.** `prove_recipient()` emits a real
transfer of `PROBE_WEI` (0.000001 GEN) and records what the recipient held at
that moment; `confirm_recipient()` refuses unless that balance has risen by the
same amount. `emit_transfer` credits a contract and never credits an externally
owned account — measured against a working `__receive__`, one that raises, one
absent, and a fresh wallet — so this tests the exact mechanism the payout will
use rather than a proxy for it. The probe is consumed either way, so a
confirmation can neither arrive unrequested nor be replayed.

**The probe comes out of the caller's own entitlement**, not out of the
contract's balance. It is debited from `owed[caller]` before it is sent, so it
can never touch anybody else's money, it needs no surplus to exist, and nothing
is lost: what the probe pays is the first slice of the same entitlement, sent
early, to the same address, by the same mechanism. An address with nothing owed
has nothing to prove and is refused.

Taken alone this guard would be satisfiable by a wallet funding itself the probe
amount from a second address between the two calls. Taken alone guard 2 cannot
fire on bradbury. Guard 1 is not satisfiable by a wallet under any funding,
which is why the three are stated in this order.

### What the site exposes

Every payout lands in `owed_to(you)`, so `/payouts` reads `owed_to`,
`is_proven` and `liabilities` for the connected account and offers both routes
with the difference stated rather than implied: `assign_to` as the default,
`withdraw` marked recipient-contracts-only and disabled with a reason whenever
the connected address has not proven it can receive — which a browser wallet
never can, because it has no code to answer `credent_recipient()` with. The page
also shows what the contract is holding for everyone, not only what it owes in
entitlements, so the two are never read as the same number.

---

## Verification

### Offline — no network, runs in CI

```bash
python -m pytest                 # 353 tests
cd web
npm run parity                   # 3,421 vectors: the TS port agrees with the engine
npm run units                    # formatting, error text, calldata encoding
npm run uicheck                  # the site and the contract speak the same names
npm run typecheck && npm run build
```

`uicheck` also fails if `deployments.json`, this README and `.env.example` ever
name different addresses, and if any page file mentions a contract method that
does not exist. Both guards exist because both failures have happened here.

### On-chain — network, but no key and no gas

```bash
npm run verify-deployment        # deployed bytes are this repository's, hashed
npm run agreement                # agreement preserves the bond and collateral outcomes
python tools/audit_review.py     # every review item, against the live bytes
```

`audit_review` reads both *deployed* contracts over `gen_getContractCode`,
parses them, and checks each item against the bytes that are live rather than
the ones that are committed — the two have come apart in this project before. It
also verifies the site carries the payout flow and that this README names no
contract method that does not exist.

Every check is structural and judged on code with docstrings stripped. That is
not fussiness: three guards in this repository once passed against a
deliberately broken contract because the term they searched for appeared in the
prose explaining the rule.

### End-to-end suite

`npm run settlement` deploys a throwaway oracle with the bond lock at zero so a
single pass can reach every path, then runs release, claim, both refund paths
and bond reclaim, asserting each entitlement to the wei, and withdraws twice:
once as a contract collecting its own credit, and once as a wallet moving its
credit to a contract it names.

```text
settlement ok - 41 checks, every payout reached its recipient   (studionet)
settlement ok - 38 checks, every payout reached its recipient   (bradbury)
```

The counts differ by the two checks in one engagement's bond reclaim, which the
suite excludes when the attestation does not record inside `ATTEST_TIMEOUT_MS`.
It says so in the run rather than folding a timeout into a payout assertion, and
the bond payout is still covered in both runs through the client's reclaim.

### Live settlement on the deployments

`npm run settlement` isolates runs by deploying its own oracle, which left the
submitted addresses carrying nothing but view reads. `npm run livedemo` settles
a real engagement against whatever is in `deployments.json`, under the
production policy:

```text
=== livedemo — a settlement on the deployed contract ===
    open_engagement — the client commits scope and stake
    quoted 0.875 GEN collateral at 8750bp for an agent with no record
    accept — the provider posts collateral through its contract
    ok   the contract took exactly 0.875 GEN of collateral
    close_engagement — the client marks the work delivered
  the attestation — an LLM grades the work, in consensus
    attest — the client posts a 1 GEN bond and 0.05 GEN over
    ok   the client wallet was credited the 0.05 GEN it overpaid
    collateral_state = releasable
  the payout
    release_collateral — the grade cleared, so the provider reclaims it
    ok   the entitlement rose by 0.875 GEN
    ok   and the contract holds exactly what it held before — crediting moves no value
    prove_recipient — the oracle probes the recipient, which answers
    ok   the claimant is a proven recipient
    withdraw — the only method that moves value
    ok   the claimant received the whole entitlement (0.875 GEN)
    ok   the entitlement was zeroed
  the client wallet's own credit — 0.05 GEN
    assign_to — moves the entitlement, not the money
    ok   the wallet entitlement is spent, not duplicated
    withdraw — the contract collects what the wallet assigned it
    ok   the claimant received the wallet's 0.05 GEN
  the payout guard, on the deployed contract
      refused: caller_is_the_transaction_origin
    ok   withdraw from an unproven wallet is refused, not attempted
      refused: recipient_is_the_zero_address
    ok   assigning to the zero address is refused

livedemo ok — a settlement completed on the submitted deployment
```

| | Studionet | Testnet Bradbury |
|---|---|---|
| claimant | [`0xBc03cF3c`](https://explorer-studio.genlayer.com/address/0xBc03cF3c752739dD1b5C82c1e164E9Fa2500AD3A) | [`0x44eFd1CF`](https://explorer-bradbury.genlayer.com/address/0x44eFd1CF21b146Bb8676A3Cde89caEC6Fbd75490) |
| `attest`, graded in consensus | [`0x9752e2c1`](https://explorer-studio.genlayer.com/tx/0x9752e2c1e2827d2b5d4613781cd39ba8148c8c2f53149bb937ca104b3aa07d4b) | [`0x51e7fdd1`](https://explorer-bradbury.genlayer.com/tx/0x51e7fdd1bcce30e12e8756970a7d35f853c5ca418831763da2d5b1307f094aea) |
| `withdraw` — 0.875 GEN delivered | [`0x2b3f3b0e`](https://explorer-studio.genlayer.com/tx/0x2b3f3b0e6208a269d8d2ea093d91519da0fbf03c587e76c546d557cc765b4daf) | [`0x45b85e71`](https://explorer-bradbury.genlayer.com/tx/0x45b85e71a2735c29e62de753f5344c0bbed821eb05ec12db41cf205406e538a1) |
| `assign_to` — the wallet's credit | [`0xbfc4f2a8`](https://explorer-studio.genlayer.com/tx/0xbfc4f2a8ccb2c9e8cb3dd73de39c27c1ff16e691763fbe0f599d5da2358da080) | [`0x234f28fe`](https://explorer-bradbury.genlayer.com/tx/0x234f28fe09fe7151c9ba7db24d70df77223ae791fd0db2393be7afa2b91c4d9a) |
| `withdraw` — 0.05 GEN delivered | [`0x3f89401a`](https://explorer-studio.genlayer.com/tx/0x3f89401a39e211a95e2b03e376e352611711e482544bbef1a12f4f0bbb2baee6) | [`0x9e0a266c`](https://explorer-bradbury.genlayer.com/tx/0x9e0a266c638a59bf781c43335be2d35be73f4a1c91651bd09b27e43775561f08) |
| wallet `withdraw`, refused | [`0x4e94f7d0`](https://explorer-studio.genlayer.com/tx/0x4e94f7d0df0d031deccf36bc4a47a7425e2464813dd55ef27d37c5cfb70caef1) | [`0x8f6e0bf5`](https://explorer-bradbury.genlayer.com/tx/0x8f6e0bf5c169d47f842ad977991614e11594633a1c9af1f59d05a9a888047a7a) |

Two paths the production policy puts out of reach of a single run, neither a
defect. `min_bond` is 1 GEN rather than the test policy's 0.01, so attesting
costs real balance — the anti-sybil price the design argues for. And
`bond_lock_seconds` is fourteen days, so `reclaim_bond` is covered by
`npm run settlement` against a zero-lock instance instead.

### The reviewer's scenario, driven against the deployment

`npm run recovery` takes the second review's sentence clause by clause against
the live bradbury contract, and prints a transaction for every step so each
claim can be opened in the explorer rather than taken on trust.

> *"on Bradbury a wallet can mark itself proven, then withdraw clears its owed
> balance before an undeliverable transfer, with no restoration path."*

**"a wallet can mark itself proven."** It cannot. The script gives an ordinary
wallet a real entitlement and then has it call `prove_recipient`,
`confirm_recipient` and `withdraw` directly. All three are refused, `is_proven`
stays false, and the entitlement is left exactly where it was — nothing is
parked, nothing is spent. The refusal is the view call into an address with no
code, so it is judged on state rather than on an error string: neither network
reports a reason for a transaction that does not complete.

**"withdraw clears its owed balance."** It parks it. Shown on a recipient that
*can* be paid: `owed_to` goes to zero and the same amount appears under
`in_flight_to`, readable for as long as the transfer is outstanding.

**"with no restoration path."** `reclaim` is the path. It settles the caller's
own outstanding withdrawal against the recipient's balance — closing it when the
value arrived, crediting the entitlement back to the same key when it did not —
and a second call credits nothing.

The restore is refused unless the contract still covers **every** obligation
with the restored claim on the books: entitlements, other withdrawals in flight,
locked bonds and posted collateral. That guard is what makes recovery safe
rather than merely available. A recipient that received the value and then
emptied itself presents the same balance evidence as one that never received it,
so the evidence alone cannot separate them — but the money can. If the transfer
really failed the value is still in the contract and the restore passes; if it
succeeded the balance is short by exactly that amount and the restore is
refused. `liabilities()` reports every figure the guard uses, separately.

### Contract validation

`genvm-lint check`, step one of GenLayer's own `write-contract` testing
strategy:

```text
✓ Lint passed (3 checks)
✓ Validation passed
  Contract: ReputationOracle
  Methods: 28 (16 view, 12 write)
```

---

## Limitations

### A recipient must be a Credent recipient contract

`withdraw` will only pay an address that answers `credent_recipient()` by view.
That is what makes the guard exact on both networks, and it is a real
constraint: an arbitrary contract cannot be pushed value by this oracle, only
one built to receive from it. Every other party — wallets included — uses
`assign_to`, which moves the entitlement into a recipient contract's name
without moving any value and without being able to fail.

The alternative was a guard that a wallet could satisfy on bradbury, which is
what the second review found. Between a constraint on recipients and a hole in
the payout path, the constraint is the right trade.

### The restore branch of `reclaim` is no longer reachable on either network

`reclaim` has two outcomes: close a withdrawal whose value arrived, or credit
the entitlement back when it did not. Only the first is reachable now. Every
contract is credited by `emit_transfer` whatever its code does — measured
against a working `__receive__`, one that raises, and none at all — and after
the recipient guard the only addresses `withdraw` ever emits at are contracts.

The restore branch is kept anyway, and tested, because "cannot happen" is a
claim about the platform rather than about this contract: a network can route a
transfer somewhere the contract cannot foresee, and a recipient can be replaced
between the probe and the payout. An earlier build made the same argument and
concluded that no recovery path was needed. That was the wrong conclusion, and
it is the one the second review rejected. The path exists, `in_flight_to` makes
the outstanding amount readable throughout, and the unit suite drives both
branches.

What can no longer be demonstrated live is the restore itself, because the state
that produced it — a wallet that had marked itself proven — cannot be reached
any more. The transactions from the run that did reach it, against the previous
build, are kept below.

### What this looked like before the recipient guard

The run below is the reviewer's scenario against the earlier build, on bradbury,
with real transactions. It is kept because it is the evidence that the restore
branch works on-chain, and because the difference between the two runs is the
point.

```text
  ok   the wallet marked itself proven (the reported bypass)
  ok   owed is now zero — as the review describes
  ok   but the entitlement is parked in flight (0.020000), not discarded
  ok   the entitlement was RESTORED in full (0.020000)
  ok   and the in-flight record was cleared, so it cannot be reclaimed twice
  ok   the contract still covers every entitlement
```

| Step | Transaction |
|---|---|
| `prove_recipient` | [`0x180bcc5a`](https://explorer-bradbury.genlayer.com/tx/0x180bcc5aca6956281a7cbc87d18cb4bec9321f6045fa82bca7655f415ee366c0) |
| `confirm_recipient` — the wallet answers its own probe | [`0xefde493f`](https://explorer-bradbury.genlayer.com/tx/0xefde493fa04d4bb047633873f668c72b07646e58f90ee113cffa9a14a74475df) |
| `withdraw` — an undeliverable transfer | [`0x825534df`](https://explorer-bradbury.genlayer.com/tx/0x825534df404a1257c13827de14e3901806cc896106b116c5b4c2daebec5f6e5f) |
| `reclaim` — the entitlement restored | [`0x009106f2`](https://explorer-bradbury.genlayer.com/tx/0x009106f2bbda9eff2b9c73af376085c404a552b30ded16e7a724dde9bbc4c9ce) |
| `reclaim` again — credited nothing | [`0xb2f854ad`](https://explorer-bradbury.genlayer.com/tx/0xb2f854ad4b281f93752b0ad27e319223ca27cef8ce348204fa497e64490d19ea) |

The first two rows are what no longer happens. `npm run recovery` drives the
same script against the current deployment and asserts that they are refused.

### Why recovery took three attempts to get right

Two earlier designs tried to decide delivery from the contract's *own* balance
and both were wrong. The first compared it to `total_owed + total_in_flight` and
read a shortfall as proof the value had left; the same balance also holds
collateral and locked bonds, so on a live run it read 1.800 against obligations
of 2.795 and refused a resolution it had no grounds to judge. The second used an
exact `total_in - total_out` ledger, sound only while every wei arrived through
a counted method — a single untracked transfer made a *delivered* payout look
recoverable and would have credited its owner twice.

Both failed for the same reason: the contract's own balance mixes obligations
that have nothing to do with the payout in question. The working answer reads
the **recipient's** balance instead, which is specific to the payout and
answerable because `emit_transfer` credits a contract and never credits a
wallet. The contract's balance is still consulted, but only as a solvency guard
on the restore, never as the evidence for it.

The fourth attempt was that guard. Weighing the balance against `total_owed`
alone counts every locked bond and every posted collateral as free surplus, so a
recipient that took the value and then emptied itself could present the same
balance evidence as one that was never paid and be credited a second time out of
them. The contract now tracks `total_bond_held` and `total_collateral_held` at
both ends — counted when posted, cleared when they settle into an entitlement —
and `_obligations()` is the single figure every solvency question is asked
against. `liabilities()` reports each part separately, so the surplus is
visible rather than inferred.

### Not production infrastructure

- **GenLayer has no mainnet.** The SDK ships localnet, studionet and two testnet
  entries — `testnet-asimov` and `testnet-bradbury`, which are chain id 4221
  under two hostnames rather than two chains; `connect()` answers `mainnet is
  not available yet`. Nothing built here can hold real value today, which is
  also why `min_bond` is one whole token rather than a figure with teeth: GEN
  has no market to price an attack in.
- **Studio is a shared sandbox.** Its state can be reset and its public RPC
  allows 30 requests per minute. Reads retry on that limit with backoff.
- **The registry needs an indexer eventually.** Loading it costs one request per
  page of fifty attestations rather than one per attestation; that holds to a
  few thousand, past which grouping by subject client-side stops being the right
  shape.
- **`get_report` recomputes** an agent's score by walking every attestation
  about them on each read. Bounded in practice by the bond, unbounded in
  principle.
- **The write path has not been signed by a real browser wallet.** It has been
  driven end to end through an EIP-1193 provider backed by a local key.

---

## Platform notes for GenLayer developers

Behaviours that cost a day each to find, recorded so they cost you less.

### The runner directive must be alone in the leading comment block

GenVM parses the contiguous run of `#` comments at the top of the file as its
runner configuration, as JSON, line by line. A banner line touching the
`Depends` directive makes the block unparseable and the node rejects the
contract with `contract_error: invalid_contract`. A blank line ends the block.
Nothing local catches this — `genvm-lint` does not model the header, and the CLI
prints *"Contract deployed successfully"* because the **transaction** was
accepted; the execution failure is inside the receipt.

### Acceptance is not success

A GenLayer transaction reaches `ACCEPTED` when consensus agrees on what
happened — **including when what happened is that your contract rejected the
call.** Always read `consensus_data.leader_receipt`, where studio receipts put
`execution_result` and the contract's own reason. Checking the transaction
status alone reports rejected writes as successes.

This is why a healthy contract shows `ERROR` rows in the explorer: a refusal
that consensus agrees on is an accepted transaction with an errored execution.

### Refusal reasons are not portable

Studio returns the contract's own reason on a rejected call — `[EXPECTED]
recipient_has_not_proven_it_can_receive` and the rest. **Bradbury does not.**
Its receipt carries `txExecutionResultName: "FINISHED_WITH_ERROR"` and nothing
else. The same refusal is legible on one network and opaque on the other.

That cost a test run: the suite asserted the reason text on both and reported
three failures on a run where the contract refused exactly as it should. It now
asserts the refusal everywhere and the reason only where the network provides
one.

### Integers are typed, and large ones arrive as strings

An address argument is its own calldata type: passing the hex string encodes a
`str`, the contract refuses it while unpacking arguments, and the node answers
`execution failed` naming nothing — see `addressArg` in
`web/src/chain/oracle.ts`. In the other direction, a `u256` past 2^53 comes back
as a decimal *string* rather than a `bigint`, so a decoder that accepts only
numbers works until a value gets large. Bonds are denominated in wei, so that
happens on the first real bond.

### `genvm-lint` rejects `__receive__`

E019 demands a `@gl.public.write` decorator on it and E106 then refuses any
public name beginning with `__`, so a recipient contract can be lint-clean or
receive value quietly, not both. Implement it anyway, for the clean receipt —
the value arrives either way.

### Nodes rate-limit, and the client does not retry

Bradbury answers `-32005 transaction gas rate limit exceeded: node is at
capacity` when a run submits faster than it accepts, and viem raises it as a
thrown error that kills a script outright. Every write and deploy in this
repository's scripts waits that condition out, honouring the delay the node
advises. Only that condition is retried — a contract rejection is rethrown at
once, because silently retrying a refusal turns a working guard into a hang.

---

## Deploying

```bash
genlayer account import --name studio --private-key 0x...
genlayer network set studionet

# The thirteen policy parameters, in constructor order. Deploying without them
# takes the contract defaults, and the seventh of those is `min_bond = 0` —
# which switches the bond off entirely and makes every attestation free. The
# last three are the collateral curve: ceiling, floor, and the forfeit
# threshold, all in basis points.
genlayer deploy --contract reputation_oracle.py \
  --args 7776000 30000 25 50 20 8 1000000000000000000 20 50 1209600 15000 2500 2500
```

Then set `VITE_CONTRACT_ADDRESS` in `web/.env.local` or the hosting
environment, and update `deployments.json` — `uicheck` fails if they disagree.

To walk the lifecycle through the site rather than read about it,
[WALKTHROUGH.md](WALKTHROUGH.md) has copy-paste values for every field, which
account signs each step, and what each refusal means. It needs two accounts: the
client cannot name itself as the provider, and only the provider can accept.

---

## Project status

**Working and verified on both networks.** The consent gate refuses an
unaccepted engagement (`engagement_not_accepted`) and refuses acceptance by
anyone but the provider (`sender_not_provider`). The bond gate refuses an
underfunded attestation (`bond_below_required`) before the model is paid to read
anything, and doubles on repeat. The collateral gate refused an acceptance one
wei short of the quote; the correctly funded one posted 8.75 GEN against a 10
GEN stake at 8750bp, the grade moved the provider to 6154, and the same job then
quoted 7.308 GEN — one well-evidenced attestation freeing 1.44 GEN of working
capital.

The payout leg works end to end, with balances checked on both sides of every
transfer, on studionet and testnet-bradbury, against both throwaway instances
and the submitted deployments.

Offline the project carries 353 tests and 3,421 parity vectors, and `genvm-lint`
validates the rebuilt schema at 26 methods and 13 constructor parameters.

---

## Appendix: measurements

Every claim above about platform behaviour was measured. The runs are recorded
here so they can be checked rather than taken on trust.

### A view call into a non-recipient takes the transaction down

The measurement the recipient guard rests on, and the one an earlier build got
half-right: it established that the failure is uncatchable, concluded that no
contract test was available, and stopped. Uncatchable is what makes it work.

A probe contract calls `credent_recipient()` by view on a target address, once
with `try` / `except Exception` around it and once without, against three
targets: a contract implementing the method, a contract that does not, and a
wallet.

```text
                                    catchable form        strict form
studionet  a contract with it       SUCCESS, marker read  SUCCESS, marker read
           a contract without it    ERROR, state untouched ERROR, state untouched
           a wallet                 ERROR, state untouched ERROR, state untouched
bradbury   a contract with it       state moved            state moved
           a contract without it    refused, untouched     refused, untouched
           a wallet                 refused, untouched     refused, untouched
```

The `except` clause never runs. Both forms behave identically, on both networks,
which is what makes the call usable as a refusal: there is no branch to route
around, and a caller either reaches the next line having answered or does not
reach it at all.

### An externally owned account is not credited

One payer contract, two transfers of 0.01 GEN in the same run. The control is a
claimant that had already been paid 0.925 GEN by this exact mechanism, so a
broken payer would have shown there:

```text
payer   0xDc66a69677BB7f636D5d67e5350842abFBC4EEf9   funded 0.030000 GEN
CONTROL 0x5d6df82bDd832f09b323256DD7dddC94265Ca324   0.925000 -> 0.935000   credited: YES
EOA     0x7C4D842feE6e5e1B4Db3B8da5853a608dd456Bcf   0.000000 -> 0.000000   credited: NO
payer ends with 0.010000 GEN
```

[The GenLayer docs](https://docs.genlayer.com/developers/intelligent-contracts/introduction)
describe `emit_transfer()` as sending value "to other contracts or EOAs", which
would make this design unnecessary — so it was measured with a control rather
than argued either way.

### Every contract is credited, whatever its code does

```text
payer 0xC6078BAbe6C9a8AAb7682Cf0C6dc1685d99B6BEB   funded 0.050000 GEN
  working __receive__   0x1f7FB150fd9c9F4312af5EfC702ae60755dd49d4   -> 0.010000  credited
  __receive__ raises    0xDF69E01C58bd6430B104B256c07D2364187D4819   -> 0.010000  credited
  no __receive__        0x53507C4c26dAb57E8B8EB2b2739713997c7a8b61   -> 0.010000  credited
payer ends with 0.020000 GEN
```

Crediting and executing are separate outcomes. Without the handler the inbound
message leaves `ValueError: call to private method ...` in its receipt, which
reads exactly like a failed payout and is not one.

### The failed-transfer hazard differs by network

On studionet, an `accepted` transfer at a wallet leaves the sender and arrives
nowhere, and the documented refund hook does not run:

| `on` | sender's balance | handler fired | value returned |
|---|---|---|---|
| `accepted` | **0.200 → 0.190 GEN** | **no** (150s) | **no** |
| `finalized` | 0.190 → 0.190 | no | n/a — never dispatched |

Bradbury does not behave the same way, and an earlier version of this file
claimed it did — a studionet measurement generalised without checking. Driven
through the deployed oracle's own `withdraw` and watched for fifteen minutes:

```text
t=0     oracle 1.063750  wallet 5.224358
t=900s  oracle 1.063750  wallet 5.224358
verdict: the emitted transfer to a wallet LEFT THE VALUE IN THE CONTRACT
```

The recipient is not credited on either network — the part the payout design
turns on. What differs is the sender: studionet debits it, bradbury does not. So
a failed payout destroys value on one network and strands it on the other, and
neither is a case worth reaching.

### Networks targeted

| Network | Chain | `on="accepted"` | `on="finalized"` |
|---|---|---|---|
| studionet | 61999 | EOA not credited; the value left the sender | EOA not credited; never dispatched |
| testnet-bradbury | 4221 | EOA not credited | EOA not credited |
| testnet-asimov | 4221 | *the same chain as bradbury* | *the same chain as bradbury* |
| localnet | 61127 | not tested | not tested |

`testnet-asimov` and `testnet-bradbury` are chain id 4221 under two hostnames,
not two chains, so there is one testnet here rather than two. Localnet is a
loopback node and was never exercised; a claim about it would be a guess.
