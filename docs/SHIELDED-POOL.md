# Mobubu Pool · ETH / BNB / BTC

**Bản devnet, không nhận tiền thật. Chưa có payout riêng tư đã chạy với proof ZK-STARK.** Không nạp vào một địa chỉ từ preview. Đây là luồng mới, tách khỏi [swap trực tiếp đã chạy local](NATIVE-SWAP.md).

## Luồng của app

1. **Nạp.** Chọn ETH trên Ethereum, BNB trên BNB Smart Chain, hoặc BTC trên Bitcoin. Nhập số lẻ (18 chữ số ETH/BNB, 8 BTC), tạo note trên thiết bị. Không có giá, `minOut`, hay mạng nhận ở bước nạp. Vault EVM băm note key cùng **`msg.value` thực nhận**, không tin số do client báo. Intake BTC local quan sát **vout P2WSH đúng script, đúng genesis, đủ xác nhận, chưa tiêu**, rồi tính leaf từ số sat của output. BTC vẫn có dust và phí miner; biểu diễn một sat không có nghĩa UTXO một sat sẽ được relay.
2. **Rút về địa chỉ mới.** Cùng coin: không có FX. Khác coin: lấy giá lúc rút; TFHE tính `floor(debit × numerator / denominator)` trên số nguyên base units, so với `minOut` mã hóa. Quote desk chỉ nhận ciphertext và tuyến, không nhận bí mật note/đường Merkle/giao dịch nạp. Desk có adapter cho snapshot oracle đã xác thực (giá biểu diễn không vượt giá tham chiếu, sai số tối đa 1 ppm trước khi làm tròn base unit). Ticket hết hạn chậm nhất cùng snapshot. Client mở kết quả, xác thực ticket và ký các điều khoản chính xác bằng một khóa SLH-DSA mới cho lệnh. Sau rút một phần, số dư còn lại thuộc một note mới. SDK **chuẩn bị** lệnh cross-chain; chưa có cross-chain exit coordinator nối vào ba vault này.
3. **Chi native khi đủ điều kiện.** Hướng dự kiến: EVM tự kiểm proof gắn root, nullifier, số trừ, note thừa và điều khoản đã ký trước khi chi. BNB và BTC trả từ dự trữ native, **không mint**. Chân Bitcoin phải có sổ note/outpoint chống replay, signer đọc chain độc lập và 2-of-3 ECDSA trước khi chi. Hiện mới có observer BTC regtest, không có sổ giá trị/payout riêng tư BTC. Không dùng chữ ký/quoter để bỏ qua proof; không bật yield trong lần này.

Một pool chung trên mỗi mạng thay vì tách theo L2 hoặc mệnh giá. Tập giao dịch lớn có thể giúp, nhưng nạp/rút native vẫn lộ số tiền, thời điểm và địa chỉ chuyển trên chain. Số tiền hiếm có thể dễ bị đối chiếu. Không tuyên bố mạnh hơn Tornado Cash/Railgun, không gọi TFHE hay SLH-DSA là ẩn danh.

## Cái gì chạy được

- `npm run pool`: preview trình duyệt chỉ có **ETH, BNB, BTC**, tạo/tải note thử và đọc file note tại máy. Không RPC, không gửi dữ liệu, không kết nối ví. Note thử có domain riêng, không phải bằng chứng đã nạp. Màn Rút xem được số còn lại dự kiến từ file, không thực hiện chuyển. File note chứa secret; không upload hoặc chia sẻ.
- [`ShieldedNativePoolDevnet.sol`](../contracts/ShieldedNativePoolDevnet.sol) chỉ triển khai được trên chain ID 31337/31338. Có escrow, Merkle tree cố định 20 tầng, nullifier, giao diện verifier bất biến và ký lệnh SLH-DSA. Withdrawal từ chối nếu không có verifier đúng bytecode và proof khớp chương trình + public journal. Repo **chưa có verifier EVM thật** tương ứng. Test dùng một verifier **chỉ từ chối** để xác nhận không có fallback, không chứng minh rút thành công.
- [`proofs/shielded-spend`](../proofs/shielded-spend/README.md) chứa chương trình quan hệ rút cho RISC Zero STARK. Native parity test chạy đúng quan hệ SHA-256; **không phải sinh proof**. Host prover/verify offline và smoke test STARK có source, nhưng chưa build hoặc chạy ở sandbox này. Chưa có image ID được kiểm. Không dùng Groth16/PLONK làm wrapper cho đường này.
- `mobubu-wallet/pool`: SDK note, lập giao dịch nạp EVM local, dựng Merkle path tại client từ log của root finalized, quan sát BTC, chuẩn bị lệnh cùng/cross-chain, ký SLH-DSA và báo giá TFHE. SDK không tự gửi tiền. Pool mới không tự coi receipt của swap cũ là credit note. Catalog 10 mạng chỉ còn trong [mã lưu trữ](../legacy/groth16/src/network-catalog.mjs).

## Kiểm thử cô lập

```sh
npm ci
npm --prefix fhe-swap ci
npm run build:contracts
npm test
BITCOIND=/path/to/bitcoind npm run test:pool
npm run pool
```

Để bật đối chiếu *native relation + SHA-256* trên Linux/OpenSSL 3: `rustc --edition=2021 test/support/check-note-relation.rs -o /tmp/check-note-relation && POOL_RELATION_CHECKER=/tmp/check-note-relation node --test test/shielded-pool.test.mjs`. `BITCOIND=… npm run test:swap` chạy tiếp regression swap cũ và test intake/quote pool. Giao dịch test chỉ dùng đồng trên test chain. BTC cần tối thiểu 1.000 sat đầu ra theo policy devnet, chưa có đường tự tính/chuyển phí miner cho rút riêng tư.

## Ví dụ SDK nạp local

```js
const pool = await openEvmPool({ asset: 'ETH', rpc, vault, genesis, codeHash, deploymentBlock });
const { note, transaction } = await pool.draft(parseAmount('100.000000000000000001', 'ETH'));
// Lưu note trước khi ký. Chỉ ký transaction trên devnet đã pin.
// Khi finalized: lấy toàn bộ leaf logs và tìm đường Merkle ở client, không hỏi RPC theo note.
const anchor = await (await pool.snapshot()).anchor(note);
```

`openEvmPool` từ `mobubu-wallet/pool` chỉ chấp nhận hai chain local. Không dùng lời gọi `snapshot()` như số dư khả dụng: nó xác nhận thành viên của cây, chưa xác nhận note chưa rút hoặc có payout. Số lần chèn bị giới hạn bởi cây 20 tầng; cần thiết kế rollover trước khi phục vụ tiền thật.
