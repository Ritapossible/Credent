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
from pathlib import Path

import pytest

import build_contract

ROOT = Path(__file__).resolve().parent
ARTIFACT = ROOT / "reputation_oracle.py"


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


def test_future_import_is_the_first_statement(artifact_source: str) -> None:
    """`__future__` imports are a syntax error anywhere but the top.

    The generator hoists one out of each inlined module, and the docstring has to
    clear it too. Both halves of that are easy to break and silent until deploy.
    """
    tree = ast.parse(artifact_source)
    assert ast.get_docstring(tree), "generated contract lost its module docstring"
    statements = [node for node in tree.body if not isinstance(node, ast.Expr)]
    first = statements[0]
    assert isinstance(first, ast.ImportFrom) and first.module == "__future__"
    assert artifact_source.count(build_contract.FUTURE_IMPORT) == 1


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
    assert "Contract" in classes
    # The engine's dataclasses have to come along, since the contract calls them.
    assert {"Policy", "Report"} <= classes


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
        if isinstance(node, ast.ClassDef) and node.name == "Contract"
    )
    expected = {
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
    decorated = set()
    for node in contract.body:
        if not isinstance(node, ast.FunctionDef):
            continue
        for decorator in node.decorator_list:
            if "gl.public" in ast.unparse(decorator):
                decorated.add(node.name)
    assert expected <= decorated, f"undecorated or missing: {sorted(expected - decorated)}"


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
