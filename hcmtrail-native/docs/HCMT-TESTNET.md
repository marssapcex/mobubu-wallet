# HCMT · kho phí native, staking và broadcaster testnet

**Chỉ coin faucet, chưa audit, chưa deploy lên mạng công khai.** Đây là profile triển khai mới (`dao-deploy`), không nâng cấp vault cũ (`deploy`), không chuyển note giữa hai bản. Không có nhánh tiền mainnet trong profile này.

## Chính sách đã mã hóa

**Một chính sách quỹ, bốn kho độc lập.** Mỗi chain có một bộ deploy dự kiến: vault, treasury nhận đúng native coin của chain, HCMT địa phương. Không token hóa native asset, không swaps, FX, oracle, bridge hay staking liên chuỗi. Stake ở Sepolia chỉ kiếm ETH ở Sepolia; không kiếm BNB, TRX hoặc HYPE của kho khác.

| Mạng | Kho | HCMT genesis trên mạng | Đơn vị phí native |
| --- | --- | ---: | --- |
| Sepolia `11155111` | ETH | 250.000 | wei |
| BSC testnet `97` | BNB | 250.000 | wei |
| Nile `3448148188` | TRX | 250.000 | sun |
| HyperEVM testnet `998` | HYPE | 250.000 | wei |

**HCMT** có 18 chữ số thập phân trên cả bốn chain. Mỗi shard phát hành đúng một lần ở constructor vào `GENESIS_HOLDER` của deployment, không mint thêm, burn, owner, proxy, admin hay quyền upgrade. `totalSupply()` trả **250.000 HCMT địa phương**, không phải 1.000.000 ở từng chain. **1.000.000** là tổng nếu chọn đúng một deployment chuẩn trên mỗi mạng. Không có registry/bridge để cưỡng chế duy nhất liên chain; ai cũng có thể triển khai một bản sao không chính thức. Cần thống nhất địa chỉ genesis và danh sách manifest chuẩn trước khi faucet/niêm yết. Bản này là escrow và chia phí theo luật, **không** có biểu quyết thay đổi luật, chi quỹ tùy ý hoặc cứu tiền.

### Luồng tiền cùng chain

- `daoFee(x) = floor(x × 25 / 10.000) = floor(x / 400)`, trong đơn vị nhỏ nhất. Làm tròn xuống một lần; phí bằng 0 nếu dưới 400 wei/sun. Không thu định kỳ trên note, không thu phí vault khi nhận change. Ví không tự chia giao dịch để làm tròn.
- **Nạp:** gửi `gross` qua `deposit(ownerCommit)`. Treasury nhận `daoFee(gross)` trong cùng giao dịch, note và `accountedNative` chỉ tăng `gross − daoFee(gross)`. `Deposited.amount` là net, `DaoFeePaid(false,gross,fee)` cho biết khoản khấu trừ.
- **Rút:** `NativeExit.amount` là số gộp của khoản chi người nhận, trước phí DAO. Treasury nhận `daoFee(amount)`, người nhận được `amount − daoFee(amount)`; nếu chọn broadcaster, signer đó được `NativeExit.fee` **riêng**, không tính vào cơ sở phí DAO. Proof ràng buộc cả hai địa chỉ, `amount`, `fee`, root, nullifier và change. Quan hệ chứng minh vẫn là `inputs = amount + fee + change`; vault giảm `accountedNative` đúng `amount + fee` và kiểm cả backing thực. `Withdrawn.amount` là số net trả cho người nhận.
- Nullifier chỉ dùng một lần, cập nhật tree/accounting trước payout; bất kỳ chân thanh toán lỗi nào đều revert **cả** khoản thu DAO, payout, nullifier và change (không hoàn gas). Không đổi được người nhận bằng cách chỉnh proof/request. Không có refund/admin override. Chỉ gửi cho địa chỉ nhận native được.

Ví dụ nạp `0,001 ETH`: treasury nhận `0,0000025 ETH`, note có `0,0009975 ETH`. Rút gross `0,0004 ETH` qua broadcaster báo `0,00001 ETH`: treasury thêm `0,000001 ETH`, người nhận có `0,000399 ETH`, broadcaster có `0,00001 ETH` **trước khi trừ gas**, change `0,0005875 ETH`. Tự gửi cùng khoản gross thì không có khoản `0,00001 ETH`, nhưng người tự gửi chịu gas.

### Phân phối mỗi kỳ 30 ngày

Kỳ `1` bắt đầu lúc treasury deploy, mỗi kỳ đúng `30 days`, không theo ngày đầu tháng UTC. Kỳ của các chain có thể lệch nhau. `stake` và `requestUnstake` chỉ đổi trọng số từ **kỳ kế tiếp**; việc giải phóng HCMT cũng phải đợi đến kỳ đó. Mỗi địa chỉ giữ lịch sử checkpoint; đóng/claim không duyệt danh sách staker. Không gửi HCMT trực tiếp vào treasury: làm vậy không ghi nhận stake và không có đường trả lại. Dùng `stake` (approve đúng số rồi stake).

Mặc định testnet: **100% doanh thu được ghi nhận của kỳ + khoản chuyển tiếp**, không có APR cố định hay tỷ lệ 4,2%. Có thể nhận native donation qua `receive`; tiền cưỡng bức vào balance không đi qua `receive` không được phân bổ/sweep. Nếu không ai active, cả pot chuyển tiếp cho kỳ tiếp theo có stake. Ai cũng có thể `closePeriods(1..24)` sau khi kỳ kết thúc, theo thứ tự cũ → mới. Sau khi đóng, mỗi staker tự `claim` (tối đa 32 kỳ/lần), nhận `floor(pot × trọng số lịch sử / tổng trọng số lịch sử)` đúng một lần. Reward cũ vẫn claim được sau khi rời stake, không hết hạn. Phần lẻ chỉ nhập kỳ **đang mở** sau khi toàn bộ trọng số của kỳ cũ đã claim; chừng nào còn người chưa claim thì phần đó vẫn được giữ. Địa chỉ stake phải nhận được native; khôi phục claim không có quyền đổi địa chỉ payout.

### Broadcaster tối giản: quote và request JSON

Tham khảo [Railgun Community broadcaster example @ `ec49691`](https://github.com/Railgun-Community/ppoi-safe-broadcaster-example/tree/ec49691533b4edc2dafefbd8cdb5f611290b2115): ví tạo yêu cầu, broadcaster kiểm đích và thù lao, rồi dùng ví gas của mình để gửi. Không chép/chạy code upstream; không triển khai Waku, PPOI, đổi token, sàn quote tập trung, HTTP server công khai hoặc tài khoản lưu ký.

- Broadcaster phải giữ **ít nhất 100 HCMT đã active trong treasury của chính chain**, không chỉ có token trong ví. Vault bắt buộc `msg.sender == exit.feeRecipient`; cả điều kiện stake và mức phí được kiểm trên chain tại lúc rút. Kỳ đầu chưa có stake active. Nhiều broadcaster có thể báo giá; ví chọn một quote rồi mới tạo proof. Không có một nhà vận hành đặc quyền.
- **Giả định testnet, cần chốt trước khi deploy công khai:** hiểu `0,000,1` là **`0,0001`** coin. Khoảng bao gồm cả hai đầu: **`0,00001–0,0001`** cùng native coin (EVM `10000000000000–100000000000000` wei, Nile `10–100` sun). Thay chính sách cần code/deployment mới; không có setter.
- Quote là giá cố định của signer theo một domain, không ký và không phải cam kết liveness. Dùng kênh xác thực tin cậy, so địa chỉ/phí trước khi duyệt. `relay-export` chỉ đưa file proof + public exit, không đưa key, note, witness, input index hay change opening. Worker chỉ dựng lệnh `withdraw` không kèm value đến vault đã xác minh, kiểm đúng báo giá, chạy simulation rồi ghi bền vững giao dịch đã ký trước khi broadcast. Một signer riêng, một request chưa rõ kết quả tại một thời điểm. Không nhận calldata tùy ý.
- **Có thể không kinh tế:** 8–9 triệu gas EVM với cap `0,0001` đòi hỏi giá gas khoảng ≤ `0,01` gwei, thấp hơn nhiều điều kiện thông thường. Mặc định worker từ chối ký nếu `gasLimit × gasPrice > phí quote`; `NATIVE_RELAY_COST_CAP_BASE` là ngưỡng do operator chọn để thử trợ giá. Trên Nile, ngưỡng đó chỉ so **ước tính** sun burn thiếu Energy; Bandwidth, dynamic Energy, phí kích hoạt, tài nguyên bị dùng trước đó và lỗi tx vẫn có thể tốn phí. `NATIVE_TRON_FEE_LIMIT_SUN` là giới hạn Energy riêng, không phải tổng phí mạng. Kiểm cả Energy và Bandwidth trước thử, không coi relay có lãi hoặc bảo đảm được nhận vào block. Không nới cap hợp đồng vì gas đắt.
- Nếu chưa gửi proof, có thể chọn tự gửi bằng một proof với `fee=0`/fee recipient zero. Proof paid đã chia sẻ không có hạn cuối hoặc nút thu hồi trên chain. Nếu đổi broadcaster/tự gửi khi proof trước chưa rõ, trước hết đối soát receipt/nullifier; các proof dùng cùng note cạnh tranh và chỉ một có thể chi. `recover-exit` để nhận change của **proof thực sự được chấp nhận**, không xóa backup trước đó.

## Runbook

Dùng [TESTNET.md §1–2](TESTNET.md) để cài compiler/prover, thiết lập `tn`, chọn ngân sách và RPC testnet. HyperEVM cần `usingBigBlocks` cho **từng** signer (kể cả broadcaster); Nile cần TronWeb/TAPOS + solidified receipts và kiểm tài nguyên thật. Dùng state mới ngoài repo cho mỗi deployment, quyền `0700`, và file key chế độ `0600`. Giữ nguyên xác nhận và endpoint giao dịch khi recovery.

```bash
npm run build:dao
npm run build:dao -- --tvm       # TRON_SOLC đã pin
npm run test:dao                # EDR + TVMJS; không dùng RPC công khai
NATIVE_TESTNET_ASSETS=ETH npm run test:dao:fresh  # STARK mới; bỏ biến để chạy 4 mạng, chạy tuần tự

# Chỉ thực hiện khối dưới nếu bạn CHỦ ĐỘNG thử trên testnet sau khi duyệt genesis/cap.
# Hai biến địa chỉ là địa chỉ TESTNET đã chọn; holder không nhất thiết là deployer.
tn dao-deploy "$GENESIS_HOLDER"  # 8 tx: token, treasury và stack 6 tx; giữ manifest.json đã xác nhận
tn inspect
```

Nạp/rút trực tiếp, ví dụ trên Sepolia (`ASSET=ETH`, biến `TO` là địa chỉ testnet mong muốn):

```bash
NOTE=$(tn note-new 1000000000000000 | jq -er .note)
# Sao lưu note-$NOTE.json RIÊNG và manifest trước khi nạp.
tn deposit "$NOTE"
EXIT=$(tn prove "$NOTE" 400000000000000 "$TO" | jq -er .exitId)
# Sao lưu cả change opening lẫn plan trong state. Không gửi các file này lên RPC/broadcaster.
tn preflight "$EXIT"
tn withdraw "$EXIT"
tn recover-exit "$EXIT"
```

Stake và claim: dùng signer nắm HCMT cho bước stake/claim, genesis holder cho bước phát hành phân bổ bằng transfer. Các `OP_ID` dưới đây là ví dụ; dùng ID mới cho operation mới, giữ **cùng** ID và tham số để retry operation cũ.

```bash
tn hcmt-transfer fund-relay-01 "$BROADCASTER_ADDRESS" 100000000000000000000
# Đổi sang signer broadcaster (hoặc dùng ví testnet của broadcaster) để khóa 100 HCMT của nó:
tn stake stake-100-01 100000000000000000000
tn dao-status "$BROADCASTER_ADDRESS"        # active từ kỳ 2 nếu stake trong kỳ 1
# Khi cả kỳ 1 và kỳ 2 đã kết thúc (không giả thời gian trên testnet thật):
tn close end-01-02 2                         # signer bất kỳ có gas
tn dao-status "$BROADCASTER_ADDRESS" 2
tn claim reward-02 2                        # signer của stake; xem claimableNative trước
tn unstake scheduled-off-01 100000000000000000000
# Khi kỳ kế tiếp bắt đầu:
tn release stake-release-01
```

Để thử riêng nhánh relay, stake và đợi active **trước** khi yêu cầu rút; không dùng lại một note đã rút. Trên máy broadcaster, import duy nhất manifest `0600` của deployment đã đối chiếu vào `NATIVE_RELAY_STATE_DIR` bên ngoài repo, và cấu hình `NATIVE_RELAY_SIGNER_FILE` là key gas cục bộ của broadcaster. Không dùng đồng thời signer đó trong tiến trình/thư mục khác. Ví dụ trên EVM (Nile thay `PRICE=10`):

```bash
umask 077
PRICE=10000000000000
tn relay-quote "$PRICE" > "$HOME/hcmt-quote.json"
# Chuyển chỉ quote JSON cho ví qua kênh tin cậy.

# Phía ví đã kiểm quote, có NOTE mới funded và TO do người dùng chọn:
EXIT=$(tn prove "$NOTE" 400000000000000 "$TO" "$HOME/hcmt-quote.json" | jq -er .exitId)
tn relay-export "$EXIT" > "$HOME/hcmt-request.json"
# Sau khi đã backup change cục bộ, chuyển chỉ request JSON cho broadcaster.

# Phía broadcaster:
tn relay-check "$PRICE" "$HOME/hcmt-request.json"     # simulation, không ký
tn relay-submit "$PRICE" "$HOME/hcmt-request.json"   # trả receipt và hash nếu xác nhận
# Phía ví:
tn recover-exit "$EXIT" "$TX_ID_FROM_CONFIRMED_RECEIPT"
```

Nếu báo pending/timeout, tra ID trong journal và đợi chính receipt đó; retry cùng request/giá/signer/state. Không tự dùng một nonce hoặc TAPOS mới hay xóa khóa/journal để gửi job khác. Nếu expiry, fail, reorg hoặc bị cạnh tranh bằng proof khác, xem [quy trình recovery](TESTNET.md#4-khôi-phục-và-lấy-bằng-chứng-audit) và đối chiếu với node tin cậy trước lần thử khác. Không dùng dấu phẩy hoặc chữ số thập phân trong tham số base-unit.

## Bảo mật và giới hạn

- Treasury và HCMT công khai toàn bộ balance, stake, lịch sử và claim. Broadcaster **thấy** nội dung public exit, gồm địa chỉ, amount, phí, thời điểm/metadata kết nối. Nó không cần opening, private signer key của người dùng, hay quyền đổi người nhận. STARK che note đầu vào được chọn và opening; không bảo đảm không thể liên kết giao dịch.
- Không có chữ ký admin, upgrade key hay oracle trong đường custody. Tuy vậy, **không thể gọi cả hệ thống là hậu lượng tử**: account, giao dịch gas, token/stake/claim, mạng và ví hiện dùng secp256k1/ECDSA; các tham số hash/STARK và verifier chưa audit độc lập. Mất khóa HCMT hoặc lộ opening note không có phương án cứu.
- Chỉ xác thực từ một manifest đúng nguồn. `inspect` kiểm chain, bytecode, immutable links, source build ID, constructor input và receipts đã xác nhận. Một contract báo đúng symbol không chứng minh là HCMT chuẩn. Runtime hash một mình không chứng minh constructor/genesis state; cần kiểm provenance và chốt danh sách deployment.
- Bản này chỉ xác minh trong VM. Phải duyệt chính sách (khớp cap gốc, holder, phân bổ/kỳ/thời gian khóa), audit contract, prover/verifier, rồi lấy receipt live cho đủ bốn mạng trước bất kỳ tuyên bố sẵn sàng nào. Đặc biệt kiểm CPU/Energy/Bandwidth/byte admission Nile và large-block của HyperEVM. Không dùng tiền thật.
