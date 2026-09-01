"""Guards on the generated contract.

`reputation_oracle.py` is the file that deploys, and it is a copy of three other
files. Copies drift. These tests are what make the copy safe to rely on: they
fail the suite the moment the artifact stops matching its sources, so a change to
the engine cannot reach a validator in one form and the test suite in another.

The GenLayer SDK is not installable from PyPI - it ships inside the GenVM runner
- so `reputation_oracle.py` cannot be imported or executed here. Nothing below
claims otherwise. What is checkable is that the file parses, that its structure
is what the runner expects, and that the arithmetic inside it is the same
arithmetic `test_reputation_core.py` exercises.
"""

from __future__ import annotations

import ast
import itertools
import json
import re
import shutil
import subprocess
import sysconfig
from pathlib import Path

import pytest

import build_contract
from reputation_core import RECIPIENT_MARKER, RECIPIENT_MARKER_METHOD

ROOT = Path(__file__).resolve().parent
ARTIFACT = ROOT / "reputation_oracle.py"

# The deployed contract class. Not `Contract`: `genvm-lint`'s module scan skips
# that name, because `from genlayer import *` binds the SDK base class to it.
CONTRACT_CLASS = "ReputationOracle"

# The contract's whole call surface. Kept here rather than inline because two
# tests need it: one reads the decorators out of the source, the other counts the
# methods the SDK's own ABI reflection can see. Those disagreeing is the bug.
EXPECTED_PUBLIC_METHODS = frozenset(
    {
        "open_engagement",
        "accept_engagement",
        "close_engagement",
        "attest",
        "reclaim_bond",
        "release_collateral",
        "claim_collateral",
        "get_report",
        "get_attestation",
        "get_attestations",
        "get_reports",
        "get_subject_attestations",
        "get_subject_page",
        "get_engagement",
        "get_policy",
        "attestation_count",
        "bond_for_next",
        "collateral_quote",
        # Settlement credits an entitlement. `withdraw` is the only method that
        # emits value, and it is for a contract collecting its own credit.
        # `assign_to` is how anyone else moves an entitlement: it rewrites two
        # storage slots and pushes nothing, so it cannot destroy money the way a
        # transfer to an unverifiable address can. `resolve_in_flight` takes back
        # an entitlement whose payout never left, and refuses when the value did.
        "withdraw",
        "assign_to",
        "agreement_check",
        "reclaim",
        "withdrawal_of",
        "in_flight_to",
        "prove_recipient",
        "confirm_recipient",
        "is_proven",
        "owed_to",
        "liabilities",
    }
)


def _find_genvm_lint() -> str | None:
    """Locate the linter, on PATH or beside the interpreter running the tests.

    `pip install genvm-linter` drops the executable in the interpreter's own
    scripts directory, which is on PATH in an activated virtualenv and routinely
    is not otherwise - a bare `shutil.which` turns "installed but not on PATH"
    into a silent skip, which is the same shape of hole this test exists to
    close.
    """
    if found := shutil.which("genvm-lint"):
        return found
    scripts = Path(sysconfig.get_path("scripts"))
    for name in ("genvm-lint", "genvm-lint.exe"):
        if (candidate := scripts / name).is_file():
            return str(candidate)
    return None


@pytest.fixture(scope="module")
def artifact_source() -> str:
    if not ARTIFACT.exists():
        pytest.fail("reputation_oracle.py is missing - run `python build_contract.py`")
    return ARTIFACT.read_text(encoding="utf-8")


def test_artifact_matches_its_sources(artifact_source: str) -> None:
    """The checked-in contract is what the current sources generate."""
    assert artifact_source == build_contract.render(), (
        "reputation_oracle.py is stale. Run `python build_contract.py` and commit "
        "the result."
    )


def test_artifact_parses(artifact_source: str) -> None:
    """Syntax only. This is not evidence the contract deploys or runs."""
    ast.parse(artifact_source)


def test_runner_pin_is_the_first_line(artifact_source: str) -> None:
    """The runner directive only counts if it is line one.

    GenLayer reads the dependency comment from the top of the file. A banner
    line accidentally sorted above it would strip the contract of its runtime.
    """
    first = artifact_source.splitlines()[0]
    assert first.startswith('# { "Depends": "py-genlayer:')
    assert build_contract.RUNNER in first


def test_runner_directive_is_alone_in_the_leading_comment_block(
    artifact_source: str,
) -> None:
    """Nothing may share the comment block the runner directive sits in.

    GenVM parses the contiguous run of comment lines at the top of the file as
    its runner configuration, as JSON, line by line. The `Depends` directive is
    the only JSON the contract has, so a banner line touching it makes the block
    unparseable and the node rejects the deployment with
    `contract_error: invalid_contract`.

    Nothing else in this suite sees that. `genvm-lint` does not model the header
    block, so the artifact validates and extracts a full schema with the banner
    in either position, and the CLI prints "Contract deployed successfully"
    because consensus accepted the *transaction* - the execution error is inside
    the receipt, and every read of the address afterwards returns
    `Contract ... not found`.

    Verified against studionet in both directions: a banner on line 2 is
    rejected, the same file with a blank line on line 2 deploys and reads back.
    """
    lines = artifact_source.splitlines()
    block = list(itertools.takewhile(lambda line: line.startswith("#"), lines))
    assert len(block) == 1, (
        "the runner directive must be the only line in the leading comment "
        f"block; found {len(block)} comment lines before the first break: "
        f"{block[1:]}. Put a blank line under the directive - the banner reads "
        "the same and GenVM stops parsing at the break."
    )


def test_runner_pin_is_a_version_hash_not_an_alias() -> None:
    """`py-genlayer:test` and `:latest` are rejected by every GenLayer network."""
    _, _, version = build_contract.RUNNER.partition(":")
    assert version not in ("", "test", "latest")
    assert len(version) == 52 and version.isalnum(), (
        f"expected a 52-character runner hash, got {version!r}"
    )


def test_runner_pin_resolves_to_a_runner_that_exists() -> None:
    """The pin must name a runner that can actually be loaded.

    This is the check whose absence let a hash nobody could resolve sit in this
    file through a fully green suite. `genvm-lint validate` fails on an
    unresolvable pin with `Failed to load SDK`, but nothing here noticed, because
    every other test only ever asked whether the *string* was in the right place.

    The GenVM artifact cache is the local source of truth. It is not present on
    every machine, so this skips rather than fails when there is nothing to check
    against -- an absent cache is no evidence either way, and a test that failed
    on a fresh checkout would just get deleted.
    """
    cache = Path.home() / ".cache" / "genvm-linter" / "extracted"
    if not cache.is_dir():
        pytest.skip("no local genvm-linter artifact cache to resolve the pin against")

    _, _, version = build_contract.RUNNER.partition(":")
    available = {
        path.name
        for extracted in cache.iterdir()
        for path in (extracted / "py-genlayer").glob("*")
        if path.is_dir()
    }
    if not available:
        pytest.skip("artifact cache holds no py-genlayer runners")

    assert version in available, (
        f"runner {version} is not in the local cache. Available: {sorted(available)}. "
        "A pin that resolves nowhere cannot deploy; check it against the extracted "
        "SDK rather than against the published API reference."
    )


def test_genvm_lint_validates_the_artifact_and_extracts_a_full_schema() -> None:
    """The one check that reflects over the contract the way the runner does.

    Everything else in this file reads the artifact as text. That is why two real
    defects survived a green suite: a contract class named `Contract`, which the
    linter's module scan skips because `from genlayer import *` binds the SDK
    base class to that name, and a hoisted `__future__` import, which turns every
    annotation into a string the ABI reflector will not accept. Both deploy.
    Neither is visible without loading the file against the SDK.

    `genvm-lint` is a dev dependency rather than a guaranteed one, so this skips
    where it is absent - a missing linter is no evidence either way.
    """
    if (executable := _find_genvm_lint()) is None:
        pytest.skip("genvm-lint is not installed")

    proc = subprocess.run(
        [executable, "check", str(ARTIFACT), "--json"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        cwd=ROOT,
    )
    # `check` prints one JSON object on the last non-empty line of stdout.
    lines = [line for line in proc.stdout.splitlines() if line.strip()]
    if not lines:
        pytest.skip(f"genvm-lint produced no output (exit {proc.returncode})")
    report = json.loads(lines[-1])

    assert report["ok"], f"genvm-lint rejected the contract: {report}"
    assert report["validate"]["contract"] == CONTRACT_CLASS

    # The schema is the ABI a client reads to learn what it can call. A missing
    # or partial one is the symptom both defects above produced.
    assert report["validate"]["methods"] == len(EXPECTED_PUBLIC_METHODS)
    assert report["validate"]["ctor_params"] == 14, "the fourteen policy parameters"


def test_the_artifact_has_no_future_import(artifact_source: str) -> None:
    """Postponed annotations destroy the contract's ABI schema.

    The GenVM standard library reflects over signatures with `inspect.signature`
    and no `eval_str=True`, so under `from __future__ import annotations` it sees
    the string `'u256'` where a type belongs and refuses to build a schema. The
    contract still imports, still generates its storage layout, and still
    deploys - it just has no callable surface any client can discover. This is
    the failure that a green suite and a passing `genvm-lint lint` both miss.
    """
    assert build_contract.FUTURE_IMPORT not in artifact_source
    tree = ast.parse(artifact_source)
    assert ast.get_docstring(tree), "generated contract lost its module docstring"


@pytest.mark.parametrize("module", ["reputation_core.py", "reputation_prompts.py"])
def test_engine_is_inlined_verbatim(artifact_source: str, module: str) -> None:
    """Every engine line survives the splice unchanged.

    The point of the generator is that it copies rather than rewrites. A codegen
    step that reformatted consensus arithmetic would be a consensus bug, so this
    checks the strong property - each source line is present verbatim - rather
    than merely that the file got longer.
    """
    source = (ROOT / module).read_text(encoding="utf-8")
    for line in source.splitlines():
        if line.rstrip() == build_contract.FUTURE_IMPORT:
            continue  # hoisted by design
        assert line in artifact_source, f"{module}: line lost or altered in the splice: {line!r}"


def test_contract_class_is_present(artifact_source: str) -> None:
    """The runner looks for a contract class; the engine classes are not it."""
    tree = ast.parse(artifact_source)
    classes = {node.name for node in tree.body if isinstance(node, ast.ClassDef)}
    assert CONTRACT_CLASS in classes
    # The engine's dataclasses have to come along, since the contract calls them.
    assert {"Policy", "Report"} <= classes


def test_contract_class_is_not_named_contract(artifact_source: str) -> None:
    """A contract class called `Contract` is invisible to the offline toolchain.

    It deploys - the runner registers the class through `__init_subclass__` and
    never looks at its name - which is what makes this worth pinning. Every tool
    that reads the file instead of running it has to *find* the class by scanning
    the module, and `from genlayer import *` binds the SDK base class to the name
    `Contract` in that same namespace. `genvm-lint` resolves the ambiguity by
    skipping the name entirely, so a contract named `Contract` lints clean, fails
    validation with "No contract class found", and yields no ABI schema.
    """
    tree = ast.parse(artifact_source)
    subclasses = [
        node.name
        for node in tree.body
        if isinstance(node, ast.ClassDef)
        and any("gl.Contract" == ast.unparse(base) for base in node.bases)
    ]
    assert subclasses == [CONTRACT_CLASS], (
        f"expected exactly one gl.Contract subclass named {CONTRACT_CLASS}, got {subclasses}"
    )


def test_public_surface_is_decorated(artifact_source: str) -> None:
    """Every public method carries a `gl.public.*` decorator.

    An undecorated method is unreachable from outside the contract. That failure
    is invisible until someone tries to call it against a live deployment, which
    is exactly the kind of thing worth catching in a suite that cannot run the
    contract itself.
    """
    tree = ast.parse(artifact_source)
    contract = next(
        node
        for node in tree.body
        if isinstance(node, ast.ClassDef) and node.name == CONTRACT_CLASS
    )
    decorated = set()
    for node in contract.body:
        if not isinstance(node, ast.FunctionDef):
            continue
        for decorator in node.decorator_list:
            if "gl.public" in ast.unparse(decorator):
                decorated.add(node.name)
    assert EXPECTED_PUBLIC_METHODS <= decorated, (
        f"undecorated or missing: {sorted(EXPECTED_PUBLIC_METHODS - decorated)}"
    )


def test_int_aliases_are_not_called(artifact_source: str) -> None:
    """`u256(0)` is a v0.2 idiom and a TypeError on the v0.3 runner.

    The integer aliases stopped being `typing.NewType` instances and became
    `typing.Annotated[int, ...]`, which are valid annotations and not callables.
    The wrapping still reads as correct and still parses, so nothing catches it
    before the contract is live.
    """
    tree = ast.parse(artifact_source)
    aliases = {f"u{n}" for n in (8, 16, 32, 64, 128, 256)}
    aliases |= {f"i{n}" for n in (8, 16, 32, 64, 128, 256)}
    called = {
        node.func.id
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id in aliases
    }
    assert not called, f"integer aliases are not callable on this runner: {sorted(called)}"


def test_no_float_arithmetic_in_the_contract_layer(artifact_source: str) -> None:
    """No float literals anywhere in the deployed file.

    The engine bans them because two validators that disagree in the last bit
    turn a rounding artifact into a failed block. The contract layer inherits the
    same ban, and the artifact is where it actually has to hold.
    """
    tree = ast.parse(artifact_source)
    offenders = [
        node.value
        for node in ast.walk(tree)
        if isinstance(node, ast.Constant) and isinstance(node.value, float)
    ]
    assert not offenders, f"float literals in the deployed contract: {offenders}"


def test_entitlement_keys_go_through_the_lowercasing_helper(artifact_source: str) -> None:
    """`owed` is keyed consistently, or `owed_to` reports zero forever.

    `Address.as_hex` returns the **EIP-55 checksummed** form -- mixed case
    derived from a keccak hash of the digits. Crediting an entitlement under
    `as_hex` while reading it back under a lowercased string is two keys for one
    address, and it fails in the worst way available: `withdraw` still works,
    because it derives the key the same way on both sides, so the money is
    recoverable and only the balance *enquiry* is broken. Every `owed_to` call
    returns 0 and nothing looks wrong until someone asks what they are owed.

    That shipped once and cost a settlement run to find. The rule is therefore
    structural rather than about one expression: **any function that touches
    `self.owed` must build its key with `_owed_key`, and must not reach for a
    bare `as_hex` of its own.**
    """
    tree = ast.parse(artifact_source)

    def touches_owed(fn: ast.FunctionDef) -> bool:
        for node in ast.walk(fn):
            if (
                isinstance(node, ast.Attribute)
                and node.attr == "owed"
                and isinstance(node.value, ast.Name)
                and node.value.id == "self"
            ):
                return True
        return False

    offenders = []
    for fn in ast.walk(tree):
        if not isinstance(fn, ast.FunctionDef) or not touches_owed(fn):
            continue
        body = _code_of(fn)
        # `owed_to` takes a string from a caller and lowercases it directly;
        # it has no Address to run through the helper.
        if fn.name == "owed_to":
            if ".lower()" not in body:
                offenders.append(f"{fn.name} does not lowercase its key")
            continue
        if "_owed_key(" not in body:
            offenders.append(f"{fn.name} keys `owed` without _owed_key")
        bare = [
            ast.unparse(node)
            for node in ast.walk(fn)
            if isinstance(node, ast.Attribute) and node.attr == "as_hex"
        ]
        if bare:
            offenders.append(f"{fn.name} uses a bare as_hex: {bare}")

    assert not offenders, "entitlement keys are not canonicalized: " + "; ".join(offenders)


def test_owed_key_helper_lowercases(artifact_source: str) -> None:
    """The helper the test above points at actually does the lowering."""
    tree = ast.parse(artifact_source)
    helper = next(
        (
            node
            for node in ast.walk(tree)
            if isinstance(node, ast.FunctionDef) and node.name == "_owed_key"
        ),
        None,
    )
    assert helper is not None, "_owed_key is missing from the artifact"
    body = ast.unparse(helper)
    assert ".lower()" in body, f"_owed_key does not lowercase: {body}"


def _code_of(fn: ast.FunctionDef) -> str:
    """The function's code with its docstring removed.

    Structural checks that search `ast.unparse(fn)` match the prose as readily
    as the code, and a docstring that explains a rule mentions every term the
    rule is about. Two guards in this file passed against a deliberately broken
    contract for exactly that reason. Stripping the docstring first is what
    makes them tests rather than spell-checks.
    """
    body = fn.body
    if (
        body
        and isinstance(body[0], ast.Expr)
        and isinstance(body[0].value, ast.Constant)
        and isinstance(body[0].value.value, str)
    ):
        body = body[1:]
    return "\n".join(ast.unparse(node) for node in body)


def test_every_credited_party_can_move_its_credit(artifact_source: str) -> None:
    """A wallet's entitlement must be movable, and moving it must not risk it.

    `withdraw` pays `gl.message.sender_address`, so only a contract collecting
    its own credit can use it. Every other party this contract credits may be an
    ordinary wallet -- a provider taking back collateral, a client claiming
    forfeited collateral, an attester reclaiming a bond, anyone refunded an
    overpayment -- and `emit_transfer` does not credit an externally owned
    account.

    The first version of this fix let a wallet name a recipient and pushed the
    value there. That was wrong in a way worth stating: a transfer to an address
    that cannot receive is not refunded. Measured on studionet, an
    `on="accepted"` transfer to a wallet left the sending contract's balance,
    arrived nowhere, and `__on_errored_message__` never fired. A method that
    pushes value at an address it cannot verify can therefore destroy money.

    `assign_to` moves the entitlement instead of the value. Asserted here as a
    property rather than by name:

    1. it exists and is a public write;
    2. it debits the **caller's** key, so a caller can only move its own credit;
    3. it emits nothing at all -- the whole point, and the one line that would
       silently reintroduce the hazard if it were added back.
    """
    tree = ast.parse(artifact_source)
    fns = {
        node.name: node
        for node in ast.walk(tree)
        if isinstance(node, ast.FunctionDef)
    }

    assert "assign_to" in fns, (
        "assign_to is missing: every wallet this contract credits would be "
        "unable to move its entitlement without risking it on a push transfer"
    )
    fn = fns["assign_to"]

    decorators = {ast.unparse(d) for d in fn.decorator_list}
    assert "gl.public.write" in decorators, (
        f"assign_to must be a public write, got {decorators}"
    )

    body = _code_of(fn)
    assert "gl.message.sender_address" in body, (
        "assign_to must debit the caller, or it would let one account move "
        "another's entitlement"
    )

    emits = [
        node
        for node in ast.walk(fn)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr in ("emit_transfer", "emit")
    ]
    assert not emits, (
        "assign_to pushes value; it must only rewrite storage. A transfer to an "
        "address this contract cannot verify is not recoverable if it fails."
    )


def test_value_is_never_emitted_at_an_unproven_recipient(artifact_source: str) -> None:
    """`withdraw` must decline rather than guess, and there is nothing to guess.

    `emit_transfer` does not credit an externally owned account and does not
    refund what it fails to deliver. Two earlier designs tried to survive that
    after the fact and both were wrong: one compared the balance to obligations,
    ignoring that the same balance holds collateral and bonds; the other used a
    `total_in - total_out` ledger that a single untracked transfer into this
    contract silently broke, crediting a delivered payout a second time.

    Delivery is not observable from inside the contract, so this design does not
    observe it. It refuses to emit at an address that has not run code to prove
    it can receive. The property asserted here:

    1. `withdraw` takes no caller-supplied claim about the recipient -- the
       previous `recipient_is_a_contract` was an assertion the contract could
       not check and that cost the entitlement when it was wrong;
    2. it consults `self.proven` before emitting;
    3. it clears the entitlement before the transfer, so a proven recipient
       cannot withdraw twice;
    4. the probe carries **no value**, so a failed proof costs nothing;
    5. a confirmation answers an outstanding probe and spends it, so it can
       neither arrive unrequested nor be replayed. This is a bar, not a
       proof of contract-hood -- see `confirm_recipient`, which says so --
       and the guard exists to keep the bar from quietly disappearing.
    """
    tree = ast.parse(artifact_source)
    fns = {
        node.name: node
        for node in ast.walk(tree)
        if isinstance(node, ast.FunctionDef)
    }

    for name in ("withdraw", "prove_recipient", "confirm_recipient"):
        assert name in fns, f"{name} is missing"

    withdraw = fns["withdraw"]
    args = [a.arg for a in withdraw.args.args if a.arg != "self"]
    assert args == [], (
        f"withdraw still takes {args}; a caller's claim about its own address is "
        "exactly what this design removes"
    )

    code = _code_of(withdraw)
    assert "self.proven" in code, (
        "withdraw does not check that the recipient proved it can receive"
    )
    zeroed = code.index("self.owed[key] = 0")
    emitted = code.index("emit_transfer")
    assert zeroed < emitted, "withdraw must clear the entitlement before emitting"

    # The handshake moves no value, and that is the correction. An earlier
    # build had `prove_recipient` emit a real transfer debited from the caller's
    # own entitlement so the confirmation could see the recipient's balance
    # rise. It cleared owed value and then emitted -- the exact shape of the
    # defect this rework removes -- to re-confirm a platform property already
    # measured. `credent_recipient()` is the guard; the handshake is an opt-in.
    probe = _code_of(fns["prove_recipient"])
    assert "emit_transfer" not in probe, (
        "prove_recipient emits value again; a handshake that moves money can "
        "lose money, and it buys nothing _require_recipient_contract has not "
        "already established"
    )
    assert "self.owed[" not in probe, (
        "prove_recipient touches the entitlement; the handshake must not be able "
        "to reduce what a recipient is owed"
    )
    assert "self.probing[key] = True" in probe, (
        "prove_recipient must record the open handshake, or confirm_recipient "
        "has nothing to check against"
    )

    # A confirmation must answer a probe this contract actually issued, and must
    # spend it. Without both halves an unrequested confirmation is accepted, and
    # one confirmation can be replayed forever.
    confirm = _code_of(fns["confirm_recipient"])
    assert "self.probing" in confirm, (
        "confirm_recipient does not require an outstanding probe; it would accept "
        "a confirmation that answers nothing"
    )
    assert "REASON_NO_PROBE_OUTSTANDING" in confirm, (
        "an unrequested confirmation must be a classified refusal, not a bare "
        "exception that rotates validators"
    )
    assert ".balance" not in confirm, (
        "confirm_recipient reads a balance again; what makes a caller eligible is "
        "_require_recipient_contract, not a figure it could be handed"
    )
    assert "self.probing[key] = False" in confirm, (
        "confirm_recipient does not consume the probe; the confirmation is replayable"
    )
    set_true = confirm.index("self.proven[key] = True")
    consumed = confirm.index("self.probing[key] = False")
    assert consumed < set_true, "the probe must be spent before the proof is recorded"

    # The one check that is a proof rather than a bar, where the network reports
    # `origin_address` faithfully: only a transaction's entry point can have a
    # wallet as its sender, so `sender != origin` means the caller is a
    # contract. It must guard both the call that records eligibility and the
    # call that spends the entitlement -- the second because nothing downstream
    # should have to trust that the first ran.
    assert "_refuse_the_transaction_origin" in fns, (
        "the origin refusal helper is gone; the handshake is the only guard left"
    )
    helper = _code_of(fns["_refuse_the_transaction_origin"])
    assert "sender_address" in helper and "origin_address" in helper, (
        "the origin refusal does not compare the sender against the origin"
    )
    assert "REASON_CALLER_IS_ORIGIN" in helper, (
        "the origin refusal is not a classified rejection"
    )
    for guarded in ("confirm_recipient", "withdraw"):
        assert "_refuse_the_transaction_origin()" in _code_of(fns[guarded]), (
            f"{guarded} does not refuse the transaction's own entry point"
        )


def test_recipients_and_entitlements_are_validated(artifact_source: str) -> None:
    """A malformed or zero recipient must be a classified refusal.

    `Address(...)` raises on anything malformed, and a bare exception is an
    *unclassified* fault: validators rotate instead of agreeing on a rejection,
    so a caller's typo becomes a consensus event. The zero address is worse than
    an error -- the chain accepts it and the entitlement can never be withdrawn
    again.
    """
    tree = ast.parse(artifact_source)
    fns = {
        node.name: node
        for node in ast.walk(tree)
        if isinstance(node, ast.FunctionDef)
    }
    assert "_clean_recipient" in fns, "no validating helper for payout recipients"

    helper = _code_of(fns["_clean_recipient"])
    assert "REASON_BAD_RECIPIENT" in helper, "malformed addresses are not classified"
    assert "REASON_ZERO_RECIPIENT" in helper, "the zero address is not refused"

    # Every method taking a recipient must go through it rather than calling
    # `Address(...)` raw.
    assign = _code_of(fns["assign_to"])
    assert "_clean_recipient(" in assign, "assign_to does not validate its recipient"
    assert "Address(recipient)" not in assign, (
        "assign_to still constructs an Address directly, which raises unclassified"
    )


def test_the_readme_states_the_real_test_count(request: pytest.FixtureRequest) -> None:
    """The README's test count must be the number of tests that actually run.

    A small thing that goes stale silently: the count sat at 337 for three
    rounds of new tests, so the one number a reader can check without running
    anything was the one number that was wrong. Every other claim in that file
    is now guarded by something; this closes the last unguarded one.

    `testscollected` is the whole session, so this is only meaningful on a full
    run -- a subset is skipped rather than failed, because failing `pytest
    test_build_contract.py` for saying so would be useless noise.
    """
    collected = request.session.testscollected
    full_suite = collected > 100
    if not full_suite:
        pytest.skip(f"only {collected} tests collected; run the whole suite")

    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    stated = {int(n) for n in re.findall(r"(\d+) tests", readme)}
    assert stated, "the README no longer states a test count"
    assert stated == {collected}, (
        f"the README says {sorted(stated)} tests and the suite collects {collected}"
    )


def test_the_agreement_view_delegates_to_the_consensus_rule(artifact_source: str) -> None:
    """`agreement_check` must answer with the rule the contract actually uses.

    The view exists so the review's first item can be exercised against a
    deployment rather than read in the source: the real comparison runs inside
    `gl.vm.run_nondet` and is only reached when two validators genuinely
    disagree, which a caller cannot arrange.

    That makes it evidence, and evidence has to be wired to the thing it is
    evidence about. A view that reimplemented the comparison would be worse than
    no view at all -- it would agree with the tests, disagree with the contract,
    and read as proof either way. So it must call `grades_agree`,
    `bond_outcome` and `collateral_outcome`, and it must read the deployed
    policy rather than take one from the caller.
    """
    tree = ast.parse(artifact_source)
    fns = {
        node.name: node
        for node in ast.walk(tree)
        if isinstance(node, ast.FunctionDef)
    }
    assert "agreement_check" in fns, "the agreement rule is not checkable from outside"

    code = _code_of(fns["agreement_check"])
    for call in ("grades_agree(", "bond_outcome(", "collateral_outcome("):
        assert call in code, (
            f"agreement_check does not call {call.rstrip('(')}; a view that "
            "reimplements the rule is evidence for the wrong thing"
        )
    assert "self._policy()" in code, (
        "agreement_check must answer against the deployed policy, not a supplied one"
    )

    args = [a.arg for a in fns["agreement_check"].args.args if a.arg != "self"]
    assert args == ["mine", "theirs"], f"unexpected signature: {args}"

    # A view: it must not write. `gl.public.view` is checked by the schema test;
    # this checks the body cannot have grown a side effect.
    assert "self." not in code.replace("self._policy()", ""), (
        "agreement_check touches storage; it is meant to decide nothing and store nothing"
    )


def test_a_failed_transfer_leaves_the_entitlement_recoverable(artifact_source: str) -> None:
    """The review's item, as a structural guarantee about the wiring.

    The *decision* is `resolve_withdrawal` in `reputation_core`, where
    `TestResolveWithdrawal` drives every branch with real numbers. What this
    checks is that the contract is wired to it: that `withdraw` parks the
    entitlement instead of dropping it, records when it did so, and that
    `reclaim` reads both and can put the claim back.

    Kept separate on purpose. A structural test cannot tell you the arithmetic
    is right, and an arithmetic test cannot tell you the contract calls it.
    """
    tree = ast.parse(artifact_source)
    fns = {n.name: n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef)}

    withdraw = _code_of(fns["withdraw"])
    assert "self.in_flight[key] = amount" in withdraw, (
        "withdraw discards the entitlement instead of parking it; a failed "
        "transfer would leave nothing to recover"
    )
    assert "self.in_flight_at[key] = opened_at" in withdraw, (
        "withdraw records no timestamp, so reclaim cannot tell a transfer that "
        "failed from one that has not landed yet"
    )
    parked = withdraw.index("self.in_flight[key] = amount")
    emitted = withdraw.index("emit_transfer")
    assert parked < emitted, "the entitlement must be parked before the transfer is emitted"

    assert "reclaim" in fns, "there is no way to recover an undelivered withdrawal"
    reclaim = _code_of(fns["reclaim"])
    assert "resolve_withdrawal" in reclaim, (
        "reclaim decides delivery inline again; the decision belongs in the "
        "engine, where it can be executed by a test"
    )
    for argument in ("elapsed_seconds", "held", "committed", "settle_seconds"):
        assert argument in reclaim, f"reclaim does not pass {argument} to the decision"
    assert "self.p_withdrawal_settle_seconds" in reclaim, (
        "reclaim uses the module constant instead of the deployed policy, so a "
        "test instance and a production one could not differ"
    )
    assert "self._committed()" in reclaim, (
        "reclaim must weigh everything a restore may not reach, not entitlements "
        "alone; judged against total_owed it reads locked bonds and posted "
        "collateral as free money, and judged against obligations alone it reads "
        "the slashed bonds that way"
    )
    assert "REASON_WITHDRAWAL_UNSETTLED" in reclaim, (
        "reclaim does not refuse an unsettled withdrawal; judging one before the "
        "transfer can have landed is the one way this can pay twice"
    )
    assert "self.owed[key] = restored" in reclaim, "reclaim never restores the entitlement"
    assert "REASON_NO_WITHDRAWAL_PENDING" in reclaim, (
        "reclaim must refuse when nothing is outstanding, rather than crediting silently"
    )

    # Nothing may leave a claim stuck. Every path out of `reclaim` either
    # resolves the withdrawal or is retryable, and `withdrawal_of` says when.
    assert ".balance" in reclaim and "sender_address).balance" not in reclaim, (
        "reclaim reads the recipient's balance again; unrelated money arriving "
        "there reads as delivery, and a recipient that spends reads as failure"
    )
    assert "withdrawal_of" in fns, (
        "an outstanding withdrawal must be readable from outside, or it is "
        "indistinguishable from a lost one"
    )


def test_only_a_credent_recipient_contract_can_be_paid(artifact_source: str) -> None:
    """The review's first item, closed exactly rather than narrowed.

    "On Bradbury a wallet can mark itself proven." It cannot any more, and the
    reason is not a heuristic. Before it will probe, confirm or pay, the
    contract makes a view call into the caller's own address for
    `credent_recipient()`. A wallet has no code to answer with, and the failure
    is **not catchable** -- it takes the calling transaction down.

    Measured on both networks with `try`/`except Exception` wrapped around the
    call, against three targets:

        studionet  a contract implementing it   returned the marker, SUCCESS
                   a contract without it        ERROR, state untouched
        bradbury   a contract implementing it   returned the marker, state moved
                   a contract without it        refused, state untouched
                   a wallet                     refused, state untouched

    That the `except` never runs is the point. There is no branch for an
    attacker to route around: the transaction either reaches the next line with
    the caller established as a Credent recipient, or it does not reach it. An
    earlier build looked at this as a way to *detect* a contract, found it
    uncatchable, and set it aside -- read as a refusal instead of a predicate,
    uncatchable is the stronger property.
    """
    tree = ast.parse(artifact_source)
    fns = {n.name: n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef)}

    assert "_require_recipient_contract" in fns, (
        "the recipient-contract guard is gone; a wallet can reach the payout path again"
    )
    helper = _code_of(fns["_require_recipient_contract"])
    assert "credent_recipient()" in helper, (
        "the guard must call the marker method on the caller's own address"
    )
    assert "gl.message.sender_address" in helper, (
        "the guard must call into the *caller*, not an address it was handed"
    )
    assert "RECIPIENT_MARKER" in helper, (
        "the returned marker is not compared, so any contract with a method of "
        "that name passes"
    )
    assert "REASON_WRONG_RECIPIENT_MARKER" in helper, (
        "a wrong marker must be a classified refusal, not a bare exception"
    )
    assert "try" not in helper and "except" not in helper, (
        "the guard must not swallow the failure; uncatchable is the mechanism"
    )

    for guarded in ("prove_recipient", "confirm_recipient", "withdraw"):
        assert "_require_recipient_contract()" in _code_of(fns[guarded]), (
            f"{guarded} does not require the caller to be a Credent recipient"
        )


def test_the_reference_recipient_answers_the_marker(artifact_source: str) -> None:
    """`claimant.py` must implement exactly the marker the contract demands.

    The two live in different files and neither imports the other, so a rename
    on one side would leave every recipient in the repository unable to be paid
    and nothing would fail until a deployment did.
    """
    marker = RECIPIENT_MARKER
    claimant = (Path(__file__).parent / "web" / "scripts" / "claimant.py").read_text()
    assert f"def {RECIPIENT_MARKER_METHOD}(" in claimant, (
        f"the reference recipient does not implement {RECIPIENT_MARKER_METHOD}(); "
        "it could not be paid by the contract it ships with"
    )
    assert f'return "{marker}"' in claimant, (
        f"the reference recipient does not return {marker!r}, so the contract "
        "would refuse it"
    )
    assert "@gl.public.view" in claimant.split(f"def {RECIPIENT_MARKER_METHOD}(")[0].rsplit("\n", 3)[0], (
        f"{RECIPIENT_MARKER_METHOD} must be a view method; the contract calls it by view"
    )


def test_every_obligation_is_counted(artifact_source: str) -> None:
    """Solvency is only honest if the contract knows everything it is holding.

    Entitlements are not the whole story: a locked bond and a posted collateral
    are both money that belongs to somebody else and both have to be handed back
    or paid out later. Counting only `total_owed` reads them as free surplus,
    which is what would let `reclaim` pay a second time out of them.

    Each counter is checked at both ends. A counter that is incremented and
    never decremented locks the contract out of a legitimate restore for ever;
    one that is decremented and never incremented is worse, because it reads as
    solvent when it is not.
    """
    tree = ast.parse(artifact_source)
    fns = {n.name: n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef)}

    assert "_obligations" in fns, "there is no single place that totals what is owed"
    obligations = _code_of(fns["_obligations"])
    for field in ("total_owed", "total_in_flight", "total_bond_held", "total_collateral_held"):
        assert field in obligations, f"_obligations does not count {field}"

    # Bonds: counted when locked, released when they become an entitlement.
    attest = _code_of(fns["attest"])
    assert "self.total_bond_held = int(self.total_bond_held) + required" in attest, (
        "a posted bond is not counted as an obligation"
    )
    assert "_BOND_LOCKED" in attest, (
        "the bond count must be conditional on the bond still being owed back; a "
        "slashed bond stays with the contract"
    )
    reclaim_bond = _code_of(fns["reclaim_bond"])
    assert "self.total_bond_held = int(self.total_bond_held) - amount" in reclaim_bond, (
        "a returned bond is still counted as held, so the contract under-reports "
        "its surplus for ever"
    )

    # Collateral: counted when posted, released on either settlement route.
    accept = _code_of(fns["accept_engagement"])
    assert "self.total_collateral_held = int(self.total_collateral_held) + required" in accept, (
        "posted collateral is not counted as an obligation"
    )
    for settle in ("release_collateral", "claim_collateral"):
        assert "self.total_collateral_held = int(self.total_collateral_held) - amount" in _code_of(fns[settle]), (
            f"{settle} pays the collateral out without clearing the obligation"
        )

    # Slashed bonds are kept, not owed — and counted, because a restore must
    # not be able to spend them. That is the difference between the one wrong
    # answer being harmless and being worth attacking.
    assert "self.total_slashed = int(self.total_slashed) + required" in attest, (
        "a slashed bond is not counted, so it reads as free money to a restore"
    )
    committed = _code_of(fns["_committed"])
    assert "self._obligations()" in committed and "total_slashed" in committed, (
        "_committed must be obligations plus what was slashed"
    )

    # And the reader sees the same figures the contract decides on.
    liabilities = _code_of(fns["liabilities"])
    for key in ("total_bond", "total_collateral", "obligations", "slashed", "committed"):
        assert key in liabilities, f"liabilities does not report {key}"
