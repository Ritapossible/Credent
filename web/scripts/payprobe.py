# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }

# Smallest contract that answers the reviewer's question: does a contract-to-wallet
# transfer actually move a balance on this network? Deposit, then pay it back.

from __future__ import annotations

from genlayer import *


class PayProbe(gl.Contract):
    owner: Address

    def __init__(self) -> None:
        self.owner = gl.message.sender_address

    @gl.public.view
    def get_owner(self) -> str:
        return self.owner.as_hex

    @gl.public.write.payable
    def deposit(self) -> None:
        pass

    @gl.public.write
    def payout(self, amount: u256) -> None:
        gl.get_contract_at(gl.message.sender_address).emit_transfer(value=int(amount))
