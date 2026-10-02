# Xác minh trên máy của bạn

Các bước dưới đây kiểm tra phần cần tài khoản / browser / OS thực tế. Chúng là hướng dẫn để bạn thực hiện, **không phải kết quả đã chạy**. Không gửi token, cookie, Client Secret, khóa bridge hay password vào cuộc trò chuyện hoặc ảnh chụp.

## Khởi chạy

1. Cài Node.js 24 LTS từ 24.15.0 kèm npm, giải nén toàn bộ ZIP.
2. Windows: mở `start-windows.cmd`. macOS/Linux: `sh start-unix.sh`. Hoặc `node scripts/launch.mjs`.
3. Nếu thiếu dependency runtime, hoặc thiếu công cụ build khi chưa có `dist`, trình khởi chạy tự chạy `npm ci --include=dev`. Nếu thiếu `dist`, tự chạy build. Cờ include đảm bảo có công cụ build kể cả khi môi trường đặt `NODE_ENV=production`. Không tự cài Node, không tạo credential, không đổi cấu hình mạng.
4. Mở http://127.0.0.1:3210. Chạy thử timeline mẫu, kiểm tra pause/tua và cảnh báo preview. Sau restart, dry run phải bật.
5. Muốn kiểm tra môi trường mà không khởi chạy/cài gì: `node scripts/launch.mjs --check`. Mã thoát 0 = Node/dependency/dist sẵn sàng; 2 = thiếu dependency hoặc build; 1 = Node không phù hợp hoặc tham số không hợp lệ. Kiểm tra này không xác minh Discord, Spotify hay kho OS.

Wrapper `start-windows.cmd` và nhánh npm qua cmd.exe chưa chạy trên Windows thật. Kiểm tra bootstrap/SIGTERM tự động dành cho Linux/macOS; test SIGTERM được skip trên Windows vì kill signal không có cùng hành vi. Trên mọi OS, tắt đồng bộ và chờ restore ở dashboard trước khi đóng cửa sổ server.

## Discord cá nhân

1. Kết nối từ tab Tài khoản bằng thông tin xác thực bạn tự cung cấp cục bộ. OAuth identify chỉ dùng để kiểm tra danh tính; để thử Custom Status, chọn adapter user token và xác nhận giới hạn self-bot.
2. Kiểm tra avatar/tên/ID khớp tài khoản của bạn. Nếu legacy settings không hỗ trợ, dừng ở thông báo đó; không coi preview hoặc bot Activity là gửi status cá nhân.
3. Với lyrics bạn có quyền, chọn Custom Status, bỏ dry run, lưu và bật. So sánh “Đang chờ”, “Gửi gần nhất” và “Dịch vụ xác nhận”. Tự mở Discord client để quan sát dòng hiển thị; response settings không chứng minh client đã hiện đúng.
4. Pause, tua và đổi bài trong player thật. Do pacing ≥15 giây, không yêu cầu mọi dòng ngắn xuất hiện. Sau pause hoặc mất nguồn, không được tiếp tục gửi hàng loạt dòng cũ.
5. Tắt đồng bộ; chờ restore hoàn tất rồi kiểm tra trạng thái gốc. Sau đó mới ngắt tài khoản / đóng server. Không đóng cưỡng bức để kiểm tra restore rồi kết luận chắc chắn thành công.

## Spotify và YouTube Music

Spotify: đăng ký redirect đúng trong README, cấp PKCE scope tối thiểu và kiểm tra allowlist/quota. Phát bài, pause, seek 30 giây rồi đổi bài; dashboard phải lấy lại progress/is_playing từ mẫu sau. `QUOTA_EXCEEDED` phải dừng nguồn; `invalid_grant` cần đăng nhập lại. Không gửi liên tục để cố tạo 429; tình huống đó đã được kiểm thử bằng fixture.

YouTube Music: nạp `extension/ytm`, ghép đúng Extension ID/key, chọn tab đang nghe trong popup. Phát bài và xác nhận mẫu mới mỗi giây; pause/tua trực tiếp trong player. Đóng tab → sau 8 giây phải stale. Đổi sang tab khác cần ghép/theo dõi lại. Bridge hiện chỉ hỗ trợ server HTTP loopback; không coi cấu hình LAN HTTPS là hỗ trợ bridge mặc định.

## Kho OS và giao diện

Nếu dashboard báo kho OS không khả dụng, chỉ dùng RAM; không chọn lưu phiên. Trên máy có kho OS, lưu rồi restart và kiểm tra danh tính tự khôi phục trong dry run. Dùng nút xóa phiên để xóa entry của ứng dụng; không mở/trích xuất credential của ứng dụng khác.

Kiểm tra cửa sổ desktop và kích thước điện thoại: điều hướng, form, bàn phím, nút bật/tắt, progress và hàng đợi. Gói hiện chưa có ảnh browser đã xác minh. Muốn dùng điện thoại, cần server LAN HTTPS và password theo README; app không tự mở firewall hoặc công khai server.

Khi báo lỗi, chỉ cung cấp bước tái hiện, phiên bản Node/OS/browser và thông báo không bí mật trên dashboard. Không gửi file `.env`, database cá nhân, OS keyring hay ảnh ô credential.


## Kiểm tra đăng nhập password + TOTP (1.1.0)

Chỉ dùng localhost trên chính máy bạn. Chọn Email/mật khẩu + 2FA trong Tài khoản; tự nhập credential, không gửi chúng vào chat hoặc log. Kiểm tra sai mật khẩu không báo thành công; tài khoản có Authenticator phải hiện bước 2FA trước khi có danh tính mới; mã sai xóa ô mã và giảm lượt, mã đúng xác minh users/@me. Kiểm tra Hủy, chờ hết 5 phút và đổi phương thức; ticket cũ không được dùng lại. Nếu cần CAPTCHA hoặc SMS/passkey/backup, phải thấy cảnh báo dừng và hoàn tất ở Discord chính thức. Không thử vượt các kiểm soát đó. Sau đăng nhập kiểm tra riêng cờ Custom Status; chỉ bật gửi khi capability đã được xác nhận. Kết nối lại dùng token hiện tại, không tự gửi password/OTP.

Các kiểm tra này cần tự chạy trên máy/tài khoản; kết quả fixtures được ghi trong TEST-REPORT.md, không thay cho kiểm chứng dịch vụ thật.
