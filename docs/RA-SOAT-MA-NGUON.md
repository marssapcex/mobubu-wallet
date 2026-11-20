# Rà soát mã nguồn Mobubu — vòng dọn dẹp và hồi quy

> **Bản ghi lịch sử trước khi thay vault.** Luồng đang dùng, lệnh build và kiểm thử mặc định hiện ở [đặc tả vault SLH-DSA](../PROTOCOL_DESIGN.md). Những kết quả ZK ở đây thuộc bản lưu trữ.

**18-11-2026 · Phạm vi: ZK vault trên EVM local, thí nghiệm FHE, và streaming trên mock chain.** Đây là rà soát nội bộ và kiểm thử hồi quy, không phải audit mật mã độc lập. Không triển khai hoặc nạp tiền thật với bản này. Số đo hiệu năng vòng trước được giữ riêng trong [báo cáo nghiên cứu](NGHIEN-CUU-ZK-FHE.md).

## Đã sửa và giữ lại gì?

| Phát hiện | Thay đổi và bằng chứng kiểm thử |
| --- | --- |
| Harness ZK kéo phần lớn cây phụ thuộc, nhưng chỉ cần compile và chạy EVM local | Bỏ Hardhat và `circomlibjs`. [Build](../scripts/compile-contracts.mjs) dùng `solc` 0.8.24; [fixture local](../legacy/groth16/test/support/vault-evm.mjs) dùng EDR Shanghai, triển khai `PoseidonT3` và Groth16 verifier sinh từ circuit. `poseidon-lite` phía client khớp các root trên Solidity qua 33 lần nạp. Không thay công thức note hay public signals của vault v2. |
| Dữ liệu witness và cache local thiếu kiểm tra ở biên | [SDK và Rust wire cũ](../legacy/groth16/packages/client/src/) dùng cùng thứ tự statement, kiểm range, kiểu và đường Merkle trước khi tạo proof/encode. Test gọi Circom trực tiếp với witness sai, không chỉ dựa vào SDK. Cache disposable kiểm marker, kích thước và SHA-256 của artifacts; test sửa VK thì cache bị từ chối. Rust kiểm file thường/kích thước trước và sau mở; regression FIFO trên Linux trả lỗi thay vì chờ. |
| CGGI cần phát hiện ciphertext sai key hoặc frame không hợp lệ sớm hơn | [Wrapper](../fhe-swap/src/fhe/tfhe.ts) gắn `keyId` từ SHA-256 cloud key, kiểm width, encoding và chiều dài tương ứng, đóng băng envelope trả về. Test khác key hoặc blob sai bị từ chối trước khi gọi gate. Native worker giới hạn dòng 2 MiB trước khi dispatch; timeout chấm dứt worker và trả lỗi cho các request đang chờ. Evaluator vẫn không giữ secret key. |
| Prototype RPC, địa chỉ một lần giả và `SwapEngine` dễ bị hiểu là có custody | Xóa scaffolding RPC/chain, sổ địa chỉ giả, engine single-shot và các test gắn riêng với chúng. Giữ demo `demo:bfv` để kiểm quote và `demo` để chạy streaming mock. BFV kiểm ID khớp header/ciphertext và số học client-side, **không** xác thực giá. `build` dọn `dist/` trước khi biên dịch; test tìm cả thư mục con. |
| Mock settlement có thể thấy depth cũ nhưng watcher không còn observation ban đầu | [Streaming](../fhe-swap/src/core/streaming.ts) tách `depositTag` khỏi `orderId`, cố định tx/asset/số tiền nguồn sau ghi có. Kiểm lại observation và depth trước mở lệnh, chunk mới, ký và gửi leg mới, và kết sổ. Nếu funding mất trong lúc ký, giữ nguyên bytes nhưng chưa broadcast; khi phục hồi không ký lại. Test watcher mất/thay tx hoặc amount, reorg giữa payout/refund, retry khi mất phản hồi, và chỉ ghi phí một lần sau kết sổ. Engine sao chép bảng adapter và danh sách arb bot lúc khởi tạo; các mock instance vẫn có state để mô phỏng lỗi. |
| Collector giữ share sau khi dùng, và sealed envelope chưa ràng buộc committee vào tag | [Orderflow](../fhe-swap/src/privacy/threshold.ts) dùng `threshold-aes-gcm-v2`: version và committee ID nằm trong AAD, IV 12 byte, tag 16 byte, ciphertext tối đa 4 KiB, Base64 canonical. Share phải theo đúng index và field range; retry cùng share không ghi đè, share khác cùng index bị từ chối. Xóa tham chiếu share sau khi open hoặc khi cần đối soát. Đây không phải xác thực người gửi share hay xóa an toàn dữ liệu khỏi RAM. |

**Tương thích:** không nạp lại sealed order v1 vào envelope v2. `EncryptedInt` cần `keyId` đúng key; với ciphertext cũ, tạo lại qua client của bản hiện tại. Mock API đổi trường inbound sang `depositTag`, outbound sang `orderId`; các RPC/settlement API prototype đã xóa, không có migration. ABI/wire của **ZK vault v2** giữ nguyên so với vòng nghiên cứu trước.

## Phụ thuộc và CI

| Kiểm tra | Trước vòng này | Sau `npm ci` ở cả hai thư mục |
| --- | ---: | ---: |
| `npm audit` root, **gồm dev deps** | 18 (15 low, 3 high) | **0** |
| `npm audit` trong `fhe-swap`, **gồm dev deps** | 0 | **0** |

Các mục đếm của npm gồm cả cảnh báo lan truyền trong cây phụ thuộc. Đã bỏ hai cây kéo [elliptic qua `circomlibjs`/ethers v5](https://github.com/advisories/GHSA-848j-6mx2-7j84) và [Zod qua Hardhat](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5), không dùng `npm audit fix --force`. GitHub Advisory Database trả **0** bản ghi khi truy vấn đúng tám cặp `crate@version` trong `Cargo.lock` (`ecosystem=rust`, `affects=…`). Đây là tra cơ sở cảnh báo theo phiên bản, không phải chạy `cargo audit` hay xác minh archive crates.io.

[Workflow](../.github/workflows/research-checks.yml) khóa SHA của GitHub Actions, không lưu token checkout vào cấu hình Git, kiểm audit ở ngưỡng moderate và chạy cả regression portable tập trung. YAML đã kiểm tra local; **chưa chạy kiểm chứng trên GitHub Actions**. Npm/Rust advisory không bao phủ toàn bộ code native/WASM, tham số CGGI, mạch Groth16 hay lỗ hổng chưa công bố.

## Kết quả đã chạy ở vòng rà soát này

Linux x86-64, Node 22.22.3, npm 10.9.8, Rust 1.88.0. Thời gian dưới đây là thời gian test, không tính build native.

| Lệnh / nhóm | Kết quả |
| --- | --- |
| `npm run build:contracts` | Biên dịch **3** nguồn Solidity bằng solc `0.8.24+commit.e11b9ed9`. |
| `npm run verify:all`, phần ZK/EVM/Rust với binary scratch | **7/7**, **0 skip**, ~8,5 s trên cache mới của vòng này. Cùng proof thật được Solidity/Rust chấp nhận; đổi recipient/byte thừa bị từ chối. Tx local revert được mine: balance và nullifier rollback, proof dùng lại được khi receiver chấp nhận thanh toán. 33 deposit đo **832.488–1.251.083 gas**; một withdraw đo **287.924 gas**, không phải chi phí trên mạng thật. |
| `cargo fmt --check` và Rust unit/release tại scratch | Format đạt; **2/2** unit test đạt và release build được. Scratch ghép source chính với snapshot GitHub, trong đó `spin` là backport cùng phiên bản; **không** thay `Cargo.lock` chính thức. |
| `npm run verify:all`, phần FHE/streaming SPQLIOS-FMA | **70/70** trong 12 suite, **0 skip**, ~58,9 s. Số ca khác vòng trước vì loại test engine/RPC/address book đã xóa, đồng thời thêm hồi quy cho phần còn dùng. |
| Nayuki portable + `tfhe-balance.test.js` | **6/6**, **0 skip**, ~22,7 s. Build và smoke test đạt; không chạy toàn bộ suite trên FFT fallback. |
| `demo` | Streaming BTC→NYX→ETH hoàn tất 5 chunk/10 lần rebalance: `198.21309995` so với `193.60351088` ETH ở mẫu single-shot; không dùng chain thật. |

Chạy lại từ root với Node/Rust đã cài, Linux x86-64 và toolchain C/C++:

```bash
npm ci
npm --prefix fhe-swap ci
npm run audit:deps
npm run build:contracts
npm run verify:all
```

`verify:all` ở snapshot cũ chạy Cargo `--locked` rồi kiểm cùng proof với native binary; để chạy lại xem [archive Groth16](../legacy/groth16/README.md). Sandbox không tải được index và archive crates.io, nên lần chạy trên dùng `MOBUBU_RUST_VERIFY_BIN` trỏ vào bản scratch sau khi kiểm unit test/build riêng. Nếu môi trường có registry Rust, hãy chạy lại **không** đặt biến đó để kiểm đường build chính thức. Lần đầu, test tạo Groth16 artifacts local-only trong `build/zk/local-only/`; cache hợp checksum không phải xác thực ceremony.

## Phần chưa thể kết luận

- **ZK:** chưa có ceremony nhiều bên, bytecode provenance và audit độc lập về mạch, Solidity, Poseidon/SDK. Bộ key local không an toàn để triển khai. Rust verify không kiểm root còn trong cửa sổ on-chain, spent nullifier hay finality.
- **FHE:** `keyId` chỉ chống dùng nhầm key, không xác thực ciphertext hay nguồn tiền. Worker, key files và SEAL chỉ nhận dữ liệu local tin cậy; không coi chúng là endpoint từ xa. Kết quả FHE hoặc quote BFV không cấp quyền chi.
- **Streaming:** `needs_review` không phải đã hoàn tiền. Observation các leg không phải snapshot finality nguyên tử; một reorg sâu vẫn có thể đảo giao dịch đã ghi nhận. Không có DB/journal, custody, cách xử lý nonce/UTXO hoặc người ký thật. Bước phát triển tiếp theo nên là journal/outbox cho mô phỏng và các test crash/replay/reorg quanh từng lần ghi có và ký; chưa nối vào tiền thật.
