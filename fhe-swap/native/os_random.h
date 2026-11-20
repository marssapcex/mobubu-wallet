#pragma once

#include <array>
#include <cerrno>
#include <cstddef>
#include <cstdint>
#include <stdexcept>
#include <sys/random.h>

// UniformRandomBitGenerator used by the pinned libtfhe distributions. The
// upstream default_random_engine is not cryptographic, even if securely seeded.
class MobubuOsRandom {
 public:
  using result_type = std::uint32_t;
  static constexpr result_type min() { return 0; }
  static constexpr result_type max() { return UINT32_MAX; }

  result_type operator()() {
    if (index_ == words_.size()) refill();
    auto value = words_[index_];
    words_[index_++] = 0;
    return value;
  }

 private:
  void refill() {
    auto* next = reinterpret_cast<unsigned char*>(words_.data());
    std::size_t left = sizeof(words_);
    while (left > 0) {
      const auto n = getrandom(next, left, 0);
      if (n < 0 && errno == EINTR) continue;
      if (n <= 0) throw std::runtime_error("system CSPRNG unavailable");
      next += n;
      left -= static_cast<std::size_t>(n);
    }
    index_ = 0;
  }

  std::array<result_type, 256> words_{};
  std::size_t index_ = words_.size();
};
