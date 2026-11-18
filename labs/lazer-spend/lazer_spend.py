"""Opt-in native research client. This module cannot withdraw ETH."""
from ctypes import CDLL, c_char_p, c_int, c_size_t, c_uint32, c_uint64, create_string_buffer
from dataclasses import dataclass
from functools import lru_cache
import os
from pathlib import Path
from secrets import token_bytes
from threading import Lock

NODE_BYTES = 512
NOTE_BYTES = 1024
ZERO_ASSET = bytes(20)
INSTANCE_BYTES = 1157
SUPPORTED_DEPTHS = (3, 20)
_LOCK = Lock()  # The pinned proof backend uses a process-global commitment key.


def _bytes(value, size, name):
    if type(value) is not bytes or len(value) != size:
        raise ValueError(f"{name} must be exactly {size} bytes")
    return value


def _uint(value, size, name):
    if type(value) is not int or not 0 <= value < 1 << (8 * size):
        raise ValueError(f"{name} must be an unsigned {8 * size}-bit integer")
    return value.to_bytes(size, "big")


@dataclass(frozen=True)
class Scope:
    chain_id: int
    vault: bytes
    denomination: int
    asset: bytes = ZERO_ASSET
    version: int = 1

    def encode(self):
        return b"".join((
            _uint(self.version, 4, "version"), _uint(self.chain_id, 32, "chain ID"),
            _bytes(self.vault, 20, "vault"), _bytes(self.asset, 20, "asset"),
            _uint(self.denomination, 32, "denomination"),
        ))


@dataclass(frozen=True)
class Spend:
    scope: Scope
    depth: int
    count: int
    recipient: bytes
    root: bytes
    nullifier: bytes

    def encode(self):
        return b"".join((
            self.scope.encode(), _uint(self.depth, 1, "depth"), _uint(self.count, 4, "deposit count"),
            _bytes(self.recipient, 20, "recipient"), _bytes(self.root, NODE_BYTES, "root"),
            _bytes(self.nullifier, NODE_BYTES, "nullifier"),
        ))


@dataclass(frozen=True)
class Profile:
    proof_bytes: int
    jl_total_bytes: int
    jl_peak_bytes: int
    jl_largest_buffer: int


@lru_cache(maxsize=1)
def _native():
    root = Path(__file__).resolve().parents[2]
    directory = Path(os.environ.get("MOBUBU_LAZER_BUILD_DIR", root / "build/lazer-spend"))
    library = (directory / "libmobubu_lazer.so").resolve()
    if not library.is_file():
        raise RuntimeError("Build the lab first: bash labs/lazer-spend/build.sh")
    lib = CDLL(str(library))
    signatures = {
        "commit": (None, c_char_p, c_char_p),
        "parent": (None, c_char_p, c_char_p, c_char_p),
        "nullifier": (c_int, c_char_p, c_char_p, c_char_p),
        "profile": (c_size_t, c_char_p, c_uint64 * 3),
        "prove": (c_int, c_char_p, c_size_t, c_char_p, c_char_p, c_uint32, c_char_p),
        "verify": (c_int, c_char_p, c_char_p, c_size_t),
    }
    for name, (returns, *args) in signatures.items():
        function = getattr(lib, f"mobubu_{name}")
        function.restype, function.argtypes = returns, args
    return lib


def new_note():
    """Local only; never pass the returned secret to a verifier."""
    return token_bytes(NOTE_BYTES)


def commitment(note):
    out = create_string_buffer(NODE_BYTES)
    _native().mobubu_commit(out, _bytes(note, NOTE_BYTES, "note"))
    return out.raw


def parent_node(left, right):
    out = create_string_buffer(NODE_BYTES)
    _native().mobubu_parent(out, _bytes(left, NODE_BYTES, "left"), _bytes(right, NODE_BYTES, "right"))
    return out.raw


def nullifier(scope, note):
    out = create_string_buffer(NODE_BYTES)
    if _native().mobubu_nullifier(out, scope.encode(), _bytes(note, NOTE_BYTES, "note")) != 1:
        raise ValueError("invalid spend scope")
    return out.raw


def profile(spend):
    jl = (c_uint64 * 3)()
    with _LOCK:
        length = _native().mobubu_profile(spend.encode(), jl)
    if not length:
        raise ValueError("unsupported spend instance")
    return Profile(length, *jl)


def prove(spend, note, index, siblings):
    """Construct a randomized ZK proof from a note and bottom-up private path."""
    public = spend.encode()
    secret = _bytes(note, NOTE_BYTES, "note")
    if type(index) is not int or not 0 <= index < spend.count:
        raise ValueError("path index is outside the funded prefix")
    if len(siblings) != spend.depth:
        raise ValueError("wrong path depth")
    path = b"".join(_bytes(sibling, NODE_BYTES, "sibling") for sibling in siblings)
    out = create_string_buffer(profile(spend).proof_bytes)
    with _LOCK:
        if _native().mobubu_prove(out, len(out), public, secret, index, path) != 1:
            raise ValueError("LaZer could not prove this spend")
    return out.raw


def verify_bytes(instance, proof):
    """Verify an encoded public instance and a proof. No secret inputs.

    Caller must also enforce its own scope, funded-root history and unspent
    nullifier. The native verifier is a research artifact, not a public service.
    """
    if type(instance) is not bytes or len(instance) != INSTANCE_BYTES or type(proof) is not bytes:
        return False
    with _LOCK:
        return _native().mobubu_verify(instance, proof, len(proof)) == 1


def verify(spend, proof):
    try:
        instance = spend.encode()
    except ValueError:
        return False
    return verify_bytes(instance, proof)


class DepositTree:
    """Append-only sparse tree. On its own it has no knowledge of payments."""
    def __init__(self, depth):
        if type(depth) is not int or depth not in SUPPORTED_DEPTHS:
            raise ValueError("unsupported depth")
        self.depth = depth
        self.count = 0
        self._nodes = [{} for _ in range(depth + 1)]
        self._empty = [bytes(NODE_BYTES)]
        for _ in range(depth):
            self._empty.append(parent_node(self._empty[-1], self._empty[-1]))
        self._leaves = set()

    @property
    def root(self):
        return self._get(self.depth, 0)

    def _get(self, level, index):
        return self._nodes[level].get(index, self._empty[level])

    def append(self, leaf):
        _bytes(leaf, NODE_BYTES, "commitment")
        if leaf == self._empty[0] or leaf in self._leaves or self.count == 1 << self.depth:
            raise ValueError("empty or duplicate commitment, or tree is full")
        index = self.count
        pos = index
        self._nodes[0][pos] = leaf
        for level in range(self.depth):
            pos >>= 1
            self._nodes[level + 1][pos] = parent_node(self._get(level, 2 * pos), self._get(level, 2 * pos + 1))
        self._leaves.add(leaf)
        self.count += 1
        return index

    def path(self, index):
        if type(index) is not int or not 0 <= index < self.count:
            raise ValueError("path index is outside the funded prefix")
        return tuple(self._get(level, (index >> level) ^ 1) for level in range(self.depth))
