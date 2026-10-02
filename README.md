# Discord Lyrics Status

Bản **1.1.0** — thêm đăng nhập Discord bằng email/số điện thoại, mật khẩu và 2FA TOTP.

Ứng dụng cục bộ bằng TypeScript, Node.js 24 LTS, Express 5, React/Vite và SQLite. Giao diện tiếng Việt, tối, thích ứng máy tính/điện thoại; cập nhật bằng SSE. Repository chứa nguồn **1.1.0**, lockfile, extension và kiểm thử. Chạy `npm ci`, `npm run build`, rồi `npm start`. ZIP bàn giao riêng có cả bản build. Không kèm thông tin xác thực, `node_modules`, cơ sở dữ liệu cá nhân hoặc `.env` thật.

| Yêu cầu                      | Cơ chế triển khai                                                            | Mức hỗ trợ / giới hạn                                                                                            |
| ---------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Xác minh tài khoản Discord   | GET `/api/v10/users/@me` với loại Authorization tương ứng                    | Có xác minh danh tính từ dịch vụ khi bạn cung cấp phiên hợp lệ; chưa thử bằng tài khoản thật trong lần bàn giao  |
| Email / mật khẩu + 2FA | POST client `/auth/login`, rồi `/auth/mfa/totp` khi được yêu cầu; xác minh `/users/@me` | Thử nghiệm, chỉ HTTP(S) loopback; mã TOTP 6 chữ số. CAPTCHA/MFA khác/xác minh bổ sung dừng. Chưa đăng nhập tài khoản thật |
| User token                   | Nhập cục bộ, xác nhận sở hữu; adapter GET/PATCH legacy `/users/@me/settings` | Thử nghiệm, API không chính thức và đã deprecated; tự vô hiệu hóa gửi nếu không có `custom_status`               |
| Cookie Discord               | Không triển khai làm credential thay token                                   | Cookie không mặc nhiên thay thế Authorization; không trích xuất cookie/token                                     |
| Discord OAuth2               | Authorization Code, scope `identify`, state ràng buộc phiên dashboard        | Chính thức, chỉ đọc danh tính; không đổi Custom Status                                                           |
| Bot token                    | Tách riêng, discord.js Gateway, Listening Activity                           | Chính thức cho bot riêng, không đổi Custom Status của tài khoản cá nhân; không có ACK xác nhận hiển thị presence |
| Lưu phiên                    | Keychain / Credential Manager / Linux Secret Service qua `@napi-rs/keyring`  | Tùy OS. Nếu không có kho OS chỉ RAM; yêu cầu lưu bị từ chối, không fallback plaintext                            |
| Spotify                      | OAuth2 PKCE; GET currently-playing; đọc progress/is_playing                  | Scope tối thiểu `user-read-currently-playing`; polling ≥5 giây, hạn chế quota/allowlist của Spotify              |
| YouTube Music                | Extension MV3 đọc media element của tab được bạn chọn                        | Đọc player thật, không dùng Video Metadata API như phiên phát; cần cài extension và ghép bridge cục bộ           |
| Metadata tên / nghệ sĩ / URL | Timeline thủ công; URL Spotify Get Track hoặc mẫu YouTube bridge tương ứng   | Metadata không chứng minh bài đang nghe; cache 24 giờ, không fetch URL tùy ý                                     |
| Nguồn lyrics                 | LRC/TXT của bạn; adapter LRCLIB tùy chọn                                     | Chỉ dùng nguồn bạn có quyền; không bảo đảm tìm được mọi bài; chọn kết quả để sửa khớp nhầm                       |
| LRC                          | Binary search timestamp + cursor playback + offset                           | Xử lý pause/resume, tua, đổi bài và dòng trống. Độ chính xác còn phụ thuộc dữ liệu nguồn                         |
| TXT                          | Luân phiên theo cursor và khoảng cấu hình                                    | Luôn ghi rõ không đồng bộ chính xác                                                                              |
| Gửi lyrics                   | Hàng đợi một dòng chờ, min 15 giây, Retry-After/header reset                 | Có thể bỏ qua nhiều dòng ngắn. Giới hạn dịch vụ luôn ưu tiên; không gửi mọi dòng bất chấp quota                  |
| Khôi phục                    | Chụp Custom Status gốc vào RAM, gửi restore qua cùng hàng đợi                | Chờ hàng đợi xong trước khi đóng; không bảo đảm khi tắt cưỡng bức, hết phiên hoặc endpoint ngừng hỗ trợ          |
| Dashboard qua LAN            | Password, HTTPS, cookie HttpOnly, Host/Origin/CSRF                           | Mặc định loopback. Nhập bí mật/OAuth/ghép bridge chỉ khi server ở chế độ cục bộ                                  |

Discord cấm tự động hóa tài khoản cá nhân bằng self-bot và có thể khóa tài khoản. Bản này giữ chức năng Custom Status theo yêu cầu trong adapter thử nghiệm, không tuyên bố Discord có API chính thức cho việc này. Các giới hạn trên là thật, không được che bằng chế độ bot hoặc bản xem trước. Tài liệu đối chiếu API nằm trong [docs/SOURCES.md](docs/SOURCES.md).

## 1. Cài và chạy

Cần **Node.js 24 LTS từ 24.15.0**, npm và quyền chạy ứng dụng trên máy của bạn. Runtime đã dùng khi kiểm thử: Node `v24.19.0`, npm `11.9.0`. Node 24 có `node:sqlite` tích hợp, không cần cài SQLite server. Dùng lockfile thay vì tự cập nhật dependency.

Clone repository hoặc giải nén ZIP, mở terminal trong thư mục dự án:

```sh
npm ci
npm run build
npm start
```

Mở **http://127.0.0.1:3210** trên chính máy chạy server. Dashboard không đòi token trong cuộc trò chuyện. Không nhập Discord token vào terminal hoặc file cấu hình.

Cách khởi chạy tiện dụng sau khi cài Node 24: Windows mở `start-windows.cmd`; macOS/Linux chạy `sh start-unix.sh`; hoặc dùng `node scripts/launch.mjs` / `npm run launch`. Trình khởi chạy tự `npm ci --include=dev` khi thiếu dependency cần thiết và tự build khi thiếu `dist`. Không tự cài Node hoặc nhận credential qua dòng lệnh. Dùng `npm run doctor` để kiểm tra Node/dependency/build mà không khởi chạy hoặc cài gì. Hướng dẫn xác minh account/player/browser thật: [docs/LOCAL-VALIDATION.md](docs/LOCAL-VALIDATION.md).

ZIP có sẵn `dist/` đã build; vẫn khuyến nghị build lại để kiểm tra môi trường. Nếu chỉ chạy bản build có sẵn:

```sh
npm ci --omit=dev
npm start
```

Cấu hình mặc định không cần `.env`. Nếu muốn đổi port hoặc đường dẫn dữ liệu, sao chép `.env.example` thành `.env` và chỉ thay cấu hình không bí mật:

```dotenv
HOST=127.0.0.1
PORT=3210
PUBLIC_ORIGIN=http://127.0.0.1:3210
DATA_DIR=./data
RESTORE_SAVED_SESSIONS=1
```

Nếu đổi port, đổi cả `PUBLIC_ORIGIN` và redirect URI trong ứng dụng Discord/Spotify. Origin phải chính xác, không có dấu `/` cuối. Để smoke test hoặc không khôi phục phiên OS khi khởi động, đặt `RESTORE_SAVED_SESSIONS=0`.

Phát triển với hai terminal:

```sh
# Terminal 1: server API
npm run dev
# Terminal 2: React/Vite
npm run dev:ui
```

Mở http://127.0.0.1:5173. Vite proxy `/api` về port 3210 và chỉ đổi Origin dev đã biết. Với OAuth/extension, nên dùng bản build tại port 3210 để callback và phiên dashboard thống nhất; callback không quay về port Vite.

## 2. Thử ngay, không cần credential

Trong Tổng quan chọn **Chạy thử**. App nhập một bài mẫu cùng LRC gốc do ứng dụng tạo, bật timeline thủ công và chỉ cập nhật preview. Nút không đăng nhập tài khoản giả, không phát âm thanh và không gửi Discord. Bản xem trước, hàng đợi và “Dịch vụ xác nhận” là ba dữ liệu khác nhau.

Trong Nguồn nhạc có thể pause, chạy hoặc tua timeline. Trong Lời bài hát nhập `examples/demo.lrc` / `demo.txt`, hoặc tệp bạn có quyền sử dụng. Trong Thiết lập chỉnh độ lệch; số dương làm dòng xuất hiện sớm hơn. Đổi bài sang bài chưa gắn lyrics sẽ dùng `{title} — {artist}` hoặc mẫu dự phòng đã cấu hình.

### Phòng thử password + 2FA cục bộ, không cần tài khoản thật

Sau `npm ci` và `npm run build`, chạy:

```sh
npm run lab:login
```

Mở `http://127.0.0.1:3211`. Đây là **giao diện và backend Express thật của 1.1.0**, nhưng Discord được thay bằng stub chỉ trong tiến trình thử. Vào Tài khoản, dùng email `fixture@example.invalid`, mật khẩu `FAKE_LAB_PASSWORD`, mã TOTP mẫu `012345`; các giá trị này là dữ liệu giả công khai. Thử mật khẩu sai hoặc mã `000000`; chỉ mã đúng mới hiện **Tài khoản mẫu cục bộ**. Khoảng chờ 3 giây và TTL 5 phút giống luồng thực. Banner ghi rõ dữ liệu mẫu; không nhập credential thật. Stub không gọi Internet, không mở OS vault, SQLite chỉ RAM và chặn khả năng Custom Status thật. OAuth thật bị chặn trong phòng thử này. Ctrl+C để dừng. Server thật dùng `npm start` tại port 3210 và không tự bật stub.

Kiểm thử tự động luồng compiled:

```sh
node scripts/login-smoke.mjs docs/login-smoke-result.json
```

Phòng thử trực tuyến riêng tư chỉ minh họa state machine bằng nút cố định, không nhận mật khẩu/OTP của bạn hoặc gọi server đăng nhập. Kết quả kiểm thử stub không chứng minh Discord chấp nhận credential thật.

## 3. Discord và các kiểu thông tin xác thực

### OAuth2 chính thức — đọc danh tính

1. Tạo Discord application trong Developer Portal của bạn.
2. Đăng ký redirect `http://127.0.0.1:3210/api/oauth/discord/callback`.
3. Trong Tài khoản chọn OAuth2, nhập Client ID và Client Secret **tại giao diện cục bộ**.
4. Bấm Kết nối, mở liên kết cấp quyền chính thức. Scope duy nhất là `identify`.
5. Callback trao đổi authorization code trên server; token chỉ ở RAM hoặc kho OS. Dashboard hiển thị danh tính từ `/users/@me`.

OAuth `identify` không cho ghi Custom Status. Scope `activities.write` thông thường không khả dụng cho app bình thường theo tài liệu Discord; bản này không xin scope giả hoặc dùng Bearer token để giả thành user token. Authorization Code callback có `code` một lần trong query theo chuẩn OAuth; access/refresh token, Client Secret và user/bot token không nằm trong URL. App không ghi request URL/body vào log và đặt `Referrer-Policy: no-referrer`.

### Email / mật khẩu + 2FA TOTP — đăng nhập cá nhân thử nghiệm

1. Chạy server cục bộ, mở `http://127.0.0.1:3210`. Không dùng form trên website công khai hoặc phòng thử trực tuyến cho tài khoản thật.
2. Vào **Tài khoản**, chọn **Email / mật khẩu + 2FA • thử nghiệm cục bộ**.
3. Nhập email hoặc số điện thoại E.164 (ví dụ định dạng `+84…`). Discord username/display name không phải định danh đăng nhập của luồng này.
4. Nhập mật khẩu **tại giao diện cục bộ**, xác nhận tài khoản của bạn và giới hạn self-bot, rồi bấm **Kết nối**. Ô mật khẩu/email được xóa sau gửi, kể cả khi gửi thất bại.
5. Nếu tài khoản bật Authenticator TOTP, ứng dụng hiển thị **Xác minh hai bước** sau khi Discord trả thử thách. Nhập mã **6 chữ số** hiện tại trong ứng dụng Authenticator và bấm **Xác minh 2FA**. Không cung cấp seed/QR 2FA, mật khẩu hay mã trong cuộc trò chuyện.
6. Khi mã sai, ô mã được xóa; thử mã mới sau thời gian chờ. Ticket chỉ ở server RAM, ràng buộc phiên dashboard; hết hạn cục bộ sau **5 phút**, tối đa **5 lượt**. **Hủy đăng nhập**, đổi phương thức hoặc đăng xuất dashboard sẽ hủy bước chờ. Đóng tab không tự đăng xuất; TTL vẫn áp dụng.
7. Chỉ sau khi có token hợp lệ và xác minh `/users/@me`, dashboard báo kết nối. Tài khoản không bật MFA có thể kết nối sau bước mật khẩu; ứng dụng không giả một lần xác minh 2FA.
8. Khả năng đổi Custom Status được kiểm tra riêng bằng adapter legacy hiện có. Đăng nhập thành công không đảm bảo endpoint Custom Status còn được Discord chấp nhận. Kết nối lại dùng token đã cấp, không tự gửi lại mật khẩu/OTP. Phiên hết hiệu lực hoặc cần xác minh sẽ dừng.

Đây là **giao thức client không chính thức**, không phải OAuth password grant hay API có cam kết ổn định. Endpoint và các trường `login/password`, `mfa/totp/ticket/login_instance_id/token` đã được đối chiếu với bundle web công khai do Discord phát hành ngày 2026-10-02; xem [bằng chứng kiểm chứng](docs/LOGIN-CLIENT-VALIDATION.json). Chưa thử bằng credential thật, nên không khẳng định tài khoản của bạn sẽ đăng nhập được. Luồng không giả fingerprint, không thu cookie, không tự đọc token trình duyệt và không giải CAPTCHA.

CAPTCHA, xác minh email/IP/điện thoại, tài khoản vô hiệu hóa/xóa/đình chỉ hoặc hành động bắt buộc: dừng, báo lý do tổng quát, hoàn tất trong Discord chính thức rồi thử lại. SMS, passkey/WebAuthn và mã dự phòng chưa triển khai trong form thử nghiệm này; chọn Discord chính thức/OAuth2 nếu cần. Không tự khôi phục tài khoản đã xóa hoặc vô hiệu hóa. WebAuthn của Discord gắn với domain Discord nên form localhost không thể giả làm domain đó.

Mật khẩu và OTP không lưu tệp, SQLite, OS vault, URL hoặc localStorage. Server gửi chúng qua HTTPS trực tiếp tới Discord, không chuyển tới provider nhạc/lyrics hay phòng thử. Ticket/instance ID không trả về dashboard; chỉ trả ID thử thách ngẫu nhiên của ứng dụng. Chọn **Lưu phiên** chỉ lưu profile chứa token được cấp vào kho OS; không có kho OS thì bị từ chối trước khi gửi credential. RAM và bộ lọc che bí mật không phải cơ chế xóa bộ nhớ có đảm bảo của JavaScript.

Ứng dụng không tự retry password/OTP khi mất mạng (tránh gửi lặp mã một lần), và tôn trọng Retry-After kể cả 429 không có JSON. Có khoảng chờ tối thiểu 3 giây giữa các lần gửi, tối đa 5 lần gửi mật khẩu/60 giây áp dụng chung cả khi đổi phiên dashboard. Đợi rồi **tự gửi** mã mới. Các giới hạn bảo vệ phía Discord có thể chặt hơn.

Đây là đăng nhập **Discord**, khác mật khẩu truy cập dashboard qua LAN. Luồng mới bị chặn ở chế độ LAN và khi `PUBLIC_ORIGIN` không phải loopback; không thêm tài khoản/mật khẩu/2FA Discord vào `.env`.

### User token — Custom Status cá nhân thử nghiệm

1. Chọn User token và tự nhập credential của chính tài khoản bạn. App không hướng dẫn hay thực hiện trích xuất token từ Discord/browser.
2. Đánh dấu xác nhận sở hữu và đã hiểu giới hạn self-bot.
3. Bấm Kết nối. Token biến mất khỏi ô nhập sau khi gửi, kể cả nếu lỗi.
4. App kiểm tra `/users/@me`, rồi thử đọc legacy `/users/@me/settings`. Phải có trường `custom_status` mới cho bật gửi.
5. Nếu endpoint trả 404/405 hoặc không có trường yêu cầu, dashboard vẫn giữ danh tính đã xác minh nhưng **vô hiệu hóa Custom Status** và báo rõ giới hạn.
6. Sau khi kết nối nguồn nhạc và gắn lyrics, tắt đồng bộ nếu đang chạy thử, mở Thiết lập, chọn Custom Status, bỏ Chạy thử, lưu rồi Bật đồng bộ.

PATCH chỉ chứa `custom_status`; không thay `status`, cài đặt tài khoản khác hoặc Online/Idle/DND/Invisible. Trạng thái văn bản mới có `expires_at: null`. App không giả lập client fingerprint, vượt CAPTCHA/2FA, đổi sang endpoint chưa xác minh hoặc tự động xử lý challenge. Khi gặp 401/invalid session dừng retry; 403/challenge báo cần xác minh trong app chính thức. Khi lỗi mạng giữ phiên và backoff 5–60 giây. 429 chờ Retry-After; bấm Kết nối lại cũng không bỏ cooldown.

Legacy settings được tài liệu reverse engineering gốc mô tả, nhưng đã deprecated để ưu tiên protobuf. Chưa xác minh GET/PATCH trên tài khoản thật trong môi trường bàn giao; không bảo đảm Discord còn chấp nhận cơ chế này cho tài khoản của bạn. Việc đọc được danh tính không chứng minh có quyền ghi settings. Không báo gửi thành công nếu response thiếu hoặc sai `custom_status.text`.

### Bot riêng — Activity chính thức

Chọn Bot token và nhập token bot từ application của bạn. App xác minh `bot: true`, kết nối Gateway qua discord.js với intent Guilds, sau đó gửi Listening Activity cho **bot đó**. Chọn đích Bot Activity và tắt chạy thử để gửi. Bot được đặt online; không cập nhật Custom Status, Presence hoặc tài khoản cá nhân của bạn. Presence Gateway không có ACK riêng cho mỗi cập nhật, nên kết quả chỉ là “Gateway đã gửi”, không “dịch vụ xác nhận” hay “đã hiển thị”. Bản này không khôi phục Activity bot trước đó.

### Cookie và phiên lưu

Cookie Discord không có ô nhập và không được chấp nhận ở API credential. Cookie HttpOnly `dls_session` là phiên đăng nhập dashboard của app, hoàn toàn khác cookie Discord. SameSite Lax cần thiết cho callback OAuth top-level; thay đổi dữ liệu vẫn cần CSRF và Origin hợp lệ.

“Lưu phiên” chỉ bật nếu kho thông tin xác thực OS hoạt động: macOS Keychain, Windows Credential Manager hoặc Linux Secret Service. Linux không fallback sang kernel keyutils hay SQLite/plaintext. Nếu native module/kho OS không khả dụng, chỉ giữ RAM và hiện giới hạn. Mọi keyring entry thuộc service `DiscordLyricsStatus`; app không đọc bí mật của ứng dụng khác.

Tự khôi phục phiên đã lưu khi chạy server; **chạy thử luôn bật lại** sau restart. Bỏ chọn Lưu phiên không xóa credential đã lưu trước đó. Dùng **Ngắt và xóa phiên lưu** để xóa profile Discord và OAuth Discord. Ngắt Spotify xóa riêng phiên Spotify. Xóa phiên cục bộ không thu hồi toàn bộ quyền OAuth tại nhà cung cấp; có thể tự thu hồi trong tài khoản nhà cung cấp.

## 4. Spotify — phiên đang phát thật

1. Tạo application trong Spotify Developer Dashboard của bạn; lấy Client ID. PKCE không cần Spotify Client Secret.
2. Đăng ký redirect `http://127.0.0.1:3210/api/oauth/spotify/callback`. Spotify cho HTTP loopback IP nhưng không cho `localhost` thay literal IP.
3. Với Development Mode, thêm tài khoản bạn vào allowlist nếu cần. Tài liệu hiện hành yêu cầu app owner có Spotify Premium và tối đa 5 người dùng mỗi app; ngoại lệ app cũ phụ thuộc chính sách grandfathering.
4. Trong Nguồn nhạc nhập Client ID, bấm Kết nối Spotify và cấp `user-read-currently-playing`. Chọn nguồn Spotify.
5. Phát nhạc trong Spotify. App đọc item, progress_ms và is_playing; lấy mẫu ≥5 giây, extrapolate giữa mẫu khi đang phát và dữ liệu còn mới.

Không yêu cầu quyền email, toàn bộ playback state, sửa playback hoặc playlist. App không phát audio hoặc điều khiển Spotify. 204 được xử lý là không có bài đang phát; episode/podcast hoặc item không hỗ trợ được ghi rõ. Pause/seek/đổi bài được lấy từ mẫu tiếp theo, do đó có độ trễ polling.

Đã đối chiếu thay đổi tháng 7/2026: có thể tạo tới 25 Client IDs mỗi developer, quota chung theo developer account. Response `error.reason: QUOTA_EXCEEDED` khác rate limit ngắn: app dừng nguồn và báo chờ quota thay vì retry nhanh. 429 thông thường vẫn dùng Retry-After. Không hardcode lượng quota vì Spotify có thể thay đổi.

Refresh token không vĩnh viễn: Spotify quy định 6 tháng theo lần cấp quyền gốc. Khi refresh trả `invalid_grant`, app xóa phiên OAuth, dừng retry và yêu cầu kết nối lại; refresh access token không kéo dài hạn refresh token. Lỗi mạng/429 tạm thời không xóa phiên.

Đọc metadata URL dùng Get Track chính thức với phiên OAuth và cache 24 giờ. Thao tác này không thay đổi hoặc tạo phiên “đang nghe”. Chưa chạy OAuth/player trên tài khoản thật trong bàn giao này.

## 5. YouTube Music — extension tự cài

Không có API công khai trong YouTube Data API để đọc phiên phát hiện tại trên tab của bạn. Bridge trong gói này đọc `currentTime`, `duration`, `paused`, `ended`, `playbackRate` của video/audio thật; tên/nghệ sĩ lấy từ Media Session hoặc player bar. Đây là adapter browser playback, không phải API metadata video được đổi tên thành “đang nghe”.

1. Giữ server chạy ở `http://127.0.0.1:3210` và mở dashboard tại cùng địa chỉ.
2. Chrome/Edge → trang Extensions → Developer mode → Load unpacked → chọn thư mục `extension/ytm`.
3. Mở popup extension để lấy Extension ID. Nhập ID ở Nguồn nhạc → YouTube Music bridge → Tạo khóa ghép.
4. Mở tab `https://music.youtube.com/`, bắt đầu phát bài hát.
5. Khi đang ở tab đó, mở popup, dán khóa bridge riêng và bấm Ghép và theo dõi tab này. Origin mặc định là `http://127.0.0.1:3210`.
6. Chọn YouTube Music trong dashboard. “Mẫu nhận gần nhất” phải cập nhật mỗi giây; kiểm tra pause/tua trực tiếp trong YouTube Music.

Không đọc cookie, token, lịch sử hoặc thông tin đăng nhập; manifest không xin quyền cookies. MAIN script chỉ xuất dữ liệu playback; isolated relay không nhận credential; service worker giữ khóa trong `chrome.storage.session` với TRUSTED_CONTEXTS. Khóa bridge không phải Discord token và không có trong SSE/log/SQLite; pair key chỉ hiện trong response ghép và ô password cục bộ. Khóa hết hạn sau 24 giờ, cần ghép lại khi server/trình duyệt khởi động lại hoặc chuyển tab đang theo dõi.

Server kiểm tra Extension Origin đã ghép, Authorization riêng, Host, schema, thời gian mẫu và giới hạn tốc độ. Một tab đang playing được ưu tiên hơn mẫu pause từ tab khác. Mất mẫu >8 giây sẽ đánh dấu stale, ngừng gửi và không giả vờ bài tiếp tục phát. Livestream có duration không hữu hạn chưa hỗ trợ. Nếu YouTube thay DOM/Media Session, cần cập nhật selector trong `reader.js`. Extension mới được kiểm thử logic bridge qua HTTP fixture, chưa chạy trong phiên YouTube Music thật.

Bridge hiện chỉ hỗ trợ server **HTTP loopback**, không chạy chung server LAN HTTPS. Muốn dashboard trên điện thoại và bridge cùng lúc cần thêm listener loopback hoặc proxy thiết kế riêng; bản này ghi rõ chưa triển khai cấu hình đó.

## 6. Lyrics, cache và sửa khớp nhầm

Nguồn phát và nguồn lời tách riêng. Tệp UTF-8 LRC/TXT của bạn là nguồn mặc định. LRCLIB được tắt mặc định; chỉ bật khi bạn có quyền truy cập/sử dụng phù hợp. API công khai của provider không cấp quyền tác giả cho mọi bài; không hứa toàn bộ catalog có lời hoặc timing đúng.

Ở Lời bài hát, nhập tên/nghệ sĩ hoặc dùng thông tin bài hiện tại, chọn file hoặc dán nội dung. “Nhập và gắn” gắn với ID bài hiện tại. “Tìm lyrics” đối chiếu tên (Unicode/tiếng Việt), nghệ sĩ và thời lượng, hiển thị score cùng chênh thời lượng. Bạn chọn “Dùng lyrics này”; app không tự gắn kết quả đầu. Có nút gỡ lyrics khớp nhầm và xem tệp đã nhập. LRCLIB search cache 24 giờ và xử lý cooldown.

Mẫu LRC:

```lrc
[ti:Tên bài của bạn]
[ar:Nghệ sĩ]
[offset:150]
[00:00.00]Dòng đầu
[00:08.50]Dòng tiếp theo
[00:12.00][00:20.00]Dòng được lặp lại
[00:25.00]
```

App hỗ trợ BOM, CRLF, nhiều timestamp trên một dòng và offset milliseconds. Dòng LRC trống có timestamp được giữ để xóa văn bản. Trước dòng timestamp đầu tiên dùng mẫu dự phòng. Cursor chọn dòng là `vị trí phát + offset giao diện + offset LRC`. Offset dương hiện sớm hơn, âm hiện muộn hơn. Pause giữ nguyên cursor; seek chọn lại dòng; đổi bài bỏ pending cũ và lấy binding theo track ID.

TXT bỏ dòng trắng và luân phiên theo khoảng cấu hình (mặc định 6 giây), dựa trên cursor nên pause/seek có hiệu lực. Giao diện luôn ghi TXT không đồng bộ chính xác; không tự suy ra timestamp.

## 7. Hàng đợi, xác nhận và khôi phục

Mặc định chỉ preview. Muốn gửi thật phải chọn đúng loại đích, bỏ Chạy thử, lưu rồi Bật đồng bộ. Preview không cần Discord credential. Với Custom Status và khôi phục được bật, app phải đọc được trạng thái gốc trước khi chạy; snapshot gốc (text/emoji/expiry) chỉ ở RAM.

Hàng đợi giữ tối đa một dòng đang chờ; thay dòng mới nhất khi seek/lyrics thay đổi. Nếu tua về dòng vừa gửi thì bỏ dòng pending lỗi thời. Request đang bay không thể thu hồi. Pause/stale/đổi bài bỏ pending cũ; rate limit được tôn trọng cả khi khôi phục. Khoảng gửi tối thiểu 15 giây chỉ là pacing cục bộ, không được coi là rate limit cố định của Discord. Nếu header/bucket/Retry-After yêu cầu chờ lâu hơn thì chờ lâu hơn. Nhiều dòng LRC ngắn sẽ bị bỏ qua; không bảo đảm status luôn đúng ngay tức thì.

Văn bản chuẩn hóa NFC, cắt theo grapheme ở tối đa **128 đơn vị UTF-16** theo giới hạn legacy được tài liệu reverse engineering mô tả. Đây là giới hạn bảo thủ: không cắt đôi surrogate, emoji ZWJ hay dấu tiếng Việt; không tuyên bố 128 grapheme được dịch vụ chấp nhận. Unicode emoji có thể nằm trong text; snapshot restore giữ emoji_name/emoji_id gốc. Không có picker guild emoji mới.

Dashboard phân biệt:

- **Xem trước:** chuỗi chọn tại máy cục bộ, chưa gửi.
- **Đang chờ / đang gửi:** công việc trong hàng đợi, chưa xác nhận.
- **Gửi gần nhất:** kết quả PATCH hợp lệ hoặc Gateway submission.
- **Dịch vụ xác nhận:** chỉ có khi PATCH settings trả đúng text yêu cầu; không quan sát được nội dung hiển thị trong Discord client.

Tắt đồng bộ để enqueue restore. Nếu còn cooldown, dashboard ghi “đang chờ khôi phục”; thao tác đổi/ngắt tài khoản sẽ bị chặn để không làm mất restore. Chờ xong, hoặc nếu muốn bỏ restore, tắt tùy chọn khôi phục khi sync đã tắt rồi lưu. Khôi phục một status gốc đã hết expiry sẽ xóa custom status thay vì hồi sinh status hết hạn.

**Đóng ứng dụng:** bấm Tắt đồng bộ, chờ restore được xác nhận rồi mới dừng server. Ctrl+C, kill, máy tắt, phiên bị vô hiệu hóa hoặc lỗi endpoint có thể để lại trạng thái mới. Bản này không hứa restore khi process chết và không lưu snapshot gốc vào ổ đĩa.

Custom Status khác Online/Idle/DND/Invisible, và khác Activity/Rich Presence. Bot Listening Activity không thay status cá nhân. Luồng SSE mất mạng cũng khác kết nối Discord: thanh trên cùng mô tả dashboard, thẻ tài khoản mô tả mẫu trạng thái Discord nhận gần nhất.

## 8. Bảo vệ dashboard và mở qua LAN

Mặc định chỉ bind loopback. API xác minh Host để chống DNS rebinding; kiểm tra Origin, cookie session HttpOnly và CSRF token trong header cho mutation. API JSON strict không nhận trường `cookie`/token trong config. Không request logging, không console error body provider, không access token/cookie trong SQLite/URL/localStorage. SSE chỉ xuất snapshot chọn lọc; redaction bổ sung giữ nguyên URL avatar công khai.

Truy cập qua mạng cần HTTPS và mật khẩu ≥12 ký tự. Server từ chối khởi động LAN nếu thiếu. Ví dụ cấu hình không bí mật (đổi IP/path theo máy bạn, cung cấp certificate được thiết bị của bạn tin cậy):

```dotenv
HOST=0.0.0.0
PORT=3210
PUBLIC_ORIGIN=https://192.168.1.10:3210
TLS_CERT_FILE=/duong-dan/dashboard-cert.pem
TLS_KEY_FILE=/duong-dan/dashboard-key.pem
```

Cung cấp `DASHBOARD_PASSWORD` bằng cơ chế môi trường riêng của hệ điều hành/process manager; không đưa mật khẩu vào repository, URL hoặc chat. Dashboard LAN sẽ yêu cầu đăng nhập; cookie Secure, SameSite Lax, session 12 giờ, khóa đăng nhập sau 5 lần sai trong 60 giây.

Chế độ LAN chặn nhập token, tạo OAuth và ghép bridge. Nếu muốn dùng tài khoản qua LAN, kết nối và lưu phiên bằng kho OS khi server còn cục bộ, dừng server, chuyển sang LAN rồi chạy lại. Khi cần cấp quyền mới chuyển về cục bộ. Không tự mở firewall, port-forward hay xuất app công khai. Cấu hình LAN/TLS thật chưa được kiểm thử trên thiết bị trong bàn giao; kiểm thử API đã xác nhận password và hạn chế nhập bí mật.

## 9. Kiểm thử, build và cấu trúc

```sh
npm run check
npm test
npm run build
node scripts/smoke.mjs docs/smoke-result.json
node scripts/launch.mjs --check
# Kiểm tra cài/build tự động vào bản sao tạm (Linux/macOS, cần mạng/cache npm):
node scripts/verify-launcher.mjs docs/launcher-result.json
# Cần Python 3 nếu muốn tự đóng ZIP:
npm run package
```

Smoke script chạy server compiled thật, dùng port tạm và SQLite tạm, `RESTORE_SAVED_SESSIONS=0`, không nạp credential của người dùng. Test dịch vụ ngoài dùng fixtures rõ tên `FAKE_*`; không gửi fixture credential tới dịch vụ ngoài. Báo cáo [docs/TEST-REPORT.md](docs/TEST-REPORT.md), output thật [docs/test-output.txt](docs/test-output.txt), và [docs/smoke-result.json](docs/smoke-result.json). Kiểm thử jsdom không thay cho browser visual QA; không có ảnh giả trong gói.

```text
discord-lyrics-status/
  README.md
  start-windows.cmd / start-unix.sh
  package.json / package-lock.json
  .env.example / .gitignore
  shared.ts
  tsconfig.server.json / tsconfig.web.json / vite.config.ts / index.html
  server/
    index.ts                 # boot, loopback / LAN guard, HTTPS
    app.ts                   # REST, SSE, bridge, validation
    engine.ts                # điều phối đồng bộ
    http.ts / security.ts    # HTTP lỗi/rate limit; bảo vệ bí mật, Unicode
    store.ts                 # cấu hình/lyrics/binding/cache không bí mật
    auth/
      vault.ts               # kho OS hoặc RAM
      oauth.ts               # OAuth, PKCE, refresh, state
      discord-login.ts       # password + TOTP cục bộ, TTL, owner binding, Retry-After
      dashboard.ts           # session, mật khẩu, Host/Origin/CSRF
    discord/service.ts       # danh tính, legacy Custom Status, bot Activity
    music/adapters.ts        # Spotify, YouTube bridge, timeline thủ công
    lyrics/service.ts        # LRC/TXT, matching, LRCLIB
    sync/queue.ts            # gộp pending, retry, chống gửi lỗi thời
  web/
    main.tsx / app.tsx / styles.css
  extension/ytm/
    manifest.json / reader.js / relay.js / worker.js
    popup.html / popup.css / popup.js
  examples/demo.lrc / demo.txt
  tests/
    helpers.ts / core.test.ts / services.test.ts / api.test.ts / ui.test.ts / launcher.test.ts / login.test.ts
  scripts/package.py / smoke.mjs / launch.mjs / verify-launcher.mjs
  scripts/login-lab.mjs / login-smoke.mjs
  docs/SOURCES.md / DEPENDENCIES.md / TEST-REPORT.md / LOCAL-VALIDATION.md
  docs/test-output.txt / smoke-result.json
  dist/                      # server và web đã build
```

Thêm nguồn phát bằng interface `MusicAdapter.read(now): Playback`, dùng Track ID ổn định, measured position/playing/observedAt/rate và stale. Không trộn provider lyrics vào player. Thêm nguồn lyrics riêng trong LyricsService, kiểm tra quyền truy cập, cache, rate limit, duration và explicit binding. Nếu thay Discord adapter, phải giữ phân biệt khả năng user/bot/OAuth và mức xác nhận kết quả.

## 10. Giới hạn và xử lý lỗi

| Tình huống                          | Cách xử lý                                                                                                        |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 401 / expired                       | Dừng sync/retry, nhập lại phiên hoặc cấp quyền OAuth; không tìm token từ browser                                  |
| 403 / cần xác minh                  | Mở ứng dụng/dịch vụ chính thức để xác minh; không bypass challenge                                                |
| Legacy settings không còn hoạt động | Giữ xem trước và danh tính, báo Custom Status không hỗ trợ; không báo bot Activity là thay đổi status cá nhân     |
| 429 rate limit                      | Chờ thời gian dashboard hiển thị; dòng pending tiếp tục được thay bằng dòng mới nhất                              |
| QUOTA_EXCEEDED                      | Spotify dừng nguồn; chờ quota khả dụng rồi kết nối lại, không retry ngắn vô hạn                                   |
| Spotify không có bài                | Kiểm tra player đang chạy, allowlist, quota và quyền tài khoản; 204 không phải cập nhật thành công                |
| Bridge không có mẫu                 | Đúng HTTP 127.0.0.1 và port; tab đang nghe được ghép; khóa còn hạn, popup không báo lỗi; mẫu cần duration hữu hạn |
| Lyrics sai bài                      | Gỡ binding và tìm/chọn lại; score là gợi ý, không phải bảo đảm                                                    |
| Kho OS không khả dụng               | Bỏ chọn lưu phiên; trên Linux cần phiên Secret Service đang mở, trên macOS/Windows có thể cần OS cấp quyền        |
| Chờ restore                         | Chờ hết cooldown; hoặc tắt khôi phục rồi lưu khi sync đã tắt để chủ động bỏ restore                               |
| SSE mất kết nối                     | Browser tự kết nối lại; thẻ Discord chỉ là mẫu gần nhất, không phải xác nhận mới                                  |

Chưa xác minh bằng credential thật: Discord password/TOTP/CAPTCHA, legacy settings/bot Gateway/OAuth, Spotify OAuth/player/quota thật, phiên YouTube Music/extension thật, LRCLIB đáp ứng một bài cụ thể, lưu credential trên macOS/Windows/desktop Linux, TLS/LAN trên điện thoại và hình học giao diện trình duyệt. Các phần này có code triển khai đầy đủ nhưng cần kiểm tra trên máy/tài khoản của bạn. Không có credential thật nên không có tuyên bố đổi Custom Status thật thành công.
