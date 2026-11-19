# Hồ sơ kiểm tra · ứng viên audit vault native testnet

**Phạm vi:** testnet-only, STARK local exit và CLI lưu/khôi phục note. Oracle, FHE và swap liên mạng nằm ngoài đường tiền. **Chưa có giao dịch hoặc deployment public trong hồ sơ này.** Địa chỉ, block và tx hash xuất hiện trong bằng chứng emulator **không** phải địa chỉ để nạp tiền hay link explorer. Dùng [runbook](TESTNET.md) để tạo deployment mới bằng coin faucet.

## Kết quả thực thi cục bộ

Linux x86-64, Node.js `v22.22.3`, GCC `12.2.0`. EDR `0.25.1` và TVMJS `1.2.0`; `solc 0.8.24+e11b9ed9` và `tron-solc 0.8.24+7d902c66` đã pin. Build `paris`, optimizer 200, bytecode hash metadata `none`. `test:testnet:fresh` tạo opening ngẫu nhiên, ký tx mới, nạp native thật **trong VM**, dựng cây từ receipt/log, sinh và tự xác minh proof trước khi gửi proof vào vault. Kiểm balance người nhận, số dư/accounted của vault, cả hai nullifier, replay on-chain bị chặn và khôi phục change từ log/receipt. Không có mock verifier trên đường này.

| Domain mô phỏng | Deploy vault (1 tx) | Nạp | Rút một phần | Proof / tx ký rút (byte) | Sinh proof (giây, một mẫu) |
| --- | ---: | ---: | ---: | ---: | ---: |
| Sepolia `11155111` (EDR gas) | 13.355.763 | 4.634.093 | 8.195.472 | 96.232 / 96.755 | 209 |
| BSC testnet `97` (EDR gas) | 13.355.729 | 4.634.093 | 8.191.057 | 95.048 / 95.568 | 285 |
| Nile `0xcd8690dc` (đơn vị thực thi TVMJS) | 12.468.165 | 4.420.498 | 6.325.711 | 96.168 / 96.801 | 328 |
| HyperEVM testnet `998` (EDR gas) | 13.355.759 | 4.634.081 | 8.194.502 | 96.040 / 96.561 | 220 |

Số đo là chi phí của giao dịch thành công, không phải gas estimate hay phí trên mạng công khai. Phần deploy trong bảng là **tx cuối cùng**, không gồm năm giao dịch triển khai verifier/chunk trước đó (tổng stack xấp xỉ 37,54M EVM gas / 34,69M đơn vị TVMJS, chia sáu tx). Runtime ba chunk là 24.330 / 24.511 / 23.975 byte; chunk lớn nhất sát cap EIP-170 24.576 byte. Hợp đồng cần một tx rút chứa cả proof; không chia proof thành nhiều tx hoặc hạ verifier để lách trần.

**4/4 domain pass** trên emulator. Ba domain EVM nạp `0,01` và rút `0,005` native coin; Nile nạp `2.000.000` và rút `1.000.000` sun. Sepolia còn **sinh proof thứ hai từ chính note change đã khôi phục**, trả nốt `0,005 ETH`; vault về `0` accounted và balance. Proof tiếp theo 95.400 byte, 189 giây; 8.183.783 gas. Các thời gian chỉ là mẫu ngẫu nhiên với hai binary đã pin, không phải benchmark chuẩn hoặc SLA.

### Hồi quy và tái lập

- `npm run build:testnet` và `-- --tvm`: pass, artifacts tách biệt. `npm run test:testnet` **9/9**: dựng stack trên bốn domain, kiểm local Poseidon/u64, chain/bytecode pin, khôi phục biên nhận khi mất phản hồi broadcast, thiếu log, proof từ domain cũ, TVM TAPOS/solidified và cờ HyperEVM large-block. Không chấp nhận log trống là nạp thành công.
- `npm run test:vault` 4/4 và `npm run test:vault:tvm` 2/2: bốn proof funded cũ vẫn trả đúng native; có test sai root/amount/recipient, replay, rollback khi payout lỗi. Các wrapper cũ là hồi quy, không deploy bằng CLI.
- Oracle hồi quy 9 EVM + 1 TVM, demo 12/12 chiều **báo giá**, FHE Solidity host fixture 7/7. Không biến những test này thành bằng chứng swap, KMS hoặc settlement live.
- `npm ci --ignore-scripts` và `npm audit --audit-level=moderate` trên bản source độc lập chạy được; 0 advisory dependency ở lần chạy này. Đây **không phải** audit mật mã, Solidity hay quy trình custody.
- `build-testnet-prover.sh` pin nguồn AGPL NotBefore prover và BLAKE3; cài lại từ source độc lập bằng cùng toolchain cho đúng SHA-256 của cả hai binary trong `prover.json`. `test:stark` replay verifier tham chiếu riêng **6/6**. Cùng input công khai nhưng entropy luôn mới; proof khác byte vẫn hợp lệ. Không dùng lại seed/khóa fixture hay receipt emulator lên testnet.

## Trước khi chốt hồ sơ live

| Rail | Cần operator thực hiện và ghi bằng chứng thực tế |
| --- | --- |
| Sepolia | Dựng đúng domain/code/pin, đo gas estimate, admission và receipt dưới cap gas/tx; nạp, rút/chi change và kiểm replay. |
| BSC testnet | Xác nhận RPC đọc historical state/log, kích thước tx và gas limit, receipt `status=1` đúng số native và độ sâu/finality đã chọn. |
| Nile | Xác nhận protobuf/TAPOS và raw proof được node nhận; đo Energy thực, Penalty, Bandwidth, `fee_limit`, CPU/out-of-time, receipt `walletsolidity`, đúng sun. TVMJS không chứng minh bất kỳ hạn mức live nào trong số này. |
| HyperEVM testnet | Xác nhận EOA vào large-block lane, RPC trả đúng gas cho big block và estimate hợp lệ; đo inclusion và tài nguyên của deploy/rút thật. EDR không phải sequencer HyperEVM. |

Trên từng rail lưu manifest, root/payout/nullifier, tx hash và block hash confirmed, balance người nhận trước/sau, bằng chứng change có thể chi tiếp và sai proof/replay bị từ chối. Không chia sẻ note secrets, prover output thô, signed journal, key file hay RPC token. [TESTNET.md](TESTNET.md) có các lệnh/kiểm và quy trình phục hồi. Nếu một rail không admit hoặc không cho mô phỏng, ghi blocker thay vì coi rail đó đã pass.

## Mục cần auditor xem kỹ

- Integer conservation/range, nullifier ổn định theo note/vị trí, zero-value dummy, 37 public limbs, DEPTH/empty nodes, pin prepare/walk/evaluator và domain ở leaf 0; liveness khi cây/roots tăng, proof size, backing và tính nguyên tử của payout.
- Quy trình restore, reorg và giao dịch chưa rõ kết quả; người dùng chịu trách nhiệm bảo mật máy, file opening và backup. RPC đáng tin để đọc deployment/state/receipt; không có light client. Cùng ID/address/state trên fork không thể phân biệt chỉ bằng domain.
- Mức soundness/chi phí prover thực tế và leakage (amount/recipient/timing/IP, private local disk, cạnh kênh); không có chứng nhận privacy/PQ, mainnet readiness, hoặc upgrade/emergency admin. *Ứng viên audit* nghĩa là code/params và evidence có thể review, không phải code đã audit.
