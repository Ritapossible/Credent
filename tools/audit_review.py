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

# Read from deployments.json, never repeated. See the note in that file.
_MANIFEST = json.loads((ROOT / "deployments.json").read_text(encoding="utf-8"))
DEPLOYMENTS = {
    net: (spec["rpc"], spec["address"], spec["params"])
    for net, spec in _MANIFEST.items()
    if not net.startswith("_")
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


def emits_value(fn: ast.FunctionDef) -> bool:
    """Does this function send value anywhere?

    `emit_transfer` always does. `emit(...)` only does when a `value=` keyword
    is present -- `prove_recipient` uses a zero-value `emit(...).credent_probe()`
    to ask a recipient to identify itself, and counting that as a value transfer
    would flag the one method whose whole point is that it risks nothing.
    """
    for node in ast.walk(ast.Module(body=statements(fn), type_ignores=[])):
        if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)):
            continue
        if node.func.attr == "emit_transfer":
            return True
        if node.func.attr == "emit" and any(k.arg == "value" for k in node.keywords):
            return True
    return False


def audit(label: str, source: str) -> list[tuple[str, bool, str]]:
    fns = {n.name: n for n in ast.walk(ast.parse(source)) if isinstance(n, ast.FunctionDef)}
    agree = code(fns["grades_agree"]) if "grades_agree" in fns else ""
    probe = code(fns["prove_recipient"]) if "prove_recipient" in fns else ""
    confirm = code(fns["confirm_recipient"]) if "confirm_recipient" in fns else ""
    withdraw = code(fns["withdraw"]) if "withdraw" in fns else ""
    emitters = sorted(n for n, f in fns.items() if emits_value(f))

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
            "assign_to" in fns and not emits_value(fns["assign_to"]),
            "the safe payout path must move an entitlement, never push value",
        ),
        (
            "withdraw is the only method that emits value",
            emitters == ["withdraw"],
            f"emitters: {emitters}",
        ),
        (
            "withdraw refuses an unproven recipient",
            "self.proven" in withdraw,
            "emitting at an address that cannot receive destroys the value",
        ),
        (
            "withdraw takes no caller-supplied claim",
            [a.arg for a in fns["withdraw"].args.args if a.arg != "self"] == [],
            "recipient_is_a_contract was unverifiable and cost the entitlement",
        ),
        (
            "the probe carries no value",
            "emit_transfer" not in probe and "value=" not in probe,
            "a probe that risks value reintroduces the problem in miniature",
        ),
        (
            "a confirmation must answer an outstanding probe",
            "self.probing" in confirm and "REASON_NO_PROBE_OUTSTANDING" in confirm,
            "an unrequested confirmation would mark any caller proven",
        ),
        (
            "the probe is consumed by the confirmation",
            "self.probing[key] = False" in confirm,
            "an unspent probe makes the confirmation replayable",
        ),
        (
            "recipients are validated and classified",
            "_clean_recipient" in fns
            and "REASON_BAD_RECIPIENT" in code(fns["_clean_recipient"])
            and "REASON_ZERO_RECIPIENT" in code(fns["_clean_recipient"]),
            "a bare Address() raises unclassified; the zero address strands funds",
        ),
        (
            "no balance-inference machinery remains",
            all(n not in fns for n in ("resolve_in_flight", "in_flight_to", "solvency")),
            "two designs inferred delivery from the balance and both were wrong",
        ),
        (
            "no __on_errored_message__ is claimed",
            "__on_errored_message__" not in fns,
            "measured: it does not fire for an undeliverable transfer",
        ),
        # 2. "complete the main app's payout flow with the owed balance and withdrawal methods"
        (
            "the payout views exist",
            all(v in fns for v in ("owed_to", "is_proven", "liabilities")),
            "the app reads these to show what is owed and whether it can be taken",
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
        ("app reads is_proven", "'is_proven'" in oracle, ""),
        ("app reads liabilities", "'liabilities'" in oracle, ""),
        ("app can assign_to", "'assign_to'" in wallet, ""),
        ("app can withdraw", "'withdraw'" in wallet, ""),
        ("app gates withdraw on the proof", "proven" in (web / "pages" / "Payouts.tsx").read_text(encoding="utf-8"), ""),
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
        "node", "ast", "dump", "view", "call", "withdraw_to", "credent_probe",
        "normalizeAddress", "resolve_in_flight", "solvency", "in_flight_to",
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
