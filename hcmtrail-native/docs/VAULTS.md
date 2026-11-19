# Bốn vault native: nạp → note → STARK → rút local

Một vault chỉ để thử với bộ mô phỏng của chain của nó. Không có tài sản bọc, nguồn mint, bridge, đường rút khẩn cấp hoặc quyền sửa verifier. **Không deploy với tiền thật.**

## Ranh giới thực thi

| Thành phần | Điều vault kiểm |
| --- | --- |
| Nạp | `msg.value` dương và tổng dư không quá `custodyCap`. Tạo leaf `Poseidon([valueLo32, valueHi32, assetId, 0x4e4f5445], ownerCommit)`. `ownerCommit = Poseidon(spendPk, blinding)`, không gửi khóa chi lên chain. Gửi trực tiếp không tạo note. Số dư bị ép vào vault không tăng nghĩa vụ hay quyền rút. |
| Domain | `chainId` cố định theo loại vault. Leaf số 0 lấy từ hash `(version, chainId, địa chỉ vault, asset, STARK image)`; chỉ append, không nhập root ngoài. Proof nhận root của chính cây đã nạp; cùng signer/nonce hoặc cùng giá trị chưa đủ để dùng chéo vault. Không chống được một fork sao chép cùng chain ID, địa chỉ và toàn bộ trạng thái. |
| Proof | Một join-split: tối đa hai note đầu vào, hai commitment đầu ra, bảo toàn theo số **nguyên** `in0 + in1 = change0 + change1 + amount + fee`. Cây Merkle Poseidon/Goldilocks sâu 32 và khóa chi nằm trong witness. Public inputs của circuit bind root, asset, hai nullifier, hai commitment, payout, fee, hai địa chỉ và `notBefore`. Association root bắt buộc bằng note root. Giá cố định `0` vì đây **không phải phép đổi tiền**. |
| Rút | Kiểm root đã công bố, mốc mở trên lưới 600 giây, backing thực, canonical field và hai nullifier phân biệt/chưa dùng. Xác minh proof đầy đủ; không nhận digest, chữ ký xác nhận, mock hoặc Groth16. Ghi cả hai nullifier và change rồi mới chuyển native. Payout/fee bị revert thì toàn bộ thay đổi lùi lại. |
| Relay | Địa chỉ nhận và địa chỉ phí được proof ràng buộc. `msg.sender` không có quyền chọn lại payout. Chủ note phải tạo proof một lần, không cần ký giao dịch rút bằng ví nạp. Relayer vẫn gửi giao dịch bằng khóa gas của mình; không có dịch vụ keeper chạy thật trong bản này. |

ETH/BNB/HYPE có tổng cap `0xffffffff00000001 - 2` **đơn vị cơ sở** (~18,4467 coin mỗi vault), TRX cap `2^63 - 1` **sun**. Đây là cap bảo thủ của thử nghiệm, không dùng cap `uint96` của oracle cho note. Roots đã công bố và nullifier không hết hạn do việc sinh proof có thể kéo dài. Cây hữu hạn và storage tăng, chưa có migration; khi cây hết chỗ, kể cả tạo change khi rút cũng có thể bị chặn. Không phát hành phiên bản này.

## Stack và phiên bản compiler

1. Build `npm run build:vault` (Ethereum/BSC/HyperEVM) hoặc `TRON_SOLC=… npm run build:vault -- --tvm` (Tron). Artifacts tách `build/evm/vaults` và `build/tvm/vaults`.
2. Trong **bộ mô phỏng**, dựng `PrepareNb_A`, `WalkNb_A(prepare)` và `Chunk` cho ba runtime in `EvaluatorChunks.json`. Truyền `(prepare, walk, chunks[3])` vào contract đúng chain. ABI và cách dựng nằm ngay trong [`test/vault-fixture.mjs`](../test/vault-fixture.mjs), không có lệnh deploy lên mainnet.
3. Constructor kiểm hash runtime của prepare và hash runtime template của walk, gồm kiểm **cả hai** vị trí immutable phải trỏ đúng prepare. Vault tự tạo evaluator và Poseidon từ code cố định. Evaluator kiểm hash từng chunk. Không có địa chỉ predicate do caller tùy chọn sau khi dựng.
4. Pin `solc` và `tron-solc` 0.8.24, target `paris`, optimizer 200 runs, `metadata.bytecodeHash: none`. `node scripts/build-vault.mjs --pins` (thêm `--tvm` nếu cần) xuất hash/offset từ đúng nguồn. Đổi compiler, tham số hoặc generated verifier không phải một cấu hình có thể sửa trên deployment cũ.

Verifier là shape A của NotBefore (37 limbs, Goldilocks mở rộng bậc hai, KECCAK/DEEP-FRI radix 8, mask ZK do prover upstream kiểm). Image `4364151e9f54797f3bbf9c8d28465f5a7dcf8ca1aafa9c9b48eb43cedf4e2429`, params `ccba76ed5748b5ee54dfd62935fd1d10998b5c0f84e35a9dc899905cfb1eadb5`; chỉ chấp nhận NOXP format 7/protocol 1, tối đa 128.000 proof bytes. [Nguồn và giấy phép](../contracts/vendor/nonos/NOTICE.md). Upstream công bố ~80,1 bit soundness cổ điển có chứng minh theo giả thiết của họ; không suy ra 128-bit hậu lượng tử hay audit từ đó.

## Kết quả với bốn bộ note đã nạp

| Vault | Rút chính xác (không kể phí relay) | Kích thước proof | Chi phí rút trong mô phỏng |
| --- | ---: | ---: | ---: |
| Ethereum | 0,01 ETH | 96.200 byte | 8.532.181 EVM gas |
| BSC | 0,01 BNB | 95.592 byte | 8.507.625 EVM gas |
| TRON | 10 TRX | 94.600 byte | 6.615.597 đơn vị thực thi TVMJS |
| HyperEVM | 0,01 HYPE | 94.792 byte | 8.508.833 EVM gas |

Đây là số đo cho đúng vector, không phải dự báo phí, hạn mức hay xác nhận của mạng công khai. Các bài kiểm có chuyển số dư thực trong máy ảo, thử sửa public inputs, đổi vault/domain, replay và rollback khi hợp đồng người nhận từ chối trên EVM. Quá trình sinh proof mới mất vài phút mỗi vector, phụ thuộc máy và số vòng grind; không phải độ trễ thực thi của verifier.

## Sinh lại proof local, không dùng seed thật

Các vector trong `test/vectors` chỉ chứa proof và statement công khai. Seed nạp giả lập là cố ý công khai trong fixture. Địa chỉ vault và root đến từ giao dịch nạp của các bộ mô phỏng, không chép proof của upstream rồi đổi metadata. CI replay các proof này qua bytecode hiện tại; không cần Rust để chạy các test replay.

Muốn sinh proof mới, clone prover upstream (AGPL-3.0-or-later) vào thư mục riêng với Cargo/rustup, compiler C và đủ RAM:

```sh
refs=$(mktemp -d)
git clone https://github.com/NON-OS/STARKs.git "$refs/starks"
git -C "$refs/starks" checkout --detach a47d23ae969e23b5f841e30b49a1d483a80a6b02
(cd "$refs/starks" && cargo build --locked --release -p nox_prover \
  --features parallel,not_before --bin nox_bench --bin nox_share)
NATIVE_STARK_PROVER_DIR="$refs/starks/target/release" \
  node scripts/generate-vault-vectors.mjs build/regenerated ETH BNB HYPE
NATIVE_STARK_PROVER_DIR="$refs/starks/target/release" TRON_SOLC=/path/to/tron-solc \
  node scripts/generate-vault-vectors.mjs build/regenerated TRX
```

Lệnh dùng `/dev/urandom`, nên byte proof mới có thể khác. `LeafAppended(index, commitment)` và `RootPublished(root, count)` là dữ liệu để dựng lại cây; giữ leaf domain số 0 và không bỏ các commitment change. Với bộ prover này, `assoc_leaves` và `assoc_root` phải khớp cây note; private seed chỉ ở máy sinh proof. `NATIVE_PERIODIC_CACHE` tùy chọn là **file** cache chung cho đúng circuit (chừng 8 MB); không đưa cache vào Git. Kết quả chỉ ghi ra sau khi Rust xác minh, mã hóa format 7 và giao dịch rút trong mô phỏng kiểm đúng balance/fee. Không lưu các bí mật change vào vector kết quả. Trên máy ít RAM, chạy từng prover một. Tải toolchain pin theo `rust-toolchain.toml` của nguồn tham chiếu.

## Trước khi cân nhắc mạng thật

- Giới hạn tx hiện hành khác nhau. Bộ EVM kiểm gas giao dịch dưới mức [EIP-7825](https://eips.ethereum.org/EIPS/eip-7825) cho vector mẫu; vẫn cần đo cấu hình RPC/mempool và chi phí từng rail. [HyperEVM](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/dual-block-architecture) có fast/large block; các tx lớn của stack này không phù hợp fast block 3M gas trong đặc tả hiện tại. TVMJS không đo `fee_limit`, deadline CPU hoặc kết quả trên java-tron.
- Deposit, amount/recipient rút và timing hiện công khai. Phần ẩn trong proof là note mở, khóa chi, phần change và membership. Tập ẩn danh của ví dụ rất nhỏ. Không coi contract này là cách giấu nguồn tiền trước quan sát chéo chain.
- Không có FHE input proof, evaluation/decryption proof hoặc authenticated source debit, inventory reservation và finalized claim đích. Các mục trong [SETTLEMENT.md](SETTLEMENT.md) phải có test tích hợp riêng, audit độc lập và đo vận hành trước khi hứa 12 tuyến settlement.
