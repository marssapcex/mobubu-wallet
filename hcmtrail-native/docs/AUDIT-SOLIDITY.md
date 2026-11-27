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
- **F-1 đã được sửa trong bản này** (`EthPoolState._openOrJoin`) và chứng minh bằng
  test đỏ-trước-xanh-sau; F-6 đã sửa comment. Sau khi sửa, toàn bộ 34 test audit PASS,
  7 kịch bản cross-lane mới PASS, chiến dịch stateful chạy lại trên **chính bản đã sửa**
  (393.216 lời gọi) PASS, và `npm test` 22/22 PASS. Pool runtime tăng 34 B
  (24.103 → **24.137 B**, trần EIP-170 24.576 B, còn **439 B**).
- Checklist chống bỏ sót: **`audit/CHECKLIST.md`** (phát hiện → bản sửa → bài test →
  bảng phủ → điều kiện merge).

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
| 9 | Forge test | `DeepScenarios.t.sol` — 13 kịch bản nhiều điều kiện đồng thời (bản đã sửa) | lô đầy, round cũ hết hạn, người nhận từ chối, cap rebate, biên kỳ, bỏ kỳ, vé 1 wei, phí biên, nạp nhiều note, rút trực tiếp, hai lô đầy cùng lúc | — | PASS (13/13) | 1,10 s |
| 10 | Forge test | `NetworkScenarios.t.sol` — 7 kịch bản cross-lane (transport fixture thật: outbox/bridge + messenger) | khoá → Settled, khoá → Cancelled → hoàn, Open → chi, huỷ theo secret, thiếu thanh khoản, retry, làn sai | — | PASS (7/7) | 0,13 s |
| 11 | Forge invariant | `StatefulInvariantTest` **trên bản đã sửa** (`FOUNDRY_PROFILE=stateful`) | 6 bất biến × 512 chuỗi × 128 bước | **393.216** | PASS | 536,63 s |
| 12 | Forge coverage | `contracts/ethereum` + `contracts/vault` | lcov | — | **75/83 hàm, 513/586 dòng (87,5%)** | 13,4 s |
| 13 | Forge test | `ReorgScenarios.t.sol` — 5 kịch bản reorg/replay kiểu THORChain 31/10 | không có đường ghi có ngoài deposit + proof của chính pool; root ngoài nhánh bị từ chối; replay proof/retarget người nhận; proof nằm mempool 1 năm; cùng nullifier cho 2 vé | — | PASS (5/5) | 0,15 s |
| 14 | Forge test | `NetworkScenarios.t.sol` +2 kịch bản gói tin giả | EOA tự gửi `Paid`; gói qua sai bridge | — | PASS (9/9 tổng) | 0,16 s |

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

### F-1 (Trung bình, liveness) — làn rút bị khoá tới 24 giờ sau khi lô đầy — **ĐÃ SỬA**

`EthPoolState._openOrJoin` chỉ mở lô mới khi lô trước **không còn "live"**. Một lô đã
đủ `target` vé nhưng chưa được chi vẫn "live" (`!paid && now < expiresAt`), nên mọi
`reserve` cho **cùng amount** bị `InvalidBatch()` cho tới khi:

- có ai gọi `executeBatch` (không cần quyền), hoặc
- hết `BATCH_LIFETIME` = 1 ngày.

Hệ quả: một người nạp hợp lệ có thể giữ làn `amount` đó đầy trong tối đa 24 giờ; người
khác không mở được lô cùng mệnh giá. Không mất tiền, nhưng là DoS tạm thời và làm chậm
trải nghiệm rút. Khuyến nghị: cho phép mở lô `round+1` khi lô trước đã đầy (kể cả chưa
chi), hoặc thêm keeper chi tự động trong tài liệu vận hành.

**Bản sửa (đang có trong `contracts/ethereum/EthPoolState.sol`):** một hàng đợi đã đủ
`target` không thể nhận thêm đặt chỗ, nên nó không còn được coi là mở:

```solidity
bool full = previous.target != 0 && previous.entries.length == previous.target;
bool live = !previous.paid && !full && block.timestamp < previous.expiresAt;
```

Lô đầy giờ đóng ngay khi đủ vé; lô `round+1` mở được, còn lô cũ vẫn `executeBatch`/
`refundPart` bình thường vì `paid`/`expiresAt` không đổi. Chi phí: **+34 byte** runtime,
+2 phép so sánh trong đường `reserve`. Bằng chứng đỏ-trước-xanh-sau ở mục 5.2.

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

### F-6 (Thông tin) — comment về biên tràn của `EthFeeStaking` lạc quan — **ĐÃ SỬA COMMENT**

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

### F-9 (Thông tin) — proof không có hạn dùng; root không hết hạn

`_consume` chỉ ràng buộc `notBefore` (là *sàn* thời gian, theo lưới 600 s), **không** có
`notAfter`, và `knownRoot` không bao giờ bị xoá (F-7). Vì vậy một giao dịch đã ký có thể
nằm mempool rất lâu — kể cả qua một reorg — rồi vẫn được include và vẫn hợp lệ. Đây
đúng là lớp sự cố đã dừng THORChain tháng 10/2026 (giao dịch bị reorg, quan sát viên vẫn
trả tiền), nhưng ở đây hậu quả bị chặn bởi ba thứ: nullifier chỉ dùng một lần
(`AlreadySpent`), commitment gắn cứng người nhận/số tiền (đổi người nhận là proof sai),
và tag batch tách đặt chỗ khỏi chi trực tiếp. Không nhân đôi chi tiêu; rủi ro còn lại chỉ
là *ý định cũ được thi hành muộn*. Khuyến nghị: ví nên ký lại bằng nullifier mới nếu tx
chưa vào chain sau N block; nếu muốn chặn hẳn, thêm `notAfter` vào `PoolSpend` (thay đổi
ABI, cần một epoch chuyển tiếp).

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

## 5. Bản sửa và chiến dịch tái kiểm

### 5.1 Đã sửa gì

| File | Thay đổi | Ảnh hưởng |
| --- | --- | --- |
| `contracts/ethereum/EthPoolState.sol` | `_openOrJoin`: thêm `full`, loại lô đầy khỏi `live`; bỏ guard `entries.length == target` bên trong | sửa F-1; +34 B runtime; ABI và storage layout **không đổi** |
| `contracts/ethereum/EthFeeStaking.sol` | viết lại comment `_fundFees` cho đúng ngữ nghĩa `fundedWei ≤ 2^128` | sửa F-6; không đổi bytecode logic |

Kích thước sau sửa (`npm run build:pool:legacy`): pool initcode+args **40.501 B**
(trước 40.467), pool runtime **24.137 B** (trước 24.103, trần 24.576 → còn **439 B**),
staking runtime **8.843 B** (không đổi).

### 5.2 Chứng minh F-1 đã hết (đỏ trước, xanh sau)

Cùng một bài test `DeepScenariosTest.test_FullQueueOpensNextRoundAndKeepsPriorSettleable`,
chạy hai lần với hai luật:

| Luật trong `_openOrJoin` | Kết quả |
| --- | --- |
| luật cũ (`live = !paid && now < expiresAt`) | `[FAIL: InvalidBatch()]` — đúng là lỗi F-1 |
| luật mới (thêm `&& !full`) | `[PASS]` |

Bài test không chỉ khẳng định “mở được lô 2”: nó còn kiểm lô 1 vẫn chi được sau khi lô 2
đang mở (`latestRound == 2`, `getBatch(amount, 2).count == 1`, 5 người nhận mỗi người
`0,49955 ETH`, `reservedNative == TICKET/4`, `reservedRefundLeaves == 1`), rồi hoàn phần
của lô 2 sau hết hạn và kiểm sổ cân.

### 5.3 Chiến dịch mới: điều kiện đồng thời, không phải fuzz đều

Fuzz ngẫu nhiên hiếm khi chạm tới trạng thái cần *nhiều* điều kiện cùng đúng. Hai file
mới dựng thẳng các giao nhau đó:

- `audit/solidity/DeepScenarios.t.sol` (13 kịch bản): lô đầy + chưa chi + còn hạn + có
  người nạp mới; lô cũ hết hạn + round nhảy; người nhận `RejectEth` + lô đủ + refund;
  nhiều vé + cap rebate mỗi lô + hai lô liên tiếp; stake 100 + qua biên kỳ + unstake +
  claim; bỏ qua 90 kỳ + pot có phí nạp; vé 1 wei + tách + hoàn + chống dùng lại proof;
  chia lô thành phần lẻ wei; phí 9 bps trên biên; nạp nhiều note khớp từng wei; rút
  trực tiếp + rebate; **hai lô cùng đầy và cùng bị giữ tiền** rồi chi độc lập (trạng
  thái mà F-1 trước đây làm cho không thể tới).
- `audit/solidity/NetworkScenarios.t.sol` (7 kịch bản): dựng transport thật
  (`LocalMessageTransport` + `LocalArbMessageBridge`/`Outbox`), gửi gói đúng *hình thức
  xác thực* của production (outbox/`l2ToL1Sender` cho làn Arbitrum, messenger cho làn
  Base) và chạy `EthNetworkState` đầu-cuối: khoá → Settled cộng thanh khoản; khoá →
  Cancelled → hoàn đúng một note; Open → chi → chặn chi lần hai và chặn huỷ sau khi chi;
  huỷ sai secret; thiếu thanh khoản rồi nạp thêm; retry; làn sai.

Nhờ đó `EthNetworkState` từ **0/124 dòng** lên **114/124** và `RollupMessageTransport`
**16/31** dòng (chỉ còn nhánh lỗi cấu hình không dựng được trong test).

### 5.4 Tổng sau khi sửa

- 34 test audit PASS (13 deep + 9 cross-lane + 5 reorg/replay + 7 test cũ).
- Tổng lời gọi mô hình hoá **5.242.880** = 3.145.728 (token fuzz) + 98.304 (staking
  invariant) + 32.768 (vault fuzz) + 1.572.864 (stateful trước sửa) + **393.216**
  (stateful trên bản đã sửa). Con số cuối là con số quan trọng: nó chạy trên đúng mã
  nguồn sẽ deploy.
- Phủ: **75/83 hàm, 513/586 dòng (87,5%)**; danh sách hàm chưa phủ kèm lý do ở
  `audit/CHECKLIST.md` §5.
- `npm test`: **22/22 PASS** trên bản đã sửa (pool, keeper, relayer, bridge, vault).

### 5.5 Reorg và replay — đối chiếu sự cố THORChain 31/10/2026

Sự cố tham chiếu: một block Ethereum bị reorg làm khoản nạp 10 ETH biến mất; bộ kiểm tra
solvency dừng swap, node operator dừng ký, rồi dừng cả các chain khác; điểm nguy hiểm được
nêu là "khi chain ngoài reorg, kẻ tấn công có thể gửi giao dịch mới cùng nonce và vẫn được
vault trả tiền". Đối chiếu với thiết kế ở đây:

| Khía cạnh | Thiết kế HCMTrail | Bài test |
| --- | --- | --- |
| Khoản nạp bị reorg | Không có đường ghi có nào ngoài `deposit`/`depositBatch` mở rộng chính cây của pool; không có admin/oracle nhận "sự kiện đã quan sát" | `test_NoCreditPathOutsideDepositAndOwnProof` |
| Root của nhánh bị bỏ | `_consume` đòi `knownRoot[s.root]`; root lạ ⇒ `UnknownRoot` | `test_RootFromAnotherBranchIsRejected` |
| "Gửi lại cùng nonce" | Pool không dùng nonce của EOA: quyền chi là **nullifier + commitment**. Gửi lại proof cũ ⇒ `AlreadySpent`; đổi người nhận ⇒ proof sai | `test_ReplayedProofPaysOnceAndCannotBeRetargeted` |
| Tx kẹt mempool qua reorg | Vẫn hợp lệ (không `notAfter`, root không hết hạn) nhưng **một lần** — xem F-9 | `test_PendingProofStaysValidButSingleUse` |
| Cùng nullifier cho vé khác | `spent[]` chặn trước khi verify ⇒ không đếm tiền hai lần | `test_SameNullifierCannotFundTwoTickets` |
| Gói tin giả báo "đã trả" | `acceptPacket` chỉ nhận qua `authenticate` của transport (outbox `l2ToL1Sender` cho Arbitrum, messenger cho Base) | `test_ForgedPaidPacketFromEoaCannotReleaseEscrow` |
| Gói tin qua sai bridge | Sai `msg.sender` ⇒ revert; trạng thái giữ nguyên | `test_PacketThroughWrongBridgeIsRejected` |
| Message bị reorg mất (chiều ra) | Đơn ở `Locked`; `retryAcross` gửi lại cùng `id`, đích xử lý idempotent theo `id` | `test_RetryAllowedAndForwardRejectedForDirectRoute` |

**Giả định còn lại (không kiểm được trong sandbox):** tính *finality* của cầu. Trên
Arbitrum/Base thật, message chỉ thi hành được sau cửa sổ thử thách, nên "Paid" mà làn
nguồn nhận được là message đã final; nhưng hợp đồng **không** tự kiểm tra finality — nó tin
vào `outbox`/`messenger`. Nếu triển khai trên một rollup có fast-confirm chưa đủ an toàn,
hoặc nếu `MessageConfig` bị cấu hình sai (trỏ vào một contract không phải outbox thật), thì
lớp bảo vệ này mất. Vì vậy: (1) `Transport.check` chỉ kiểm tra *có code* + `inbox.bridge()`,
không kiểm tra *danh tính* bridge; (2) cần thêm bước xác minh địa chỉ outbox/messenger
chính thức trong quy trình triển khai; (3) nên theo dõi `outboundNative` theo tuổi đơn để
phát hiện message mất.

### 5.6 Đối chiếu với upstream (đã clone và đọc, không phải suy đoán)

Clone `NON-OS/L1-Shield@9d17ad96` và `NON-OS/STARKs@a47d23ae` rồi so hash:

| Hạng mục | Upstream | Repo này | Kết luận |
| --- | --- | --- | --- |
| `PoseidonGoldilocks.sol`, `StarkProofReader.sol` | `contracts/shield/` | `contracts/vendor/nonos/` | sha256 **trùng** (byte-identical) |
| `chunk0..2.hex` | `spec/not-before/` | `contracts/vendor/nonos/` | sha256 **trùng** |
| Image hash | `deployments/sepolia.env` → `PRODUCTION_IMAGE_HASH` | `NativeStark.STARK_IMAGE` | **cùng** `0x4364151e…2429` |
| Public words | `spec/not-before/transfer-eth-shape1/publics.json` | `_consume` dựng 37 limb | **cùng layout** (root×2, nf×2, cm×2, amount, fee, asset, price, recipient×4, feeRecipient×4, not_before) |
| Commitment | `_computeCommitmentWith`: `hash2(uint32(v)｜(v>>32)<<64｜asset<<128｜domain<<192, ownerCommit)` | `NativeNoteDeposits.commitment` | **cùng công thức** |
| Prover | `nox_prover` (`api.rs`, `proof.rs`) | `prover.wasm` build từ cùng commit | cùng engine |

Nghĩa là statement trong repo **không** phải "NotBefore yếu": `not_before` chỉ là **word thứ 37**
của statement join-split 2-vào/2-ra (`stark_proofs/src/shield/join/`, gọi là
`transfer-eth-shape1`, shape **A**). Phần khác upstream: `settleBatch` (11–13 word/intent,
`clearingPrice`, `MAX_INTENTS = 64`, cửa sổ settler), `AmountPolicy` theo mệnh giá
(1, 2, 5 × 10ⁿ), `associationRegistry`, vòng root 138 slot, `soundnessBitsForSize ≥ 80`.
Đo gas của họ cho cùng shape: **2,15 M verify / 3,86 M cả tx** (`docs/12-gas.md`), trong khi
pool này đo **8,24 M** — chênh ~2,1×, là việc tối ưu thật chứ không phải khác biệt proof.

## 6. Khoảng trống và rủi ro chưa kiểm

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
4. **Verifier STARK**: test Foundry dùng fixture `keccak(abi.encode(words))`, nhưng nhánh JS
   (`npm run test:pool:key`, `npm run test:prover:browser`) deploy `EthShieldedPool` thật và
   verify proof thật bằng evaluator ghim. Vẫn **không** có kết luận về soundness của toán học
   STARK — chỉ có kết luận rằng đường ống (publics ↔ verifier ↔ pool) khớp nhau.
5. **Cross-lane**: `EthNetworkState` đã có 7 kịch bản đầu-cuối với transport fixture
   (114/124 dòng), nhưng **chưa** fuzz nhiều chain thật và chưa kiểm bridge thật
   (Arbitrum/Base). `NativeStark` (0/35 dòng) và `EthPoolVerified._verifyNote` chỉ chạm
   tới ở nhánh deploy thật, không chạy trong Foundry.
6. **Chưa kiểm**: `research/stark256`, JS relayer/worker, app UI.

## 7. Tái lập

Xem `audit/README.md` (lệnh, seed, cấu hình) và `audit/CHECKLIST.md` (map phát hiện →
bản sửa → bài test, bảng phủ, điều kiện merge). Seed fuzz mặc định `0x4a554e4532303236`,
chain ID 31337, solc 0.8.24 (Paris), optimizer 200. Chiến dịch stateful đầy đủ dùng
`FOUNDRY_PROFILE=stateful` (512 × 128, `fail_on_revert = false`) vì mục tiêu dùng chung
với Medusa/Echidna phơi cả hợp đồng thật, nơi lời gọi ngẫu nhiên revert theo thiết kế.
