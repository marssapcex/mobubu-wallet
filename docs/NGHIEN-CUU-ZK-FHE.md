# Nghiên cứu và nâng cấp Mobubu: ZK, FHE và cross-chain

**Ngày đối chiếu:** 18-11-2026 · **Baseline:** `816d233bc48156b187a59268d0af45c56c2c8fcc`

**Phạm vi đã kiểm:** máy Linux x86‑64, Intel Xeon 2.60 GHz / 2 vCPU, Node 22.22.3, Rust 1.88.0. Kết quả là kiểm thử kỹ thuật local, không phải audit hay chứng nhận deploy.

> Đây là báo cáo của vòng nghiên cứu đầu tiên. [Vault ETH mặc định](../PROTOCOL_DESIGN.md) đã chuyển sang SLH-DSA. Kết quả dependency và regression sau khi bỏ Hardhat/`circomlibjs` nằm trong [bản rà soát lịch sử](RA-SOAT-MA-NGUON.md). Số đo bên dưới không được dùng như số đo của vault mới.

## 1. Kết luận thiết kế

Không dùng FHE làm bằng chứng rằng blockchain đã nhận tiền, và không dùng ZK làm bằng chứng rằng đồng thuận trên một chain khác đã final. Ba hệ thống khác nhau:

| Cơ chế | Có thể chứng minh/làm gì | Phần còn thiếu |
| --- | --- | --- |
| Groth16 / ZK | Chứng minh quan hệ `R(public, witness)` được thỏa mà không đưa witness lên chain. Verifier nhỏ, cố định theo circuit/ceremony. | Chỉ tin những gì được ràng buộc. Không tự xác minh accounting, xem finality, hay rút ciphertext. |
| FHE / HE | Tính hàm trên ciphertext; sau decrypt ra kết quả. Evaluator không có secret key. | Không tự chứng minh evaluator thật sự chạy hàm/đúng input, không xác thực ciphertext với deposit, không cấp quyền rút. |
| Sealed orderflow | AES‑GCM giấu payload đến lúc mở với quorum Shamir trong mô phỏng. | Plaintext sau mở vẫn lộ cho thành viên xử lý; thiếu DKG, verifiable shares, consensus. Không phải threshold FHE. |

Do đó vault mới chốt quyền chi bằng **exact native value + note một lần + Groth16**; FHE và engine streaming là hai đường thử riêng. Nếu sau này dùng ZK và FHE chung, cần phát biểu cụ thể: `c = Encrypt(pk_epoch, v; coins)` **và** cùng `v` được commit trong note/token ID/range, sau đó authenticate evaluation và quyền mở output. Chỉ hash bytes của `c` hoặc trả một bit do client tự giải mã không chứng minh quan hệ này.

## 2. Upstream đã đối chiếu và quyết định trong repo

| Nguồn | Chi tiết hữu ích | Áp dụng / không áp dụng |
| --- | --- | --- |
| **Circom / snarkjs** — [snarkjs](https://github.com/iden3/snarkjs), [circomlib](https://github.com/iden3/circomlib) | R1CS phải ràng buộc giá trị, không chỉ tính witness. `Num2Bits(k)` giới hạn range; comparator có giả định về input bit length. Groth16 sinh proof và public signals riêng; exporter xử lý thứ tự hệ số G2 cho EVM. | Circom 2.2.3, `--O2 --inspect`, 6.053 constraints, public ABI bốn tín hiệu. Cùng proof được kiểm trên Solidity sinh tự động và `substrate-bn` native. |
| **Tornado Cash Classic** — [withdraw circuit a533ad9](https://github.com/tornadocash/tornado-core/blob/a533ad9ffb62163a42d4fa9a09984c5dd4e5c41d/circuits/withdraw.circom), [pool](https://github.com/tornadocash/tornado-core/blob/a533ad9ffb62163a42d4fa9a09984c5dd4e5c41d/contracts/Tornado.sol), [cây](https://github.com/tornadocash/tornado-core/blob/a533ad9ffb62163a42d4fa9a09984c5dd4e5c41d/contracts/MerkleTreeWithHistory.sol) | Mệnh giá cố định, Merkle bất biến dạng append, root history có giới hạn, nullifier chỉ xuất hiện khi tiêu. Classic dùng Pedersen cho note/nullifier và MiMC cho cây. Circuit giữ recipient/fee/relayer trong quan hệ proof. | Học invariants, không sao chép nguồn hay key. Mobubu dùng Poseidon qua cả 3 lớp, kiểm domain và range recipient; không dùng relayer fee. Nạp/rút không làm metadata on-chain biến mất. |
| **RAILGUN** — source [Verifier.sol](https://github.com/Railgun-Privacy/contract/blob/36bcf5ed7cf94bfafb6e1a303e1832c769c16780/contracts/logic/Verifier.sol), [RailgunLogic.sol](https://github.com/Railgun-Privacy/contract/blob/36bcf5ed7cf94bfafb6e1a303e1832c769c16780/contracts/logic/RailgunLogic.sol), [Using Private Tokens](https://docs.railgun.org/wiki/learn/using-private-tokens) | Mô hình note/UTXO có input nullifier và output commitment. `hashBoundParams` là public input, contract kiểm `chainID`, range/check policy của transaction nằm ngoài việc kiểm pairing thuần túy. | Lấy ý tưởng bind ngữ cảnh vào public statement. Không mô phỏng shielded transfer có change, viewing key, đa tài sản hoặc tích hợp DApp của RAILGUN. |
| **THORChain** — [Streaming Swaps](https://dev.thorchain.org/swap-guide/streaming-swaps.html), [CLP](https://docs.thorchain.org/technical-documentation/thorchain-finance/continuous-liquidity-pools) | Inbound một lần, interval để tái cân bằng, limit cho từng lần thử, phần khớp đi outbound, phần còn lại có thể refund. Đầu ra raw XYK là `xY/(x+X)`; slip fee là `x²Y/(x+X)²`, đầu ra sau slip fee là `xXY/(x+X)²`. Interval upstream tính theo block, không phải giây. | Mobubu giữ XYK hai leg qua NYX và phí bps, **không** giả là CLP hoặc swap queue của THORChain. Lỗi xác nhận/broadcast và partial refund có test riêng. |
| **Serai** — [processor tại 4b89cf0](https://github.com/serai-dex/serai/tree/4b89cf0206184886e96d0663861596312e5b47d2/processor/src), [FROST implementation](https://github.com/serai-dex/serai/tree/4b89cf0206184886e96d0663861596312e5b47d2/crypto/frost), [RFC 9591](https://www.rfc-editor.org/rfc/rfc9591) | Scanner theo dõi chain ngoài, scheduler lập batch/plan, signer làm việc với session/keys/việc theo dõi giao dịch. FROST là ký ngưỡng **Schnorr**, không thay thế trực tiếp chữ ký ECDSA của các giao dịch native EVM. | Tách observation, lập plan, signature và broadcast. Không nhập code AGPL, không gọi tập Ed25519 approvals là FROST. [UPSTREAMS](../fhe-swap/docs/UPSTREAMS.md) ghi phiên bản và license theo crate. |
| **CGGI/TFHE** — [paper](https://eprint.iacr.org/2018/421), [libtfhe pin](https://github.com/tfhe/tfhe/tree/9373b5d8a5b022ca5b4e112ae1c2440bc18e160c), [TFHE-rs](https://github.com/zama-ai/tfhe-rs) | Gate bootstrapping refresh ciphertext; `COPY/NOT` không cần PBS trong worker này. `bootsMUX` upstream có **hai** bootstrap không keyswitch rồi keyswitch đầu ra. TFHE-rs radix, tham số và PBS backend khác libtfhe C. | Giữ cùng preset upstream trong benchmark, thay cấu trúc circuit và đường đi IPC. Build từ source pin + SHA-256; dùng Linux `getrandom` thay `default_random_engine` cho các phân phối upstream; **bỏ toàn bộ key từ binary cũ**. |
| **Microsoft SEAL** — [SEAL README & security notice](https://github.com/microsoft/SEAL#readme), [ví dụ BFV batching](https://github.com/microsoft/SEAL/blob/main/native/examples/2_encoders.cpp) | BFV dùng số nguyên modulo; packing nhiều slot cho cùng operation, không làm một phép so sánh bí mật tự nhiên rẻ. `node-seal` dùng SEAL 4.1.2 trong nhánh hiện tại; upstream khuyến nghị ≥4.4 vì bản sửa về xử lý input. | Giữ BFV demo với đầu vào local. Không mở parser ciphertext lên dịch vụ công cộng; cần nâng backend và kiểm bộ tham số trước khi tin input bên ngoài. |

### Vì sao Groth16 cho đường rút này?

- **R1CS và public input.** Witness calculator sinh giá trị; chỉ constraints quyết định witness nào được chấp nhận. R1CS ép từng tích tổ hợp tuyến tính bằng tổ hợp thứ ba. Circuit buộc `root` từ một path bit hợp lệ, `nullifierHash` từ secret và `domain`, `recipient` khác 0 và ≤160 bit. Verifier đưa *cả bốn* scalar vào `IC[0] + Σ s[i]·IC[i+1]` trước phép pairing. Thử sửa một public signal trên proof cũ phải thất bại ngay cả khi root mới vẫn nằm trong history.
- **Groth16 vs PLONK/KZG.** Groth16 có ba điểm proof (`A,C` ở G1, `B` ở G2) và đường verify BN254 phù hợp precompile EVM. Đổi mạch thay VK và phase 2; rò trapdoor ceremony có thể phá soundness. PLONK dùng SRS KZG có thể tái dùng trong giới hạn degree với setup cập nhật được, hữu ích khi nhiều mạch/version; không đồng nghĩa không trusted setup hoặc gas thấp hơn. Cả Groth16 trên BN254 lẫn PLONK/KZG đều không giải quyết rủi ro lượng tử của đường rút. Nguồn: [Groth16](https://eprint.iacr.org/2016/260), [PLONK](https://eprint.iacr.org/2019/953).
- **Fixed note vs private UTXO.** Vault một mệnh giá đơn giản hóa conservation thành `totalLocked += denomination` hoặc `-= denomination`; nullifier gắn với đúng một note khi dùng client chuẩn. Join/split kiểu RAILGUN cần ràng buộc token ID, range, tổng input = output + fee, owner key, spent nullifiers, output commitments và các public parameters. Không thêm `amount` vào tham số gọi hoặc witness rồi xem đó là hỗ trợ rút một phần. Quyền biết note là quyền tiêu; SDK không quét mempool, quản lý khóa xem, hay che dữ liệu mạng.

### Baseline và thay đổi đã kiểm

- **Vault cũ:** contract dùng Keccak còn circuit dùng Poseidon; verifier placeholder với độ dài proof không khớp ABI; deposit không kiểm tài sản thực theo mệnh giá; circuit khai `noteAmount` nhưng không commit vào note. Bản mới bỏ amount tự khai, dùng một mệnh giá/vault, proof bind domain và recipient, root history cố định. Cây tăng theo frontier: `O(20)` hash mỗi lần nạp, không copy/rehash mọi leaf. SDK cũng update sparse tree theo sự kiện, không giữ bí mật trong log.
- **Rust cũ:** manifest khai feature crypto nhưng dependency không tồn tại, verifier chỉ kiểm cấu trúc chuỗi. Rust mới kiểm chuẩn `Fr` không reduce input tùy ý, kiểm curve/subgroup G2, phép pairing Groth16 và public statement độc lập khỏi proof. Không thêm code mật mã tự chế để thay primitive upstream.
- **CGGI cũ:** comparator tạo cả ciphertext constant, rồi tính các bit của hiệu dù chỉ cần cờ borrow; RNG upstream mặc định không phù hợp tạo key. Bản mới bỏ các bit diff không dùng, có phép `GE_CONST`, kiểm width/giá trị, từ chối LWE header sai trước hàm import, quản lý timer/ipc/temp keys.
- **Streaming cũ:** RPC mất phản hồi sau broadcast có thể kẹt ở state không được tick lại; `completed` chưa chờ xác nhận, cùng inbound có thể được nhận ở hai record của mô phỏng. Bản mới giữ từng leg đã ký, kiểm ID, retry không tái lập giá. Kiểm depth trước chunk, trước mỗi signature và trước khi kết sổ; `needs_review` không phải `refunded`. Bot cũ ghi thẳng target reserves làm tròn, có thể hạ `k`; bot mới đặt lệnh qua XYK và cap riêng theo đơn vị input, test cả hai hướng.

## 3. Tối ưu FHE theo workload, không đổi độ an toàn để lấy tốc độ

### So sánh threshold công khai: thay mạch, không giảm bit width

Với `v` mã hóa và `c` đã công khai, đặt `b_i` là borrow từ `i` bit thấp. Bước tiếp theo: `b_(i+1) = (!v_i AND b_i)` nếu `c_i=0`, hoặc `(!v_i OR b_i)` nếu `c_i=1`. Tất cả bit dưới bit 1 đầu tiên của `c` có borrow = 0. Bit 1 đầu tiên chỉ cần `NOT(v_i)`; `c=0` ra constant true. Kết quả là `NOT(b_w)`. Số gate nonlinear cho `c>0` là `w - ctz(c) - 1`; code không rẽ nhánh theo `v`. Một cuộc gọi IPC không cần gửi ciphertext thứ hai. Không cắt `publicAmount` xuống 16 bit: wrapper dùng width thực của ciphertext và reject ngoài biểu diễn. `DIVCONST` cho lũy thừa hai chuyển thành shift/copy; divisor lớn hơn mọi giá trị cùng width cho ra 0.

Nếu cả hai vế bí mật, **không** dùng tính chất công khai này. Generic comparator chỉ bỏ các bit diff thừa: `w=16` còn 31 gọi gate nonlinear thay vì 48. Gate count **không bằng** số PBS: MUX đắt hơn AND/OR.

### Các bước tiếp theo, theo ưu tiên kiểm chứng

1. **Chốt encoding tiền trước khi chọn FHE width.** Tách asset/decimal, range và điều kiện phát hiện overflow. Giữ `bigint`/integer; không mặc định 16 bit cho số tiền chain, không dùng CKKS xấp xỉ để ký khoản settlement. Lập oracle plaintext và property tests ở `0`, `max`, `max+1`, ranh giới lượng nhỏ và làm tròn.
2. **Tách dữ liệu public / encrypted.** Cho constant propagation và shift dùng dữ liệu được phép công khai. Dùng CMP rồi CMUX nếu chỉ chọn nhánh; tránh encrypted division khi có thể so sánh chéo sau khi **chứng minh** mẫu số dương và tích không tràn. Nếu hai vế cùng key và không bí mật giá, ưu tiên BFV batching đối với multiply/add slotwise và giới hạn overflow modulo. Các phép quay slot đòi Galois keys; ciphertext multiplication cần relinearization, mức noise/level phải đo. Không gửi noise budget hay thông tin phụ thuộc secret ra dịch vụ không tin cậy.
3. **Đo hệ thống, không chỉ gate.** Tách keygen và key load khỏi latency nóng; đo IPC bytes, deserialization, peak RSS, lỗi, p50/p95 trên nhiều width. Cache cloud key theo version/session tin cậy, đặt quota/bounds, tránh keygen theo request. Với workload nhiều order, benchmark SIMD BFV hoặc batching/parallel PBS của TFHE-rs trước khi mua GPU.
4. **Nén khác với giảm phép tính.** TFHE-rs có ciphertext list compression với bộ tham số và CPU/GPU rõ ràng. Packing cùng list có thể tăng tỉ lệ nén, nhưng phải đo cả decompress và khối lượng key [tài liệu compression](https://docs.zama.ai/tfhe-rs/fhe-computation/data-handling/compress). Không gọi nối blob bằng byte phân cách là compression. Bảng CPU radix và benchmark GPU có phiên bản, security preset, failure probability và thiết bị khác nhau; không lấy latency từ đó làm số của Mobubu [CPU benchmarks](https://docs.zama.ai/tfhe-rs/0.7-1/get-started/benchmarks), [GPU/PBS](https://www.zama.org/post/bootstrapping-tfhe-ciphertexts-in-less-than-one-millisecond).
5. **Migration TFHE-rs có tiêu chí rõ.** Chọn backend/version, CPU và parameter set sau khi chạy vector so sánh 8/16/32/64 bit, xác suất lỗi, key size, nén, p95 và tải đồng thời. Compact PKE proof của TFHE-rs có thể xác thực quá trình mã hóa/range, **không** tự chứng minh ciphertext đến từ số dư vault [compact PKE proof](https://docs.zama.ai/tfhe-rs/0.6-3/guides/zk-pok). Không có backend TFHE-rs hoạt động trong patch này; Rust được dùng để verify Groth16 thật.

## 4. Kết quả đo tái lập

CGGI: `uint16(50_000) >= 30_001`, cùng cloud key mới, preset upstream `128`, SPQLIOS-FMA. Mỗi đường 1 warmup, 9 mẫu nóng xen kẽ; latency IPC + eval, **không** gồm keygen/decrypt. Mọi output đều giải mã đối chiếu plaintext. p95 theo nearest-rank ở 9 mẫu là mẫu chậm nhất.

| Đường đi | nonlinear gate calls | p50 | p95 |
| --- | ---: | ---: | ---: |
| Binary lịch sử: `CONST` + `CMP ge` | 48 | 953,3 ms | 1.072,8 ms |
| Binary mới, comparator generic | 31 | 696,3 ms | 746,3 ms |
| Binary mới, `GE_CONST` | 15 | 234,3 ms | 264,2 ms |

Ở lượt cuối: **4,07×** theo p50 với binary lịch sử; **2,97×** so với comparator generic trên **cùng** binary mới. Lượt trước lần lượt đo 1.011,5 / 655,3 / 247,8 ms p50 và giữ nguyên gate counts. Binary lịch sử lấy từ `fhe-swap/native/bin/tfhe_worker` tại baseline (SHA-256 `873cf938536550a766c093b4f572f58bb7dabbb374899282fb5803676b4156fa`), không tạo key bằng binary đó. Không giả định cờ compiler của hai binary là như nhau. Đây là latency của một phép toán, không phải speedup của mọi swap hay TFHE-rs.

```bash
npm --prefix fhe-swap run build:native
npm --prefix fhe-swap run bench:tfhe
# Tùy chọn chỉ để đo baseline trên chính máy thử: dùng binary cũ như evaluator
# với cloud key mới do benchmark tạo; tuyệt đối không tạo key bằng binary cũ.
# TFHE_BASELINE_WORKER=/path/to/legacy-evaluator npm --prefix fhe-swap run bench:tfhe
```

### Probe TFHE-rs: kích thước wire, không phải latency eval

Cài và chạy [probe](../fhe-swap/bench/compact-pke.mjs) độc lập, không thêm dependency runtime. `node-tfhe@1.8.2` WASM dùng bộ tham số mặc định. Mọi row tạo, serialize, deserialize và giải mã lại các `uint16` tại ranh giới giá trị. Dùng `CompactCiphertextList.build()`, **không** dùng packed PKE proof hoặc FHE list compression sau eval.

```bash
npm install --prefix .cache/tfhe-rs-probe --ignore-scripts --save-exact node-tfhe@1.8.2
node fhe-swap/bench/compact-pke.mjs .cache/tfhe-rs-probe/node_modules/node-tfhe
```

| Số `uint16` | Từng ciphertext (bytes) | Từng ciphertext nén bằng client key (bytes) | Một compact public list (bytes) |
| ---: | ---: | ---: | ---: |
| 1 | 132.101 | 1.639 | 16.691 |
| 4 | 528.404 | 6.556 | 16.931 |
| 16 | 2.113.616 | 26.224 | 17.891 |
| 64 | 8.454.464 | 104.896 | 21.731 |

Ở 64 giá trị, compact list nhỏ hơn **4,83×** so với nén từng ciphertext trong phép đo, khi dùng lại compact public key **33.034 bytes** đã cấp trước. Ở 1–4 giá trị ciphertext nén riêng nhỏ hơn; hai đường còn khác chỗ bên mã hóa có giữ client key hay không. Không tính key hoặc framing vào bảng. Binding WASM này không trực tiếp có `FheUint16.ge`; kết quả chỉ giúp chọn transport/migration, không so với latency CGGI và không thiết lập quyền chi. Trước tích hợp, xem điều khoản [BSD‑3‑Clause‑Clear và patent](https://github.com/zama-ai/tfhe-rs#license).

### ZK, EVM và kiểm thử hồi quy

ZK/EVM: 20 mức cây, 6.053 constraints, 4 public signals. Một vòng thử **33 deposit** dùng khoảng **778k–1,20M gas**/deposit; spend hợp lệ khoảng **288k gas**. Đây là giá đo trên EVM giả lập Hardhat với solc 0.8.24, optimizer 200, không phải phí tiền thật; các bit cây, slot đã ghi và bytes proof làm gas thay đổi. Bản cũ không có baseline gas hợp lệ để tính phần trăm cải thiện. Một giao dịch thật trên EVM local bị revert bởi receiver; `totalLocked` và nullifier không đổi, sau đó dùng lại đúng proof khi receiver nhận ETH thành công.

| Kiểm tra | Kết quả đã chạy |
| --- | --- |
| `npm run test:zk:rust` với `MOBUBU_RUST_VERIFY_BIN` | **4/4**, ~8 s warm. Proof thật hợp lệ với Solidity/Rust, public recipient bị sửa và wire có byte thừa bị Rust từ chối. Test Solidity còn kiểm domain, known root, spent nullifier, thứ tự log và giao dịch revert trước khi trả tiền. Cold setup + suite khoảng 180 s. |
| `cargo test` + release build tại scratch | **2/2** unit test, kiểm định dạng proof/key/statement. Không phải build `--locked` thông qua crates.io. |
| `npm run test:fhe` (SPQLIOS‑FMA) | **78/78**, 15 suite, ~56 s thời gian test không tính build. Gồm BFV, CGGI, và 16 ca streaming. |
| `TFHE_FFT=nayuki-portable` + `node --test dist/test/tfhe-balance.test.js` trong `fhe-swap` | **5/5**, ~21 s; build fallback thành công, test so sánh/width/division/IPC/key file. Không chạy toàn bộ suite trên fallback. |
| `npm --prefix fhe-swap run demo` | Mô phỏng 5 chunk BTC→NYX→ETH, 193,60351088 ETH một lần vs 198,21309995 ETH với 10 lượt arb trong fixture. Không phải dự báo giá/hiệu suất trên chain thật. |

## 5. Công cụ đã cài và giới hạn còn lại

- Cài từ lockfile NPM: Circom2 (`circom2@0.2.23` → Circom 2.2.3), circomlib 2.0.5, snarkjs 0.7.6, solc 0.8.24, Hardhat 3.22, node-seal 7. Không dùng `npx` tải một verifier hay compiler không pin lúc chạy. Rust/Cargo 1.88.0 cài trong sandbox; vì `index.crates.io`/`static.crates.io` không tới được ở đây, lần kiểm Rust dùng source snapshots GitHub với các phiên bản trong lock (riêng `spin` dùng snapshot backport cùng phiên bản). Đó không phải lần kiểm download archive crates.io; lệnh và CI chuẩn dùng `cargo --locked` trên crates.io. Không vendoring toolchain/khóa/binary vào Git.
- `npm audit` root từ 23 xuống **18** (15 low, 3 high, gồm cảnh báo lan qua các package phụ thuộc, không phải 18 lỗi độc lập). Phần còn lại nằm ở Hardhat/Zod và ethers v5/elliptic kéo bởi `circomlibjs`. `npm audit --omit=dev` root và audit trong `fhe-swap` trả 0; phép đo đó không bao phủ toolchain ZK cần dev deps. Pin bản vá lồng `ws`, `underscore`, `tmp`, không force đổi major. Không dùng toolchain local này như API phục vụ dữ liệu không tin cậy.
- Chưa có **durable journal/outbox** cho cross-chain. Bước tiếp theo: cùng một transaction persist credit bằng `(network, txid, vout/logIndex, blockHash)` + fill + outbox; kiểm crash ở trước/sau DB commit, sign, broadcast và reorg. Phân biệt confirmed/finalized theo chain, DKG/handover khóa theo epoch và quy trình rescan. Tích hợp testnet với signer/adapter thật nhưng không tự động deploy mainnet.
- Vault chưa có ceremony nhiều bên, trusted build/reproducibility review, kiểm chứng zero-knowledge/range độc lập, hay policy cho thực thi thực tế. Audit toàn bộ hệ thống và dữ liệu công khai phải tách khỏi kết quả test local.
