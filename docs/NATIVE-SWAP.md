# Swap native BTC / ETH / BNB — bàn giao

**Chạy settlement testnet/regtest trước, không dùng tiền thật.** Đây là đường giao dịch native trong `packages/swap`, không phải `MockChainAdapter`, note Groth16 hay wrapped BTC. Sáu chiều trên **ba sổ**: Bitcoin, Ethereum, BNB Smart Chain. Không có swap nguyên tử: nhà vận hành giữ và cấp trước thanh khoản, BTC 2-of-3 cùng kiểm lệnh, ETH/BNB dùng một khóa treasury SLH-DSA riêng trên mỗi rail. Chưa audit hoặc triển khai lên mạng công khai.

Đây là luồng **swap trực tiếp** (báo giá trước khi nạp), không phải [Mobubu Pool](SHIELDED-POOL.md). SDK chỉ chấp nhận các profile Bitcoin/Ethereum/BSC mainnet hoặc cặp testnet/devnet tương ứng; không dùng L2.

## Chạy lại từ mã nguồn

```sh
npm ci
npm --prefix fhe-swap ci
npm run build:contracts
npm test
BITCOIND=/absolute/path/to/bitcoind npm run test:swap
```

`test:swap` đòi Bitcoin Core v28+; trên Linux x86-64 build worker CGGI từ source pin sẵn (hoặc đặt `TFHE_WORKER` tới worker đã build). Test tự chạy **Bitcoin Core regtest với RPC riêng** và hai EVM Osaka độc lập. Nó ký, gửi và đào giao dịch **2-of-3 P2WSH**; kiểm receipt, vout và số dư; chạy đủ 6 chiều, encrypted minOut, hoàn khi thiếu BTC hoặc payout lỗi, khởi động lại, reorg và replay. Hai EVM không phải node Ethereum/BSC công khai; EDR kiểm bytecode và chuyển số dư native, không kiểm đồng thuận BSC/Ethereum mainnet. Lần chạy bàn giao: **14/14 ca** với Bitcoin Core v32.1, EDR 0.25.1 và worker CGGI mới build; bốn payout EVM thành công dùng khoảng **2,47–2,54 triệu gas** (không phải worst case). Suite in các txid funding, payout và source resolution để đối chiếu; txid local không có trên explorer công khai. `NativeSwapRail` và `PostQuantumVault` độc lập; không dùng số dư của vault cá nhân làm thanh khoản swap.

## Đặt cấu hình trước khi nhận đơn

- Build `build/contracts.json`, triển khai `contracts/NativeSwapRail.sol → NativeSwapRail` trên đúng hai EVM, constructor nhận **khóa công khai treasury của mạng đó**. Pin `chainId`, hex `genesis`, địa chỉ `rail`, `codeHash = keccak256(runtime từ eth_getCode)`, `treasury` và `depth` trong `policy.ETH` và `policy.BNB`. Không chép chain ID hoặc code hash từ một RPC không tin cậy. Rail cần `finalized` và đọc theo block hash canonical. Gas account riêng cho từng rail, không dùng đồng thời với app khác.
- `policy.BTC`: `network` = `regtest`, `testnet` hoặc `bitcoin`; `genesis` block 0 dạng `0x…`; `keys` đúng ba khóa nén secp256k1 khác nhau; `depth` số xác nhận; `fee` số satoshi tuyệt đối cho giao dịch một input. Core dùng `-txindex=1`, node sync, endpoint RPC riêng (HTTPS hoặc loopback với `cookieFile`). Không mở RPC/TFHE worker ra Internet. Cấu hình `rpc.BTC/ETH/BNB` đều có `url`, BTC có thể thêm `cookieFile`. Các cosigner nên lấy dữ liệu từ node độc lập.
- `policy.quoter`: khóa công khai SLH-DSA ký kết quả định giá, tách khỏi treasury. Bàn giá dùng `quoterKeyFile` và `rates` có khóa như `BTC/ETH`, giá nguyên Q16 theo **lot đích trên một lot nguồn**. Phí/markup nằm trong giá đã niêm yết. Không mặc định đây là giá live hay vốn đã được giữ. Thiếu route trong bảng thì tắt route đó.
- Cấu hình coordinator: `journal` là đường dẫn SQLite nằm trong thư mục riêng; `evmSigners.ETH/BNB` gồm `gasKeyFile`, `treasuryKeyFile`, `maxGasPrice` (wei). Cấu hình signer BTC riêng chỉ cần policy, các RPC đọc và `cosigner.{keyFile,journal}`. Secret file dạng hex `0x…`, mode `0600`. Dùng `npm run swap:ctl -- keygen-pq private/…key` hoặc `keygen-btc` để tạo; stdout chỉ có public key. **Không** đặt hai khóa BTC trên máy coordinator. Sao lưu cả DB (bao gồm WAL hoặc SQLite backup) và journal độc lập của mỗi signer; không xóa DB để thử lại giao dịch.
- Nạp vốn trước: gọi `provideLiquidity()` với native ETH/BNB thực nhận trên mỗi rail; không phải LP token/lệnh redeem. `treasury-address` trả địa chỉ BTC common multisig. Nạp BTC tới đó, đợi xác nhận rồi chạy `reserve CONFIG txid vout` cho từng UTXO. Mỗi payout BTC dùng một UTXO đủ lớn, change về treasury được ghi nhận khi final. Chỉ funds đã collect sau payout mới trở thành thanh khoản. Khóa treasury có thể chi dự trữ của rail, nên phải giữ an toàn.

## Một lệnh lấy báo giá và đi tới settlement

Giữ cấu hình thật trong `private/`, không commit. SDK là `mobubu-wallet/swap`; CLI dùng chính SDK, không có đường ký tắt. Bàn giá chỉ nạp cloud key/ciphertext của client đã provision qua kênh tin cậy, không mở native parser cho người lạ. TFHE làm việc với lot; mỗi BTC input phải đủ để trả phí cố định và còn lại tối thiểu 1.000 sat.

```sh
# Thiết bị user: cùng policy, userKeyFile, trade.{from,to,amountIn,minOut,payer,recipient,refund}.
# Giữ terminal mở để secret TFHE chỉ ở thiết bị user. Amount/minOut là số nguyên base units dạng chuỗi.
node scripts/swapctl.mjs client-order private/user.json private/exchange
# Bàn giá nhận request.json + cloud.key qua kênh riêng đã provision (không nhận khóa bí mật user).
node scripts/swapctl.mjs quote-eval private/quoter.json request.json cloud.key > reply.json
# User đưa reply.json vào exchange, nhấn Enter; client tạo order.json nếu kiểm FHE đạt.
node scripts/swapctl.mjs register private/coordinator.json private/exchange/order.json
```

Đọc chỉ dẫn nạp từ `register`. BTC gửi đúng sats tới P2WSH **riêng cho order**; chỉ gửi một output. ETH/BNB ký `funding.to/data/value` bằng ví `payer` trên `funding.chainId`, không chuyển ETH/BNB trần. `payer` chỉ dùng khi nguồn là EVM. Nạp **sau** khi đăng ký thành công, trước `fundUntil`; không tự dựng địa chỉ/lệnh nạp cho đơn chưa đăng ký. Rồi cung cấp `txid` và **vout BTC hoặc logIndex Funded EVM**; bất kỳ dữ liệu nào từ user vẫn được đối chiếu với node.

```sh
node scripts/swapctl.mjs attach private/coordinator.json ORDER_ID TXID INDEX
node scripts/swapctl.mjs tick private/coordinator.json ORDER_ID
# Khi tick báo btc_approval_required, xuất yêu cầu, từng operator ký trên máy riêng.
node scripts/swapctl.mjs approval private/coordinator.json ORDER_ID > request-to-sign.json
node scripts/swapctl.mjs cosign private/signer-1.json request-to-sign.json > partial-1.json
node scripts/swapctl.mjs cosign private/signer-2.json request-to-sign.json > partial-2.json
jq -s . partial-1.json partial-2.json > partials.json
node scripts/swapctl.mjs tick private/coordinator.json ORDER_ID partials.json
```

Gọi `tick` tiếp (hoặc điều phối từ `active`), đọc `status` để chờ finality và leg tiếp theo. Chỉ chạy một coordinator logic cho mỗi deployment, dùng chung journal giữa các lần gọi. Không cấp quyền tick/cosign hoặc file secret cho ví người dùng. Có thể theo dõi bằng txid từ `status`. `paid` chỉ sau payout đích **và** collect nguồn được xác nhận; `refunded` chỉ sau xác nhận hoàn tiền. Không tự kích một swap mới khi RPC timeout. CLI mặc định chặn ghi mainnet; bỏ chặn không thay cho audit/testnet/giới hạn tài chính.

## Điều kiện không được bỏ qua khi sửa code

- **PQ intent** (`protocol.mjs`): pure SLH-DSA-SHA2-128s, ký bytes ABI có domain, deployment (pin cụ thể BTC genesis/multisig và hai rail EVM), hai chain, payer, nhận/hoàn, amountIn, minOut, amountOut, nonce, quote ID, hạn nạp và hạn payout. Hash của thông điệp là order ID. BTC script gắn order ID; nguồn EVM kiểm chữ ký user và `msg.value`. Đích EVM chỉ trả đúng address và số tiền user ký, trước hạn trong block, và chỉ khi treasury đồng ký. Chữ ký treasury gắn rail, hành động, order, đích, giá trị và tài khoản submit.
- **FHE thực thi** (`fhe-quote.mjs`): user mã hóa `uint24` số nạp và `uint32` số tối thiểu. CGGI evaluator chỉ có cloud key, nhân giá Q16 trong 48 bit, dịch 16 bit để làm tròn xuống và so sánh **ciphertext với ciphertext**. Client giải mã số nhận + cờ đạt và đối chiếu công thức trước khi ký. Lot là **100 sat**, **10^12 wei** ETH/BNB; từ chối phần lẻ, BTC dưới 1.000 sat. Quoter ký hash transcript; signer tái tính clear quote. Đây là xác nhận của bàn giá rằng nó đã chạy mạch, **không phải proof** việc mở ciphertext. Giai đoạn settlement cần thấy số tiền rõ; BTC/ETH/BNB on-chain không ẩn số tiền, địa chỉ hay liên kết.
- **Durability** (`journal.mjs`, `settlement.mjs`): nonce/order, funding receipt và tài nguyên spend (UTXO hoặc nonce EVM) ghi SQLite giao dịch nguyên tử. Ký xong lưu raw bytes và txid **trước** broadcast. Lỗi/mất phản hồi thì tra txid và chỉ gửi lại đúng bytes. Hai cosigner tự kiểm lệnh PQ, funding canonical chưa tiêu và toàn bộ đầu vào/đầu ra/fee/change trước khi lưu quyết định riêng và ký `SIGHASH_ALL`.
- **Hoàn tiền**: funding sai số BTC, quá hạn trước quyết định, hoặc thiếu UTXO đích → chọn hoàn chứ không chi. Với BTC nguồn, cosigner yêu cầu kết quả từ chối/thất bại đã final trên EVM đích; chặn payout lại trên contract, rồi hoàn về script đã ký số sats thực nhận trừ fee đã pin. EVM hoàn đúng giá trị escrow. Nếu payout không rõ đã gửi/đã nhận, reorg mất funding, chữ ký còn có thể được phát lại, refund dưới dust hoặc đích hoàn từ chối, **dừng để đối soát**, không tự trả thêm chân còn lại. `btc_approval_window_closed` không phải đã hoàn: giao dịch Bitcoin ký trước deadline không mất hiệu lực theo consensus khi deadline qua. Sau khi export yêu cầu ký, không tự chuyển sang hoàn chỉ vì thiếu ACK hoặc thiếu một chữ ký. Phí BTC cố định, không tự thay tx/RBF; người vận hành cần quản lý kẹt phí và coin inventory. `review` hoặc `no_spend_available` không được trình bày thành `refunded`.
- **Trust**: ít nhất 2 signer BTC có thể thông đồng bỏ qua policy; Bitcoin chỉ kiểm chữ ký secp256k1, không SLH-DSA. Keeper/treasury EVM vẫn có quyền collect và chi thanh khoản; không chứng minh finality chain kia trên contract. Không trustless, không atomic. Depth BTC không loại bỏ deep reorg. Nếu mất quorum hoặc khóa treasury không có lối thoát admin. Thêm cap, quản trị khóa, đối soát độc lập và audit trước khi nhận tiền người khác. Không tự nhận thêm UTXO ngoài chỉ dẫn một output; nạp dư lần hai/đơn không đăng ký phải xử lý bằng quy trình custody riêng.
