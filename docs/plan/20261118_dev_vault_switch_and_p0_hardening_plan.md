# Kế Hoạch Triển Khai Toàn Diện: Dev Vault Switch (`🔓 Vault ↔ </> Dev`), Vá Bảo Mật P0 & Quy Hoạch API Keys Vào Dev Vault

- **Ngày lập**: 2026-11-18
- **Tham chiếu kiến toán**: [20261118-best-in-class-audit-and-dev-vault-architecture.md](file:///Users/ttcenter/Desktop/VIBE_CODE/apps/webmcp-vault-kit/docs/research/20261118-best-in-class-audit-and-dev-vault-architecture.md)
- **Triết lý thiết kế**: `/ponytail` (`0` npm dependencies, tái sử dụng `lib/store.js` & `lib/vault/model.js`, Single Encrypted Store SSOT, trần $\le 1.200$ LOC soft / $\le 1.500$ LOC hard cho mã thực thi)
- **Phạm vi**: Core (`envelope.js`, `model.js`, `autofill.js`, `ssh-agent.js`, `store.js`, `ui-server.js`, `bin/webmcp-vault.mjs`) + Web & macOS Popover UI (`lib/ui/*`) + Chrome Extension `v1.3.0` (`webmcp-vault-extension/dist/*`) + Rebuild App 2 Mac (`local` + `.69`) + Quy hoạch toàn bộ API keys vào Dev Vault.

---

## 1. Kiến Trúc Cốt Lõi: Single Encrypted Store SSOT + `scope: 'normal' | 'dev'`

1. **Không tách 2 file `.enc.json` vật lý**: Giữ nguyên `~/.webmcp/vault/credentials.enc.json` duy nhất để bảo toàn 100% tương thích với CLI `webmcp-vault read` / `run` / `ssh-add` / `lease`, `sync-vault.mjs`, backup, và Touch ID unlock.
2. **Phân vùng ngữ cảnh tại Store (`itemEffectiveScope(item, vaultById)`)**:
   - Mọi thư mục Vault có thêm thuộc tính `scope: 'normal' | 'dev'` (mặc định `'normal'`), cùng cờ tùy chọn `isDefaultDev: true` cho vault Dev gốc (`API Keys`).
   - Mọi item `type !== 'login'` (`api_token`, `ssh_key`, `env`) **luôn thuộc `'dev'`**.
   - Item `type === 'login'` đi theo `vault.scope` của thư mục chứa nó (`'normal'` hoặc `'dev'`).
3. **Cụm Switch `.brand` (`#vaultModeSwitch`) & Extension Toggle (`[🔓 | </>]`)**:
   - Tại `<header class="bar">` (`lib/ui/vault-ui.html`), thay cụm icon + tiêu đề tĩnh bằng Segmented Switch `[🔓 Vault | </> Dev]` cùng phím tắt **`Cmd/Ctrl + Shift + D`**.
   - Hoạt động đồng bộ trên **cả 3 mặt bằng**: Full macOS App (bên phải nút đèn giao thông `padding-left: 86px`), `Cmd + \` Popover (`html.is-mac-popover`, nơi `.vault-sidebar` bị ẩn), và Web UI.
   - Khi chuyển sang **`</> Dev`**: sidebar `VAULTS` chỉ hiện thư mục `scope === 'dev'`, `#itemCount` đếm riêng item Dev, xuất hiện dải lọc nhanh `All | API | SSH | Env`, và nút `+ New` mặc định tạo `api_token` trong vault Dev.
4. **Hợp đồng Điền Dev An Toàn (`Safe Dev-Fill Contract`)**:
   - **`api_token`**: `Cmd + \` / `Alt+K` / `Popup` $\rightarrow$ `Enter` chỉ dán **duy nhất `token`** (`mode: 'pass_only'`); hỗ trợ nút `Copy Bearer Header`.
   - **`ssh_key`**: **BẤT BIẾN**: Hành động Fill mặc định **CHỈ dán `public_key`**, **tuyệt đối không bao giờ** autofill hay trả về `private_key` qua endpoint Autofill! Thao tác với `private_key` đi qua nút 1-chạm `Load ssh-add (1h)` (`POST /api/items/:id/ssh-add`, có hỗ trợ tự truyền `passphrase` qua `SSH_ASKPASS`).
   - **`env`**: Bung phẳng từng biến môi trường trong search `Alt+K` / `Popup` (`<id>::<KEY>`); `Enter` dán đúng giá trị biến đơn, `Shift+Enter` dán `KEY="VALUE"`.

---

## 2. Bộ Vá Bảo Mật & An Toàn Dữ Liệu P0 Best-in-Class

1. **Vòng đời Lock thực sự + Zeroize RAM**:
   - `POST /api/lock` trong `lib/ui-server.js` xóa ngay `sessionUnlockedKey = null; sessionUnlockedExpiresAt = 0;`.
   - Gọi `POST /api/lock` từ `#lockButton` trên App/Web UI và nút `Lock` mới trên Extension Popup.
   - `lib/vault/envelope.js` bọc `try ... finally` gọi `.fill(0)` lên `key`, `plaintext`, `decrypted`.
2. **`passwordHistory` (tối đa `10` bản ghi) + Thùng Rác Mềm (`Trash` / `deletedAt`)**:
   - Khi `updateItem` hoặc `upsertLoginCredential` đổi mật khẩu khác rỗng sang mật khẩu mới, đẩy bản cũ `{ value, changedAt }` vào `item.passwordHistory` (cắt giữ `10` bản gần nhất).
   - `deleteItem(id)` gán `deletedAt = nowIso()` (chuyển vào `Trash`); truyền `{ permanent: true }` (`DELETE /api/items/:id?permanent=1`) để xóa vĩnh viễn; tự động dọn item trong `Trash` quá 30 ngày trong `saveVault()`.
   - Bổ sung `restoreItem(id)` (`POST /api/items/:id/restore`) và `emptyTrash()` (`POST /api/trash/empty`), kèm mục `Trash` ở đáy sidebar UI.
3. **Phòng thủ DOM Extension Clickjacking chuẩn DEF CON 33 (`webmcp-vault-extension v1.3.0`)**:
   - Nâng cấp `isVisibleInput(el)` kiểm tra kích thước tối thiểu (`>= 16x12`), nằm trong viewport, duyệt toàn bộ thẻ tổ tiên đảm bảo `display !== 'none'`, `visibility !== 'hidden'`, `opacity >= 0.75`, không `clip-path: inset(100%)` hay `scale(0)`.
   - Bổ sung `isUnoccludedInput(el)` dùng `document.elementFromPoint(cx, cy)` chống lớp phủ tàng hình trước khi autofill.
   - **Tắt autofill mật khẩu thụ động trên `focusin`**: chỉ hiện badge 🛡️ khi focus ô input, bắt buộc thao tác chủ động (`event.isTrusted !== false` trên click badge/item hoặc `Alt+K` / Popup) mới điền credential.

---

## 3. Phân Công Module & Kiểm Soát Kích Thước File

| Hạng mục | File chính | Trách nhiệm |
| :--- | :--- | :--- |
| **Core Backend** | `lib/vault/{envelope,model,autofill,ssh-agent}.js`, `lib/store.js`, `lib/ui-server.js`, `bin/webmcp-vault.mjs` | Zeroization, `scope` + `Trash` + `passwordHistory`, Safe Dev Autofill, `SSH_ASKPASS`, `POST /api/lock`, `/ssh-add`, `/restore`, `/trash/empty`. |
| **Web / App UI** | `lib/ui/vault-ui.html`, `lib/ui/styles/layout.css`, `lib/ui/app/{state,item-sort,vaults,item-list,controller,keyboard,context-menu,main}.js` | Cụm switch `.brand` (`Cmd+Shift+D`), lọc `Normal ↔ Dev`, `Trash` view, `Password History`, nút `ssh-add` & Dev Fill cho Mac Popover. |
| **Extension v1.3.0** | `webmcp-vault-extension/dist/{manifest.json,background.js,popup.html,popup.js,content-scripts/vault-content.js}` | DEF CON 33 guards, `[🔓 \| </>]` switch trong `Alt+K` & `Popup`, nút Lock Vault, Dev Fill (`token` / `public_key` / `.env` value). |
| **Tests** | `tests/unit/vault-dev-mode-and-hardening.test.mjs`, `tests/unit/vault-extension.test.mjs` | Bao phủ toàn bộ API lock, zeroization, history, soft-delete/restore/purge, Dev fill safety (`ssh_key` cấm lộ `private_key`), clickjacking guards. |

---

## 4. Quy Hoạch API Keys Vào Dev Vault Thực Tế (`~/.webmcp/vault/credentials.enc.json`)

Trước khi chạy migration, tạo backup chuẩn `0o600` qua `store.backup()`, sau đó thực hiện an toàn trong RAM (tuyệt đối không in bí mật ra log):
1. Đổi vault `API_TOKEN` (`f3c028d1-ea16-47b8-b18d-2400024e2393`) thành root Dev vault **`API Keys`** (`scope: 'dev'`, `parentId: null`, `isDefaultDev: true`, `icon: 'key'`), đồng thời tạo sẵn 2 root Dev vault anh em là **`SSH Keys`** (`scope: 'dev'`) và **`Environments`** (`scope: 'dev'`).
2. Chuyển 7 mục **web login** của các nhà cung cấp email SMTP (`admin goicuoc`, `admin gyga`, `Mailgun`, `Sendgrid`, `Mailercloud`, `Mailjet`, `MailerLite (ok)`) đang nằm trong `API_TOKEN` sang vault **`DEV`** (`scope: 'normal'`) để đăng nhập web dashboard vẫn hiển thị gọn ở chế độ Normal.
3. Gom cả `5` mục `type: 'api_token'` hiện có (`YouTube Studio Analytics - Game Di`, `WebMCP Telegram Control Bot`, `Youtube Data V3 API`, `TypeSafe API key (Jev)`, `Rclone - harry2906090@gmail.com`) về **`API Keys`** (`scope: 'dev'`).
4. **Trích xuất không phá hủy (non-destructive)** các API key, GitHub PAT, Strapi API token, MinIO Access/Secret key, Harbor secret, OAuth Client Secret (`n8n`, `Keycloak`, `Authentik`) và `WebMCP Node Executor` đang nằm nhúng trong trường `note`/`password` của các login item thành các mục `type: 'api_token'` riêng sạch sẽ bên trong **`API Keys`** (`scope: 'dev'`), giữ nguyên bản ghi gốc để không ảnh hưởng web login.
