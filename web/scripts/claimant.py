# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }

# A settlement recipient that can actually be paid.
#
# `emit_transfer` does not credit an externally-owned account -- to a wallet the
# value leaves the sender and arrives nowhere -- and it does credit a contract.
# So a provider, client or attester that expects to be paid on this platform has
# to be a contract, and this is the smallest one that works: it names the oracle,
# claims what it is owed, and counts what arrives.
#
# `__receive__` is what makes it a valid recipient. It is called when native
# tokens are sent without invoking a method, and it must be a payable public
# write. Crediting and executing are separate outcomes -- a recipient is credited
# even when this body has not run yet -- so the counter is a convenience for the
# harness, not the proof. The balance is the proof.

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

    # `genvm-lint` rejects this method: E019 wants a `@gl.public.write`
    # decorator on it, and E106 then refuses any public name beginning with
    # `__`. The two rules cannot both be satisfied, so a recipient contract can
    # be lint-clean or receive value quietly, not both.
    #
    # Quiet wins here, deliberately. `emit_transfer` sends a message with **no
    # method name**; the runner resolves that by trying `__receive__` and then
    # `__handle_undefined_method__`. A recipient implementing neither still
    # *receives the value* -- crediting and executing the handler are separate
    # outcomes, so the balance moves either way -- but the inbound message
    # leaves `ValueError: call to private method ...` in its receipt, which
    # reads exactly like the failed transfer this whole change exists to fix.
    # On a payout path being re-examined by a reviewer, a clean receipt is worth
    # more than a clean lint run on a test fixture.
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

    @gl.public.write
    def claim(self) -> None:
        """Call `withdraw` on the oracle, asserting that this caller is a contract.

        `True` is honest here in a way it would not be from a wallet: this is a
        contract, so the assertion the oracle cannot verify is one this caller
        can make truthfully.

        `on="accepted"` rather than the default: a transfer emitted
        `on="finalized"` was measured on Bradbury reaching FINALIZED with an
        empty `triggered_transactions` and no value moved.
        """
        gl.get_contract_at(self.oracle).emit(on="accepted").withdraw(True)
