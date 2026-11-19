#pragma once
#include <cerrno>
#include <cstdint>
#include <cstdlib>
#include <sys/random.h>

// UniformRandomBitGenerator adapter used only in the Linux TFHE research build.
// The pinned library's default C++ engine is not suitable for generating keys or noise.
struct LabOsRandom {
    using result_type = uint32_t;
    static constexpr result_type min() { return 0; }
    static constexpr result_type max() { return UINT32_MAX; }
    result_type operator()() const {
        result_type word;
        ssize_t count;
        do { count = getrandom(&word, sizeof(word), 0); } while (count < 0 && errno == EINTR);
        if (count != static_cast<ssize_t>(sizeof(word))) std::abort();
        return word;
    }
};
