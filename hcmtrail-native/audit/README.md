# Bộ công cụ kiểm toán Solidity (chỉ Solidity)

Thư mục này chứa **test/harness kiểm toán** và cấu hình fuzzer. Không có file
hợp đồng production nào bị sửa. Mọi thư mục sinh ra (`hcmtrail-native/build/audit`)
đều nằm trong danh sách bỏ qua của git.

## Công cụ đã cài và đã xác minh

| Công cụ | Phiên bản | Cách lấy | Trạng thái |
| --- | --- | --- | --- |
| Foundry `forge` | 1.7.1 (`4072e48705af9d93e3c0f6e29e93b5e9a40caed8`) | npm `@foundry-rs/forge-linux-amd64@1.7.1` | chạy được |
| `solc` native | 0.8.24+commit.e11b9ed9.Linux.g++ | `ethereum/solc-bin` raw + SHA-256 trong `list.json` | chạy được |
| Halmos | 0.3.3 | PyPI, venv riêng | chạy được (kèm `z3`, `yices`) |
| `crytic-compile` | 0.4.2 | PyPI | đã cài (dùng cho Medusa/Echidna) |
| Medusa | v1.5.1 | `codeload.github.com/crytic/medusa` (dựng nguồn) | **chưa dựng xong** — xem mục "Chặn" |
| Echidna | 2.4.0 | asset phát hành `echidna-2.4.0-x86_64-linux.tar.gz` | **chưa cài được** |

`build/audit/bin/solc` chỉ dùng khi chạy offline; đường dẫn tuyệt đối trong
snapshot là `/home/user/mobubu-wallet/hcmtrail-native/build/audit/bin`.

## Chặn kỹ thuật (không phải lỗi hợp đồng)

- Asset phát hành của Medusa (`371539722`) và Echidna (`710402563`) nằm trên
  `release-assets.githubusercontent.com`; sandbox chỉ mở `github.com`,
  `codeload.github.com`, `api.github.com`, npm và PyPI. Tải asset trả về
  0 byte hoặc lỗi TLS. Vì vậy Echidna **chưa được chạy**.
- Medusa được dựng từ tag nguồn với module Go ghim qua `codeload`. Đã đi tới 348
  thay thế module cục bộ nhưng dừng ở các module mà đường dẫn import không trùng
  repo (`github.com/decred/dcrd/dcrec/secp256k1/v4` nằm trong submodule `decred/dcrd`,
  `github.com/holiman/bloomfilter/v2`). Script dựng lặp lại vẫn còn trong
  `build/audit/build-medusa.py` nếu chạy ở máy có `GOPROXY` thật.
- Halmos không dựng được trạng thái cho harness pool: `setUp()` tạo hợp đồng
  lồng trong constructor (`EthPoolState` → `new EthFeeStaking`), Halmos báo
  `No successful path found in setUp()`. Các test tượng trưng cho `HcmtToken`
  thì chạy được.

## Tái lập

```bash
cd hcmtrail-native
# 1. Fuzz thể tích ERC-20: 65.536 ca × 16 bước × 3 lời gọi
./build/audit/bin/forge test --offline --use "$PWD/build/audit/bin/solc" \
  --match-contract '^TokenVolumeTest$' --fuzz-runs 65536 --summary

# 2. Bất biến sổ staking (3 tác nhân, nhảy kỳ 30 ngày)
FOUNDRY_INVARIANT_RUNS=1024 FOUNDRY_INVARIANT_DEPTH=96 \
  ./build/audit/bin/forge test --offline --use "$PWD/build/audit/bin/solc" \
  --match-contract '^StakingInvariantTest$' --fuzz-runs 32768 --summary

# 3. Bất biến "stateful" dùng chung với Medusa/Echidna
FOUNDRY_INVARIANT_RUNS=2048 FOUNDRY_INVARIANT_DEPTH=128 FOUNDRY_INVARIANT_FAIL_ON_REVERT=false \
  ./build/audit/bin/forge test --offline --use "$PWD/build/audit/bin/solc" \
  --match-contract '^StatefulInvariantTest$' --summary

# 4. Halmos
PATH="$PWD/build/audit/bin:$PWD/build/audit/halmos-venv/bin:$PATH" \
  FOUNDRY_SOLC="$PWD/build/audit/bin/solc" FOUNDRY_OFFLINE=true \
  build/audit/halmos-venv/bin/halmos --contract HcmtSymbolicTest \
  --forge-build-out build/audit/halmos-out \
  --solver-command "$PWD/build/audit/halmos-venv/bin/z3 -smt2"

# 5. Medusa (sau khi dựng xong binary)
cd build/audit/medusa-target && PATH="$PWD/../bin:$PATH" ../bin/medusa --config ../../../audit/medusa.json

# 6. Echidna (chưa có binary)
echidna build/audit/medusa-target/StatefulProperties.sol --config audit/echidna.yaml
```

## File trong thư mục này

- `solidity/TokenAudit.t.sol` — mục tiêu fuzz thể tích ERC-20 + 3 test Halmos.
- `solidity/StakeAudit.t.sol` — bất biến sổ staking 3 tác nhân qua nhiều kỳ.
- `solidity/VaultAudit.t.sol` — quan hệ phí 9 bps và kế toán một lô 20 vé.
- `solidity/RefundFinding.t.sol` — thử phá hoàn tiền sau khi lô đã trả (kết quả âm).
- `solidity/StatefulProperties.sol` — mục tiêu Medusa/Echidna dùng chung.
- `solidity/StatefulInvariant.t.sol` — chạy chính mục tiêu đó bằng Forge + smoke test.
- `solidity/PoolSymbolic.t.sol` — test Halmos cho quy tắc phí (bị chặn ở `setUp`).
- `medusa.json`, `echidna.yaml` — cấu hình chiến dịch.

Không có test nào trong đây chứng minh tính đúng của STARK: verifier được
thay bằng fixture (`keccak256(abi.encode(words))`).
