"""Real, native proofs; all balances in this file are simulation counters."""
from dataclasses import asdict, replace
from hashlib import shake_256
import json
import os
from pathlib import Path
import subprocess
import sys
from time import perf_counter
import unittest

from lazer_spend import (
    DepositTree, NOTE_BYTES, Scope, Spend, commitment, nullifier, profile,
    prove, verify,
)

DENOMINATION = 10**16
SCOPE = Scope(31_337, bytes.fromhex("11" * 20), DENOMINATION)
ALICE, BOB = bytes.fromhex("22" * 20), bytes.fromhex("33" * 20)
MEASUREMENTS = {}


def fixture_note(index):
    # Public fixture openings, NOT wallet secrets. Prover randomness is still OS-generated.
    return shake_256(b"mobubu-lazer-test-note/" + bytes((index,))).digest(NOTE_BYTES)


class PaymentHarness:
    """No real ETH, callbacks or network. Model expected state transitions."""
    def __init__(self, depth):
        self.tree = DepositTree(depth)
        self.scope = SCOPE
        self.history = set()
        self.balance = 0
        self.paid = {}
        self.spent = set()
        self.reject_recipient = set()

    def fund(self, c, wei):
        if wei != self.scope.denomination:
            raise ValueError("incorrect simulated deposit amount")
        index = self.tree.append(c)
        self.history.add((self.tree.root, self.tree.count))
        self.balance += wei
        return index

    def snapshot(self):
        return self.balance, self.paid.copy(), self.spent.copy(), self.history.copy()

    def spend(self, request, proof):
        if (request.scope != self.scope or request.depth != self.tree.depth or
                (request.root, request.count) not in self.history or request.nullifier in self.spent or
                self.balance < self.scope.denomination):
            return False
        if not verify(request, proof):
            return False
        if request.recipient in self.reject_recipient:
            return False  # Simulated payout failure: do not consume the note.
        self.spent.add(request.nullifier)
        self.balance -= self.scope.denomination
        self.paid[request.recipient] = self.paid.get(request.recipient, 0) + self.scope.denomination
        return True


def make_request(tree, recipient, note):
    return Spend(SCOPE, tree.depth, tree.count, recipient, tree.root, nullifier(SCOPE, note))


def make_proof(request, note, index, path, *, measure=False):
    start = perf_counter()
    proof = prove(request, note, index, path)
    after_prove = perf_counter()
    if measure:
        if not verify(request, proof):
            raise AssertionError("fresh proof did not verify")
        elapsed = perf_counter() - after_prove
        info = profile(request)
        assert info.proof_bytes == len(proof)
        zero = proof.count(0)
        MEASUREMENTS[request.depth] = {
            **asdict(info), "zero_bytes": zero,
            "proof_only_floor_gas": 21_000 + 10 * (zero + 4 * (len(proof) - zero)),
            "prove_ms": round(1000 * (after_prove - start), 2),
            "verify_ms": round(1000 * elapsed, 2),
        }
    return proof


class SpendTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ledger = PaymentHarness(3)
        cls.note = fixture_note(1)
        for i in range(4):
            cls.ledger.fund(commitment(fixture_note(i)), DENOMINATION)
        cls.old = make_request(cls.ledger.tree, ALICE, cls.note)
        cls.path = cls.ledger.tree.path(1)
        cls.proof = make_proof(cls.old, cls.note, 1, cls.path, measure=True)
        cls.ledger.fund(commitment(fixture_note(4)), DENOMINATION)
        cls.current = make_request(cls.ledger.tree, BOB, cls.note)
        cls.current_proof = make_proof(cls.current, cls.note, 1, cls.ledger.tree.path(1))

    def test_verifier_process_needs_only_public_instance_and_bytes(self):
        script = """
import sys
from lazer_spend import INSTANCE_BYTES, verify_bytes
message = sys.stdin.buffer.read()
sys.exit(0 if verify_bytes(message[:INSTANCE_BYTES], message[INSTANCE_BYTES:]) else 1)
"""
        subprocess.run(
            [sys.executable, "-c", script], input=self.old.encode() + self.proof,
            env={**os.environ, "PYTHONPATH": str(Path(__file__).resolve().parent)},
            timeout=60, check=True,
        )

    def test_rebinds_every_public_field(self):
        self.assertNotEqual(self.current.root, self.old.root)
        self.assertEqual(self.current.nullifier, self.old.nullifier)
        self.assertNotEqual(self.current_proof, self.proof)
        self.assertTrue(verify(self.current, self.current_proof))
        cases = {
            "recipient": replace(self.old, recipient=BOB),
            "unknown root": replace(self.old, root=bytes(512)),
            "another known root": replace(self.old, root=self.current.root, count=self.current.count),
            "count only": replace(self.old, count=self.old.count + 1),
            "asset": replace(self.old, scope=replace(SCOPE, asset=ALICE)),
            "chain": replace(self.old, scope=replace(SCOPE, chain_id=SCOPE.chain_id + 1)),
            "vault": replace(self.old, scope=replace(SCOPE, vault=BOB)),
            "denomination": replace(self.old, scope=replace(SCOPE, denomination=DENOMINATION + 1)),
            "version": replace(self.old, scope=replace(SCOPE, version=2)),
            "nullifier": replace(self.old, nullifier=bytes([self.old.nullifier[0] ^ 1]) + self.old.nullifier[1:]),
        }
        for field, request in cases.items():
            with self.subTest(field=field):
                self.assertFalse(verify(request, self.proof))
        self.assertNotEqual(nullifier(replace(SCOPE, chain_id=1), self.note), self.old.nullifier)

    def test_wrong_secret_is_not_a_witness(self):
        # A funded note at index 0 cannot use the target's index and tag.
        for wrong in (fixture_note(0), fixture_note(9)):
            with self.assertRaisesRegex(ValueError, "could not prove"):
                prove(self.old, wrong, 1, self.path)
        with self.assertRaisesRegex(ValueError, "could not prove"):
            prove(self.old, self.note, 0, self.path)
        with self.assertRaisesRegex(ValueError, "outside the funded prefix"):
            prove(self.old, self.note, self.old.count, self.path)

    def test_bad_wire_rejected(self):
        invalid = (b"", self.proof[:-1], self.proof + b"\0", b"bad!" + self.proof[4:],
                   self.proof[:-1] + bytes([self.proof[-1] ^ 1]))
        for i, proof in enumerate(invalid):
            with self.subTest(case=i):
                self.assertFalse(verify(self.old, proof))
        with self.assertRaises(ValueError):
            profile(replace(self.old, depth=1))

    def test_unfunded_padding_does_not_authorize_spending(self):
        # H(0) = 0; index 7 is public padding with a known opening. It can
        # only prove against an invented count, which the state never recorded.
        index = 7
        tree = self.ledger.tree
        empty = bytes(NOTE_BYTES)
        path = tuple(tree._get(level, (index >> level) ^ 1) for level in range(tree.depth))
        request = make_request(tree, ALICE, empty)
        with self.assertRaisesRegex(ValueError, "outside the funded prefix"):
            prove(request, empty, index, path)
        fake = replace(request, count=index + 1)
        proof = make_proof(fake, empty, index, path)
        self.assertTrue(verify(fake, proof))  # Cryptographic verifier does not own the ledger.
        self.assertFalse(verify(request, proof))
        before = self.ledger.snapshot()
        self.assertFalse(self.ledger.spend(fake, proof))
        self.assertEqual(self.ledger.snapshot(), before)

    def test_state_checks_payout_failure_and_replay(self):
        ledger = self.ledger
        before = ledger.snapshot()
        for statement, proof in (
            (replace(self.current, recipient=ALICE), self.current_proof),
            (replace(self.current, scope=replace(SCOPE, chain_id=1)), self.current_proof),
            (replace(self.current, root=bytes(512)), self.current_proof),
            (self.current, self.proof),
            (self.old, self.proof[:-1]),
        ):
            self.assertFalse(ledger.spend(statement, proof))
            self.assertEqual(ledger.snapshot(), before)
        ledger.reject_recipient.add(ALICE)
        self.assertFalse(ledger.spend(self.old, self.proof))
        self.assertEqual(ledger.snapshot(), before)
        ledger.reject_recipient.clear()
        self.assertTrue(ledger.spend(self.old, self.proof))
        self.assertEqual(ledger.balance, 4 * DENOMINATION)
        self.assertEqual(ledger.paid, {ALICE: DENOMINATION})
        self.assertEqual(ledger.spent, {self.old.nullifier})
        after = ledger.snapshot()
        self.assertFalse(ledger.spend(self.old, self.proof))
        self.assertFalse(ledger.spend(self.current, self.current_proof))
        self.assertEqual(ledger.snapshot(), after)

    def test_deposit_rejects_duplicates_and_wrong_amounts(self):
        ledger = PaymentHarness(3)
        c = commitment(fixture_note(0))
        before = ledger.snapshot()
        with self.assertRaises(ValueError):
            ledger.fund(c, DENOMINATION + 1)
        with self.assertRaises(ValueError):
            ledger.fund(bytes(512), DENOMINATION)
        self.assertEqual(ledger.snapshot(), before)
        ledger.fund(c, DENOMINATION)
        after = ledger.snapshot()
        with self.assertRaises(ValueError):
            ledger.fund(c, DENOMINATION)
        self.assertEqual(ledger.snapshot(), after)

    def test_depth_twenty_real_deposit_root(self):
        ledger = PaymentHarness(20)
        for i in range(5):
            ledger.fund(commitment(fixture_note(i)), DENOMINATION)
        note = fixture_note(3)
        request = make_request(ledger.tree, BOB, note)
        proof = make_proof(request, note, 3, ledger.tree.path(3), measure=True)
        self.assertTrue(ledger.spend(request, proof))
        self.assertEqual(ledger.paid, {BOB: DENOMINATION})
        self.assertEqual(ledger.balance, 4 * DENOMINATION)


if __name__ == "__main__":
    result = unittest.main(verbosity=2, exit=False).result
    if not result.wasSuccessful():
        sys.exit(1)
    root = Path(__file__).resolve().parents[2]
    build = Path(os.environ.get("MOBUBU_LAZER_BUILD_DIR", root / "build/lazer-spend"))
    text = json.dumps(MEASUREMENTS, indent=2) + "\n"
    (build / "measurements.json").write_text(text)
    print(text, end="")
