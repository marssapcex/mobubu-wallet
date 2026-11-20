# Rà soát profile rút native ETH / BNB / TRX / HYPE

**Phạm vi: tự rà soát mã và kiểm thử devnet; chưa audit độc lập, chưa có deployment công khai.** Không gửi coin thật. Không dùng kết quả Slither, oracle hoặc mô phỏng làm chứng nhận finality, thanh khoản thực, bảo mật tuyệt đối hay mức phí gas trên mạng.

## Ma trận kiểm thử

Nguồn/đích là bốn ledger test riêng: Sepolia (`11155111`), BSC Testnet (`97`), Nile (`3448148188`), HyperEVM Testnet (`998`). EVM chạy bằng EDR, TRON chạy bytecode compiler chính thức trong TVMJS và dùng transport TAPOS/protobuf nội bộ. Tất cả feed, key ký chứng thư, note và LP là fixture. Không dùng địa chỉ/khóa fixture để triển khai public.

| Nguồn ↓ / Đích → | ETH | BNB | TRX | HYPE |
| --- | --- | --- | --- | --- |
| ETH | Nội mạng | Quote | Quote | **Chi trả** |
| BNB | **Chi trả** | Nội mạng | Quote | Quote |
| TRX | Quote | **Chi trả** | Nội mạng | Quote |
| HYPE | Quote | Quote | **Chi trả** | Nội mạng |

- **Quote:** `test:crosschain:four` đối chiếu 36 phép quy đổi nguyên (3 mức debit × 12 cặp có hướng) giữa Solidity và phép tính BigInt độc lập. Đây không phải 36 lần chi tiền. Dòng cùng mạng không quy đổi USD.
- **Chi trả:** note được nạp native, LP đích nạp và reserve native thật trong VM, nguồn tiêu thụ proof STARK thật, đích kiểm chứng thư log từ nguồn và chuyển native, nguồn chỉ credit đúng LP sau log `Paid`. `test:crosschain` giữ bài kiểm tra chính xác **31,0939453125 HYPE** từ note **0,9975 ETH**. `test:crosschain:four` thêm HYPE → TRX, TRX → BNB, BNB → ETH; HYPE và TRX đều làm chân nguồn lẫn chân đích. Chỉ có bốn hướng quyết toán được chạy, không gọi các hướng chỉ báo giá là đã quyết toán.
- **Rút nội mạng:** bài kiểm ETH trong profile này chạy cả khi feed ETH offline; các bộ vault cũ kiểm STARK nội mạng trên EVM/TVM và giữ nguyên chính sách. Không tự import hoặc migrate note giữa profile.
- **Gas tách biệt:** receipt EVM kiểm `gasUsed × effectiveGasPrice` đúng delta ví tài trợ. Trong bài kiểm bốn coin, TVMJS chỉ mô phỏng trừ **1 sun/đơn vị VM** vào tài khoản gửi; mục đích là kiểm tách nguồn tiền, không dự báo giá Energy/Bandwidth, phí theo contract hoặc khả năng gửi trên Nile. HyperEVM phải bật Big Blocks cho proof nguồn, không hạ xuống small block nếu preflight không đạt.

## Kết quả chi trả kiểm bằng số dư

Bảng dùng các mức giá fixture cố định ở lúc khóa, không phải giá thị trường. Với các tuyến mới, HYPE = 80 USD, TRX = 0,35410123 USD, BNB = 600 USD, ETH = 2.500 USD.

| Tuyến | Debit từ note | Gross ở đích | Phí DAO ở đích | Người nhận |
| --- | ---: | ---: | ---: | ---: |
| ETH → HYPE | 0,9975 ETH | 31,171875 HYPE | 0,0779296875 HYPE | **31,0939453125 HYPE** |
| HYPE → TRX | 0,019826851852098149 HYPE | 4,479363 TRX | 0,011198 TRX | **4,468165 TRX** |
| TRX → BNB | 11,234569 TRX | 0,006630291169033116 BNB | 0,000016575727922582 BNB | **0,006613715441110534 BNB** |
| BNB → ETH | 0,997500000000000003 BNB | 0,2394 ETH | 0,0005985 ETH | **0,2388015 ETH** |

Case TRX nạp 16,123457 TRX, note 16,083149 TRX; sau debit còn 4,84858 TRX backing note change. Không dùng change hỗ trợ phí. Chứng thư cùng digest trên EVM/TVM với phép dựng EIP-712 độc lập trong test.

| Tuyến | Kích thước STARK nguồn | Khóa nguồn | Chi đích |
| --- | ---: | ---: | ---: |
| ETH → HYPE | 95.208 byte | khoảng 8,53M gas EDR | khoảng 176 nghìn gas EDR |
| HYPE → TRX | 95.624 byte | khoảng 8,54M gas EDR | 114.531 đơn vị VM |
| TRX → BNB | 95.208 byte | 6.594.048 đơn vị VM | khoảng 137 nghìn gas EDR |
| BNB → ETH | 95.688 byte | khoảng 8,55M gas EDR | khoảng 137 nghìn gas EDR |

Ba vector mới được sinh bằng prover pin, đã chạy với note funded và ghi lại theo SHA-256. Gas trên EDR có thể đổi nhẹ theo calldata và tx; bảng không gồm nạp/fund/reserve/complete và không suy ra chi phí RPC live. Runtime `CrosschainNoteVault`: 15.689 byte EVM, 16.564 byte TVM; `CrosschainLiquidity`: 7.732 / 8.139 byte tương ứng.

## Thay đổi sau rà soát

| Điểm cần siết | Cách xử lý và cách kiểm |
| --- | --- |
| Lệnh chỉ dùng hai giá mà trước đây phụ thuộc keeper và bốn feed | `currentPair` đọc hai round mới nhất trong cùng lần thực thi, dùng lại các chốt về decimals, biên giá, độ mới, timestamp và sequencer. ID buộc cặp có thứ tự + domain + hai round. Test có feed không liên quan offline và không hề `refresh()`; feed đã đổi làm quote mới đổi trực tiếp. Lab `activeEpoch` vẫn chạy quy tắc cũ. |
| Deployer có thể nhầm implementation oracle/quorum | Vault pin runtime oracle/quorum EVM/TVM và cả stack verifier; liquidity cũng kiểm quorum. Pin code được sinh lại từ compiler, kiểm đủ mọi immutable offset. Sau pin còn đối chiếu domain và cấu hình constructor (chain, policy feed, phí lab = 0, và ba witness có thứ tự). Không nâng cấp proxy cho oracle/quorum trong profile này. Đây **không** phải phê duyệt một bộ feed hoặc witness live. |
| Sai chứng thư, lệch đồng hồ giữa hai mạng | Từ chối chứng thư sai hoặc ABI lỗi thành `UnverifiedEvent`. Chữ ký buộc chain, emitter, kind, order, dữ liệu, block/tx/log và consumer. Refund cần **cả** `payBy` trên nguồn lẫn log `Cancelled` hợp lệ từ đích. Test cho đích chạm hạn trước; nguồn không hoàn sớm và không hoàn chỉ vì timeout. |
| Chi và credit không được lấn backing note | Nguồn đối soát `balance >= note + escrow + credit`; đích `balance >= free + reserved` trước reserve/chi/rút LP. Test kiểm bằng số dư sau từng pha, cả note change khi debit một phần TRX. LP không rút khoản reserve hoặc credit chưa phát sinh. |

## Các bất biến chính

- **Quyền chi:** STARK 37 public limbs buộc root, cùng hai nullifier cho mọi kiểu rút, output change và toàn bộ hash lệnh. Chứng thư không thay STARK, không chi note chưa có quyền. Proof chốt các giới hạn, không chốt giá cũ; chỉ lấy `rateHash` sau giao dịch khóa. Lệnh sửa đích, proof nội mạng phát lại sau khóa và proof cross-chain diễn giải thành lệnh nội mạng đều bị từ chối.
- **Kế toán nguồn:** `deposit` cộng net sau phí; `lock` chuyển đúng debit từ note sang escrow; `complete` chuyển escrow sang credit LP; `refund` chuyển escrow về note mới, không thu thêm phí. Nullifier không được xóa. Lock giữ thêm một chỗ cho lá hoàn; hoàn/complete giải phóng đúng một chỗ. Không có đường admin sweep.
- **Kế toán đích:** `reserve` chuyển cap từ free sang reserved. `pay` dùng gross ≤ cap, trả đúng `gross − floor(gross/400)` và `floor(gross/400)` trong một tx, đưa phần thừa về free. `cancel` chỉ khi chưa chi và trả nguyên cap về free. Không chi hai lần; test revert nhận tiền và retry không làm mất reserve/phí.
- **Số nguyên:** debit note < `2^64`, mỗi USD18 < `2^80`, `units` ≤ `10^18 < 2^60`, BPS < `2^14`. Tử số `NativeAssets.convert()` cho rail này < `2^218`, mẫu số dương. Một phép floor quy đổi, một floor phí native; TRX chặn payout vượt int64 sun, EVM chặn vượt uint96, không dùng `Number` để tính tỷ giá. Không có phép tính phí nạp lần hai.
- **Khôi phục:** mở note hoàn được sao lưu cục bộ trước khi dùng proof; change có giá trị được sao lưu trước khi giao proof cho sponsor. Test sinh mới một phần TRX kiểm opening dẫn ra đúng commitment. Không ghi opening vào fixture public.

## Phân tích tĩnh và phân loại cảnh báo

Slither **0.11.5**, native solc **0.8.24**, Paris/optimizer 200/metadata hash none. Ba lần phân tích các entry point dưới đây; kết quả trùng giữa các lần (do import chung), loại báo cáo chỉ nằm trong `vendor`, `vault`, `dao`. Không dùng bộ đếm như thước đo mức an toàn.

| Entry point | High | Medium | Low | Info |
| --- | ---: | ---: | ---: | ---: |
| `CrosschainNoteVault` | 0 | 8 | 17 | 3 |
| `CrosschainLiquidity` | 1 | 7 | 17 | 2 |
| `ReceiptQuorum` | 0 | 1 | 1 | 0 |

- **High `arbitrary-send-eth`:** native payout cố ý chuyển cho địa chỉ trong lệnh, không chỉ cho caller. Rà soát hai đường tới `_pay`: `withdrawLiquidity` trừ `freeLiquidity[msg.sender]` và kiểm cap/solvency; `pay` cần reserve đúng lệnh, rate trong cap, chứng thư buộc đúng nguồn/đích và chuyển terminal trước khi gọi người nhận. Các test từ chối rút LP của người khác, rút vào reserve, đổi người nhận/sai chứng thư và trả hai lần. Không coi đây là quyền rút công khai vô điều kiện; vẫn có rủi ro chi sai khi quorum ký gian như mục finality, không tắt cảnh báo.
- **Medium:** so sánh bằng ở oracle là sentinel (ID/clock rỗng), không là so sánh số dư dễ bị phá do donate. `newest` khởi đầu 0; mọi phần tử của `feeds` chỉ được đọc sau khi đã gán hoặc sau khi vòng lặp đủ bốn. Các giá trị trả về không dùng là kết quả enum dùng để kiểm supported-chain qua revert và trường Chainlink không dùng (`answeredInRound`, hoặc `startedAt` đối với price feed).
- **Low/Info:** thời gian là dữ liệu đầu vào cho freshness/deadline, không dùng làm entropy. Gọi theo vòng lặp bị chặn bởi 4 feed, 3 witness hoặc bảng offset cố định. Các nhánh có chuyển native đều giữ guard và cập nhật state trước payout; test receiver revert kiểm atomic rollback. Bảng offset assembly kiểm lại kích thước, vùng zero và không chồng từ output compiler. Cần audit độc lập cho logic dương tính, compiler pin và vendor STARK; Slither không chứng minh được các giả định đó.

Có thể chạy lại với binary solc 0.8.24 Linux x86-64 (`sha256:fb03a29a517452b9f12bcf459ef37d0a543765bb3bbc911e70a87d6a37c30d5f`) và Slither cài ngoài thư mục package, từ `hcmtrail-native/`:

```sh
for entry in CrosschainNoteVault CrosschainLiquidity ReceiptQuorum; do
  slither "contracts/crosschain/$entry.sol" --solc /path/to/solc-0.8.24 \
    --solc-args '--evm-version paris --optimize --optimize-runs 200 --metadata-hash none' \
    --filter-paths 'contracts/vendor|contracts/vault|contracts/dao' \
    --json "/tmp/slither-$entry.json" --fail-none
done
```

## Rào cản trước khi triển khai thật

1. **Finality là điều kiện chặn.** Quorum 2/3 có thể ký sai log nếu hai khóa thông đồng/bị chiếm; mất quorum có thể để escrow bị treo. Không có consensus proof, chống deep reorg, xoay witness, checkpoint hoặc policy xác minh deployment canonical cho vận hành public. Pin code chỉ chống nhầm runtime, không sửa mô hình tin cậy này.
2. **Oracle live và LP.** Cần chọn feed và policy cho từng chain có dữ liệu thật, xem xét heartbeat, skew, downtime, proxy upgrade, exposure, reserve và thanh khoản đủ. Đọc `currentPair` nghĩa là đúng round mà hai feed hiện trả về, không chứng minh dữ liệu phản ánh giá thị trường hay nguồn feed chống thao túng.
3. **VM không phải node mạng.** Cần xác nhận solid receipt và Java-Tron resource/CPU, cũng như HyperEVM size, Big Blocks, reorg và gas cap thực. Hai deadline không cho hoàn sớm nhưng phải vận hành với buffer clock/finality; khi mất relay hoặc chain đích có thể đợi vô hạn. Không tự động refund vì RPC im lặng.
4. **Bảo mật và riêng tư.** Cần audit độc lập Solidity lẫn soundness STARK, release manifest, chiến lược khôi phục và thử lỗi vận hành. Order/tuyến/lượng/người nhận vẫn công khai. Không quảng bá ẩn danh liên mạng, lệnh chuyển HCMT shard hay bảo đảm hậu lượng tử end-to-end.

## Chạy lại

```sh
npm ci --ignore-scripts
# Linux x86-64: build/pin compiler TRON theo docs/TESTNET.md
export TRON_SOLC=/path/to/pinned/tron-solc
npm run build:crosschain -- --check-config-pins
npm run build:crosschain
npm run build:crosschain -- --tvm
npm run test:crosschain
npm run test:crosschain:four
# Tùy chọn: prover đã pin (TESTNET.md), không dùng RPC public
NATIVE_CROSSCHAIN_VECTORS_DIR="$(mktemp -d)" npm run test:crosschain:four:fresh
```

Profile chỉ nhận artifact oracle/quorum từ `build/{evm,tvm}/crosschain/` (metadata hash `none`); không tráo oracle artifact của lệnh `npm run build` độc lập. Nếu cố ý đổi miền, note fixture hoặc bytecode làm đổi địa chỉ deploy TVM, cần sinh lại proof gắn các địa chỉ mới. Chỉ cài vector sau khi replay VM thành công; đọc thêm README bên cạnh các proof.
