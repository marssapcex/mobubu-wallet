# hcmtrail ETH Vault V3 · lab

[Toàn bộ Solidity hiện hành: vault và HCFR v2](docs/CONTRACTS.md).

Một mã pool ETH trên Ethereum (`31337` lab), Arbitrum One (`31338`) và Base (`31339`). Nạp ETH lấy note, rút ETH cùng mạng hoặc rút từ thanh khoản đã cấp trên một trong hai mạng còn lại. Phí cố định **9 bps mỗi lần nạp/rút**, gas riêng. Token ERC-20 chỉ để stake; không dùng token để nạp/rút trong ETH pool.

| Thành phần | Chức năng |
| --- | --- |
| [`EthShieldedPool`](contracts/ethereum/EthShieldedPool.sol) | Cùng verifier và trạng thái pool trên ba VM. Rút cùng mạng trực tiếp, theo lô hoặc hoàn về note. |
| [`EthNetworkState`](contracts/ethereum/EthNetworkState.sol) | Khóa note ở nguồn, nhận xác thực, chi ETH từ thanh khoản ở đích, nhận kết quả hoặc khôi phục note. |
| [`EthFeeStaking`](contracts/ethereum/EthFeeStaking.sol) | Quỹ phí ETH riêng mỗi deployment, chia theo tỷ lệ stake đang hiệu lực sau mỗi kỳ 30 ngày. Ethereum lab dùng HCMT; Base và Arbitrum lab dùng LAB thử. |
| [`HcmtToken`](contracts/ethereum/HcmtToken.sol) | ERC-20, 18 decimals, cấp một lần 100.000 HCMT. Không có owner, mint thêm, burn hay nâng cấp. |
| [`NativeStark`](contracts/vault/NativeStark.sol) | Pinned NotBefore A trên devnet. `build`/`build:pool`/`pool:eth` mặc định chặn release. [HCFR v2](docs/ETH-POOL-STARK256.md) chỉ là nghiên cứu FRI. |

[Luồng sáu chiều](docs/ETH-CLEARING.md) · [Runbook khóa note](docs/ETH-POOL.md) · [Staking](docs/ETH-FEE-STAKING.md) · [Relayer HCMT và lô 20 địa chỉ](docs/ETH-RELAYER.md) · [Verifier pins](docs/VAULTS.md).
