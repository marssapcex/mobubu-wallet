// Reference prover for the separately pinned HCFR research verifiers. No note openings, AIR or ZK.
// The hash is injected (Node crypto in tests, standard BLAKE2b-512 in a browser).
// This implementation caps distinct evaluation count; it is not a general trace prover.
import { GOLDILOCKS as P } from '../../testnet/networks.mjs';

export function makeFriReference(params, version, domain) {
  const D = 1 << params.maxDegreeLog;
  const LOG_N = params.maxDegreeLog + params.blowupLog;
  const ROUNDS = params.maxFoldRounds;
  const N_QUERIES = params.queries;
  const RADIX = params.foldRadix;
  const WIDTH = params.extensionDegree;
  const DIGEST = params.digestBits / 8;
  const MAGIC = Uint8Array.of(0x48, 0x43, 0x46, 0x52, version, WIDTH, LOG_N, N_QUERIES);
  const DOMAIN = new TextEncoder().encode(domain);
  const HEIGHTS = Array.from({ length: ROUNDS }, (_, i) => LOG_N - 3 * (i + 1));
  const MAX_DISTINCT_EVALS = 1 << 15;
  const HEADER_BYTES = MAGIC.length + ROUNDS * DIGEST + WIDTH * 8;
  const QUERY_BYTES = HEIGHTS.reduce((n, height) => n + RADIX * WIDTH * 8 + height * DIGEST, 0);

  function concat(...parts) {
    const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
    let at = 0;
    for (const part of parts) { out.set(part, at); at += part.length; }
    return out;
  }
  function num(n) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n, false);
    return b;
  }
  function words(values) {
    const out = new Uint8Array(8 * values.length);
    const view = new DataView(out.buffer);
    for (let i = 0; i < values.length; ++i) view.setBigUint64(i * 8, values[i], true);
    return out;
  }
  function read(data, at) {
    return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(at, true);
  }

  function framedHasher(hash) {
    const get = (type, ...parts) => {
      const out = hash(concat(DOMAIN, Uint8Array.of(type), ...parts));
      if (!(out instanceof Uint8Array) || out.length !== DIGEST) throw new Error('Expected a BLAKE2b-512 digest');
      return out;
    };
    return {
      start: (context) => get(0, num(context.length), context),
      absorb: (state, tag, data) => get(1, state, Uint8Array.of(tag), num(data.length), data),
      challenge(state, tag) {
        for (let retry = 0; retry < 8; ++retry) {
          const next = get(2, state, Uint8Array.of(tag), num(retry));
          const value = Array.from({ length: WIDTH }, (_, i) => read(next, i * 8));
          if (value.every((v) => v < P)) return { value, next };
        }
        throw new Error('Wide challenge exhausted');
      },
      leaf: (layer, row) => get(3, Uint8Array.of(layer), num(row.length), row),
      parent: (layer, l, r) => get(4, Uint8Array.of(layer), l, r),
      queryBlock: (state, counter) => get(5, state, num(counter)),
      sessionKey: (context, header) => get(6, get(0, num(context.length), context), header),
    };
  }

  const ZERO = Object.freeze(Array(WIDTH).fill(0n));
  const ONE = Object.freeze([1n, ...ZERO.slice(1)]);
  const add = (a, b) => a.map((v, i) => (v + b[i]) % P);
  const sub = (a, b) => a.map((v, i) => (v + P - b[i]) % P);
  const scale = (a, v) => a.map((c) => c * v % P);
  function mul(a, b) {
    const c = Array(2 * WIDTH - 1).fill(0n);
    for (let i = 0; i < WIDTH; ++i) for (let j = 0; j < WIDTH; ++j) c[i + j] += a[i] * b[j];
    for (let i = WIDTH; i < c.length; ++i) c[i - WIDTH] += 7n * c[i];
    return c.slice(0, WIDTH).map((v) => v % P);
  }
  function powBase(a, exponent) {
    let result = 1n;
    for (let k = BigInt(exponent); k !== 0n; k >>= 1n) {
      if (k & 1n) result = result * a % P;
      a = a * a % P;
    }
    return result;
  }
  const omega = (size) => powBase(7n, (P - 1n) / BigInt(size));

  function evaluations(poly, size) {
    // If the polynomial is g(X^stride), its evaluation vector is periodic. The
    // repeated subtrees retain their exact original size/depth in the proof.
    let mix = 0;
    for (const i of poly.keys()) mix |= i;
    const stride = mix ? mix & -mix : size;
    const period = size / stride;
    if (period > MAX_DISTINCT_EVALS) throw new Error('Reference prover exceeds its distinct evaluation cap');
    const v = Array(period).fill(ZERO);
    for (const [i, c] of poly) v[i / stride] = c;
    for (let i = 1, j = 0; i < period; ++i) {
      let bit = period >> 1;
      while (j & bit) { j ^= bit; bit >>= 1; }
      j ^= bit;
      if (i < j) [v[i], v[j]] = [v[j], v[i]];
    }
    for (let len = 2; len <= period; len *= 2) {
      const factor = omega(len);
      for (let at = 0; at < period; at += len) {
        let root = 1n;
        for (let j = 0; j < len / 2; ++j) {
          const u = v[at + j];
          const w = scale(v[at + j + len / 2], root);
          v[at + j] = add(u, w);
          v[at + j + len / 2] = sub(u, w);
          root = root * factor % P;
        }
      }
    }
    return v;
  }

  function buildTree(h, round, poly) {
    const size = 1 << (HEIGHTS[round] + 3);
    const nLeaves = size / RADIX;
    const values = evaluations(poly, size);
    const leaves = Array.from({ length: Math.min(nLeaves, values.length) }, (_, at) =>
      words(Array.from({ length: RADIX }, (_, j) => values[(at + j * nLeaves) % values.length]).flat()));
    const layers = [leaves.map((row) => h.leaf(round, row))];
    while (layers.length <= HEIGHTS[round]) {
      const lower = layers.at(-1);
      const count = Math.max(1, lower.length / 2);
      layers.push(Array.from({ length: count }, (_, i) => h.parent(round, lower[2 * i], lower[(2 * i + 1) % lower.length])));
    }
    return { leaves, layers, root: layers.at(-1)[0] };
  }

  function foldCoefficients(poly, alpha) {
    // Compute on coefficients, not using the verifier's DFT/coset evaluation formula.
    const powers = [ONE];
    for (let k = 1; k < RADIX; ++k) powers.push(mul(powers[k - 1], alpha));
    const next = new Map();
    for (const [i, c] of poly) {
      const j = Math.floor(i / RADIX);
      next.set(j, add(next.get(j) ?? ZERO, mul(c, powers[i % RADIX])));
    }
    return next;
  }

  function proveFri(coefficients, context, hash) {
    if (!(context instanceof Uint8Array) || context.length > 1024) throw new Error('Invalid wide FRI context');
    if (!(coefficients instanceof Map)) throw new Error('Expected sparse coefficients Map');
    let poly = new Map();
    for (const [exp, c] of coefficients) {
      if (!Number.isInteger(exp) || exp < 0 || exp >= D || !Array.isArray(c) || c.length !== WIDTH ||
          [...c].some((v) => typeof v !== 'bigint' || v < 0n || v >= P)) throw new Error('Invalid wide FRI coefficients');
      if (c.some((v) => v !== 0n)) poly.set(exp, c);
    }
    const h = framedHasher(hash);
    let state = h.start(concat(MAGIC, context));
    const trees = [];
    for (let r = 0; r < ROUNDS; ++r) {
      const tree = buildTree(h, r, poly);
      trees.push(tree);
      const { value, next } = h.challenge(h.absorb(state, r, tree.root), r);
      poly = foldCoefficients(poly, value);
      state = next;
    }
    const last = words(poly.get(0) ?? ZERO);
    const header = concat(MAGIC, ...trees.map((tree) => tree.root), last);
    const seed = h.absorb(state, 255, last);
    const queries = new Uint8Array(N_QUERIES * QUERY_BYTES);
    const positions = [];
    let draws;
    let at = 0;
    for (let q = 0; q < N_QUERIES; ++q) {
      if (q % 8 === 0) draws = h.queryBlock(seed, q / 8);
      let i = Number(read(draws, (q % 8) * 8) & ((1n << BigInt(LOG_N)) - 1n));
      positions.push(i);
      for (let r = 0; r < ROUNDS; ++r) {
        const { leaves, layers } = trees[r];
        i %= 1 << HEIGHTS[r];
        const row = leaves[i % leaves.length];
        queries.set(row, at);
        at += row.length;
        let k = i;
        for (const layer of layers.slice(0, -1)) {
          queries.set(layer[(k ^ 1) % layer.length], at);
          at += DIGEST;
          k >>= 1;
        }
      }
    }
    return { header, queries, positions };
  }

  // Nonconstant full-domain benchmark whose evaluations have a short period.
  // The 2^24 domain and all Merkle paths still have their full original length.
  function benchmarkCoefficients() {
    return new Map([0, 1, 5, 30, 63].map((j, i) => [4096 * j, Array.from({ length: WIDTH }, (_, k) => (P - 1n - 675n * BigInt(k + 1) * BigInt(i + 1)) ** 2n % P)]));
  }
  return Object.freeze({ benchmarkCoefficients, framedHasher, HEADER_BYTES, mul, powBase, proveFri, QUERY_BYTES });
}
