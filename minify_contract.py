"""Shrink the generated contract to what the chain actually needs to run.

`reputation_oracle.py` is 96,285 bytes and bradbury will not take it. The deploy
is not refused for gas - it reverts at 20M, 40M and 60M alike, and at 90M the
node finally names the wall: `BlockPubdataLimitReached`. That is a limit on the
*bytes* a block will carry, so the fix is bytes, not gas.

Half the file is prose. 33,910 bytes of docstrings and 13,269 of comments, 49%
of the artifact, none of which the runner executes. Removing it is the whole
strategy here, and it costs the repository nothing: the sources keep every word,
and this runs on the generated file on its way to the chain.

## Why this is a tokenizer and not `ast.unparse`

`ast.unparse` would be four lines and would be wrong. `build_contract.py` says
it plainly - "a codegen step that 'tidies' consensus arithmetic is a consensus
bug waiting for a validator to disagree" - and it holds here for the same
reason: every validator re-executes this file, and the arithmetic 279 tests are
pinned to should reach the chain spelled exactly as it was written. So every
byte of code is copied verbatim. Only comments and docstrings are cut, and only
by blanking the spans the tokenizer reports.

## The two things that make this delicate

**Line 1 is not a comment.** `# { "Depends": ... }` is the runner pin, and GenVM
reads the *contiguous* comment block at the top of the file as its configuration
and parses every line of it as JSON. So the pin must survive, and line 2 must
stay blank - a comment there makes the block unparseable and the node rejects
the contract with `contract_error: invalid_contract`. A minifier that closed
that gap would produce a smaller file that cannot deploy at all.

**Blank lines are not always insignificant.** The grading prompts are multi-line
strings with blank lines inside them. Collapsing whitespace by scanning text
would silently edit the prompt the validators grade against. Every line covered
by a string token is therefore protected and never dropped.

## What is checked

`verify()` re-parses both sides and compares `ast.dump` after stripping
docstrings from each. If the trees match, the runner cannot tell the two files
apart, which is the only guarantee worth having here.
"""

from __future__ import annotations

import ast
import io
import sys
import tokenize
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / "reputation_oracle.py"
OUTPUT = ROOT / "reputation_oracle.min.py"


def _is_string_statement(node: object) -> bool:
    """A statement that is nothing but a string literal."""
    return (
        isinstance(node, ast.Expr)
        and isinstance(node.value, ast.Constant)
        and isinstance(node.value.value, str)
    )


def _docstring_targets(tree: ast.AST) -> list[ast.Expr]:
    """Every string-only statement in the tree, as statements to delete.

    Not just docstrings, and the difference is 12,000 bytes. `build_contract.py`
    inlines `reputation_core.py` and `reputation_prompts.py` into the middle of
    the generated module, so each one's module docstring arrives as a bare string
    statement partway down the body rather than at `body[0]`. Reading only the
    first statement of each block left those in place - the largest single blocks
    of prose in the file, still riding to the chain.

    A string statement anywhere other than `body[0]` is dead weight by
    definition: Python evaluates the constant and discards it. At `body[0]` it is
    the docstring, which the runner never reads either - nothing in this contract
    touches `__doc__`, and GenVM builds its ABI from `inspect.signature`.
    """
    found = []
    for node in ast.walk(tree):
        body = getattr(node, "body", None)
        if not isinstance(body, list) or not body:
            continue
        for statement in body:
            # A block that is *only* a string cannot lose it; the block would be
            # empty and the file would not parse. It is left alone rather than
            # replaced with `pass`, because substituting code is exactly the kind
            # of edit this module refuses to make.
            if _is_string_statement(statement) and len(body) > 1:
                found.append(statement)
    return found


def _strip_docstrings(tree: ast.AST) -> ast.AST:
    """A copy of the tree with every docstring removed, for comparison."""
    for node in ast.walk(tree):
        body = getattr(node, "body", None)
        if not isinstance(body, list) or not body:
            continue
        kept = [s for s in body if not _is_string_statement(s)]
        if len(kept) != len(body):
            node.body = kept or [ast.Pass()]
    return tree


def minify(source: str) -> str:
    lines = source.splitlines(keepends=True)
    # 1-indexed rows, so pad slot 0.
    cut: list[list[tuple[int, int]]] = [[] for _ in range(len(lines) + 2)]
    protected: set[int] = set()

    readline = io.StringIO(source).readline
    pin_row = None
    for tok in tokenize.generate_tokens(readline):
        if tok.type == tokenize.COMMENT:
            if pin_row is None and tok.string.lstrip().startswith('# {') and '"Depends"' in tok.string:
                pin_row = tok.start[0]
                continue  # the runner pin stays
            cut[tok.start[0]].append((tok.start[1], tok.end[1]))
        elif tok.type == tokenize.STRING or tok.type == getattr(tokenize, "FSTRING_START", -1):
            for row in range(tok.start[0], tok.end[0] + 1):
                protected.add(row)

    if pin_row is None:
        raise SystemExit("no runner pin found; refusing to emit a contract that cannot deploy")

    tree = ast.parse(source)
    for node in _docstring_targets(tree):
        s, e = node.lineno, node.end_lineno
        for row in range(s, e + 1):
            protected.discard(row)
        if s == e:
            cut[s].append((node.col_offset, node.end_col_offset))
        else:
            cut[s].append((node.col_offset, len(lines[s - 1].rstrip("\r\n"))))
            for row in range(s + 1, e):
                cut[row].append((0, len(lines[row - 1].rstrip("\r\n"))))
            cut[e].append((0, node.end_col_offset))

    out: list[str] = []
    for i, raw in enumerate(lines, start=1):
        text = raw.rstrip("\r\n")
        for start, end in sorted(cut[i], reverse=True):
            text = text[:start] + text[end:]
        if not text.strip() and i not in protected:
            continue  # a line that held only prose, or an ordinary blank
        out.append(text.rstrip() if i not in protected else text)

    # Rebuild the header explicitly: the pin, then the blank line that closes the
    # runner-config block. Everything else follows.
    pin = lines[pin_row - 1].rstrip("\r\n").strip()
    body = [l for l in out if l.strip() != pin]
    return pin + "\n\n" + "\n".join(body) + "\n"


def verify(original: str, minified: str) -> None:
    """Fail unless the runner cannot tell the two files apart."""
    a = _strip_docstrings(ast.parse(original))
    b = _strip_docstrings(ast.parse(minified))
    if ast.dump(a) != ast.dump(b):
        raise SystemExit("MINIFY CHANGED THE PROGRAM - refusing to write")
    head = minified.splitlines()
    if not head[0].startswith('# {') or '"Depends"' not in head[0]:
        raise SystemExit("line 1 is not the runner pin")
    if head[1].strip():
        raise SystemExit("line 2 is not blank; the runner-config block would be unparseable")


def main() -> int:
    original = SOURCE.read_text(encoding="utf-8")
    minified = minify(original)
    verify(original, minified)
    OUTPUT.write_text(minified, encoding="utf-8", newline="\n")
    before, after = len(original.encode()), len(minified.encode())
    print(f"{SOURCE.name}  {before:>7,} bytes")
    print(f"{OUTPUT.name}  {after:>7,} bytes   {100 * after / before:.1f}% ({before - after:,} saved)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
