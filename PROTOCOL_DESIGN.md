# Cross-Chain Anonymous Vault (CCAV) — Protocol Design

## Mục tiêu
Cho phép người dùng nạp tiền vào vault trên chain A, rút ra trên chain B (hoặc cùng chain) mà không ai có thể **chắc chắn 100%** rằng ví rút là ví nạp. Chấp nhận metadata rò rỉ (timestamp, IP, kích thước ciphertext, asset pair) nhưng tối đa hoá giấu **liên kết ví nạp ↔ ví rút** và **số tiền thực tế**.

## Thành phần chính

1. **Vault Contract** (Solidity, EVM) — giữ coin thực từ LP, nhận deposit, unlock khi có proof hợp lệ. Triển khai độc lập trên mỗi chain.
2. **Withdrawal Verifier** (Solidity) — xác minh ZK-SNARK: người rút biết secret của một note, số tiền rút <= số tiền trong note, nullifier chưa dùng.
3. **FHE Encrypted Balance** — số tiền trong note được mã hóa bằng TFHE/FHE public key của mạng node. Node tính toán `balance >= amount` trên ciphertext, không thấy số thật.
4. **ZK Circuit** — chứng minh: (1) biết secret key của commitment, (2) amount encrypted khớp với FHE ciphertext, (3) nullifier unique, (4) không rút quá số có.
5. **Validator Node Network** — các node chạy FHE evaluator + ZK verifier, tham gia threshold key generation, ký consensus về withdrawal hợp lệ.
6. **Client SDK** — kết nối ví, sinh key tạm khi nạp, tạo note, tạo ZK proof, gửi withdrawal.

## Luồng chạy

1. Connect + Keygen: user kết nối ví, sinh ephemeral key pair (k_enc, k_view).
2. Deposit: gửi coin vào Vault trên Chain A. Vault lưu commitment = H(secret, amount, chain, asset) và mã hóa amount bằng FHE public key của mạng node.
3. Note: user giữ note = {commitment, secret, encrypted_amount, nullifier = H(secret, "withdraw")}.
4. Withdraw: user chọn destination trên Chain B, số tiền rút. Tạo ZK-SNARK proving:
   - có một note với commitment trong merkle tree
   - biết secret của commitment đó
   - withdraw_amount <= decrypted_amount (kiểm tra qua FHE + range proof)
   - nullifier chưa dùng
5. Validator Nodes: nhận withdrawal, chạy FHE kiểm tra encrypted_balance >= withdraw_amount, threshold ký xác nhận, gửi lên Vault Chain B.
6. Unlock: Vault Chain B verifies ZK proof + threshold signatures, gửi coin đến destination.

## Giới hạn thừa nhận
- Không che được: timestamp, IP, kích thước ciphertext, asset pair, địa chỉ ví gửi/nhận (metadata).
- Che được: liên kết trực tiếp ví nạp/ví rút (nhờ ZK anonymity + nullifier), số tiền thực tế (nhờ FHE encryption).

## Chuỗi hỗ trợ (mục tiêu)
- EVM chains (Ethereum, BSC, Polygon, v.v.)
- Bitcoin (qua gateway/vault contract)
- Monero, Zcash (qua light client hoặc gateway tương thích)
