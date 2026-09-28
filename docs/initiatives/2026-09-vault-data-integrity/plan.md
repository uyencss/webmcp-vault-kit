---
title: Vault Data Integrity Hardening — Plan
type: plan
status: proposed
created: 2026-09-26
updated: 2026-09-26
baseline: a9194e5
---

# Plan

Thứ tự: **lõi + CLI trước, phát hành, rồi mới đến UI.** Kết thúc Phase 1 là
một mốc phát hành (dời pin vault-kit). Từ đó CLI, store API và lease/broker đã
an toàn để dùng cho việc khác, không cần chờ UI. Phase 2 (UI) không chặn ai.

Phase 1 cũng giảm rủi ro cho UI cũ ngay cả trước khi Phase 2 xong: sau C1,
server tự giữ secret khi nhận giá trị rỗng. Vì vậy lỗi `OTP` và race Cmd+S trên
UI cũ không còn xoá được secret đã lưu, chỉ còn là lỗi hiển thị.

## Cách dùng checklist này (bắt buộc với mọi agent)

1. **Nhận task:** ghi tên agent/model và ngày vào dòng `Owner:` trước khi bắt
   đầu. Task đã có owner khác và chưa xong thì không nhận.
2. **Tick từng bước ngay khi xong**, không tick dồn. Chỉ tick khi có bằng
   chứng: test đã thực sự chạy đỏ/xanh, lệnh đã chạy, file đã đọc lại.
3. **Ghi bằng chứng** vào `Evidence:`: commit SHA, tên test, hoặc một dòng
   output (ví dụ `tests 90 / pass 76 / fail 14`).
4. **Bị chặn:** không tick. Ghi `BLOCKED: <lý do>` ngay dưới task rồi dừng.
5. **Không sửa phạm vi task.** Muốn đổi thì ghi vào
   [Nhật ký thay đổi](#nhật-ký-thay-đổi) và báo orchestrator.
6. Tên test mới bắt đầu bằng `integrity:`. 14 test `RED:` hiện có phải giữ
   nguyên trạng thái (fail).
7. Không bao giờ đụng `~/.webmcp`. Mọi repro dùng `WEBMCP_HOME` scratch và
   dữ liệu `AUDIT-*`.

Checklist trong từng task là nguồn sự thật duy nhất. Bảng tiến độ chỉ được
cập nhật khi mọi bước của task đã được tick.

## Tiến độ tổng

| Phase | Nội dung | Xong |
| --- | --- | --- |
| 0 | Chốt quyết định D1–D4 | 0/4 |
| 1 | Lõi + CLI (C1–C10) | 0/10 |
| 1R | Mốc phát hành CLI | 0/1 |
| 2 | UI server + UI (U1–U8) + runbook | 0/9 |
| 3 | Đóng initiative | 0/1 |

---

## Phase 0: Chốt quyết định (owner: người dùng)

Chưa tick thì không bắt đầu Phase 1. Chi tiết xem
[README](README.md#quyết-định-cần-chốt).

- [ ] **D1:** update gửi `value: ""` cho secret field đang có giá trị → giữ giá trị cũ; muốn xoá thì xoá cả dòng field
- [ ] **D2:** đổi type thì map đủ `username`/`otpSecret`; nếu làm rơi field thì từ chối, trừ khi có `dropFields: true`
- [ ] **D3:** `useLease` chỉ dùng `lease.itemId`
- [ ] **D4:** `init --force` trên vault đã tồn tại thì tự backup trước khi ghi đè

---

## Phase 1: Lõi và CLI

Không đụng `lib/ui-server.js`, `lib/ui/**`. Phân công theo wave xem
[Phân công](#phân-công).

### C1: Update validate lại required fields và giữ secret khi gửi rỗng (D1)

File: `lib/vault/model.js:136-146`, test: `tests/unit/vault-typed.test.mjs`
Owner: — · Evidence: —

- [ ] Viết test `integrity: update without token field is rejected`: tạo api_token có `token`, update `fields` chỉ gồm một field metadata → throw `require a token field`
- [ ] Viết test `integrity: empty secret value keeps stored value`: env có `API_TOKEN=AUDIT-1` (secret), update cùng field với `value: ""` → `readField` vẫn trả `AUDIT-1`
- [ ] Chạy cả hai, xác nhận **fail**
- [ ] Trong `normalizeItemInput`: khi `has('fields') && existing`, field secret có `value === ""` và trùng `name` với field cũ đang có giá trị thì dùng lại giá trị cũ
- [ ] Sau khi merge, luôn gọi `assertRequiredFields(type, patch.fields)` mỗi khi `has('fields')`
- [ ] Hai test pass; `npm test` chỉ còn 14 fail `RED:`
- [ ] Commit

### C2: Đổi type không làm rơi dữ liệu (D2)

File: `lib/store.js:163-172` (helper mapping đặt trong `lib/vault/model.js`), test: `tests/unit/vault-typed.test.mjs`
Owner: — · Evidence: —

- [ ] Viết test `integrity: login→api_token→login keeps username and otp`: login có `username`, `password`, `otpSecret` → api_token → login → cả ba còn nguyên
- [ ] Viết test `integrity: lossy type change is rejected`: api_token có thêm `key_id` → login mà không có `dropFields` → throw `Type change would drop fields: key_id`
- [ ] Viết test `integrity: lossy type change allowed with dropFields`: như trên, có `dropFields: true` → thành công
- [ ] Chạy ba test, xác nhận fail
- [ ] Một hàm mapping duy nhất cho cả hai chiều: `username` ↔ field `username` (non-secret), `otpSecret` ↔ field `otp_secret` (secret), password/note/web như hiện có
- [ ] Thay khối `delete item.*` trong `updateItem` bằng mapping này; field không rỗng mà không map được thì throw, trừ khi `input.dropFields === true`
- [ ] Nếu test cũ `vault-typed.test.mjs:231` dựa vào hành vi xoá thì sửa theo, ghi lý do vào Evidence
- [ ] CLI `update` nhận `--drop-fields` và truyền thành `dropFields: true` (phần sửa trong `bin/` do owner C5 làm nếu C5 đang giữ file; ghi chú vào Evidence)
- [ ] `npm test` sạch
- [ ] Commit

### C3: Tên field trùng không phân biệt hoa/thường

File: `lib/vault/model.js:56,69`, test: `tests/unit/vault-typed.test.mjs`
Owner: — · Evidence: —

- [ ] Viết test `integrity: Token and token are duplicates`: tạo item có cả hai → throw duplicate
- [ ] Chạy, xác nhận fail
- [ ] Dedup trong `normalizeFields` theo `name.toLowerCase()`
- [ ] Kiểm tra trên vault scratch: item cũ đã có cặp trùng hoa/thường vẫn đọc được. Không đọc được thì ghi `BLOCKED` và báo orchestrator
- [ ] `npm test` sạch
- [ ] Commit

### C4: Không cho ghi vault vượt 64 MiB

File: `lib/vault/envelope.js:101-104`, test: `tests/unit/vault-store.test.mjs`
Owner: — · Evidence: —

- [ ] Viết test `integrity: oversized write is refused and old file kept`: dùng giới hạn chỉnh được trong test (tham số hoặc biến module), ghi vượt ngưỡng → throw; sha256 file cũ không đổi
- [ ] Chạy, xác nhận fail
- [ ] Trong `writeEnvelope`: serialize trước, `Buffer.byteLength(out) > MAX_ENVELOPE_BYTES` thì throw trước `writePrivateFile`
- [ ] `npm test` sạch
- [ ] Commit

### C5: Parse cờ boolean đúng trong CLI

File: `bin/webmcp-vault.mjs:21-45` (`parseFlags`), `:503` (`gateway-token`), test: `tests/unit/webmcp-vault-cli.test.mjs`
Owner: — · Evidence: —

- [ ] Viết test `integrity: init --force=false keeps items`
- [ ] Viết test `integrity: delete --confirm=false does not delete`: item còn, exit code ≠ 0
- [ ] Viết test `integrity: get --reveal=false stays redacted`
- [ ] Chạy ba test, xác nhận fail
- [ ] Trong `parseFlags`: `"false"|"0"|"no"` → `false`, `"true"|"1"|"yes"` → `true`. Vá một chỗ, không vá từng call site
- [ ] `--gateway-token=false` hoặc rỗng → báo lỗi, không gửi chuỗi `"false"` làm bearer token
- [ ] Rà cả 8 call site (`:290, 304, 324, 414, 428, 440, 465, 551`) để chắc chúng nhận boolean thật
- [ ] `npm test` sạch
- [ ] Commit

### C6: `init --force` tự backup trước khi ghi đè (D4)

File: `lib/store.js:82-90`, `bin/webmcp-vault.mjs` (in đường dẫn), test: `tests/unit/webmcp-vault-cli.test.mjs`
Owner: — · Evidence: —

- [ ] Viết test `integrity: init --force backs up existing vault`: vault có 2 item → `init --force --json` → có `backupFile`, file tồn tại, `restore` từ file đó lấy lại đủ 2 item
- [ ] Chạy, xác nhận fail
- [ ] Trong `init`: `force` và file tồn tại → gọi `backupApi.backup()` trước khi ghi, trả `backupFile`
- [ ] Khi không có `--json`, CLI in `Backup: <path>`
- [ ] `npm test` sạch
- [ ] Commit

### C7: Lease luôn dùng item đã bind (D3)

File: `lib/vault/leases.js:202`, test: `tests/unit/vault-leases.test.mjs`
Owner: — · Evidence: —

- [ ] Viết test `integrity: useLease ignores caller itemId`: lease cho item A; `useLease({ itemId: B.id, ... })` → không bao giờ trả secret của B
- [ ] Chạy, xác nhận fail
- [ ] Đổi thành `resolveItem(loadVault().items, lease.itemId)`
- [ ] Grep lại `useLease` trong `webmcp-ops-kit` và `webmcp-automation-kit`: không consumer nào truyền `itemId`
- [ ] `npm test` sạch
- [ ] Commit

### C8: Lỗi parse `.env` không in nội dung dòng

File: `lib/vault/envfile.js:71,76`, test: `tests/unit/vault-envfile.test.mjs`
Owner: — · Evidence: —

- [ ] Viết test `integrity: malformed env line is not echoed`: dòng `API_KEY sk-live-x` và `=sk-live-y` → message có số dòng, không chứa `sk-live`
- [ ] Chạy, xác nhận fail
- [ ] Bỏ `rawLine` khỏi cả hai message lỗi
- [ ] `npm test` sạch
- [ ] Commit

### C9: Sửa race khi dọn stale lock

File: `lib/vault/fs-safe.js:63-120`, test mới: `tests/unit/vault-lock-race.test.mjs`
Owner: — · Evidence: —

- [ ] Viết test stress `integrity: stale lock reap admits one writer`: 8 process con, lock stale có sẵn với pid đã chết, 20 vòng → số item được lưu == số writer báo `ok:true`
- [ ] Chạy, xác nhận fail (tham khảo lúc audit: 13/20 vòng lỗi)
- [ ] Lock ghi `{ pid, nonce }`; release chỉ unlink khi nonce trong file là của mình
- [ ] Reap bằng `renameSync(lock, lock + '.reap.' + random)`, rồi so `ino` với `stat` đã kiểm tra; khác nhau (tức vừa cướp nhầm lock mới) thì `linkSync` trả lại và báo busy; xoá tombstone
- [ ] **Không** dùng cách "stat lại trước khi unlink" (vẫn còn race)
- [ ] Test stress pass 20/20, chạy 3 lần liên tiếp
- [ ] `npm test` sạch
- [ ] Commit

### C10: Tài liệu phần lõi và CLI

File: `docs/ARCHITECTURE.md:207-208`, `skills/webmcp-vault/SKILL.md`, `README.md`
Owner: — · Evidence: —

- [ ] Bỏ câu "type is immutable"; mô tả mapping khi đổi type, `dropFields` / `--drop-fields`
- [ ] Ghi D1: gửi secret rỗng thì giữ giá trị cũ, muốn xoá thì xoá cả field
- [ ] SKILL.md: `init --force` tự backup và in đường dẫn; `--flag=false` được hiểu đúng
- [ ] Ghi giới hạn 64 MiB và hành vi từ chối ghi khi vượt
- [ ] Commit

### Cổng Phase 1

- [ ] C1–C10 đã tick đủ
- [ ] `npm test` trong package: không có fail ngoài 14 `RED:`; ghi số liệu vào Evidence
- [ ] Smoke test CLI trên vault scratch: `init` → `create` login/api_token/env → `update` → `read` → `lease issue`/`lease read` → `backup` → `restore`, tất cả đúng
- [ ] Test consumer liên kit xanh: `webmcp-ops-kit/packages/webmcp-node-executor` (lease), `webmcp-automation-kit/packages/webmcp-browser-kit` (vault doctor/bridge)
- [ ] Orchestrator tự review diff Phase 1 (verify, không chỉ đọc báo cáo)

---

## Phase 1R: Mốc phát hành CLI

Sau mốc này, CLI và store API dùng được cho việc khác. Dời pin cần người dùng
đồng ý trước khi push.

- [ ] Người dùng đồng ý dời pin (ghi ngày vào Evidence)
- [ ] Dời pin vault-kit trong lockfile của `webmcp-automation-kit` (commit `fix(lock): …`), test consumer xanh
- [ ] `webmcp vault doctor --json` qua bridge của browser-kit trả kết quả đúng với pin mới
- [ ] Cập nhật bảng Tiến độ tổng; ghi SHA đã phát hành vào Nhật ký thay đổi

Owner: orchestrator · Evidence: —

---

## Phase 2: UI server và UI

Bắt đầu sau Phase 1R. Không có harness test DOM; mỗi task UI nghiệm thu bằng
kịch bản tương ứng trong [Runbook U-R](#u-r-runbook-nghiệm-thu-ui-qua-webmcp-browser).

### U1: `/read?field=OTP` chỉ đi vào nhánh TOTP với item login

File: `lib/ui-server.js:227`, test: `tests/unit/vault-ui-server.test.mjs`
Owner: — · Evidence: —

- [ ] Viết test `integrity: typed field named OTP reads its stored value`: env có `OTP=AUDIT-OTP`, `GET /api/items/:id/read?field=OTP` → `value === 'AUDIT-OTP'`
- [ ] Chạy, xác nhận fail
- [ ] Thêm điều kiện `(item.type || 'login') === 'login'` vào nhánh `readTotp`
- [ ] Item login: `read?field=otp` vẫn trả mã TOTP (test hiện có pass)
- [ ] `npm test` sạch
- [ ] Commit

### U2: Cmd+S không bỏ qua nút Save đang disabled

File: `lib/ui/app/keyboard.js:28-34` · Owner: — · Evidence: —

- [ ] Chạy kịch bản R2 trên code cũ, xác nhận lỗi (có request PUT trong lúc preload)
- [ ] Chỉ gọi `requestSubmit()` khi `state.editMode && !el('submitButton').disabled`
- [ ] Chạy lại R2: không có PUT; sau khi preload xong Cmd+S lưu bình thường
- [ ] Commit

### U3: Reveal all không xoá chỉnh sửa chưa lưu

File: `lib/ui/app/main.js:44-63` · Owner: — · Evidence: —

- [ ] Khi `state.formDirty` thì hỏi `confirmDiscardChanges()`; người dùng huỷ thì không gọi `fillForm`
- [ ] Chạy R3: pass
- [ ] Commit

### U4: Private key nhiều dòng dùng `<textarea>`

File: `lib/ui/app/controller.js:140` (+ CSS nếu cần) · Owner: — · Evidence: —

- [ ] Field `private_key`, và mọi field có giá trị chứa `\n`, render bằng `<textarea>`
- [ ] Vẫn che được giá trị (cơ chế hiện/ẩn sẵn có hoặc `-webkit-text-security`)
- [ ] Chạy R4: đọc lại qua CLI thấy đủ newline
- [ ] Commit

### U5: Đổi type trên UI: map đủ, có confirm, cập nhật tiêu đề

File: `lib/ui/app/controller.js:212-249` · Owner: — · Evidence: —

- [ ] Dùng cùng quy tắc mapping với C2 (username, otp_secret, password, note, web)
- [ ] Server trả lỗi `would drop fields` → hiện confirm liệt kê field sẽ mất → đồng ý thì gửi lại kèm `dropFields: true`
- [ ] Cập nhật `detailTitle` (H2) cùng lúc với `detailEyebrow`
- [ ] Chạy R5: pass
- [ ] Commit

### U6: `.field-row` dùng được ở màn hình hẹp

File: `lib/ui/styles/fields.css:398-409`, `lib/ui/styles/responsive.css` · Owner: — · Evidence: —

- [ ] Dưới 560px: `.field-row { flex-wrap: wrap }`, ô value chiếm hết chiều ngang
- [ ] Chạy R6 (phần độ rộng ô value ≥ 200px)
- [ ] Commit

### U7: Mobile: form chi tiết không bị đẩy xuống dưới màn hình

File: `lib/ui/styles/responsive.css:5-39` (+ `main.js` hoặc `item-list.js` cho nút quay lại) · Owner: — · Evidence: —

- [ ] Dưới 900px, khi đã chọn item: ẩn `.vault-sidebar` và `.rail`, có nút quay lại danh sách
- [ ] Chạy R6 (phần form bắt đầu trong 150px đầu)
- [ ] Desktop không đổi (chụp màn hình trước/sau ở 1440px)
- [ ] Commit

### U8: Ô value của field có accessible name

File: `lib/ui/app/controller.js:140-152` · Owner: — · Evidence: —

- [ ] `aria-label` của ô value = tên field; cập nhật khi đổi tên field
- [ ] `getAriaSnapshot` hiện đúng tên field cho từng ô
- [ ] Commit

### U-R: Runbook nghiệm thu UI qua webmcp browser

Chuẩn bị: `WEBMCP_HOME` scratch, key tổng hợp qua `WEBMCP_VAULT_KEY_FILE`, chạy
`webmcp-vault ui --json --port 7891` ở background, mở một tab mới tới token
URL, mở khoá bằng "Use configured key". Mỗi kịch bản **phải đọc lại qua CLI**
(`read <id> <field> --json`), không chỉ nhìn DOM.

Owner: — · Evidence: —

- [ ] **R1:** env có `OTP`, `API_TOKEN`, `REGION`; sửa title, Save → cả 3 còn giá trị
- [ ] **R2:** làm chậm `fetch /read` 1.5s, Cmd+S giữa chừng → không có PUT, dữ liệu nguyên vẹn
- [ ] **R3:** sửa title, bấm Reveal all → có hỏi xác nhận; huỷ thì chỉnh sửa được giữ
- [ ] **R4:** paste PEM 3 dòng vào `private_key`, Save → CLI đọc lại được 3 ký tự `\n`
- [ ] **R5:** login (username + TOTP) → api_token → login → username và TOTP còn nguyên; api_token có `key_id` → login thì có confirm
- [ ] **R6:** viewport 390×844: ô value rộng ≥ 200px; `.detail` bắt đầu trong 150px đầu (đo bằng `getBoundingClientRect`)
- [ ] Dọn dẹp: tắt server, đóng tab, xoá scratch; sha256 vault thật không đổi

### Cổng Phase 2

- [ ] U1–U8 và U-R đã tick đủ
- [ ] `webmcp-desktop-app` vẫn spawn được UI server (smoke test)
- [ ] Orchestrator review diff Phase 2

---

## Phase 3: Đóng initiative

- [ ] Cổng Phase 1 và Phase 2 đã đạt
- [ ] `npm test` cuối: ghi số liệu vào Evidence
- [ ] Dời pin lần hai cho phần UI (cần người dùng đồng ý), test consumer xanh
- [ ] Đổi `status:` trong README thành `done`; cập nhật bảng Tiến độ tổng

---

## Phân công

Mỗi agent làm trong một git worktree riêng; orchestrator merge theo thứ tự
trong bảng.

| Wave | Task | Write-set | Ghi chú |
| --- | --- | --- | --- |
| A1 | C1, C2, C3, C4, C6 (phần store) | `lib/vault/model.js`, `lib/store.js`, `lib/vault/envelope.js`, `vault-typed`, `vault-store` | Một agent, vì cùng `model.js`/`store.js`. Đường dài nhất của Phase 1 |
| A2 | C5, phần CLI của C2 (`--drop-fields`) và C6 (in `Backup:`) | `bin/webmcp-vault.mjs`, `webmcp-vault-cli.test.mjs` | Song song với A1; phần phụ thuộc A1 merge sau A1 |
| A3 | C7, C8 | `lib/vault/leases.js`, `lib/vault/envfile.js` và test tương ứng | Song song |
| A4 | C9 | `lib/vault/fs-safe.js`, `vault-lock-race.test.mjs` | Song song |
| A5 | C10 | docs | Sau khi A1–A4 merge |
| — | Phase 1R | lockfile `webmcp-automation-kit` | Orchestrator, sau khi người dùng đồng ý |
| B | U1–U8, U-R | `lib/ui-server.js`, `lib/ui/**` | Một agent, sau Phase 1R |

Ước lượng: Phase 1 khoảng 2–2,5 tiếng (A1 là đường găng), Phase 1R khoảng
15 phút, Phase 2 khoảng 1,5–2 tiếng.

Việc không giao cho subagent: chốt D1–D4 (người dùng); dời pin lockfile và
push (orchestrator, sau khi người dùng đồng ý).

## Ghi nhận, chưa làm

- `.env` có quote không đóng (`KEY="abc`) được giữ nguyên dạng literal thay vì
  báo lỗi. Đây là lỗi parser, không phải rò rỉ; chỉ sửa khi có người dùng bị
  ảnh hưởng.
- Field env mới mặc định `secret: true`. Giữ nguyên vì đây là mặc định an toàn.
- 14 test `RED:` (grant/receipt/export): cần initiative riêng.

## Nhật ký thay đổi

| Ngày | Ai | Thay đổi | Lý do |
| --- | --- | --- | --- |
| 2026-09-26 | Claude (orchestrator) | Tạo plan | Từ verification.md |
| 2026-09-26 | Claude (orchestrator) | Sắp lại: lõi + CLI (C1–C10) → mốc phát hành 1R → UI (U1–U8). Race lock, `.env`, trùng tên field và docs CLI chuyển lên Phase 1; lỗi `OTP` ở `ui-server.js` chuyển xuống U1 | Người dùng muốn dùng CLI sớm cho việc khác |
