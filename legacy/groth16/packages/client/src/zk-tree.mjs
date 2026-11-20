import { poseidon2 } from "poseidon-lite/poseidon2";
import { SCALAR_FIELD, TREE_DEPTH, unsigned } from "./zk-format.mjs";

/** Sparse, fixed-depth index for confirmed Deposit logs; O(depth) append/path. */
class VaultTree {
  #hash;
  #empty = [0n];
  #levels = Array.from({ length: TREE_DEPTH + 1 }, () => new Map());
  #size = 0;
  #commitments = new Set();

  constructor(hash) {
    this.#hash = hash;
    for (let level = 0; level < TREE_DEPTH; level++) {
      this.#empty.push(hash(this.#empty[level], this.#empty[level]));
    }
  }

  get size() { return this.#size; }
  get root() { return this.#levels[TREE_DEPTH].get(0) ?? this.#empty[TREE_DEPTH]; }

  #insert(commitment, expectedRoot) {
    let current = unsigned(commitment, SCALAR_FIELD, "commitment");
    const index = this.#size;
    if (index >= 2 ** TREE_DEPTH) throw new Error("tree full");
    if (current === 0n || this.#commitments.has(current)) throw new Error("invalid or duplicate commitment");
    let cursor = index;
    const path = [current];
    for (let level = 0; level < TREE_DEPTH; level++) {
      current = cursor & 1
        ? this.#hash(this.#levels[level].get(cursor - 1), current)
        : this.#hash(current, this.#empty[level]);
      path.push(current);
      cursor >>= 1;
    }
    if (expectedRoot !== undefined && current !== expectedRoot) throw new Error("deposit root does not match local tree");
    // Only publish mutations after the log has been checked.
    for (let level = 0; level <= TREE_DEPTH; level++) {
      this.#levels[level].set(index >> level, path[level]);
    }
    this.#size++;
    this.#commitments.add(path[0]);
    return index;
  }

  /** Preflight all inserts before a synchronous update touching multiple trees. */
  assertCanAppend(commitments) {
    if (this.#size + commitments.length > 2 ** TREE_DEPTH) throw new Error("tree full");
    const seen = new Set();
    for (const commitment of commitments) {
      const leaf = unsigned(commitment, SCALAR_FIELD, "commitment");
      if (leaf === 0n || this.#commitments.has(leaf) || seen.has(leaf)) throw new Error("invalid or duplicate commitment");
      seen.add(leaf);
    }
  }

  /** Offline append (e.g. local fixture or quote before transaction inclusion). */
  append(commitment) { return this.#insert(commitment); }

  /** Append canonical insert logs in index order, including v3 change leaves. */
  appendDeposit({ commitment, leafIndex, root }) {
    if (typeof leafIndex !== "bigint" || leafIndex !== BigInt(this.#size)) throw new Error("unexpected deposit index");
    return this.#insert(commitment, unsigned(root, SCALAR_FIELD, "root"));
  }

  path(index) {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.#size) throw new RangeError("unknown leaf index");
    const pathElements = [], pathIndices = [];
    let cursor = index;
    for (let level = 0; level < TREE_DEPTH; level++) {
      pathElements.push((this.#levels[level].get(cursor ^ 1) ?? this.#empty[level]).toString());
      pathIndices.push(String(cursor & 1));
      cursor >>= 1;
    }
    return { leaf: this.#levels[0].get(index), root: this.root, pathElements, pathIndices };
  }
}

export function createVaultTree() { return new VaultTree((left, right) => poseidon2([left, right])); }
