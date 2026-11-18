# Execution Plan (`/ponytail`): Header Backup Modal (`rclone` Google Drive Auth + Zero-Knowledge Backup) & 2-Way `sync-vault.mjs sync`

> **Ngày lập**: `2026-11-18`  
> **Phạm vi**: `apps/webmcp-vault-kit` (Core Backup + HTTP UI Server + Header Backup Modal + CLI + Mac M1 `.69` Sync)  
> **Lăng kính thiết kế**: `/ponytail` (Rung 5: tái sử dụng `rclone` đã cài sẵn, `0` npm dependency, `0` vòng lặp nền đốt CPU)  
> **Bài học kiến trúc từ sự cố `8dd6a6ef`**: Tránh tuyệt đối lỗi gọi `scryptSync` lặp lại trên Main Thread khi mở modal hoặc giữ vòng lặp polling/watch gây quá tải **99.6% CPU**.

---

## 1. Kiến trúc `/ponytail` & 5 Bất biến Chống Quá Tải CPU

Theo thang `/ponytail`, không viết lại Google Drive REST client hay OAuth local loopback server bằng Node.js khi `rclone v1.75.1` (`arm64`) và `~/.config/rclone/rclone.conf` đã có sẵn trên máy:

| Bất biến | Cơ chế thực thi | Mục tiêu hiệu năng / An toàn |
| :--- | :--- | :--- |
| **1. `0` `scryptSync` & `0` Network khi mở Modal** | `GET /api/backup/status` chỉ đọc INI section header từ `~/.config/rclone/rclone.conf`, `readdirSync` thư mục `backups/`, `cloud-backup-state.json`, và SHA-256 file `credentials.enc.json`. | Mở Modal `< 2ms`, **0%** CPU spike (không tái diễn bão `285x scryptSync` ~9–29s như `8dd6a6ef`). |
| **2. `0` `execSync` trong HTTP Server** | Mọi lệnh `rclone` trong `lib/vault/rclone-backup.js` đều chạy qua async `child_process.spawn` với `PATH` chuẩn hóa (`~/.local/bin:/opt/homebrew/bin:/usr/local/bin`) và timeout cứng (`15s` `lsjson`, `60s` `copyto`, `120s` `config create`). | Không bao giờ treo Event Loop của daemon `:7876`. |
| **3. `0` Vòng lặp chạy ngầm khi đóng Modal** | Không tạo `setInterval` ngoài lúc đang chờ `rclone` Google OAuth (`authJob.status === 'pending'`). Khi poll `GET /api/backup/rclone/auth/status`, endpoint chỉ đọc **1 object RAM** (`0.01ms`, `0` disk, `0` KDF, `0` subprocess) mỗi `2000ms` (tối đa 60 nhịp = `120s`) và dọn `clearInterval` ngay khi đóng dialog hoặc đổi trạng thái. | CPU nhàn rỗi **0.0%** sau khi đóng modal hoặc xong backup. |
| **4. Tra cứu OAuth Client tối đa `1` lần giải mã** | Ưu tiên tái sử dụng `client_id` + `client_secret` từ `rclone.conf` (`0` lần giải mã Vault). Nếu chưa có mới gọi `store.listItems()` 1 lần, lọc tiêu đề `/rclone\|gdrive/i` và `getItem({ reveal: true })` trên tối đa `1–2` mục khớp. | Chấm dứt hoàn toàn việc giải mã toàn bộ 284 items. |
| **5. Chốt chặn Zero-Knowledge (`assertEncryptedEnvelopeFile`)** | Cấm cứng mọi file khớp `vault.key` / `*.key` / `vault-ui.json`, và bắt buộc xác thực file là envelope `version: 1`, `cipher: "aes-256-gcm"`, `kdf.name: "scrypt"` trước khi `rclone copyto`. | `vault.key` tuyệt đối không bao giờ chạm tới Google Drive. |

---

## 2. Cấu phần Triển khai

### A. Backend & CLI (`lib/vault/rclone-backup.js`, `lib/ui-server.js`, `bin/webmcp-vault.mjs`, `sync-vault.mjs`)
1. **`lib/vault/rclone-backup.js`**:
   - `resolveRcloneBin()`, `parseRcloneDriveRemotes()` (redacted: không lộ `token`/`client_secret`), `findReusableDriveOAuthClient()`.
   - `assertEncryptedEnvelopeFile(filePath)` trả `{ sha256, sha8, sizeBytes }`.
   - `getBackupStatus()` đọc siêu nhẹ (`< 2ms`).
   - `bootstrapRcloneFromVault({ store, rcloneConfPath })` trích tối đa 3 mục `Rclone`/`GDrive` (`api_token`) vào `rclone.conf` (`0o600`) cho máy mới như Mac M1 `.69`.
   - `startGdriveAuth()`, `getAuthJobPublic()`, `cancelGdriveAuth()` bọc `rclone config create <remote> drive scope=drive.file config_is_local=true`, bắt URL OAuth tức thì và tự động `backupToRclone()` ngay khi đăng nhập xong.
   - `backupToRclone()` kiểm tra chống trùng SHA-256 trên cloud (`lsjson` + `.sha8.enc.json`), tạo snapshot local nếu chưa có, upload bằng `rclone copyto`, giữ lại 30 bản gần nhất trên Drive (`deletefile`), lưu `cloud-backup-state.json` (`0o600`).
   - `listCloudBackups()` liệt kê bản snapshot `.enc.json` trên Drive.
2. **`lib/ui-server.js`**:
   - Yêu cầu `hasExplicitUiToken()` (chặn `chrome-extension://` không có UI token) cho toàn bộ `/api/backup/status` & `/api/backup/rclone/*` (`status`, `list`, `push`, `bootstrap-vault`, `auth/start`, `auth/status`, `auth/cancel`).
3. **`bin/webmcp-vault.mjs` & `skills/webmcp-vault/scripts/sync-vault.mjs`**:
   - `webmcp-vault backup --remote <name> [--force] [--json]`: backup local + đẩy offsite lên `rclone`.
   - `sync-vault.mjs sync [--remote <host>] [--dry-run] [--json]`: gộp 2 chiều không mất dữ liệu theo `item.id` + `updatedAt` + `deletedAt` tombstone + bảo toàn `passwordHistory`.

### B. UI Header Backup Button & Modal (`lib/ui/vault-ui.html`, `backup-modal.js`, `main.js`, `components.css`, `layout.css`)
- Đưa `#backupButton` lên cụm `.bar-right` ngay cạnh `#lockButton` (giữa nút Theme và Lock), ẩn trong `html.is-mac-popover`.
- Bấm `#backupButton` mở `<dialog id="backupDialog">` cho phép:
  1. Chọn remote Google Drive có sẵn hoặc bấm `+ Connect Google Drive` / `Import from Vault` để cấp quyền Google qua `rclone` (tự mở trình duyệt Google Sign-In và tự backup ngay sau khi Auth xong).
  2. Bấm `Backup to Google Drive` (chống trùng SHA-256) hoặc `Save Local Snapshot` hoặc `View Drive Snapshots`.
- Tuân thủ 100% Strict CSP (không `style="..."` inline) và quy tắc `components.css` không chứa literal hex/rgb (dùng CSS custom properties `var(...)`).

---

## 3. Kế hoạch Kiểm chứng & Triển khai Cụm Máy
1. **Unit tests (`tests/unit/vault-rclone-backup-and-sync.test.mjs`)**: Mock `rclone` kiểm tra `0` `vault.key` leak, chống trùng SHA-256, auth start/cancel, auth token enforcement (`401` cho extension origin), và 2-way merge `sync-vault.mjs`.
2. **Gates**: `npm test` + `check-file-loc.mjs` (`0` warnings/violations).
3. **Live Test + Cluster Rollout**:
   - Đưa binary `rclone` (`arm64`) lên Mac M1 `.69` (`~/.local/bin/rclone`).
   - Build lại `WebMCP Vault.app` + kiểm tra backup thực tế lên `gdrive:webmcp-vault-backups/` + đo CPU idle `%cpu` của daemon `:7876`.
   - Push trực tiếp lên `origin main`, chạy Final Security & CPU Review độc lập, và deploy/sync toàn diện sang Mac M1 `.69`.
