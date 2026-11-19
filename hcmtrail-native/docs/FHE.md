# Báo giá mã hóa với Zama FHEVM

[`ZamaNativeQuotes.sol`](../contracts/fhe/ZamaNativeQuotes.sol) dùng **`@fhevm/solidity@0.13.4`** trực tiếp trong Solidity. Đây là contract **không giữ hoặc chuyển tiền**, không phải vault thứ năm. Cả bốn vault ETH/BNB/TRX/HYPE vẫn áp dụng đúng proof STARK riêng cho rút nội mạng. Không có tuyến settlement liên mạng nào được bật.

## Phép tính và biên số nguyên

1. Ví đọc `activeEpoch()` và `quoteParameters(epochId, src, dst)`. Oracle cố định khi deploy, phải cùng host với quote contract. Không nhận giá, phí, decimals hay cap từ requester. Cả bốn round phải còn active khi tạo quote và khi xác nhận bit.
2. `requestQuote(input, inputProof)` nhận **hai `externalEuint128`**, không phải số tiền rõ. `FHE.fromExternal` gọi input verifier của Zama với proof cho chính caller và contract. Không chấp nhận handle zero hoặc đường `inputProof` rỗng. Proof input không chứng minh số tiền thuộc một note.
3. Đặt `n = price[src] × units[dst] × (10000 − feeBps)`, `d = price[dst] × units[src] × 10000`. Contract rút gọn tỷ lệ bằng GCD **công khai**, rồi homomorphic `mul` và `div` để lấy đúng `floor(debit × n / d)`. Không floor trung gian. Đơn vị TRX là sun, không phải wei.
4. FHE `euint128` có thể wrap. `maxDebit` là min của cap nguồn, `floor((2^128 − 1)/n)` và `floor(((cap(dst) + 1) × d − 1)/n)` sau rút gọn. `FHE.select` thay debit vượt biên bằng ciphertext zero **trước** khi nhân. Nếu tỷ lệ không vừa 128 bit hoặc không có output dương trong miền này, contract trả `UnsupportedRate`; không xấp xỉ giá. Giới hạn này có thể nhỏ hơn miền `quote()` công khai và không phải quota thanh khoản của vault.
5. `FHE.gt`, `FHE.ge`, `FHE.and` tạo bit hợp lệ: output dương và không dưới `minOut`. `FHE.select` trả amount mã hóa bằng 0 khi không hợp lệ. Contract cấp ACL bền cho chính nó và requester trên **hai đầu ra**; không cấp ACL public cho amount, debit hay `minOut`.

### Xác nhận bit tùy chọn

Mặc định của ví nên là `publishEligibility: false`. Với `true`, contract gọi `FHE.makePubliclyDecryptable` chỉ trên bit. Bất kỳ ai lấy được chữ ký quorum KMS **cho bit của quote đó** có thể gọi `confirmEligibility(id, eligible, decryptionProof)`. `FHE.checkSignatures` xác minh đúng handle đã lưu và `abi.encode(eligible)`. Callback sai, cũ, tráo bit hoặc gửi lại đều bị từ chối. Kiểm lại epoch có thể làm callback hết hạn trong khi đang đợi KMS; tạo quote mới với epoch mới, không tự lấy giá khác cho quote cũ.

ID hash có domain version, chain ID, địa chỉ contract, requester, nonce và toàn bộ input (epoch, route, hai handle, lựa chọn public). Mạch gắn ID công khai vào phép so sánh luôn đúng `FHE.eq(FHE.asEuint256(tag), tag)` rồi AND với bit kết quả. Như vậy các thao tác FHE trùng số liệu vẫn có handle kết quả riêng; nonce trong storage **một mình** không đủ vì KMS ký tập handle, không ký ID ứng dụng. Đây là ràng buộc với request báo giá, **không** với một public statement STARK.

Bật public có thể làm lộ ngưỡng qua bit; ACL public không hết hạn theo epoch. `quotes(id).verdict` cũng là dữ liệu lịch sử, không là cam kết thực thi. Requester, tuyến, epoch, ID và thời gian đều công khai. Coprocessor/KMS có lớp tin cậy và liveness riêng; xác nhận giải mã của họ không phải proof STARK rằng debit/quotient thuộc về một note. Contract không nhận note, nullifier, địa chỉ payout hay tiền nạp.

## Host và wallet

| Host | Cấu hình của contract |
| --- | --- |
| Ethereum `1` và Sepolia `11155111` | `ZamaEthereumConfig` trong gói đã pin. Phải kiểm đúng ACL, executor, KMS verifier và relayer hoạt động trước thử nghiệm live. Chưa deploy hoặc chạy Sepolia/mainnet ở đây. |
| `31337` | Chỉ dùng trong VM cục bộ với fixture địa chỉ local. Thiếu host bytecode thì constructor từ chối. |
| BSC `56`, TRON `0x2b6653dc`, HyperEVM `999` | Constructor từ chối. Có tuyến báo giá **cho** những asset này không đồng nghĩa có FHEVM **trên** những mạng này. Không lấy địa chỉ Ethereum sang mạng khác. |

Solidity tạo tác vụ trên các handle; coprocessor chạy FHE trên ciphertext và KMS giải mã theo quyền. Gói Solidity và gói SDK không tự triển khai các dịch vụ đó. Xem [Zama Litepaper](https://docs.zama.org/protocol/zama-protocol-litepaper) và [Zama SDK Encrypt & decrypt](https://docs.zama.org/protocol/sdk/guides/encrypt-decrypt). Chính sách feed vẫn cần kiểm theo [CHAINLINK.md](CHAINLINK.md): oracle chỉ đọc feed **cùng chain**, không ghép bốn proxy từ bốn mạng hoặc lấy oracle OP qua `STATICCALL`. Với smoke test Sepolia, chỉ dùng feed fixture tổng hợp có gắn nhãn và tài khoản testnet; đây không phải cấu hình giá live.

ABI tạo bởi `npm run build:fhe` ở `build/evm/fhe/ZamaNativeQuotes.json`. Ví dụ ghép vào ví test có sẵn `sdk` (`@zama-fhe/sdk@3.8.0`), `signer` và ethers contracts `oracle`, `book` đúng chain/địa chỉ; không có script tự lấy khóa hay gửi giao dịch lên mạng công khai:

```js
const { id: epochId } = await oracle.activeEpoch();
const [src, dst] = [0, 2]; // ETH → TRX, số nguyên wei và sun
const { maxDebit } = await book.quoteParameters(epochId, src, dst);
if (debit <= 0n || debit > maxDebit) throw new Error('Debit ngoài miền báo giá');
const contractAddress = await book.getAddress();
const userAddress = await signer.getAddress();
const { encryptedValues: [hDebit, hMinOut], inputProof } = await sdk.encrypt({
  contractAddress, userAddress,
  values: [{ type: 'euint128', value: debit }, { type: 'euint128', value: minOut }],
});
const tx = await book.connect(signer).requestQuote({
  epochId, src, dst, debit: hDebit, minOut: hMinOut, publishEligibility: false,
}, inputProof);
const receipt = await tx.wait();
const event = receipt.logs.filter((log) => log.address === contractAddress)
  .map((log) => book.interface.parseLog(log)).find((log) => log?.name === 'QuoteRequested');
if (!event) throw new Error('Thiếu QuoteRequested');
const quote = await book.quotes(event.args.id);
// Chỉ gọi sau khi user chấp thuận permit giải mã bằng ví. Không log cleartext.
const values = await sdk.decryption.decryptValues([
  { contractAddress, encryptedValue: quote.amount },
  { contractAddress, encryptedValue: quote.eligible },
]);
```

Nếu đã chọn `publishEligibility: true`, lấy `{ clearValues, decryptionProof } = await sdk.decryption.decryptPublicValues([quote.eligible])`. Chỉ giải mã public **một handle bit**. Truyền ID, giá trị `bool` của `clearValues[quote.eligible]` và `decryptionProof` vào `confirmEligibility`. Không dùng `cleartext` transport hoặc key fixture trên mạng công khai.

## Kiểm tra tái lập

```sh
npm ci --ignore-scripts
npm run build:fhe
npm run test:fhe:evm
npm run test:fhe:trace  # Linux x86-64, C/C++, mạng tới codeload.github.com; nhanh hơn với AVX2/FMA
```

- `test:fhe:evm`: chạy **bytecode ứng dụng dùng thư viện Zama** trong EDR, với ACL/executor/KMS fixture. Kiểm 12 cặp, phép floor, cap sun và overflow, thay caller/contract/inputs, ACL, epoch đổi và hết hạn, sai handle/bit/quorum và replay. Phần tính clear ở bài kiểm này là mô hình, không phải FHE crypto.
- `test:fhe:trace`: lấy chính operation trace của contract chạy trên EDR. Client local mã hóa hai số 128 bit dưới khóa thử nghiệm; evaluator TFHE/CGGI chỉ nhận cloud key và ciphertext để chạy các cổng bootstrapped theo trace. Kiểm `floor(debit × 5/3)` với `minOut` bằng kết quả và lớn hơn đúng một đơn vị. Chữ ký callback do **KMS fixture** tạo từ bit giải mã. Đây là kiểm tích hợp FHE thật trong lab, **không** phải chạy coprocessor TFHE-rs của Zama, input ZKPoK, Gateway hay threshold MPC thật. Không suy ra HCU, latency, gas trên mạng công khai hoặc an toàn production từ các test này.
- Build oracle/vault EVM và TVM không nạp closure thư viện FHEVM. `npm run test:fhe` vẫn là bài thử CGGI cũ độc lập.

Việc còn thiếu trước khi dùng để chi tiền: quan hệ STARK mới phải buộc cùng note/debit/change, commitment ciphertext và epoch vào statement; kiểm được evaluation/decryption theo mô hình tin cậy đã duyệt; kiểm giữ chỗ, finality và claim một lần ở đích. Không nối callback này vào `withdraw` thay cho các kiểm tra đó. Xem [SETTLEMENT.md](SETTLEMENT.md).
