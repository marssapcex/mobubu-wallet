# Relayer HCMT · Ethereum lab

Relayer gửi giao dịch chi trả bằng gas của nó. Mô hình API lấy cảm hứng từ [tornado-relayer](https://github.com/tornadocash/tornado-relayer); không dùng mã, oracle, ví hay contract của repo đó. **Chỉ EVM lab (`31337`).** Không có RPC công khai, deployment mainnet, hay lời hứa lợi nhuận.

## Điều kiện và tiền thưởng

- Ví giao dịch của relayer phải có **ít nhất 100 HCMT đang stake có hiệu lực** trong [EthFeeStaking](../contracts/ethereum/EthFeeStaking.sol) của đúng pool. Giữ trong ví, gửi token trực tiếp, hoặc stake mới đang chờ đầu kỳ không tính. Thêm/rút stake áp dụng tại biên kỳ 30 ngày như staking thường. Worker kiểm tra khi khởi động và trước mỗi giao dịch; hợp đồng kiểm tra lại khi ghi thưởng. Base và Arbitrum dùng LAB thử và không có thưởng relayer tại hai VM đó.
- **Phí người dùng luôn `floor(gross × 9 / 10.000)` wei cho nạp hoặc rút cùng một `gross`.** Khi nạp rồi rút hết note, `gross` ở lần rút nhỏ hơn vì note đã trừ phí nạp, nên hai số phí tuyệt đối có thể khác. Với lô, mỗi lượt là một lần rút và làm tròn riêng, không làm tròn sau khi gộp tổng. Gas không phải phí vault. Khi dùng relayer, **không thu thêm phí, không đổi net**.
- Mỗi lần chi thành công (`withdraw`, `claimAcross` hoặc cả `executeBatch`), relayer đạt điều kiện nhận `min(floor(phí rút / 2), 0,003 ETH)`. Phần còn lại vào quỹ ETH chia sau kỳ 30 ngày. Nạp, giữ chỗ, truyền thông điệp, hủy, hoàn note và giao dịch revert không ghi thưởng relayer. Nếu người gửi không đủ stake, toàn bộ phí rút vào quỹ 30 ngày. Payout liên mạng tính điều kiện tại **nơi chi trả**.
- Khoản relayer được ghi vào `relayCredit(executor)` và nhận bằng `claimRelayReward(to)`, riêng với `claim(to)` của staking 30 ngày. Chỉ pool tạo staking mới được ghi khoản này; địa chỉ nhận credit là người thật sự gửi giao dịch chi, không phải tham số tùy chọn. Không gọi vào ví relayer lúc đang chi cho người dùng. Worker có chế độ `minProfitWei` để bỏ qua lệnh khi thưởng không đủ trả gas dự kiến và biên lợi nhuận cấu hình. Đây không phải đảm bảo lãi: đặc biệt một lần xác minh STARK lẻ có thể tốn hơn trần thưởng.

## Bảo vệ người rút

Trình duyệt tính phí, xem trước địa chỉ nhận và tạo proof cục bộ. Relayer chỉ nhận `{chainId,pool,data,value}`: calldata công khai cho đúng deployment, `value = "0"`. Không chấp nhận khóa note, seed phrase, witness, địa chỉ thưởng hoặc giá phí tự khai. API không cho điều khiển signer, cấp quyền chi, nạp, khóa note hay giao dịch đến địa chỉ tùy ý.

Vault kiểm tra proof / lệnh đã xác thực và cố định người nhận, số tiền, miền mạng, phí và thông tin hoàn theo từng chế độ. Đổi địa chỉ, số tiền hay dữ liệu lệnh không tạo được payout hợp lệ. Ai khác gửi lại calldata hợp lệ vẫn chỉ trả đúng người nhận; chi thành công chỉ một lần. Relayer có thể từ chối gửi, nhưng người dùng **không cần qua relayer** để chi trên vault. Không đưa khóa note cho bất kỳ dịch vụ nào; ai có khóa note có thể chi.

## Lô 10 ETH trước phí, 20 địa chỉ khác nhau

Vào **Rút thông minh**, mỗi lượt `0,5 ETH` trước phí và sĩ số `20`. Giữ đủ 20 lượt đã xác minh riêng, một `executeBatch` trả cả lô hoặc hoàn tác toàn bộ. Không tính phí khi giữ chỗ. Hợp đồng không cho hai lượt hoàn chỉnh trùng địa chỉ trong cùng lô. Nếu chọn một tổng trước phí làm đầu vào, [`quoteEqualBatch`](../pool/protocol.mjs) từ chối tổng không chia hết theo wei, không ưu tiên địa chỉ nào nhận wei dư.

| | Mỗi địa chỉ | Cả lô |
| --- | ---: | ---: |
| Trước phí | 0,5 ETH | 10 ETH |
| Phí | 0,00045 ETH | 0,009 ETH |
| Nhận | **499.550.000.000.000.000 wei** | **9,991 ETH** |

Nếu relayer đủ điều kiện, nó nhận đúng **0,003 ETH** tín dụng từ **0,009 ETH** phí của cả lô, còn **0,006 ETH** vào quỹ staking. Không ai bị trừ thêm, và trần không nhân 20. Lần chạy fixture dùng 912.467 gas cho giao dịch chi lô; 0,003 ETH khoảng 3,29 gwei/gas ở mức hòa vốn **chỉ cho giao dịch chi**, chưa tính proof giữ chỗ, vận hành hoặc chuyển tiếp liên mạng.

## Chạy và kiểm thử

```sh
npm ci --ignore-scripts
npm --prefix hcmtrail-native ci --ignore-scripts
npm run pool:eth:relayer:lab        # preview mới, cổng mặc định 4186
npm --prefix hcmtrail-native run test:relayer
# Sau khi dựng WASM theo ETH-POOL.md, chạy riêng:
npm --prefix hcmtrail-native run test:relayer:fresh
```

Chế độ preview dùng signer trong VM, chuyển sẵn 100 HCMT từ lượng đã phát hành và mô phỏng qua một biên kỳ **trước khi** mở HTTP. Không mint thêm và không có API tua thời gian. Mỗi lần dựng lab có trạng thái mới; không di trú note. `GET /api/ethereum/relayer` xem tình trạng stake, trần và credit. `POST /api/ethereum/relayer` với JSON chỉ nhận lệnh chi công khai, kiểm tra trước giao dịch, trả hash/khối/gas khi thành công. `/api/ethereum/tx` vẫn cho gửi rút trực tiếp; bỏ chọn **Gửi qua relayer HCMT** để dùng đường này trong preview. Keeper trả lô và relay trả tuyến đến L1 dùng worker nếu đang đủ stake; kênh truyền tin vẫn là mô phỏng. Không dùng note thật hoặc private key ví thật.

[`Relayer worker`](../pool/relayer.mjs) · [`Test lô 20 và giới hạn`](../test/eth-relayer.test.mjs) · [`Test Arbitrum → L1 với proof WASM`](../test/eth-relayer-fresh.test.mjs). Test lô dùng verifier fixture và đo 20 số dư ETH thực trong EVM; test WASM xác minh riêng một proof bằng verifier lab đã ghim, không phải 20 proof. [Điều kiện phát hành](ETH-POOL-STARK256.md) vẫn chặn vault công khai.
