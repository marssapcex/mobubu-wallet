# hcmtrail — nạp và rút ETH bằng khóa note

**ETH thử, ba cây note riêng.** Một mã `EthShieldedPool` chạy trên ba EVM lab: Ethereum (`31337`), Arbitrum One (`31338`), Base (`31339`). Mỗi mạng có cây note và hợp đồng staking riêng. Chọn Ethereum để stake [HCMT](ETH-FEE-STAKING.md); hai VM còn lại dùng LAB thử, không phải HCMT. Giao diện hỗ trợ rút cùng mạng và [sáu chiều rút liên mạng](ETH-CLEARING.md) từ thanh khoản tự do ở đích.

## Chạy lab

Node.js ≥22.13. Để tạo proof trong trình duyệt, cần thêm Git và Rust 1.88.0 với target WASM:

```sh
npm ci --ignore-scripts
npm --prefix hcmtrail-native ci --ignore-scripts
rustup toolchain install 1.88.0 --profile minimal --target wasm32-unknown-unknown
RUSTC="$(rustup which --toolchain 1.88.0 rustc)" npm --prefix hcmtrail-native run build:pool:legacy:wasm
npm run pool:eth:legacy
```

Mở preview **4184** (chạy tại máy: `http://localhost:4184`). Chọn mạng nạp trong thanh mạng lab. Khi rút, khóa note xác định mạng nguồn; chọn mạng nhận trong form. Trình duyệt cần Web Workers, WebAssembly, `JSON.rawJSON` và `crypto.getRandomValues`. Prover cục bộ có thể mất vài phút. `POOL_PERIODIC_CACHE` tùy chọn trỏ tới cache **tham số công khai** `periodic.top` của prover ghim; không đặt khóa hoặc witness vào biến này. Khởi động lại lab tạo ba deployment mới; khóa note thử của phiên cũ không được di trú. Giao diện không cần kết nối ví tiền thật.

## Nạp, rút và hoàn

| Thao tác | Cách dùng |
| --- | --- |
| **Nạp** | Nhập ít nhất **0,01 ETH trước phí**. Ghi lại khóa `hceth3.…` hoặc tải file note JSON rồi xác nhận. Note ghi có đúng số wei sau phí. |
| **Rút ngay** | Dán khóa note, bấm **Mở khóa**. Ứng dụng chọn đúng mạng nguồn. Chọn **Mạng nhận ETH** rồi nhập địa chỉ trên mạng nhận; để trống số lượng để dùng hết note. Rút liên mạng cần thanh khoản ở đích, và luôn yêu cầu lưu khóa mới có note hoàn trước khi gửi proof. |
| **Rút thông minh** | Chọn lô hoặc mức ETH **trước phí** và sĩ số 5–100. Chỉ lượt góp đủ và qua verifier được đếm. Khi đủ lượt, một giao dịch trả cả lô; tất cả nhận cùng số ETH sau phí. |
| **Hoàn về note** | Lô hết 24 giờ chưa trả hoặc phần chưa đủ của lô đã chi có thể được hoàn. Với lệnh liên mạng đã xác thực nhưng chưa chi, có thể **Hủy lệnh và hoàn về note**. Mở lại bản sao đã lưu để xử lý tiếp, không cần tạo proof cho cùng lệnh. Không thu phí lúc giữ chỗ hoặc khi hoàn. |

Khóa note không phải private key ví. Đó là bản sao **không mã hóa** gồm bí mật mở note, giá trị và miền của deployment; checksum phát hiện chép nhầm chứ không thay quyền chi. Ai có khóa/file đều có thể chi note. Không dán seed phrase hoặc khóa ví thật. Không gửi khóa note qua chat hay máy chủ. Giao diện chỉ gửi calldata công khai, tạo và kiểm proof trong trình duyệt, không lưu khóa note vào local/session storage. Nếu bị mất khóa note, không có admin khôi phục.

## Phí và số dư

`fee = floor(grossWei × 9 / 10.000)`, `net = grossWei − fee`. Ví dụ nạp 1 ETH tạo note **0,9991 ETH**; rút hết note nhận **0,99820081 ETH**. Phí nạp là 0,0009 ETH, phí rút là 0,00089919 ETH, gas trả riêng. Phí chuyển thẳng vào [staking](ETH-FEE-STAKING.md) tại mạng nạp hoặc mạng thực sự chi trả. Khoản dưới 1.112 wei có phí 0 wei.

- Mỗi giao dịch nạp thu phí một lần, rồi chia **net** thành một hoặc nhiều note. `depositBatch` chỉ chấp nhận cung cấp cam kết tổng đúng net.
- Rút riêng chứng minh tổng `net + fee` được tiêu, đồng thời bind `net`, `fee`, người nhận, địa chỉ staking cố định và change trong statement. Không thể đổi đích hoặc sửa phí bằng cách gửi lại calldata. Nếu một giao dịch revert, không mất note hay phí.
- Lô giữ chỗ theo gross. Khi lô trả, tính phí một lần trên **mỗi lượt hoàn chỉnh**, không trên từng proof góp tiền. Payout hoặc ghi phí lỗi thì cả giao dịch rollback. Những phần được hoàn về note giữ nguyên giá trị.
- Một proof xử lý tối đa **18,446744069414584319 ETH trước phí** (`Goldilocks.P - 2` wei). Đây không phải trần số dư pool. Nạp hoặc rút lớn có thể cần vài giao dịch, phí làm tròn theo từng lần nạp/rút riêng; giao diện hiện số net. Rút riêng nhiều bước không nguyên tử. Lô có thể góp từ nhiều note và chỉ thu một phí trên lượt.
- Trong vận hành bình thường, số dư pool bằng `shieldedNative + reservedNative + outboundNative + liquidityNative` (không tính ETH gửi ép). Staking hạch toán phần phí riêng. ETH bị ép gửi không tạo thêm note, stake hay thưởng.

## Kiểm thử và phát hành

```sh
npm --prefix hcmtrail-native run build:pool:legacy # compile, không triển khai
npm test                                          # sáu chiều, trạng thái ETH/staking, FRI và khóa release
npm --prefix hcmtrail-native run test:pool:key    # cần WASM; khóa note, proof thật, fee, claim
npm --prefix hcmtrail-native run test:routes:fresh # cần WASM; proof thật và rút liên mạng
npm --prefix hcmtrail-native run test:pool:fresh   # luồng dài: proof thật và lô 5 lượt
```

`test:pool:key` dùng khóa note trên VM Ethereum, tạo STARK thật, trả net và dùng HCMT đang stake để nhận phí ETH sau khi kỳ đóng. [Test liên mạng](ETH-CLEARING.md) có ma trận cả sáu chiều và một bài proof thật riêng. Test chi lô 100 lượt chỉ dùng proof fixture để đo bước kế toán và chuyển ETH; không phải xác minh 100 proof trong một giao dịch.

**STARK không tự chứng minh hậu lượng tử.** Lab dùng verifier NotBefore A ghim đúng bytecode; mức cổ điển upstream báo khoảng 80,1 bit. FRI nghiên cứu chưa chứng minh quyền chi note. Cổng phát hành vẫn yêu cầu ≥256 bit soundness cổ điển và phân tích lượng tử được rà soát cho mục tiêu 128 bit, xem [ETH-POOL-STARK256.md](ETH-POOL-STARK256.md). Số tiền, địa chỉ payout, thời gian và dữ liệu staking công khai. Không triển khai lên chain công khai và không nạp tiền thật.
