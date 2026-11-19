# Chainlink: cấu hình feed không phải cấu hình cầu

**Bản lab chỉ deploy oracle trên VM cục bộ với feed fixture.** Dưới đây là proxy chuẩn theo registry, không phải deployment manifest. Không trộn proxy chuẩn với proxy SVR; cùng tên cặp có thể có nhiều proxy và độ chính xác khác nhau.

## Feed tham chiếu trên bốn mạng tài sản

| Chain có proxy | Cặp | Standard proxy | Decimals feed | Heartbeat / deviation trong registry |
| --- | --- | --- | ---: | --- |
| Ethereum Mainnet | ETH/USD | `0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419` | 8 | [3.600 s / 0,5%](https://docs.chain.link/data-feeds/price-feeds/addresses?network=ethereum&search=ETH%20%2F%20USD) |
| BNB Chain Mainnet | BNB/USD | `0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE` | 8 | [27 s / 0,1%](https://docs.chain.link/data-feeds/price-feeds/addresses?network=bnb-chain&search=BNB%20%2F%20USD) |
| TRON Mainnet | TRX/USD | `0x175fa5B93CA066D9Acd2E4c9Bf68c50865713C4b` | 8 | [86.400 s / 0,5%](https://docs.chain.link/data-feeds/price-feeds/addresses?network=tron&search=TRX%20%2F%20USD) |
| HyperEVM Mainnet | HYPE/USD | `0xa5a72eF19F82A579431186402425593a559ed352` | 8 | [86.400 s / 0,5%](https://docs.chain.link/data-feeds/price-feeds/addresses?network=hyperevm&search=HYPE%20%2F%20USD) |

TRON JSON API: prefix `41` trước 20 byte của proxy, hoặc [Base58Check `TC6o8AakUg4Xz9nHY9qXpJNsgF7CQkwBqF`](https://data.chain.link/feeds/tron/tron/trx-usd). Đã kiểm checksum EIP-55 của các hex và kiểm Base58Check khớp payload. **Precision của feed TRX/USD là 8; native TRX là 6.** Tương tự, native HYPE trên [HyperEVM](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm) là 18. Không dùng WETH/WBNB/WTRX/WHYPE hoặc stablecoin làm định danh tài sản. Không chọn feed theo ticker rồi giả định có ở mọi mạng.

## Một hợp đồng đọc trực tiếp bốn feed

Một `CALL`/`STATICCALL` trên Ethereum không đọc hợp đồng của ba mạng còn lại. Bốn địa chỉ ở bảng trên không thể truyền gộp vào một oracle như bốn địa chỉ local. Có hai lựa chọn:

1. **OP Mainnet chỉ làm hub giá** (chain ID `10`, ứng viên, không giữ tiền và không thêm asset). Tất cả bốn feed chuẩn ở cùng mạng nên `ChainlinkPriceEpochs` có thể đọc trực tiếp cả bốn. Nhưng bốn vault vẫn phải xác minh epoch **đã chấp nhận trên OP** bằng chứng external state, và thêm giả thiết OP/L1 finality và uptime. Địa chỉ sequencer uptime [theo Chainlink](https://docs.chain.link/data-feeds/l2-sequencer-feeds) là `0x371EAD81c9102C9BF4874A9075FFFf170F2Ee389`; lab chặn khi sequencer down, trong grace period và khi giá trước lúc phục hồi.
2. **Chỉ bốn mạng**: một sổ epoch canonical trên một trong bốn, nhưng lấy các giá còn thiếu bằng bằng chứng giá/trạng thái đã finalized từ mạng có feed. Cần adapter/light client cho mỗi nguồn; một relayer chuyển số không thay thế proof. Không trộn round tùy tiện giữa proxy khác mạng. Chưa chọn phương án production.

| Cặp trên OP | Standard proxy (không phải địa chỉ ở bảng trên) | Decimals | Heartbeat / deviation |
| --- | --- | ---: | --- |
| ETH/USD | `0x13e3Ee699D1909E989722E753853AE30b17e08c5` | 8 | [1.200 s / 0,15%](https://docs.chain.link/data-feeds/price-feeds/addresses?network=optimism&search=ETH%20%2F%20USD) |
| BNB/USD | `0xD38579f7cBD14c22cF1997575eA8eF7bfe62ca2c` | 8 | [1.200 s / 0,2%](https://docs.chain.link/data-feeds/price-feeds/addresses?network=optimism&search=BNB%20%2F%20USD) |
| TRX/USD | `0x0E09921cf7801A5aD47B892C8727593275625a9f` | 8 | [86.400 s / 0,5%](https://docs.chain.link/data-feeds/price-feeds/addresses?network=optimism&search=TRX%20%2F%20USD) |
| HYPE/USD | `0x961f6a07bFc62F618a4fA737eDe08F23aD6Da67F` | 8 | [86.400 s / 0,5%](https://docs.chain.link/data-feeds/price-feeds/addresses?network=optimism&search=HYPE%20%2F%20USD) |

### Trước khi pin deployment thật

- Dùng nhiều RPC độc lập, kiểm chain/genesis và một block được finalized (solidified với TRON). Kiểm bytecode proxy, registry/deprecation, `description()`, `decimals()` và các trường `latestRoundData()` trên chính mạng đó. Ghi block hash/round và checksum; không nhầm feed giá với token hay OCR aggregator implementation. Chưa chạy live RPC ở module này.
- `answer > 0`, `roundId != 0`, `updatedAt != 0` và không trong tương lai. `answeredInRound` được [tài liệu API](https://docs.chain.link/data-feeds/api-reference#latestrounddata) đánh dấu deprecated; không dùng thay freshness. So bounds của *ứng dụng* theo USD18; báo start/stop và độ lệch giữa feed/nguồn tham chiếu. Proxy có thể đổi aggregator, dtype/feed có thể ngừng; config bất biến không làm nguồn dữ liệu bên ngoài bất biến.
- Heartbeat và deviation là ngưỡng **kích hoạt cập nhật**, không đảm bảo price là executable, không phải SLA. Không có chuẩn luôn dùng `heartbeat × 1,5`. Chọn max age, lệch timestamp, bounds và notional caps theo biến động của asset, thanh khoản, độ trễ finality và liveness đo được. TRX/HYPE heartbeat theo ngày: nới stale thành 25 giờ cho swap nhanh có thể cho phép trade trên giá cũ; thắt chặt thì một số phiên/tuyến phải đóng. Dùng [hướng dẫn rủi ro Chainlink](https://docs.chain.link/data-feeds/selecting-data-feeds). Cân nhắc nguồn giá mới hơn và kiểm độc lập trước khi bật tuyến thật, không tự động hạ chuẩn khi feed hỏng.
- Bản hợp đồng lab lấy cả bốn round cùng lần thực thi, chặn timestamp skew, cập nhật lùi, decimals đổi; `validUntil = min(updatedAt + maxAge)`, mốc không bao gồm. Nếu có round mới, phải refresh chứ không được tự chọn epoch lịch sử. `refresh()` không nhận tham số, không kéo dữ liệu từ chain khác. Một lệnh lỗi bất kỳ làm epoch bốn giá không khả dụng; đó là lựa chọn an toàn có đánh đổi liveness, không có fallback silent.
