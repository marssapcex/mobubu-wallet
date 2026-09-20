# 🦡 Mobubu Wallet: The Monero Web3 Privacy Extension

**Mobubu Wallet** là tiện ích mở rộng trình duyệt (Chrome, Brave, Firefox, Edge) kết hợp trải nghiệm thân thuộc, mượt mà của **MetaMask** với tiêu chuẩn bảo mật tuyệt đối của **Feather**, **Cake Wallet**, và **Monero GUI**.

---

## 🔍 Báo cáo Self-Audit & Các Nâng Cấp Kỹ Thuật Chuyên Sâu

Trong đợt tự audit toàn diện mã nguồn, Mobubu đã hoàn thành kiểm thử tự động 8/8 module (`npm test` / `test-audit.mjs` đạt 100%):

### 1. Nền tảng Mật mã Monero chuẩn xác (Ed25519, Keccak-256, CN-Base58)
- **Monero CN-Base58**: Đã audit thuật toán mã hóa & giải mã khối 8-byte thành 11 ký tự, xử lý trọn vẹn các byte lẻ còn lại (1 byte ➔ 2 ký tự, 2 byte ➔ 3 ký tự, 5 byte ➔ 7 ký tự). Đã kiểm thử tính thuận nghịch (roundtrip) 100%.
- **Key Derivation**: 32-byte seed được giảm số nguyên (scalar reduction) theo cấp đường cong Ed25519 `l = 2^252 + 27742317777372353535851937790883648493`.
  - Khóa chi tiêu bí mật (Private Spend Key) $b$.
  - Khóa xem bí mật (Private View Key) $a = \mathcal{H}_s(b)$.
  - Khóa công khai $B = bG$ và $A = aG$.
- **Địa chỉ chuẩn (Primary Address)**: Bắt đầu bằng số `4...`, độ dài chính xác 95 ký tự, checksum Keccak-256 4 byte.
- **Địa chỉ phụ ẩn danh (Stealth Subaddress)**: Bắt đầu bằng số `8...`, độ dài 95 ký tự, sinh từ $m = \mathcal{H}_s(\text{"SubAddr\0"} \parallel a \parallel i \parallel j)$, $D = B + mG$, $C = aD$.
- **Địa chỉ tích hợp (Integrated Address)**: Bắt đầu bằng `4...`, độ dài 106 ký tự, nhúng trực tiếp Payment ID 8 byte cho các sàn giao dịch hoặc thanh toán thương mại điện tử.
- **OpenAlias Resolver**: Tự động phân giải các địa chỉ tên miền dạng `donate@getmonero.org` thành địa chỉ XMR chuẩn.

### 2. Khắc phục trọn vẹn 4 điểm yếu lớn của các ví Monero hiện nay
1. **Dạng Extension như MetaMask**:
   - Kiến trúc chuẩn **Manifest V3** (`manifest.json`, `background.js` Service Worker, `content.js` tiêm Web3 provider `window.mobubu` và `window.monero`).
   - Cung cấp cả giao diện **Popup Extension (380x600px)** lẫn **Tab mở rộng toàn màn hình (Expanded View)**.
2. **Minh bạch kết nối Tor vs Clearnet**:
   - Thanh trạng thái trực quan: `[🧅 Tor Active]` (xanh lá), `[⚡ Local Node]` (xanh dương), hoặc `[🌐 Clearnet]` (cảnh báo lộ IP).
   - Tích hợp danh sách Node Tor Onion từ Feather Wallet (`.onion:18089`) và công tắc ép buộc proxy SOCKS5 (`127.0.0.1:9050`).
3. **Quy trình Onboarding thân thiện, an toàn**:
   - Đặt Master Password mã hóa khoá bằng **AES-256-GCM + PBKDF2 (100.000 vòng)**.
   - Hiển thị 25 từ Monero Seed sạch sẽ kèm câu đố xác thực từ ngẫu nhiên (Verification Quiz) chống quên sao lưu.
   - Hỗ trợ cả **Ví chỉ xem (View-Only Wallet)** để kiểm toán số dư an toàn mà không cần lưu khóa chi tiêu trên trình duyệt.
4. **Trải nghiệm quen thuộc cho người dùng MetaMask**:
   - Layout quen thuộc: Network Pill, Avatar identicon, Pill copy địa chỉ rút gọn, số dư lớn XMR + quy đổi USD, 4 nút chức năng kinh điển: **Buy, Swap, Send, Receive**.

### 3. 🛡️ Privacy Posture Meter (Điểm bảo mật 0 – 100)
Điểm số được tính toán động dựa trên 4 trụ cột:
- **Trụ cột 1: Tầng mạng (Network Transport)** (Tối đa 30đ): Tor Onion (+30đ) vs Clearnet lộ IP (0đ).
- **Trụ cột 2: Độ tin cậy Node (Node Sovereignty)** (Tối đa 25đ): Full Node cục bộ (+25đ), Node Feather Onion (+20đ), Clearnet (+6đ).
- **Trụ cột 3: Vệ sinh địa chỉ (Address Hygiene)** (Tối đa 25đ): Subaddress mới dùng 1 lần (+25đ), Subaddress tái sử dụng (+18đ), Địa chỉ chính 4... lộ dữ liệu (0đ).
- **Trụ cột 4: Ẩn danh đầu ra & Phòng vệ EAE (Decoys & Output Churn)** (Tối đa 20đ): Ring size 16 bắt buộc + Đầu ra đã churn (+20đ). Nếu có tiền mới nhận chưa churn, hệ thống cảnh báo nguy cơ **tấn công EAE (Exchange-Alice-Exchange)** và khuyến nghị churn tự chi tiêu để xóa dấu vết chuỗi giao dịch.

### 4. 🔀 Bộ gom Swap chuẩn Cake Wallet
- Hoán đổi chéo 2 chiều giữa: **BTC, ETH, SOL, USDT, LTC <-> XMR**.
- Gom tỷ giá tự động từ các sàn không KYC: **Trocador (Tor Onion Aggregator), ChangeNOW, FixedFloat, SimpleSwap**.
- Quy trình theo dõi giao dịch trực tiếp 4 bước: `waiting_deposit` ➔ `confirming` ➔ `exchanging` ➔ `finished`.

### 5. 🖥️ Quản lý Full Node chuẩn Monero GUI
- Kết nối trực tiếp với daemon cục bộ `http://127.0.0.1:18081`.
- Công cụ **Benchmark All Nodes** để kiểm tra độ trễ (latency ms) của tất cả các node Tor và Clearnet theo thời gian thực.
- Hướng dẫn lệnh khởi chạy `monerod` cục bộ chỉ bằng 1 nút bấm copy.

---

## 🧪 Kết quả Kiểm thử Tự động (`test-audit.mjs`)

```
====================================================
🧪 RUNNING COMPREHENSIVE MOBUBU AUDIT SUITE
====================================================

▶ [Test 1] Monero Base58 Encoding & Decoding...
  ✓ Base58 roundtrip verified (16 bytes -> 22 base58 chars)
▶ [Test 2] Monero Cryptographic Key & Address Derivation...
  • Primary Address: 422RGxySZ3HPD6qsbX8nNRJ3Fqn3fHPxcY3MuFafw8EoV98GNwfPt7YFegveLeUsw4Q1aaK1WZMVh3HkaNJvhWFbA4d6tS2
  ✓ Primary Address format and checksum verified
▶ [Test 3] Monero Subaddress Derivation (Major: 0, Minor: 1)...
  • Subaddress #1: 87vFwwTKXY8jBGo7zPVm8uZeDxmvrXPoeeVehiC1Kwt7XtrmnWPGnFch6EhKYZTbsJcPf3AutMm5aBgRAfDdGZ5fLdizVjX
  ✓ Subaddress derivation and checksum verified (Starts with 8)
▶ [Test 4] Monero Integrated Address with 8-byte Payment ID...
  • Integrated Address: 4Bj6HmnwAJoPD6qsbX8nNRJ3Fqn3fHPxcY3MuFafw8EoV98GNwfPt7YFegveLeUsw4Q1aaK1WZMVh3HkaNJvhWFbEP9KAAEB1xQU4NFp7f
  ✓ Integrated Address 106 chars and payment ID extraction verified
▶ [Test 5] Monero 25-Word Seed Mnemonic & CRC32 Checksum Word...
  ✓ 25-word mnemonic generation, CRC32 checksum, and recovery verified
▶ [Test 6] Keyring Vault PBKDF2 + AES-256-GCM Encryption...
  ✓ Vault AES-256-GCM encryption, decryption, and authentication tag verified
▶ [Test 7] Privacy Posture Meter Scoring Algorithm...
  • High Stealth Score: 95/100 [Ironclad Stealth]
  • Exposed Clearnet Score: 16/100 [Clearnet Exposed]
  ✓ Privacy Posture calculation, tier grading, and recommendations verified
▶ [Test 8] Cake-Style Cross-Chain Swap Aggregator Quotes...
  • Best Rate: 0.05 BTC ➔ 18.602174 XMR via Trocador Aggregator (Tor Onion)
  ✓ Swap aggregator multi-provider rate calculation verified

====================================================
🎉 ALL 8 AUDIT MODULES PASSED WITH 100% SUCCESS
====================================================
```

---

## 🚀 Hướng dẫn Chạy và Cài đặt Mobubu

### 1. Trải nghiệm trực tiếp trên Trình duyệt (Live Dev Server)
Dev server đang chạy tại cổng `0.0.0.0:3000`:
- 📱 **Extension Popup**: Khung mô phỏng cửa sổ extension 390x640px chuẩn Chrome.
- 🖥️ **Expanded Tab**: Chế độ bảng điều khiển máy tính toàn màn hình.
- 🧪 **Web3 Playground**: Cửa hàng dApp mô phỏng kết nối với `window.mobubu` và gửi yêu cầu thanh toán XMR.

### 2. Cài đặt vào Chrome / Brave / Edge (Load Unpacked)
1. Mở `chrome://extensions` trên trình duyệt.
2. Bật công tắc **Developer mode** ở góc trên bên phải.
3. Nhấp nút **Load unpacked** và chọn thư mục `mobubu-wallet/dist`.
4. Mobubu Wallet sẽ xuất hiện trên thanh công cụ Extension trình duyệt của bạn.

### 3. Cài đặt vào Firefox
1. Mở `about:debugging#/runtime/this-firefox`.
2. Nhấp **Load Temporary Add-on...**.
3. Chọn tệp `mobubu-wallet/dist/manifest.json`.
