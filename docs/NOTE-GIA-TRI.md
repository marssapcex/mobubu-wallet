# Lưu trữ: note giá trị tùy chọn và mô phỏng đổi tài sản v3

**Đã thay luồng nạp/rút mặc định bằng [vault ETH SLH-DSA](../PROTOCOL_DESIGN.md).** Note v3 và simulator dưới đây chỉ còn trong [archive](../legacy/groth16/README.md); không tương thích với vault mới.

**Không nạp tiền thật.** Đây là hai môi trường thử dùng cùng mạch v3: vault ETH native trên EVM local, và mô phỏng đổi **BTC, ETH, BNB native** trên [10 sổ theo mạng](SWAP-10-MANG.md) trong RAM. Có **90 tuyến liên mạng**, gồm cả ETH→ETH khác mạng; cùng ID là rút/chuyển note ngang giá. **Không thể chuyển note giữa hai môi trường.** Mô phỏng không phải bridge, không ký hay phát giao dịch thật, và không nối với engine streaming hoặc FHE.

**Vault v3 không chống lượng tử:** Groth16/BN254 là điều kiện cấp quyền chi của riêng ABI cũ. Xem [nghiên cứu lịch sử về nạp/rút riêng tư](RIENG-TU-HAU-LUONG-TU.md).

## Chạy lại simulator lưu trữ

```bash
npm ci
npm --prefix legacy/groth16 ci
npm --prefix legacy/groth16 run demo:notes
npm --prefix legacy/groth16 run demo:notes -- BTC ETH@optimism 0.02 0.1
npm --prefix legacy/groth16 run demo:notes -- BNB BNB 0.123456789123456789 0.000000000000000001
npm --prefix legacy/groth16 run demo:notes -- ETH@base ETH@arbitrum-one 0.2 0.1
npm --prefix legacy/groth16 run demo:notes -- --note ETH@base ETH@optimism 0.2 0.01
npm --prefix legacy/groth16 test
```

Đối số là `assetNạp assetNhận sốNạp sốMuốnNhận`, dùng dấu `.` cho phần thập phân. [Danh mục](../legacy/groth16/src/network-catalog.mjs) yêu cầu `COIN@network` trong ledger; CLI vẫn nhận ký hiệu ngắn cho BTC trên Bitcoin (8 chữ số), ETH trên Ethereum mainnet (18) và BNB trên BSC (18). WBTC, WETH, WBNB, BTCB và các token khác đều bị từ chối. Ví dụ nạp `0.731234567891234567 ETH`, yêu cầu `0.01000003 BTC`: thanh khoản mẫu tính cần trừ `0.200642596235379323 ETH` và còn `0.530591971655855244 ETH` trong note mới. **Đây không phải giá thị trường.** Khi yêu cầu nhiều hơn note có thể chi, từ chối; không tiêu note để rồi mới báo thiếu. Lần đầu chạy tạo artifacts Groth16 dùng một lần khoảng 3 phút trong thư mục build đã ignore.

## Note v3: chứng minh giá trị, không chỉ chứng minh có note

- SDK tạo hai bí mật và khóa note `key = Poseidon(4)(3, domain, nullifier, secret)`. Ledger lấy **số base unit thực nhận** để đưa `Poseidon(2)(key, received)` vào cây. Không chấp nhận commitment hoàn chỉnh do người nạp tùy khai kèm số tiền khác. `domain` phân tách vault/deployment; mô phỏng phân tách theo phiên, mạng và tài sản nguồn.
- [Mạch `spendNote`](../legacy/groth16/circuits/spendNote.circom) kiểm membership, một nullifier duy nhất theo note, và `giá trị note = số trừ + tiền thừa`. Số trừ dương và mỗi giá trị nằm trong 128 bit, nên phép trừ không thể lợi dụng wraparound của trường BN254. Note cũ bị tiêu toàn bộ; nếu còn tiền thì tạo **một note mới cùng tài sản nguồn**, với bí mật mới. Rút hết thì không tạo leaf tiền thừa.
- Public statement theo thứ tự: `[root, nullifierHash, payoutBinding, amount, changeCommitment, domain]`. [Vault EVM v3](../legacy/groth16/contracts/ValueNoteVault.sol) tự gắn `payoutBinding` vào địa chỉ nhận; mô phỏng tự tính hash của tuyến (gồm mạng đích), số trừ/nhận, `oracleId`, deadline và địa chỉ mock hoặc note key nhận. Đổi đích/mạng, sửa số chi hoặc sửa leaf tiền thừa làm proof không còn hợp lệ. Không dùng public signals do người gửi tự khai để ra quyết định.
- SDK dành cho local: giữ note và change note an toàn trước khi gửi lệnh; mất bí mật thì mất quyền chi note. Chỉ ghi nhận thay đổi sau giao dịch thành công. Vault v3 dùng ABI và artifacts **khác** vault v2; không có migration note/circuit hoặc Rust wire v3. Verifier Rust hiện kiểm chéo v2.

## Tỷ giá và quy tắc làm tròn trong mô phỏng

[MockNoteMarket](../legacy/groth16/packages/sim/src/note-market.mjs) có một pool `asset/hub` cho mỗi ID native. Cùng ID thì trừ và trả ngang số base unit, không qua pool. Khác mạng thì quote qua hai pool dù cùng ký hiệu ETH. [Oracle](SWAP-10-MANG.md) so giá của quote với tham chiếu USD, không dùng giá do người rút tự gõ. Tất cả phép toán dùng `BigInt`, không ép về 8 chữ số chung.

Với reserve vào `X`, reserve ra `Y`, mỗi leg có:

- **Chọn số trừ:** `out = floor(Y × in / (X + in))`. Lượng ra phải đạt ít nhất một base unit đích.
- **Chọn số nhận:** `requiredIn = ceil(X × out / (Y − out))`, với `0 < out < Y`. Tính ngược hai leg và phí để khóa đúng tổng số phải trừ. Fee trên hub làm tròn lên, không chi thêm cho người rút vì số làm tròn.

Hai cách đều giữ `k = X × Y` của từng pool không giảm. Không so sánh số danh nghĩa giữa hai coin; **proof giới hạn số tài sản nguồn bị trừ**, còn pool giới hạn số tài sản đích được trả theo quote. Không đủ note hoặc thanh khoản thì không đổi state. Địa chỉ mock không có giá trị trên chain thật.

Quote có hạn tối đa 5 phút hoặc đến khi snapshot hết hạn, tùy mốc nào đến trước. Khi thay snapshot hoặc reserves đã đổi, phải tạo lại quote. Ledger kiểm lại root, nullifier, giá, oracle và deadline sau khi đợi verifier rồi mới commit debit, tiền thừa, reserves và đích nhận trong RAM.

`--note` minh họa cơ chế nhận bằng note key một lần. Bên nhận tự tạo và giữ note riêng ở domain đích, gửi key nhận qua kênh riêng cho bên gửi. Key không phải cam kết của người gửi về số tiền; đối chiếu số base unit thực nhận với số mong muốn và lưu note theo số thực nhận. Lúc commit, thay vì tạo payout ra địa chỉ, ledger ghi note đích theo số tiền từ quote. Bên nhận sau đó dùng proof để chi note. Đây không phải giao dịch ẩn danh on-chain; coordinator vẫn thấy metadata, và phiên demo không lưu note sau khi thoát.

## Điều gì còn thiếu?

- **Tham chiếu không phải giá thực thi.** Demo dùng oracle và reserve mẫu; có trình đọc Chainlink riêng, không có giữ thanh khoản, giá thực thi, phí gas/bridge hay SLA trượt giá đã kiểm.
- **Không có custody liên chuỗi.** `creditConfirmed` là điểm tiêm receipt tin cậy chỉ dành cho test. Chưa có xác thực nạp/rút thật cho bất kỳ mạng nào, ký ngưỡng, lưu bền hay đối soát khi restart/reorg. `payoutId` chỉ là ID mô phỏng, không phải tx hash thật.
- **Không cam kết ẩn danh.** Trên vault EVM local, người quan sát vẫn thấy số tiền nạp/rút, địa chỉ, thời điểm và leaf tiền thừa. Mệnh giá tùy chọn giúp linh hoạt nhưng số lẻ đặc biệt có thể dễ tương quan hơn. Tạo Groth16 proof đúng không thay cho ceremony đa bên hoặc audit độc lập.
