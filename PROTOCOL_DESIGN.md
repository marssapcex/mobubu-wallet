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

## 7. Yield Vault + EIP-7702 + Tokenized Assets (RWA)

### 7.1 YieldVault
Cho phép người dùng gửi tiền vào pool keeper lâu để kiếm lãi (yield).
- Người dùng nạp token vào YieldVault, nhận yToken (ERC20 đại diện cho quyền sở hữu).
- Lãi tính theo APR (basis points) và thời gian giữ: `interest = amount * aprBps * elapsedSeconds / (SECONDS_PER_YEAR * PRECISION)`.
- Người dùng có thể withdraw gốc + lãi, hoặc claim chỉ lãi.
- Hỗ trợ EIP-7702: ví EOA bình thường có thể tạm thời "mượn" code của YieldVault để thực hiện deposit/withdraw/claim trong một transaction duy nhất, không cần đổi địa chỉ ví.

### 7.2 EIP-7702 (Ephemeral Account Delegation)
Trước Pectra, EOA chỉ có private key, không chạy được code. Sau EIP-7702:
- EOA gửi transaction có authorization list, ký để "set code" của mình thành smart contract address.
- Các lời gọi đến EOA sẽ delegatecall đến code của contract đó.
- Trong mobubu-wallet: EOA authorize code của YieldVault/TokenizedAsset, rồi gọi deposit/withdraw/mint/redeem qua ephemeral account.
- Privacy được giữ nguyên: ephemeral account không liên kết trực tiếp với ví public gốc.

### 7.3 Tokenized Asset (RWA - Real World Assets)
Token hóa cổ phiếu / tài sản thực thế (ví dụ: S&P 500).
- Mỗi token đại diện cho 1 đơn vị cổ phiếu (hoặc tỉ lệ cố định).
- Liên kết với Oracle giá (Chainlink-style).
- Cho phép mint token khi gửi collateral (ETH/DAI), redeem để nhận lại collateral.
- Giá trị token được cập nhật theo oracle giá.

### 7.4 Luồng Yield + EIP-7702
```
User ──nạp tiền ẩn danh vào AnonymousVault──> (note, commitment, nullifier)
User ──stake vào YieldVault qua EIP-7702──> ephemeral account chạy code vault
YieldVault ──tính lãi theo APR + thời gian──> yToken tăng giá trị
User ──claim lãi hoặc withdraw──> nhận lại tiền (vẫn ẩn danh nhờ nullifier)
```

### 7.5 Chuỗi hỗ trợ (mục tiêu)
- EVM chains (Ethereum, BSC, Polygon, v.v.)
- Bitcoin (qua gateway/vault contract)
- Monero, Zcash (qua light client hoặc gateway tương thích)
- Tokenized assets: SP500, RWA (real-world assets)
