# WebMCP Vault Companion Extension

`WebMCP Vault Companion` (`v1.0.0`) là extension trình duyệt chuyên biệt quản lý và tự động điền (autofill) thông tin đăng nhập, mật khẩu, mã xác thực 2FA TOTP và Passkey an toàn cho hệ sinh thái WebMCP.

---

## 1. Vai trò trong Hệ sinh thái

Extension này hoạt động song song nhưng hoàn toàn tách biệt với **WebMCP Tools Provider**:

- **WebMCP Vault Companion (Extension này):**
  - Đóng vai trò là giao diện tương tác người dùng (User Interface) và trợ lý autofill biểu mẫu đăng nhập.
  - Kết nối trực tiếp với daemon máy chủ WebMCP Vault cục bộ qua HTTP loopback: `http://127.0.0.1:7876`.
  - Hỗ trợ người dùng mở khóa két bảo mật bằng Touch ID phần cứng trên máy Mac hoặc Master Password.
  - Lắng nghe sự kiện ủy quyền đăng nhập `__webmcp_vault_agent_cmd__` từ AI Agent để tự động điền form mà **không bao giờ để lộ mật khẩu dạng thô (plaintext secret) cho AI model**.

- **WebMCP Tools Provider:**
  - Nắm quyền `debugger` (CDP) để điều khiển trình duyệt, chụp ảnh màn hình, tương tác DOM và khởi tạo **Virtual Authenticator** (`WebAuthn`) cho các phiên đăng nhập Passkey tự động của AI Agent.

---

## 2. Tài liệu Tham khảo Chuyên sâu

Để hiểu rõ cách thức hoạt động của Passkey, cơ chế Virtual Authenticator trong Chrome DevTools Protocol, và nguyên lý xác thực chữ ký ECDSA ES256 phía Server:
👉 **[Passkey, WebAuthn & Virtual Authenticator Architecture](../docs/passkey-webauthn-virtual-authenticator-architecture.md)**

---

## 3. Cấu trúc Thư mục

- `dist/`: Mã nguồn đã đóng gói của extension (Manifest V3, popup, background service worker, content scripts).
- `build/`: Tệp gói ZIP release sẵn sàng nộp lên Chrome Web Store (`webmcp-vault-extension-v1.0.0.zip`).
