# Lưu trữ: mô phỏng BTC, ETH và BNB trên 10 mạng

**Không nạp tiền thật.** Oracle RPC chỉ đọc và catalog độc lập với [vault ETH SLH-DSA](../PROTOCOL_DESIGN.md), vốn chỉ nạp/rút trên cùng một EVM. [Luồng note v3 lưu trữ](NOTE-GIA-TRI.md) chỉ báo giá và ghi chi **mô phỏng** giữa 10 sổ native. [Đường settlement mới](NATIVE-SWAP.md) không dùng note và chỉ bật được ba mạng gốc BTC, ETH, BNB với rail/UTXO được cấu hình; chưa bật public. Catalog 10 mạng chỉ dùng trong simulator lưu trữ. [Mobubu Pool hiện tại](SHIELDED-POOL.md) không có tuyến L2.

## 1. Coin và mạng là hai phần của định danh

| ID trong Mobubu | Mạng mainnet | Chain ID EVM | Coin / độ chính xác |
| --- | --- | ---: | --- |
| `ETH@ethereum` | [Ethereum Mainnet](https://ethereum.org/en/developers/docs/networks/) | 1 | ETH / 18 |
| `ETH@arbitrum-one` | [Arbitrum One](https://docs.arbitrum.io/for-devs/dev-tools-and-resources/chain-info) | 42161 | ETH / 18 |
| `ETH@optimism` | [OP Mainnet](https://docs.optimism.io/superchain/networks) | 10 | ETH / 18 |
| `ETH@base` | [Base](https://docs.base.org/base-chain/quickstart/connecting-to-base) | 8453 | ETH / 18 |
| `ETH@zksync-era` | [ZKsync Era](https://docs.zksync.io/zksync-network/zksync-era/network-details) | 324 | ETH / 18 |
| `ETH@linea` | [Linea](https://docs.linea.build/get-started/build/network-info) | 59144 | ETH / 18 |
| `ETH@scroll` | [Scroll](https://docs.scroll.io/en/user-guide/setup/) | 534352 | ETH / 18 |
| `ETH@robinhood` | [Robinhood Chain](https://docs.robinhood.com/chain/connecting/) | 4663 | ETH / 18 |
| `BNB@bsc` | [BNB Smart Chain](https://docs.bnbchain.org/bnb-smart-chain/introduction/) | 56 | BNB / 18 |
| `BTC@bitcoin` | [Bitcoin](https://developer.bitcoin.org/reference/rpc/getblockhash.html) | — | BTC / 8 |

Robinhood mainnet dùng `4663`, **không** dùng testnet `46630`. BTC được nhận diện bằng genesis Bitcoin mainnet (`bip122`), không giả lập EVM chain ID. ETH native trên rollup là số dư dùng được trực tiếp để trả gas trên mạng đó, không phải WETH; giá tham chiếu chung không đồng nghĩa có thể chi cùng một note trên hai mạng.

[Catalog](../legacy/groth16/src/network-catalog.mjs) đóng đúng 10 ID, không wrapped, token hay cặp coin–mạng ngoài bảng. Có 90 chiều liên mạng (`10 × 9`) trong mô phỏng. `ETH@base → ETH@optimism` phải có dự trữ ETH độc lập trên cả hai mạng, nhận số lượng theo báo giá; không mặc định 1:1. Cùng ID, như `BNB@bsc → BNB@bsc` hoặc `BTC@bitcoin → BTC@bitcoin`, là **rút/chuyển note cùng mạng** ở ngang giá, không qua FX hay tính phí FX mô phỏng. CLI vẫn chấp nhận `ETH`, `BNB`, `BTC` cho ba mạng gốc; API ledger bắt buộc dùng `COIN@network`.

```bash
npm ci
npm run networks   # catalog active: Bitcoin, Ethereum, BSC
# Riêng cho simulator v3 lưu trữ:
npm --prefix legacy/groth16 ci
npm --prefix legacy/groth16 run demo:notes -- ETH@base ETH@arbitrum-one 0.2 0.1
npm --prefix legacy/groth16 run demo:notes -- BNB@bsc ETH@robinhood 5 0.1
npm --prefix legacy/groth16 run demo:notes -- --note ETH@base ETH@optimism 0.2 0.01
```

Dòng `--note` không phát giao dịch; chỉ ghi một note riêng cho bên nhận trong RAM. Các demo dùng giá và dự trữ mẫu, không gọi RPC.

## 2. Oracle: tham chiếu USD, không phải thanh khoản

[`chainlinkReader`](../packages/oracle/src/chainlink.mjs) đọc proxy Chainlink chuẩn cho **BTC/USD, ETH/USD, BNB/USD** trên Ethereum và BSC. Đây là hai mạng nguồn cho toàn bộ tuyến, không cần đặt feed trên cả 10 mạng. Giá ETH giữa các mạng dùng cùng tham chiếu USD; oracle **không** đo chênh lệch thanh khoản giữa các mạng, phí gas, phí bridge, spread hay thời gian hoàn tất. Không đọc giá spot từ chính pool sắp swap. Không cấp quyền ký hay chuyển tiền, không dùng giao thức nhắn tin liên chuỗi.

- Địa chỉ và độ chính xác feed được pin trong [policy](../packages/oracle/src/feed-policy.mjs). Đối chiếu các feed chuẩn: Ethereum [BTC](https://data.chain.link/feeds/ethereum/mainnet/btc-usd), [ETH](https://data.chain.link/feeds/ethereum/mainnet/eth-usd), [BNB](https://data.chain.link/feeds/ethereum/mainnet/bnb-usd); BSC [BTC](https://data.chain.link/feeds/bsc/mainnet/btc-usd), [ETH](https://data.chain.link/feeds/bsc/mainnet/eth-usd), [BNB](https://data.chain.link/feeds/bsc/mainnet/bnb-usd).
- Kiểm tra `eth_chainId` trước/sau batch, chỉ chọn block theo tag `finalized`, pin mọi `eth_call` của một mạng vào cùng block hash với `requireCanonical: true` ([EIP-1898](https://eips.ethereum.org/EIPS/eip-1898)). API nhận HTTPS từ cấu hình vận hành, không redirect; giới hạn thời gian và kích thước response; không forward phương thức từ người dùng. BSC có [tag `finalized`](https://docs.bnbchain.org/bnb-smart-chain/developers/json_rpc/bsc-api-list/). RPC thiếu hỗ trợ thì từ chối, **không** hạ xuống `latest`.
- [`CrossChainOracle`](../packages/oracle/src/market-oracle.mjs) từ chối thiếu feed, giá không dương, timestamp sai/cũ, lệch precision, block/round đi lùi hoặc đổi ở cùng anchor. Đối chiếu hai giá của mỗi coin, dừng nếu lệch hơn **150 bps so với giá thấp hơn**. Sau đó lấy trung bình bằng `BigInt` ở scale USD `1e18`. Đây vẫn là **cùng nhà cung cấp Chainlink** ở hai mạng, không phải hai nguồn độc lập về dữ liệu hoặc hai light client.
- Giới hạn nghiên cứu: tuổi *block* ≤ 30 phút trên Ethereum, ≤ 180 giây trên BSC; tuổi *round* theo policy: ETH/BTC Ethereum 5.400 giây, BNB Ethereum 7.200 giây, các feed BSC 1.800 giây. Snapshot hết hạn tại mốc sớm nhất của các giới hạn trên và 5 phút sau refresh. Đây không phải heartbeat/SLA. Feed còn hoạt động nhưng quá ngưỡng, hai feed lệch mạnh khi thị trường biến động, node lỗi hoặc đang refresh thì dừng báo giá liên mạng. Rút cùng mạng vẫn hoạt động trong mô phỏng.
- Pool XYK quyết định số thực nhận/trừ. So giá trị USD của hai vế bằng phép nhân nguyên với đúng 8/18 chữ số; quote lệch > **200 bps** so với giá trị đầu vào bị từ chối. Bao gồm phí pool và trượt giá mô phỏng; ngưỡng chưa phải định mức production. `oracleId`, tuyến/chain đích, số tiền, đích nhận, revision và deadline nằm trong binding của proof. Sau khi chờ xác minh, ledger kiểm lại snapshot và toàn bộ quote trước commit. Đổi snapshot giữa chừng phải báo giá và chứng minh lại; không âm thầm đổi số tiền.

**Đọc giá thật, không giao dịch:** đặt các biến `MOBUBU_ETHEREUM_RPC_URL` và `MOBUBU_BSC_RPC_URL` trong môi trường hoặc `.env` đã ignore; chạy `npm run oracle:read` nếu biến đã được export, hoặc `node --env-file=.env scripts/read-oracle.mjs`. Dùng endpoint hỗ trợ block hash EIP-1898. `MOBUBU_NETWORK_RPC_URL` dùng riêng cho `npm run networks -- --probe <network>`, chỉ `bitcoin`, `ethereum` hoặc `bsc`. Probe chỉ so chain ID (hoặc genesis ở Bitcoin); không chứng minh node trung thực, đã sync hay giao dịch đạt finality. Không công khai Bitcoin Core RPC; với node cục bộ có thể dùng `bitcoin-cli getblockhash 0` để kiểm genesis. Trình probe Bitcoin chỉ nhận endpoint HTTPS JSON-RPC 2.0 đã cấu hình an toàn. Lượt này kiểm parser và đường lỗi bằng fixture RPC, không xác minh endpoint mainnet trực tiếp từ sandbox.

## 3. Việc cần làm trước khi bật từng mạng

| Nhóm | Kiểm tra bắt buộc, không suy từ các mô phỏng |
| --- | --- |
| Ethereum mainnet | Pin code hash vault SLH-DSA và kiểm runtime SHA-256; đọc receipt/log canonical trên block finalized; ID nạp gồm chain/vault/tx/log hoặc output nhận; theo dõi gas và nonce. |
| Arbitrum One và Robinhood Chain | Kiểm bằng node Nitro và ghi nhận batch/parent chain, phân biệt sequencer preconfirmation với finality theo L1. Xác minh phí gồm phần đăng dữ liệu L1, thời gian thoát và tình huống sequencer không nhận order. Không sao chép policy Ethereum chỉ vì dùng ETH. Robinhood có [khác biệt riêng](https://docs.robinhood.com/chain/differences-from-ethereum/). |
| OP Mainnet và Base | Test `unsafe`/`safe`/`finalized`, L1 reorg, downtime/recovery và phí L1 + L2; các tag và phí không phải cam kết có khả năng rút ngay từ cầu. |
| ZKsync Era, Linea, Scroll | Test từng runtime/compiler và chi phí kiểm SLH-DSA nếu dùng vault đó; kiểm stage batch/prove/finalize theo chain, phí và con đường thoát. Không coi EDR local là test các runtime này. |
| BNB Smart Chain | Tách native BNB, signer, nonce và LP inventory khỏi ETH. Chốt policy fast-finality BSC và xử lý lúc finality dừng hoặc provider phân kỳ. |
| Bitcoin | Dùng full node, kiểm đúng script/UTXO nhận và `txid:vout`, confirmations/reorg, sats/vbyte, coin selection, dust, change, RBF/CPFP; cơ chế custody và signing BTC khác EVM. Không phải ERC-20. |

Nếu sau này đọc giá trực tiếp từ L2, cần kiểm sequencer uptime và grace period sau phục hồi theo [Chainlink](https://docs.chain.link/data-feeds/l2-sequencer-feeds) hay tín hiệu vận hành đã thẩm định riêng cho mạng đó. Ngay cả khi giá đọc từ L1, vẫn phải tạm ngừng từng lane khi mạng nạp hoặc chi không đủ finality, không còn thanh khoản dành riêng hoặc vượt phí/chính sách. Không cấp phát đích chỉ từ giá. Xem [audit nội bộ và tiêu chí mở lane](AUDIT-SWAP-10-MANG.md).
