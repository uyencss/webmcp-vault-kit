# Báo Cáo Phản Biện Đa AI & Khung Ma Trận Đồng Thuận (Consensus Matrix)
> Chủ đề: **WebMCP Passkey Vault, Touch ID Unlock, Extension & Agent Passkey Provider**
> Thời gian: 2026-10-17 17:49:15
> Điều phối chính (Host-Native Orchestrator): **Gemini 4 Argon**

## I. Trạng Thái Phản Hồi Của Các Thành Viên Fleet (3 Models)

| Thành viên Fleet | Vai trò | Kênh gọi | Trạng thái | Thời gian | Phán quyết sơ bộ |
| :--- | :--- | :---: | :---: | :---: | :--- |
| **Muse Preset (`GLM 5.3 Flash Free`)** | Peer Reviewer (Security & Schema) | `webmcp-ai` | ✅ Sẵn sàng | 31.07s | **APPROVE WITH GUARDS** (12 findings: `rpId` one-way, `redactItem`, lease signing) |
| **Claude Opus 5.5 (`claude:opus`)** | Peer Reviewer (`/ponytail` Minimalism) | `direct` | ✅ Sẵn sàng | 174.36s | **APPROVE WITH GUARDS** (Block `WebAuthn.*` in `executeCDP`, `BE=1/BS=1` flags, JXA/Swift `LAContext`) |
| **Gemini 4 Argon (`argon-4`)** | Peer Reviewer (Full-Stack Architecture) | `subagent` | ✅ Sẵn sàng | 62.10s | **APPROVE DUAL-LANE** (`lib/vault/passkey.js` pure `node:crypto` + `MAIN` world hook + CDP Broker) |

---

## II. Khung Ma Trận Đồng Thuận Thực Tế (Consensus Synthesis Matrix)

| Hạng mục Phân Tích / Rủi Ro Cốt Lõi | Muse Preset (`GLM 5.3 Flash`) | Claude Opus 5.5 (`claude:opus`) | Gemini 4 Argon (`argon-4`) | Quyết Định Đồng Thuận & Mức Độ Ưu Tiên |
| :--- | :---: | :---: | :---: | :--- |
| **1. [P0] Chặn lộ khóa bí mật qua `executeCDP` (`WebAuthn.getCredentials`)** | Đồng thuận không lộ privateKey cho LLM | Phát hiện `cdp-actions.js:32` cho phép gọi bất kỳ lệnh CDP nào -> LLM có thể gọi `WebAuthn.getCredentials` lấy trộm PKCS#8 | Yêu cầu chặn cứng `/^WebAuthn\./i` trong `executeCDP` (`cdp-actions.js`) | **P0 (Bắt buộc sửa)**: Chặn `/^WebAuthn\./i` trong `cdp-actions.js`; chỉ handler Passkey Broker chuyên biệt được phép gọi `WebAuthn.*` và luôn `removeVirtualAuthenticator` trong `finally`. |
| **2. [P0] Không lộ `privateKey` trong `redactItem`, `revealItem`, CSV Export** | `[F1, F6]` `redactItem` chỉ trả `hasPasskey`, `passkeyMeta`; `revealItem` không trả raw key | `redactItem` trả `{ rpId, credentialId, userName }`; `revealItem` & CSV không bao giờ xuất `privateKey` | `redactItem` trả `hasPasskey` + `passkeyMeta`; giữ `privateKeyPkcs8` & `privateKeyJwk` chỉ cho internal signing/CDP | **P0 (Bắt buộc sửa)**: `redactItem` và `revealItem` chỉ trả `passkeyMeta` công khai (`credentialId`, `rpId`, `userHandle`, `userName`, `alg`, `signCount`, `createdAt`). Khóa bí mật chỉ đọc qua `getItemPasskeySecret` nội bộ. |
| **3. [P0] Cờ `BE=1` & `BS=1` (`0x1d` / `0x5d`) cho Passkey từ 1Password** | `[F9]` Lưu ý bit `BE/BS = 0x08 \| 0x10` khi credential có backup | 1Password passkeys có `BE=1` lúc đăng ký; nếu đổi `BE` lúc assert sẽ bị RP từ chối | Bắt buộc đặt flags `0x1d` (`UP\|UV\|BE\|BS`) khi assert và `0x5d` khi register; bật `backupEligibility`/`backupState` | **P0 (Bắt buộc sửa)**: Đặt mặc định `backupEligibility: true, backupState: true` (`flags = 0x1d` cho assertion, `0x5d` cho attestation) để Google/GitHub/Microsoft chấp nhận chữ ký 100%. |
| **4. [P0] Kiểm tra `rpId` Một Chiều Nghiêm Ngặt & Xác thực `sender.url`** | `[F2, F8]` Không dùng `webMatches` 2 chiều; thêm `rpIdMatchesHost(rpId, host)` | Không dùng `webMatches`; kiểm tra `host === rpId \|\| host.endsWith('.' + rpId)` và lấy origin từ `sender.url` | Cấm tin `params.origin` từ `window.postMessage`; bắt buộc parse `new URL(sender.url \|\| sender.tab.url)` ở `bg/events.js` | **P0 (Bắt buộc sửa)**: Viết `isValidRpIdForHost(rpId, callerHost)` một chiều nghiêm ngặt trong `lib/vault/passkey.js` và lấy `sender.url` trong `bg/events.js`. |
| **5. [P1] Kiến trúc Dual-Mode Passkey Provider (Interactive Extension + Agent CDP)** | `[F3, F8]` Hỗ trợ cả Vault-side assertion signing và CDP Virtual Authenticator | Ưu tiên CDP Virtual Authenticator cho Agent + Popup button, mở rộng `MAIN` world hook khi cần | Kết hợp cả 2: `lib/vault/passkey.js` (<180 LOC pure `node:crypto`) phục vụ `MAIN` world `navigator.credentials` hook (0 debugger banner) + CDP Virtual Authenticator cho Agent | **P1 (Triển khai đầy đủ cả 2)**: Cung cấp cả **Interactive Extension Hook (`navigator.credentials.get/create`)** (không bị banner debugger, tự động bắt passkey mới đăng ký) LẪN **Agent CDP Virtual Authenticator (`broker.js`)**. |
| **6. [P1] Touch ID Unlock (`LocalAuthentication` + Browser Platform Authenticator)** | `[F7]` Dùng macOS `LocalAuthentication` (`LAContext`) trên host | Dùng `osascript -l JavaScript` (`ObjC.import('LocalAuthentication')`) hoặc Swift helper + WebAuthn khi qua HTTPS | Kết hợp Swift/JXA `LAContext` (`POST /api/unlock/touchid`) mở khóa session RAM + WebAuthn Platform Authenticator trên UI | **P1 (Triển khai cả 2)**: Tích hợp macOS native `LAContext` (Touch ID hệ thống cực nhạy qua `/api/unlock/touchid`) + WebAuthn Platform Authenticator trên Lockbox UI. |
| **7. [P1] Giải quyết 35+ Passkeys trùng `rpId: "google.com"`** | `[F8]` Non-discoverable: lọc theo `allowCredentials`; Discoverable: hiện bộ chọn hoặc yêu cầu `itemId` | Agent truyền `itemId` cụ thể qua lease; Interactive chọn item | Khớp `allowCredentials` trước; nếu `allowCredentials` rỗng và có >1 tài khoản, ưu tiên khớp email đang nhập trên trang hoặc hiện UI chọn tài khoản | **P1 (Tối ưu UX)**: Khớp chính xác `allowCredentials[].id` -> gợi ý theo email trên DOM -> hiển thị UI Picker gọn nhẹ trên trang nếu vẫn có nhiều tài khoản. |

---

## III. Tóm Tắt Các Điểm Đồng Thuận Kỹ Thuật (`/ponytail` Guardrails)

1. **Zero External Dependencies**: Toàn bộ mật mã học WebAuthn (`ES256` P-256, `EdDSA` Ed25519, JWK $\leftrightarrow$ PKCS#8 DER, `authenticatorData`, `clientDataJSON`, CBOR COSE key encoding cho `navigator.credentials.create`) được viết gói gọn trong `packages/webmcp-vault-kit/lib/vault/passkey.js` (~170 dòng pure `node:crypto`).
2. **Bảo toàn 100% 67 Passkeys từ 1Password**:
   - Ghép tự động vào các `login` item tương ứng trong `~/.webmcp/vault/credentials.enc.json` (và tạo mới `login` item cho các passkey chưa có item trong vault như `grab.com`, `tiktok.com`, `whatsapp.com`, `App Cake`).
   - Tự động chạy **Cryptographic Self-Verification Round-Trip Test** (`signAssertion` -> `crypto.verify` bằng public key trích xuất từ PKCS#8/JWK) trên cả 67 passkey ngay lúc nạp vào Vault.
3. **Đồng bộ Đa Máy (`mac-mini` & `mac-m1`)**:
   - Cập nhật đồng bộ `credentials.enc.json` và mã nguồn lên cả máy chính lẫn máy `mac-m1` (`100.100.207.69`), sau đó xóa sạch toàn bộ file tạm `/tmp/1pass_*` và `/tmp/recovered_passkeys.json`.
