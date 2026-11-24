# Stake HCMT, nhận phí bằng ETH

[`EthShieldedPool`](../contracts/ethereum/EthShieldedPool.sol) tạo một [`EthFeeStaking`](../contracts/ethereum/EthFeeStaking.sol) riêng cho từng deployment. Staking nhận phí **0,09% khi nạp và 0,09% khi rút** từ pool trên cùng mạng. Rút liên mạng trả phí vào staking ở **mạng chi trả**, không thu thêm ở nguồn. Không dùng ETH gốc trong note để chia thưởng. Địa chỉ token stake được ghim lúc deploy và không thay đổi được. Vault vẫn chỉ nhận ETH để tạo note.

## HCMT: đúng 100.000 token, cấp một lần

- [`HcmtToken`](../contracts/ethereum/HcmtToken.sol) là ERC-20, ký hiệu **HCMT**, 18 chữ số thập phân. Constructor cấp toàn bộ `100_000 × 10^18` đơn vị cho `initialHolder` khác địa chỉ 0 và ghi một sự kiện `Transfer` từ địa chỉ 0. Không có quyền mint cần thu hồi: sau deploy không có owner, minter, hàm mint/burn hay cơ chế nâng cấp.
- **Ethereum lab (`31337`)** stake HCMT. Ví thử nhận 100 HCMT **qua chuyển token từ quỹ đã cấp lúc deploy**, không tăng tổng cung. Preview không yêu cầu khóa hay ví thật.
- **Base và Arbitrum lab** dùng fixture LAB cho các quỹ phí độc lập. Không mint thêm HCMT trên hai VM này, không gộp thưởng hay stake liên mạng. Chưa có deployment công khai, token bọc hoặc cầu nối HCMT. Mỗi lần dựng lab là một mô phỏng mới, không phải phát hành thật.

## Chu kỳ 30 ngày

- Các kỳ dài đúng **2.592.000 giây**, bắt đầu từ thời điểm deploy, không theo tháng lịch. Staking và yêu cầu rút token có hiệu lực ở **đầu kỳ sau**. Shares cố định trong cả kỳ: gửi token cuối kỳ không ăn phí của kỳ đó và không có stake rồi rút trong cùng một giao dịch để nhận thưởng.
- Khi một kỳ đóng, mỗi người hưởng `phí ETH kỳ đó × stake đang hiệu lực của mình / tổng stake đang hiệu lực`. Nếu cả kỳ chỉ có A stake 1 HCMT và B stake 3 HCMT, A hưởng 25% và B hưởng 75% (tính theo wei, có giữ phần lẻ). Không tính token còn trong ví hoặc gửi thẳng vào hợp đồng staking: dùng `approve` rồi `stake` để được ghi nhận. Nếu chưa có stake, phí chờ đến khi kỳ đầu tiên có stake đóng. Không có APR cố định.
- **`claim(to)`** trả tất cả phần thưởng nguyên wei của các kỳ đã đóng. Người dùng tự bấm **Nhận thưởng ETH**, có thể chọn địa chỉ nhận hoặc để nhận vào ví thử. Không claim thì thưởng không mất. Claim không đổi số token đã stake.
- **`requestUnstake(amount)`** hẹn giảm stake cho kỳ sau. **`withdrawStake(amount,to)`** nhận token đã được mở khóa, độc lập với nhận thưởng. Hết stake vẫn nhận được phần thưởng trước đó. Không chi token đang bị khóa.

## Hạch toán và kiểm thử

Không cần keeper để chốt kỳ. Mọi cập nhật roll theo `block.timestamp`, lưu chỉ số lũy kế và tối đa một mốc stake kế tiếp. Xem `position`/`epochState` đã tính cả kỳ vừa kết thúc dù chưa có giao dịch checkpoint. Không duyệt danh sách staker hoặc tất cả kỳ đã qua khi claim. Test nhảy qua 80 kỳ đã gom thưởng trong một giao dịch **142.236 gas** (lab).

Phần lẻ được giữ theo thang `2^128`, không dùng số thực. Dư nhỏ hơn một wei có thể chưa rút được cho đến khi tích lũy đủ; phần dư phép chia toàn cục được đưa sang kỳ sau. Token có fee-on-transfer bị từ chối nếu không bảo toàn lượng chuyển; không cấu hình token rebasing hoặc token có quyền thay đổi số dư trong custody. Token gốc và quỹ ETH được hạch toán riêng, không có owner/sweep. ETH gửi ép ngoài `fundFees` không được ghi thưởng. Tất cả lệnh đổi trạng thái được khóa reentrancy; payout lỗi thì credit không mất.

```sh
npm --prefix hcmtrail-native run test:hcmt
npm --prefix hcmtrail-native run test:staking
npm --prefix hcmtrail-native run test:pool:key  # cần build WASM; xác minh proof trong EVM lab
```

Test kiểm tra cấp cung đúng một lần, ERC-20 và không có hàm mint. Test staking dùng hợp đồng HCMT trong EVM lab: phí nạp/rút chia 1:3 chỉ sau khi kỳ đóng, claim dồn, claim không đổi stake hay tổng cung. Các test khác kiểm tra phí chờ khi chưa có stake, chống claim trùng, hoàn tác receiver lỗi, sai lệch lượng token nhận và bảo toàn quỹ theo wei. Trong preview không có API tua thời gian; test EVM tăng thời gian nội bộ để xác nhận đóng kỳ. STARK chỉ cấp quyền chi **note ETH**; staking và token theo số dư công khai trên chuỗi. Không chứng nhận hậu lượng tử cho ERC-20 hoặc chữ ký của ví blockchain.
