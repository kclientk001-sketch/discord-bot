# Phiên bản đã cài và kiểm tra

Node: v24.19.0. npm: 11.9.0. Đã đối chiếu npm registry cho các thư viện chính trước khi chọn; package-lock.json chốt dependency tree. Dùng npm ci để tái tạo.

Bản 1.0.1 yêu cầu Node `>=24.15.0 <25` theo engine requirements trong lockfile, gồm jsdom và dependency kiểm thử. Đã cài lại thành công 185 package từ ZIP; bootstrap với `NODE_ENV=production` dùng `--include=dev` để bước build vẫn có TypeScript/Vite. Không có dependency mới cho launcher.

| Thư viện               | Phiên bản thực tế |
| ---------------------- | ----------------- |
| @napi-rs/keyring       | 2.1.0             |
| @testing-library/react | 16.3.3            |
| @types/express         | 5.0.6             |
| @types/node            | 24.19.1           |
| @types/react           | 19.3.0            |
| @types/react-dom       | 19.3.0            |
| @vitejs/plugin-react   | 6.1.1             |
| discord.js             | 14.27.0           |
| express                | 5.2.1             |
| jsdom                  | 30.1.1            |
| react                  | 19.3.0            |
| react-dom              | 19.3.0            |
| tsx                    | 4.23.15           |
| typescript             | 5.9.3             |
| vite                   | 8.3.2             |
| zod                    | 4.6.5             |

SQLite: node:sqlite tích hợp Node 24. Native keyring là optional; thiếu module/kho OS => RAM-only, không plaintext. jsdom và Testing Library chỉ kiểm tra DOM/behavior, không browser visual QA.
