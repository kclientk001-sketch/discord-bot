# Báo cáo kiểm thử

Bản 1.0.1 được kiểm tra trên Linux, Node v24.19.0, npm 11.9.0. Gói ZIP đã được giải nén lại và cài bằng lockfile. Không dùng thông tin xác thực thật để kiểm thử.

| Kiểm tra                                                          | Kết quả                                                                  | Bằng chứng                                                             |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| TypeScript server + web                                           | Đạt (trong build)                                                        | build-output.txt                                                       |
| Build production Vite + server                                    | Đạt                                                                      | build-output.txt, dist/                                                |
| Unit / service / HTTP / React / launcher                          | **53 / 53 đạt**, 0 fail, 0 skip                                          | test-output.txt                                                        |
| Kiểm tra lại launcher sau chỉnh sửa cuối                          | **2 / 2 đạt**, 0 fail, 0 skip                                            | launcher-test-output.txt                                               |
| Cài mới từ ZIP bằng npm ci                                        | Đạt, 185 package                                                         | fresh-install-output.txt                                               |
| Bootstrap từ source không có dependency/dist, NODE_ENV=production | **6 / 6 đạt**                                                            | launcher-result.json                                                   |
| Smoke compiled server thật                                        | **12 / 12 đạt**; kết quả bản 1.0.0 được giữ lại, mã server/web không đổi | smoke-result.json                                                      |
| Trình duyệt render / screenshot                                   | Chưa xác minh                                                            | Chromium chưa có; tải browser thất bại với tệp ZIP rỗng / không hợp lệ |
| Dịch vụ với credential thật                                       | Chưa xác minh                                                            | Không sử dụng thông tin xác thực thật trong bàn giao                   |

Full suite ghi duration_ms 2751.341153; hai test launcher chạy lại ghi duration_ms 830.347431. Bootstrap mới hoàn tất lúc 2026-10-02T01:37:39.220Z; smoke giữ lại chạy lúc 2026-10-02T01:08:07.031Z. Node tối thiểu 24.15.0 được chọn theo engine requirements trong lockfile; runtime thực tế đã chạy là 24.19.0.

Bootstrap dùng bản sao tạm có đường dẫn chứa khoảng trắng và cwd khác thư mục app. Launcher tự cài bằng `npm ci --include=dev`, tự build TypeScript/Vite, phục vụ trang HTML tiếng Việt, mở API ở trạng thái dry run/disconnected và chuyển SIGTERM để server dừng sạch. Bản sao không nạp phiên từ kho OS và được xóa sau kiểm tra. Không coi các kiểm tra HTTP/DOM là kiểm tra render trình duyệt.

Wrapper Windows và nhánh npm qua cmd.exe chưa chạy trên Windows thật. Test chuyển SIGTERM tự động được skip trên Windows; kết quả trên Linux không chứng minh hành vi của Windows hoặc macOS.

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

## Cần xác minh trên máy người dùng

1. Discord legacy GET/PATCH còn được tài khoản của bạn chấp nhận hay không, hiển thị trong client, expiry/emoji thực tế, user verification behavior.
2. Discord OAuth callback thật và Gateway bot thật. Không có ACK riêng cho presence nên “đã gửi” vẫn không chứng minh người khác nhìn thấy.
3. Spotify OAuth/player/allowlist/quota thật, độ trễ polling, server response variation. Các tình huống đã test ở trên dùng fixtures, không phải Spotify thật.
4. Extension MV3 trên Chrome/Edge với YouTube Music thực tế; MAIN Media Session/DOM selector, quyền tải extension và service worker lifecycle.
5. LRCLIB endpoint sống và quyền/độ đúng của lyrics cụ thể. HTTP fixture/cache test không bảo đảm provider có mọi bài.
6. Keychain/Credential Manager/Secret Service desktop thật. Môi trường bàn giao không có phiên desktop keyring khả dụng; app hiện RAM-only và không fallback lưu plaintext.
7. Chứng chỉ HTTPS tin cậy, LAN/password/cookie/SSE trên điện thoại. Guard HTTP đã test; network/TLS trên thiết bị thật chưa test.
8. Visual QA desktop/mobile trong trình duyệt. Không có screenshot vì không chạy được Chromium; React DOM assertions và asset HTTP smoke không thay cho kiểm tra hình học.
9. Wrapper Windows, nhánh npm qua cmd.exe và khởi chạy trên macOS. Dùng checklist trong [LOCAL-VALIDATION.md](LOCAL-VALIDATION.md); kết quả thực tế hiện có chỉ từ Linux.

Không có tuyên bố đã thay Custom Status thật, kết nối tài khoản thật hoặc nhận lyrics của một bài cụ thể từ dịch vụ thật.
