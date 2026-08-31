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

Deployed on **GenLayer Studio** at `0x10B19063c1F03E91103c6cb9E1845D66eeE08bC5`,
inspectable through the [GenLayer Studio explorer](https://explorer-studio.genlayer.com/),
and on **Testnet Bradbury** at `0x791852F8571481EA503D0863660A9Cb8fBD6c940` — the
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
mean two copies of arithmetic that 349 tests are pinned to, and the copy that
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
python -m pytest                 # 349 tests: engine, prompts, contract, parity vectors
python build_contract.py         # regenerate reputation_oracle.py after any engine change

cd web
npm ci
cp .env.example .env.local       # then set the contract address
npm run dev
npm run parity                   # the TS port still agrees with the Python engine
npm run units                    # formatting, error text, calldata encoding
npm run uicheck                  # the site and the contract still speak the same names
npm run build
```

Two more need a network but no key, no gas and no setup — they read the
deployments named in `deployments.json`:

```bash
npm run verify-deployment        # the deployed bytes are this repository's, hashed
npm run agreement                # agreement preserves the bond and collateral outcomes
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

Emitting value toward an **externally owned account** does not work, **and the
value is not returned**. The message a contract emits becomes a call to the
recipient; a wallet holds no code, and the call errors with
`Contract 0x… not found`. The parent transaction still reports success, because
from the contract's side emitting the message *is* the whole operation, so
nothing surfaces until you read the triggered transaction or notice the balance
never moved.

An earlier revision of this section said `__on_errored_message__` refunds the
value. That was wrong, and it mattered, because it was the justification for a
payout path that could destroy money. Measured on studionet with a probe that
implements the handler explicitly:

| `on` | sender's balance | handler fired | value returned |
|---|---|---|---|
| `accepted` | **0.200 → 0.190 GEN** | **no** (150s) | **no** |
| `finalized` | 0.190 → 0.190 | no | n/a — never dispatched |

So an `accepted` transfer at a wallet leaves the sender and arrives nowhere, and
the documented refund hook does not run. There is no recovery after the fact;
the only safe design is not to push value at an address the contract cannot
verify. That is why the payout path below moves entitlements rather than value. Seven routes were tried -- both `on` modes, `gl.Account`,
`gl.chain.Account`, and `wasi.gl_call({'PostMessage': …})` with three different
calldata shapes -- and all seven end in the same place.

**The documentation says otherwise, so this was measured again with a control.**
[The GenLayer docs](https://docs.genlayer.com/developers/intelligent-contracts/introduction)
describe `emit_transfer()` as sending value "to other contracts or EOAs", which
would make this entire payout design unnecessary. A reviewer reading that page
should see the measurement rather than take either claim on trust.

One payer contract, two transfers of 0.01 GEN, same run. The control is a
claimant contract that had already been paid 0.925 GEN by this exact mechanism,
so if the payer were broken the control would show it:

```text
payer   0xDc66a69677BB7f636D5d67e5350842abFBC4EEf9   funded 0.030000 GEN
CONTROL 0x5d6df82bDd832f09b323256DD7dddC94265Ca324   0.925000 -> 0.935000   credited: YES
EOA     0x7C4D842feE6e5e1B4Db3B8da5853a608dd456Bcf   0.000000 -> 0.000000   credited: NO
payer ends with 0.010000 GEN
```

The payer is debited **0.02 GEN for two transfers** and only one arrives. The
wallet is not credited and the 0.01 GEN sent toward it is gone. Every earlier
attempt at this measurement was thrown away for a harness fault -- recipients
that had silently failed to deploy, and a poll that stopped on the sender's
balance dropping rather than the recipient's rising -- so the run above verifies
the payer answers a view call, verifies its funding by reading the balance back,
pays a known-good control first, and waits on the recipient only.

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

**`assign_to()` is the half that stops a wallet's credit from being stranded**,
and it replaced a worse answer to the same problem. `withdraw()` pays
`gl.message.sender_address`, so it can only ever deliver to a contract that calls
it itself. But four of the five parties this contract credits are ordinarily
wallets -- a provider taking back collateral, a client claiming forfeited
collateral, an attester reclaiming a bond, anyone refunded an overpayment -- and
a wallet calling `withdraw()` achieves nothing. Their entitlement was recorded
correctly, readable through `owed_to`, and permanently immobile.

The first fix for that was a `withdraw_to(recipient, ...)` which pushed the value
at an address the caller named. It is gone, and the reason is the table above: a
transfer that cannot be delivered is **not** refunded. Handing a wallet a method
that emits value at an unverifiable address replaced a stranded entitlement with
a destroyed one, which is worse — the money was at least still in the contract
before.

`assign_to(recipient)` moves the **entitlement** instead. It debits
`owed[caller]` and credits `owed[recipient]`, both pure storage, and the
contract's balance does not change; there is no transfer to fail. If the
recipient turns out to be unable to collect, the credit is still sitting under
its address, readable and assignable onward. Authorisation is preserved by
construction: the debited key is `gl.message.sender_address`, so naming a
recipient decides *where* an entitlement goes and never *whose* it is.

**The site carries this too, and did not before.** Every payout in the protocol
lands in `owed_to(you)`, and the app could open engagements, grade them and
settle them without ever showing a visitor the money. `/payouts` closes that: it
reads `owed_to`, `is_proven` and `liabilities` for the connected account, and
offers the two ways out with the difference stated rather than implied —
`assign_to` as the default, `withdraw` marked contracts-only, and
the withdraw button disabled with a reason whenever the connected address
has not proven it can receive — which a browser wallet never can. When the value has already left, the page says the reclaim will be
refused and why, instead of letting a visitor spend gas to find out.

**What that means for an integrator.** A party that expects to be paid has to
name something that can receive, and receiving means being a contract. It does
not have to *be* one: a wallet holds its entitlement and assigns it to a contract
with `assign_to`, which then calls `withdraw()` for itself. What no party can do
is take value at an externally owned address, on any network, because that is a
property of `emit_transfer` rather than of this contract.

**`withdraw()` refuses rather than guesses.** It emits value and cannot observe
whether the transfer arrived, so this contract does not try to find out
afterwards — it declines to emit at an address that has not proven it can
receive.

Two earlier designs tried to recover after the fact and both were wrong, which
is why the third does not attempt it. The first compared the contract's balance
to `total_owed + total_in_flight` and read a shortfall as proof the value had
left; the same balance also holds work collateral and locked bonds, so on a live
run it read balance 1.800 against obligations 2.795 and refused a resolution it
had no grounds to judge. The second used an exact `total_in - total_out` ledger,
which was sound only while every wei arrived through a counted method — a single
untracked transfer into the contract made a *delivered* payout look recoverable
and credited its owner a second time. Both were found by auditing the fix rather
than by a reviewer.

Delivery is not observable from inside the contract. So the question is removed
instead of answered:

* `prove_recipient()` emits a **zero-value** call back to the caller and records
  an outstanding probe. Nothing is at stake if it fails.
* `confirm_recipient()` is what the recipient calls from inside `credent_probe`.
  It requires an outstanding probe and consumes it, so a confirmation cannot be
  replayed and cannot arrive unrequested.
* `withdraw()` is refused unless the caller is proven, and takes **no arguments**
  — the previous `recipient_is_a_contract` was an assertion the caller made
  about itself that this contract could not check and that cost the entitlement
  when it was wrong.

**Two guards, and they are not equally strong.** The stronger one is stated
first, along with where it does not hold, because quoting only the strong half
is the mistake this section exists to correct.

`withdraw` and `confirm_recipient` both refuse a caller that is its own
transaction's entry point. Only an entry point can have an externally owned
account as `sender_address` — every deeper frame is one contract calling
another — so where `origin_address` really carries the initiator, `sender !=
origin` *proves* the caller is a contract. That is exactly the question the
payout turns on, and it is the question `withdraw(recipient_is_a_contract)` used
to ask the caller to answer about itself.

The field is not portable, which is the whole reason this is written as a
refusal and never consulted as a proof. Measured with a reporter contract called
once directly and once through a relay:

```text
studionet  direct   sender 0xaA34…02Bd   origin 0xaA34…02Bd      equal
           relayed  sender <relay>       origin 0xaA34…02Bd      differ
bradbury   direct   sender 0xaA34…02Bd   origin 0x9F6aa736…      differ
           direct   sender 0xaA34…02Bd   origin 0x2d012a29…      differ
           direct   sender 0xaA34…02Bd   origin 0xB93a46B8…      differ
```

On studionet the equality holds for a wallet and the check is exact: a wallet
cannot get past it at all. On bradbury every transaction reports a different
unrelated origin, so the equality never holds and the check cannot fire. Inert
is the right failure mode for a refusal — it never admits a caller that would
otherwise be rejected — but it means bradbury is guarded only by the second
thing.

**The probe is that second thing, and it is a bar rather than a proof.** A
wallet on bradbury can call `prove_recipient` and then `confirm_recipient`
directly, in two deliberate transactions, and mark itself proven; that was
tested against a throwaway deployment and it works. An address's code cannot be
inspected from inside a contract, anything the probe carries is public calldata
a wallet can read and repeat, and a view call into an address that turns out to
be a wallet takes the whole transaction down rather than raising something
catchable. Nothing available closes it there.

What the bar buys is the ordinary case: a recipient that answers the probe from
inside `credent_probe` has demonstrably executed code, so it is verified rather
than asserted, and getting it wrong takes two deliberate calls instead of one
wrong flag on the payout itself. A caller that lies spends only its own
entitlement. The path that carries no claim of any kind is `assign_to()`, which
moves the entitlement between storage slots, emits nothing, and cannot fail —
that is what a wallet should use, and the app offers it by default.

The settlement suite drives both cases on both networks, and prints which one it
got rather than asserting a guarantee the network does not provide.

`web/scripts/claimant.py` shows both halves; the probe answer is one statement.

**One operational difference worth knowing before you debug a refusal.**
Studio returns the contract's own reason on a rejected call — `[EXPECTED]
recipient_has_not_proven_it_can_receive` and the rest — and **bradbury does
not**. Its receipt carries `txExecutionResultName: "FINISHED_WITH_ERROR"` and
nothing else; the reason string is not in it anywhere. So the same refusal is
legible on one network and opaque on the other, through no fault of the caller.

That cost a test run: the settlement suite asserted the reason text on both, and
reported three failures on a run where the contract refused exactly as it
should. The suite now asserts the refusal everywhere and the reason only where
the network provides one, and the site says which case it is in rather than
showing a bare "rejected".

Proven on-chain rather than argued. The suite exercises the refusal, because a
guard that is never triggered is a comment:

```text
=== the payout guard ===
  ok   an ordinary wallet is not a proven recipient
  ok   withdraw from an unproven wallet is refused, not attempted
  ok   assigning to the zero address is refused
  ok   the claimant contract proved it can receive
  ok   a confirmation with no outstanding probe is refused
  ok   the refused confirmation left the wallet unproven
  ok   a wallet cannot answer its own probe on this network
```

That last line is studionet. The same step on bradbury prints this instead, and
the run still passes, because the suite records what the network does rather
than asserting a guarantee it does not provide:

```text
  a wallet answered its own probe and is_proven is now true.
  This network does not report origin_address as the transaction
  initiator, so the origin check cannot fire and the handshake is a
  bar rather than a proof here. Documented, not a regression -- and
  a wallet that does this spends only its own entitlement.
```

The last two lines are there because the handshake was decorative once.
`confirm_recipient` set `proven[sender]` without checking that a probe had ever
been issued, so any address could mark itself proven in a single direct call —
measured against a throwaway oracle, a wallet went from `false` to `true` that
way. `prove_recipient` now records an outstanding probe and `confirm_recipient`
requires and spends one, so a confirmation can neither arrive unrequested nor be
replayed. That still does not make the handshake a proof, and the section above
says so plainly; it makes it a bar that has to be cleared deliberately rather
than a flag anyone can set.

`web/scripts/claimant.py` is the reference: it accepts an engagement as the
provider (forwarding its own collateral, so the oracle sees the contract as the
provider), implements `__receive__`, answers the probe, and calls `withdraw`.
About a hundred lines of code, and rather more comment than that.

One snag worth knowing before you write your own: **`genvm-lint` rejects
`__receive__`.** E019 demands a `@gl.public.write` decorator on it and E106 then
refuses any public name beginning with `__`, so a recipient contract can be
lint-clean or receive value quietly, not both. Implement it anyway, for the
clean receipt -- but the value arrives either way, and that is measured rather
than reasoned:

```text
payer 0xC6078BAbe6C9a8AAb7682Cf0C6dc1685d99B6BEB   funded 0.050000 GEN
  working __receive__   0x1f7FB150fd9c9F4312af5EfC702ae60755dd49d4   -> 0.010000  credited
  __receive__ raises    0xDF69E01C58bd6430B104B256c07D2364187D4819   -> 0.010000  credited
  no __receive__        0x53507C4c26dAb57E8B8EB2b2739713997c7a8b61   -> 0.010000  credited
payer ends with 0.020000 GEN
```

Three transfers of 0.01 GEN, three arrivals, and the payer down exactly 0.03.
**Crediting and executing are separate outcomes**: a recipient without the
handler still receives, and one whose handler raises still receives. Without the
handler the inbound message leaves `ValueError: call to private method ...` in
its receipt, which reads exactly like a failed payout and is not one.

**This is the fact the payout design rests on, so it is worth stating as a
rule.** Set beside the wallet measurement above, the behaviour is exact:

| recipient | credited | sender debited |
|---|---|---|
| any contract — handler working, raising, or absent | **yes** | yes |
| externally owned account | **no** | yes |

So *being a contract* is the entire condition, and nothing about the recipient's
code can defeat it. That is why `withdraw` may clear the entitlement before it
emits: it emits only at an address established to be a contract, and every
contract is credited. There is no case where a proven recipient loses its
entitlement to a failed transfer.

**Item one is a view now, so it can be checked instead of read.** Validator
agreement runs inside `gl.vm.run_nondet`, which is only entered when two
validators genuinely produce different grades — nothing a caller can arrange. So
the rule that agreement must preserve the bond and collateral outcomes could be
read in the source and pinned by unit tests, and could not be exercised against
a deployment at all. `agreement_check` is a view that answers it directly, and
`npm run agreement` runs the interesting cases against every address in
`deployments.json`:

```text
studionet  0x10B19063c1F03E91103c6cb9E1845D66eeE08bC5
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

Ten and thirty are within the tolerance and on opposite sides of `slash_floor`:
by the arithmetic they agree, and one confiscates the attester's bond while the
other returns it. The control matters as much — two grades that differ and
settle identically still agree, because a rule that rejected those would fail
every honest round.

**Written against the official guidance, and checked with the official tool.**
`genlayerlabs/skills`' `write-contract` skill is the reference this contract is
held to, and `genvm-lint check` is step one of its testing strategy:

```text
✓ Lint passed (3 checks)
✓ Validation passed
  Contract: ReputationOracle
  Methods: 26 (15 view, 11 write)
```

The runner header is the exact hash that skill pins. Errors carry its four
prefixes and `[LLM_ERROR]` forces rotation rather than agreement. Storage is
`TreeMap`/`DynArray`/`u256` declared as class-level annotations, money is
atto-scale `u256`, and enums are stored as `str`. On the rule it calls most
important -- never validate the leader's output alone -- the validator re-runs
the prompt and compares the decision fields, which is the comparative form it
asks for.

One rule is deliberately not followed. The skill says never raise a bare
exception, because an unclassified fault forces validator rotation instead of an
agreed rejection. `parse_block_time` and `Policy.validate` still raise
`ValueError`. That is the point: they guard invariants that no caller can reach
-- every public method routes user input through `_fail`, and typed `u256`
parameters are rejected by the calldata decoder before the body runs -- so a
failure there is a bug in this contract, and rotation is the correct outcome for
a bug. `_fail` exists for the other case, and the distinction is the whole
reason both exist.

**Check the review's four items yourself, in one command.** `python
tools/audit_review.py` needs no key and no gas. It reads both *deployed*
contracts over `gen_getContractCode`, parses them, and checks each item against
the bytes that are live rather than the ones that are committed — the two have
come apart in this project before. It also checks the site carries the payout
flow and that the README names no contract method that does not exist, which is
what let a false claim about an error handler survive here.

```text
studionet  0x10B19063c1F03E91103c6cb9E1845D66eeE08bC5
  ok   agreement preserves the bond outcome
  ok   agreement preserves the collateral outcome
  ok   assign_to exists and emits no value
  ok   withdraw is the only method that emits value
  ok   withdraw refuses an unproven recipient
  ok   withdraw takes no caller-supplied claim
  ok   the probe carries no value
  ok   a confirmation must answer an outstanding probe
  ok   the probe is consumed by the confirmation
  ok   recipients are validated and classified
  ok   no balance-inference machinery remains
  ok   no __on_errored_message__ is claimed
  ok   the payout views exist
...
every item in the review is satisfied, on-chain and in the repository
```

Every check is structural and judged on code with docstrings stripped. That is
not fussiness: three guards in this repository have passed against a
deliberately broken contract because the term they searched for appeared in the
prose explaining the rule.

**Proven end to end, with balances, on both networks.** `npm run settlement`
runs release, claim, both refund paths and bond reclaim, asserting each
entitlement to the wei, and then withdraws twice: once as a contract collecting
its own credit, and once as a *wallet* moving its credit to a contract it names.
It passes on **studionet and on testnet-bradbury**, every check on both. The
*number* of checks moves a little between runs -- 33 on both of the runs quoted
below -- because engagement three's bond reclaim only
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
  ok   the claimant received the whole entitlement (+0.935 GEN)
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

assign_to + withdraw: the wallet takes out its refund and reclaimed bond
  contract  1.87 GEN -> 1.81 GEN  (-0.06 GEN)
  claimant  0 GEN    -> 0.06 GEN  (+0.06 GEN)
  owed_to   0.06 GEN -> 0 GEN
  ok   the claimant received the whole entitlement (+0.06 GEN)
  ok   the contract paid out exactly 0.06 GEN
  ok   the entitlement was zeroed
```

That bond was reclaimed in engagement two, by the client, whose account is an
ordinary wallet. Every run reaches it, and before `assign_to` nothing could
have moved it.

And the fourth engagement is the one that answers *whose* money can move. The
collateral is forfeited by the grade and claimed by the client -- an ordinary
wallet, not a contract -- which then assigns the entitlement to a contract that
collects it. Two calls, and the split is the safety property: the first moves no
value and so cannot fail, the second is made by the party that can actually
receive.

```text
claim_collateral: the client takes collateral the grade forfeited
  owed 0.875 GEN to client wallet 0xaA34e14a0e0B2fdD8Ad10F06bC0907fA0b1D02Bd
  ok   the entitlement rose by exactly 0.875 GEN
  ok   the entitlement moved to the contract (0.875 GEN)
  ok   the wallet's entitlement is spent, not duplicated

withdraw: the contract collects the collateral the wallet assigned it
  contract  0.885 GEN -> 0.01 GEN   (-0.875 GEN)
  claimant  0 GEN     -> 0.875 GEN  (+0.875 GEN)
  owed_to   0.875 GEN -> 0 GEN
  ok   the claimant received the whole entitlement (+0.875 GEN)
  ok   the contract paid out exactly 0.875 GEN
  ok   the entitlement was zeroed
```

Without `assign_to` that 0.875 GEN stays in the contract for good, and `owed_to`
reports it accurately forever. With the `withdraw_to` that preceded it, the
wallet could have destroyed it by naming an address that could not receive.

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
| Studionet | `0xEF9A5C49690479AC5e098e27D77ca4aD522d87f3` | `0x5d6df82bDd832f09b323256DD7dddC94265Ca324` | `0xAE17BdE91144eA7d4b8971463500DC7832118654` | `0xeCFd428341e91a285BD8414Afd65515e9A833cb6` |
| Testnet Bradbury | `0x75838Fe47B4e1f1FE1c0E9884302A8afa9e58b4F` | `0xD2dB78576a2CD9E44e60F957c49D4A435759A46E` | `0x1A5a50fBF5712255C5DAeC3aaE7E59EFC8Ca3F94` | `0xB9c5c79833fF657b80Ec6f0D10C2522c00bD6C55` |

The last two columns are the fourth engagement: the oracle whose forfeit
threshold is raised so `claim_collateral` is reachable, and the contract the
client's **wallet** assigned its claimed collateral to.


Both runs above end the same way, on the same code and the same artifacts that
are deployed:

```text
contract holds 1.81 GEN at the end

settlement ok - 39 checks, every payout reached its recipient   (studionet)
settlement ok - 38 checks, every payout reached its recipient   (bradbury)
```

The counts differ by the two checks in the third engagement's bond reclaim,
which the suite excludes when the attestation does not record inside
`ATTEST_TIMEOUT_MS` — it says so in the run rather than folding a timeout into a
payout assertion. The bond payout type is still covered in both runs: the client
reclaims one in engagement two and withdraws it through `assign_to`.

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
and 266 new parity vectors, and `genvm-lint` validates the rebuilt schema: 26
methods, 13 constructor parameters. The offline suite is 349 tests.

The payout leg works, and getting there was the most instructive part of this
build. An earlier revision pushed value directly at providers, clients and
attesters at the moment of settlement, and moved nothing: `emit_transfer` does
not credit an externally owned account, and every one of those parties is a
wallet. This paragraph used to say so and conclude the fix was upstream. It was
not.

`release_collateral`, `claim_collateral`, the acceptance refund and
`reclaim_bond` now credit an entitlement, which is pure storage and cannot fail,
and `withdraw()` moves the value in a separate call the recipient
makes. The *recipient* must be a contract, because that is the only kind of
address this runner credits — `web/scripts/claimant.py` is the
reference, about a hundred lines of code under twice as much comment. The *entitlement owner* need not be: a wallet holds its credit and
assigns it to a contract with `assign_to`, which is what stops the four
wallet-facing payouts from being recorded correctly and left immobile. Run
`npm run settlement` to watch a contract's balance fall by exactly what the
recipient's rises by, on both counts.

A note for anyone reading an older review of this repository. The answer to
"identify a target network where contract-to-wallet payouts complete" is that
there is not one among the networks this project targets, and there is not meant
to be. Stated precisely, because the earlier wording claimed more than had been
measured:

| Network | Chain | `on="accepted"` | `on="finalized"` |
|---|---|---|---|
| studionet | 61999 | EOA not credited; **the value left the sender** | EOA not credited; message never dispatched |
| testnet-bradbury | 4221 | EOA not credited | EOA not credited |
| testnet-asimov | 4221 | *the same chain as bradbury* | *the same chain as bradbury* |
| localnet | 61127 | not tested | not tested |

Re-measured on 29 August 2026 with an isolated two-method probe, separately from
this contract. `testnet-asimov` and `testnet-bradbury` are chain id 4221 under
two hostnames, not two chains, so there is one testnet here rather than two.
Localnet is a loopback node and was never exercised; nothing in this repository
depends on its behaviour, and a claim about it would be a guess.

The studionet `accepted` row is the sharpest version of the hazard: the sender's
balance fell by exactly the amount emitted while the recipient's did not rise, so
the value did not bounce, it simply did not arrive. It behaves that way whether
or not the sender implements `__on_errored_message__` -- the handler is not
called for this failure at all, which is why this contract does not rely on one.
Naming a network would have been
the wrong fix. The right one was to stop requiring a wallet to receive at all —
settlement credits, and value moves contract to contract, with `assign_to` as
the bridge that lets a wallet direct its own credit into one. That is proven
with balances on studionet **and** on testnet-bradbury, which is the closest
thing to "a target network where settlement completes" that this platform
currently permits.

It is **not** production infrastructure, for reasons mostly outside this
repository:

- **GenLayer has no mainnet.** The SDK ships localnet, studionet and two testnet
  entries -- `testnet-asimov` and `testnet-bradbury`, which are chain id 4221
  under two hostnames rather than two chains; `connect()` answers
  `mainnet is not available yet`. Nothing built
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
