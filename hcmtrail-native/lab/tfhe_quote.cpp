// Research fixture: a bootstrapped encrypted quote at a synthetic fixed 3/2 rate.
// This has no serialization, network, wallet or settlement entry point.
#include <tfhe.h>
#include <array>
#include <cstdio>
#include <memory>

namespace {
constexpr int debit_bits = 8;
constexpr int result_bits = 9;

template <int Width> class Bits {
public:
    explicit Bits(const TFheGateBootstrappingParameterSet* p) : data(new_gate_bootstrapping_ciphertext_array(Width, p)) {}
    Bits(const Bits&) = delete;
    Bits& operator=(const Bits&) = delete;
    ~Bits() { delete_gate_bootstrapping_ciphertext_array(Width, data); }
    LweSample* operator[](int i) { return &data[i]; }
    const LweSample* operator[](int i) const { return &data[i]; }
private:
    LweSample* data;
};

template <int Width> void encrypt(Bits<Width>& bits, unsigned value, const TFheGateBootstrappingSecretKeySet* client) {
    for (int i = 0; i < Width; ++i) bootsSymEncrypt(bits[i], (value >> i) & 1U, client);
}

template <int Width> unsigned decrypt(const Bits<Width>& bits, const TFheGateBootstrappingSecretKeySet* client) {
    unsigned value = 0;
    for (int i = 0; i < Width; ++i) value |= unsigned(bootsSymDecrypt(bits[i], client)) << i;
    return value;
}

// In this circuit the evaluator gets only a cloud key and ciphertexts. All loops are fixed-width.
void evaluate(Bits<result_bits>& payout, LweSample* eligible, const Bits<debit_bits>& debit,
              const Bits<result_bits>& minimum, const TFheGateBootstrappingCloudKeySet* eval_key) {
    const auto* p = eval_key->params;
    Bits<7> scratch(p);
    auto *zero = scratch[0], *state = scratch[1], *next = scratch[2], *differ = scratch[3],
         *sum = scratch[4], *positive = scratch[5], *seen = scratch[6];
    bootsCONSTANT(zero, 0, eval_key);
    bootsCOPY(state, zero, eval_key);
    // A 10-bit sum is sufficient for 3*255 = 765. Drop its low bit to take the exact floor / 2.
    for (int i = 0; i <= result_bits; ++i) {
        const auto* a = i < debit_bits ? debit[i] : zero;
        const auto* b = i > 0 && i <= debit_bits ? debit[i-1] : zero;
        bootsXOR(differ, a, b, eval_key);
        bootsXOR(sum, differ, state, eval_key);
        if (i != 0) bootsCOPY(payout[i-1], sum, eval_key);
        bootsMUX(next, differ, state, a, eval_key);
        bootsCOPY(state, next, eval_key);
    }
    // Borrow out of (payout - minimum) is 1 precisely when payout < minimum.
    bootsCOPY(state, zero, eval_key);
    bootsCOPY(positive, zero, eval_key);
    for (int i = 0; i < result_bits; ++i) {
        bootsXOR(differ, payout[i], minimum[i], eval_key);
        bootsMUX(next, differ, minimum[i], state, eval_key);
        bootsCOPY(state, next, eval_key);
        bootsOR(seen, positive, payout[i], eval_key);
        bootsCOPY(positive, seen, eval_key);
    }
    bootsANDNY(eligible, state, positive, eval_key);
}
} // namespace

int main() {
    auto params = std::unique_ptr<TFheGateBootstrappingParameterSet, decltype(&delete_gate_bootstrapping_parameters)>(
        new_default_gate_bootstrapping_parameters(128), delete_gate_bootstrapping_parameters);
    auto key = std::unique_ptr<TFheGateBootstrappingSecretKeySet, decltype(&delete_gate_bootstrapping_secret_keyset)>(
        new_random_gate_bootstrapping_secret_keyset(params.get()), delete_gate_bootstrapping_secret_keyset);
    constexpr std::array<std::array<unsigned, 2>, 6> vectors{{{0, 0}, {1, 1}, {13, 20}, {13, 19}, {255, 382}, {255, 383}}};
    for (const auto& v : vectors) {
        Bits<debit_bits> debit(params.get());
        Bits<result_bits> minimum(params.get()), payout(params.get());
        Bits<1> eligible(params.get());
        encrypt(debit, v[0], key.get());
        encrypt(minimum, v[1], key.get());
        evaluate(payout, eligible[0], debit, minimum, &key->cloud);
        const unsigned expected = v[0] * 3 / 2;
        if (decrypt(payout, key.get()) != expected || decrypt(eligible, key.get()) != (expected != 0 && expected >= v[1])) {
            std::fputs("TFHE encrypted quote did not match the clear reference\n", stderr);
            return 1;
        }
    }
    std::puts("TFHE/CGGI: 6 encrypted floor/minimum cases passed; laboratory vectors only.");
}
