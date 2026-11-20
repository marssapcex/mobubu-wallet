/* Research-only LaZer spend relation. No network, Ethereum calls or payout. */
#include <sys/types.h>
#include <string.h>
#include "fips202.h"
#include "labrados_python.h"
#include "malloc.h"
#include "wire.h"
#include "ajtai.h"

#define API __attribute__((visibility("default")))
enum {
    D = 512, NOTE_POLYS = 16, NODE_BITS = 8, TAG_POLYS = 2, LIFT_BASE = 128,
    SCOPE = 108, COUNT = SCOPE + 1, RECIPIENT = COUNT + 4, ROOT = RECIPIENT + 20,
    TAG = ROOT + D, INSTANCE = TAG + D, MAX_DEPTH = 20, MAX_TERMS = 64,
};
_Static_assert(D == 2 * N && LOGQ == 38, "wrong LaBRADOS profile");
_Static_assert(MAX_TERMS >= 2 * MAX_DEPTH && MAX_TERMS >= 26, "equation buffer too small");

typedef int64_t coeffs[D];
typedef int16_t matrix_row[D];

static int nonzero(const uint8_t *v, size_t n) {
    uint8_t x = 0;
    for (size_t i = 0; i < n; ++i) x |= v[i];
    return x != 0;
}

static int valid_scope(const uint8_t scope[SCOPE]) {
    // version[4] || chain[32] || vault[20] || asset[20] || wei[32], big endian.
    return !memcmp(scope, "\0\0\0\1", 4) && nonzero(scope + 4, 32) &&
           nonzero(scope + 36, 20) && nonzero(scope + 76, 32);
}

static size_t count_be(const uint8_t *p) {
    return ((size_t)p[0] << 24) | ((size_t)p[1] << 16) | ((size_t)p[2] << 8) | p[3];
}

static int valid_instance(const uint8_t input[INSTANCE]) {
    size_t depth = input[SCOPE], count = count_be(input + COUNT);
    if (!valid_scope(input) || (depth != 3 && depth != 20) ||
        count == 0 || count > (1u << depth) || !nonzero(input + RECIPIENT, 20)) return 0;
    for (size_t j = 0; j < D; ++j) if (input[TAG + j] >= 64) return 0;
    return 1;
}

// Exact negacyclic product (X^512 = -1). This is a small trace generator,
// not a constant-time/optimized wallet implementation.
static void add_product(coeffs out, const matrix_row a, const coeffs b, int sign) {
    for (size_t i = 0; i < D; ++i) {
        int64_t v = (int64_t)a[i] * sign;
        for (size_t j = 0; j < D - i; ++j) out[i + j] += v * b[j];
        for (size_t j = D - i; j < D; ++j) out[i + j - D] -= v * b[j];
    }
}

static void unpack_node(coeffs *bits, const uint8_t node[D], size_t nbits) {
    for (size_t k = 0; k < nbits; ++k)
        for (size_t j = 0; j < D; ++j) bits[k][j] = (node[j] >> k) & 1;
}

static void unpack_note(coeffs *bits, const uint8_t *note, size_t n) {
    for (size_t k = 0; k < n; ++k)
        for (size_t j = 0; j < D; ++j) bits[k][j] = (note[k * (D / 8) + j / 8] >> (j % 8)) & 1;
}

static void dot(coeffs out, const matrix_row *a, const coeffs *b, size_t n) {
    memset(out, 0, sizeof(coeffs));
    for (size_t i = 0; i < n; ++i) add_product(out, a[i], b[i], 1);
}

static void tag_matrix(matrix_row a[TAG_POLYS], const uint8_t scope[SCOPE]) {
    static const uint8_t label[] = "mobubu/lazer-spend/v1/nullifier";
    uint8_t bytes[TAG_POLYS * D];
    shake256incctx ctx;
    shake256_inc_init(&ctx);
    shake256_inc_absorb(&ctx, label, sizeof(label));
    shake256_inc_absorb(&ctx, scope, SCOPE);
    shake256_inc_finalize(&ctx);
    shake256_inc_squeeze(bytes, sizeof(bytes), &ctx);
    for (size_t i = 0; i < TAG_POLYS; ++i)
        for (size_t j = 0; j < D; ++j) a[i][j] = (int16_t)bytes[i * D + j] - 128;
}

API void mobubu_commit(uint8_t leaf[D], const uint8_t note[NOTE_POLYS * D / 8]) {
    coeffs s[NOTE_POLYS], raw;
    unpack_note(s, note, NOTE_POLYS);
    dot(raw, ajtai, s, NOTE_POLYS);
    for (size_t j = 0; j < D; ++j) leaf[j] = (uint8_t)raw[j];
    explicit_bzero(s, sizeof(s));
    explicit_bzero(raw, sizeof(raw));
}

API void mobubu_parent(uint8_t out[D], const uint8_t left[D], const uint8_t right[D]) {
    coeffs bits[2 * NODE_BITS], raw;
    unpack_node(bits, left, NODE_BITS);
    unpack_node(bits + NODE_BITS, right, NODE_BITS);
    dot(raw, ajtai, bits, 2 * NODE_BITS);
    for (size_t j = 0; j < D; ++j) out[j] = (uint8_t)raw[j];
}

API int mobubu_nullifier(uint8_t tag[D], const uint8_t scope[SCOPE], const uint8_t *note) {
    if (!valid_scope(scope)) return 0;
    matrix_row a[TAG_POLYS];
    coeffs s[TAG_POLYS], raw;
    tag_matrix(a, scope);
    unpack_note(s, note, TAG_POLYS);
    dot(raw, a, s, TAG_POLYS);
    for (size_t j = 0; j < D; ++j) tag[j] = (uint8_t)raw[j] >> 2;
    explicit_bzero(s, sizeof(s));
    explicit_bzero(raw, sizeof(raw));
    return 1;
}

typedef struct {
    size_t n, ids[MAX_TERMS], lens[MAX_TERMS];
    coeffs phi[MAX_TERMS];
} eq;

static void term(eq *e, size_t i, int64_t constant, const int16_t *a, const int16_t *sub) {
    e->ids[e->n] = i;
    e->lens[e->n] = 1;
    coeffs *p = &e->phi[e->n++];
    if (a) {
        for (size_t j = 0; j < D; ++j) (*p)[j] = constant * (a[j] - (sub ? sub[j] : 0));
    } else {
        memset(p, 0, sizeof(*p));
        (*p)[0] = constant;
    }
}

static void node_terms(eq *e, size_t i, int sign) {
    for (size_t b = 0; b < NODE_BITS; ++b) term(e, i + b, sign * (1L << b), NULL, NULL);
}

static void lift_terms(eq *e, size_t i) {
    term(e, i, -256, NULL, NULL);
    term(e, i + 1, -256 * LIFT_BASE, NULL, NULL);
}

static int append(statement st, eq *e, coeffs rhs, size_t *dir, size_t *delta) {
    int rc;
    if (dir) {
        int64_t one = 1;
        rc = py_append_quadratic(st, e->n, 1, e->ids, dir, delta, e->lens, 2, &one, *e->phi, rhs);
    } else {
        rc = py_append_constraint(st, e->n, e->ids, e->lens, 2, *e->phi, rhs, 1);
    }
    e->n = 0;
    return rc == 0;
}

// The three integer lifts used by the relation have a balanced radix-128
// low limb and a small signed high limb. The per-limb l2 bound accepted by
// the approximate proof is 2^21. Even with both limbs at that bound, no
// ring coefficient can wrap modulo 2^38-107 in a lifted hash equation.
static void trace_lift(coeffs *v, const coeffs raw, const coeffs residue) {
    for (size_t j = 0; j < D; ++j) {
        int64_t k = (raw[j] - residue[j]) / 256;
        v[0][j] = ((uint64_t)(k + 64) & 127) - (int64_t)64;
        v[1][j] = (k - v[0][j]) / LIFT_BASE;
    }
}

// Witness layout is deterministic and precedes decoding. In the verifier
// private == NULL: no witness or deposit index is used to build the statement.
static int build_statement(statement st, witness wt, const uint8_t input[INSTANCE],
                           const uint8_t *note, size_t index, const uint8_t *siblings) {
    const size_t depth = input[SCOPE];
    const size_t exact_count = count_be(input + COUNT);
    const size_t n_approx = 4 + 5 * depth;
    const size_t secret = n_approx, leaf = secret + NOTE_POLYS, low = leaf + NODE_BITS;
    const size_t branch = low + 2, n = branch + 18 * depth;
    size_t dims[n];
    uint64_t norms[n], required[n];
    normtype types[n];
    for (size_t i = 0; i < n; ++i) {
        dims[i] = 2;
        types[i] = i < n_approx ? L2APPROX : BIN;
        norms[i] = i >= n_approx ? D : ((i >= 4 && (i - 4) % 5 == 0) ? (1u << 23) : (1u << 21));
        required[i] = i < n_approx ? (UINT64_C(1) << 42) : 0;
    }
    py_init_statement(st, n, dims, norms, required, types, 4 + 2 * depth, 0, 2 * depth);
    coeffs *v = note ? calloc(n, sizeof(coeffs)) : NULL;
    eq *e = calloc(1, sizeof(eq));
    if (!e || (note && !v)) goto fail;
    matrix_row tap[TAG_POLYS];
    tag_matrix(tap, input);
    coeffs raw, residue, rhs = {0};
    if (v) {
        unpack_note(v + secret, note, NOTE_POLYS);
        dot(raw, ajtai, v + secret, NOTE_POLYS);
        uint8_t image[D];
        for (size_t j = 0; j < D; ++j) image[j] = residue[j] = (uint8_t)raw[j];
        unpack_node(v + leaf, image, NODE_BITS);
        trace_lift(v, raw, residue);

        dot(raw, tap, v + secret, TAG_POLYS);
        for (size_t j = 0; j < D; ++j) {
            residue[j] = (uint8_t)raw[j];
            v[low][j] = residue[j] & 1;
            v[low + 1][j] = (residue[j] >> 1) & 1;
        }
        trace_lift(v + 2, raw, residue);
    }

    // H(s) = leaf, and LWR_T(s[0:2]) = public tag. Both reference the same s.
    for (size_t j = 0; j < NOTE_POLYS; ++j) term(e, secret + j, 1, ajtai[j], NULL);
    node_terms(e, leaf, -1);
    lift_terms(e, 0);
    if (!append(st, e, rhs, NULL, NULL)) goto fail;
    for (size_t j = 0; j < TAG_POLYS; ++j) term(e, secret + j, 1, tap[j], NULL);
    term(e, low, -1, NULL, NULL);
    term(e, low + 1, -2, NULL, NULL);
    lift_terms(e, 2);
    for (size_t j = 0; j < D; ++j) rhs[j] = 4 * input[TAG + j];
    if (!append(st, e, rhs, NULL, NULL)) goto fail;
    memset(rhs, 0, sizeof(rhs));

    size_t child = leaf;
    for (size_t k = 0; k < depth; ++k) {
        size_t sib = branch + 18 * k, parent = sib + NODE_BITS;
        size_t dir = parent + NODE_BITS, slack = dir + 1;
        size_t delta = 4 + 5 * k;
        if (v) {
            int direction = (index >> k) & 1;
            v[dir][0] = direction;
            v[slack][0] = ((exact_count - 1 - index) >> k) & 1;
            unpack_node(v + sib, siblings + k * D, NODE_BITS);
            memset(raw, 0, sizeof(raw));
            for (size_t j = 0; j < NODE_BITS; ++j) {
                add_product(raw, ajtai[j], v[sib + j], 1);
                add_product(raw, ajtai[j], v[child + j], -1);
                add_product(raw, ajtai[j + NODE_BITS], v[sib + j], -1);
                add_product(raw, ajtai[j + NODE_BITS], v[child + j], 1);
            }
            for (size_t j = 0; j < D; ++j) v[delta][j] = (int64_t)(uint8_t)(raw[j] + 128) - 128;
            trace_lift(v + delta + 1, raw, v[delta]);
            dot(raw, ajtai, v + child, NODE_BITS);
            for (size_t j = 0; j < NODE_BITS; ++j)
                add_product(raw, ajtai[j + NODE_BITS], v[sib + j], 1);
            uint8_t image[D];
            for (size_t j = 0; j < D; ++j) {
                raw[j] += direction * v[delta][j];
                image[j] = residue[j] = (uint8_t)raw[j];
            }
            unpack_node(v + parent, image, NODE_BITS);
            trace_lift(v + delta + 3, raw, residue);
        }
        for (size_t j = 0; j < NODE_BITS; ++j) {
            term(e, sib + j, 1, ajtai[j], ajtai[j + NODE_BITS]);
            term(e, child + j, -1, ajtai[j], ajtai[j + NODE_BITS]);
        }
        term(e, delta, -1, NULL, NULL);
        lift_terms(e, delta + 1);
        if (!append(st, e, rhs, NULL, NULL)) goto fail;

        // H(child,sib) + dir*delta mod 256 selects the order, without exposing dir.
        for (size_t j = 0; j < NODE_BITS; ++j) {
            term(e, child + j, 1, ajtai[j], NULL);
            term(e, sib + j, 1, ajtai[j + NODE_BITS], NULL);
        }
        node_terms(e, parent, -1);
        lift_terms(e, delta + 3);
        if (!append(st, e, rhs, &dir, &delta) || py_append_deg0_constraint(st, dir, 2) ||
            py_append_deg0_constraint(st, slack, 2)) goto fail;
        child = parent;
    }
    node_terms(e, child, 1);
    for (size_t j = 0; j < D; ++j) rhs[j] = input[ROOT + j];
    if (!append(st, e, rhs, NULL, NULL)) goto fail;

    // Secret index + secret (nonnegative) slack = count - 1. Each is in
    // [0, 2^depth), so this exact equality has no modulo-q alias. This
    // prevents spending a public, zero-padded slot, even with its opening.
    for (size_t k = 0; k < depth; ++k) {
        term(e, branch + 18 * k + 16, INT64_C(1) << k, NULL, NULL);
        term(e, branch + 18 * k + 17, INT64_C(1) << k, NULL, NULL);
    }
    memset(rhs, 0, sizeof(rhs));
    rhs[0] = exact_count - 1;
    if (!append(st, e, rhs, NULL, NULL)) goto fail;

    // Public recipient and scope must influence the initial challenge, not
    // merely be appended to the payload at a layer after verification.
    static const uint8_t label[] = "mobubu/lazer-spend/v1/statement";
    shake128incctx ctx;
    shake128_inc_init(&ctx);
    shake128_inc_absorb(&ctx, label, sizeof(label));
    shake128_inc_absorb(&ctx, input, INSTANCE);
    shake128_inc_absorb(&ctx, st->h, sizeof(st->h));
    shake128_inc_finalize(&ctx);
    shake128_inc_squeeze(st->h, sizeof(st->h), &ctx);

    if (v) {
        py_init_witness(wt, n, dims);
        for (size_t j = 0; j < n; ++j) py_set_witness_vector(wt, j, 1, 2, v[j]);
        explicit_bzero(v, n * sizeof(coeffs));
        explicit_bzero(raw, sizeof(raw));
        explicit_bzero(residue, sizeof(residue));
    }
    free(v);
    free(e);
    return 1;
fail:
    if (v) explicit_bzero(v, n * sizeof(coeffs));
    free(v);
    free(e);
    py_free_statement(st);
    return 0;
}

static int make_params(dch_pack_params pp, const statement st) {
    size_t estimated_bits;
    if (dch_pack_params_gen(pp, &estimated_bits, st, 1)) return 0;
    if (wire_supported(pp)) return 1;
    dch_pack_params_free(pp);
    return 0;
}

API size_t mobubu_profile(const uint8_t input[INSTANCE], uint64_t jl[3]) {
    statement st;
    dch_pack_params pp;
    size_t out = 0;
    if (!valid_instance(input) || !build_statement(st, NULL, input, NULL, 0, NULL)) return 0;
    if (make_params(pp, st)) {
        if (jl) wire_jl_profile(jl, pp);
        out = wire_size(pp);
        dch_pack_params_free(pp);
    }
    py_free_statement(st);
    return out;
}

API int mobubu_prove(uint8_t *out, size_t len, const uint8_t input[INSTANCE],
                     const uint8_t *note, uint32_t index, const uint8_t *siblings) {
    statement st;
    dch_pack_params pp;
    dch_pack_proof proof;
    witness w;
    int rc = 0;
    if (!valid_instance(input) || index >= count_be(input + COUNT) ||
        !build_statement(st, w, input, note, index, siblings)) return 0;
    // Run the full witness check before invoking a research prover that
    // expects a satisfying input (and may not terminate for bad inputs).
    if (py_simple_verify(st, w) && make_params(pp, st)) {
        if (len == wire_size(pp)) {
            dch_pack_prove(proof, st, w, pp);
            rc = wire_encode(out, len, pp, proof);
            wire_free(proof);
        }
        dch_pack_params_free(pp);
    }
    size_t polys = 0;
    for (size_t i = 0; i < w->r; ++i) polys += w->n[i];
    explicit_bzero(w->s[0], polys * sizeof(poly));
    py_free_witness(w);
    py_free_statement(st);
    return rc;
}

API int mobubu_verify(const uint8_t input[INSTANCE], const uint8_t *proof_bytes, size_t len) {
    statement st;
    dch_pack_params pp;
    dch_pack_proof proof;
    int rc = 0;
    if (!valid_instance(input) || !build_statement(st, NULL, input, NULL, 0, NULL)) return 0;
    if (make_params(pp, st)) {
        if (wire_decode(proof, pp, proof_bytes, len)) {
            rc = dch_pack_verify(st, pp, proof) == 1;
            wire_free(proof);
        }
        dch_pack_params_free(pp);
    }
    py_free_statement(st);
    return rc;
}
