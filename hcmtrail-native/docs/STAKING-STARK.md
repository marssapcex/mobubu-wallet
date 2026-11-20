# HCMT staking · quyền rút gốc và thưởng bằng STARK

**Testnet-only, chưa audit, chưa deploy công khai.** `dao-deploy` hiện dùng profile `stake-stark-v1`. Đây là treasury mới bất biến; manifest, vị thế và genesis của bản cũ **không được chuyển tự động**. Nếu đã dùng bản cũ, quản lý vị thế cũ bằng đúng code/manifest của deployment đó. Không tạo một bộ HCMT mới trên cùng testnet rồi gọi cả hai là canonical.

## Ai có quyền làm gì?

| Thao tác | Quyền bắt buộc |
| --- | --- |
| `stake(amount, authRoot)` | Chủ balance HCMT approve rồi gửi tx khóa. Lần đầu cố định root của **credential STARK độc lập**; lần sau buộc dùng đúng root. |
| `requestUnstake` | Proof hợp lệ cho **đúng staker, số lượng, người nhận và kỳ kế tiếp**. Không cần chữ ký của staker để trả gas. Chỉ một unlock chờ tại một thời điểm. |
| `releaseStake(staker)` | Bất kỳ signer nào có thể gửi khi đến kỳ mở khóa. Đích và số lượng đã cố định bằng proof ở bước trên; không có tham số đổi đích. |
| `claim` | Proof hợp lệ cho **đúng staker, người nhận và danh sách kỳ**. Treasury tự tính số native theo checkpoint lịch sử; mỗi kỳ chỉ claim một lần. |
| `closePeriods` | Permissionless sau khi kỳ kết thúc. Không chuyển tiền hay cấp quyền đặc biệt cho caller. |

Khóa ví cổ điển vẫn cần để gửi HCMT **chưa khóa** và trả gas. Nhưng sau khi stake, chỉ có khóa gas **không** đủ để tự chọn đích hoặc lấy HCMT/thưởng. Sau lần stake đầu đã xác nhận đúng root, chủ credential có thể tạo proof chi tới một địa chỉ an toàn khác và nhờ signer khác gửi. Không chia sẻ secret, không dùng `stake-key-new` để “reset” một vị thế đã khóa: **mất credential có thể mất cả gốc và thưởng**, không có khóa admin/recovery. Số stake, kỳ, giao dịch và địa chỉ nhận là công khai; proof không biến staking thành ẩn danh.

## Thiết kế và tái sử dụng verifier

1. Ví tạo opening ngẫu nhiên bằng CSPRNG, dùng Poseidon như note vault nhưng với asset tag riêng `0x48434d5453544b31` (`HCMTSTK1`) và giá trị *tổng hợp* `2`. Hai lá gồm domain credential (chain ID, treasury, staker) và note tổng hợp ở index 1. Root public được lưu lần stake đầu. Hợp đồng kiểm root không zero, đúng miền Goldilocks và không thay đổi về sau; **root do người stake tự chọn**, không tự chứng minh đã backup/biết opening tại lúc khóa. Trước khi stake, đối chiếu `staker`, `treasury`, `chainId` và root từ **đúng** máy đã lưu bản sao credential. Không stake với root chép từ người khác hoặc không tự kiểm được.
2. Cùng mạch **NotBefore 37-limb, DEEP-FRI format 7** đã pin của native vault. Hai public amount *tổng hợp* cố định `1 + 1`, clearing price `0`, cùng root cho pool/association. Do quan hệ bảo toàn số nguyên của mạch, ít nhất một input live phải mở được trong root. Ví dùng một credential và một dummy giá trị 0. Đây **không phải tài sản/tỷ giá**: gate không chi hai đơn vị đó và không ghi output thành tiền/note rút được.
3. Treasury tự băm `abi.encode(domain, chainId, treasury, staker, nonce, actionHash)`. `actionHash` có tag riêng cho unstake hoặc claim, buộc *toàn bộ* trường của hành động. Cả 256 bit challenge đi vào hai slot địa chỉ public, mỗi slot mang 128 bit và một bit marker để không zero; **không cắt hash xuống một địa chỉ 160-bit**. Hai slot đó chỉ mang dữ liệu, không phải đích thanh toán. `notBefore` được proof ràng buộc và gate kiểm theo lưới 600 giây. Unstake còn từ chối khi kỳ kế tiếp đã thay đổi; không tự dời sang kỳ khác.
4. Credential dùng lại **để chứng minh quyền**, không tiêu thụ như note nhận tiền. Nonce từng staker chỉ tăng khi hành động thành công; proof cho chain/treasury/staker/nonce/hành động khác không được chấp nhận. Các nullifier tổng hợp có thể liên kết những proof của cùng credential; chúng không phải nullifier của fee vault. Claim còn kiểm `claimed[period][staker]`. Cả nonce, reserve, claim flags và payout rollback nếu thanh toán lỗi.
5. Treasury tự tạo `HcmtStakeGate` trong constructor; không nhận verifier do caller cung cấp. Gate pin `Prepare`/`Walk`/evaluator chunks, dùng chung source verifier với vault nhưng có miền proof riêng. `inspect` kiểm runtime, constructor, image/params, liên kết gate và chunks qua receipt. Profile chỉ có trên bốn testnet đã ghi; không có mock/fake-verifier fallback trong hợp đồng triển khai.

### Giới hạn

- Mô hình này bảo vệ **quyền lấy tài sản đang khóa** nếu chỉ lộ khóa ECDSA, giả sử credential, thiết bị tạo proof và chain vẫn an toàn. Công bố proof là ủy quyền cho bất kỳ ai gửi **đúng** lệnh, không có nút thu hồi. Đừng tạo hai proof khác nhau cùng nonce khi chưa đối soát kết quả. Sau payout, tiền phụ thuộc vào bảo mật địa chỉ nhận.
- Không có claim hậu lượng tử end-to-end hay soát xét độc lập soundness của việc tái dùng mạch. Verifier tốn gas, proof cần RAM/thời gian. Rủi ro bug bất biến và mất liveness là thật. Đo EVM gas/Nile Energy & CPU, xác nhận HyperEVM large blocks trước testnet công khai. Không dùng tiền thật.
- Chính sách phí 0,25%, phân phối kỳ 30 ngày, cadence stake và bond 100 HCMT không đổi. STARK **không** nằm trên đường nội bộ thu phí hoặc đóng kỳ; chỉ xác thực hành động chi staking. Không cần dịch vụ tính toán bên ngoài hay oracle trong đường này.

## Vận hành thử

Dùng [TESTNET.md](TESTNET.md) và [HCMT-TESTNET.md](HCMT-TESTNET.md) cho RPC testnet, compiler, prover, ngân sách, signer gas và hàm shell `tn`. Không dùng state lẫn với deployment cũ. Tách thư mục state máy tạo proof với máy trả gas nếu muốn; chỉ copy manifest đã xác nhận và các dữ liệu công khai. File ngoài repo `0600`, thư mục `0700`. **Không nhập hoặc gửi key lên chat, RPC hay relay.**

```bash
# Ví dụ treasury mới: tn dao-deploy "$GENESIS_HOLDER" (chỉ khi đã duyệt deployment testnet)
# Trên máy giữ credential, không cần NATIVE_SIGNER_FILE để tạo key/proof:
KEY_INFO=$(tn stake-key-new "$STAKER")
AUTH_ROOT=$(jq -er .authRoot <<<"$KEY_INFO")
# Sao lưu file .privateFile dưới NATIVE_STATE_DIR một cách mã hóa, trước khi khóa.

# Với signer sở hữu HCMT:
tn stake lock-01 100000000000000000000 "$AUTH_ROOT"  # 100 HCMT (18 decimals)
tn dao-status "$STAKER"                          # đối chiếu authRoot; active từ kỳ kế tiếp

# Trên máy giữ credential: ủy quyền mở khóa 20 HCMT vào kỳ kế tiếp.
UNLOCK=$(tn unstake-proof "$STAKER" 20000000000000000000 "$SAFE_TO")
PERMIT="$NATIVE_STATE_DIR/$(jq -er .publicFile <<<"$UNLOCK")"
# Chỉ file public được phép chuyển cho signer gas, không chuyển credential.
```

Máy tạo proof chỉ gửi các lệnh đọc public state qua RPC, chạy prover trên máy riêng. Trên máy signer gas, trỏ `PERMIT` đến file `stake-proof-*.json` public đã nhận, dùng cùng manifest:

```bash
tn stake-check "$PERMIT"             # simulation, kiểm budget; không ký
tn stake-submit "$PERMIT"            # xác nhận receipt; retry cùng file/state khi chưa rõ
# Sau khi kỳ mở khóa bắt đầu (xem unlockPeriod):
tn release release-01 "$STAKER"       # bất kỳ signer nào, không chọn lại SAFE_TO
```

Nhận thưởng tương tự: khi kỳ 2 đã kết thúc, signer bất kỳ `tn close close-01 2`, kiểm `tn dao-status "$STAKER" 2`. Máy giữ credential chạy `tn claim-proof "$STAKER" "$SAFE_TO" 2` (hoặc danh sách `2,3` đã đóng). `stake-submit` với file public mới chi đúng đích; không dùng lại file unlock. Nếu receipt chưa rõ, đối soát `authNonce`, `unlockRecipient`, `claimed`/status và journal trước khi tạo proof khác. Nếu đến ranh giới kỳ trong lúc chứng minh unstake và chưa có tx thành công, tạo proof mới cho kỳ mới sau khi đối soát; không sửa trường trong file proof.

## Kiểm thử tái lập

```bash
npm ci --ignore-scripts
npm run build:dao
npm run build:dao -- --tvm  # TRON_SOLC chính thức đã pin
npm run test:dao
npm run test:stake         # EDR/TVMJS, vector STARK thật gắn đúng fixture; không cần Rust
# Prover pin theo TESTNET.md, chạy một proof mỗi lần, không dùng public RPC:
npm run test:stake:fresh
```

Các vector trong `test/vectors/stake/` **chỉ dùng fixture**, không dùng key hoặc root của chúng trên mạng thật. Tests kiểm quyền độc lập signer, khóa số lượng/kỳ/đích, proof sai domain hoặc nonce, release sớm, stake lịch sử, claim nhiều kỳ, chống claim lại và rollback khi người nhận native từ chối. Có quy trình tạo lại vector trong README của thư mục đó. Đơn vị VM không thay được receipt, phí hoặc finality live.

### Kết quả cục bộ của profile này

Sinh mới **5 proof** và gửi qua treasury với stake/nạp phí trong VM, không dùng mock verifier. `test:stake:fresh` và `test:stake` đều **2/2** (Sepolia EDR, Nile TVMJS); proof hợp lệ chi đúng đích khi signer khác staker, proof sai bị từ chối. Khi người nhận native revert, nonce, reserve, hai reward records và cờ claim không đổi; retry cùng proof sau khi nhận được native thì thành công.

| Domain mô phỏng | Hành động | Proof (byte) | Sinh proof (giây, một mẫu) | Chi phí thực thi VM |
| --- | --- | ---: | ---: | ---: |
| Sepolia | Lên lịch mở khóa 20 HCMT | 96.104 | 239 | 3.851.147 gas |
| Sepolia | Claim hai kỳ | 95.144 | 294 | 3.852.352 gas |
| Sepolia | Staker thứ hai claim kỳ 2 | 95.912 | 148 | 3.849.678 gas |
| Nile | Lên lịch mở khóa 20 HCMT | 93.512 | 197 | 2.163.203 TVMJS |
| Nile | Claim hai kỳ | 94.504 | 159 | 2.158.612 TVMJS |

Bước `releaseStake` sau khi đến kỳ không chạy lại verifier: 77.218 gas ở EDR / 67.189 đơn vị TVMJS trong fixture này. Số đo không phải phí thật, SLA hay ước tính Energy của java-tron. Riêng chi phí proof staking EVM đo được đã vượt lane 3M gas; phải kiểm large-block trên HyperEVM trước khi thử live.

Build EVM/TVM và `test:dao` **7/7** kiểm chính sách/triển khai bốn chain; `test:testnet` **9/9**, `test:vault` **4/4**, `test:vault:tvm` **2/2**, oracle **9+1**. Build ID của cả bốn vault không phí và pin của verifier chung không đổi. `npm ci --ignore-scripts` và `npm audit --audit-level=moderate` cho bản standalone sạch chạy được (0 advisory dependency); không thay audit độc lập. Chưa có receipt public testnet.
