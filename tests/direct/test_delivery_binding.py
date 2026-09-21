"""The Explorer review's sentence, executed.

    "bind attestations to signed events or validator-retrievable artifacts
     before a counterparty's claim can redirect collateral."

The path it names was real. `attest` takes a claim and an evidence string, both
written by one counterparty about the other; an LLM graded that prose; and a
grade below `collateral_forfeit_bp` let the client take the provider's
collateral. Nothing was ever fetched, so `substantiated` measured how evidenced
the *writing* looked. A fluent account of non-delivery bought the whole
collateral for the price of one bond.

These run the contract rather than describe it, and the central ones key the
model's answer to *what it was shown*: a grader that sees the real artifact
returns a passing grade, and a grader that sees only the accuser's account
returns the damning one the attack needs. The outcome therefore turns on
whether the contract put the artifact in front of the model, which is exactly
what the review asked for and exactly what a mock returning one fixed answer
could not demonstrate.

What is *not* claimed here: that a verified artifact makes a forfeit
impossible. With the work in hand the decision is still the model's, made on
the work. What the binding buys is that the model is looking at the deliverable
the provider committed rather than at prose the accuser wrote about it -- and
that an artifact nobody could establish cannot forfeit at all.
"""

from __future__ import annotations

import hashlib
import json

from conftest import CONTRACT, address

GEN = 10**18
SCOPE = "Deliver a Python script that de-duplicates orders.csv, and a README."
ARTIFACT = b"""# orders_clean.py
import csv, sys
# Reads orders.csv, keeps the latest row per order id, writes orders_clean.csv.
# See README.md for usage and malformed-row handling.
"""
DIGEST = hashlib.sha256(ARTIFACT).hexdigest()
URI = "https://provider.test/orders_clean.py"

# The grade the attack needs: unfulfilled, well above both floors, so the
# policy's own gates are satisfied and only the deliverable stands in the way.
DAMNING = json.dumps(
    {"verdict": "unfulfilled", "fulfilled": 2, "substantiated": 90, "confidence": 95}
)
# What a grader says once it can see the work.
PASSING = json.dumps(
    {"verdict": "fulfilled", "fulfilled": 95, "substantiated": 85, "confidence": 90}
)


def _grader_that_reads_the_deliverable(vm):
    """Answer on the evidence, the way a real grader would.

    First match wins, so a prompt carrying the committed artifact gets the
    passing grade and anything else gets the damning one. If the contract fails
    to put the artifact in front of the model, the attack succeeds and the test
    says so -- which is the only way a mocked model can testify to this at all.
    """
    vm.mock_llm(r"orders_clean\.py", PASSING)
    vm.mock_llm(r".*", DAMNING)

FALSE_CLAIM = (
    "Nothing was delivered. The repository was empty at the agreed deadline, "
    "the provider stopped responding on the 3rd, and no script or README ever "
    "appeared. I checked the branch twice and confirmed with a colleague."
)


def _engagement(oracle, vm, client, provider, name, *, stake=10 * GEN):
    vm.sender = client
    vm.value = 0
    oracle.open_engagement(name, address(provider), SCOPE, stake)
    required = int(oracle.collateral_quote(address(provider), stake)["required"])
    vm.sender = provider
    vm.value = required
    oracle.accept_engagement(name)
    vm.value = 0
    return required


def _attest(oracle, vm, client, name, claim=FALSE_CLAIM):
    vm.sender = client
    bond = int(oracle.bond_for_next(address(client), address(vm.sender)))
    vm.value = bond
    result = int(oracle.attest(name, claim, "see above"))
    vm.value = 0
    return result


class TestTheCommitmentIsSigned:
    """The provider's own transaction is the signed event. Only theirs."""

    def test_only_the_provider_may_commit_a_delivery(
        self, oracle, direct_vm, direct_alice, direct_bob
    ):
        """A client who could commit the delivery could commit a bad one and
        then grade it, which is the same attack wearing a different hat."""
        _engagement(oracle, direct_vm, direct_alice, direct_bob, "e-owner")
        direct_vm.sender = direct_alice  # the client
        try:
            oracle.submit_delivery("e-owner", URI, DIGEST)
        except Exception as error:
            assert "provider" in str(error), error
        else:
            raise AssertionError("the client was allowed to commit the provider's delivery")

    def test_the_commitment_freezes_when_the_engagement_closes(
        self, oracle, direct_vm, direct_alice, direct_bob
    ):
        """Otherwise a provider swaps the artifact once trouble starts."""
        _engagement(oracle, direct_vm, direct_alice, direct_bob, "e-freeze")
        direct_vm.sender = direct_bob
        oracle.submit_delivery("e-freeze", URI, DIGEST)
        direct_vm.sender = direct_alice
        oracle.close_engagement("e-freeze")

        direct_vm.sender = direct_bob
        try:
            oracle.submit_delivery("e-freeze", "https://provider.test/other", DIGEST)
        except Exception:
            pass
        else:
            raise AssertionError("the delivery was still editable after the engagement closed")
        assert oracle.delivery_of("e-freeze")["uri"] == URI

    def test_a_malformed_digest_is_refused_at_the_door(
        self, oracle, direct_vm, direct_alice, direct_bob
    ):
        """A digest that cannot match would park the engagement permanently in
        `unverified`, the one state that cannot forfeit -- so refusing it is
        what stops a provider opting out of judgement."""
        _engagement(oracle, direct_vm, direct_alice, direct_bob, "e-digest")
        direct_vm.sender = direct_bob
        for bad in ("", "abc", "z" * 64, DIGEST[:-1]):
            try:
                oracle.submit_delivery("e-digest", URI, bad)
            except Exception:
                continue
            raise AssertionError(f"accepted {bad!r} as a sha256 digest")


class TestAClaimCannotRedirectCollateral:
    """The review's sentence itself."""

    def test_a_false_accusation_cannot_take_a_delivered_provider_collateral(
        self, oracle, direct_vm, direct_alice, direct_bob
    ):
        """The attack, run end to end, against a provider who did the work.

        Everything the attacker controls is set to its most favourable value:
        the claim is specific and confident, and the model returns exactly the
        grade that forfeits. The one thing they do not control is the artifact,
        and that is what decides it.
        """
        _engagement(oracle, direct_vm, direct_alice, direct_bob, "e-attack")
        direct_vm.sender = direct_bob
        oracle.submit_delivery("e-attack", URI, DIGEST)
        direct_vm.sender = direct_alice
        oracle.close_engagement("e-attack")

        direct_vm.mock_web(r"provider\.test", {"status": 200, "body": ARTIFACT})
        _grader_that_reads_the_deliverable(direct_vm)

        attestation = _attest(oracle, direct_vm, direct_alice, "e-attack")

        assert oracle.get_attestation(attestation)["delivery"] == "verified", (
            "the graders did not establish the artifact, so the grade still "
            "rested on the claim"
        )
        state = oracle.get_engagement("e-attack")["collateral_state"]
        assert state != "forfeit", (
            "a false accusation forfeited a delivered provider's collateral -- "
            "the review's objection is still open"
        )

    def test_the_collateral_cannot_then_be_claimed(
        self, oracle, direct_vm, direct_alice, direct_bob
    ):
        """And the money does not move, which is the part that matters."""
        _engagement(oracle, direct_vm, direct_alice, direct_bob, "e-claim")
        direct_vm.sender = direct_bob
        oracle.submit_delivery("e-claim", URI, DIGEST)
        direct_vm.sender = direct_alice
        oracle.close_engagement("e-claim")
        direct_vm.mock_web(r"provider\.test", {"status": 200, "body": ARTIFACT})
        _grader_that_reads_the_deliverable(direct_vm)
        _attest(oracle, direct_vm, direct_alice, "e-claim")

        direct_vm.sender = direct_alice
        owed_before = int(oracle.owed_to(address(direct_alice)))
        try:
            oracle.claim_collateral("e-claim")
        except Exception:
            pass
        assert int(oracle.owed_to(address(direct_alice))) == owed_before, (
            "the accuser was credited the provider's collateral"
        )

    def test_a_provider_who_delivered_nothing_still_forfeits(
        self, oracle, direct_vm, direct_alice, direct_bob
    ):
        """The other half. Binding the forfeit to an artifact must not become a
        shield for a provider who never produced one: with no commitment there
        is no signed delivery, and that absence is an on-chain fact rather than
        the client's word for it.
        """
        _engagement(oracle, direct_vm, direct_alice, direct_bob, "e-nothing")
        direct_vm.sender = direct_alice
        oracle.close_engagement("e-nothing")
        direct_vm.mock_llm(r".*", DAMNING)

        attestation = _attest(oracle, direct_vm, direct_alice, "e-nothing")
        assert oracle.get_attestation(attestation)["delivery"] == "absent"
        assert oracle.get_engagement("e-nothing")["collateral_state"] == "forfeit", (
            "a provider who committed no delivery kept their collateral anyway"
        )

    def test_an_artifact_that_does_not_match_its_commitment_is_not_graded(
        self, oracle, direct_vm, direct_alice, direct_bob
    ):
        """Swapping the file after committing the digest establishes nothing.

        The retrieved bytes are discarded rather than graded, so whoever can
        write to that host cannot decide the outcome either way.
        """
        _engagement(oracle, direct_vm, direct_alice, direct_bob, "e-swap")
        direct_vm.sender = direct_bob
        oracle.submit_delivery("e-swap", URI, DIGEST)
        direct_vm.sender = direct_alice
        oracle.close_engagement("e-swap")

        direct_vm.mock_web(r"provider\.test", {"status": 200, "body": b"a different file"})
        direct_vm.mock_llm(r".*", DAMNING)

        attestation = _attest(oracle, direct_vm, direct_alice, "e-swap")
        assert oracle.get_attestation(attestation)["delivery"] == "unverified"
        assert oracle.get_engagement("e-swap")["collateral_state"] != "forfeit", (
            "an unestablished deliverable was enough to take the collateral"
        )
