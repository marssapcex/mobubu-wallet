# hcmtrail native · Vault STARK, staking HCMT và oracle

**Chỉ dùng coin testnet; chưa audit, không dùng mainnet.** Bốn vault Solidity nạp/rút native trên **chính chain của vault** bằng STARK. Bắt đầu ở [runbook testnet](docs/TESTNET.md): deploy Sepolia/BSC testnet/Nile/HyperEVM testnet, lưu note cục bộ, nạp có biên nhận, tạo STARK thật và rút/khôi phục change. [Kết quả kiểm tra](docs/TESTNET-RESULTS.md) phân biệt emulator với cổng live chưa chạy. Không có deployment công khai kèm theo.

**Profile có phí (testnet):** [HCMT / DAO / broadcaster](docs/HCMT-TESTNET.md) thêm phí native 0,25% mỗi lần nạp/rút, kho và 250.000 HCMT cố định cho từng chain, stake/claim theo kỳ 30 ngày và relay có bond. [STARK bắt buộc cho lệnh unstake và claim](docs/STAKING-STARK.md); signer gas không có quyền thay người nhận. Chạy `npm run build:dao`, `npm run test:dao` và `npm run test:stake`. Đây là deployment riêng; không nâng cấp treasury cũ hay dùng chung note với profile gốc.

Đã gỡ module báo giá mã hóa và các dependency của nó khỏi thư mục này. Oracle vẫn độc lập; ví có thể tự tính báo giá từ epoch công khai.

**Rút native liên mạng (devnet riêng):** [Cross-chain withdrawal](docs/CROSSCHAIN-WITHDRAWAL.md) triển khai giữ note theo coin nguồn, lấy giá lúc khóa rút, và chi native đích sau đúng phí DAO. Có tuyến ETH → HYPE qua hai VM và rút nội mạng vẫn không cần giá. `npm run build:crosschain` / `npm run test:crosschain`. Adapter truyền log thử nghiệm tin 2/3 witness; không phải cầu/finality proof hay deployment public. Không dùng tiền thật.

Các wrapper dùng chain ID mainnet dưới đây **chỉ giữ để hồi quy emulator**, không có lệnh deploy bằng CLI testnet:

| Tài sản | Mạng (chain ID) | Đơn vị cơ sở | Điểm vào Solidity |
| --- | --- | --- | --- |
| ETH | Ethereum (`1`) | `10^18` wei/ETH | [`EthereumVault`](contracts/ethereum/EthereumVault.sol) |
| BNB | BNB Smart Chain (`56`) | `10^18`/BNB | [`BscVault`](contracts/bsc/BscVault.sol) |
| TRX | TRON TVM (`0x2b6653dc`) | `10^6` sun/TRX | [`TronVault`](contracts/tron/TronVault.sol) |
| HYPE | HyperEVM (`999`) | `10^18`/HYPE | [`HyperEvmVault`](contracts/hyperevm/HyperEvmVault.sol) |

Mỗi vault cố định chain ID, asset và verifier; dùng chung [`NativeVault`](contracts/vault/NativeVault.sol), không có admin, proxy hoặc đăng ký ERC-20. `deposit(ownerCommit)` ghi đúng `msg.value` vào note. `withdraw(proof, exit)` kiểm STARK Goldilocks/DEEP-FRI trực tiếp, chi đúng người nhận/phí mà proof chỉ định và khóa nullifier một lần. Bất kỳ relayer nào cũng gửi được proof; không cần chữ ký giao dịch rút từ chủ note. Tiền nạp/rút và địa chỉ nhận native vẫn thấy được trên chain.

## Chạy độc lập

Node.js 22+, trong thư mục này:

```sh
npm ci --ignore-scripts
npm run build && npm test && npm run demo
npm run build:vault && npm run test:vault
```

`test:vault` dựng stack và nạp tiền trong EVM bộ nhớ, rồi gửi proof của chính các note đó từ tài khoản khác. Test còn cố sửa amount, recipient, phí, root và nullifier, đổi domain, thử verifier giả và thử replay sau khi rút. Xem [VAULTS.md](docs/VAULTS.md) cho cấu trúc proof, cách sinh vector mới và các giới hạn.

Trên Linux x86-64, với compiler TVM **chính thức** đã pin checksum:

```sh
bash scripts/fetch-tron-solc.sh /tmp/hcmtrail-native-tron-solc
export TRON_SOLC=/tmp/hcmtrail-native-tron-solc
npm run build -- --tvm
npm run build:vault -- --tvm
npm run test:tvm && npm run test:vault:tvm
npm run build:dao && npm run build:dao -- --tvm
npm run test:dao && npm run test:stake
```

TVMJS thực thi bytecode của compiler TRON và chuyển số dư sun trong bộ nhớ. Bộ test [testnet](docs/TESTNET.md) còn dựng và ký protobuf/TAPOS cục bộ nhưng **không** thay cho kiểm tra java-tron, phí Energy thật, finality hay giới hạn node công khai. Chỉ CLI `npm run testnet` do người dùng chủ động cấu hình signer/RPC mới gửi giao dịch công khai; các test không gửi.

`npm run bundle` tạo `dist/hcmtrail-native-source.tar.gz` bằng GNU tar. Giải nén vào thư mục rỗng để build và test mà không cần repo ví cũ.

## Oracle là module độc lập, không cấp quyền rút

[`ChainlinkPriceEpochs.sol`](contracts/ChainlinkPriceEpochs.sol) đọc bốn proxy **cùng chain** bằng một contract. Policy đặt ở constructor, không admin/setter; keeper bất kỳ gọi `refresh()` không tham số. Oracle chặn round sai, feed cũ, giá ngoài biên, skew hoặc sequencer L2 lỗi. [`NativeAssets.sol`](contracts/NativeAssets.sol) đổi đơn vị và lấy floor một lần theo tỷ số giá. Demo dùng bốn feed giả, kiểm **12 chiều báo giá**, không phải 12 chiều chuyển tiền.

Ví có thể đọc epoch công khai rồi tính riêng. Đừng gửi amount riêng vào `quote()` qua RPC. [`CHAINLINK.md`](docs/CHAINLINK.md) ghi nguồn, precision/heartbeat và candidate hub; chưa pin oracle triển khai công khai.

[`REFERENCES.md`](docs/REFERENCES.md) ghi nguồn verifier. [`SETTLEMENT.md`](docs/SETTLEMENT.md) là yêu cầu cho mô hình riêng tư và finality độc lập, chưa phải tính năng production.

**Không đưa tiền thật vào.** Có thể mất tiền do lỗi prover/verifier, gửi sai note, nhận tiền bị revert hoặc vault không còn liveness. Chưa audit, chưa chứng nhận anonymity hoặc an toàn hậu lượng tử. Không xóa cây nguồn cũ khi bản mới chưa thay thế được nó.
