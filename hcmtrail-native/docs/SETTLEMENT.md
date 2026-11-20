# Đặc tả trước khi nhận tiền: pool và swap riêng tư

**Trạng thái:** đây là điều kiện nghiệm thu cho *swap liên mạng*, không phải mô tả một mixer đã chạy. [Bốn vault thử nghiệm](VAULTS.md) chỉ nạp/rút native nội mạng qua STARK. Báo giá có thể tính riêng trong ví từ snapshot giá công khai, không cấp quyền chi note. Chưa có proof đổi giá ràng buộc vào debit, dự trữ, bridge hoặc cấu hình triển khai công khai.

## 1. Tách định giá, quyền chi, dự trữ và finality

- Bốn tài sản native, bốn vault đích; `msg.value` thực nhận mới sinh nghĩa vụ pool. Không sinh tài sản mới ở đích: phải có dự trữ native. Giá USD từ Chainlink là benchmark, không là thanh khoản hay cam kết khớp lệnh. Tại lúc nhận lệnh cần rate thực thi và giữ chỗ dự trữ, kèm phí, trượt giá, deadline và giới hạn exposure cho từng tuyến.
- Một oracle công bố **dữ liệu dùng chung**. Ví lấy epoch và tự tạo lệnh/proof; không gửi note, số tiền, địa chỉ nhận, `minOut` hay IP qua một dịch vụ báo giá theo user. `activeEpoch()` chỉ có ý nghĩa tại block thực thi trên mạng oracle. Proof của một bản ghi cũ `EpochPublished` không chứng minh giá vẫn active khi nhận lệnh. Nếu dùng hub, cần một bước chấp nhận batch kiểm `activeEpoch` cùng giao dịch ở hub, hoặc một bằng chứng tương đương cho trạng thái/thực thi nguồn; các vault phải xác minh head và đúng oracle program/runtime. Payout dùng epoch đã chốt khi chấp nhận, không tính lại giá ở đích.
- Các rail độc lập: Ethereum/BSC/HyperEVM có định dạng và finality riêng; TRON cần kiểm solidified state trên node thực và đánh giá cách xác minh đồng thuận TVM, không tin chuỗi do relayer khai báo. `chainId` một mình không xác định deployment/fork; pin genesis, vault, version/program ID và cam kết deployment. Chainlink Data Feeds không xác minh sự kiện gửi tiền hoặc cứu một payout bị thiếu vốn.
- Tiến trình ngoài chain theo dõi finality, tạo/chuyển proof và tự gửi giao dịch bằng khóa gas (hoặc qua keeper khác). Bất kỳ bên nào cung cấp proof hợp lệ đều có thể gửi; không dùng chữ ký keeper làm quyền chi. Solidity không tự thức dậy lúc hết giờ. Lỗi xác thực, reorg, quá giới hạn, thiếu inventory hoặc trạng thái payout chưa rõ phải dừng thay vì chi lần nữa.

## 2. Quan hệ ZK-STARK phải chứng minh

Nguồn phải chấp nhận root được ghi bởi pool canonical. Witness riêng gồm khóa chi note, giá trị, blinding, đường Merkle, debit, change, mức tối thiểu và mở các commitment; không đưa chúng vào calldata/log ở dạng rõ. Public statement gắn version, domain nguồn, nullifier nguồn, root, epoch xác thực, fee, hạn **nhận lệnh**, commitment change và commitment lệnh đích (mạng, vault, asset, người nhận hoặc quyền claim, giá trị, `minOut`, hạn quyết toán). Lộ cái gì ở public statement phải ghi riêng cho mỗi profile; muốn ẩn tuyến ở nguồn thì tuyến và phép tra giá bốn tài sản phải được kiểm bên trong proof, không đặt hai asset ID thô trong event.

Proof cần kiểm đồng thời:

1. Note thuộc root, trị giá được bảo chứng, người tạo proof có quyền chi. Nullifier nguồn được dẫn xuất ổn định từ note/domain và khóa chi, **không đổi theo đích hay kiểu swap**. Nguồn tiêu thụ cùng một nullifier đối với rút nội bộ hoặc liên mạng. Sau khi trừ, change được tạo đúng bằng `noteValue - debit` và không thể lặp/cấp thêm.
2. `0 < debit <= noteValue`. Các amounts và giá phải đúng miền/số nguyên; circuit phải range-check các limb/carry, không dùng đẳng thức modulo field để thay số học integer. Gọi `N = debit × USD18[src] × units[dst] × (10000 − feeBps)` và `D = USD18[dst] × units[src] × 10000`. Ép `D > 0`, `N = out × D + remainder`, `0 <= remainder < D`, `0 < out <= cap(dst)`, `out >= minOut` và `out <= reserved`. Đây là cùng phép floor như Solidity; cộng một wei hay một sun phải không verify được.
3. Đích chỉ được phát hành quyền claim được cam kết trong batch nguồn đã finalized, đúng domain, và mỗi claim nullifier chỉ dùng một lần. Phải chứng minh liên kết mật giữa giao dịch trao đổi và note đích, không phụ thuộc chữ ký của nhà vận hành. Ngăn reserve được dùng hai lần và nghĩa vụ tổng vượt tồn kho ngay cả khi nhiều batch đến đồng thời. Hash chỉ có ý nghĩa khi prover **kiểm cách tạo hash và các giá trị nó ràng buộc**.
4. Không tự hoàn vì timeout RPC, hết hạn hay không thấy biên nhận. Tách hạn nhận lệnh, thời gian finality và hạn payout. Trước khi khấu trừ không đảo ngược cần dự trữ được khóa đủ lâu, hoặc cơ chế hoàn dựa trên bằng chứng trạng thái cuối đã vô hiệu hóa quyền trả ở đích. Không coi một relay ACK hoặc thiếu event là bằng chứng. Chưa chọn/chứng minh giao thức nguyên tử bốn mạng.

## 3. Mức riêng tư và mô hình đe dọa

- Mục tiêu ẩn liên kết: nhiều lệnh cùng lô rồi tạo **note được bảo chứng ở pool đích**, chứng minh claim riêng và rút sau bằng relayer. Không công khai một `orderId` hay event riêng chung cho cả hai chân. Giới hạn cỡ lô, đệm shape và đo tập ẩn danh thực tế; chịu được quan sát chéo chain, timing, amount, danh tính relayer và liên kết IP. Lô ít người hoặc số tiền đặc trưng vẫn có thể bị đối chiếu. Native transfer ra địa chỉ công khai luôn lộ người nhận và số tiền trả; ZK không che được dữ liệu thanh toán mà consensus công khai.
- Mục tiêu hậu lượng tử ở tầng ứng dụng: STARK **có che witness/auxiliary columns** và transcript/FRI với giả thiết và biên soundness lượng tử rõ ràng. Không lấy STARK bất kỳ hoặc wrapper Groth16/BN254 làm bằng chứng đạt yêu cầu. Ngay cả nếu proof tốt, chữ ký giao dịch, đồng thuận từng mạng, cơ sở hạ tầng Chainlink có mô hình đe dọa độc lập. Không có tuyên bố toàn hệ thống chống lượng tử tuyệt đối.

## 4. Chặn phát hành

1. Chứng minh thật cho **chính quan hệ** ở trên, pin verifier/program/params, chấp nhận proof hợp lệ và từ chối proof bị sửa, giá/epoch khác, fork/vault khác, chi hơn quyền, sai phí, reveal/cancel sai. Không dùng test oracle làm test thanh toán. Audit ZK và độ rộng số nguyên; đo calldata, gas, TVM Energy, kích thước code và hạn mức block.
2. Chạy end-to-end devnet ETH ↔ BNB trước, sau đó TRON bằng java-tron độc lập và HyperEVM bằng testnet; kiểm mỗi hướng xác thực finality, dự trữ, replay, liveness, deep reorg, số tiền thật nhận, phí và hủy lệnh. Thử treo keeper, giá ngừng cập nhật, mất finality và giao dịch không rõ kết quả.
3. Đo privacy trước quan sát đa mạng và side channel; audit độc lập; duyệt chính sách cap, báo giá và triển khai trước khi khóa một phiên bản bất biến. Khi lỗi, chỉ tự từ chối và có kế hoạch rời/migrate theo quy tắc đã công bố, không có khóa admin cứu bằng cách lờ verifier.
4. Chỉ cắt sang bản mới, đối soát nghĩa vụ còn lại và dọn code cũ sau khi bản thay thế qua các mục trên. Xóa cây nguồn cũ không xóa các contract hoặc lịch sử Git của phiên bản đó.
