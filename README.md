# hcmtrail · ETH Vault V3 và HCFR v2

**[Toàn bộ link mã hợp đồng hiện hành](hcmtrail-native/docs/CONTRACTS.md)** — tách mã vault lab và mã FRI nghiên cứu hướng hậu lượng tử. HCFR v2 chưa chứng minh quyền chi note và không được nối vào vault.

**ETH vào, ETH ra.** Ethereum, Base và Arbitrum One chạy cùng mã hợp đồng, với số dư và cây note riêng. Có thể rút trên mạng đã nạp hoặc dùng một trong **sáu chiều rút liên mạng**. Mạng đích trả từ ETH thanh khoản có sẵn, không lấy ETH bảo chứng note của người khác. Chỉ truyền thông điệp xác thực, không chuyển ETH gốc qua các mạng, không có oracle.

**Phí 0,09% khi nạp và 0,09% khi rút**, làm tròn xuống theo wei. Phí vào staking của mạng nạp hoặc chi trả. Trên Ethereum lab, thưởng ETH mỗi kỳ **30 ngày** chia theo tỷ lệ **HCMT đang stake**. [`HcmtToken`](hcmtrail-native/contracts/ethereum/HcmtToken.sol) cấp cố định **100.000 HCMT** ngay khi tạo hợp đồng, không có quyền mint thêm. Base và Arbitrum lab dùng LAB để thử quỹ phí riêng, không phát hành thêm HCMT.

> **Chỉ lab, không dùng tiền thật.** Ba EVM local mô phỏng kênh thông điệp. Verifier STARK hiện tại chưa đạt điều kiện phát hành công khai.

```sh
npm ci --ignore-scripts
npm --prefix hcmtrail-native ci --ignore-scripts
npm test
npm --prefix hcmtrail-native run test:routes   # sáu chiều, thiếu thanh khoản, hủy và hoàn
npm run pool:eth:legacy                        # preview 4184; build WASM trước để rút
```

[Cách rút liên mạng và chạy test proof thật](hcmtrail-native/docs/ETH-CLEARING.md) · [Dựng WASM và mở khóa note](hcmtrail-native/docs/ETH-POOL.md) · [Staking](hcmtrail-native/docs/ETH-FEE-STAKING.md).
