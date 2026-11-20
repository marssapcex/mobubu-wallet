# Mobubu — đặc tả vault ETH hậu lượng tử

[`PostQuantumVault`](contracts/PostQuantumVault.sol) thay toàn bộ đường nạp/rút ETH mặc định. Hợp đồng tự kiểm **chữ ký hash-based SLH-DSA-SHA2-128s**, biến thể category 1 của [NIST FIPS 205](https://csrc.nist.gov/pubs/fips/205/final). [`SlhDsaSha2_128s`](contracts/lib/SlhDsaSha2_128s.sol) dùng SHA-256 chuẩn tại precompile `0x02`, không đổi EVM. Verifier nằm trong bytecode vault, không có địa chỉ verifier tùy chỉnh, admin, proxy, attester, trusted setup hoặc fallback ECDSA/ZK.

## 1. Trạng thái và lệnh nạp/rút

`accounts(publicKey)` trả `(balance, nonce)`; tài khoản mới bắt đầu từ `(0, 0)`. Khóa công khai là 32 byte `PK.seed[16] || PK.root[16]`. Số dư và số tiền tính bằng **wei**, không theo mệnh giá cố định. Một nonce tuần tự **dùng chung cho nạp và rút** của mỗi khóa; không đặt lại khi số dư về 0.

- `deposit(bytes32 publicKey, uint256 nonce, uint64 deadline, bytes signature)` là `payable`. Chữ ký ủy quyền cho đúng `msg.sender` và `msg.value` dương. Sau xác minh, tăng nonce, ghi có đúng ETH nhận và tăng `totalLocked`.
- `withdraw(bytes32 publicKey, address recipient, uint256 amount, uint256 nonce, uint64 deadline, bytes signature)` là `nonpayable`. Ai cũng có thể trả gas để relay. Chữ ký phải đúng người nhận và số wei dương, không vượt số dư của **khóa đó**. Hợp đồng tăng nonce, trừ hai số dư rồi mới gọi người nhận. Nếu không chuyển được ETH, cả payout, số dư và nonce rollback. Cả nạp và rút bị chặn trong callback payout.
- Chữ ký hết hạn khi `block.timestamp > deadline`. Lệnh đã thành công không dùng lại được. Sự kiện `Deposit`/`Withdrawal` công khai **nonce đã dùng**, không phải nonce tiếp theo. Không trừ phí relay từ số tiền đã ký; mọi thỏa thuận fee nằm ngoài vault.
- `totalLocked` là tổng số dư đã ghi sổ. Chuyển ETH trực tiếp không có lệnh nạp bị từ chối; ETH bị ép chuyển vào địa chỉ hợp đồng không tăng `totalLocked`, không tạo quyền chi và không có lệnh thu hồi phần dư đó.

## 2. Thông điệp ký và định dạng chữ ký

Ký **320 byte ABI** do SDK hoặc `authorizationMessage(...)` tạo, không ký chuỗi hex, không `personal_sign`, không EIP-712 và không tự prehash. Dùng pure SLH-DSA-SHA2-128s, context rỗng. Thuật toán chuẩn thêm `0x0000` trước thông điệp nội bộ, **SDK không tự thêm lần nữa**.

```text
abi.encode(
  bytes32(keccak256("mobubu:SLH-DSA-SHA2-128s:eth-vault:v1")),
  uint256(chainId), address(vault), address(0), // 0 = native asset, không phải ERC-20
  uint8(action), bytes32(publicKey), address(party),
  uint256(amountWei), uint256(nonce), uint64(deadlineUnixSeconds)
)
```

| Lệnh | `action` | `party` | `amountWei` |
| --- | ---: | --- | --- |
| Nạp | 1 | người gửi tx | `msg.value` |
| Rút | 2 | người nhận ETH | `amount` |

Hợp đồng tự lấy chain ID và địa chỉ vault, không dùng domain do người gọi khai. Chữ ký bắt buộc đúng **7.856 byte**: `R[16] || SIG_FORS[2912] || SIG_HT[4928]`. Hợp đồng tính `H_msg`, dựng FORS root và kiểm 7 tầng WOTS+/XMSS tới `PK.root`; thông điệp hoặc một phần chữ ký bị đổi không còn khớp. Không chấp nhận proof cũ. Xem [các vector ACVP độc lập](test/fixtures/NOTICE.md); khớp vector không phải chứng nhận NIST cho triển khai.

## 3. Gọi SDK

Dùng **địa chỉ đã kiểm tra code** và chain ID của deployment local. `build/contracts.json` chứa ABI, `evm.bytecode.object` để deploy và `evm.deployedBytecode.object` để đối chiếu runtime từ `eth_getCode`. Không cần deploy thêm verifier. Ví dụ dưới đây giả sử `provider`, `payer`, `relayer`, `recipientAddress`, `vaultAddress` và `chainId` đã được cấu hình cho cùng một EVM local. Không chạy với tiền thật.

```js
import { parseEther } from "ethers";
import {
  DEPOSIT, WITHDRAW, connectVault, createVaultKey,
  signAuthorization, verifyAuthorization, encodeVaultTransaction,
} from "mobubu-wallet";

const account = createVaultKey(); // 64 byte secretKey; không log, lưu an toàn trước khi nạp
const vault = connectVault(vaultAddress, provider);
const scope = { chainId, vault: vaultAddress, publicKey: account.publicKey };

async function submit(sender, action, party, amount) {
  const { nonce } = await vault.accounts(account.publicKey);
  const { timestamp } = await provider.getBlock("latest");
  const intent = { ...scope, action, party, amount, nonce, deadline: BigInt(timestamp) + 600n };
  const signature = signAuthorization(account.secretKey, intent); // chỉ trên thiết bị giữ khóa
  if (!verifyAuthorization(intent, signature)) throw new Error("Chữ ký không hợp lệ");
  // Chỉ gửi tx đã encode (không gửi secret key); sender trả gas EVM như bình thường.
  const tx = await sender.sendTransaction(encodeVaultTransaction(intent, signature));
  return tx.wait();
}

await submit(payer, DEPOSIT, await payer.getAddress(), parseEther("1"));
await submit(relayer, WITHDRAW, recipientAddress, parseEther("0.25"));
```

`verifyAuthorization` chỉ kiểm chữ ký, không xác nhận số dư, nonce hiện hành, thời hạn hay finality. Store/restore secret và chống side channel là trách nhiệm của client, không giao cho RPC. Không ký song song cho cùng nonce nếu không chủ ý tạo các lệnh tranh nhau; đợi trạng thái mới trước khi ký lệnh kế. Chữ ký rút đã đưa cho relayer có thể được **bất kỳ ai** gửi với đúng số tiền/đích trước khi hết hạn. Sau payout thất bại có thể gửi lại đúng chữ ký nếu nonce và deadline còn hợp lệ.

## 4. Kết quả kiểm và phạm vi bảo vệ

[`test/pq-vault.test.mjs`](test/pq-vault.test.mjs): vector NIST (sigVer với context 255 byte và sigGen với context rỗng), chữ ký do SDK tạo, giao dịch nạp/rút xử lý ETH trong EVM, số dư nhiều khóa, replay khác contract/chain ID, chữ ký/lệnh sai, rollback và callback bị chặn. EDR `0.25.1`, Osaka, không fork RPC và không override precompile; `solc 0.8.24` target Paris. Gas dưới đây lấy từ **receipt giao dịch thành công** với key fixture và người nhận EOA (đã gồm calldata):

| Giao dịch | Gas dùng |
| --- | ---: |
| Nạp đầu | 1.340.671 |
| Nạp thêm | 1.282.304 |
| Rút một phần | 1.271.909 |
| Rút hết | 1.219.547 |

Đây là số đo mẫu, không phải giới hạn xấu nhất hay báo giá mainnet. Chi phí thay đổi theo chữ ký và code bên nhận. Các fixture thành công chạy với gas limit 3 triệu, dưới trần giao dịch Osaka **16.777.216** ([EIP-7825](https://eips.ethereum.org/EIPS/eip-7825)).

- **Không ẩn danh:** cùng public key nối các lần nạp và rút; số dư, số tiền, payer, recipient, thời điểm và relayer có thể quan sát. Chữ ký giữ bí mật khóa chứ không che giao dịch.
- **Không biến Ethereum thành mạng hậu lượng tử:** chỉ quyền ghi có/chi số dư trong vault bắt buộc có chữ ký SLH-DSA. Tài khoản gửi tx, tài khoản nhận sau payout, RPC và consensus là lớp riêng. Chain ID không tách hai fork giữ cùng chain ID, địa chỉ và trạng thái.
- **Không có nâng cấp/thoát bằng admin:** mất secret thì không có khôi phục; muốn đổi khóa cần rút bằng khóa hiện tại và nạp lại có chữ ký khóa mới. Cần audit độc lập verifier/contract/SDK, quản lý khóa và kiểm bytecode/network trước khi xem xét triển khai công khai. Chưa triển khai công khai.
- **Không migrate note:** [v2/v3 Groth16](legacy/groth16/README.md) là ABI riêng. Sửa repo không đổi bytecode đã deploy. Không gửi thêm vào vault cũ hoặc đưa note cũ vào SDK này; nếu đang giữ tài sản ở một deployment cũ, chỉ nghiệp vụ rút theo chính deployment đó mới có thể giải phóng tiền trước khi nạp vào vault khác. Không có migration tự động, token ERC-20 hoặc rút liên mạng từ vault cá nhân. [Swap BTC/ETH/BNB](docs/NATIVE-SWAP.md) dùng rail và custody riêng, không lấy tiền từ số dư ở đây.

## 5. FHE: tách khỏi việc cấp quyền chi

`fhe-swap` có BFV leveled (SEAL/WASM) và CGGI gate bootstrapping (native C++). Client giữ secret; evaluator CGGI giữ cloud key tin cậy, trả ciphertext 1 bit cho `balance >= publicAmount`. Phép toán hai ciphertext yêu cầu cùng width (với các phép cùng độ rộng) và cùng key. Envelope có `keyId` lấy từ SHA-256 cloud key để phát hiện dùng nhầm, không phải xác thực ciphertext. Kết quả chưa giải mã không phải `bool`, vote, threshold signature hay ZK proof. Không có API nào của vault lấy kết quả này làm quyền rút.

BFV dùng phép toán nguyên modulo plaintext modulus, không phải lệnh so sánh hoặc chia nguyên số bí mật một cách miễn phí. Sealed orderflow AES‑GCM + Shamir là mở lệnh theo quorum trong mô phỏng, không phải FHE hay verifiable DKG. Envelope v2 xác thực version/committee ID bằng AAD và giới hạn dữ liệu trước khi mở. Collector bỏ tham chiếu share đã dùng, không bảo đảm xóa RAM hay xác thực participant. Xem số đo và lộ trình ở [tài liệu nghiên cứu](docs/NGHIEN-CUU-ZK-FHE.md).

## 6. Streaming NYX: reference state machine

- Xét inbound theo adapter/asset/`depositTag` mock (không phải địa chỉ L1), số lượng nguyên dương và độ sâu xác nhận; một `(chain, txHash)` chỉ được ghi có một lần trong tiến trình. Đơn vị là base unit của tài sản, quy đổi sang 8 decimal nội bộ phải chính xác. Sai tài sản không được hoàn bằng tài sản trong order. Sau khi ghi có, engine không thay tx hoặc amount nguồn khi watcher đổi observation.
- Mở order khi đủ share và qua epoch. Mỗi chunk có `ceil(fullMinOut × chunkIn / fullIn)`. Không có commit nào nếu quote dưới limit. Một tick xử lý tối đa một chunk; mất xác nhận nguồn thì dừng các chunk mới. Bot chỉ đề xuất input tại giá tham chiếu, còn AMM tính output từ reserves thật và enforce cap riêng cho tài sản/NYX. Lỗi từ bot được đếm, không làm trade đã thực thi được book lần nữa.
- Sau khi dừng, lập đúng một payout và/hoặc refund cố định, không tính lại giá. Giữ các bytes đã ký cho mỗi leg. Nếu phản hồi RPC bị mất, tick kế tiếp gửi lại **chính** bytes đó, kiểm tx ID trả về và không đổi nonce/transaction. Kiểm lại funding trước khi ký và gửi **mỗi** leg, kể cả trước khi retry broadcast. Mất funding sau khi payout đã gửi: vẫn theo dõi ID đã ghi, hoãn refund mới và kết sổ. Chỉ thu phí NYX và đánh dấu kết thúc sau khi quan sát đủ độ sâu ở inbound và mọi leg. Các lần quan sát không nguyên tử; nếu đã gửi nhưng mất phản hồi, bản mock chỉ giữ bytes và thử lại khi funding trở về, chưa reconcile độc lập.
- `needs_review` là yêu cầu đối soát thủ công, **không** phải đã hoàn tiền. Toàn bộ outbox/claims/pool hiện ở RAM: không đảm bảo an toàn sau crash hoặc reorg sâu. Chưa có ký chain thật, indexer tin cậy, đồng thuận, reservation nonce/UTXO, kiểm finality theo block hash, account balance/custody. Không cấu hình vào mainnet.
