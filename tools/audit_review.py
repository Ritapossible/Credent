"""Check this repository and its deployments against the review, item by item.

    python tools_audit.py

No key, no gas. Every check reads the *deployed* contract over
`gen_getContractCode` and parses it, so what it reports is what is live rather
than what is committed -- the two have come apart in this project before.

Checks are structural and judged on code with docstrings stripped. That is not
fussiness: three guards in this repository have passed against a deliberately
broken contract because the term they searched for appeared in the prose
explaining the rule.
"""

from __future__ import annotations

import ast
import base64
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

DEPLOYMENTS = {
    "studionet": (
        "https://studio.genlayer.com/api",
        "0x395A0E1b81778b69Dd128183412C1738BddD1E4F",
        "bare",
    ),
    "testnet-bradbury": (
        "https://rpc-bradbury.genlayer.com",
        "0xeeAa76953b8E6e83CD83633A0E06f57BDC653155",
        "object",
    ),
}


def fetch(rpc: str, address: str, shape: str) -> str:
    """The deployed source. curl rather than urllib, which ignores a proxy."""
    params = [address] if shape == "bare" else [{"address": address}]
    payload = json.dumps(
        {"jsonrpc": "2.0", "id": 1, "method": "gen_getContractCode", "params": params}
    )
    out = subprocess.run(
        ["curl", "-sS", "-X", "POST", rpc, "-H", "content-type: application/json", "-d", payload],
        capture_output=True,
        text=True,
        timeout=120,
    ).stdout
    result = json.loads(out).get("result")
    if not result:
        raise RuntimeError(f"no code at {address}")
    return base64.b64decode(result).decode("utf-8")


def statements(fn: ast.FunctionDef) -> list[ast.stmt]:
    body = fn.body
    if (
        body
        and isinstance(body[0], ast.Expr)
        and isinstance(body[0].value, ast.Constant)
        and isinstance(body[0].value.value, str)
    ):
        body = body[1:]
    return body


def code(fn: ast.FunctionDef) -> str:
    return "\n".join(ast.unparse(node) for node in statements(fn))


def emits(fn: ast.FunctionDef) -> bool:
    return any(
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr in ("emit_transfer", "emit")
        for node in ast.walk(ast.Module(body=statements(fn), type_ignores=[]))
    )


def audit(label: str, source: str) -> list[tuple[str, bool, str]]:
    fns = {n.name: n for n in ast.walk(ast.parse(source)) if isinstance(n, ast.FunctionDef)}
    agree = code(fns["grades_agree"]) if "grades_agree" in fns else ""
    resolve = code(fns["resolve_in_flight"]) if "resolve_in_flight" in fns else ""
    withdraw = code(fns["withdraw"]) if "withdraw" in fns else ""
    emitters = sorted(n for n, f in fns.items() if emits(f))

    return [
        # 1. "make validator agreement preserve the same bond and collateral outcomes"
        (
            "agreement preserves the bond outcome",
            "bond_outcome(mine, policy) != bond_outcome(theirs, policy)" in agree,
            "two grades within tolerance can straddle slash_floor",
        ),
        (
            "agreement preserves the collateral outcome",
            "collateral_outcome(mine, policy) != collateral_outcome(theirs, policy)" in agree,
            "two grades within tolerance can straddle collateral_forfeit_bp",
        ),
        # 3/4. "redesign the transfer step to avoid clearing owed value irreversibly"
        (
            "assign_to exists and emits no value",
            "assign_to" in fns and not emits(fns["assign_to"]),
            "the wallet payout path must move an entitlement, never push value",
        ),
        (
            "withdraw is the only emitter",
            emitters == ["withdraw"],
            f"emitters: {emitters}",
        ),
        (
            "withdraw parks the entitlement instead of discarding it",
            "self.in_flight[key]" in withdraw and "self.total_out" in withdraw,
            "a transfer it cannot observe must not clear owed irreversibly",
        ),
        (
            "resolve_in_flight decides against the ledger",
            "self.total_in" in resolve and "self.total_out" in resolve,
            "balance vs obligations is unsound: the balance also holds collateral",
        ),
        (
            "resolve_in_flight clears the entry either way",
            "self.in_flight[key] = 0" in resolve,
            "a settled withdrawal left on the books poisons later recoveries",
        ),
        (
            "resolve_in_flight restores only above the ledger",
            "expected + amount" in resolve,
            "restoring a delivered payout would create an unbacked claim",
        ),
        (
            "the unsafe withdraw_to is gone",
            "withdraw_to" not in fns,
            "pushing value at a caller-named address can destroy the entitlement",
        ),
        (
            "no __on_errored_message__ is claimed",
            "__on_errored_message__" not in fns,
            "measured: it does not fire for an undeliverable transfer",
        ),
        # 2. "complete the main app's payout flow with the owed balance and withdrawal methods"
        (
            "the payout views exist",
            all(v in fns for v in ("owed_to", "in_flight_to", "solvency")),
            "the app reads these to show what is owed",
        ),
    ]


def audit_app() -> list[tuple[str, bool, str]]:
    """The site has to carry the payout flow, not just the contract."""
    web = ROOT / "web" / "src"
    oracle = (web / "chain" / "oracle.ts").read_text(encoding="utf-8")
    wallet = (web / "chain" / "wallet.ts").read_text(encoding="utf-8")
    app = (web / "App.tsx").read_text(encoding="utf-8")
    page = web / "pages" / "Payouts.tsx"
    return [
        ("app reads owed_to", "'owed_to'" in oracle, ""),
        ("app reads in_flight_to", "'in_flight_to'" in oracle, ""),
        ("app reads solvency", "'solvency'" in oracle, ""),
        ("app can assign_to", "'assign_to'" in wallet, ""),
        ("app can withdraw", "'withdraw'" in wallet, ""),
        ("app can resolve_in_flight", "'resolve_in_flight'" in wallet, ""),
        ("the payouts page exists", page.exists(), ""),
        ("the payouts route is wired", 'path="payouts"' in app, ""),
    ]


def main() -> int:
    failures = 0

    for network, (rpc, address, shape) in sorted(DEPLOYMENTS.items()):
        print(f"{network}  {address}")
        try:
            source = fetch(rpc, address, shape)
        except Exception as exc:  # noqa: BLE001 - reporting
            print(f"  could not read the deployment: {exc}\n")
            failures += 1
            continue
        for name, ok, why in audit(network, source):
            print(f"  {'ok  ' if ok else 'FAIL'} {name}")
            if not ok:
                print(f"       {why}")
                failures += 1
        print()

    print("the site")
    for name, ok, _ in audit_app():
        print(f"  {'ok  ' if ok else 'FAIL'} {name}")
        if not ok:
            failures += 1
    print()

    # The README must not name a contract method that does not exist. It claimed
    # an error handler once, which is what prompted this file.
    source = fetch(*DEPLOYMENTS["studionet"])
    fns = {n.name for n in ast.walk(ast.parse(source)) if isinstance(n, ast.FunctionDef)}
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    known_external = {
        "emit_transfer", "connect", "get", "pytest", "npm", "curl", "python",
        "node", "ast", "dump", "view", "call", "withdraw_to",
    }
    named = sorted(set(re.findall(r"`([a-z_][a-z0-9_]*)\(\)?[^`]*`", readme)))
    unknown = [n for n in named if n not in fns and n not in known_external]
    print("the README")
    print(f"  {'ok  ' if not unknown else 'FAIL'} every method it names exists on-chain")
    if unknown:
        print(f"       not deployed: {unknown}")
        failures += 1
    # `withdraw_to` is allowed above only as history; check it reads that way.
    for line in readme.splitlines():
        if "withdraw_to" in line and not any(
            w in line for w in ("It is gone", "that preceded it", "first fix")
        ):
            print(f"  FAIL withdraw_to is named outside its historical note: {line.strip()[:70]}")
            failures += 1

    print()
    if failures:
        print(f"{failures} check(s) failed")
        return 1
    print("every item in the review is satisfied, on-chain and in the repository")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
