# hcmtrail native · Oracle lab

**Mã nguồn riêng cho hướng mới, chưa phải mixer.** Không nhận tiền, không có địa chỉ triển khai công khai, không có quyền chi hay verifier settlement giả. Không phụ thuộc vào code ví/swap cũ.

| Tài sản native | Mạng | Chain ID | Đơn vị cơ sở |
| --- | --- | ---: | --- |
| ETH | Ethereum | `1` | `10^18` wei / ETH |
| BNB | BNB Smart Chain | `56` | `10^18` / BNB |
| TRX | TRON | `0x2b6653dc` (TVM Mainnet) | `10^6` sun / TRX |
| HYPE | HyperEVM | `999` | `10^18` / HYPE |

Không có wrapper hoặc stablecoin. 12 chiều **định giá**, không phải 12 cầu thanh toán.

## Chạy độc lập

Node.js 22+, trong thư mục này:

```sh
npm ci --ignore-scripts
npm run build
npm test
npm run demo
```

Demo deploy một oracle và bốn feed giả lập lên EVM **trong bộ nhớ**, tự gọi `refresh()` từ keeper khác deployer, rồi chạy 12 báo giá. Không dùng RPC hoặc ví bên ngoài. Chẳng hạn với ETH = 3.000 USD, BNB = 625 USD, HYPE ≈ 67,123456789 USD và phí giả lập 30 bps, `1 ETH` tương ứng `4,7856 BNB` hoặc `44,559683649816982014 HYPE`, trước phí mạng và giới hạn thanh khoản.

Kiểm thêm trên Linux x86-64:

```sh
bash scripts/fetch-tron-solc.sh /tmp/hcmtrail-native-tron-solc
TRON_SOLC=/tmp/hcmtrail-native-tron-solc npm run build -- --tvm
TRON_SOLC=/tmp/hcmtrail-native-tron-solc npm run test:tvm
npm run test:fhe  # C/C++ compiler, curl, tar, patch, Linux getrandom; tải TFHE đã pin
```

TVMJS kiểm thực thi bytecode biên dịch bằng compiler TRON. Đây không phải java-tron node, không kiểm TAPOS, phí Energy thực hay đồng thuận/finality. Bài kiểm STARK công khai của upstream có hướng dẫn riêng ở [REFERENCES.md](docs/REFERENCES.md).

`npm run bundle` tạo `dist/hcmtrail-native-source.tar.gz` bằng GNU tar. Giải nén vào một thư mục rỗng; gói chỉ gồm mã nguồn, test, lockfile và tài liệu của module này.

## Contract làm gì?

[`ChainlinkPriceEpochs.sol`](contracts/ChainlinkPriceEpochs.sol) gọi `decimals()` và `latestRoundData()` trên bốn proxy **cùng chain**. Policy chỉ đặt ở constructor, không admin/setter/proxy nâng cấp. `refresh()` nhận **không tham số**; ai cũng có thể tự động gửi giao dịch. Contract loại round sai/giá cũ/quá bounds/lệch timestamp, đóng khi sequencer không lành nếu cấu hình L2, và không cho lệnh chọn epoch lịch sử sau cập nhật. Không dùng giá cũ khi feed lỗi. Giá cập nhật cho epoch tương lai; không đổi rule hoặc núm phí của deployment.

[`NativeAssets.sol`](contracts/NativeAssets.sol) tính đúng một phép floor theo tỷ số hai giá USD18, đổi về đơn vị của **asset đích** và trừ fee bps cố định. Không nhận `tokenDecimals` do caller khai báo, không lẫn sun và wei, từ chối dust, số quá miền, cùng asset và `minOut` không đạt. Đây chỉ là số tham chiếu, không phải quyền rút. Đừng truyền số tiền riêng tư vào `quote()` kể cả thông qua RPC `eth_call`; ví đọc `activeEpoch()` công khai và tính cục bộ. `publishedEpoch()` có thể trả lịch sử đã hết hiệu lực.

- [CHAINLINK.md](docs/CHAINLINK.md): địa chỉ chuẩn/precision/heartbeat đã đối chiếu và lựa chọn hub. Chưa pin manifest chạy mainnet.
- [SETTLEMENT.md](docs/SETTLEMENT.md): quan hệ ZK-STARK, dự trữ, giao thức chống chi hai lần và tiêu chí trước khi triển khai.
- [REFERENCES.md](docs/REFERENCES.md): clone, pin và kiểm lab TFHE/STARK. Hai bài kiểm **chưa ghép** thành một proof của mixer. Code hợp đồng là Solidity; sinh proof, thực thi FHE và relayer phải chạy ngoài chain nếu muốn giữ witness riêng tư.

**Không chuyển tài sản vào contract.** Bản này không có payout, deposit, relayer sản xuất hay lối admin thu hồi tiền. Nếu native balance bị đẩy trực tiếp vào địa chỉ mà không thực thi contract, điều đó không cấp quyền rút. Không xóa nguồn cũ hay đổi deployment cho đến khi có bản thay thế đã được kiểm chứng.
