// Test-only evaluator for the ciphertext operation trace emitted by the EDR host fixture.
// Separate client and evaluator code; not a Zama coprocessor, serialization format, or verifier.
#include <tfhe.h>
#include <algorithm>
#include <cstdlib>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace {
using Ct = std::shared_ptr<LweSample>;
struct Bit {
    Bit(Ct c = nullptr, bool b = false) : cipher(std::move(c)), known(b) {}
    Ct cipher;
    bool known; // Meaningful only when there is no ciphertext (public scalar/constant).
};
using Word = std::vector<Bit>; // Least significant bit first.

Ct allocate(const TFheGateBootstrappingParameterSet* params) {
    return Ct(new_gate_bootstrapping_ciphertext(params), delete_gate_bootstrapping_ciphertext);
}

Word literal(const std::string& hex, size_t width) {
    if (hex.substr(0, 2) != "0x" || hex.size() > 66 || hex.size() <= 2) throw std::runtime_error("hex literal");
    Word word(width);
    for (size_t i = 0; i < hex.size() - 2; ++i) {
        auto nibble = std::string("0123456789abcdef").find(hex[hex.size() - 1 - i]);
        if (nibble > 15) throw std::runtime_error("hex digit");
        for (size_t j = 0; j < 4; ++j) if ((nibble >> j) & 1) word.at(i * 4 + j).known = true;
    }
    return word;
}

struct Gates {
    const TFheGateBootstrappingCloudKeySet* key;
    Bit gate(decltype(&bootsAND) fn, Bit a, Bit b) const {
        auto out = allocate(key->params);
        fn(out.get(), a.cipher.get(), b.cipher.get(), key);
        return {out, false};
    }
    Bit flip(Bit a) const {
        if (!a.cipher) return {nullptr, !a.known};
        auto out = allocate(key->params);
        bootsNOT(out.get(), a.cipher.get(), key);
        return {out, false};
    }
    Bit xorBit(Bit a, Bit b) const {
        if (!a.cipher) return a.known ? flip(b) : b;
        if (!b.cipher) return b.known ? flip(a) : a;
        return gate(bootsXOR, a, b);
    }
    Bit andBit(Bit a, Bit b) const {
        if (!a.cipher) return a.known ? b : a;
        if (!b.cipher) return b.known ? a : b;
        return gate(bootsAND, a, b);
    }
    Bit choose(Bit control, Bit a, Bit b) const {
        if (!control.cipher) return control.known ? a : b;
        if (!a.cipher && !b.cipher) return a.known == b.known ? a : (a.known ? control : flip(control));
        if (!a.cipher) return a.known ? flip(andBit(flip(control), flip(b))) : andBit(flip(control), b);
        if (!b.cipher) return b.known ? flip(andBit(control, flip(a))) : andBit(control, a);
        auto out = allocate(key->params);
        bootsMUX(out.get(), control.cipher.get(), a.cipher.get(), b.cipher.get(), key);
        return {out, false};
    }

    Bit subtract(const Word& a, const Word& b, Word* difference = nullptr) const {
        Bit borrow;
        for (size_t i = 0; i < a.size(); ++i) {
            auto change = xorBit(a[i], b[i]);
            if (difference) (*difference)[i] = xorBit(change, borrow);
            borrow = choose(change, b[i], borrow);
        }
        return borrow;
    }
    Word multiply(const Word& a, const Word& scalar) const {
        Word out(a.size());
        // Add each shifted copy selected by a public bit. Wrap exactly like the FHE uint type.
        for (size_t j = 0; j < scalar.size(); ++j) if (scalar[j].known) {
            Bit carry;
            for (size_t i = j; i < out.size(); ++i) {
                auto change = xorBit(out[i], a[i - j]);
                auto next = choose(change, carry, out[i]);
                out[i] = xorBit(change, carry);
                carry = next;
            }
        }
        return out;
    }
    Word divide(const Word& a, Word scalar) const {
        // Restoring division. Remainder width depends only on the public divisor, never on input values.
        while (!scalar.empty() && !scalar.back().known) scalar.pop_back();
        if (scalar.empty()) throw std::runtime_error("division by zero");
        scalar.push_back({});
        Word out(a.size()), rem(scalar.size()), diff(scalar.size());
        for (size_t i = a.size(); i-- > 0;) {
            std::copy_backward(rem.begin(), rem.end() - 1, rem.end());
            rem[0] = a[i];
            out[i] = flip(subtract(rem, scalar, &diff));
            // The reduced remainder fits in the low bits; the top bit is discarded on the next shift.
            for (size_t j = 0; j + 1 < rem.size(); ++j) rem[j] = choose(out[i], diff[j], rem[j]);
        }
        return out;
    }
};

// Each row contains public operation metadata and indices of previously registered ciphertexts.
void evaluate(std::istream& in, size_t count, std::vector<Word>& words, const TFheGateBootstrappingCloudKeySet* key) {
    Gates g{key};
    for (size_t i = 0; i < count; ++i) {
        unsigned op, width;
        bool scalar;
        size_t control;
        std::string lhs, rhs;
        if (!(in >> op >> width >> lhs >> rhs >> control >> scalar) || (width != 1 && width != 128 && width != 256))
            throw std::runtime_error("invalid trace row");
        if (op == 0) { words.push_back(literal(lhs, width)); continue; }
        const auto& a = words.at(std::stoul(lhs));
        const auto b = scalar ? literal(rhs, a.size()) : words.at(std::stoul(rhs));
        if (a.size() != b.size() || ((op == 1 || op == 2) && !scalar)) throw std::runtime_error("trace operands");
        Word out;
        switch (op) {
            case 1: out = g.multiply(a, b); break;
            case 2: out = g.divide(a, b); break;
            case 3: out = {g.flip(g.subtract(b, a))}; break;
            case 4: out = {g.subtract(b, a)}; break;
            case 5: out = {g.flip(g.subtract(a, b))}; break;
            case 6: {
                Bit equal{nullptr, true};
                for (size_t j = 0; j < a.size(); ++j) equal = g.andBit(equal, g.flip(g.xorBit(a[j], b[j])));
                out = {equal};
                break;
            }
            case 7: out = {g.andBit(a.at(0), b.at(0))}; break;
            case 8:
                for (size_t j = 0; j < a.size(); ++j) out.push_back(g.choose(words.at(control).at(0), a[j], b[j]));
                break;
            default: throw std::runtime_error("unsupported trace opcode");
        }
        if (out.size() != width) throw std::runtime_error("trace result width");
        words.push_back(std::move(out));
    }
}

Word encrypt(const std::string& input, const TFheGateBootstrappingSecretKeySet* key) {
    auto word = literal(input, 128);
    for (auto& bit : word) {
        auto ct = allocate(key->params);
        bootsSymEncrypt(ct.get(), bit.known, key);
        bit = {ct, false};
    }
    return word;
}

std::string decrypt(const Word& word, const TFheGateBootstrappingSecretKeySet* key) {
    std::string hex;
    for (size_t i = 0; i < word.size(); i += 4) {
        unsigned nibble = 0;
        for (size_t j = 0; j < 4 && i + j < word.size(); ++j) {
            const auto& b = word[i + j];
            const auto bit = b.cipher ? bootsSymDecrypt(b.cipher.get(), key) : b.known;
            nibble |= unsigned(bit) << j;
        }
        hex += "0123456789abcdef"[nibble];
    }
    std::reverse(hex.begin(), hex.end());
    return "0x" + hex;
}
} // namespace

int main() try {
    std::string debit, minimum;
    size_t count, amountIndex, eligibleIndex;
    if (!(std::cin >> debit >> minimum >> count) || count == 0 || count > 64) throw std::runtime_error("trace header");
    auto p = std::unique_ptr<TFheGateBootstrappingParameterSet, decltype(&delete_gate_bootstrapping_parameters)>(
        new_default_gate_bootstrapping_parameters(128), delete_gate_bootstrapping_parameters);
    auto key = std::unique_ptr<TFheGateBootstrappingSecretKeySet, decltype(&delete_gate_bootstrapping_secret_keyset)>(
        new_random_gate_bootstrapping_secret_keyset(p.get()), delete_gate_bootstrapping_secret_keyset);
    std::vector<Word> words{encrypt(debit, key.get()), encrypt(minimum, key.get())};
    evaluate(std::cin, count, words, &key->cloud);
    if (!(std::cin >> amountIndex >> eligibleIndex)) throw std::runtime_error("trace outputs");
    const auto& amount = words.at(amountIndex);
    const auto& eligible = words.at(eligibleIndex);
    if (amount.size() != 128 || eligible.size() != 1 || !eligible[0].cipher) throw std::runtime_error("missing encrypted bit");
    std::cout << decrypt(amount, key.get()) << ' ' << decrypt(eligible, key.get()) << '\n';
    return EXIT_SUCCESS;
} catch (const std::exception& error) {
    std::cerr << "TFHE trace fixture: " << error.what() << '\n';
    return EXIT_FAILURE;
}
