# Checklist kiểm toán — chống bỏ sót phát hiện

Mục đích: một chỗ duy nhất để **không phát hiện nào bị quên**. Mỗi dòng nối
*phát hiện → bản sửa → bài test chứng minh → trạng thái*. Nếu ai đó sửa code,
chạy lại mục 1; nếu một ô không còn đúng, checklist này là thứ phải cập nhật trước
khi merge.

Ngày: 2026-11-18 · Nhánh `arena/32000e7e-mobubu-wallet` · Solidity: solc 0.8.24 (Paris),
optimizer 200 · Forge 1.7.1.

## 1. Ba lệnh tái kiểm (chạy trong `hcmtrail-native/`)

```bash
# a) toàn bộ campaign audit (26 test, gồm fuzz + invariant nhỏ)
./build/audit/bin/forge test --offline --use "$PWD/build/audit/bin/solc" --threads 1 \
  --no-match-contract '^StatefulInvariantTest$' --summary

# b) chiến dịch stateful đầy đủ (6 bất biến × 512 chuỗi × 128 bước)
FOUNDRY_PROFILE=stateful ./build/audit/bin/forge test --offline \
  --use "$PWD/build/audit/bin/solc" --threads 1 --match-contract '^StatefulInvariantTest$' --summary

# c) bản build thật + bộ JS trên cùng mã nguồn
npm test && npm run build:pool:legacy
```

Kỳ vọng: (a) `27 passed; 0 failed`; (b) `6 invariants passed`; (c) `22 pass` và
`pool runtime 24137 B` (trần EIP-170 là 24.576 B → còn **439 B**).

## 2. Phát hiện → bản sửa → bằng chứng

| # | Mức | Nội dung | Trạng thái | Bằng chứng (bài test) |
| --- | --- | --- | --- | --- |
| F-1 | Trung bình | Lô đầy nhưng chưa chi vẫn giữ làn `amount` “live”, chặn mở lô mới tới 1 ngày | **ĐÃ SỬA** (`EthPoolState._openOrJoin`: `full` loại khỏi `live`) | `DeepScenariosTest.test_FullQueueOpensNextRoundAndKeepsPriorSettleable` — trước bản sửa bài này **revert `InvalidBatch()`**, sau bản sửa mở được lô 2 và lô 1 vẫn chi/hoàn đúng |
| F-2 | Thấp | Vé 1 wei chỉ ràng buộc 223 bit (mất 33 bit đệm) | Chấp nhận thiết kế, đã ghi trong tài liệu | `test_OneWeiPartIsSingleUseAndRefundsExactlyOneWei` — hoàn đúng 1 wei, không hoàn lần hai; `test_FeeIsExactlyNineBpsForEveryTicket` phủ 1, 111, 1.111, 1.112 … 2^64-1 |
| F-3 | Thấp (thiết kế) | Khoá ra cross-lane không có hạn hoàn theo thời gian; chỉ có `retryAcross` | **Mở** — yêu cầu vận hành (keeper + theo dõi `outboundNative`), không sửa code | `NetworkScenariosTest.test_RetryAllowedAndForwardRejectedForDirectRoute` (retry chạy được) |
| F-4 | Thông tin | Người rút trực tiếp có thể tự là relayer hợp lệ và nhận lại nửa phí | Chấp nhận (không phải lỗi), đã ghi | `test_DirectWithdrawChargesExactlyNineBpsAndSharesTheRebate` — đo đúng `fee/2` vào `relayCredit` |
| F-5 | Thông tin | Rebate relayer chỉ tồn tại trên lab 31337–31339 | Chấp nhận; cổng chain ID giữ nguyên | `HcmtToken`/`EthShieldedPool` kiểm chain ID ở constructor |
| F-6 | Thông tin | Comment biên tràn của `EthFeeStaking` lạc quan (nói tới 2^256) | **ĐÃ SỬA** (comment nói đúng trần `fundedWei` 2^128 ⇒ check revert) | `StakingInvariantTest` + fuzz `depositFees` |
| F-7 | Thông tin | `knownRoot` không bao giờ bị xoá | Chấp nhận: root không hết hạn theo thiết kế; cần theo dõi off-chain | `StatefulInvariantTest.invariant_treeStaysBounded` |
| F-8 | Thông tin | Chi lô all-or-nothing, ~35k gas/người nhận; một người nhận chặn cả lô | Chấp nhận (người nạp tự chọn người nhận), đã ghi | `test_RejectingRecipientRevertsWholeBatchThenRefunds` — cả lô revert, không chi đồng nào, sau hết hạn hoàn đủ 5 phần |

Quy tắc: một phát hiện **chỉ được đánh “ĐÃ SỬA” khi có bài test đỏ-trước-xanh-sau**.
F-1 ở trên đã được kiểm đúng cách đó (xem mục 4).

## 3. Bất biến & kịch bản nhiều điều kiện

Liệt kê theo *điều kiện đồng thời* — đây là phần fuzz ngẫu nhiên đều không tới được.

| Điều kiện phải cùng đúng | Bài test | Kết quả |
| --- | --- | --- |
| lô đầy + chưa chi + hết hạn chưa tới + có người nạp mới | `test_FullQueueOpensNextRoundAndKeepsPriorSettleable` | PASS |
| lô cũ hết hạn + round mới mở + nonce nhảy | `test_StaleRoundCannotBeJoinedAndRoundThreeNeedsTwo` | PASS |
| người nhận từ chối ETH + lô đủ + refund sau hết hạn | `test_RejectingRecipientRevertsWholeBatchThenRefunds` | PASS |
| nhiều vé + cap rebate theo lô + hai lô liên tiếp | `test_RelayCapAppliesPerBatchNotPerTicket` | PASS |
| stake 100 + qua biên kỳ + requestUnstake + claim | `test_RelayEligibilityDropsExactlyAtBoundaryAndKeepsEarnedCredit` | PASS |
| bỏ qua nhiều kỳ + pot có phí nạp + chia dư | `test_SkippedEpochsDoNotOverclaim` | PASS |
| vé 1 wei + tách phần + hoàn đúng + chống dùng lại proof | `test_OneWeiPartIsSingleUseAndRefundsExactlyOneWei` | PASS |
| **hai lô cùng đầy, cùng giữ tiền, rồi chi lần lượt** (trạng thái F-1 từng chặn) | `test_TwoFullRoundsSettleIndependently` | PASS |
| chia lô thành nhiều phần lẻ wei | `test_TinyBatchSplitsEveryWeiExactly` | PASS |
| phí 9 bps trên biên (1, 111, 1.111, 1.112, 2^64-1) | `test_FeeIsExactlyNineBpsForEveryTicket` | PASS |
| nạp nhiều note + tổng khớp từng wei + từ chối lệch | `test_DepositBatchSplitsEveryUnitOfNet` | PASS |
| rút trực tiếp + phí + rebate relayer | `test_DirectWithdrawChargesExactlyNineBpsAndSharesTheRebate` | PASS |
| khoá ra + gói Paid về + cộng thanh khoản + chống hoàn | `NetworkScenariosTest.test_LockedExitSettlesAndReplenishesLiquidity` | PASS |
| khoá ra + gói Cancelled + hoàn đúng 1 note | `test_CancelledExitRestoresExactlyOneNote` | PASS |
| gói Open vào + chi + chặn chi lần hai + chặn huỷ sau khi chi | `test_InboundAuthorizeClaimThenRules` | PASS |
| huỷ sai secret + huỷ đúng + chặn chi | `test_InboundCancelNeedsTheSecretAndBlocksPayment` | PASS |
| thanh khoản thiếu + nạp thêm + chi đúng | `test_ShortLiquidityBlocksThenAllowsClaim` | PASS |
| retry + forward sai tuyến + làn sai | `test_RetryAllowedAndForwardRejectedForDirectRoute`, `test_WrongLaneAndBadOrdersAreRejected` | PASS |

## 4. Bằng chứng “đỏ trước, xanh sau” cho F-1

```bash
cp contracts/ethereum/EthPoolState.sol /tmp/EthPoolState.fixed.sol
# khôi phục luật cũ (bỏ `full` khỏi `live`, bỏ guard `target`)
python3 - <<'PY'
from pathlib import Path
p=Path('contracts/ethereum/EthPoolState.sol'); s=p.read_text()
s=s.replace("bool full = previous.target != 0 && previous.entries.length == previous.target;","bool full = false;")
s=s.replace("live = !previous.paid && !full && block.timestamp < previous.expiresAt;","live = !previous.paid && block.timestamp < previous.expiresAt;")
p.write_text(s)
PY
./build/audit/bin/forge test --offline --use "$PWD/build/audit/bin/solc" --threads 1 \
  --match-test test_FullQueueOpensNextRoundAndKeepsPriorSettleable   # → FAIL: InvalidBatch()
cp /tmp/EthPoolState.fixed.sol contracts/ethereum/EthPoolState.sol
```

## 5. Bảng phủ (Forge coverage, chỉ `contracts/ethereum` + `contracts/vault`)

`forge coverage --report lcov` → **75/83 hàm, 513/586 dòng (87,5%)**.

| File | Hàm phủ | Dòng phủ |
| --- | --- | --- |
| `contracts/ethereum/EthPoolState.sol` | 20/22 | 146/154 |
| `contracts/ethereum/EthNetworkState.sol` | 19/19 | 114/124 |
| `contracts/ethereum/EthFeeStaking.sol` | 22/23 | 136/138 |
| `contracts/ethereum/RollupMessageTransport.sol` | 3/3 | 16/31 |
| `contracts/ethereum/HcmtToken.sol` | 5/5 | 26/26 |
| `contracts/vault/NativeNoteDeposits.sol` | 2/4 | 31/33 |
| `contracts/vault/NativeNoteTree.sol` | 4/4 | 44/45 |
| `contracts/vault/NativeStark.sol` | 0/3 | 0/35 |

Hàm chưa phủ và lý do (đã kiểm, **không** phải bỏ sót):

| Hàm | Lý do |
| --- | --- |
| `EthFeeStaking.currentEpoch`, `NativeNoteDeposits.maxNoteValue`, `commitment` | Bị optimizer inline; **dòng** của chúng có phủ (attribution của LCOV, không phải thiếu test) |
| `EthPoolVerified._pinnedHasher`, `_verifyNote` | Chỉ chạy trong `EthShieldedPool` thật (ghim codehash Poseidon); harness fixture thay verifier. Được phủ bởi nhánh deploy thật trong `npm test` / preview |
| `NativeStark.constructor`, `_extract`, `_verifyStark` | Cần deploy cả chồng verifier ghim bytecode; chỉ nhánh deploy thật chạm tới |

## 6. Checklist trước khi merge

- [x] F-1 sửa trong `EthPoolState._openOrJoin`, có test đỏ-trước-xanh-sau
- [x] F-6 comment đã viết lại đúng ngữ nghĩa `fundedWei` (2^128)
- [x] Bộ audit Solidity: 27 test PASS (fuzz 3.145.728 + stateful 1.572.864 lời gọi cũ + chiến dịch mới)
- [x] Chiến dịch stateful chạy lại trên **bản đã sửa** với `FOUNDRY_PROFILE=stateful`
- [x] `npm test` 22/22 PASS trên bản đã sửa
- [x] Kích thước: pool runtime 24.137 B / trần 24.576 B (còn 439 B) — đã ghi lại, không vượt
- [x] Không đổi ABI công khai, không đổi storage layout (chỉ thêm biến `full` cục bộ)
- [x] Mọi phát hiện F-1…F-8 có dòng trong mục 2 với trạng thái và bằng chứng
- [x] `docs/AUDIT-SOLIDITY.md` phản ánh trạng thái sau sửa (mục 4 mới)
- [ ] Echidna/Medusa: vẫn chưa chạy được trong sandbox — cấu hình sẵn sàng, ghi ở §5 báo cáo
