# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }

# A settlement recipient that can actually be paid.
#
# `emit_transfer` does not credit an externally-owned account -- to a wallet the
# value leaves the sender and arrives nowhere -- and it does credit a contract.
# So a provider, client or attester that expects to be paid on this platform has
# to be a contract, and this is the smallest one that works: it names the oracle,
# claims what it is owed, and counts what arrives.
#
# `__receive__` is called when native tokens are sent without invoking a method,
# and it must be a payable public write. It is not what makes this a valid
# recipient: measured on studionet, a contract is credited whether its handler
# works, raises, or does not exist at all, while an externally owned account is
# never credited. Being a contract is the whole condition. The handler is here
# for the clean receipt and the counter, and the counter is a convenience for
# the harness rather than the proof -- the balance is the proof, and the
# settlement suite reads it on both sides of every transfer.

from __future__ import annotations

from genlayer import *


class Claimant(gl.Contract):
    owner: Address
    oracle: Address
    received: u256

    def __init__(self, oracle: str) -> None:
        self.owner = gl.message.sender_address
        self.oracle = Address(oracle)
        # Plain `0`, never `u256(0)`: on the v0.3 runner the integer aliases are
        # `typing.Annotated[int, ...]` rather than `NewType`, so they annotate
        # and do not call.
        self.received = 0

    @gl.public.view
    def get_owner(self) -> str:
        return self.owner.as_hex

    @gl.public.view
    def get_oracle(self) -> str:
        return self.oracle.as_hex

    @gl.public.view
    def total_received(self) -> int:
        return int(self.received)

    @gl.public.view
    def credent_recipient(self) -> str:
        """Identify this contract as a Credent push-payment recipient.

        The oracle calls this, by view, on the caller's own address before it
        will probe, confirm or pay. A wallet has no code to answer with, and the
        failure is not catchable, so the oracle's transaction ends there. That
        is the whole recipient test: implementing this method is what makes an
        address eligible for `withdraw`.

        The string is compared exactly. Returning anything else is a refusal
        with a reason rather than a dead transaction.
        """
        return "credent-recipient-v1"

    # `genvm-lint` rejects this method: E019 wants a `@gl.public.write`
    # decorator on it, and E106 then refuses any public name beginning with
    # `__`. The two rules cannot both be satisfied, so a recipient contract can
    # be lint-clean or receive value quietly, not both.
    #
    # Quiet wins here, deliberately. `emit_transfer` sends a message with **no
    # method name**; the runner resolves that by trying `__receive__` and then
    # `__handle_undefined_method__`. A recipient implementing neither still
    # receives the value -- crediting and executing the handler are separate
    # outcomes, measured, see the README -- but the inbound message leaves
    # `ValueError: call to private method ...` in its receipt, which reads
    # exactly like the failed transfer this whole change exists to fix. On a
    # payout path being re-examined by a reviewer, a clean receipt is worth more
    # than a clean lint run on a test fixture.
    @gl.public.write.payable
    def __receive__(self) -> None:
        """Accept a plain value transfer."""
        self.received = int(self.received) + int(gl.message.value)

    @gl.public.write.payable
    def accept(self, engagement_id: str) -> None:
        """Accept an engagement as the provider, forwarding the collateral.

        This is why the claimant is a contract rather than a wallet, and it is
        the shape a real provider agent has to take on this platform: the party
        that gets paid must be able to *receive*, and receiving means being a
        contract, so the same contract has to be able to post collateral too.

        The oracle checks `gl.message.sender_address` against the engagement's
        provider. An emitted cross-contract call arrives with this contract as
        the sender, so this contract is the provider -- which is exactly what
        makes it eligible for the settlement it will later withdraw.
        """
        gl.get_contract_at(self.oracle).emit(
            value=gl.message.value, on="accepted"
        ).accept_engagement(engagement_id)

    @gl.public.write
    def release(self, engagement_id: str) -> None:
        """Ask the oracle to release this engagement's collateral.

        The oracle checks the caller against the engagement's provider, and the
        provider is this contract, so this call has to originate here. Driving
        it from the wallet that funded the contract is rejected with
        `sender_not_provider` -- correctly, since that wallet is not the party
        the collateral belongs to.
        """
        gl.get_contract_at(self.oracle).emit(on="accepted").release_collateral(
            engagement_id
        )

    @gl.public.write.payable
    def attest(self, engagement_id: str, claim: str, evidence: str) -> None:
        """Grade the counterparty, posting the bond from this contract.

        The oracle requires the attester to be one of the engagement's two
        parties. This contract is the provider, so it attests about the client,
        and the bond it posts becomes an entitlement it can reclaim later --
        which is the third of the three payout types the review names.
        """
        gl.get_contract_at(self.oracle).emit(
            value=gl.message.value, on="accepted"
        ).attest(engagement_id, claim, evidence)

    @gl.public.write
    def reclaim(self, attestation_id: int) -> None:
        """Reclaim a bond this contract posted, once the lock has elapsed."""
        gl.get_contract_at(self.oracle).emit(on="accepted").reclaim_bond(
            attestation_id
        )

    @gl.public.write
    def prove(self) -> None:
        """Ask the oracle to pay this contract a token amount.

        The oracle emits `PROBE_WEI` here. Only a contract is credited by
        `emit_transfer`, so the arrival of that value is itself the proof that
        this address can be paid -- there is nothing to assert and nothing the
        oracle has to take on trust.
        """
        gl.get_contract_at(self.oracle).emit(on="accepted").prove_recipient()

    @gl.public.write
    def confirm(self) -> None:
        """Tell the oracle the probe arrived, once it has.

        A separate transaction, deliberately. The probe is an *emitted*
        transfer: it settles after the call that sent it, so there is no moment
        during `prove` at which this contract has already been paid. Calling
        this too early is a classified refusal -- `the_probe_value_did_not_arrive`
        -- and costs nothing but the call. Wait and try again.
        """
        gl.get_contract_at(self.oracle).emit(on="accepted").confirm_recipient()

    @gl.public.write
    def claim(self) -> None:
        """Call `withdraw` on the oracle and take this contract's entitlement.

        No argument is passed, because there is nothing to assert. `withdraw`
        used to take `recipient_is_a_contract` -- a claim the oracle could not
        check, made on the call that spent the money. It now refuses anyone who
        has not answered the probe above, so eligibility is established before
        any value moves rather than asserted while it does.

        `on="accepted"` rather than the default: a transfer emitted
        `on="finalized"` was measured on Bradbury reaching FINALIZED with an
        empty `triggered_transactions` and no value moved.

        If the transfer cannot be delivered the oracle does not lose the
        claim: `withdraw` parks it and `reclaim` restores it.

        Measured on Bradbury, the emitted transfer lands about 150 seconds after
        this call returns. A harness that stops watching sooner will report a
        working payout as a shortfall; the settlement suite waits on the
        entitlement reaching zero and the full amount arriving, for that reason.
        """
        gl.get_contract_at(self.oracle).emit(on="accepted").withdraw()

    @gl.public.write
    def settle_withdrawal(self) -> None:
        """Call `reclaim` on the oracle to resolve this contract's withdrawal.

        Named apart from `reclaim` above, which returns an attestation *bond*.
        This one resolves the payout: it closes the withdrawal when the value
        arrived, and puts the entitlement back when it did not.

        There is nothing to pass and nothing to decide here. The oracle reads
        this contract's own balance against the baseline it recorded when it
        emitted the transfer, so the answer comes from the chain rather than
        from anything this contract claims.
        """
        gl.get_contract_at(self.oracle).emit(on="accepted").reclaim()
