# Rút ETH liên mạng từ thanh khoản có sẵn

**Chỉ ETH thử.** Một mã `EthShieldedPool` chạy ở cả ba vai trò. Ethereum ↔ Base, Ethereum ↔ Arbitrum One và Base ↔ Arbitrum One cho **sáu hướng**. Hai L2 trao đổi thông điệp qua Ethereum. **Không có ETH gốc trong thông điệp**: không chuyển tiền qua từng chặng, không bọc ETH và không dùng oracle. Test chỉ giả lập nguồn xác thực thông điệp ở ba EVM cô lập; không kiểm chứng finality hay vận hành trên mạng công khai.

## Kế toán

- Phí nạp **0,09%** vào staking nguồn. Note được ghi **sau phí**. Rút tính thêm **0,09%** trên `gross` thực sự tiêu từ note: `fee = floor(gross × 9 / 10.000)`, người nhận được `gross − fee`. Nạp 1 ETH, rút hết một note: **0,99820081 ETH**, chưa tính gas.
- `fundLiquidity` cấp ETH rõ ràng cho quỹ **`liquidityNative`**. Đây chưa phải cổ phần LP có quyền rút. Không dùng `shieldedNative`, `reservedNative` hoặc ETH gửi ép để trả lệnh từ mạng khác. Đích cần **đủ `gross`** để trả cả net lẫn phí vào staking ở đích.
- Sau khi đích xác nhận đã trả, gross đã giữ ở nguồn chuyển thành thanh khoản **tại nguồn**. Có thể phục vụ lệnh chiều ngược lại; nếu các luồng lệch về một hướng, pool đích có thể hết thanh khoản. Địa chỉ nhận chỉ nhận ETH, không nhận IOU hay nợ.
- `balance(pool) ≥ shieldedNative + reservedNative + outboundNative + liquidityNative`. Mỗi lần cấp vốn, khóa, trả hoặc hoàn cập nhật đúng ngăn tương ứng. ETH dành trả gas retryable không nằm trong các ngăn này.

## Lệnh, truyền tin và hoàn

1. Từ khóa `hceth3` mở note **tại nguồn**, kiểm root, tạo proof STARK. `ExitOrder` cố định chain nguồn/đích, số wei, recipient, cam kết của note hoàn, hash của một bí mật hủy **riêng** và salt. Giữ khóa note hoàn và bí mật hủy ở thiết bị trước khi gửi. `exitLeg` trong `pool/clearing.mjs` chuyển order thành 37 public limbs qua `prepareProof`; không dùng secret note làm bí mật hủy. Lệnh trực tiếp, lô và xuyên chuỗi có miền proof khác nhau.
2. `withdrawAcross` verify proof, tiêu nullifier một lần, tạo note dư nếu có, khóa gross tại `outboundNative` và gửi `Open`. Nếu gửi không thành công trong giao dịch, hoàn tác cả nullifier lẫn khóa. Có thể `retryAcross` cùng order mà không tạo proof hoặc trừ thêm tiền. Cùng note không thể rút tiếp tại nguồn hoặc tạo lệnh đích khác.
3. `acceptPacket` kiểm domain chung và caller theo đúng chặng: messenger + `xDomainMessageSender` cho Base, Bridge + Outbox đang hoạt động cho Arbitrum rút về L1, alias của pool L1 cho thông điệp đến Arbitrum. Nếu là chặng trung gian ở Ethereum thì ghi quyền `forwardPacket`, không ghi quyền rút cho Ethereum. Callback không nhận ETH. Trường hợp Inbox cần gas trả trước, `l2CallValue = 0`; ngân sách `gasLimit × maxFeePerGas + maxSubmissionCost` trả riêng.
4. Khi đã xác thực, `claimAcross` được gọi bởi bất kỳ ai nhưng chỉ trả đến địa chỉ bind. Thiếu `liquidityNative` thì vẫn `Authorized`, không mất phí và có thể thử lại sau khi quỹ được nạp. Đọc mức thanh khoản trước khi khóa hữu ích nhưng không phải đặt chỗ. Nhiều lệnh hợp lệ cạnh tranh cùng quỹ; không hứa thứ tự hay trả ngay.
5. Nếu muốn hủy lệnh đang `Authorized`, dùng bí mật riêng trong `cancelAcross` ở đích. Trạng thái `Paid` và `Cancelled` loại trừ nhau. `publishOutcome` gửi kết quả theo đường ngược. Sau `Paid`, nguồn đổi tiền đã khóa thành thanh khoản nguồn; sau `Cancelled`, `refundAcross` khôi phục **đủ gross vào note đã bind**, không thu phí rút. Chỉ thời gian trôi ở nguồn không đủ để hoàn tiền, vì đích có thể đã trả. Gửi lại packet không gây chi hoặc ghi có lần hai. Chậm/mất kênh xác thực có thể kéo dài khoản đang khóa.

## Dùng preview 4184

1. Dựng WASM và mở lab theo [runbook](ETH-POOL.md). Mỗi VM được cấp **2 ETH thử** vào quỹ tự do lúc khởi động; đây không phải note và không sinh phí nạp.
2. Vào **Rút ngay**, dán khóa `hceth3` và **Mở khóa**. Mạng nguồn tự nhận theo khóa. Chọn **Mạng nhận ETH** và nhập địa chỉ nhận trên mạng đó. Giao diện đọc quỹ tự do từ hợp đồng và hiện gross, phí, net; gas lab được tài trợ riêng. Có thể rút cùng mạng mà không dùng quỹ này. **Rút thông minh** vẫn là lô nội mạng.
3. Tạo proof trong trình duyệt. Trước khi gửi lệnh liên mạng, lưu khóa mới hoặc file JSON: nó chứa note dư (nếu có), note hoàn và bí mật hủy riêng. Số dư và thanh khoản hiển thị là ảnh chụp, không phải đặt chỗ; thiếu thanh khoản trước lúc tạo proof thì giao diện chưa khóa note.
4. Nếu bị ngắt kết nối hoặc giao dịch chưa chi, mở lại khóa mới trên **cùng phiên lab**, xem mục **Rút liên mạng** và bấm **Kiểm tra và xử lý tiếp**. Nếu đích đã xác thực nhưng chưa chi, có thể chọn **Hủy lệnh và hoàn về note**. Bí mật hủy độc lập chỉ được công khai lúc hủy; không gửi bí mật mở note hay khóa ví. Khởi động lại lab xóa trạng thái và làm vô hiệu các khóa của phiên cũ.

Relay preview chỉ phát thông điệp đúng thứ tự chặng từ log `MessageQueued` của hợp đồng đã gắn cố định. Giao diện chỉ gửi calldata hợp lệ của pool, hoặc yêu cầu xử lý tiếp bằng mã lệnh đã ghi nhận; không có endpoint RPC, giả signer, truyền packet tùy ý hay cấp vốn.

## Chạy thử

```sh
npm --prefix hcmtrail-native ci --ignore-scripts
npm --prefix hcmtrail-native run build:pool:legacy
npm --prefix hcmtrail-native run test:routes
# Cần build WASM theo ETH-POOL.md:
npm --prefix hcmtrail-native run test:routes:fresh
```

`test:routes` chạy cả sáu chiều trên ba VM bằng fixture proof để kiểm trạng thái nhanh. Có thử đúng 1 wei, lệch 1 wei thanh khoản, số dư shielded không dùng được, top-up, giả caller / replay, Inbox lỗi rồi gửi lại, và hủy → hoàn. ETH trả trên từng VM là thật trong **môi trường thử**, lấy đúng từ ETH đã cấp cho quỹ đích. `test:routes:fresh` tạo proof WASM thật từ khóa note, verify bằng stack đã pin trên VM Ethereum, sau đó nhận ETH từ quỹ Base và xác nhận nguồn. Quá trình tạo một proof có thể mất vài phút và dùng nhiều RAM; chạy lần lượt các test WASM trên máy ít RAM. Các kết quả này không đo thời gian finality ngoài mạng thật.


### Kết quả lab V3

| Kiểm thử | Kết quả |
| --- | --- |
| `npm test` | 21/21. Ma trận 6/6 hướng dùng proof fixture, có kiểm số dư ETH thực trong VM, phí/dust, thiếu thanh khoản, hủy hoàn và chống phát lại. |
| `test:routes:fresh` | Ethereum → Base, proof STARK WASM thật. Nạp `1000000000000000017`, note `999100000000000017`, địa chỉ đích nhận `998200810000000017` wei. Staking Base nhận `899190000000000` wei. Giao dịch khóa proof dùng `8460350` gas; proof `95656` byte trong lần chạy này. |
| Chromium, preview 4184 | Base → Ethereum → Arbitrum One, proof thật trong trình duyệt. Thử ngắt bước chuyển tiếp rồi tải lại trang và xử lý tiếp qua khóa đã lưu. Đích nhận phần net, staking ở nguồn chỉ nhận phí nạp; không upload khóa note. |
| `test:pool:key` | Rút cùng mạng Base bằng proof thật và nhận đúng phí staking sau khi kỳ đóng. |

**Giới hạn:** Nhánh đúng 1 wei dùng tag và một địa chỉ tổng hợp để ràng buộc 222 bit của digest; đây là tương thích với circuit lab, không phải thiết kế đã đạt ngưỡng phát hành. Route ID, số tiền, địa chỉ nhận và dấu thời gian vẫn quan sát được. Không gộp nhiều chain thành một giao dịch nguyên tử. Để phát hành cần verifier chi note đạt yêu cầu [256 bit cổ điển + đánh giá lượng tử](ETH-POOL-STARK256.md), manifest peer/hệ thống xác thực được kiểm tra, kiểm thử finality/challenge/retryable thực tế, và rà soát kế toán/thanh khoản độc lập. Không có quyền admin để cấp quyền rút hay quét tiền; đây không phải hệ thống đã được kiểm toán hoặc thanh khoản thật.
