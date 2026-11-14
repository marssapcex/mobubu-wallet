// TFHE (CGGI) homomorphic computation worker for fhe-swap.
//
// Links against the TFHE library by Chillotti, Gama, Georgieva, Izabachene
// (https://github.com/tfhe/tfhe, Apache-2.0). This file is original glue code
// for this project (MIT).
//
// Protocol: newline-delimited text on stdin/stdout.
//   request:  <id> <OP> [args...]
//   response: <id> OK [payload...]   |   <id> ERR <message>
//
// Two roles:
//   client    - holds the secret key, can ENC/DEC and compute
//   evaluator - loads ONLY the cloud (evaluation) key; DEC/ENC are refused
//
// Integers are encrypted bit-sliced: an w-bit unsigned integer is an array of
// w LWE ciphertexts, each encrypting one bit. Every gate is bootstrapped, so
// circuit depth is unbounded (fully homomorphic, not leveled).

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cstdint>
#include <string>
#include <vector>
#include <sstream>
#include <iostream>
#include <chrono>
#include <climits>
#include <stdexcept>

#include "tfhe.h"
#include "tfhe_io.h"

namespace {

TFheGateBootstrappingParameterSet* g_params = nullptr;
TFheGateBootstrappingSecretKeySet* g_secret = nullptr;
TFheGateBootstrappingCloudKeySet* g_cloud = nullptr;
bool g_owner_cloud = false;
long long g_gates = 0;   // bootstrapped nonlinear gates
long long g_linear = 0;  // noiseless linear ops: CONSTANT/COPY/NOT/shift

const char* B64 =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
;

unsigned long long parse_ull(const std::string& v) {
  if (v.empty()) throw std::runtime_error("missing integer");
  unsigned long long r = 0;
  for (char c : v) {
    if (c < '0' || c > '9') throw std::runtime_error("invalid decimal integer");
    unsigned d = static_cast<unsigned>(c - '0');
    if (r > (ULLONG_MAX - d) / 10ULL) throw std::runtime_error("integer overflow");
    r = r * 10ULL + d;
  }
  return r;
}

int parse_width(const std::string& v, int maxw = 128) {
  unsigned long long w = parse_ull(v);
  if (w == 0 || w > static_cast<unsigned long long>(maxw))
    throw std::runtime_error("bit width out of range");
  return static_cast<int>(w);
}

int bit_length(unsigned long long v) {
  int n = 0;
  while (v) { n++; v >>= 1; }
  return n;
}

std::string b64encode(const unsigned char* data, size_t len) {
  std::string out;
  out.reserve(((len + 2) / 3) * 4);
  for (size_t i = 0; i < len; i += 3) {
    unsigned int v = data[i] << 16;
    if (i + 1 < len) v |= data[i + 1] << 8;
    if (i + 2 < len) v |= data[i + 2];
    out.push_back(B64[(v >> 18) & 63]);
    out.push_back(B64[(v >> 12) & 63]);
    out.push_back(i + 1 < len ? B64[(v >> 6) & 63] : '=');
    out.push_back(i + 2 < len ? B64[v & 63] : '=');
  }
  return out;
}

int b64val(char c) {
  if (c >= 'A' && c <= 'Z') return c - 'A';
  if (c >= 'a' && c <= 'z') return c - 'a' + 26;
  if (c >= '0' && c <= '9') return c - '0' + 52;
  if (c == '+') return 62;
  if (c == '/') return 63;
  return -1;
}

std::vector<unsigned char> b64decode(const std::string& in) {
  std::vector<unsigned char> out;
  uint32_t acc = 0;
  int bits = 0;
  size_t pad = 0;
  for (char c : in) {
    if (c == '=') { pad++; if (pad > 2) throw std::runtime_error("invalid base64 padding"); continue; }
    if (pad) throw std::runtime_error("data after base64 padding");
    int v = b64val(c);
    if (v < 0) throw std::runtime_error("invalid base64");
    acc = ((acc << 6) | static_cast<uint32_t>(v)) & 0xFFFFFFu;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push_back(static_cast<unsigned char>((acc >> bits) & 0xFF));
    }
  }
  if ((in.size() % 4) != 0) throw std::runtime_error("invalid base64 length");
  return out;
}

struct Bits {
  int width = 0;
  LweSample* s = nullptr;
  Bits() = default;
  explicit Bits(int w) : width(w) {
    if (w <= 0 || w > 128) throw std::runtime_error("bit width out of range");
    s = new_gate_bootstrapping_ciphertext_array(w, g_params);
  }
  ~Bits() {
    if (s) delete_gate_bootstrapping_ciphertext_array(width, s);
  }
  Bits(const Bits&) = delete;
  Bits& operator=(const Bits&) = delete;
};

void gate() { g_gates++; }
void linear() { g_linear++; }
void copy_bit(LweSample* dst, const LweSample* src);

void copy_bit(LweSample* dst, const LweSample* src) {
  memcpy(dst->a, src->a, sizeof(Torus32) * g_params->in_out_params->n);
  dst->b = src->b;
  dst->current_variance = src->current_variance;
}

void requireCloud() {
  if (!g_cloud || !g_params) throw std::runtime_error("no evaluation key loaded");
}
void requireSecret() {
  if (!g_secret) throw std::runtime_error("role has no secret key");
}

std::string serialize(const Bits& b) {
  char* buf = nullptr;
  size_t len = 0;
  FILE* f = open_memstream(&buf, &len);
  if (!f) throw std::runtime_error("open_memstream failed");
  for (int i = 0; i < b.width; i++) {
    export_lweSample_toFile(f, &b.s[i], g_params->in_out_params);
  }
  fclose(f);
  std::string out = b64encode(reinterpret_cast<unsigned char*>(buf), len);
  free(buf);
  return out;
}

void deserialize(Bits& b, const std::string& blob) {
  requireCloud();
  std::vector<unsigned char> raw = b64decode(blob);
  // Each exported LWE sample is: int32 type_uid (42), n uint32 coefficients,
  // uint32 b, double current_variance. Reject malformed input BEFORE calling
  // upstream import (which aborts the process on a short read).
  const size_t n = static_cast<size_t>(g_params->in_out_params->n);
  const size_t sample_bytes = 4 + 4 * n + 4 + 8;
  if (raw.size() != static_cast<size_t>(b.width) * sample_bytes) {
    throw std::runtime_error("ciphertext byte length does not match width/params");
  }
  FILE* f = fmemopen(raw.data(), raw.size(), "r");
  if (!f) throw std::runtime_error("fmemopen failed");
  for (int i = 0; i < b.width; i++) {
    import_lweSample_fromFile(f, &b.s[i], g_params->in_out_params);
  }
  fclose(f);
}

void constant(Bits& out, unsigned long long value) {
  requireCloud();
  for (int i = 0; i < out.width; i++) {
    bootsCONSTANT(&out.s[i], i < 64 ? static_cast<int32_t>((value >> i) & 1ULL) : 0, g_cloud);
    linear();
  }
}

// carry = (a&b) | ((a^b)&cin) = MUX(a^b, cin, a)
void full_adder(LweSample* sum, LweSample* carry, const LweSample* a,
                const LweSample* b, const LweSample* cin) {
  LweSample* t = new_gate_bootstrapping_ciphertext(g_params);
  bootsXOR(t, a, b, g_cloud); gate();
  bootsXOR(sum, t, cin, g_cloud); gate();
  bootsMUX(carry, t, cin, a, g_cloud); gate();
  delete_gate_bootstrapping_ciphertext(t);
}

// borrow = (~a & b) | (~(a^b) & bin) = MUX(a^b, b, bin)
void full_subtractor(LweSample* diff, LweSample* borrow, const LweSample* a,
                     const LweSample* b, const LweSample* bin) {
  LweSample* t = new_gate_bootstrapping_ciphertext(g_params);
  bootsXOR(t, a, b, g_cloud); gate();
  bootsXOR(diff, t, bin, g_cloud); gate();
  bootsMUX(borrow, t, b, bin, g_cloud); gate();
  delete_gate_bootstrapping_ciphertext(t);
}

void add_into(Bits& out, const Bits& a, const Bits& b) {
  requireCloud();
  if (a.width != b.width || out.width != a.width)
    throw std::runtime_error("add width mismatch");
  LweSample* cin = new_gate_bootstrapping_ciphertext(g_params);
  LweSample* cout = new_gate_bootstrapping_ciphertext(g_params);
  bootsCONSTANT(cin, 0, g_cloud); linear();
  for (int i = 0; i < a.width; i++) {
    full_adder(&out.s[i], cout, &a.s[i], &b.s[i], cin);
    copy_bit(cin, cout);
  }
  delete_gate_bootstrapping_ciphertext(cin);
  delete_gate_bootstrapping_ciphertext(cout);
}

void sub_into(Bits& out, const Bits& a, const Bits& b) {
  requireCloud();
  if (a.width != b.width || out.width != a.width)
    throw std::runtime_error("sub width mismatch");
  LweSample* bin = new_gate_bootstrapping_ciphertext(g_params);
  LweSample* bout = new_gate_bootstrapping_ciphertext(g_params);
  bootsCONSTANT(bin, 0, g_cloud); linear();
  for (int i = 0; i < a.width; i++) {
    full_subtractor(&out.s[i], bout, &a.s[i], &b.s[i], bin);
    copy_bit(bin, bout);
  }
  delete_gate_bootstrapping_ciphertext(bin);
  delete_gate_bootstrapping_ciphertext(bout);
}

// unsigned borrow-out of a-b : 1 iff a < b
void borrow_out(LweSample* out, const Bits& a, const Bits& b) {
  requireCloud();
  if (a.width != b.width) throw std::runtime_error("cmp width mismatch");
  LweSample* bin = new_gate_bootstrapping_ciphertext(g_params);
  LweSample* bout = new_gate_bootstrapping_ciphertext(g_params);
  LweSample* diff = new_gate_bootstrapping_ciphertext(g_params);
  bootsCONSTANT(bin, 0, g_cloud); linear();
  for (int i = 0; i < a.width; i++) {
    full_subtractor(diff, bout, &a.s[i], &b.s[i], bin);
    copy_bit(bin, bout);
  }
  bootsCOPY(out, bin, g_cloud); linear();
  delete_gate_bootstrapping_ciphertext(bin);
  delete_gate_bootstrapping_ciphertext(bout);
  delete_gate_bootstrapping_ciphertext(diff);
}

void mul_const(Bits& out, const Bits& a, unsigned long long c) {
  requireCloud();
  constant(out, 0);
  if (c == 0) return;
  Bits acc(out.width);
  Bits shifted(out.width);
  constant(acc, 0);
  bool first = true;
  for (int i = 0; i < out.width; i++) {
    if (i >= 64 || !((c >> i) & 1ULL)) continue;
    for (int j = 0; j < out.width; j++) {
      if (j < i || j - i >= a.width) {
        bootsCONSTANT(&shifted.s[j], 0, g_cloud); linear();
      } else {
        bootsCOPY(&shifted.s[j], &a.s[j - i], g_cloud); linear();
      }
    }
    if (first) {
      for (int j = 0; j < out.width; j++) copy_bit(&acc.s[j], &shifted.s[j]);
      first = false;
    } else {
      Bits tmp(out.width);
      add_into(tmp, acc, shifted);
      for (int j = 0; j < out.width; j++) copy_bit(&acc.s[j], &tmp.s[j]);
    }
  }
  if (first) return;
  for (int j = 0; j < out.width; j++) copy_bit(&out.s[j], &acc.s[j]);
}

void mul_enc(Bits& out, const Bits& a, const Bits& b) {
  requireCloud();
  if (out.width < a.width + b.width)
    throw std::runtime_error("mul output width too small");
  constant(out, 0);
  Bits acc(out.width);
  Bits partial(out.width);
  Bits tmp(out.width);
  constant(acc, 0);
  for (int i = 0; i < b.width; i++) {
    for (int j = 0; j < out.width; j++) {
      if (j < i || j - i >= a.width) {
        bootsCONSTANT(&partial.s[j], 0, g_cloud); linear();
      } else {
        bootsAND(&partial.s[j], &a.s[j - i], &b.s[i], g_cloud); gate();
      }
    }
    add_into(tmp, acc, partial);
    for (int j = 0; j < out.width; j++) copy_bit(&acc.s[j], &tmp.s[j]);
  }
  for (int j = 0; j < out.width; j++) copy_bit(&out.s[j], &acc.s[j]);
}

void eq_bits(LweSample* out, const Bits& a, const Bits& b) {
  requireCloud();
  if (a.width != b.width) throw std::runtime_error("eq width mismatch");
  LweSample* acc = new_gate_bootstrapping_ciphertext(g_params);
  LweSample* t = new_gate_bootstrapping_ciphertext(g_params);
  LweSample* next = new_gate_bootstrapping_ciphertext(g_params);
  bootsXNOR(acc, &a.s[0], &b.s[0], g_cloud); gate();
  for (int i = 1; i < a.width; i++) {
    bootsXNOR(t, &a.s[i], &b.s[i], g_cloud); gate();
    bootsAND(next, acc, t, g_cloud); gate();
    copy_bit(acc, next);
  }
  bootsCOPY(out, acc, g_cloud); linear();
  delete_gate_bootstrapping_ciphertext(acc);
  delete_gate_bootstrapping_ciphertext(t);
  delete_gate_bootstrapping_ciphertext(next);
}

// diff = a - b, borrow = 1 iff a < b (unsigned). All gates bootstrapped.
void sub_borrow(Bits& diff, LweSample* borrow, const Bits& a, const Bits& b) {
  requireCloud();
  if (a.width != b.width || diff.width != a.width)
    throw std::runtime_error("sub width mismatch");
  LweSample* bin = new_gate_bootstrapping_ciphertext(g_params);
  LweSample* bout = new_gate_bootstrapping_ciphertext(g_params);
  bootsCONSTANT(bin, 0, g_cloud); linear();
  for (int i = 0; i < a.width; i++) {
    full_subtractor(&diff.s[i], bout, &a.s[i], &b.s[i], bin);
    copy_bit(bin, bout);
  }
  copy_bit(borrow, bin);
  delete_gate_bootstrapping_ciphertext(bin);
  delete_gate_bootstrapping_ciphertext(bout);
}

// Unsigned restoring division of encrypted numerator by a PUBLIC divisor.
// quotient width ow; remainder is discarded. Divisor must be > 0.
void div_const(Bits& q, const Bits& a, unsigned long long d) {
  requireCloud();
  if (d == 0) throw std::runtime_error("division by zero");
  if (q.width > a.width) throw std::runtime_error("quotient wider than numerator");
  int rw = bit_length(d) + 1;
  if (rw > a.width) rw = a.width;
  Bits rem(rw), divisor(rw), diff(rw);
  constant(divisor, d);
  constant(rem, 0);
  LweSample* borrow = new_gate_bootstrapping_ciphertext(g_params);
  for (int i = a.width - 1; i >= 0; i--) {
    for (int j = rw - 1; j >= 1; j--) copy_bit(&rem.s[j], &rem.s[j - 1]);
    copy_bit(&rem.s[0], &a.s[i]);
    sub_borrow(diff, borrow, rem, divisor);
    if (i < q.width) { bootsNOT(&q.s[i], borrow, g_cloud); linear(); }
    for (int j = 0; j < rw; j++) {
      bootsMUX(&rem.s[j], borrow, &rem.s[j], &diff.s[j], g_cloud); gate();
    }
  }
  delete_gate_bootstrapping_ciphertext(borrow);
}

// Unsigned restoring division of two encrypted integers. Caller must ensure
// divisor != 0 (the evaluator cannot branch on an encrypted zero test).
void div_enc(Bits& q, const Bits& a, const Bits& b) {
  requireCloud();
  if (a.width != b.width) throw std::runtime_error("div width mismatch");
  if (q.width > a.width) throw std::runtime_error("quotient wider than numerator");
  int w = a.width;
  Bits rem(w), diff(w);
  constant(rem, 0);
  LweSample* borrow = new_gate_bootstrapping_ciphertext(g_params);
  for (int i = w - 1; i >= 0; i--) {
    for (int j = w - 1; j >= 1; j--) copy_bit(&rem.s[j], &rem.s[j - 1]);
    copy_bit(&rem.s[0], &a.s[i]);
    sub_borrow(diff, borrow, rem, b);
    if (i < q.width) { bootsNOT(&q.s[i], borrow, g_cloud); linear(); }
    for (int j = 0; j < w; j++) {
      bootsMUX(&rem.s[j], borrow, &rem.s[j], &diff.s[j], g_cloud); gate();
    }
  }
  delete_gate_bootstrapping_ciphertext(borrow);
}

std::string param_string() {
  std::ostringstream os;
  os << g_params->in_out_params->n << " " << g_params->tgsw_params->tlwe_params->N
     << " " << g_params->tgsw_params->tlwe_params->k << " "
     << g_params->tgsw_params->l << " " << g_params->tgsw_params->Bgbit;
  return os.str();
}

}  // namespace

int main(int argc, char** argv) {
  std::ios::sync_with_stdio(false);
  std::string line;
  while (std::getline(std::cin, line)) {
    if (line.empty()) continue;
    std::istringstream in(line);
    std::string id, op;
    in >> id >> op;
    try {
      if (op == "PING") {
        std::cout << id << " OK PONG\n";
      } else if (op == "KEYGEN") {
        std::string secs, path;
        in >> secs >> path;
        int security = static_cast<int>(parse_ull(secs));
        if (security != 80 && security != 128)
          throw std::runtime_error("security must be 80 or 128");
        if (g_secret || g_cloud) throw std::runtime_error("key already loaded");
        g_params = new_default_gate_bootstrapping_parameters(security);
        g_secret = new_random_gate_bootstrapping_secret_keyset(g_params);
        g_cloud = const_cast<TFheGateBootstrappingCloudKeySet*>(&g_secret->cloud);
        FILE* f = fopen(path.c_str(), "wb");
        if (!f) throw std::runtime_error("cannot write cloud key");
        export_tfheGateBootstrappingCloudKeySet_toFile(f, g_cloud);
        fclose(f);
        std::cout << id << " OK client " << security << " " << param_string() << "\n";
      } else if (op == "LOADCLOUD") {
        std::string path;
        in >> path;
        if (g_secret || g_cloud) throw std::runtime_error("key already loaded");
        FILE* f = fopen(path.c_str(), "rb");
        if (!f) throw std::runtime_error("cannot read cloud key");
        g_cloud = new_tfheGateBootstrappingCloudKeySet_fromFile(f);
        fclose(f);
        g_owner_cloud = true;
        g_params = const_cast<TFheGateBootstrappingParameterSet*>(g_cloud->params);
        std::cout << id << " OK evaluator " << param_string() << "\n";
      } else if (op == "MODE") {
        std::cout << id << " OK " << (g_secret ? "client" : (g_cloud ? "evaluator" : "empty"))
                  << "\n";
      } else if (op == "STATS") {
        std::cout << id << " OK gates " << g_gates << " linear " << g_linear << "\n";
      } else if (op == "ENC") {
        requireSecret();
        std::string ws, value;
        in >> ws >> value;
        int w = parse_width(ws, 64);
        unsigned long long v = parse_ull(value);
        Bits b(w);
        if (w < 64 && (v >> w) != 0) throw std::runtime_error("value exceeds bit width");
        for (int i = 0; i < w; i++) {
          bootsSymEncrypt(&b.s[i], static_cast<int32_t>((v >> i) & 1ULL), g_secret);
        }
        std::cout << id << " OK " << w << " " << serialize(b) << "\n";
      } else if (op == "DEC") {
        requireSecret();
        std::string ws, blob;
        in >> ws >> blob;
        int w = parse_width(ws, 64);
        Bits b(w);
        deserialize(b, blob);
        unsigned long long v = 0;
        for (int i = 0; i < w; i++) {
          if (bootsSymDecrypt(&b.s[i], g_secret)) v |= (1ULL << i);
        }
        std::cout << id << " OK " << v << "\n";
      } else if (op == "CONST") {
        std::string ws, value;
        in >> ws >> value;
        int w = parse_width(ws);
        unsigned long long v = parse_ull(value);
        Bits b(w);
        constant(b, v);
        std::cout << id << " OK " << w << " " << serialize(b) << "\n";
      } else if (op == "ADD" || op == "SUB" || op == "AND" || op == "OR" ||
                 op == "XOR") {
        std::string ws, ba, bb;
        in >> ws >> ba >> bb;
        int w = parse_width(ws);
        Bits a(w), b(w), out(w);
        deserialize(a, ba);
        deserialize(b, bb);
        if (op == "ADD") {
          add_into(out, a, b);
        } else if (op == "SUB") {
          sub_into(out, a, b);
        } else {
          requireCloud();
          for (int i = 0; i < w; i++) {
            if (op == "AND") bootsAND(&out.s[i], &a.s[i], &b.s[i], g_cloud);
            else if (op == "OR") bootsOR(&out.s[i], &a.s[i], &b.s[i], g_cloud);
            else bootsXOR(&out.s[i], &a.s[i], &b.s[i], g_cloud);
            gate();
          }
        }
        std::cout << id << " OK " << w << " " << serialize(out) << "\n";
      } else if (op == "NOT") {
        std::string ws, ba;
        in >> ws >> ba;
        int w = parse_width(ws);
        Bits a(w), out(w);
        deserialize(a, ba);
        requireCloud();
        for (int i = 0; i < w; i++) { bootsNOT(&out.s[i], &a.s[i], g_cloud); linear(); }
        std::cout << id << " OK " << w << " " << serialize(out) << "\n";
      } else if (op == "ADDCONST") {
        std::string ws, ba, cv;
        in >> ws >> ba >> cv;
        int w = parse_width(ws);
        unsigned long long c = parse_ull(cv);
        Bits a(w), cb(w), out(w);
        deserialize(a, ba);
        constant(cb, c);
        add_into(out, a, cb);
        std::cout << id << " OK " << w << " " << serialize(out) << "\n";
      } else if (op == "MULCONST") {
        std::string ws, ba, cv, ows;
        in >> ws >> ba >> cv >> ows;
        int w = parse_width(ws), ow = parse_width(ows);
        unsigned long long c = parse_ull(cv);
        Bits a(w), out(ow);
        deserialize(a, ba);
        mul_const(out, a, c);
        std::cout << id << " OK " << ow << " " << serialize(out) << "\n";
      } else if (op == "MUL") {
        std::string was, ba, wbs, bb, ows;
        in >> was >> ba >> wbs >> bb >> ows;
        int wa = parse_width(was), wb = parse_width(wbs), ow = parse_width(ows);
        Bits a(wa), b(wb), out(ow);
        deserialize(a, ba);
        deserialize(b, bb);
        mul_enc(out, a, b);
        std::cout << id << " OK " << ow << " " << serialize(out) << "\n";
      } else if (op == "SHR") {
        std::string ws, ba, shs;
        in >> ws >> ba >> shs;
        int w = parse_width(ws);
        unsigned long long shu = parse_ull(shs);
        if (shu >= static_cast<unsigned long long>(w)) throw std::runtime_error("shift out of range");
        int sh = static_cast<int>(shu);
        Bits a(w);
        deserialize(a, ba);
        int ow = w - sh;
        Bits out(ow);
        requireCloud();
        for (int i = 0; i < ow; i++) { bootsCOPY(&out.s[i], &a.s[i + sh], g_cloud); linear(); }
        std::cout << id << " OK " << ow << " " << serialize(out) << "\n";
      } else if (op == "RESIZE") {
        std::string ws, ba, ows;
        in >> ws >> ba >> ows;
        int w = parse_width(ws), ow = parse_width(ows);
        Bits a(w), out(ow);
        deserialize(a, ba);
        requireCloud();
        for (int i = 0; i < ow; i++) {
          if (i < w) { bootsCOPY(&out.s[i], &a.s[i], g_cloud); linear(); }
          else { bootsCONSTANT(&out.s[i], 0, g_cloud); linear(); }
        }
        std::cout << id << " OK " << ow << " " << serialize(out) << "\n";
      } else if (op == "CMP") {
        std::string cmpop, ws, ba, bb;
        in >> cmpop >> ws >> ba >> bb;
        int w = parse_width(ws);
        Bits a(w), b(w), out(1);
        deserialize(a, ba);
        deserialize(b, bb);
        requireCloud();
        if (cmpop == "lt") {
          borrow_out(&out.s[0], a, b);
        } else if (cmpop == "ge") {
          LweSample* t = new_gate_bootstrapping_ciphertext(g_params);
          borrow_out(t, a, b);
          bootsNOT(&out.s[0], t, g_cloud); linear();
          delete_gate_bootstrapping_ciphertext(t);
        } else if (cmpop == "gt") {
          borrow_out(&out.s[0], b, a);
        } else if (cmpop == "le") {
          LweSample* t = new_gate_bootstrapping_ciphertext(g_params);
          borrow_out(t, b, a);
          bootsNOT(&out.s[0], t, g_cloud); linear();
          delete_gate_bootstrapping_ciphertext(t);
        } else if (cmpop == "eq") {
          eq_bits(&out.s[0], a, b);
        } else if (cmpop == "ne") {
          LweSample* t = new_gate_bootstrapping_ciphertext(g_params);
          eq_bits(t, a, b);
          bootsNOT(&out.s[0], t, g_cloud); linear();
          delete_gate_bootstrapping_ciphertext(t);
        } else {
          throw std::runtime_error("unknown comparison");
        }
        std::cout << id << " OK 1 " << serialize(out) << "\n";
      } else if (op == "MUX") {
        std::string bs, ws, ba, bb;
        in >> bs >> ws >> ba >> bb;
        int w = parse_width(ws);
        Bits sel(1), a(w), b(w), out(w);
        deserialize(sel, bs);
        deserialize(a, ba);
        deserialize(b, bb);
        requireCloud();
        for (int i = 0; i < w; i++) {
          bootsMUX(&out.s[i], &sel.s[0], &a.s[i], &b.s[i], g_cloud); gate();
        }
        std::cout << id << " OK " << w << " " << serialize(out) << "\n";
      } else if (op == "DIVCONST") {
        std::string ws, ba, ds, ows;
        in >> ws >> ba >> ds >> ows;
        int w = parse_width(ws), ow = parse_width(ows);
        unsigned long long d = parse_ull(ds);
        Bits a(w), q(ow);
        deserialize(a, ba);
        div_const(q, a, d);
        std::cout << id << " OK " << ow << " " << serialize(q) << "\n";
      } else if (op == "DIV") {
        std::string was, ba, wbs, bb, ows;
        in >> was >> ba >> wbs >> bb >> ows;
        int wa = parse_width(was), wb = parse_width(wbs), ow = parse_width(ows);
        if (wa != wb) throw std::runtime_error("div widths must match");
        Bits a(wa), b(wb), q(ow);
        deserialize(a, ba);
        deserialize(b, bb);
        div_enc(q, a, b);
        std::cout << id << " OK " << ow << " " << serialize(q) << "\n";
      } else if (op == "QUIT") {
        std::cout << id << " OK BYE\n";
        std::cout.flush();
        break;
      } else {
        throw std::runtime_error("unknown op");
      }
      std::string extra;
      if (in >> extra) throw std::runtime_error("trailing arguments");
    } catch (const std::exception& e) {
      std::cout << id << " ERR " << e.what() << "\n";
    }
    std::cout.flush();
  }
  if (g_secret) delete_gate_bootstrapping_secret_keyset(g_secret);
  else if (g_owner_cloud && g_cloud) delete_gate_bootstrapping_cloud_keyset(g_cloud);
  return 0;
}
