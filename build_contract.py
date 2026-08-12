"""Generate the deployable single-file contract.

GenLayer's standard `py-genlayer` runner takes one Python file, so the contract
has to carry the engine inside it rather than importing it. Concatenating by
hand would mean maintaining two copies of arithmetic that 245 tests are pinned
to, and the copy that drifts would be the one nobody runs.

So: `contract_shell.py` holds the chain-facing code with an `#<<<ENGINE>>>`
marker, and this script splices `reputation_core.py` and `reputation_prompts.py`
into it. Run it after touching any of the three; `test_build_contract.py` fails
the suite if the checked-in artifact is stale.

The transformation is deliberately almost nothing. Every inlined line is copied
byte for byte except `from __future__ import annotations`, which Python requires
to be the first statement in a file and therefore cannot appear a third of the
way down one. It is hoisted into the generated header instead. Nothing is
reformatted, reordered, or rewritten - a codegen step that "tidies" consensus
arithmetic is a consensus bug waiting for a validator to disagree.
"""

from __future__ import annotations

import ast
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent

SHELL = ROOT / "contract_shell.py"
OUTPUT = ROOT / "reputation_oracle.py"

# Order matters: `reputation_prompts` is independent, `reputation_core` defines
# the names the shell calls. Both land above the contract class either way.
MODULES = (ROOT / "reputation_core.py", ROOT / "reputation_prompts.py")

MARKER = "#<<<ENGINE>>>"

FUTURE_IMPORT = "from __future__ import annotations"

# The runner pin. This is the single line that decides whether the contract can
# deploy at all, and it is version-locked to the SDK surface the shell is written
# against: `gl.vm.run_nondet_default`, `gl.vm.UserError.immediate`,
# `gl.vm.get_timestamp`, `gl.chain.Account` and `gl.storage` are all v0.3.x
# spellings. Bumping the hash without re-checking those names against
# https://sdk.genlayer.com/main/_static/ai/api.txt is how this breaks.
RUNNER = "py-genlayer:9b8kjyda2ycxyq4ea6g4yfpnydxhd52gqba5rb8dw7krkh5mn9p0"

BANNER = f'''# {{ "Depends": "{RUNNER}" }}
# ---------------------------------------------------------------------------
# GENERATED FILE - DO NOT EDIT.
#
# Built by `build_contract.py` from:
#   contract_shell.py       the chain-facing contract
#   reputation_core.py      the deterministic engine (inlined verbatim)
#   reputation_prompts.py   the grading prompt (inlined verbatim)
#
# Edit those and re-run `python build_contract.py`. `test_build_contract.py`
# fails if this file and its sources disagree.
# ---------------------------------------------------------------------------
'''


def _split_docstring(source: str) -> tuple[str, str]:
    """Separate a module's leading docstring from the rest of its source.

    The generated file needs its docstring above `from __future__ import
    annotations`, because anything after that line is a plain string expression
    rather than the module's docstring. Split on the AST's own line span rather
    than by matching quotes, so a docstring containing quote characters cannot
    confuse it.
    """
    tree = ast.parse(source)
    if not (
        tree.body
        and isinstance(tree.body[0], ast.Expr)
        and isinstance(tree.body[0].value, ast.Constant)
        and isinstance(tree.body[0].value.value, str)
    ):
        return "", source

    node = tree.body[0]
    lines = source.splitlines(keepends=True)
    end = node.end_lineno  # 1-based, inclusive
    return "".join(lines[:end]), "".join(lines[end:])


def _strip_future(source: str, origin: str) -> str:
    """Drop the `__future__` import from an inlined module.

    Removes the line and nothing else, so the remainder stays byte-identical to
    the file the tests run against.
    """
    lines = source.splitlines(keepends=True)
    kept = [line for line in lines if line.rstrip("\r\n") != FUTURE_IMPORT]
    if len(kept) == len(lines):
        raise SystemExit(
            f"{origin}: expected a '{FUTURE_IMPORT}' line to hoist and found none. "
            "If it was removed on purpose, drop this check; if it moved, the "
            "generated file may not compile."
        )
    return "".join(kept)


def render() -> str:
    """The full text of the generated contract."""
    shell = SHELL.read_text(encoding="utf-8")
    if MARKER not in shell:
        raise SystemExit(f"{SHELL.name}: missing the {MARKER} marker")

    engine_parts = []
    for path in MODULES:
        body = _strip_future(path.read_text(encoding="utf-8"), path.name)
        engine_parts.append(
            f"# --- inlined verbatim from {path.name} "
            f"{'-' * max(0, 48 - len(path.name))}\n\n{body}"
        )

    engine = "\n\n".join(engine_parts)
    # The shell's own `__future__` line is hoisted too, so the generated file has
    # exactly one and it is the first statement. Its docstring has to clear that
    # line as well, or it stops being a docstring and becomes dead text.
    shell = _strip_future(shell, SHELL.name)
    docstring, body = _split_docstring(shell)
    return BANNER + "\n" + docstring + "\n" + FUTURE_IMPORT + "\n" + body.replace(MARKER, engine)


def main() -> int:
    rendered = render()
    current = OUTPUT.read_text(encoding="utf-8") if OUTPUT.exists() else None
    if current == rendered:
        print(f"{OUTPUT.name} already up to date ({len(rendered.splitlines())} lines)")
        return 0
    OUTPUT.write_text(rendered, encoding="utf-8", newline="\n")
    print(f"wrote {OUTPUT.name} ({len(rendered.splitlines())} lines)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
