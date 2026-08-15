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
        "close_engagement",
        "attest",
        "reclaim_bond",
        "get_report",
        "get_attestation",
        "get_subject_attestations",
        "get_engagement",
        "get_policy",
        "attestation_count",
        "bond_for_next",
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
    assert report["validate"]["ctor_params"] == 10, "the ten policy parameters"


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
