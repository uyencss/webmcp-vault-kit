# Passkey, WebAuthn & Virtual Authenticator Architecture

Tài liệu kiến trúc giải thích cơ chế xác thực Passkey (FIDO2 / WebAuthn), vai trò của Chrome DevTools Protocol Virtual Authenticator (Touch ID ảo), nguyên lý mật mã học bất đối xứng (ECDSA ES256) và mô hình phân tách trách nhiệm (Decoupled Architecture) giữa **WebMCP Vault Kit** và **WebMCP Tools Provider Extension**.

---

## 1. Bài toán thực tế (Problem Statement)

Bình thường, khi người dùng đăng nhập bằng **Passkey** trên Google Chrome (ví dụ: Google, GitHub, Shopee):
1. Trang web gọi Web API: `navigator.credentials.get()`.
2. Trình duyệt Chrome kích hoạt giao diện hệ điều hành yêu cầu xác thực phần cứng: **Touch ID** trên macOS, Windows Hello trên Windows, hoặc YubiKey qua cổng USB.
3. Người dùng chạm ngón tay vào cảm biến $\rightarrow$ Khóa bảo mật ký điện tử và hoàn tất đăng nhập.

> [!IMPORTANT]
> **Vấn đề của AI Agent & Headless Automation:**  
> Một AI Agent hoặc tiến trình tự động hóa chạy lúc nửa đêm (hoặc chạy headless trên máy chủ) **không thể chạm ngón tay vật lý vào cảm biến Touch ID**. Nếu không có cơ chế xử lý chuyên biệt, quy trình tự động hóa sẽ bị treo vô thời hạn tại màn hình chờ sinh trắc học của hệ điều hành.

---

## 2. Nguyên lý Mật mã học WebAuthn: Tại sao không thể "bịa bừa" chìa khóa?

Passkey hoạt động dựa trên nền tảng **Mật mã học bất đối xứng (Asymmetric Cryptography)** và thuật toán **ECDSA** (đường cong Elliptic P-256 / chuẩn `ES256`):

### A. Giai đoạn Tạo Passkey (Registration)
- Khi người dùng tạo Passkey trên một trang web (ví dụ `github.com`), trang web yêu cầu khởi tạo khóa gắn với tên miền định danh `rpId: "github.com"`.
- Trình duyệt/Authenticator sinh ra một cặp khóa:
  - **Khóa Công Khai (Public Key)** kèm mã định danh **`credentialId`**: Được gửi lên và lưu trữ vĩnh viễn trong cơ sở dữ liệu của máy chủ web (GitHub).
  - **Khóa Riêng Bí Mật (Private Key)**: Được cất giữ trong máy của người dùng (1Password, Apple Keychain, hoặc lưu trữ an toàn trong WebMCP Vault Kit).
- Khóa này bị khóa chặt vào tên miền `rpId`. Trình duyệt từ chối sử dụng chìa khóa của `github.com` cho bất kỳ tên miền nào khác (chống tấn công Phishing tuyệt đối).

### B. Giai đoạn Đăng nhập (Authentication)
1. **Phát đề thi (Challenge):** Máy chủ web gửi xuống trình duyệt một chuỗi số ngẫu nhiên chỉ dùng một lần gọi là `challenge` (nonce), kèm danh sách `allowCredentials` (các `credentialId` hợp lệ).
2. **Ký số bằng Private Key:** Trình duyệt tìm đúng chìa khóa có `credentialId` tương ứng, dùng `privateKey` để tính toán chữ ký số ECDSA (cặp tọa độ $(r, s)$) trên chuỗi `challenge`.
3. **Nộp bài thi:** Trình duyệt gửi gói chữ ký điện tử ngược về cho máy chủ web.
4. **Máy chủ chấm thi (Server-Side Verification):** Máy chủ lấy `Public Key` lưu trong database ra đối chiếu với chữ ký $(r, s)$ và `challenge`. Nếu phép toán đường cong Elliptic trả về `TRUE` $\rightarrow$ Đăng nhập thành công!

> [!CAUTION]
> **Quy tắc An ninh "Zero-Trust Client" (Bắt buộc xác thực trên Server):**  
> Việc kiểm tra chữ ký số **bắt buộc phải diễn ra trên máy chủ của trang web**, tuyệt đối không thể diễn ra cục bộ trong trình duyệt. Nếu kiểm tra tại máy khách, kẻ tấn công chỉ cần mở Chrome DevTools sửa mã JavaScript thành `return true` là có thể xâm nhập trái phép. Máy chủ phải tự tay chấm điểm thì mới cấp Cookie/JWT phiên đăng nhập hợp lệ.

---

## 3. Chrome Virtual Authenticator (Touch ID ảo) là gì?

Để hỗ trợ kiểm thử tự động (automated testing) và AI Agents, Google Chromium tích hợp sẵn một cơ chế đặc biệt trong Chrome DevTools Protocol (CDP): **`WebAuthn.addVirtualAuthenticator`**.

- **Bản chất:** Đây là một bộ cảm biến FIDO2/CTAP2 ảo được tạo trực tiếp trong bộ nhớ RAM của một tab Chrome cụ thể.
- **Tính năng tự động duyệt:** Khi được cấu hình `automaticPresenceSimulation: true` và `isUserVerified: true`, chiếc Touch ID ảo này sẽ **tự động xác nhận thành công ngay lập tức** khi trang web gọi `navigator.credentials.get()`, loại bỏ 100% pop-up đòi hỏi vân tay vật lý của hệ điều hành.
- **Vòng đời tạm thời (Ephemeral):** Được tạo ra khi bắt đầu phiên đăng nhập, nạp khóa vào để ký, và bị hủy ngay lập tức (`WebAuthn.removeVirtualAuthenticator`) trong khối `finally` để trả lại trạng thái an toàn cho trình duyệt.

---

## 4. Mô hình Phân tách Trách nhiệm (Decoupled Architecture)

Hệ thống WebMCP chia tách ranh giới rõ ràng giữa **Nơi cất giữ bí mật (Vault Kit)** và **Công cụ điều khiển hiện trường (WebMCP Tools Provider)**:

```mermaid
sequenceDiagram
    autonumber
    actor Agent as AI Agent / Runner
    participant Vault as WebMCP Vault Kit (127.0.0.1:7876)
    participant Extension as WebMCP Tools Provider (v2.1.14)
    participant Chrome as Chrome CDP (RAM)
    participant Web as Target Website (e.g. GitHub)
    participant Server as Target Web Server

    Web->>Server: Request Passkey Sign-in
    Server-->>Web: Send Challenge + rpId + credentialId
    Agent->>Vault: Lease Passkey Credential (token-gated)
    Vault-->>Agent: Return { credentialId, rpId, privateKey } (PKCS#8)
    Agent->>Extension: Command: passkey.authenticateWithVirtualAuthenticator
    Note over Extension,Chrome: Kích hoạt CDP trên Tab
    Extension->>Chrome: WebAuthn.enable
    Extension->>Chrome: WebAuthn.addVirtualAuthenticator (CTAP2, autoPresence)
    Chrome-->>Extension: Return authenticatorId
    Extension->>Chrome: WebAuthn.addCredential (nạp privateKey & credentialId)
    Extension->>Web: Click Passkey Sign-in trigger
    Web->>Chrome: navigator.credentials.get()
    Note over Chrome: Touch ID ảo tự ký Challenge bằng Private Key
    Chrome-->>Web: Return WebAuthn Assertion (Signature r, s)
    Web->>Server: HTTP POST /api/passkey/verify (gửi chữ ký)
    Note over Server: Server dùng Public Key xác thực ECDSA
    Server-->>Web: Session Cookie Granted (200 OK)
    Note over Extension,Chrome: Dọn dẹp dấu vết (finally block)
    Extension->>Chrome: WebAuthn.removeVirtualAuthenticator
    Extension->>Chrome: WebAuthn.disable
    Extension-->>Agent: { ok: true, rpId: "github.com", triggered: true }
```

### So sánh vai trò các thành phần:

| Tiêu chí | WebMCP Vault Kit | WebMCP Tools Provider (`v2.1.14`) | WebMCP Vault Companion Extension |
|---|---|---|---|
| **Vị trí** | Daemon cục bộ / Node.js CLI | Chrome Extension (Quyền `debugger` + `<all_urls>`) | Chrome Extension (Quyền UI thông thường) |
| **Quyền hạn nhạy cảm** | Quản lý két mã hóa AES-256-GCM, KDF scrypt, SQLite 1Password | Thao tác Chrome DevTools Protocol (CDP), điều khiển DOM/Network | Form detection, autofill UI, tương tác trực tiếp người dùng |
| **Trách nhiệm với Passkey** | Lưu trữ an toàn `privateKey`, `credentialId`, `rpId`, cấp lease ngắn hạn | Khởi tạo Touch ID ảo trong RAM Chrome, cắm chìa để ký tự động, tự hủy | Hỗ trợ người dùng người thật đăng nhập bằng Touch ID vật lý |
| **Bảo mật dữ liệu** | Mã hóa an toàn tại ổ đĩa (`0600`) | **Không lưu mật khẩu**. Chỉ nhận credential tạm qua WebSocket để nạp vào CDP | Không lưu mật khẩu cục bộ, gọi qua HTTP API `127.0.0.1:7876` |

---

## 5. Đặc tả Kỹ thuật Triển khai trong Code

Đoạn mã cốt lõi được hiện thực tại [`packages/webmcp-browser-kit/webmcp-extension/dist/bg/handlers/passkey-actions.js`](file:///Users/ttcenter/Desktop/VIBE_CODE/webmcp-automation-kit/packages/webmcp-browser-kit/webmcp-extension/dist/bg/handlers/passkey-actions.js):

```javascript
// 1. Kích hoạt WebAuthn CDP
await sendCDPCommand(tabId, 'WebAuthn.enable', { enableUI: false });

// 2. Tạo Touch ID ảo (CTAP2 internal authenticator)
const added = await sendCDPCommand(tabId, 'WebAuthn.addVirtualAuthenticator', {
  options: {
    protocol: 'ctap2',
    transport: 'internal',
    hasResidentKey: true,
    hasUserVerification: true,
    isUserVerified: true,
    automaticPresenceSimulation: true,
    defaultBackupEligibility: cred.backupEligibility !== false, // BE=1
    defaultBackupState: cred.backupState !== false,             // BS=1
  },
});
const authenticatorId = added.authenticatorId;

// 3. Nạp chìa khóa lấy từ Vault Kit vào Touch ID ảo
await sendCDPCommand(tabId, 'WebAuthn.addCredential', {
  authenticatorId,
  credential: {
    credentialId: base64UrlToStandardBase64(cred.credentialId),
    isResidentCredential: cred.isResidentCredential !== false,
    rpId: cred.rpId,
    privateKey: String(cred.privateKey).trim(), // PKCS#8 DER base64
    userHandle: base64UrlToStandardBase64(cred.userHandle || ''),
    signCount: Number(cred.signCount || 0) >>> 0,
    backupEligibility: cred.backupEligibility !== false,
    backupState: cred.backupState !== false,
  },
});

// 4. Kích hoạt trigger trên trang web
if (params.triggerSelector) {
  await evaluateInTab(tabId, `document.querySelector(${JSON.stringify(params.triggerSelector)})?.click()`);
}

// 5. Khối finally: Dọn dẹp sạch sẽ Touch ID ảo khỏi RAM
finally {
  if (authenticatorId) {
    try {
      await sendCDPCommand(tabId, 'WebAuthn.removeVirtualAuthenticator', { authenticatorId });
    } catch {}
  }
  try {
    await sendCDPCommand(tabId, 'WebAuthn.disable', {});
  } catch {}
}
```

---

## 6. Ghi chú Khả năng Tương thích (Compatibility Notes)

1. **Cờ `BE=1` và `BS=1` (Backup Eligibility & Backup State):**
   - Hầu hết các Passkey hiện đại được tạo bởi 1Password, Apple Keychain hoặc Google Password Manager đều bật cờ đồng bộ đám mây (`backupEligibility: true`, `backupState: true`, cờ bit assertion `0x1d` hoặc `0x5d`).
   - Nếu Virtual Authenticator không khai báo `defaultBackupEligibility: true`, các máy chủ khắt khe (như Google Accounts hoặc GitHub) sẽ từ chối chữ ký vì không khớp với trạng thái đã đăng ký lúc tạo khóa ban đầu.
2. **Định dạng khóa `privateKey`:**
   - CDP yêu cầu khóa riêng ở định dạng **PKCS#8 DER mã hóa Base64** (không có header PEM `-----BEGIN PRIVATE KEY-----`).
   - Vault Kit hỗ trợ chuyển đổi tự động từ định dạng JSON Web Key (JWK) của 1Password sang PKCS#8 DER thông qua Node.js `crypto.createPrivateKey`.
3. **Cơ chế Autofill Ủy quyền (`vault.autofill`):**
   - Khi không dùng Passkey mà dùng Username/Password/TOTP truyền thống, WebMCP Tools Provider không đọc mật khẩu thô mà bắn sự kiện `CustomEvent('__webmcp_vault_agent_cmd__')` cho `WebMCP Vault Companion` tự điền, đảm bảo mô hình AI Agent có tầm nhìn **Zero-Knowledge** đối với mật khẩu người dùng.
