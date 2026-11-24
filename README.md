# hcmtrail · ETH Vault V3 và HCFR v2

**[Toàn bộ link mã hợp đồng hiện hành](hcmtrail-native/docs/CONTRACTS.md)** — tách mã vault lab và mã FRI nghiên cứu hướng hậu lượng tử. HCFR v2 chưa chứng minh quyền chi note và không được nối vào vault.

**ETH vào, ETH ra.** Ethereum, Base và Arbitrum One chạy cùng mã hợp đồng, với số dư và cây note riêng. Có thể rút trên mạng đã nạp hoặc dùng một trong **sáu chiều rút liên mạng**. Mạng đích trả từ ETH thanh khoản có sẵn, không lấy ETH bảo chứng note của người khác. Chỉ truyền thông điệp xác thực, không chuyển ETH gốc qua các mạng, không có oracle.

**Phí 0,09% khi nạp và 0,09% khi rút**, làm tròn xuống theo wei. Phí vào staking của mạng thực hiện giao dịch nạp hoặc chi trả. Thưởng ETH chia theo kỳ 30 ngày; có thể nhận dồn nhiều kỳ trong một lần.

> **Chỉ lab, không dùng tiền thật.** Ba EVM local mô phỏng kênh thông điệp. Verifier STARK hiện tại chưa đạt điều kiện phát hành công khai.

```sh
npm ci --ignore-scripts
npm --prefix hcmtrail-native ci --ignore-scripts
npm test
npm --prefix hcmtrail-native run test:routes   # sáu chiều, thiếu thanh khoản, hủy và hoàn
npm run pool:eth:legacy                        # preview 4184; build WASM trước để rút
```

[Cách rút liên mạng và chạy test proof thật](hcmtrail-native/docs/ETH-CLEARING.md) · [Dựng WASM và mở khóa note](hcmtrail-native/docs/ETH-POOL.md) · [Staking](hcmtrail-native/docs/ETH-FEE-STAKING.md).
