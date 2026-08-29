# Credent

Reputation as collateral for autonomous agents.

An agent's counterparties write attestations about completed work. A GenLayer
intelligent contract grades each one with an LLM **in consensus** — several
validators run the same prompt and must agree — and aggregates the graded
outcomes into a score. The score decides how much collateral the agent has to
post up front. Nobody is asked to trust a self-report, and nobody has to trust a
single model call either.

That last sentence is a gate in the contract, not a summary of one. A client
opens an engagement declaring what the work is worth; when the named provider
accepts it, `accept_engagement` reads their `get_report().score_bp`, converts it
through `collateral_required` into a share of that stake, and **refuses the
acceptance unless the transaction carries it** — 150% of the stake for an agent
with no record, 87.5% for one with no history at all, 25% for a perfect one. A
substantiated attestation that the work went undelivered forfeits that collateral
to the client; anything else returns it. The attester's bond is a separate,
smaller mechanism that prices *reviewing*, and it is not what the score feeds.

Deployed on **GenLayer Studio** at `0x8B7B9bd431F61dE6c7B2294c57fd7a820777775c`,
inspectable through the [GenLayer Studio explorer](https://explorer-studio.genlayer.com/),
and on **Testnet Bradbury** at `0x335A1b98729CA924014227E7B8238d76C8A09Cb3` — the
minified artifact there, since bradbury refuses the full-size source on
transaction pubdata rather than on gas.

Both carry the production policy and both answer `owed_to`, which is the
quickest way to confirm you are looking at a build with the settlement fix in it
rather than an earlier one.

The production policy is **not** the constructor's bare defaults, and the
difference matters. The defaults leave `min_bond` at zero, which makes an
attestation free to write and switches off the cost that the anti-sybil argument
rests on. `npm run livecheck` asserts `min_bond == 1 GEN` for exactly that
reason, and it is the check to run against any deployment before trusting it --
an earlier pair of these addresses was deployed on the defaults and failed it. Every view and
every write works on both, **payouts included**: settlement credits an
entitlement and `withdraw()` moves the value out to a recipient that can receive
it, proven with balances on both sides of the transfer. See *A contract cannot
pay a wallet, and that is a design constraint rather than a dead end*.

---

## Why it is laid out this way

The scoring arithmetic decides money, so it is written once and pinned twice.

```
reputation_core.py      the deterministic engine — every number the protocol produces
reputation_prompts.py   the grading prompt, built byte-identically by every validator
contract_shell.py       the chain-facing contract: storage, access rules, consensus
build_contract.py       splices the three into one deployable file
reputation_oracle.py    ← generated. Do not edit.
web/                    the site: reads the chain, and writes to it with your wallet
```

GenLayer's runner takes a **single** Python file, so the engine has to live
inside the contract rather than be imported by it. Concatenating by hand would
mean two copies of arithmetic that 337 tests are pinned to, and the copy that
drifts is always the one nobody runs. So `build_contract.py` inlines the engine
verbatim — byte for byte, nothing reformatted — and `test_build_contract.py`
fails the suite if the checked-in artifact is stale.

The site ports the same arithmetic to TypeScript, because it explains *how* each
weight was reached and the contract only returns the result. That port is pinned
to the engine by 3421 generated parity vectors across 13 families. If the two ever
disagree, `npm run parity` fails the build.

## Running it

```bash
pip install -r requirements-dev.txt
python -m pytest                 # 337 tests: engine, prompts, contract, parity vectors
python build_contract.py         # regenerate reputation_oracle.py after any engine change

cd web
npm ci
cp .env.example .env.local       # then set the contract address
npm run dev
npm run parity                   # the TS port still agrees with the Python engine
npm run units                    # formatting, error text, calldata encoding
npm run build
```

CI runs all of it on every push. Neither of the two failures this project hit in
deployment would have been caught by it — both were green locally and broken on
chain — but everything checkable without a network is now checked without anyone
remembering to.

## Deploying

```bash
genlayer account import --name studio --private-key 0x...
genlayer network set studionet

# The thirteen policy parameters, in constructor order. Deploying without them
# takes the contract defaults, and the seventh of those is `min_bond = 0` - which
# switches the bond off entirely and makes every attestation free. The last three
# are the collateral curve: ceiling, floor, and the forfeit threshold, all in
# basis points. Those three have working defaults and are passed here so the
# deployment states them rather than inheriting them.
genlayer deploy --contract reputation_oracle.py \n  --args 7776000 30000 25 50 20 8 1000000000000000000 20 50 1209600 15000 2500 2500
```

Then set the address in `web/.env.local`, or in the hosting environment:

| Variable | Meaning |
| --- | --- |
| `VITE_CONTRACT_ADDRESS` | The deployed `ReputationOracle`. Changes on every redeploy. |
| `VITE_GENLAYER_NETWORK` | `localnet`, `studionet`, `testnet-asimov`, or `testnet-bradbury`. |

Both are public by construction. Vite inlines every `VITE_`-prefixed variable
into the client bundle, so **nothing secret can go here** — and nothing needs to.
The site never holds a key: every view it reads is unsigned, and every write is
signed by the visitor's own wallet.

### Three things that will waste your afternoon

Each cost a day to find, so they are written down.

**The runner directive must be alone in the leading comment block.** GenVM parses
the contiguous run of `#` comments at the top of the file as its runner
configuration, as JSON, line by line. A banner line touching the `Depends`
directive makes the block unparseable and the node rejects the contract with
`contract_error: invalid_contract`. A blank line ends the block. Nothing local
catches this — `genvm-lint` does not model the header, and the CLI prints
*"Contract deployed successfully"* because the **transaction** was accepted;
the execution failure is inside the receipt.

**Acceptance is not success.** A GenLayer transaction reaches `ACCEPTED` when
consensus agrees on what happened — including when what happened is that your
contract rejected the call. Always read `consensus_data.leader_receipt`, where
studio receipts put `execution_result` and the contract's own reason. Checking
the transaction status alone reports rejected writes as successes.

**A contract cannot pay a wallet, and that is a design constraint rather than a
dead end.** This section used to end by concluding the opposite, and the
conclusion was wrong. It is left corrected rather than deleted, because the
mistake is more instructive than the finding.

Emitting value toward an **externally owned account** does not work. The message
a contract emits becomes a call to the recipient; a wallet holds no code, the
call errors with `Contract 0x… not found`, and `__on_errored_message__` refunds
the value to the sender. The parent transaction still reports success, because
from the contract's side emitting the message *is* the whole operation, so
nothing surfaces until you read the triggered transaction or notice the balance
never moved. Seven routes were tried -- both `on` modes, `gl.Account`,
`gl.chain.Account`, and `wasi.gl_call({'PostMessage': …})` with three different
calldata shapes -- and all seven end in the same place.

**Emitting value toward a contract works.** That is the half this repository
never tested, and it is the half that matters. Measured with an isolated probe:

| Recipient | `on` | `value_credited` | Recipient credited |
|---|---|---|---|
| EOA | `accepted` | **false** | no |
| EOA | `finalized` | **false** | no |
| **Contract** | `finalized` | **true** | **yes** |

So the fix belongs in this contract, not in the runner, and the earlier claim
that "the contract needs no change" was the expensive kind of wrong: it was
true about the mechanism and false about the remedy. Testing only the failing
half and generalizing from it is how a platform limitation gets invented.

**What the contract does now.** Settlement **credits an entitlement** rather
than pushing value. `_credit(recipient, amount)` is pure storage: it cannot
fail, cannot be dropped by a consensus round, and is readable through
`owed_to`. `withdraw()` moves the value in a separate call the recipient makes
when it can receive it, so the part that must not fail no longer depends on the
part that can.

`withdraw()` requires the caller to assert it is a contract, and refuses by
default. The contract cannot check this itself, and the Ethereum guard does not
port: GenLayer sets `origin_address` **equal to** `sender_address` across an
emitted call, so `sender != origin` rejects the one path that works. Making the
caller say it, and refusing unless they do, is not a proof -- it is the
difference between a mistake anyone can make by accident and one you have to opt
into.

**`withdraw_to()` is the half that stops a wallet's credit from being stranded**,
and it was missing for longer than it should have been. `withdraw()` pays
`gl.message.sender_address`, so it can only ever deliver to a contract that calls
it itself. But four of the five parties this contract credits are ordinarily
wallets -- a provider taking back collateral, a client claiming forfeited
collateral, an attester reclaiming a bond, anyone refunded an overpayment -- and
a wallet calling `withdraw()` achieves nothing. Their entitlement was recorded
correctly, readable through `owed_to`, and permanently immobile: the settlement
defect this section is about, moved one step down the pipe.

`withdraw_to(recipient, recipient_is_a_contract)` lets an entitlement's owner
send its own credit to a contract it names. Authorisation is preserved by
construction rather than by a check: the entitlement is keyed by
`gl.message.sender_address`, so naming a recipient decides *where* the value
goes and never *whose* value it is. Paying this contract is refused outright,
and the balance is zeroed before the transfer for the same reason `withdraw()`
zeroes first.

**What that means for an integrator.** A party that expects to be paid has to
name something that can receive, and receiving means being a contract. It does
not have to *be* one: a wallet can hold an entitlement and hand it to a contract
with `withdraw_to`. What no party can do is take value at an externally owned
address, on any network, because that is a property of `emit_transfer` rather
than of this contract.
`web/scripts/claimant.py` is the smallest one that works: it accepts an
engagement as the provider (forwarding its own collateral, so the oracle sees
the contract as the provider), implements `__receive__`, and calls `withdraw`.
Roughly sixty lines.

One snag worth knowing before you write your own: **`genvm-lint` rejects
`__receive__`.** E019 demands a `@gl.public.write` decorator on it and E106 then
refuses any public name beginning with `__`, so a recipient contract can be
lint-clean or receive value quietly, not both. Without the handler the value
still arrives -- crediting and executing are separate outcomes -- but every
inbound transfer leaves `ValueError: call to private method ...` in its receipt,
which reads exactly like a failed payout and is not one.

**Proven end to end, with balances, on both networks.** `npm run settlement`
runs release, claim, both refund paths and bond reclaim, asserting each
entitlement to the wei, and then withdraws twice: once as a contract collecting
its own credit, and once as a *wallet* moving its credit to a contract it names.
It passes on **studionet and on testnet-bradbury**, every check on both. The
*number* of checks moves a little between runs -- 29 on the studionet run quoted
below, 27 on the bradbury one -- because engagement three's bond reclaim only
happens when the grade leaves that bond releasable. Nothing is skipped silently:
the withdrawal's label and total change with it, and the bond-reclaim payout is
proven separately either way, further down.

`claim` is in that list for real now, and was not before. `claim_collateral` is
only live when a grade leaves the collateral `forfeit`, which on the production
25% threshold is an LLM's judgement rather than the script's -- so the branch
fired or did not depending on the grade, and on the run that prompted this
change it did not. The suite passed without ever exercising one of the four
payouts it claimed to cover. It now runs a fourth engagement on a second oracle
whose forfeit threshold is 100%, which leaves the grade real and makes the path
reachable every run.

The rejection that prompted this change named release, refund and bond reclaim
specifically, so the third engagement earns all three against a contract
recipient and takes them out in a single call:

```text
owed from release, refund and bond reclaim: 0.935 GEN

withdraw: release, refund and bond reclaim all leave the contract
  contract  2.795 GEN -> 1.86 GEN   (-0.935 GEN)
  claimant  0 GEN     -> 0.935 GEN  (+0.935 GEN)
  owed_to   0.935 GEN -> 0 GEN
  ok   the claimant's balance rose (+0.935 GEN)
  ok   the contract paid out exactly 0.935 GEN
  ok   the entitlement was zeroed
```

0.935 GEN is 0.875 release plus 0.05 refund plus 0.01 bond reclaim.

**That third figure moves, and the suite says so rather than pretending
otherwise.** The claimant's bond is reclaimable only when the grade does not
slash it, and a grade that slashes a thin attestation is the bond working, not a
failure. On a run where it is slashed this withdrawal covers release and refund
alone and prints `0.925 GEN` under a label that says so. Which is why proving
*bond-reclaim* money leaves cannot rest on this engagement, and does not:

```text
=== the client wallet's own credit ===
  owed_to(client wallet) 0.06 GEN
    ok   the wallet holds its refund plus its reclaimed bond (0.06 GEN)

withdraw_to: the wallet takes out its refund and its reclaimed bond
  contract  1.86 GEN -> 1.8 GEN  (-0.06 GEN)
  claimant  0 GEN    -> 0.06 GEN  (+0.06 GEN)
  owed_to   0.06 GEN -> 0 GEN
  ok   the contract paid out exactly 0.06 GEN
  ok   the entitlement was zeroed
```

That bond was reclaimed in engagement two, by the client, whose account is an
ordinary wallet. Every run reaches it, and before `withdraw_to` nothing could
have moved it.

And the fourth engagement is the one that answers *whose* money can move. The
collateral is forfeited by the grade, claimed by the client -- an ordinary
wallet, not a contract -- and then moved out by that wallet with `withdraw_to`:

```text
claim_collateral: the client takes collateral the grade forfeited
  owed 0.875 GEN to client wallet 0xaA34e14a0e0B2fdD8Ad10F06bC0907fA0b1D02Bd
  ok   the entitlement rose by exactly 0.875 GEN

withdraw_to: a wallet moves its own claimed collateral to a contract
  contract  0.885 GEN -> 0.01 GEN   (-0.875 GEN)
  claimant  0 GEN     -> 0.875 GEN  (+0.875 GEN)
  owed_to   0.875 GEN -> 0 GEN
  ok   the claimant's balance rose (+0.875 GEN)
  ok   the contract paid out exactly 0.875 GEN
  ok   the entitlement was zeroed
```

Without `withdraw_to` that 0.875 GEN stays in the contract for good, and
`owed_to` reports it accurately forever.

One timing note for anyone re-running this. `attest` makes an LLM call inside
the consensus round, and a contract-emitted one adds a hop; on bradbury it has
taken over fifteen minutes and settled comfortably at twenty. `ATTEST_TIMEOUT_MS`
exists for that, and a timeout there is a timeout rather than a verdict -- an
earlier draft of this repository concluded from one such timeout that the path
could not settle on bradbury at all, which was wrong and is the same shape of
error as the one this whole section corrects.


**These are the suite's own throwaway contracts, not the deployments.** Each run
deploys a fresh oracle with the bond lock at zero so one pass can reach every
path, and a fresh claimant to receive the payout. They are listed so the run
above can be inspected on-chain; the addresses to actually use are the two at
the top of this file.

| Network | Oracle (test policy) | Claimant | Strict oracle (100% forfeit) | Wallet's recipient |
|---|---|---|---|---|
| Studionet | `0x12464272DBA6b5A2eA6eD444dAe2f66217a615E9` | `0xcb0B8E2C6d5173f928Dd5B3025Aa6586934060a0` | `0x39f6dDfEB821EA4413c60B1a534c7b393842e6a0` | `0xa0F2Dc1Ac3563cE5e8B1fd454E5378D88624fC0A` |
| Testnet Bradbury | `0x6A2096C655A4C2784620e9E2BCcF3713ec48fD34` | `0x7a6B56D8656671C743DBB33C23E3cBB575dF7bb9` | `0x63210cFA12a1d84c42AF8560C081ea97ff272d65` | `0xAc7C9E09B5001C1c6f3a64e083614A637B8Ee008` |

The wallet's own refund and reclaimed bond went to
`0xc81EAf9a00401D634bC1cefbeC39cBEA4dB9bC95` on studionet and
`0x45943C977A7CBAde01C6e08112fDa09C79b92a36` on bradbury.

The last two columns are the fourth engagement: the oracle whose forfeit
threshold is raised so `claim_collateral` is reachable, and the contract the
client's **wallet** sent its claimed collateral to with `withdraw_to`.


```text
withdraw: the claimant takes the money out of the contract
  contract  2.735 GEN -> 1.86 GEN   (-0.875 GEN)
  claimant  0 GEN     -> 0.875 GEN  (+0.875 GEN)
  owed_to   0.875 GEN -> 0 GEN
  ok   the claimant's balance rose (+0.875 GEN)
  ok   the contract paid out exactly 0.875 GEN
  ok   the entitlement was zeroed

settlement ok - 15 checks, every payout reached its recipient
```

**Integers are typed, and large ones arrive as strings.** An address argument is
its own calldata type: passing the hex string encodes a `str`, the contract
refuses it while unpacking arguments, and the node answers with `execution
failed` naming nothing — see `addressArg` in `web/src/chain/oracle.ts`. In the
other direction, a `u256` past 2^53 comes back as a decimal *string* rather than
a `bigint`, so a decoder that accepts only numbers works until a value gets
large. Bonds are denominated in wei, so that happens on the first real bond.

## The lifecycle

```
open_engagement    client proposes a scope, a provider, and a stake → proposed
accept_engagement  the provider agrees, posting collateral          → open
close_engagement   either party marks the work finished             → closed
attest             a counterparty grades the other, posting a bond
reclaim_bond       the attester takes the bond back after the lock
release_collateral the provider takes their collateral back
claim_collateral   the client takes it instead, if the work was forfeited
```

The acceptance step is load-bearing twice over. It is the consent gate: without
it anyone could name a victim as their provider, close the engagement alone, and
have them graded on work they never agreed to — the bond is a price on that, not
a bar to it. Only the named provider can accept, and they accept a scope whose
digest is already committed.

It is also the only place reputation costs money. The collateral is priced from
the provider's own score at the moment they accept and frozen into storage, so a
later review cannot retroactively change what an earlier job cost them. Two views
quote it before anyone signs: `collateral_quote(provider, stake)` returns the
score, the rate it buys and the amount owed, and `get_engagement` carries all
three back afterwards so the figure can be re-derived rather than trusted.

Settlement runs on explicit calls, never during grading. The client's attestation
marks the collateral `releasable` or `forfeit` — forfeiting only on a grade
substantiated and confident enough to carry weight in the score, so an unevidenced
accusation moves nothing — and the money follows in `release_collateral` or
`claim_collateral`. A client who simply never attests cannot strand the capital
either: after the engagement has been closed for `bond_lock_seconds`, the
provider releases it ungraded.

To run that sequence through the site rather than read about it,
[WALKTHROUGH.md](WALKTHROUGH.md) has copy-paste values for every field, which
account signs each step, and what each refusal means. It needs two accounts —
the client cannot name itself as the provider, and only the provider can accept.

## Status

Verified end to end against a live deployment: the consent gate refuses an
unaccepted engagement (`engagement_not_accepted`) and refuses acceptance by
anyone but the provider (`sender_not_provider`); the bond gate refuses an
underfunded attestation (`bond_below_required`) before the model is paid to read
anything, and doubles on repeat; the batch views return the registry in a
handful of calls; and the site renders every route, reads the deployed policy,
and submits correctly formed transactions from a connected wallet.

The collateral layer has now been run against a live deployment too, and the
gate it exists for holds: an acceptance one wei short of the quote was refused
with `collateral_below_required`, the correctly funded one posted 8.75 GEN
against a 10 GEN stake at the neutral rate of 8750bp, the grade moved the
provider to 6154, and the same job then quoted 7.308 GEN — one well-evidenced
attestation freeing 1.44 GEN of working capital. Offline it carries 60 new tests
and 266 new parity vectors, and `genvm-lint` validates the rebuilt schema: 21
methods, 13 constructor parameters. The offline suite is 340 tests.

The payout leg works, and getting there was the most instructive part of this
build. An earlier revision pushed value directly at providers, clients and
attesters at the moment of settlement, and moved nothing: `emit_transfer` does
not credit an externally owned account, and every one of those parties is a
wallet. This paragraph used to say so and conclude the fix was upstream. It was
not.

`release_collateral`, `claim_collateral`, the acceptance refund and
`reclaim_bond` now credit an entitlement, which is pure storage and cannot fail,
and `withdraw()`/`withdraw_to()` move the value in a separate call the recipient
makes. The *recipient* must be a contract, because that is the only kind of
address this runner credits — `web/scripts/claimant.py` is the sixty-line
reference. The *entitlement owner* need not be: a wallet holds its credit and
hands it to a contract it names with `withdraw_to`, which is what stops the four
wallet-facing payouts from being recorded correctly and left immobile. Run
`npm run settlement` to watch a contract's balance fall by exactly what the
recipient's rises by, on both counts.

A note for anyone reading an older review of this repository. The answer to
"identify a target network where contract-to-wallet payouts complete" is that
there is not one, and there is not meant to be: `emit_transfer` does not credit
an externally owned account on localnet, studionet or either testnet, in either
`on` mode, by any of the seven routes tried. Naming a network would have been
the wrong fix. The right one was to stop requiring a wallet to receive at all —
settlement credits, and value moves contract to contract, with `withdraw_to` as
the bridge that lets a wallet direct its own credit into one. That is proven
with balances on studionet **and** on testnet-bradbury, which is the closest
thing to "a target network where settlement completes" that this platform
currently permits.

It is **not** production infrastructure, for reasons mostly outside this
repository:

- **GenLayer has no mainnet.** The SDK ships localnet, studionet and two
  testnets; `connect()` answers `mainnet is not available yet`. Nothing built
  here can hold real value today, which is also why `min_bond` is set to one
  whole token rather than a figure with teeth — GEN has no market to price an
  attack in.
- **Studio is a shared sandbox.** Its state can be reset, and its public RPC
  allows 30 requests per minute. Reads retry on that limit with backoff.
- **The registry needs an indexer eventually.** Loading it now costs one request
  per page of fifty attestations plus one per page of reports, rather than one
  per attestation; that holds to a few thousand, past which grouping by subject
  client-side stops being the right shape.
- The write path has not yet been signed by a real browser wallet; it has been
  driven end to end through an EIP-1193 provider backed by a local key.
- `get_report` recomputes an agent's score by walking every attestation about
  them on each read. Bounded in practice by the bond, unbounded in principle.
