# ETH ↔ BNB: kiểm biên nhận theo checkpoint (thử nghiệm)

**Chỉ kiểm lịch sử trong VM, không triển khai và không cấp quyền chi tiền.** Bước này tách **bằng chứng log nằm trong block** khỏi **quyết định block đã đạt finality**. Không còn chữ ký witness trong bằng chứng log mới; checkpoint vẫn là đầu vào tin cậy, bất biến sau khi deploy. Đây chưa phải bộ xác minh đồng thuận Ethereum Beacon Chain hoặc BNB Parlia, và chưa thay `ReceiptQuorum` trong profile rút tiền.

## Luồng xác minh

1. `EvmCheckpointReceiptVerifier` cố định hai chain testnet Sepolia (`11155111`) và BSC Testnet (`97`) theo chiều triển khai, genesis nguồn, số/hash checkpoint, địa chỉ contract phát log, contract gọi hàm kiểm và các loại log được phép. Không có owner, điểm cập nhật checkpoint hay đường fallback nhận chữ ký.
2. Relayer có thể chuyển một dãy execution header RLP từ checkpoint ngược đến block phát log. Verifier đối chiếu `keccak256` với checkpoint, rồi từng `parentHash` và số block giảm đúng một. Nó **lấy `receiptsRoot` từ chính header đã kiểm**, không nhận root do relayer tự khai.
3. Dưới root đó, `ExecutionReceiptTrie` kiểm Merkle Patricia Trie với khóa **`RLP(transactionIndex)`**, không băm khóa như storage trie. Nhánh, extension và leaf phải dẫn đúng đến receipt; không nhận node dư hoặc byte thừa. Receipt chuẩn có bloom 256 byte nên các node trên đường đều dài ≥ 32 byte và được tham chiếu bằng hash, không cần hỗ trợ inline node của generic state trie.
4. Kiểm receipt thành công, đúng emitter, đúng topic `SettlementMessage(uint8,bytes32,bytes32)`, kind/order/data. Chỉ số log là **vị trí trong receipt**, không phải `logIndex` toàn block của RPC. Adapter kiểm đúng chain và `msg.sender` trước khi xử lý proof. Một proof public có thể được kiểm lại; chống chi lặp là nghĩa vụ của state machine thanh toán, không phải side effect của hàm `view` này.

Đảm bảo có điều kiện: **nếu checkpoint thực sự finalized trên chain nguồn**, log được chứng minh thuộc block đó hoặc tổ tiên của nó. RLP execution header không mang chain ID hay quy tắc đồng thuận; pin genesis/chain ID không tự chứng minh mối liên hệ giữa một checkpoint tùy ý và genesis. Checkpoint sai lúc cấu hình sẽ làm mất giả định gốc. Không dùng độ sâu block, `latest`, hay RPC trả nhãn `finalized` làm bằng chứng đồng thuận. Trong test, chọn checkpoint từ VM chỉ để kiểm phần đường dẫn.

## Định dạng và giới hạn

| Trường | Encoding |
| --- | --- |
| Version, số header, số node MPT | 1 byte mỗi trường, version `1` |
| Chỉ số giao dịch | uint32 big-endian từ byte 3 |
| Chỉ số log trong receipt | uint16 big-endian từ byte 7, tối đa 255 |
| Header rồi node | Mỗi item `uint16 length` big-endian + bytes RLP; checkpoint trước, block đích chứng minh cuối; MPT root node trước |

Giới hạn test profile: 65.535 byte tổng, tối đa 33 header / 4.096 byte mỗi header, tối đa 11 trie node / 32.768 byte mỗi node. Đây là giới hạn thiết kế của adapter, không phải giới hạn của chain. Hỗ trợ execution header RLP 15–21 trường tiêu chuẩn và receipt trạng thái EIP-658 dạng legacy hoặc typed `1`–`4`. Khối có fork fields không hỗ trợ, receipt quá lớn hoặc log quá sâu bị từ chối. Không áp dụng cho TVM/TRX, HyperEVM hoặc chain mainnet. Không bao gồm chứng minh transaction hash (cần transaction trie riêng); receipt proof xác minh giao dịch theo vị trí trong `receiptsRoot`, không tin vào trường `transactionHash` do RPC thêm.

`testnet/receipt-proof.mjs` có `collectReceiptEvidence(rpc, {checkpointHash, blockHash, txIndex, logIndex})` và builder offline `checkpointReceiptEvidence({headers, blockReceipts, txIndex, logIndex})`. Không có RPC mặc định, không có signer, không tự chọn checkpoint. Builder đối chiếu lại `hash` của header và tái tạo trie từ mọi receipt trong block đích. RPC trả thiếu/sai sẽ không tạo ra proof hợp lệ cho checkpoint đúng. Không đưa note opening hay khóa vào file proof.

## Kiểm thử và chạy lại

```sh
npm ci --ignore-scripts
npm run build:receipt-proof
npm run test:receipt-proof
# Có TRON_SOLC đã pin để chạy cả ma trận gốc và đối chiếu log của lệnh BNB → ETH:
npm run test:crosschain:four
```

- Hai VM EDR độc lập tạo block có nhiều giao dịch, gồm receipt legacy/typed, giao dịch revert, và vị trí 127/128 qua ranh mã hóa RLP. Kiểm cả bốn loại log và cả hai chiều. Gốc trie do builder tái tạo phải bằng `receiptsRoot` của block EDR; hash mỗi header phải khớp RPC trước khi đưa vào Solidity. Test từ chối header từ nhánh đã revert cùng độ cao, log sai, sai cặp/consumer/emitter/order/kind/data, proof cắt ngắn, đính thêm hoặc vượt cap.
- **Đối chiếu trên lệnh BNB → ETH đã quyết toán bằng STARK:** dùng bộ mới kiểm độc lập receipt `Locked` từ BNB sang ETH, và `Reserved`, `Paid` từ ETH về BNB. Đây là kiểm lại log của lệnh VM, **không phải chi bằng adapter mới**. Hai hợp đồng giữ tiền V1 vẫn từ chối cấu hình adapter này vì pin quorum gốc.
- [`CROSSCHAIN-AUDIT.md`](CROSSCHAIN-AUDIT.md) nêu giới hạn vận hành còn lại. Không dùng benchmark từ VM để suy ra phí trên mạng thật.

### Số đo VM

| Trường hợp | Proof bytes | Gas EDR ước lượng khi kiểm |
| --- | ---: | ---: |
| ETH → BNB, block 130 receipt, 3 header / 5 node | 3.266 | khoảng 305.000 |
| BNB → ETH, block 4 receipt, 3 header / 3 node | 2.950 | khoảng 261.000 |
| Đúng biên 32 tổ tiên, 33 header | 20.115 | khoảng 1.469.000 |

Log thật của bài BNB → ETH có ba proof shadow từ khoảng 1,4 đến 4,0 KB. Bytecode verifier: init 8.010 và runtime 7.365 byte (solc 0.8.24, Paris, optimizer 200). Slither 0.11.5 trên phần verifier mới báo hai vị trí assembly chỉ đọc từ slice calldata đã kiểm độ dài, không báo High/Medium trong phạm vi này. Scan tĩnh và test không thay audit độc lập.

## Việc còn lại trước khi thay 2/3 trong đường chi

Cần một nguồn header finality đã audit **cho từng chiều**, hoặc cầu đã được duyệt với mô hình tin cậy ghi rõ. Với Ethereum: light client Beacon, sync committee/fork và liên kết SSZ tới execution block đã finalized. Với BNB: kiểm finality Parlia và các lần đổi validator set theo chính sách chain; không thay bằng đếm số block. Nguồn đó phải cấp checkpoint canonical, cập nhật đơn điệu và xử lý fork/deep reorg đúng quy tắc chain. Chỉ sau đó mới thiết kế profile thanh toán mới pin **cả verifier receipt lẫn nguồn finality**, kiểm các deadline hai chiều (kể cả cancel/refund), chạy public testnet và audit độc lập. Một checkpoint tĩnh chỉ chứng minh lịch sử đã có, không thể xác thực lệnh tương lai.
