# Mã hợp đồng hiện hành: HCFR v2 và ETH Vault V3

**Chưa có vault hậu lượng tử dùng được với tiền thật.** Hai nhóm dưới đây độc lập: HCFR v2 kiểm FRI, không kiểm quan hệ chi note; ETH Vault V3 dùng NotBefore A để kiểm chi note **trong lab**. Không dùng `WideFri256.progress().complete` làm quyền rút. Mọi link là **mã nguồn**, không phải địa chỉ triển khai công khai.

## HCFR v2 · nghiên cứu hướng hậu lượng tử

| Mã Solidity | Vai trò |
| --- | --- |
| [`WideFri256.sol`](../contracts/research/stark256/WideFri256.sol) | Verifier FRI; chỉ hoàn tất khi đã kiểm đúng 144 truy vấn. Không giữ ETH, không xác minh chi note. |
| [`WideTranscript256.sol`](../contracts/research/stark256/WideTranscript256.sol) | Transcript 512 bit, cam kết Merkle và lấy challenge bằng rejection sampling. |
| [`GoldilocksFp8.sol`](../contracts/research/stark256/GoldilocksFp8.sol) | Trường mở rộng bậc 8 và phép gập FRI radix 8. |
| [`Blake2b512.sol`](../contracts/research/stark256/Blake2b512.sol) | BLAKE2b-512 dùng precompile EIP-152. |

[Mô tả wire, giới hạn và điều kiện phát hành](ETH-POOL-STARK256.md) · [Prover tham chiếu FRI](../pool/stark256/fri-reference.mjs) · [Test verifier](../test/stark256.test.mjs).

## ETH Vault V3 · lab

`EthShieldedPool` là cùng một mã chạy trên ba VM Ethereum, Base và Arbitrum One. Chỉ ETH thử; phí 0,09% mỗi lần nạp/rút thành công và thanh khoản đích được hạch toán riêng.

| Mã Solidity | Vai trò |
| --- | --- |
| [`EthShieldedPool.sol`](../contracts/ethereum/EthShieldedPool.sol) | Hợp đồng vault chính; gắn verifier đã ghim và giới hạn chain ID lab. |
| [`EthPoolState.sol`](../contracts/ethereum/EthPoolState.sol) | Sổ ETH, phí, nullifier, rút nội mạng, giữ chỗ và chi theo lô. |
| [`EthNetworkState.sol`](../contracts/ethereum/EthNetworkState.sol) | Khóa note nguồn, chi từ thanh khoản đã có ở đích, xác nhận hoặc hoàn. |
| [`RollupMessageTransport.sol`](../contracts/ethereum/RollupMessageTransport.sol) | Gửi và kiểm nguồn thông điệp; không chuyển ETH gốc trong packet. |
| [`EthFeeStaking.sol`](../contracts/ethereum/EthFeeStaking.sol) | Staking, chia phí ETH theo tỷ lệ token đang stake trong kỳ 30 ngày; Ethereum lab gắn với HCMT. |
| [`HcmtToken.sol`](../contracts/ethereum/HcmtToken.sol) | ERC-20 cấp đúng 100.000 HCMT một lần lúc deploy, không có quyền mint thêm hoặc nâng cấp. |
| [`NativeNoteDeposits.sol`](../contracts/vault/NativeNoteDeposits.sol) | Nạp ETH, commitment note và kiểm phân bổ khi nạp lô. |
| [`NativeNoteTree.sol`](../contracts/vault/NativeNoteTree.sol) | Cây note Poseidon riêng theo deployment. |
| [`NativeStark.sol`](../contracts/vault/NativeStark.sol) | Verifier chi note NotBefore A và kiểm pin bytecode. **Chỉ dùng cho lab, không đạt ngưỡng hậu lượng tử.** |

[Pin verifier](VAULTS.md) · [Build vault và token](../scripts/build-vault.mjs) · [Cách chia phí](ETH-FEE-STAKING.md) · [Test HCMT](../test/hcmt.test.mjs) · [Test sáu chiều](../test/eth-clearing.test.mjs) · [Test proof WASM thật](../test/eth-clearing-fresh.test.mjs).

### Phụ thuộc Solidity đã ghim của Vault V3

Nguồn vendored tại [`contracts/vendor/nonos`](../contracts/vendor/nonos), kèm [giấy phép](../contracts/vendor/nonos/LICENSE), [NOTICE](../contracts/vendor/nonos/NOTICE.md) và ba evaluator chunk trong cùng thư mục. Đây là phụ thuộc để tái lập vault lab, **không phải** HCFR v2.

- **Hash, field, đọc proof:** [`PoseidonGoldilocks`](../contracts/vendor/nonos/PoseidonGoldilocks.sol), [`IPoseidonGoldilocks`](../contracts/vendor/nonos/interfaces/IPoseidonGoldilocks.sol), [`Goldilocks`](../contracts/vendor/nonos/libraries/Goldilocks.sol), [`StarkProofReader`](../contracts/vendor/nonos/StarkProofReader.sol).
- **Chuẩn bị và chạy verifier:** [`PrepareNb_A`](../contracts/vendor/nonos/verifier/nb/PrepareNb_A.sol), [`WalkNb_A`](../contracts/vendor/nonos/verifier/nb/WalkNb_A.sol), [`NbStraightEvaluatorAt`](../contracts/vendor/nonos/verifier/nb/NbStraightEvaluatorAt.sol), [`IProgramFormEvaluator`](../contracts/vendor/nonos/verifier/IProgramFormEvaluator.sol), [`CodeChunk`](../contracts/vendor/nonos/verifier/shapes/CodeChunk.sol).
- **Thành phần verifier:** [`GoldilocksCore`](../contracts/vendor/nonos/verifier/GoldilocksCore.sol), [`StarkFieldExt`](../contracts/vendor/nonos/verifier/StarkFieldExt.sol), [`StarkMerkle`](../contracts/vendor/nonos/verifier/StarkMerkle.sol), [`StarkTranscript`](../contracts/vendor/nonos/verifier/StarkTranscript.sol), [`ProductionAir`](../contracts/vendor/nonos/verifier/ProductionAir.sol), [`ProductionComposeAir`](../contracts/vendor/nonos/verifier/ProductionComposeAir.sol), [`ProductionDeepQuery`](../contracts/vendor/nonos/verifier/ProductionDeepQuery.sol), [`RealQueryVerify`](../contracts/vendor/nonos/verifier/RealQueryVerify.sol), [`RealQueryWalk`](../contracts/vendor/nonos/verifier/RealQueryWalk.sol).

## Kiểm tra

```sh
npm ci --ignore-scripts
npm --prefix hcmtrail-native ci --ignore-scripts
npm test
npm --prefix hcmtrail-native run build:pool:legacy # chỉ compile lab, không triển khai
npm --prefix hcmtrail-native run report:pool:256   # releaseAllowed=false
```

Swap đa tài sản, oracle, vault đời cũ và HCFR v1 không thuộc cây mã hiện hành. Các fixture nằm trong `test/`, không phải hợp đồng phát hành.
