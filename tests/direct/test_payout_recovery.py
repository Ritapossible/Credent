"""The review's sentence, executed.

    "on Bradbury a wallet can mark itself proven, then withdraw clears its owed
     balance before an undeliverable transfer, with no restoration path."

Three clauses, and each one is a test here that runs the contract rather than
reading it. The on-chain runs (`npm run recovery`) prove the same things against
a deployed contract; these prove them in 50ms, on every commit, including the
one case a live network cannot produce — a transfer that does not arrive.
"""

from __future__ import annotations

GEN = 10**18
SCOPE = "Deliver a small script and a README."


def _entitlement(oracle, vm, client, provider, *, stake: int, excess: int) -> int:
    """Give `provider` an entitlement by overpaying its collateral."""
    engagement = f"e-{stake}-{excess}"
    vm.sender = client
    vm.value = 0
    oracle.open_engagement(engagement, provider, SCOPE, stake)

    required = int(oracle.collateral_quote(provider, stake)["required"])
    vm.sender = provider
    vm.value = required + excess
    oracle.accept_engagement(engagement)
    vm.value = 0
    return required


class TestAWalletCannotBePaid:
    """Clause one: "a wallet can mark itself proven"."""

    def test_a_wallet_cannot_open_the_handshake(self, oracle, direct_vm, chain, direct_alice):
        direct_vm.sender = direct_alice
        try:
            oracle.prove_recipient()
            raised = None
        except Exception as error:  # noqa: BLE001 - the message is the assertion
            raised = str(error)
        assert raised is not None, "a wallet opened the payout handshake"
        assert "credent_recipient" in raised or "not_a_credent_recipient" in raised, raised
        assert oracle.is_proven(str(direct_alice)) is False

    def test_a_wallet_cannot_close_a_handshake_it_never_opened(
        self, oracle, direct_vm, chain, direct_alice
    ):
        direct_vm.sender = direct_alice
        try:
            oracle.confirm_recipient()
            raised = None
        except Exception as error:  # noqa: BLE001
            raised = str(error)
        assert raised is not None, "a wallet marked itself proven"
        assert oracle.is_proven(str(direct_alice)) is False

    def test_a_wallet_cannot_withdraw_and_its_entitlement_is_untouched(
        self, oracle, direct_vm, chain, direct_alice, direct_bob
    ):
        """The whole of the reported bypass, in one test.

        The wallet is genuinely owed something — that is the point. It is
        refused at every step, and what it is owed is exactly where it was.
        """
        excess = GEN // 20
        _entitlement(oracle, direct_vm, direct_alice, direct_bob, stake=GEN, excess=excess)
        assert int(oracle.owed_to(str(direct_bob))) == excess

        direct_vm.sender = direct_bob
        for method in (oracle.prove_recipient, oracle.confirm_recipient, oracle.withdraw):
            try:
                method()
            except Exception:  # noqa: BLE001 - refusal is the expected outcome
                pass

        assert oracle.is_proven(str(direct_bob)) is False
        assert int(oracle.owed_to(str(direct_bob))) == excess, "the entitlement moved"
        assert int(oracle.in_flight_to(str(direct_bob))) == 0, "something was put in flight"
        assert chain.transfers == [], "value was emitted at a wallet"


class TestWithdrawParksTheEntitlement:
    """Clause two: "withdraw clears its owed balance"."""

    def test_the_entitlement_is_parked_and_readable(
        self, oracle, direct_vm, chain, direct_alice, direct_bob
    ):
        excess = GEN // 20
        _entitlement(oracle, direct_vm, direct_alice, direct_bob, stake=GEN, excess=excess)
        chain.register_recipient(direct_bob)

        direct_vm.sender = direct_bob
        direct_vm.origin = direct_alice  # a contract calling, not an entry point
        oracle.prove_recipient()
        oracle.confirm_recipient()
        assert oracle.is_proven(str(direct_bob)) is True

        oracle.withdraw()

        assert int(oracle.owed_to(str(direct_bob))) == 0, "owed is not cleared"
        assert int(oracle.in_flight_to(str(direct_bob))) == excess, "the claim was discarded"

        outstanding = oracle.withdrawal_of(str(direct_bob))
        assert int(outstanding["amount"]) == excess
        assert int(outstanding["resolvable_at"]) == int(outstanding["opened_at"]) + 60
        assert outstanding["resolvable_now"] is False

        to, value = chain.last_transfer()
        assert value == excess, "the emitted transfer was not the entitlement"


class TestReclaimIsTheRestorationPath:
    """Clause three: "with no restoration path"."""

    def _park(self, oracle, direct_vm, chain, client, recipient) -> int:
        excess = GEN // 20
        _entitlement(oracle, direct_vm, client, recipient, stake=GEN, excess=excess)
        chain.register_recipient(recipient)
        direct_vm.sender = recipient
        direct_vm.origin = client
        oracle.prove_recipient()
        oracle.confirm_recipient()
        oracle.withdraw()
        return excess

    def test_nothing_is_judged_before_the_transfer_can_have_settled(
        self, oracle, direct_vm, chain, direct_alice, direct_bob
    ):
        """The one way a recovery path can pay twice is by answering too early."""
        excess = self._park(oracle, direct_vm, chain, direct_alice, direct_bob)
        try:
            oracle.reclaim()
            raised = None
        except Exception as error:  # noqa: BLE001
            raised = str(error)
        assert raised is not None and "not_settled" in raised, raised
        assert int(oracle.in_flight_to(str(direct_bob))) == excess

    def test_an_undelivered_transfer_restores_the_entitlement(
        self, oracle, direct_vm, chain, direct_alice, direct_bob
    ):
        """The case the review asked for, and the one no live network produces.

        The transfer was emitted and did not arrive, so the value is still in
        the contract. `reclaim` sees that the balance covers every obligation
        with the claim on its books, and gives it back.
        """
        excess = self._park(oracle, direct_vm, chain, direct_alice, direct_bob)

        # The transfer did not arrive, so the contract still holds everything it
        # owes — including the claim now sitting in `in_flight`.
        obligations = int(oracle.liabilities()["obligations"])
        chain.set_held(obligations)

        chain.warp("2030-01-01T00:00:00Z")
        result = oracle.reclaim()

        assert result["outcome"] == "restored", result
        assert int(oracle.owed_to(str(direct_bob))) == excess, "the entitlement was not restored"
        assert int(oracle.in_flight_to(str(direct_bob))) == 0
        assert int(oracle.liabilities()["held"]) == obligations, "value moved during a restore"
        assert int(oracle.liabilities()["obligations"]) == obligations, "the books did not balance"

    def test_a_restored_entitlement_can_be_withdrawn_again(
        self, oracle, direct_vm, chain, direct_alice, direct_bob
    ):
        """Restored has to mean usable, or it is bookkeeping rather than recovery."""
        excess = self._park(oracle, direct_vm, chain, direct_alice, direct_bob)
        chain.set_held(int(oracle.liabilities()["obligations"]))
        chain.warp("2030-01-01T00:00:00Z")
        assert oracle.reclaim()["outcome"] == "restored"

        oracle.withdraw()
        assert int(oracle.in_flight_to(str(direct_bob))) == excess
        assert chain.transfers[-1][1] == excess

    def test_a_delivered_transfer_is_closed_and_not_paid_twice(
        self, oracle, direct_vm, chain, direct_alice, direct_bob
    ):
        """The ordinary case: the value left, so there is nothing to give back."""
        excess = self._park(oracle, direct_vm, chain, direct_alice, direct_bob)
        # The transfer landed: the contract is short by exactly the payout.
        chain.set_held(int(oracle.liabilities()["obligations"]) - excess)

        chain.warp("2030-01-01T00:00:00Z")
        result = oracle.reclaim()

        assert result["outcome"] == "delivered", result
        assert int(oracle.owed_to(str(direct_bob))) == 0, "a delivered payout was credited back"
        assert int(oracle.in_flight_to(str(direct_bob))) == 0

    def test_reclaim_cannot_be_replayed(
        self, oracle, direct_vm, chain, direct_alice, direct_bob
    ):
        self._park(oracle, direct_vm, chain, direct_alice, direct_bob)
        chain.set_held(int(oracle.liabilities()["obligations"]))
        chain.warp("2030-01-01T00:00:00Z")
        oracle.reclaim()
        owed = int(oracle.owed_to(str(direct_bob)))
        try:
            oracle.reclaim()
            raised = None
        except Exception as error:  # noqa: BLE001
            raised = str(error)
        assert raised is not None and "no_withdrawal_pending" in raised, raised
        assert int(oracle.owed_to(str(direct_bob))) == owed, "a replay credited a second time"
