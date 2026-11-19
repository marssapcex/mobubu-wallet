# hcmtrail native · Vault STARK, oracle và báo giá FHE

**Mã nguồn riêng, chỉ thử với dữ liệu và tiền giả lập.** Bốn vault Solidity nạp/rút native trên **chính chain của vault** bằng STARK. [`ZamaNativeQuotes`](contracts/fhe/ZamaNativeQuotes.sol) làm báo giá mã hóa bằng FHE trực tiếp trong Solidity. Hai luồng vẫn tách biệt: chưa có FHE ràng buộc vào quyền chi, chưa có settlement liên mạng, chưa deploy công khai.

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
npm run build:fhe && npm run test:fhe:evm
```

`test:vault` dựng stack và nạp tiền trong EVM bộ nhớ, rồi gửi proof của chính các note đó từ tài khoản khác. Test còn cố sửa amount, recipient, phí, root và nullifier, đổi domain, thử verifier giả và thử replay sau khi rút. Xem [VAULTS.md](docs/VAULTS.md) cho cấu trúc proof, cách sinh vector mới và các giới hạn.

Trên Linux x86-64, với compiler TVM **chính thức** đã pin checksum:

```sh
bash scripts/fetch-tron-solc.sh /tmp/hcmtrail-native-tron-solc
export TRON_SOLC=/tmp/hcmtrail-native-tron-solc
npm run build -- --tvm
npm run build:vault -- --tvm
npm run test:tvm && npm run test:vault:tvm
npm run test:fhe        # Linux getrandom, C/C++ compiler, curl, tar, patch; tải TFHE đã pin
npm run test:fhe:trace  # replay trace Solidity với TFHE thật, KMS/host fixture
```

TVMJS thực thi bytecode của compiler TRON và chuyển số dư sun trong bộ nhớ. Đây không phải kiểm tra java-tron, TAPOS, phí Energy thực, finality hay giới hạn node công khai. Không có script gửi giao dịch lên RPC bên ngoài.

`npm run bundle` tạo `dist/hcmtrail-native-source.tar.gz` bằng GNU tar. Giải nén vào thư mục rỗng để build và test mà không cần repo ví cũ.

## Oracle là module độc lập, không cấp quyền rút

[`ChainlinkPriceEpochs.sol`](contracts/ChainlinkPriceEpochs.sol) đọc bốn proxy **cùng chain** bằng một contract. Policy đặt ở constructor, không admin/setter; keeper bất kỳ gọi `refresh()` không tham số. Oracle chặn round sai, feed cũ, giá ngoài biên, skew hoặc sequencer L2 lỗi. [`NativeAssets.sol`](contracts/NativeAssets.sol) đổi đơn vị và lấy floor một lần theo tỷ số giá. Demo dùng bốn feed giả, kiểm **12 chiều báo giá**, không phải 12 chiều chuyển tiền.

Ví có thể đọc epoch công khai rồi tính riêng. Đừng gửi amount riêng vào `quote()` qua RPC. [`CHAINLINK.md`](docs/CHAINLINK.md) ghi nguồn, precision/heartbeat và candidate hub; chưa pin oracle triển khai công khai.

## Phép tính FHE nằm trong Solidity

`ZamaNativeQuotes` import `@fhevm/solidity@0.13.4`. Ví gửi `debit` và `minOut` đã mã hóa; contract dùng `FHE.fromExternal`, `mul`, `div`, so sánh và `select` trên handle. Amount đầu ra chỉ cho requester giải mã; nếu chọn public thì chỉ bit hợp lệ được giải mã và xác minh bằng `FHE.checkSignatures` với đúng epoch và request. Địa chỉ requester và tuyến vẫn công khai. Xem [FHE.md](docs/FHE.md) cho miền `euint128`, ví dụ SDK và hai mức test (EDR fixture và replay TFHE thật).

Host cấu hình Ethereum/Sepolia; test local dùng `31337`. Chưa có xác nhận live, cấu hình FHEVM trên BSC/TVM/HyperEVM, hay payout liên mạng. [`REFERENCES.md`](docs/REFERENCES.md) ghi nguồn tham chiếu. [`SETTLEMENT.md`](docs/SETTLEMENT.md) liệt kê phần còn thiếu: ràng buộc ciphertext và epoch vào proof của debit, giữ chỗ thanh khoản, kiểm finality và claim đích. Không thay những phần đó bằng chữ ký nhà vận hành.

**Không đưa tiền thật vào.** Có thể mất tiền do lỗi prover/verifier, gửi sai note, nhận tiền bị revert hoặc vault không còn liveness. Chưa audit, chưa chứng nhận anonymity hoặc an toàn hậu lượng tử. Không xóa cây nguồn cũ khi bản mới chưa thay thế được nó.
