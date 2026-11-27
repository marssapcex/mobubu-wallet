# ETH pool — ngưỡng phát hành 256 bit cổ điển

**Trạng thái: không phát hành.** Ngưỡng tối thiểu của proof **chi note** là **256 bit soundness cổ điển**. Mục tiêu **128 bit an toàn lượng tử** cần phân tích riêng trên đúng giao thức và triển khai được pin; không suy ra bằng phép chia đôi. Không có profile chi note nào được duyệt. Điều kiện này áp dụng cho pool ETH, không phải đánh giá các vault hoặc mạng khác trong repo.

| Profile | Đã có | Cho phép custody |
|---|---|---|
| NotBefore A | Devnet chi ETH thử, soundness cổ điển ~80,1 bit theo upstream | Không. Contract legacy chỉ cho phép chain ID lab 31337–31339. |
| HCFR v2 | FRI 144 query, Fₚ⁸; thử trên Osaka EVM local | Không. Chưa có AIR chi note, chưa có cận cho giao thức chi note hay cho đối thủ lượng tử. |

`npm run pool:eth`, `build:pool` và `build:pool:256` từ chối theo `pool/release-policy.mjs`. Không tự chạy legacy. Chỉ `npm run pool:eth:legacy` và các lệnh [lab explicit](ETH-POOL.md) dùng được với bản cũ, trên ETH thử. Không có cờ bỏ qua ngưỡng phát hành, không nhận một con số từ caller làm chứng cứ.

## Vì sao không dùng quy tắc “chia đôi” cho cả STARK

Với hash **lý tưởng** có output `n` bit, tìm preimage của một đích cố định có chi phí generic khoảng `2^n` cổ điển hoặc `2^(n/2)` query lượng tử (Grover). Tìm **một cặp va chạm tùy ý** là bài toán khác: birthday search cổ điển khoảng `2^(n/2)`, [Brassard–Høyer–Tapp](https://arxiv.org/abs/quant-ph/9705002) khoảng `2^(n/3)` quantum query với giả định truy cập bộ nhớ tương ứng. Đây là mô hình query, không phải thời gian hay số gate thực tế. Digest 256 bit vì vậy không đủ để dựa vào giả định **256 bit chống va chạm cổ điển**, và không tự bảo đảm 128 bit chống va chạm lượng tử. Với digest 512 bit, các mốc generic cho va chạm lần lượt là khoảng `2^256` và `2^170,67`, **không phải** cận cho cả pool.

Một bound tương tác, một cận ROM cho Fiat–Shamir và một cận QROM là ba kết quả riêng. [CMS19, Theorem 8.6](https://eprint.iacr.org/2019/834.pdf) phân tích biến đổi BCS cụ thể trên IOP thỏa round-by-round soundness/knowledge. Các hạng tử có dạng `O(t²·ε + t³/2^λ + qᵥ log ℓ/2^λ)` với `t` là ngân sách oracle lượng tử (cần tính phần kiểm chứng theo định lý), `ε` là sai số IOP thích hợp, `λ` là số bit output oracle, `qᵥ` và `ℓ` liên quan tới số truy vấn/độ dài oracle của IOP. Không áp định lý thẳng vào một transcript tự ghép hoặc một hash cụ thể chỉ vì có cùng chiều rộng. NIST [định nghĩa Category 5](https://csrc.nist.gov/csrc/media/Projects/pqc-dig-sig/documents/call-for-proposals-dig-sig-sept-2022.pdf) bằng so sánh tài nguyên tấn công với tìm khóa AES-256; nó không phải nhãn tự động cho STARK, hay chứng nhận dựa trên digest 512 bit.

## HCFR v2: đã chạy FRI, chưa chạy chi note

- Challenge dùng `Fₚ[t]/(t⁸−7)` với `p = 2^64 − 2^32 + 1`; `8 | p−1`, `p ≡ 1 mod 4` và `7^((p−1)/2) = −1 mod p` cho tiêu chuẩn binomial bất khả quy. Tám word `u64` LE, từng word `< p` (reject toàn mẫu nếu có word không canonical, tối đa 8 lần; không reduce modulo). Cam kết Merkle, state transcript và khóa phiên đều giữ đủ **512 bit BLAKE2b**; dùng EIP-152 để tính digest. Proof v1/NOXP không tương thích với v2.
- `D = 2^18`, `N = 2^24`, rate `1/64`, sáu fold radix 8 đến một hệ số cuối, **144 query** với hoàn lại, không tính grinding.
- **Đo được**, không phải dự toán: proof đa thức thưa không hằng trên domain thực `2^24`, **1.189.320 byte**; verifier **6.645 / 6.617 byte** initcode/runtime (solc 0.8.24/Paris/viaIR/optimizer 200). Mở phiên 118.536 gas, 48 giao dịch kiểm 3 query (**10.256.467–10.277.832 gas/giao dịch**, 492.562.503 gas tổng) trên EDR Osaka. Gom proof mẫu một giao dịch riêng calldata đã tối thiểu 47.454.270 gas theo EIP-7623, lớn hơn trần `2^24` của EIP-7825. Kết quả chỉ đo FRI; không suy ra gas của cả AIR. Việc chia kiểm proof không đổi yêu cầu trả cả lô trong một giao dịch nguyên tử.
- Test đối chiếu field và transcript với prover tham chiếu, kiểm đủ 144/144, từ chối v1/NOXP, sai context/header/path, word không canonical, thiếu dữ liệu và terminal sai dù path đúng. Prover tối ưu bằng chu kỳ đa thức; một mẫu mất khoảng 0,5 giây ở Node và 2,2 giây ở Chromium 131, trùng byte (SHA-256 `ebbb8ca639195e152a8b4c69f4097eb3f759b1e8f2d4eb2b076159a280bb81dc`). Không phải WASM cho witness chi note. Một codeword Fₚ⁸ dense riêng đã cần **1 GiB** trước Merkle/trace. Không gửi note hay ETH cho verifier nghiên cứu.

### Wire HCFR v2

- [Verifier và thư viện](CONTRACTS.md#hcfr-v2--nghiên-cứu-hướng-hậu-lượng-tử) dùng miền `hcmtrail/eth-pool/stark256/research/v2` và một byte phân loại ở đầu từng preimage BLAKE2b-512. Trường độ dài và counter là `u32` big-endian. Context tối đa 1.024 byte. Header 456 byte gồm magic `4843465202081890`, sáu root Merkle 64 byte và một hệ số cuối Fₚ⁸ 64 byte.
- Transcript bắt đầu bằng magic ghép context, lần lượt hấp thụ root trước lấy challenge mỗi lớp. Hệ số cuối được hấp thụ trước lấy vị trí query. Mỗi block lấy vị trí gồm tám word little-endian, dùng 24 bit thấp mỗi word. Record query 8.256 byte: mỗi lớp có một lá 512 byte và đường Merkle tương ứng sâu `21,18,15,12,9,6`.
- `open` ghim đủ 512 bit của khóa phiên tính từ context và header. `check` đối chiếu lại khóa phiên, kiểm tối đa 3 query liên tiếp đúng thứ tự và chỉ tăng cursor khi mọi opening/fold trong cửa sổ đều hợp lệ. `progress.complete` chỉ là kết quả FRI sau đủ 144 query, không cấp quyền chi tiền.

### Số học chọn tham số, không phải chứng cứ phát hành

[Worksheet hiện hành](../pool/stark256-profile.mjs) dùng trường `p⁸`, rate `1/64`, `m = 3`, hạng tử Johnson và xác suất query `(7/48)^144`. Các hạng tử composition/copy/OOD/DEEP **vẫn là hạn mức cho phần chưa có**, chưa thỏa giả thiết bằng code chi note.

| `−log₂(hạng tử)` | HCFR v2 (nghiên cứu) |
|---|---:|
| Tổng hạng tử fold | 438,54 |
| Query (cận bán kính proven đưa vào worksheet) | 399,98 |
| Union đại số có điều kiện | 399,98 |
| Chiếu ROM ở ngân sách giả định `Q = 2^48` (không phải work factor tại `2^256`) | 351,98 |
| Riêng quy mô `t²·ε` ở `t = 2^128`, chưa có hệ số | 143,98 |
| Riêng quy mô `t³/2^λ` ở `t = 2^128`, chưa có hệ số | 128 |

Hai hàng cuối là **hai thành phần** để chọn tham số, không phải bound tổng, không được dùng để tuyên bố “128 bit PQ”. Ví dụ nếu yêu cầu xác suất chấp nhận sai `≤2^-128` ngay cả tại `2^128` quantum query, chỉ hạng tử hash chưa tính hệ số đã dùng hết ngân sách của ví dụ; cần thêm margin và phép giảm trừ thực tế. Còn nếu yêu cầu **work factor** `2^128`, phải phát biểu tiêu chí xác suất thành công và mô hình tài nguyên tương ứng. Xác suất, work factor và số bit digest không thay thế nhau.

## Còn thiếu trước khi dùng ETH thật

1. **Đúng quan hệ chi note:** chứng minh kiến thức witness sở hữu note, membership, nullifier, số wei chính xác, change, thời gian và mọi điều khoản payout/refund. Nối query FRI lớp 0 với trace/composition/OOD/DEEP và kiểm cả wiring, không nhận `WideFri256.progress().complete` làm quyền chi. Masking, rank, entropy và chứng minh zero knowledge phải xét lại với bề rộng mới.
2. **Binding và phiên bản:** thay digest note/tree và nén điều khoản 256 bit (hoặc 222–223 bit với 1 wei) của lab; bind đầy đủ deployment, phiên bản, mode, recipient, số wei, ticket/round/target và refund owner. Không import proof, note hoặc nullifier legacy vào bản mới. Kiểm mọi primitive, độ rộng và giả thiết về preimage, collision/collapsing, multi-target và entropy; không chỉ tăng hash của Merkle FRI.
3. **Cận theo code và review độc lập:** classical ≥256 cho proof chi note đã pin và phân tích riêng cho mục tiêu quantum 128, gồm Fiat–Shamir/BCS dùng thật, adaptive knowledge soundness, chi phí oracle và commitments cùng các điều kiện của định lý. Có kiểm thử WASM tạo proof thật, tiền thử đi qua trực tiếp/giữ chỗ/chi nguyên tử/hoàn note; xét giới hạn calldata, tx và kích thước code. Mọi mục còn thiếu đều giữ khóa phát hành.
4. **Ranh giới Ethereum:** ngay cả nếu quyền chi note đạt mục tiêu, điều đó không nâng cấp chữ ký tài khoản Ethereum, đồng thuận của chain, nơi nhận ETH hoặc quyền riêng tư ngoài giao thức. Không gọi toàn mạng hay toàn vòng đời tài sản là hậu lượng tử dựa vào STARK.

```sh
npm --prefix hcmtrail-native run report:pool:256 # worksheet và releaseAllowed=false
npm --prefix hcmtrail-native run test:pool:256   # FRI + kiểm tra khóa release
npm --prefix hcmtrail-native run build:pool:256  # chủ ý lỗi, không có artifact custody
```
