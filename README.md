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

Deployed on GenLayer Studio at `0x1903b01a14053c2322ede4373669F411Dcd2Cd05`,
inspectable through the [GenLayer Studio explorer](https://explorer-studio.genlayer.com/).
Studio cannot pay a wallet from a contract, so every payout there is recorded and
never arrives — the site says so, and `npm run settlement` proves it. See
**Settlement**.

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

Everything above runs offline. The one check that cannot is `npm run settlement`,
which proves the payouts actually pay — see **Settlement** below.

CI runs all of it on every push. Neither of the two failures this project hit in
deployment would have been caught by it — both were green locally and broken on
chain — but everything checkable without a network is now checked without anyone
remembering to.

## Deploying

```bash
genlayer account import --name studio --private-key 0x...
genlayer network set studionet
# ...or `testnet-asimov` / `testnet-bradbury` to deploy where payouts actually
# arrive. Nothing below changes; see Settlement.

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

**A contract cannot pay a wallet on studionet.** Emitting value is the one thing
this runner cannot do toward an externally owned account, and every provider and
attester is one. The message a contract emits becomes a **type 2** transaction — a
contract call — which studio executes against the recipient and finalizes with
`execution_result: ERROR` and the reason `Contract 0x… not found`. The parent call
still reports success, because from the contract's side emitting the message *is*
the whole operation, so nothing surfaces until you read the triggered transaction
or notice the balance never moved.

Seven routes were tried against a probe contract on the same runner pin, and all
seven end in the same place:

| Route | Result |
| --- | --- |
| `emit_transfer(on='finalized')` | emits, transfer fails `Contract 0x… not found` |
| `emit_transfer(on='accepted')` | emits, same failure |
| `gl.Account(...)` | not exposed on this runner's proxy; `exit_code 1` |
| `gl.chain.Account(...)` | not exposed either; same crash |
| `wasi.gl_call({'PostMessage': …})`, calldata `{}` | emits, same failure |
| the same with calldata `b''` | emits, same failure |
| the same with calldata `None` | emits, same failure |

The calldata makes no difference: the message kind is a call whatever it carries.
That also rules out the indirections worth reaching for — an internal ledger of
claimable balances, or paying into a vault contract — because the last hop is
still contract to wallet. The fix is not in this repository. `reclaim_bond` has
carried the same limitation since it was written, hidden behind a 14-day lock
nobody had waited out, and the collateral layer is simply the first code here
that settles fast enough to expose it.

**The deployment stays on studionet, and the software stops implying otherwise.**
That is a deliberate split, so it is worth separating the two halves.

Studionet is where this contract is deployed and where it is being demonstrated,
so it remains the default: a default naming a network with no deployment on it
renders an empty registry, which reads as a broken site rather than a missing
address. What changes is that nothing here claims a payout will arrive when it
will not:

- The site detects studio networks **structurally**, through the SDK's own
  `isStudio` flag rather than a list of names, so a network added later
  classifies itself instead of defaulting to "settlement works". `/attest` says
  so above the three settlement steps. See `SETTLEMENT_SUPPORTED` in
  `web/src/chain/config.ts`.
- `npm run settlement` stops asserting what the contract decided and checks what
  the chain did — the triggered transaction and the recipient's balance. On
  studionet it **confirms** the limitation: it passes when every payout is
  recorded and none is paid, and fails if one unexpectedly arrives. See
  **Settlement** below.

`testnet-asimov` and `testnet-bradbury` are not studio networks and should apply
these messages properly. Both are fully supported targets — the contract and the
client need no change for either — and the same harness verifies settlement
there for real. Moving is a deploy and two environment variables, not a code
change.

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

## Settlement

Every other check in this repository asserts what the contract *decided*. None of
them could have caught the defect above, because the contract decided correctly
every time: `release_collateral` marked the collateral returned, emitted the
transfer, reached `ACCEPTED`, and left a clean leader receipt — over money that
never moved.

`npm run settlement` is the check that closes that gap. It asserts the only two
things that separate a settled payout from a recorded one:

1. the **triggered transaction** the payout produced finished without error, and
2. the **recipient's balance** actually went up.

The first is the diagnosis and the second is the ground truth. `emit_transfer`
does not move value inside the calling transaction — it queues a message the node
executes as its own transaction afterwards — so the failure is invisible in the
parent receipt and visible in exactly those two places.

```bash
cd web

# On studionet: confirm the limitation on the deployed network.
CLIENT_PRIVATE_KEY=0x... PROVIDER_PRIVATE_KEY=0x... npm run settlement

# On a network that can pay a wallet: verify settlement for real.
VITE_GENLAYER_NETWORK=testnet-asimov \
CLIENT_PRIVATE_KEY=0x... \
PROVIDER_PRIVATE_KEY=0x... \
npm run settlement
```

The two runs mean different things, and the script keeps them apart rather than
collapsing both into "pass". On studionet it is a **characterization test**: it
passes when every payout is recorded and none is paid — the documented
limitation, reproduced rather than asserted — and fails if a payout unexpectedly
arrives, which would mean this file has gone stale. A pass there never reads as
"the money moved"; the closing line says so explicitly. On a settling network it
is a **verification**: every payout must arrive, or the run fails.

It covers every path in this contract that returns value:

| Payout | Reached by |
| --- | --- |
| acceptance refund | an overfunded `accept_engagement` returns the excess |
| attestation refund | an overfunded `attest` returns the excess |
| release, graded | the client graded the work as delivered |
| release, ungraded | nobody attested and the dispute window elapsed |
| claim | a substantiated grade forfeited it to the client |
| bond reclaim | the attester takes the bond back after the lock |

Two accounts, because the protocol requires two: a client cannot name itself as
its own provider, and only the named provider can accept. Both need funding —
the provider posts collateral, the client posts bonds. `SETTLEMENT_STAKE`
(default 2 GEN) sets the engagement value everything else is priced off, and
`SETTLEMENT_BOND`, `SETTLEMENT_OVERPAY` and `SETTLEMENT_GAS_ALLOWANCE` tune the
rest.

**It deploys its own contract**, rather than running against the live one. Two of
those six paths wait out `bond_lock_seconds` — fourteen days at the deployed
policy — so verifying them against a long-lived deployment would mean running the
setup and the assertion a fortnight apart. The lock is a policy parameter, so the
script deploys an instance with it set to zero and every other parameter left at
the deployed values. Nothing about the payout path changes with the lock; only
the wait does.

**On a studio network it does not pretend, and does not merely give up.** It runs
the same lifecycle and reports each payout with the triggered transaction's own
error, which is what turns the section above from a claim into a reproducible
result. Anyone doubting that studionet records payouts it never pays can run this
and watch it happen.

It is not in CI, and cannot be: it needs two funded accounts and a live network,
and CI has neither. Two of the six outcomes also depend on how the model grades
the evidence — the release path needs a grade that is substantiated and
fulfilled, the claim path one that is substantiated and *un*fulfilled — so the
script checks the resulting `collateral_state` and reports plainly when a grade
did not reach the state a leg needs, rather than reporting a pass it did not
earn.

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
and 266 new parity vectors, and `genvm-lint` validates the rebuilt schema: 18
methods, 13 constructor parameters.

### The payout leg

On studionet the payout leg does **not** work, and it is a property of the
network rather than of this contract — see *A contract cannot pay a wallet on
studionet* above, where all seven available routes are tabulated.
`release_collateral`, `claim_collateral`, the two refunds and `reclaim_bond` all
record the right decision, emit the right transfer, and then the chain fails to
apply it. Collateral posted on studionet is collateral held.

The response to that is in this repository and has two halves. The site stops
implying a payout will arrive when it will not, and says so where it offers a
settlement action. And `npm run settlement` now checks the payouts the only way
they can be checked — by reading the triggered transaction and the recipient's
balance — instead of asserting what the contract decided, which was never the
broken part.

Deployment stays on studionet, so the honest position is that the collateral
layer **prices and gates correctly, and does not settle**. That is a property of
the network, it is now reproducible on demand rather than argued, and the
software no longer reports it as a success.

**Neither run has been performed yet.** The harness is written, typechecks,
bundles, and its guards and balance-read path have been exercised as far as the
first RPC call; what remains is a run against a live network with two funded
accounts. Two things are therefore still open, and neither should be read as
settled:

- the studionet run, which should **confirm** the limitation — this needs only a
  faucet and the deployed contract;
- the Asimov run, which should **verify** settlement. Contract-to-wallet payment
  there is **expected to work and unproven**: the seven routes above establish
  that studio is the blocker, not that Asimov is the cure.

Until this section records the output of either, treat both as unproven — the
same standard this file applies everywhere else, and the reason these claims are
written here rather than in the present tense above.

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
