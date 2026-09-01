"""Direct-mode fixtures: the payout path, executed.

`gltest`'s direct mode runs the contract in-memory against a mocked host. Two
things it does not simulate are exactly the two this contract's payout path
depends on, and both are exposed as extension points:

* **Cross-contract calls.** `_require_recipient_contract` view-calls
  `credent_recipient()` on the caller. Direct mode delegates `CallContract` to
  `vm._gl_call_hook` if one is installed. `Chain` installs one and answers only
  for addresses a test has registered as recipient contracts, which is what
  makes "a wallet" and "a recipient" different things here.

* **Emitted transfers.** `emit_transfer` arrives as `PostMessage`. The hook
  records them instead of dispatching, so a test can decide whether the value
  arrived by adjusting the contract's balance with `direct_vm.deal` — which is
  the whole point, because "did the transfer land" is the question `reclaim`
  exists to answer and the only one that cannot be observed on a live network.

One honest difference from the chain: where an address has no code, the real
GenVM ends the calling transaction, while here the call returns nothing and the
contract's marker comparison rejects it. The caller is refused either way with
no state change, which is what these tests assert; the *mechanism* of the
refusal is measured on-chain instead, and recorded in the README.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

# The harness needs Python 3.12+ (`genlayer_py` imports `collections.abc.Buffer`)
# and a cached GenVM release tarball. Neither is a reason to fail the default
# suite on an interpreter that cannot run them, so this module skips rather than
# errors, and `run_direct_tests.sh` names the interpreter that can.
pytest.importorskip(
    "gltest.direct.pytest_plugin",
    reason="direct-mode harness unavailable: needs python>=3.12 and `pip install genlayer-test`",
)

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from reputation_core import RECIPIENT_MARKER  # noqa: E402

CONTRACT = ROOT / "reputation_oracle.py"


def _returned(value) -> bytes:
    """Encode a contract-call result the way the runner does.

    A cross-contract call is not decoded like a web or LLM response: the SDK
    reads a one-byte `ResultCode` first and then the calldata. `RETURN` is 0.
    Returning the plain `{"ok": ...}` shape used elsewhere fails with
    `unknown type 14`, which is the first byte of the encoded string.
    """
    from genlayer.py import calldata
    from genlayer.py.public_abi import ResultCode

    return bytes([ResultCode.RETURN]) + calldata.encode(value)


def _as_bytes(address) -> bytes:
    for attribute in ("as_bytes", "_bytes"):
        value = getattr(address, attribute, None)
        if isinstance(value, (bytes, bytearray)):
            return bytes(value)
    if isinstance(address, (bytes, bytearray)):
        return bytes(address)
    text = str(address)
    if text.startswith("Address("):
        text = text[text.index('"') + 1 : text.rindex('"')]
    return bytes.fromhex(text.removeprefix("0x"))


class Chain:
    """The parts of the chain direct mode leaves to the test."""

    def __init__(self, vm):
        self.vm = vm
        self._recipients: set[bytes] = set()
        self.transfers: list[tuple[bytes, int]] = []
        vm._gl_call_hook = self._hook

    def register_recipient(self, address) -> None:
        """Make this address answer `credent_recipient()`, as a contract would."""
        self._recipients.add(_as_bytes(address))

    def _hook(self, vm, request):
        if "CallContract" in request:
            call = request["CallContract"]
            method = (call.get("calldata") or {}).get("method")
            if method == "credent_recipient":
                if _as_bytes(call["address"]) in self._recipients:
                    return _returned(RECIPIENT_MARKER)
                return None  # nothing there to answer
            return None
        if "PostMessage" in request:
            message = request["PostMessage"]
            self.transfers.append((_as_bytes(message["address"]), int(message.get("value", 0))))
            return {"ok": None}
        return None

    @property
    def contract_address(self):
        return self.vm._contract_address

    def set_held(self, amount: int) -> None:
        """Set what the contract is holding.

        Direct mode does not credit a payable call's `value` to the contract's
        balance, so `held` has to be stated rather than accumulated. That is not
        a workaround so much as the point: `reclaim` decides from the balance,
        and a test that could not set the balance could not drive the decision.
        """
        self.vm.deal(self.contract_address, amount)

    def warp(self, timestamp: str) -> None:
        """Move consensus time forward, including where the contract reads it.

        `direct_vm.warp` updates the VM's datetime, and `_refresh_gl_message`
        rewrites `sender_address` and `origin_address` on the already-imported
        `gl.message_raw` — but not `datetime`. This contract reads consensus
        time from `gl.message_raw["datetime"]`, which is the only place the
        runner exposes it, so a bare `warp` leaves it where it was and every
        time-dependent branch stays unreachable. Setting both is the workaround.
        """
        import sys

        self.vm.warp(timestamp)
        module = sys.modules.get("genlayer.gl")
        if module is not None and getattr(module, "message_raw", None) is not None:
            module.message_raw["datetime"] = timestamp

    def last_transfer(self) -> tuple[bytes, int]:
        assert self.transfers, "no transfer was emitted"
        return self.transfers[-1]


@pytest.fixture
def chain(direct_vm) -> Chain:
    return Chain(direct_vm)


@pytest.fixture
def oracle(direct_vm, direct_deploy, direct_owner):
    """A deployed oracle with the timers short enough to drive in one test."""
    direct_vm.sender = direct_owner
    return direct_deploy(
        str(CONTRACT),
        min_bond=0,
        bond_lock_seconds=0,
        withdrawal_settle_seconds=60,
    )
