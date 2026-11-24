# Staking token, nhận phí bằng ETH

[`EthShieldedPool`](../contracts/ethereum/EthShieldedPool.sol) tạo một [`EthFeeStaking`](../contracts/ethereum/EthFeeStaking.sol) riêng cho từng deployment. Hợp đồng staking nhận phí ETH **0,09% khi nạp và 0,09% khi rút** từ pool trên cùng mạng. Rút liên mạng trả phí vào staking ở **mạng chi trả**, không thu thêm ở nguồn. Không lấy ETH gốc trong note để chia thưởng. Token stake là một ERC-20 được đặt bất biến lúc dựng hợp đồng, khác với tài sản trong pool (chỉ ETH). Mạng thực chưa cấu hình token. Lab dùng **LAB** giả và ví thử riêng mỗi phiên; không cần cung cấp ví hoặc khóa thật.

## Chu kỳ 30 ngày

- Các kỳ dài đúng **2.592.000 giây**, bắt đầu từ thời điểm deploy, không theo tháng lịch. Staking và yêu cầu rút token có hiệu lực ở **đầu kỳ sau**. Shares cố định trong cả kỳ: gửi token cuối kỳ không ăn phí của kỳ đó và không có stake rồi rút trong cùng một giao dịch để nhận thưởng.
- Khi một kỳ đóng, phí được phân theo tỷ lệ `stake đang hiệu lực / tổng stake đang hiệu lực`. Nếu chưa có stake, phí chờ kỳ đầu tiên có stake và được chia khi kỳ đó đóng. Không có APR cố định hay phát hành thưởng khi không có phí.
- **`claim(to)`** trả tất cả phần thưởng nguyên wei của các kỳ đã đóng. Người dùng tự bấm **Nhận thưởng ETH**, có thể chọn địa chỉ nhận hoặc để nhận vào ví thử. Không claim thì thưởng không mất. Claim không đổi số token đã stake.
- **`requestUnstake(amount)`** hẹn giảm stake cho kỳ sau. **`withdrawStake(amount,to)`** nhận token đã được mở khóa, độc lập với nhận thưởng. Hết stake vẫn nhận được phần thưởng trước đó. Không chi token đang bị khóa.

## Hạch toán và kiểm thử

Không cần keeper để chốt kỳ. Mọi cập nhật roll theo `block.timestamp`, lưu chỉ số lũy kế và tối đa một mốc stake kế tiếp. Xem `position`/`epochState` đã tính cả kỳ vừa kết thúc dù chưa có giao dịch checkpoint. Không duyệt danh sách staker hoặc tất cả kỳ đã qua khi claim. Test nhảy qua 80 kỳ đã gom thưởng trong một giao dịch **142.236 gas** (lab).

Phần lẻ được giữ theo thang `2^128`, không dùng số thực. Dư nhỏ hơn một wei có thể chưa rút được cho đến khi tích lũy đủ; phần dư phép chia toàn cục được đưa sang kỳ sau. Token có fee-on-transfer bị từ chối nếu không bảo toàn lượng chuyển; không cấu hình token rebasing hoặc token có quyền thay đổi số dư trong custody. Token gốc và quỹ ETH được hạch toán riêng, không có owner/sweep. ETH gửi ép ngoài `fundFees` không được ghi thưởng. Tất cả lệnh đổi trạng thái được khóa reentrancy; payout lỗi thì credit không mất.

```sh
npm --prefix hcmtrail-native run test:staking
npm --prefix hcmtrail-native run test:pool:key
```

Test xác nhận thời điểm có hiệu lực, phí carry khi chưa có stake, claim dồn & chống claim trùng, hoàn tác receiver lỗi, sai lệch lượng token nhận và bảo toàn quỹ theo wei. Trong preview không có API tua thời gian; test EVM tăng thời gian nội bộ để xác nhận đóng kỳ. STARK chỉ cấp quyền chi **note ETH**; staking và token theo số dư công khai trên chuỗi. Không chứng nhận hậu lượng tử cho ERC-20 hoặc chữ ký của ví blockchain.
