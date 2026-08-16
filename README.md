# Credent

Reputation as collateral for autonomous agents.

An agent's counterparties write attestations about completed work. A GenLayer
intelligent contract grades each one with an LLM **in consensus** — several
validators run the same prompt and must agree — and aggregates the graded
outcomes into a score. The score decides how much collateral the agent has to
post up front. Nobody is asked to trust a self-report, and nobody has to trust a
single model call either.

Deployed on GenLayer Studio at `0x7D72e67bdCCb542a669f3C18055e04D295Dbf6f7`,
inspectable through the [GenLayer explorer](https://genlayer-explorer.vercel.app/).

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
mean two copies of arithmetic that 277 tests are pinned to, and the copy that
drifts is always the one nobody runs. So `build_contract.py` inlines the engine
verbatim — byte for byte, nothing reformatted — and `test_build_contract.py`
fails the suite if the checked-in artifact is stale.

The site ports the same arithmetic to TypeScript, because it explains *how* each
weight was reached and the contract only returns the result. That port is pinned
to the engine by 3155 generated parity vectors across 9 families. If the two ever
disagree, `npm run parity` fails the build.

## Running it

```bash
pip install -r requirements-dev.txt
python -m pytest                 # 277 tests: engine, prompts, contract, parity vectors
python build_contract.py         # regenerate reputation_oracle.py after any engine change

cd web
npm ci
cp .env.example .env.local       # then set the contract address
npm run dev
npm run parity                   # the TS port still agrees with the Python engine
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
genlayer deploy --contract reputation_oracle.py
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

### Two things that will waste your afternoon

Both cost a day to find, so they are written down.

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

A corollary for clients: an address argument is its own calldata type. Passing
the hex string encodes a `str`, the contract refuses it while unpacking
arguments, and the node answers with `execution failed` naming nothing. See
`addressArg` in `web/src/chain/oracle.ts`.

## Status

Working and verified end to end: the contract deploys and executes, all seven
views read, the full `open → close → attest → reclaim` lifecycle runs, and the
site renders every route, reads the live contract, and submits correctly formed
transactions from a connected wallet.

It is **not** production infrastructure, for reasons mostly outside this
repository:

- **GenLayer has no mainnet.** The SDK ships localnet, studionet and two
  testnets; `connect()` answers `mainnet is not available yet`. Nothing built
  here can hold real value today.
- **Studio is a shared sandbox.** Its state can be reset, and its public RPC
  allows 30 requests per minute.
- **The registry does not scale on that budget.** Loading it costs
  `2 + N + E + S` calls — policy, count, one per attestation, one per
  engagement, one per subject — so it starts failing at roughly a dozen
  attestations. Past that it wants an indexer, which is the natural next piece
  of work.
- The write path has not yet been signed by a real browser wallet; it has been
  driven end to end through an EIP-1193 provider backed by a local key.
