# Running the lifecycle through the site

Copy-paste values for one full pass through `/attest`: open an engagement, accept
it under collateral, close it, and grade it. Everything below is a real,
self-consistent example — the scope, claim and evidence are written to be
gradeable, not to be filler.

Two of the steps move money. Accepting posts **collateral** priced by the
provider's own score, which is the mechanism the whole protocol is for;
attesting posts a **bond**, which prices the review rather than the work. Fund
both accounts accordingly before you start.

## Before you start

**You need two accounts.** This is not a convenience, it is the protocol: only
the *named provider* can accept an engagement, and the client cannot name
themselves. One wallet cannot complete the flow alone.

| | |
|---|---|
| **Account A** — the client | Opens the engagement. Attests about B. |
| **Account B** — the provider | Accepts. Is the subject of A's attestation. |

In MetaMask: **account menu → Add account** to create the second one. Fund both
from the Studio faucet. Note B's address before you start — you type it in step 1.

Both accounts must be on the network the site is built for — **testnet-asimov**
by default — and the masthead must show the connected address (not "Switch to
testnet-asimov"). If you point the build at studionet instead, every step below
still works except the ones that move money back; see *Where the money comes
back* below. Switching accounts in your wallet switches
who signs; the site follows it live, so you do not reload between steps.

## The table

Substitute your own values for the two placeholders: `0xBBBB…BBBB` is Account B's
address, and bump `001` in the engagement id on every run — **reused ids are
rejected** (`engagement_exists`).

| # | Card | Field | Value | Signed by |
|---|---|---|---|---|
| 1 | Open the engagement | Engagement id | `credent-demo-001` | **A** |
| 1 | | Provider address | `0xBBBB…BBBB` (Account B) | |
| 1 | | Value of the work | `10` | |
| 1 | | Scope | *see Scope below* | |
| 2 | Accept it, posting collateral | Engagement id | `credent-demo-001` | **B** |
| 3 | Close it | Engagement id | `credent-demo-001` | A **or** B |
| 4 | Attest | Engagement id | `credent-demo-001` | **A** |
| 4 | | Claim | *see Claim below* | |
| 4 | | Evidence | *see Evidence below* | |
| 5 | Reclaim the bond | Attestation id | the number step 4 returned (`0`, `1`, …) | **A** |
| 6 | Release the collateral | Engagement id | `credent-demo-001` | **B** |
| 7 | Claim forfeited collateral | Engagement id | *only if step 4 forfeited it* | **A** |

Steps 5, 6 and 7 return money, so they depend on the network: on testnet-asimov
they settle, on studionet they are recorded and the balance does not move. Step 5
additionally waits out the 14-day lock — see [The bond](#the-bond). Step 6 does
not, as soon as step 4 has graded the work: a clearing grade settles the
collateral immediately, and only an ungraded engagement waits.

Step 1's value is in GEN and is optional. Leaving it blank runs the same
lifecycle with the collateral layer switched off, which is what every pass
through this table did before the collateral existed. `10` is used here because
Account B then has to find **8.75 GEN** to accept — an agent with no history
posts 87.5% of the stake — which is enough to feel like collateral on a studio
account funded with a hundred.

### Scope

Pasted into step 1. Hashed on commit, so it cannot be changed afterwards; the
grader reads it as the standard the claim is measured against. Past 1200
characters it is truncated in the prompt rather than rejected — the contract only
refuses a scope that is empty or all whitespace.

```
Deliver a Python script that reads orders.csv (about 12,000 rows), removes
duplicate order ids keeping the most recent row by timestamp, and writes
orders_clean.csv sorted by order id. Runtime under 30 seconds on a laptop.
Include a one-page README covering how to run it and what it does with
malformed rows. Delivered by 2026-08-24.
```

### Claim

Pasted into step 4. What A says happened. Truncated in the prompt past 1500
characters.

```
The script was delivered on 2026-08-21, three days inside the deadline. It
processed all 12,047 rows in 8.4 seconds and removed 313 duplicate order ids,
keeping the latest timestamp in every case. The output was sorted by order id as
specified. The README covered how to run it and stated that rows with an
unparseable timestamp are dropped and logged, which the scope did not ask for.
```

### Evidence

Pasted into step 4. **This is the field that decides whether the bond survives.**
Truncated in the prompt past 6000 characters, four times the claim's allowance.

```
Commit 4f1c9ab in the delivered repository, timestamped 2026-08-21T14:02Z.
Runtime measured with `time python clean_orders.py`: real 0m8.412s against the
12,047-row file I supplied. Row counts: `wc -l orders.csv` gives 12048 including
the header, `wc -l orders_clean.csv` gives 11735 including the header, a
difference of 313 that matches the count in the script's own log line. The sort
was checked with `sort -t, -k1,1 -c orders_clean.csv`, which exited 0. The
dropped-row handling is at lines 41-48 of clean_orders.py and in the README's
"Assumptions" section.
```

Two grades come back, and they are independent. `fulfilled` reads the claim
against the scope; `substantiated` reads whether the evidence actually supports
the claim. Specific and checkable scores high on the second one — counts,
timings, commit hashes, commands and their exit codes. Praise scores low no
matter how warm, and **evidence that only restates the claim in other words
scores low too**. Below `substantiated = 20` the bond is slashed rather than
returned, which is the price on asserting without support.

Criticism is never what costs you the bond. A harsh claim carrying specific,
checkable detail is highly substantiated and comes back intact.

## Grading the other direction

Optional. B can grade A on the same closed engagement — one attestation per
attester per engagement, so B's is a separate one, and A's score gets its first
entry from it.

| # | Card | Field | Value | Signed by |
|---|---|---|---|---|
| 4 | Attest | Engagement id | `credent-demo-001` | **B** |
| 4 | | Claim | `The client supplied the 12,047-row orders.csv on 2026-08-18, the day after we agreed the scope, and answered both of my questions about malformed timestamps within three hours. Payment cleared 2026-08-22.` | |
| 4 | | Evidence | `Input file received 2026-08-18T09:14Z, sha256 e3b0c442...98fb (recorded in the delivery repo's data/README). My two questions and the client's replies are in the thread of 2026-08-18, timestamped 11:02Z and 14:20Z. The payment transaction is on the account history for 2026-08-22.` | |

## The collateral

Accepting is payable, and what it costs is decided by the accepting agent's own
score. The Accept card quotes the exact figure — **"Collateral required: … GEN"**
— along with the two numbers it came from: the rate, and the score that bought
it. **Trust that quote over anything written here**, and keep enough GEN to
cover it plus gas.

- **150%** of the declared value for an agent scoring zero, **87.5%** for one
  with no history at all, **25%** for a perfect record. Nobody works for free:
  the floor is what stops a bought reputation becoming unlimited leverage.
- Anything sent above the requirement is **returned in the same transaction**,
  so over-sending is safe.
- The score is read at the moment of accepting and frozen. A review that lands
  later cannot change what this job cost.

After step 4 the collateral is settled one way or the other:

| The client's attestation | What happens | Who calls it |
|---|---|---|
| Work delivered, or graded at or above 25% fulfilled | Released to the provider | **B**, step 6 |
| Undelivered *and* substantiated at ≥ 50 with confidence ≥ 50 | Forfeited to the client | **A**, step 7 |
| Nobody ever attests | Released to the provider after the 14-day lock | **B**, step 6 |

The middle row is the one to read twice. An accusation that carries no weight in
the score cannot take the collateral either — the evidence has to be good enough
to move the number before it can move the money. Writing "they delivered nothing"
with no evidence loses the *attester's* bond and leaves the provider's collateral
untouched.

### Where the money comes back

**On studionet it does not.** Step 6 is accepted by the contract, every validator
emits the transfer, and the balance does not move. A GenVM contract cannot pay an
externally owned account on this network: the emitted message is executed as a
contract call and finalizes with `Contract 0x… not found`, so the value stays
with the oracle. The site now says so above steps 5–7 when it is built against a
studio network, rather than reporting a success your balance contradicts.

**This is why the default network is testnet-asimov**, which is not a studio
network. To check settlement rather than take it on trust, run
`npm run settlement` from `web/` — it drives this whole table headlessly against
two funded accounts and asserts that each payout's triggered transaction
succeeded *and* that the recipient's balance went up. See the README's
**Settlement** section.

Every route a contract has was tried — both `emit_transfer` stages, `gl.Account`
and `gl.chain.Account` (neither exists on this runner), and the raw `PostMessage`
primitive with three different calldata shapes. All of them emit a *call*, and a
call against a wallet has no contract to run.

This is not about collateral specifically — step 5, reclaiming a *bond*, uses the
same SDK call and had the same problem; the 14-day lock is the only reason nobody
had hit it before. Everything that decides who is owed what is on chain and
correct either way. Only the transfer depends on the network applying it.

## The bond

Attesting is payable. The site quotes the exact figure in the Attest card as
**"Bond required: … GEN"**, read from the deployed contract at submit time —
**trust that number over anything written here**, and keep enough GEN to cover it
plus gas.

- The first attestation from one attester about one subject costs the deployment's
  `min_bond` — intended to be **1 GEN**.
- It **doubles** on every repeat about the same subject: 1, 2, 4, 8… while each
  repeat is worth *half* the last in the score. That opposition is the argument
  against buying reputation, and `/attack` plots it.
- The lock is **14 days**. Step 5 before then fails with `bond_still_locked`, so
  a same-day pass through this table stops at step 4. That is the contract
  working, not a bug.

The attestation id you need for step 5 is what step 4 returns — the site prints
it as *"Returned N"* beside the transaction link. It counts from `0` across the
whole contract, not per engagement.

## What you should see

| After | Where to look |
|---|---|
| Step 1 | `/agents` — nothing yet. A proposal cannot reach anyone's score. |
| Step 2 | Card 4's bond note stops saying "not been accepted by its provider", and 8.75 GEN has left Account B. |
| Step 3 | Card 4's bond note clears and the Post button enables. |
| Step 4 | `/agents` lists B with a score off 50. `/agents/<B>` shows the weight breakdown, and what that record now costs B to take on work. |
| Step 6 | The call is accepted and the transfer is emitted. On testnet-asimov the collateral lands back in B; on studionet it does not arrive. See the note below. |

Every card prints a **View transaction →** link to the explorer for whichever
network the build targets — `explorer-asimov.genlayer.com` by default,
`explorer-studio.genlayer.com` for a studionet build. Read the receipt, not just
the status: a GenLayer transaction reaches `ACCEPTED` when consensus agrees on
what happened — including when what happened is that the contract rejected your
call.

Step 4 is the slow one. It is a live LLM call settled by validator consensus, so
give it a moment; the button says *"Grading… this takes a moment"* because it
means it.

## When it refuses

Each of these is the contract enforcing the order, and each names its own remedy.

| Reason | What it means |
|---|---|
| `engagement_exists` | That id is taken. Bump the number. |
| `provider_is_client` | You named your own address as the provider. Use Account B. |
| `empty_scope` | The scope was blank or only whitespace. |
| `sender_not_provider` | Step 2 was signed by A. Only the named provider can accept. |
| `engagement_not_accepted` | Step 3 or 4 before step 2. A proposal is not work. |
| `engagement_not_closed` | Step 4 before step 3. |
| `sender_not_counterparty` | Signed by an account that is neither client nor provider. |
| `already_attested` | One attestation per attester per engagement. |
| `bond_below_required` | The quote went stale. Re-read the card and resubmit. |
| `bond_still_locked` | Step 5 inside the 14-day lock. |
| `bond_slashed` | The grade found the claim unsubstantiated. Nothing to reclaim. |
| `collateral_below_required` | Step 2 sent less than the quote. Re-read the card and resubmit. |
| `stake_out_of_range` | Step 1's value is too large for the contract to price. |
| `no_collateral_posted` | Nothing was posted, because the engagement declared no value. |
| `collateral_still_held` | Step 6 on an ungraded engagement, inside the 14-day lock. |
| `collateral_forfeited` | Step 6 after the grade forfeited it. It is the client's to claim. |
| `collateral_not_forfeited` | Step 7 where nothing was forfeited. |
| `collateral_already_settled` | The collateral has already been released or claimed. |
| `sender_not_client` | Step 7 signed by anyone but the client. |

## Reading it without a wallet

Nothing above is needed to *read* the registry. Every page renders from view
calls: `/agents` for the registry, `/agents/<address>` for one agent's weight
breakdown, `/lab` and `/attack` for the arithmetic, `/scope` to preview a scope
digest before committing it in step 1.
