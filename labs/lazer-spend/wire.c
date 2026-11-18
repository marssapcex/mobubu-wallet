#include "wire.h"
#include "malloc.h"

#define MAGIC "LZS1"
#define HEADER 4u
#define QCOEFF_BYTES 5u

int wire_supported(const dch_pack_params params) {
    return params->pp_pack->zkp != NULL && params->pp_pack->np >= 3 &&
           params->pp_pack->zkround > 0 && params->pp_pack->zkround < params->pp_pack->np - 1 &&
           !params->pp_pack->p[params->pp_pack->np - 1]->compressed;
}

static size_t lab_polys(const lab_params p) {
    if (p->compressed) return 4 * p->kappa[2];
    if (p->tail) return p->len[LAB_INCOM] + p->len[LAB_QUADG] + p->len[LAB_LIFT] + p->len[LAB_LING];
    return 2 * p->kappa[1] + LIFTS;
}

static size_t lnp_polys(const lnp_params p) {
    return 4 * p->kappa_linfmsis + 256 / N;
}

size_t wire_size(const dch_pack_params params) {
    const pack_params *p = &params->pp_pack;
    const lab_params *last = &(*p)->p[(*p)->np - 1];
    size_t z = params->pp_dch->kappa_outer;
    size_t bytes = HEADER;
    for (size_t i = 0; i < (*p)->np; ++i) {
        if (i == (*p)->zkround) {
            z += lnp_polys((*p)->zkp[0]);
        } else {
            z += lab_polys((*p)->p[i]);
            if (!(*p)->p[i]->compressed) bytes += 256 * 4;
        }
    }
    size_t final_polys = (*last)->fz * (*last)->nmax;
    if (!(*last)->tail) final_polys += (*last)->len[LAB_INCOM] + (*last)->len[LAB_QUADG] + (*last)->len[LAB_LING];
    return bytes + z * N * QCOEFF_BYTES + final_polys * N * 2;
}

// Fixed-width little-endian signed integers, preserving the upstream signed
// representative (not reducing mod q, which changes its transcript encoding).
static void store(uint8_t **p, uint64_t x, size_t bytes) {
    for (size_t i = 0; i < bytes; ++i) *(*p)++ = (uint8_t)(x >> (8 * i));
}

static int64_t load(const uint8_t **p, size_t bytes) {
    uint64_t x = 0;
    for (size_t i = 0; i < bytes; ++i) x |= (uint64_t)*(*p)++ << (8 * i);
    const uint64_t sign = UINT64_C(1) << (8 * bytes - 1);
    return (x & sign) ? -(int64_t)(2 * sign - x) : (int64_t)x;
}

static int put_polys(uint8_t **out, const polz *p, size_t n) {
    for (size_t i = 0; i < n; ++i) for (size_t j = 0; j < N; ++j) {
        zz c;
        polz_getcoeff(c, p[i], j);
        for (size_t k = 0; k + 1 < L; ++k)
            if (c->limbs[k] < 0 || c->limbs[k] >= (1 << 14)) return 0;
        int64_t v = int64_fromzz(c);
        if (v <= -(int64_t)(2 * PS_Q) || v >= (int64_t)(2 * PS_Q)) return 0;
        store(out, (uint64_t)v, QCOEFF_BYTES);
    }
    return 1;
}

static int get_polys(const uint8_t **in, polz *p, size_t n) {
    for (size_t i = 0; i < n; ++i) for (size_t j = 0; j < N; ++j) {
        int64_t v = load(in, QCOEFF_BYTES);
        if (v <= -(int64_t)(2 * PS_Q) || v >= (int64_t)(2 * PS_Q)) return 0;
        polz_setcoeff_fromint64(p[i], v, j);
    }
    return 1;
}

int wire_encode(uint8_t *out, size_t len, const dch_pack_params params, const dch_pack_proof proof) {
    const pack_params *p = &params->pp_pack;
    const pack_proof *pi = &proof->pi_pack;
    uint8_t *next = out;
    if (!wire_supported(params) || len != wire_size(params)) return 0;
    memcpy(next, MAGIC, HEADER);
    next += HEADER;
    if (!put_polys(&next, proof->pi_dch->com, params->pp_dch->kappa_outer)) return 0;
    for (size_t i = 0; i < (*p)->np; ++i) {
        if (i == (*p)->zkround) {
            if (!put_polys(&next, (*pi)->zkp[0]->m[0], lnp_polys((*p)->zkp[0]))) return 0;
        } else {
            if (!put_polys(&next, (*pi)->p[i]->m[0], lab_polys((*p)->p[i]))) return 0;
            if (!(*p)->p[i]->compressed)
                for (size_t j = 0; j < 256; ++j) store(&next, (uint64_t)(*pi)->p[i]->p[j], 4);
        }
    }
    const witness *w = &(*pi)->owt;
    for (size_t i = 0; i < (*w)->r; ++i) {
        if ((*w)->n[i] > (size_t)(out + len - next) / (2 * N)) return 0;
        for (size_t j = 0; j < (*w)->n[i]; ++j)
            for (size_t k = 0; k < N; ++k) store(&next, (uint64_t)(*w)->s[i][j]->c[k], 2);
    }
    return (size_t)(next - out) == len;
}

int wire_decode(dch_pack_proof proof, const dch_pack_params params, const uint8_t *in, size_t len) {
    const pack_params *p = &params->pp_pack;
    pack_proof *pi = &proof->pi_pack;
    const uint8_t *next = in;
    if (!wire_supported(params) || len != wire_size(params) || memcmp(in, MAGIC, HEADER)) return 0;
    next += HEADER;

    proof->pi_dch->com = _aligned_alloc(64, params->pp_dch->kappa_outer * sizeof(polz));
    pack_proof_init(*pi, *p);
    memset((*pi)->p, 0, (*p)->np * sizeof(lab_proof));
    lnp_proof_init((*pi)->zkp[0], (*p)->zkp[0]);
    lab_witness_init((*pi)->owt, (*p)->p[(*p)->np - 1]);
    if (!get_polys(&next, proof->pi_dch->com, params->pp_dch->kappa_outer)) goto bad;
    for (size_t i = 0; i < (*p)->np; ++i) {
        if (i == (*p)->zkround) {
            if (!get_polys(&next, (*pi)->zkp[0]->m[0], lnp_polys((*p)->zkp[0]))) goto bad;
        } else {
            lab_proof_init((*pi)->p[i], (*p)->p[i]);
            if (!get_polys(&next, (*pi)->p[i]->m[0], lab_polys((*p)->p[i]))) goto bad;
            if (!(*p)->p[i]->compressed) {
                // The upstream JL checker accumulates squared int32s in uint64.
                // Reject before verification rather than permit wraparound.
                __uint128_t norm = 0;
                for (size_t j = 0; j < 256; ++j) {
                    int64_t x = load(&next, 4);
                    (*pi)->p[i]->p[j] = (int32_t)x;
                    norm += (uint64_t)(x * x);
                }
                if (norm > UINT64_MAX) goto bad;
            }
        }
    }
    witness *w = &(*pi)->owt;
    for (size_t i = 0; i < (*w)->r; ++i)
        for (size_t j = 0; j < (*w)->n[i]; ++j)
            for (size_t k = 0; k < N; ++k) (*w)->s[i][j]->c[k] = (int16_t)load(&next, 2);
    if ((size_t)(next - in) == len) return 1;
bad:
    wire_free(proof);
    return 0;
}

void wire_free(dch_pack_proof proof) {
    // At the pinned revision pack_proof_free frees the LNP struct, not its messages.
    lnp_proof_free(proof->pi_pack->zkp[0]);
    dch_pack_proof_free(proof);
}

// Byte counts for the exact dense allocations in jl_sample_mat, not gas.
// LNP holds both matrices concurrently; other rounds free theirs before continuing.
void wire_jl_profile(uint64_t out[3], const dch_pack_params params) {
    const pack_params *p = &params->pp_pack;
    const uint64_t unit = 2 * 256 * N / 8;
    out[0] = out[1] = out[2] = 0;
    for (size_t i = 0; i < (*p)->np; ++i) {
        uint64_t a, b = 0;
        if (i == (*p)->zkround) {
            a = unit * (*p)->zkp[0]->silen_max;
            b = unit * ((*p)->zkp[0]->vtildelen / 2);
        } else {
            const lab_params *round = &(*p)->p[i];
            a = unit * ((*round)->compressed ? (*round)->nmax : (*round)->nn);
        }
        out[0] += a + b;
        out[1] = MAX(out[1], a + b);
        out[2] = MAX(out[2], MAX(a, b));
    }
}
