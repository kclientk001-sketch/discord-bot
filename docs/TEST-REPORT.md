# Báo cáo kiểm thử — 1.1.0

Kiểm thử trên Linux, Node v24.19.0, npm 11.9.0 ngày 2026-10-02. Bản này bổ sung đăng nhập Discord bằng mật khẩu và TOTP. Toàn bộ credential dùng trong test là dữ liệu `FAKE_*`, không gửi đến Discord. Dependency giữ nguyên lockfile của 1.0.1; chỉ tăng phiên bản ứng dụng.

| Kiểm tra | Kết quả | Bằng chứng |
| --- | --- | --- |
| Unit/service/HTTP/React/launcher | **75/75 đạt**, 0 fail, 0 skip | test-output.txt |
| Nhóm password/TOTP mới | **20/20 đạt**, nằm trong tổng 75 | tests/login.test.ts và test-output.txt |
| Flow password/MFA HTTP + lỗi HTTP | **2/2 đạt**, nằm trong tổng 75 | tests/api.test.ts |
| React password/TOTP | Đạt trong flow React chung: mật khẩu xóa, OTP sai xóa, OTP đúng, đổi phương thức, ID không bị che nhầm | tests/ui.test.ts |
| TypeScript server + web / production build | Đạt | build-output.txt |
| Đăng nhập compiled với fixture cục bộ | **9/9 đạt** | login-smoke-result.json, login-smoke-output.txt |
| Server compiled thật, HTTP/SSE/SQLite tạm | **12/12 smoke đạt** | smoke-result.json, smoke-output.txt |
| Bootstrap từ nguồn sạch | **6/6 đạt ở 1.0.1**, chưa chạy lại trên 1.1.0 | launcher-result.json (kết quả cũ) |
| Keyring/LAN TLS/Windows/macOS thật | Chưa xác minh | cần thử trên máy người dùng |
| Password/TOTP/login/MFA thật với Discord | **Chưa xác minh** | không sử dụng credential thật |
| Kiểm chứng giao thức | Đối chiếu tĩnh bundle client chính thức, không phải xác thực tài khoản thật | LOGIN-CLIENT-VALIDATION.json |

Full suite duration_ms 2215.634825. Smoke lần này được ghi lại theo thời gian trong smoke-result.json. Hai launcher unit test nằm trong 75 kiểm tra; dữ liệu bootstrap/cài sạch riêng từ 1.0.1 được giữ nguyên và ghi rõ lịch sử, không coi là lần chạy 1.1.0.

## Kiểm tra đăng nhập mới

- Password → MFA → token: chỉ xác minh danh tính sau khi Discord fixture cấp token. Tài khoản không có MFA không bị tạo một lần xác minh giả.
- Hủy ngay khi đang xác minh `/users/@me` ngắt request, không kết nối và không lưu token mới.
- TOTP 6 chữ số, owner binding, ID thử thách không chứa ticket; hủy/hết hạn/replay/phiên khác bị chặn trước request upstream.
- Mã sai còn lượt thì cho nhập mã mới; 5 mã sai xóa ticket. Discord báo invalid ticket/session (60006/60009) dừng ngay.
- CAPTCHA, phone verification, tài khoản bị đình chỉ/xóa/vô hiệu hóa và required_actions dừng; SMS/passkey/backup-only không bị coi là TOTP.
- 429 chọn Retry-After dài nhất, gồm response không phải JSON. Hủy/đổi dashboard session không xóa cooldown. Không tự retry mật khẩu/OTP khi mất mạng.
- Không có cookie/Authorization trong request đăng nhập; endpoint HTTPS cố định, chặn redirect. Persistence không có keyring bị từ chối trước khi gửi.
- HTTP guard CSRF/phiên/LAN; logout hủy thử thách; password/code/ticket/token không có trong response, SSE, SQLite hoặc console fixture.
- OTP số có thể trùng một phần ID công khai: giữ đúng ID/danh tính, che mã trong log. Không lấy kết quả preview làm xác nhận Custom Status.
- Không giả fingerprint, giải CAPTCHA, lấy token từ trình duyệt hay seed 2FA. Mật khẩu/OTP không lưu vào profile/kho OS. JavaScript không cung cấp cam kết zeroization RAM.

## Những hành vi đã kiểm tra

- Sai Discord credential → expired, không retry tự động; captcha/challenge → verification-required. Token cá nhân cần xác nhận sở hữu; bot flag không bị coi là tài khoản cá nhân. Endpoint legacy 404 giữ danh tính nhưng vô hiệu hóa gửi.
- Mạng bị ngắt → backoff, sau đó dừng khi phiên vô hiệu hóa. OAuth Bearer identify không được phép PATCH Custom Status; state ràng buộc dashboard session, dùng một lần; Spotify PKCE đúng scope tối thiểu.
- Refresh được gộp một request; giữ refresh token nếu response không có token mới. `invalid_grant` xóa phiên và ngừng gọi lại. `QUOTA_EXCEEDED` dừng nguồn thay vì retry ngắn; Discord Retry-After không bị bỏ qua khi bấm reconnect.
- PATCH chỉ sửa custom_status, kiểm tra response text. Chụp và khôi phục emoji gốc. Response thiếu/sai text không báo thành công.
- LRC BOM/CRLF/nhiều tag/offset/dòng trống/timestamp sai; seek lùi, trước dòng đầu, offset dương/âm. TXT luân phiên, không tạo timestamp giả. Unicode NFC và emoji ZWJ không bị cắt giữa grapheme.
- Spotify fixtures cho playing/pause/resume/seek/đổi bài/204 và 429; cooldown freeze, metadata URL không tạo playback claim. YouTube nhận mẫu hợp lệ, chọn tab playing, từ chối mẫu quá cũ, đánh dấu stale sau 8 giây.
- Queue giữ latest pending, pacing 15 giây, seek về dòng đã gửi loại pending cũ, Retry-After header/JSON/reset lấy thời gian dài nhất, dừng trong lúc request lỗi không làm sống lại pending. Gateway submission không bị đổi thành service confirmation.
- Engine thiếu lyrics dùng fallback, preview không gửi, pause/tua/đổi bài có hiệu lực; restore còn chờ không bị thao tác disconnect làm mất; heartbeat invalid auth dừng sync.
- HTTP server loopback thật: session HttpOnly/SameSite Lax, authentication, Host/Origin/CSRF, password LAN, giới hạn đăng nhập, chặn secret input ở LAN, từ chối cookie như token, JSON lỗi không phản chiếu nội dung, strict config không lưu secret.
- Bridge Origin + key riêng, canonical URL/metadata cache không claim phiên playback; pair key không có trong snapshot. SSE thật gửi snapshot, không tạo false confirmation.
- Log/response/state/nội dung SQLite không xuất credential fixture. Secret redaction giữ avatar URL công khai và xử lý escaped string.
- React thật trong jsdom với API/EventSource fixture: chạy demo, pause, tua, nhập TXT, chỉnh offset, phân biệt cookie/user token, xóa ô token sau gửi, localStorage không lưu credential. jsdom không đo responsive layout hoặc font/browser geometry.

## Smoke test không dùng credentials

`scripts/smoke.mjs` khởi chạy `dist/server/index.js` thật ở port tạm, DATA_DIR tạm và `RESTORE_SAVED_SESSIONS=0`. Kiểm tra trang HTML tiếng Việt/header, JS/CSS production, phiên dashboard, mặc định dry run, nhập bài, gắn LRC, pause, tua lùi, đổi bài thiếu lời, SSE và bật/tắt preview. Script dừng server và xóa database tạm sau khi chạy.

`scripts/login-smoke.mjs` chạy cùng server Express và module đăng nhập đã compile với stub Discord đóng; kiểm tra mật khẩu sai, bước MFA, OTP sai/đúng, danh tính mẫu, không giả ACK Custom Status và không phản chiếu bí mật. Chạy `npm run smoke:login`; không gọi dịch vụ thật, không phải bài kiểm tra hình học giao diện.

## Cần xác minh trên máy người dùng

1. Discord password/TOTP/CAPTCHA/xác minh bổ sung và legacy GET/PATCH còn được tài khoản của bạn chấp nhận hay không, hiển thị trong client, expiry/emoji thực tế, user verification behavior.
2. Discord OAuth callback thật và Gateway bot thật. Không có ACK riêng cho presence nên “đã gửi” vẫn không chứng minh người khác nhìn thấy.
3. Spotify OAuth/player/allowlist/quota thật, độ trễ polling, server response variation. Các tình huống đã test ở trên dùng fixtures, không phải Spotify thật.
4. Extension MV3 trên Chrome/Edge với YouTube Music thực tế; MAIN Media Session/DOM selector, quyền tải extension và service worker lifecycle.
5. LRCLIB endpoint sống và quyền/độ đúng của lyrics cụ thể. HTTP fixture/cache test không bảo đảm provider có mọi bài.
6. Keychain/Credential Manager/Secret Service desktop thật. Môi trường bàn giao không có phiên desktop keyring khả dụng; app hiện RAM-only và không fallback lưu plaintext.
7. Chứng chỉ HTTPS tin cậy, LAN/password/cookie/SSE trên điện thoại. Guard HTTP đã test; network/TLS trên thiết bị thật chưa test.
8. Giao diện form cục bộ được kiểm tra bằng React/jsdom; hình học responsive của form thật và login thật chưa kiểm tra bằng trình duyệt. Phòng thử trên web có dữ liệu mẫu riêng, không chứng minh form/backend thật đã đăng nhập Discord.
9. Wrapper Windows, nhánh npm qua cmd.exe và khởi chạy trên macOS. Dùng checklist trong [LOCAL-VALIDATION.md](LOCAL-VALIDATION.md); kết quả thực tế hiện có chỉ từ Linux.

Không có tuyên bố đã thay Custom Status thật, kết nối tài khoản thật hoặc nhận lyrics của một bài cụ thể từ dịch vụ thật.
