# Kiểm toán Solidity — HCMTrail ETH pool, staking và transport

Ngày: 2026-11-18 · Nhánh `arena/32000e7e-mobubu-wallet` · Phạm vi: **chỉ Solidity** (không JS/frontend/relayer service).

## 1. Kết luận ngắn

- Đã chạy **4.849.664 lời gọi thay đổi trạng thái được mô hình hoá** bằng Forge
  (fuzz + invariant: 3.145.728 + 98.304 + 32.768 + 1.572.864) và **15 đường tượng trưng**
  bằng Halmos trên token HCMT.
- **Không phát hiện lỗi mất tiền trực tiếp** trong lớp kế toán Solidity đã đọc.
  Có **1 phát hiện mức trung bình** (khoá làn rút lô tạm thời), vài phát hiện mức thấp
  và thông tin.
- **Echidna chưa chạy được** trong sandbox (asset phát hành bị chặn, không có GHC/Stack).
  **Medusa v1.5.1 không dựng xong** từ tag nguồn (closure module Go không khép kín được
  chỉ bằng archive GitHub). Cả hai **không** được tính vào kết quả; harness và cấu hình
  đã sẵn sàng để chạy ở máy có mạng.
- **Không** có kết luận nào về tính đúng của STARK: verifier trong các test này là
  fixture (`keccak256(abi.encode(words))`). Không có phê duyệt lưu ký công khai.

## 2. Phạm vi

Đã đọc toàn bộ các file sau (1294 dòng):

| File | Nội dung kiểm tra |
| --- | --- |
| `contracts/ethereum/HcmtToken.sol` | nguồn cung cố định, không mint, chuyển nhượng, allowance |
| `contracts/ethereum/EthPoolState.sol` | nạp/rút, phí 9 bps, mở lô, đặt chỗ, chi lô, hoàn phần |
| `contracts/ethereum/EthFeeStaking.sol` | kỳ 30 ngày, chỉ số thưởng, credit relayer, rút stake |
| `contracts/ethereum/EthNetworkState.sol` | khoá ra cross-lane, cấp quyền, chi, huỷ, hoàn |
| `contracts/ethereum/RollupMessageTransport.sol` | xác thực người gửi, gói tin zero-principal, gas bid |
| `contracts/ethereum/EthShieldedPool.sol` | ràng buộc chain ID 31337–31339, ghim codehash |
| `contracts/vault/NativeNoteDeposits.sol` | cam kết note, tách note, không mất phần dư |
| `contracts/vault/NativeNoteTree.sol` | cây append-only độ sâu 32, root không hết hạn |
| `contracts/vault/NativeStark.sol` | ghim bytecode, biên proof, thất bại đóng |

**Ngoài phạm vi (nêu rõ ranh giới):**

- `contracts/vendor/nonos/**` (verifier ghim commit `9d17ad96…`, ~21–23 KB bytecode):
  chỉ kiểm tra phần *ghim* và *định dạng*; không kiểm toán toán học STARK.
- `contracts/research/stark256/**` (HCFR v2 FRI): nghiên cứu, bị chặn bởi
  `approvedSpendProfile = null`, `releaseAllowed = false`.
- `test/fixtures/**`: chỉ là đối tượng thử, không được triển khai.
- Toàn bộ JS: `pool/*.mjs`, `scripts/*.mjs`, `apps/eth-pool`, relayer service.

## 3. Chiến dịch đã chạy

| # | Công cụ | Mục tiêu | Cấu hình | Lời gọi mô hình hoá | Kết quả | Thời gian |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Forge fuzz | `TokenVolumeTest.testFuzz_TransferApproveDelegated` | 65.536 ca, 16 bước × 3 lời gọi ERC-20 | **3.145.728** | PASS | 87,28 s |
| 2 | Forge invariant | `StakingInvariantTest` (3 tác nhân, nhảy kỳ) | 1.024 chuỗi × 96 bước | **98.304** (0 revert) | PASS | 51,88 s |
| 3 | Forge fuzz | `VaultSolidityTest.testFuzz_SameGrossSameFeeAndExactWei` | 32.768 ca | 32.768 | PASS | 0,9 s |
| 4 | Forge test | `VaultSolidityTest.test_BatchAccountingAndRelayCap` | 20 vé × 0,5 ETH | 20 lần chi | PASS | — |
| 5 | Forge invariant | `StatefulInvariantTest` (mục tiêu dùng chung Medusa/Echidna) | 6 tính chất × 2.048 chuỗi × 128 bước | **1.572.864** (handler: 90.717 hành động/lượt, 0 revert) | PASS | 2.109,61 s |
| 6 | Halmos | `HcmtSymbolicTest` (3 tính chất) | z3, mọi `uint96` | **15 đường** (6 + 6 + 3) | PASS | 0,35 s |
| 7 | Halmos | `PoolSymbolicTest` (quy tắc phí) | z3 | — | **chặn**: `setUp()` không có đường thành công | — |
| 8 | Forge test | `RefundFindingTest` (2 kịch bản thử phá hoàn tiền) | lô đã chi + lô hết hạn | — | **âm tính**: cả hai đều bị chặn | 0,16 s |

Cách đếm: cột "lời gọi mô hình hoá" là số lời gọi *bên trong* mỗi ca fuzz
(fuzz case × bước × lời gọi mỗi bước). Đây **không** phải số giao dịch độc lập, không
phải số giao dịch thực trên chain. Halmos đếm **đường tượng trưng**, không phải mẫu.

### Kiểm chứng bằng chứng cụ thể

- Một lô 20 vé 0,5 ETH: mỗi người nhận đúng `499550000000000000` wei,
  tổng phí `10000000000000000` wei (0,01 ETH), credit relayer **một lần**
  `3000000000000000` wei (0,003 ETH), phần staking `6000000000000000` wei.
  Bất biến cân đối: `balance(pool) + balance(staking) + 9,991 ETH == 11 ETH`.
- Staking 100 HCMT: `relayEligible == false` trước biên kỳ, `true` sau 30 ngày.
- Tổng cung HCMT luôn `100000000000000000000000` qua mọi ca fuzz.

## 4. Phát hiện

### F-1 (Trung bình, liveness) — làn rút bị khoá tới 24 giờ sau khi lô đầy

`EthPoolState._openOrJoin` chỉ mở lô mới khi lô trước **không còn "live"**. Một lô đã
đủ `target` vé nhưng chưa được chi vẫn "live" (`!paid && now < expiresAt`), nên mọi
`reserve` cho **cùng amount** bị `InvalidBatch()` cho tới khi:

- có ai gọi `executeBatch` (không cần quyền), hoặc
- hết `BATCH_LIFETIME` = 1 ngày.

Hệ quả: một người nạp hợp lệ có thể giữ làn `amount` đó đầy trong tối đa 24 giờ; người
khác không mở được lô cùng mệnh giá. Không mất tiền, nhưng là DoS tạm thời và làm chậm
trải nghiệm rút. Khuyến nghị: cho phép mở lô `round+1` khi lô trước đã đầy (kể cả chưa
chi), hoặc thêm keeper chi tự động trong tài liệu vận hành.

### F-2 (Thấp) — đặt chỗ 1 wei chỉ ràng buộc 223 bit

`_reserveSpend` với `value == 1` nhồi `(id, refundOwner)` vào limb 27 (63 bit) và một
địa chỉ (160 bit) = **223 bit**, thay vì 256 bit như mọi nhánh khác. Chính comment
trong mã thừa nhận điều này. Không khai thác được với công 2^111, nhưng là mức ràng
buộc thấp hơn chuẩn của hệ. Khuyến nghị: cấm `value == 1` (đặt tối thiểu 2 wei) hoặc
thêm một limb ràng buộc.

### F-3 (Thấp, thiết kế) — khoá ra cross-lane không có đường hoàn theo thời gian

`withdrawAcross` giữ `gross` trong `outboundNative`; chỉ `cancelAcross` (sau khi đích đã
`Authorized`) mới dẫn tới `Refundable`. Nếu gói `Open` không bao giờ tới đích, tiền bị
khoá vĩnh viễn; `retryAcross` là đường phục hồi duy nhất và phụ thuộc transport sống.
Đây là lựa chọn có chủ đích (không hoàn theo thời gian), nhưng rủi ro vận hành cần được
ghi trong tài liệu người dùng.

### F-4 (Thông tin) — người rút trực tiếp có thể tự nhận rebate relayer

`withdraw` chuyển phí cho `feeStaking.fundPayoutFees(msg.sender)`. Nếu chính người rút
đang stake ≥ 100 HCMT, họ nhận lại `min(fee/2, 0,003 ETH)` → phí hiệu dụng còn ~4,5 bps.
Đúng với đặc tả "ai cũng có thể chi trực tiếp", nhưng nên nêu rõ trong tài liệu phí.

### F-5 (Thông tin) — rebate relayer chỉ tồn tại trên lab 31337

`EthFeeStaking.relayEnabled = block.chainid == 31337 && token.codehash == keccak256(runtimeCode HCMT)`.
Trên chain khác, `quoteRelayReward` trả 0 → mô hình 0,003 ETH/vé không áp dụng. Đúng
chủ đích lab-only, nhưng nghĩa là mọi phân tích kinh tế relayer chỉ đúng trong lab.

### F-6 (Thông tin) — comment về biên tràn của `EthFeeStaking` lạc quan

`_fundFees` giới hạn `fundedWei ≤ 2^128 − 1`, nên `index` (đơn vị `2^128`) có thể tới
xấp xỉ `2^256` khi chỉ có **1 wei HCMT** stake và phí chạm trần. Không khả thi về kinh tế
(cần ~3,4×10^20 ETH phí), nhưng câu "mọi giá trị đã scale vừa 256 bit kể cả khi chỉ có
một đơn vị stake" là quá mạnh; nên viết lại là "không thể đạt trong thực tế".

### F-7 (Thông tin) — `knownRoot` không bao giờ bị xoá

Mỗi root mới tốn một slot vĩnh viễn. Không phải lỗi bảo mật (không hết hạn root là
đúng ý đồ chống griefing ví), chỉ là tăng trưởng storage không giới hạn.

### F-8 (Thông tin) — chi lô là all-or-nothing với 35.000 gas mỗi người nhận

`executeBatch` gọi từng người nhận với `BATCH_RECEIVE_GAS = 35_000`; một người nhận là
hợp đồng cần nhiều gas hơn sẽ làm **toàn bộ** lô revert. Không mất tiền, nhưng một địa
chỉ "khó tính" chặn được lô (người nhận do chính người nạp chọn, nên rủi ro tự gây).

### Kết quả âm tính đã kiểm chứng (tốt cho hệ)

- **Không** hoàn tiền được cho lô đã chi: `refundPart` với vé đã trả revert
  `RefundUnavailable()`, và `shieldedNative`/`reservedNative`/`reservedRefundLeaves`
  không đổi. Đã viết PoC cố tình khai thác (`RefundFinding.t.sol`) và xác nhận bị chặn;
  điều kiện `b.paid ? funded == amount : now < expiresAt` đúng chiều.
- Hoàn tiền sau hết hạn đúng **một lần** cho mỗi phần; lần thứ hai revert, số dư note
  không tăng thêm.
- `reservedNative`, `reservedRefundLeaves` và `address(this).balance` khớp nhau qua
  1.572.864 lời gọi stateful (bất biến #5). Bản chạy nhỏ hơn (6 × 512 × 128 = 393.216
  lời gọi) cũng PASS, dùng để đối chiếu thời gian.
- `claimedWei ≤ fundedWei`, `relayClaimedWei ≤ relayFundedWei` qua toàn bộ chiến dịch.
- Với 65.536 ca fuzz, tổng cung HCMT và tổng số dư ba tác nhân luôn bảo toàn; allowance
  hữu hạn luôn giảm đúng bằng số đã chi.
- Halmos: với **mọi** `uint96`, `transferFrom` round-trip, self-transfer và allowance
  hữu hạn đều đúng (15 đường, 0 phản ví dụ).

## 5. Khoảng trống và rủi ro chưa kiểm

1. **Echidna 2.4.0 chưa chạy.** Asset `echidna-2.4.0-x86_64-linux.tar.gz`
   (id `710402563`, SHA-256 `a77a90501dd6269e12807156e9d409b160ce0c87fbb36fe323a896a4fb7a2d1d`)
   bị chặn cùng CDN; sandbox không có GHC/Stack để dựng từ Haskell. Cấu hình đã chuẩn bị
   (`audit/echidna.yaml`) và harness đã được kiểm bằng Forge trên cùng mã nguồn Solidity.
   Chạy ở máy có mạng: `docker run -v $PWD:/src ghcr.io/crytic/echidna:latest echidna
   build/audit/medusa-target/StatefulProperties.sol --config audit/echidna.yaml`.
2. **Medusa**: asset `medusa-linux-x64.tar.gz` (id `371539722`, SHA-256
   `ddfe1517ae9028ef9fc331b00f5a6a9d5406f3fcd11a715d60c6b6fb3e4546d3`) nằm trên
   `release-assets.githubusercontent.com` — sandbox chỉ mở `github.com`,
   `codeload.github.com`, `api.github.com`, npm, PyPI. Dựng từ tag nguồn đã đi được
   348 thay thế module nhưng dừng ở các module có đường dẫn import khác repo
   (`decred/dcrd` submodule, `holiman/bloomfilter/v2`). Không có kết quả Medusa.
   Chạy ở máy có mạng: `go install github.com/crytic/medusa@v1.5.1` rồi
   `medusa --config audit/medusa.json` (mục tiêu `build/audit/medusa-target`).
   Hoặc `docker run -v $PWD:/src ghcr.io/crytic/medusa:latest`.
3. **Halmos không dựng được** trạng thái pool (constructor tạo hợp đồng lồng nhau).
   Các tính chất của pool chỉ được kiểm bằng fuzz + lập luận số học.
4. **Verifier STARK** không được kiểm: mọi proof trong test là fixture băm `words`.
   Không có kết luận về âm thanh (soundness) của giao thức.
5. **Cross-lane**: `EthNetworkState` chỉ được kiểm bằng fixture transport; chưa có
   kiểm thử fuzz nhiều chain thật.
6. **Chưa kiểm**: `research/stark256`, JS relayer/worker, app UI.

## 6. Tái lập

Xem `audit/README.md`. Toàn bộ seed, số ca và lệnh chính xác nằm ở đó; seed fuzz mặc
định `0x4a554e4532303236`, chain ID 31337, solc 0.8.24 (Paris), optimizer 200.
