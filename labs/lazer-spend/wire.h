#ifndef MOBUBU_LAZER_WIRE_H
#define MOBUBU_LAZER_WIRE_H
#include <sys/types.h>
#include "dachshund.h"

/* This is a lab codec, not an upstream LaZer wire format. Parameters are
 * rebuilt locally and never read from the proof. */
int wire_supported(const dch_pack_params params);
size_t wire_size(const dch_pack_params params);
int wire_encode(uint8_t *out, size_t len, const dch_pack_params params, const dch_pack_proof proof);
int wire_decode(dch_pack_proof proof, const dch_pack_params params, const uint8_t *in, size_t len);
void wire_free(dch_pack_proof proof);
void wire_jl_profile(uint64_t out[3], const dch_pack_params params);
#endif
