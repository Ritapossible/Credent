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
import shutil
import subprocess
import sysconfig
from pathlib import Path

import pytest

import build_contract

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
        # transfer to an unverifiable address can. `reclaim_in_flight` takes back
        # an entitlement whose payout never left, and refuses when the value did.
        "withdraw",
        "assign_to",
        "reclaim_in_flight",
        "owed_to",
        "in_flight_to",
        "solvency",
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
    assert report["validate"]["ctor_params"] == 13, "the thirteen policy parameters"


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
        body = ast.unparse(fn)
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

    body = ast.unparse(fn)
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


def test_a_failed_payout_leaves_the_entitlement_recoverable(artifact_source: str) -> None:
    """`withdraw` must not discard an entitlement it cannot confirm delivered.

    It emits a transfer and cannot observe the result, so clearing `owed`
    outright made an undeliverable payout unrecoverable. The entitlement now
    moves to `in_flight`, and `reclaim_in_flight` restores it -- but only while
    the contract still holds the money, checked against its own balance rather
    than assumed.

    Restoring unconditionally would be worse than the original bug: it would let
    one owner reclaim a credit whose value has gone, paying them out of balance
    that backs everybody else's entitlements. So the solvency comparison is part
    of the property, not an implementation detail.
    """
    tree = ast.parse(artifact_source)
    fns = {
        node.name: node
        for node in ast.walk(tree)
        if isinstance(node, ast.FunctionDef)
    }

    for name in ("withdraw", "reclaim_in_flight"):
        assert name in fns, f"{name} is missing"

    withdraw = ast.unparse(fns["withdraw"])
    assert "self.in_flight[key]" in withdraw, (
        "withdraw discards the entitlement instead of moving it to in_flight, "
        "so a payout that never lands cannot be recovered"
    )

    reclaim = ast.unparse(fns["reclaim_in_flight"])
    assert "_contract_balance()" in reclaim, (
        "reclaim_in_flight does not consult the contract's balance, so it would "
        "restore entitlements whose value has already left"
    )
    assert "total_owed" in reclaim and "total_in_flight" in reclaim, (
        "reclaim_in_flight must weigh the restoration against every obligation, "
        "not just its own"
    )
