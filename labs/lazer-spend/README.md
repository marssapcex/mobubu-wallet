# LaZer: thử quan hệ rút note mệnh giá cố định

**Lab lưu trữ, không nằm trong luồng nạp/rút. Không rút ETH, không deploy, không dùng tiền thật.** Lab này sinh và xác minh proof LaZer thật, không cần witness ở verifier; sổ tiền trong test chỉ là bộ đếm. [Vault ETH mặc định](../../PROTOCOL_DESIGN.md) đã thay v2/v3 Groth16 bằng chữ ký SLH-DSA. Không có cổng rút LaZer, precompile giả, chữ ký attester hay Groth16 wrapper trong lab.

## Chạy

```bash
npm ci
npm run test:lazer
```

Cần Linux x86-64 với AES-NI, VAES, AVX-512 (gồm VBMI/VNNI), GCC hỗ trợ `gnu2x` (đã chạy GCC 12.2), `make`, `curl`, `tar`, `sha256sum`, Python 3 và Node theo repo. Không cần Sage, GMP, CFFI hoặc Python package ngoài stdlib. Build tải hai archive pin có SHA-256, không cài vào hệ thống. Lệnh chạy bộ test native và probe EVM Osaka in-process không nối RPC ngoài. `ERROR in ...` do verifier in trong các ca **cố tình gửi proof sai** là bình thường nếu test vẫn `ok`.

Thư viện và hai file kết quả `measurements.json`, `evm-measurements.json` ở `build/lazer-spend/` (ignored). Có thể đặt `MOBUBU_LAZER_BUILD_DIR` sang thư mục riêng. Không lưu secret hay proof mẫu ra file.

## Proof ràng buộc gì?

- `lazer_spend.py` tạo note bí mật 1.024 byte, tính commitment và cây Merkle thưa thêm theo thứ tự. Chỉ hỗ trợ profile đã thử ở độ sâu **3** và **20**. Cây không tự xác định khoản nào có tiền: ledger phải lưu chính cặp `(root, count)` khi nhận đúng mệnh giá.
- [`spend.c`](spend.c) mở commitment từ 16 đa thức bit bí mật. Với `B()` là tách 8 bit mỗi hệ số và `A` là ma trận hash Merkle của LaZer, một nút cha là `H(B(left) ‖ B(right))`, `H(s) = A·s mod 256` trong vành bậc 512. Các bit hướng đi là binary và được chứng minh là hằng số. Phương trình `index + slack = count − 1` dùng cùng bit hướng đi, với `slack` cũng là số không âm biểu diễn bằng bit ẩn. Nhờ đó biết preimage của ô đệm zero vẫn không cho phép rút từ root/count đã ghi.
- Nullifier thử nghiệm là `⌊(T_scope·s[0:2] mod 256)/4⌋` trên **chính hai đa thức đầu của bí mật mở commitment**. Hai bit thấp là witness trong phương trình LWR, nên proof không thể nhận một tag tùy ý. `T_scope` lấy từ SHAKE256 trên `"mobubu/lazer-spend/v1/nullifier" || 0x00 || scope`; 14 đa thức còn lại đến từ randomness độc lập. Tag không phụ thuộc root, count, người nhận hay randomness của proof.
- Verifier dựng lại ma trận, ràng buộc, norm và `zk=1` từ profile và instance công khai. `scope` là `version[4] || chainId[32] || vault[20] || asset[20] || denomination[32]`. Instance là `scope || depth[1] || count[4] || recipient[20] || root[512] || nullifier[512]`; số nguyên big-endian, hai đa thức public mỗi hệ số một byte, tag trong `0..63`. Đưa toàn bộ instance vào hash mở đầu transcript (có nhãn miền riêng). Không có leaf, index, đường cây hay secret trong interface xác minh. Nếu dùng instance do người gọi đưa mà không đối chiếu với state thì **chưa** cấp quyền rút.
- [`wire.c`](wire.c) encode proof của chuỗi LaBRADOS có vòng ZK (không phải LNP22 độc lập). `LZS1` chứa các message của Dachshund, pack (gồm LNP và phép chiếu công khai ở vòng không nén) và opening cuối sau nén; hệ số theo thứ tự cục bộ của engine, signed little-endian 40/32/16 bit. Không serialize con trỏ, struct ABI, tham số, hay witness đầu vào. Decoder kiểm kích thước theo tham số verifier tự sinh và giữ nguyên đại diện hệ số tham gia hash của engine. Đây là **codec thử nghiệm**, không phải format LaZer tiêu chuẩn hay codec nén tối ưu.

Các test kiểm xác minh từ một tiến trình mới chỉ nhận public instance + bytes proof, sai người nhận/chain/vault/tài sản/mệnh giá/phiên bản/root/count/tag, sai secret/path, padding chưa fund, wire bị sửa/cắt/nối và replay kể cả dưới root mới. Sổ giả lập từ chối ghi khi payout thất bại, rồi dùng lại đúng proof để ghi chi thành công một lần.

## Kết quả và điều kiện loại đối với Ethereum

Một lượt trên Xeon 2,60 GHz, Linux x86-64, Python 3.11.2; thời gian native gồm dựng statement/codec. Randomness làm thay đổi số byte zero, không đổi độ dài proof trong profile này.

| Độ sâu | Proof serialize | Sàn calldata chỉ proof | Sinh / kiểm native | Buffer JL lớn nhất |
| ---: | ---: | ---: | ---: | ---: |
| 3 | 161.540 B | ~5,69 triệu gas | ~3,06 / 1,29 s | 33.767.424 B |
| 20 | 166.660 B | ~5,81 triệu gas | ~2,07 / 0,98 s | 33.865.728 B |

Calldata chỉ mang proof còn dưới trần; **chỗ chặn là thực thi verifier**. `wire_jl_profile` đếm số byte mà backend hiện tại phải sinh cho các ma trận Johnson–Lindenstrauss từ challenge. [`evm-bound.mjs`](evm-bound.mjs) thử hai phần đó riêng trên EDR Osaka, không chạy verifier hoặc payout:

1. Với bản port giữ nguyên buffer dày, chỉ mở rộng EVM memory cho **một** buffer lớn nhất đã tốn tối thiểu **2.177.998.848 / 2.190.689.280 gas** (độ sâu 3 / 20, công thức `3w + floor(w²/512)`, `w` là số word 32 byte). Giao dịch thử `mstore` chạm cuối buffer thất bại, hết **16.777.216 gas** dù chưa sinh một byte ma trận nào. Đối chứng 1 MiB chạy thành công, dùng **2.216.870 gas** gồm giao dịch.
2. Stream AES-128-CTR tránh giữ buffer lớn: check output trên EVM so với OpenSSL. Đo **266.949 / 507.333 gas** cho 32 / 64 block, tức thêm **7.512 gas/block** trong kernel đã cấp sẵn round keys. Verifier gốc sinh tương ứng **6.931.456 / 7.922.688 block AES** cho toàn bộ phép chiếu. Ngoại suy **chỉ AES của kernel đã đo** đã là ~52,07 / 59,52 tỷ gas, chưa gồm key expansion, SHAKE, số học lattice, kiểm proof hay payout. Đây không phải gas của full verifier hoặc cận dưới cho mọi thuật toán.

So với [EIP-7623](https://eips.ethereum.org/EIPS/eip-7623) và [trần giao dịch EIP-7825](https://eips.ethereum.org/EIPS/eip-7825): không dùng bản port trực tiếp của backend này để rút trong một giao dịch Ethereum. Không suy ra mọi verifier lattice hay một thiết kế lại phép chiếu đều bất khả thi. Cần verifier khác hoặc hỗ trợ thực thi phù hợp **trên chain đích**, rồi đo toàn bộ giao dịch, trước khi nối vào một vault mới. Giữ nguyên cổng rút đang dùng trong khi chưa có đường thay thế đó.

## Nguồn và giới hạn bảo mật

Build chỉ dùng backend LaBRADOS trong [LaZer `b958e247`](https://github.com/lazer-crypto/lazer/tree/b958e247a2fdb9593b3c25c9603c6c5305c19420) (MIT: Makefile và ma trận) và [Labrador `c1ae0e61`](https://github.com/lazer-crypto/labrador/tree/c1ae0e612d5accd9e7d9d1c264951c1afe949c83) (Apache-2.0: proof engine), không copy thư viện vào Git. Tùy chọn `-include stdalign.h` cho GCC 12. Không thay code proof upstream. Merkle và kiểu LWR lấy cảm hứng từ các case study trong [ePrint 2026/1289](https://eprint.iacr.org/2026/1289), nhưng **tổ hợp chi note, tham số, codec và transcript của lab không được audit**. Không khẳng định unlinkability với note do đối thủ chọn, độ an toàn QROM của cả tổ hợp hoặc mức bảo mật lượng tử cụ thể. Không tái dùng bí mật qua các vault. Không mở prover/verifier C nghiên cứu làm dịch vụ public; chưa kiểm side channel, malformed input đầy đủ hoặc chứng minh chính thức rằng revision code khớp kết quả bảo mật mới nhất của bài báo.
