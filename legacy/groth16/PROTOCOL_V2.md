# Thiết kế lưu trữ — Groth16 vault v2

Vault v2 dưới đây là tài liệu lịch sử. Không deploy hoặc cấp tiền mới từ build này. Luồng ETH mặc định đã thay bằng [PostQuantumVault](../../PROTOCOL_DESIGN.md).

## 1. Vault EVM v2: một mạng, một tài sản native, một mệnh giá

Mục tiêu kiểm chứng: **chỉ một note đã được nạp và chưa tiêu mới cấp quyền chi một mệnh giá**, đến đúng địa chỉ trong proof. Hai artifacts tin cậy là verifier Groth16 của đúng circuit/ceremony và Poseidon(2) từ đúng bộ hằng circomlib. Vault giữ hai địa chỉ này `immutable`; constructor **không** chứng nhận bytecode ở đó. Fixture EDR local triển khai `PoseidonT3` từ `poseidon-solidity` và verifier do `snarkjs` xuất; không dùng mock verifier. SDK dùng `poseidon-lite`; test đối chiếu root khi dựng lại từ log.

Tất cả giá trị Poseidon thuộc scalar field BN254 `r`. Độ sâu cây là 20; leaf trống bằng 0. Các secret do SDK sinh từ CSPRNG, là số khác 0, rộng 248 bit.

| Thành phần | Công thức / điều kiện |
| --- | --- |
| Domain | `uint256(keccak256(abi.encode(keccak256("mobubu-native-vault-v2"), chainId, vault, denomination))) % r` |
| Commitment | `Poseidon(4)(1, domain, nullifier, secret)` |
| Nullifier công khai khi tiêu | `Poseidon(3)(2, domain, nullifier)` |
| Node Merkle | `Poseidon(2)(left, right)`; bit `0` đặt node hiện tại bên trái; path từ leaf lên root |
| Public signals theo thứ tự | `[root, nullifierHash, uint160(recipient), domain]` |
| Private witness | `nullifier`, `secret`, 20 siblings, 20 bit hướng. Không có `noteAmount` do người dùng tự khai. |

**Nạp.** `deposit(commitment)` yêu cầu `msg.value == denomination`, commitment khác 0, `< r`, chưa từng có. Cập nhật frontier bằng đúng 20 phép hash, lưu tối đa 32 root gần nhất. `Deposit` chứa commitment, index, root; SDK dựng cây từ log đúng thứ tự và kiểm tra từng root. Bên gọi phải lấy log từ **đúng vault và đúng canonical chain**, chọn checkpoint đã xác nhận, tự rescan khi reorg; SDK không tự xác minh RPC/finality. Contract không phát nullifier lúc nạp. ETH bị ép chuyển vào contract không tăng `totalLocked`, không tạo note.

**Rút.** `withdraw(recipient, root, nullifierHash, A, B, C)` không nhận commitment hay số tiền rút. Contract kiểm tra root trong cửa sổ lưu trữ, nullifier chưa dùng, verifier chấp nhận public signals do contract lắp ráp. Sau đó đánh dấu nullifier, trừ `totalLocked`, chuyển đúng mệnh giá. Nếu payout revert, toàn bộ cập nhật rollback; reentrant withdrawal bị chặn. Bên gửi giao dịch không có quyền đổi người nhận. Nếu khoá chain ID của mạng thay đổi, vault từ chối nạp/rút; không bảo vệ được bản sao fork giữ *cùng* chain ID và state.

**Giới hạn.** Không có change note, fee cho relayer, ERC‑20, withdraw cross-chain hay tự khôi phục note. Người mất secret mất quyền chi. V2 đổi ABI/circuit/domain; note, root, proof và key từ bản cũ **không tương thích**, không có migration tự động. Groth16 cần ceremony đáng tin cậy; artifacts một máy trong `local-only` không được triển khai. Audit độc lập phía circuit, Solidity, SDK, artifact và quy trình key custody là điều kiện trước khi cân nhắc tiền thật. Địa chỉ nạp/nhận, lượng native, thời điểm, gas payer và metadata mạng vẫn quan sát được; không bảo đảm ẩn danh.

**Rust.** Verifier Rust/BN254 là kiểm chéo offline, không phải indexer. Nó nhận VK tin cậy, proof, và public statement **độc lập**. Nó không kiểm tra root còn được EVM lưu, nullifier đã tiêu hay giao dịch đã final. Kiểm các điều kiện đó tại nơi thực thi, không suy diễn từ `valid`.
