# Mobubu Wallet — swap native BTC / ETH / BNB

**[Luồng swap native](docs/NATIVE-SWAP.md):** BTC ↔ ETH, BTC ↔ BNB, ETH ↔ BNB. TFHE tính output và so `minOut` trên ciphertext; người dùng ký lệnh bằng SLH-DSA. Hai rail EVM chuyển native asset; Bitcoin xác nhận giao dịch multisig 2-of-3. Không ZK hay wrapped coin. Đã kiểm với Bitcoin Core regtest và hai EVM local độc lập, chưa triển khai công khai. [Cấu hình, cách chạy và giới hạn custody](docs/NATIVE-SWAP.md).

**Vault ETH cá nhân là [`PostQuantumVault`](contracts/PostQuantumVault.sol).** Nạp ETH vào số dư của một khóa công khai; rút một phần hoặc toàn bộ bằng chữ ký **SLH-DSA-SHA2-128s (FIPS 205)**. Cả hai lệnh kiểm chữ ký trong hợp đồng, dùng SHA-256 có sẵn trên EVM. Không có Groth16, LaZer, trusted setup, server ký thay hoặc đường rút dự phòng. SDK mặc định ký local; khóa bí mật không gửi vào RPC hay contract.

**Đã kiểm bằng giao dịch ETH trên EVM Osaka local. Chưa deploy lên mạng công khai, chưa audit độc lập; không nạp tiền thật.** Khóa công khai, số dư, người nạp, người nhận và số tiền đều nhìn được trên chain: đây **không** phải vault ẩn liên kết nạp–rút. Giao dịch trả gas và cơ chế đồng thuận Ethereum không đổi.

## Build và kiểm thử

Yêu cầu **Node.js ≥22.13** và `npm`. Không cần Circom, Rust, RPC hay ceremony cho vault mặc định.

```bash
npm ci
npm run build:contracts   # build/contracts.json; không gửi giao dịch
npm test                  # vector NIST, nạp/rút thật trên EVM local, ca từ chối và oracle fixture
npm run test:vault        # vault ETH cá nhân và SDK
npm --prefix fhe-swap ci
BITCOIND=/path/to/bitcoind npm run test:swap    # 6 chiều với BTC regtest + 2 EVM local
```

Artifact để triển khai local là `build/contracts.json` → `contracts/PostQuantumVault.sol` → `PostQuantumVault`; constructor không có tham số. SDK import từ `mobubu-wallet` (hoặc [`packages/client/src/index.mjs`](packages/client/src/index.mjs)). Xem [đặc tả, cách gọi SDK và gas đo được](PROTOCOL_DESIGN.md).

**Thay đổi ABI:** note, proof, số dư và địa chỉ v2/v3 cũ không dùng được với vault mới. Các contract cũ nếu đã deploy vẫn chạy đúng bytecode cũ; không có nâng cấp hoặc di chuyển tiền tự động. [Mã Groth16 cũ](legacy/groth16/README.md) chỉ để đối chiếu lịch sử, không nằm trong build/test mặc định hay SDK mới.

## Các phần độc lập

| Phần | Chạy được | Ranh giới |
| --- | --- | --- |
| [Oracle và catalog](docs/SWAP-10-MANG.md) | Catalog 10 mạng và giá tham chiếu Chainlink trên Ethereum + BSC | Chỉ đọc; không cấp quyền chi hay mở thêm mạng settlement |
| [FHE](fhe-swap/README.md) | CGGI client/evaluator cho báo giá mã hóa; BFV và probe TFHE-rs/WASM độc lập | Không quyết định quyền chi hay che số tiền đã settle on-chain |
| [Streaming swap](fhe-swap/README.md) | NYX hub trên ba mạng gốc, minOut theo chunk, retry payout/refund trên mock chain | Không giữ tiền, không ký chain thật, không nối vault |

```bash
npm run networks
npm run test:oracle
npm --prefix fhe-swap ci
npm run audit:deps
npm run test:fhe          # cần Linux x86-64 và toolchain native; xem README ở fhe-swap/
```

`npm run verify:all` chạy build, test mặc định và FHE sau khi cài cả hai lockfile. [CI](.github/workflows/research-checks.yml) có job riêng cho vault/oracle, swap native và FHE/streaming mock.

**Tài liệu lưu trữ:** [note v3 và simulator 10 mạng](docs/NOTE-GIA-TRI.md) · [Rust kiểm Groth16 v2](mobubu-wallet-rust/README.md) · [nghiên cứu riêng tư hậu lượng tử](docs/RIENG-TU-HAU-LUONG-TU.md) · [lab LaZer không chuyển ETH](labs/lazer-spend/README.md) · [review mainnet trước khi đổi vault](docs/SAN-SANG-GOI-VON-AUDIT-MAINNET.md).
