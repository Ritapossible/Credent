"""Generate the deployable single-file contract.

GenLayer's standard `py-genlayer` runner takes one Python file, so the contract
has to carry the engine inside it rather than importing it. Concatenating by
hand would mean maintaining two copies of arithmetic that 279 tests are pinned
to, and the copy that drifts would be the one nobody runs.

So: `contract_shell.py` holds the chain-facing code with an `#<<<ENGINE>>>`
marker, and this script splices `reputation_core.py` and `reputation_prompts.py`
into it. Run it after touching any of the three; `test_build_contract.py` fails
the suite if the checked-in artifact is stale.

The transformation is deliberately almost nothing. Every inlined line is copied
byte for byte except `from __future__ import annotations`, which is dropped.
Nothing is reformatted, reordered, or rewritten - a codegen step that "tidies"
consensus arithmetic is a consensus bug waiting for a validator to disagree.

The dropped import is not a stylistic choice, and it is the one place the
generated file is allowed to differ from its sources. Python only permits that
line as a file's first statement, so an inlined module cannot keep its own; the
obvious repair is to hoist a single copy into the generated header. That is what
this script used to do, and it silently broke the contract's ABI.

Postponed annotations turn every signature into a string. The GenVM standard
library builds its ABI schema with `inspect.signature`, without `eval_str=True`,
so it reads the *string* `'u256'` where it expects the type and refuses it:
`Schema extraction failed: couldn't get schema for method __init__`. The class
still imports, the storage layout still generates - `generate_storage` resolves
annotations through `typing.get_type_hints`, which evaluates strings - and the
contract still deploys. Only the schema is gone, and the schema is what every
client reads to learn the call surface. `genvm-lint check` is where this is
visible; `test_build_contract.py` pins it so it cannot come back.

The sources keep their own `__future__` imports. They are ordinary modules that
never face the GenVM reflection path, and 279 tests import them directly.
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
# against: `gl.Contract`, `gl.vm.run_nondet`, `gl.vm.UserError`, `gl.message_raw`
# and `gl.get_contract_at` are all spellings of *this* runner's standard library
# (`py-lib-genlayer-std:11rhn002...`), not of the one documented at
# https://sdk.genlayer.com/main/_static/ai/api.txt.
#
# That distinction is the whole reason this comment is long. There are two live
# generations of the SDK and they disagree about nearly every name this contract
# touches. The published api.txt describes the other one: it documents
# `gl.vm.get_timestamp`, which exists in neither generation on disk, and
# `gl.chain.Account`, which exists only in the generation `genvm-lint` cannot
# load. Verify a bump against the extracted std library under
# `~/.cache/genvm-linter/extracted/`, and against `genvm-lint check`, rather than
# against the website. `test_build_contract.py` asserts this hash resolves to a
# runner the linter can actually find.
RUNNER = "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6"

# The blank line on the second line is load-bearing, and it is the second thing
# on this file's list of ways to write a contract that lints clean and cannot
# deploy. GenVM reads the *contiguous* comment block at the top of the file as
# its runner configuration and parses every line in it as JSON. The `Depends`
# line is the only JSON here, so any ordinary comment touching it - even one -
# makes the whole block unparseable and the node rejects the contract with
# `contract_error: invalid_contract` at deploy time.
#
# A blank line ends that block. Everything below it is an ordinary comment that
# GenVM never reads, which is where the human-facing banner belongs.
#
# Nothing local catches this. `genvm-lint` does not model the header block, so
# the artifact validates and extracts a full schema either way, and the CLI
# reports "Contract deployed successfully" because the *transaction* is accepted
# by consensus - the execution failure is inside the receipt. Confirmed on
# studionet: a comment on line 2 is rejected, a blank line on line 2 deploys and
# reads back. `test_build_contract.py` pins the blank line so it cannot be
# tidied away.
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


def _strip_future(source: str, origin: str) -> str:
    """Drop the `__future__` import from an inlined module.

    Removes the line and nothing else, so the remainder stays byte-identical to
    the file the tests run against. Nothing re-emits it: see the module
    docstring for why the generated contract must have no postponed annotations.
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
    # The shell's own `__future__` line goes too. The banner above it is comments
    # only, so the shell's docstring stays the generated module's docstring.
    shell = _strip_future(shell, SHELL.name)
    return BANNER + "\n" + shell.replace(MARKER, engine)


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
