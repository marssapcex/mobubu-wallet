# Rút native liên mạng · giá tại lúc rút, phí đúng một lần

**Profile `CrosschainNoteVault` / `CrosschainLiquidity` là devnet/testnet thử nghiệm. Không dùng tiền thật.** Có hai máy ảo với hai ledger độc lập; giá dùng feed fixture, chứng thư truyền log dùng 2/3 witness fixture. Không phải một cầu live, không phải bằng chứng đồng thuận. Vault nội mạng và staking trước đây bất biến, không tự có đường cross-chain, không import note cũ vào cây mới.

## Chính sách tiền

- **Nạp:** `deposit(ownerCommit)` ghi note bằng `msg.value − floor(msg.value/400)` theo **coin nguồn**. Phí nạp về treasury nguồn ngay. Không đọc oracle, không đổi sang USD/HYPE, không mở hay giữ một khoản HYPE. Ngay cả khi oracle offline, vẫn nạp và rút nội mạng được.
- **Rút cùng chain:** verify proof STARK của note, trả `amount − floor(amount/400)` đúng loại coin và phần phí về treasury cùng chain. Nhánh nội mạng giữ chính sách broadcaster cũ; proof có fee bằng 0 có thể được người khác tài trợ gas.
- **Rút khác chain:** xác thực proof STARK của note nguồn rồi **chốt một epoch đang active tại giao dịch khóa lệnh**. Không dùng epoch lúc nạp/hay lúc bắt đầu sinh proof. `amountIn` là phần đã chọn từ **note ròng**, không trừ lại phí nạp hay phí rút ở nguồn. Sender của `lockWithdrawal`, `pay`, `complete` hoặc `refund` chỉ trả gas; **0 phí gas trừ vào note/payout** của nhánh này. Không có hoàn gas trên chain hay phí swap ẩn.

```text
grossDst = floor(amountIn × USD18[src] × units[dst] / (USD18[dst] × units[src]))
daoDst   = floor(grossDst / 400)
netDst   = grossDst − daoDst
```

`units[TRX]=10^6` (sun), `units[ETH,BNB,HYPE]=10^18`; **không** lấy decimals của feed làm decimals của coin. Thực hiện một phép floor cho quy đổi và một floor cho khoản phí theo `HcmtPolicy`; không tính `floor(gross × 0,9975)` thay cho `gross − floor(gross/400)`. `netDst >= minNetOut` và `grossDst <= liquidityLimit`. Max input là miền note của chain nguồn; payout native ở đích không phải note mới, nên không bị cap Goldilocks của cây note (vẫn giới hạn uint96 EVM / int64 sun ở TVM).

| ETH → HYPE ở giá rút | Số thực hiện |
| --- | ---: |
| Nạp gross | 1 ETH |
| Phí nạp gửi treasury ETH | 0,0025 ETH |
| Note | 0,9975 ETH |
| Giá ETH / HYPE lúc chấp nhận rút | 2.500 USD / 80 USD |
| HYPE gộp | 31,171875 HYPE |
| Phí rút gửi treasury HYPE | 0,0779296875 HYPE |
| **HYPE người nhận** | **31,0939453125 HYPE** |

HYPE 60 USD lúc nạp không tham gia công thức. Nếu vẫn dùng 60 thì gross là 41,5625 HYPE, trị giá 3.325 USD theo giá 80, chênh 831,25 USD trước phí. User chịu biến động tỷ giá **đến lúc chốt rút**; sau đó LP chịu rủi ro giá/thanh khoản đến khi hoàn tất và tái cân bằng. Giá feed là chuẩn tham chiếu, không bảo đảm thanh khoản hoặc LP có lãi. Không tự chi khi giá không nằm trong giới hạn đã chấp nhận.

## Trình tự hợp đồng

1. **Lập lệnh thị trường có giới hạn.** Người dùng chọn nguồn/đích, số coin nguồn, `minNetOut`, cap thanh khoản, đích nhận, LP, hạn `acceptBy`/`payBy` và cam kết note hoàn (`refundOwnerCommit`). Ví giữ backup opening của note hoàn **trước khi** công khai lệnh/proof. LP tự chọn tài trợ lệnh và ghi địa chỉ đối ứng nguồn. Cùng một `orderId` ràng buộc toàn bộ dữ liệu; không cho sponsor đổi người nhận hoặc kéo dài hạn. Để kiểm giá trước khi gửi, tính local từ epoch công khai; `quote(...)` qua RPC làm lộ lượng/đích.
2. **Đích giữ chỗ cap.** `CrosschainLiquidity.reserve` tách tiền native đã nạp của đúng LP từ `freeLiquidity` sang `reservedNative`. Dùng cap, không phải lời hứa một lượng chính xác lúc nạp. Lệnh nào thiếu thanh khoản thì không reserve; LP không thể rút số đã khóa. Trường hợp giá mới cho gross vượt cap thì nguồn từ chối lệnh, không đụng note.
3. **Nguồn khóa đúng principal.** Bất kỳ signer nào gọi `lockWithdrawal` với STARK và chứng thư event `Reserved` đúng tuyến. Nguồn lấy `oracle.activeEpoch()` **trong transaction**, không nhận `priceIn`/`priceOut` do relayer khai. Không dùng epoch cũ đã bị supersede, giá stale, ngoài bounds hoặc lệch timestamp. Ghi `WithdrawalLocked` gồm epoch, giá hai coin, thời điểm và gross. Chuyển số `amountIn` từ backing note sang escrow, không gửi ra ngay; giữ chỗ một lá để có thể hoàn kể cả nếu tree gần đầy. Hai nullifier chung giữa rút nội mạng và liên mạng; change vẫn ghi ở chain nguồn.
4. **Đích chỉ trả đúng giá đã khóa.** `pay` kiểm log `Locked` với đúng rate hash, tự tính lại gross/fee/net bằng cùng công thức và đánh dấu lệnh đã chi. Thanh toán `netDst` và phí DAO bằng một giao dịch; lỗi ở một chân làm revert cả reserve/paid marker/fee. Không đọc giá mới ở đích. Chứng thư `Paid` cho phép `complete` credit đúng `amountIn` cho **LP nguồn đã ràng buộc**, không trả cho sponsor. LP rút phần credit riêng; không dùng backing note hoặc pending escrow.
5. **Hủy và hoàn có chứng cứ.** Đích chỉ `cancel` khi chưa trả và đã tới `payBy`, là trạng thái cuối không quay về `pay`. Nguồn chỉ `refund` nếu có chứng thư `Cancelled` đúng order. Phát lại một note được bảo chứng bằng nguyên principal, không thu phí nạp mới, không gỡ nullifier cũ. Giá cũ, thiếu receipt, timeout RPC hay hết giờ tự chúng **không** được hoàn. Nếu đường truyền hoặc đích ngừng hoạt động, escrow có thể phải đợi; không tạo đường tắt cho operator.

Kế toán: nguồn `balance >= accountedNative + escrowNative + creditedNative`; đích `balance >= availableNative + reservedNative`. Số dư bị ép vào hợp đồng không trở thành tín dụng của LP hay phí DAO tự động.

### STARK và mô hình tin cậy còn lại

`SpendGate` kiểm trực tiếp image NotBefore đã pin. Vault kiểm **runtime và mọi liên kết** của gate/Prepare/Walk/evaluator/chunks trước khi nhận cấu hình gate. Cross-chain dùng toàn bộ hash lệnh qua hai slot địa chỉ tổng hợp, không phải địa chỉ được chi. Trong quan hệ bảo toàn chia `amountIn` thành `amountIn−1` và `1`; **cả hai vào escrow**, đơn vị thứ hai không phải thù lao. Nhánh rút local từ chối phí relay `1`, thấp hơn sàn trên mọi chain, nên không thể diễn giải proof cross-chain thành thanh toán đến hai địa chỉ tổng hợp. So với proof staking, đây là proof chi **note đã funded**, không phải credential staking. Không có khóa admin/sweep.

`IFinalizedEvents` là ranh giới riêng, không phải oracle giá. `ReceiptQuorum` hiện kiểm 2 chữ ký EIP-712 khác nhau trong 3 witness cố định, buộc chain/contract phát, loại sự kiện, order, dữ liệu, block/tx/log index và chain/verifier/contract nhận. Test lấy dữ liệu từ receipt của hai VM mới ký. **Chữ ký không chứng minh đồng thuận hay reorg safety. Hai witness thông đồng có thể giả log, chi sai thanh khoản đã giữ chỗ hoặc hoàn/giải phóng escrow sai.** Chúng không có quyền chi note chưa được STARK cho phép. Chỉ dùng cho mô phỏng và thử nghiệm kiểm soát; không đưa vào luồng tiền public. Chưa có verifier finality/bridge được xác thực cho đủ bốn chain; phải thay adapter bằng bản kiểm finality thật và audit cấu hình/canonical deployment trước khi dùng thật. Không cấu hình oracle/adapter proxy tùy ý. Các price feeds chỉ được gọi **cùng chain với hợp đồng oracle**, không truyền địa chỉ proxy ở chain khác vào như địa chỉ local.

Đây không phải thiết kế ẩn tuyến/lượng/đích: các điều đó công khai ở order. Opening, đường Merkle và khóa chi vẫn cục bộ. Không có lời hứa ẩn danh liên chuỗi, an toàn hậu lượng tử end-to-end hoặc khả năng đổi shard gốc HCMT; muốn chuyển thưởng native thì claim nội mạng trước rồi dùng rail native riêng.

## Chạy lại trong VM

```bash
npm ci --ignore-scripts
npm run build:crosschain
npm run test:crosschain
# Với compiler TRON chính thức đã pin (xem TESTNET.md):
npm run build:crosschain -- --tvm
npm run test:crosschain  # thêm test deploy/nạp/reserve/hủy bằng TVMJS
# Prover pin; sinh proof thật mới tại chỗ, ngoài repo, không gọi public RPC:
NATIVE_CROSSCHAIN_VECTORS_DIR="$(mktemp -d)" npm run test:crosschain:fresh
```

Test EDR dựng một chain nguồn ETH và một chain đích HYPE; không giả lập quyền chi STARK bằng mock. Chứng minh một note funded rồi kiểm hai nhánh trả/hoàn từ snapshot. Nhánh nội mạng dùng proof thật khác của **cùng note** để kiểm share nullifier và rút khi oracle offline. Các ca lỗi gồm thiếu thanh khoản, giá 60/100 không đạt cap/minOut, giá stale, chứng thư sai/signer trùng, proof sai đích, sai gross một wei, payout revert, replay và hoàn chỉ vì timeout. Test TVMJS kiểm build/pin, nạp sun và dự trữ/hủy, **không phải** receipt cross-chain Nile hay Energy thật. CLI `testnet` cũ vẫn chỉ vận hành profile nội mạng; chưa có CLI phục hồi/điều phối public cho lệnh cross-chain.

Sinh mới 2 STARK của cùng note trong fixture ETH: lệnh cross-chain **95.208 byte / 188 giây**, lệnh nội mạng **96.360 byte / 139 giây** (một lần chạy). Mỗi lệnh được kiểm trên chain mô phỏng với đúng quan hệ và tiền nạp. Chi phí mẫu khoảng **8,59M gas EDR** để khóa ở nguồn và **176 nghìn gas EDR** để chi ở đích, chưa gồm fund/reserve/complete hoặc phí transport live. Đây không phải phí mạng, Energy Nile hay báo giá gas bảo đảm.
