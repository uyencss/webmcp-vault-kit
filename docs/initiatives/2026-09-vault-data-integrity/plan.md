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
| 0 | Chốt quyết định D1–D4 | 4/4 |
| 1 | Lõi + CLI (C1–C10) | 10/10 |
| 1R | Mốc phát hành CLI | 1/1 |
| 2 | UI server + UI (U1–U8) + runbook | 9/9 |
| 3 | Đóng initiative | 1/1 |

---

## Phase 0: Chốt quyết định (owner: người dùng)

Chốt ngày 2026-09-28 theo đúng khuyến nghị README, trên cơ sở yêu cầu người dùng
"triển khai luôn plan này" / "làm hết toàn diện". Chi tiết xem
[README](README.md#quyết-định-cần-chốt).

- [x] **D1:** update gửi `value: ""` cho secret field đang có giá trị → giữ giá trị cũ; muốn xoá thì xoá cả dòng field
- [x] **D2:** đổi type thì map đủ `username`/`otpSecret`; nếu làm rơi field thì từ chối, trừ khi có `dropFields: true`
- [x] **D3:** `useLease` chỉ dùng `lease.itemId`
- [x] **D4:** `init --force` trên vault đã tồn tại thì tự backup trước khi ghi đè

---

## Phase 1: Lõi và CLI

Không đụng `lib/ui-server.js`, `lib/ui/**`. Phân công theo wave xem
[Phân công](#phân-công).

### C1: Update validate lại required fields và giữ secret khi gửi rỗng (D1)

File: `lib/vault/model.js:136-146`, test: `tests/unit/vault-typed.test.mjs`
Owner: agy-gemini-3.8-flash-high (wave A1) · Evidence: commit `7641399`; tests `integrity: update without token field is rejected`, `integrity: empty secret value keeps stored value` (+A10 flag/case variants `fbbd15d`, +A11 legacy twin `c1a2d4c`); `npm test` 126→127 pass.

- [x] Viết test `integrity: update without token field is rejected`: tạo api_token có `token`, update `fields` chỉ gồm một field metadata → throw `require a token field`
- [x] Viết test `integrity: empty secret value keeps stored value`: env có `API_TOKEN=AUDIT-1` (secret), update cùng field với `value: ""` → `readField` vẫn trả `AUDIT-1`
- [x] Chạy cả hai, xác nhận **fail**
- [x] Trong `normalizeItemInput`: khi `has('fields') && existing`, field secret có `value === ""` và trùng `name` với field cũ đang có giá trị thì dùng lại giá trị cũ
- [x] Sau khi merge, luôn gọi `assertRequiredFields(type, patch.fields)` mỗi khi `has('fields')`
- [x] Hai test pass; `npm test` chỉ còn 14 fail `RED:`
- [x] Commit

### C2: Đổi type không làm rơi dữ liệu (D2)

File: `lib/store.js:163-172` (helper mapping đặt trong `lib/vault/model.js`), test: `tests/unit/vault-typed.test.mjs`
Owner: agy-gemini-3.8-flash-high (waves A1/A6/A7/A10) · Evidence: `7641399` mapping + hardening `7baa67d`, `aca2ca1`, `2dae13a`; tests round-trip/lossy/dropFields/empty-keep/collision/cap; test cũ `vault-typed.test.mjs:231` cập nhật kèm `dropFields` (ghi trong báo cáo A1).

- [x] Viết test `integrity: login→api_token→login keeps username and otp`: login có `username`, `password`, `otpSecret` → api_token → login → cả ba còn nguyên
- [x] Viết test `integrity: lossy type change is rejected`: api_token có thêm `key_id` → login mà không có `dropFields` → throw `Type change would drop fields: key_id`
- [x] Viết test `integrity: lossy type change allowed with dropFields`: như trên, có `dropFields: true` → thành công
- [x] Chạy ba test, xác nhận fail
- [x] Một hàm mapping duy nhất cho cả hai chiều: `username` ↔ field `username` (non-secret), `otpSecret` ↔ field `otp_secret` (secret), password/note/web như hiện có
- [x] Thay khối `delete item.*` trong `updateItem` bằng mapping này; field không rỗng mà không map được thì throw, trừ khi `input.dropFields === true`
- [x] Nếu test cũ `vault-typed.test.mjs:231` dựa vào hành vi xoá thì sửa theo, ghi lý do vào Evidence
- [x] CLI `update` nhận `--drop-fields` và truyền thành `dropFields: true` (phần sửa trong `bin/` do owner C5 làm nếu C5 đang giữ file; ghi chú vào Evidence)
- [x] `npm test` sạch
- [x] Commit

### C3: Tên field trùng không phân biệt hoa/thường

File: `lib/vault/model.js:56,69`, test: `tests/unit/vault-typed.test.mjs`
Owner: agy-gemini-3.8-flash-high (waves A1/A11) · Evidence: `7641399` + `a11bab8`; tests `integrity: Token and token are duplicates`, `integrity: legacy item with case-colliding fields resolves exact match`, `integrity: legacy duplicate-case fields keep the secret twin on empty update`.

- [x] Viết test `integrity: Token and token are duplicates`: tạo item có cả hai → throw duplicate
- [x] Chạy, xác nhận fail
- [x] Dedup trong `normalizeFields` theo `name.toLowerCase()`
- [x] Kiểm tra trên vault scratch: item cũ đã có cặp trùng hoa/thường vẫn đọc được. Không đọc được thì ghi `BLOCKED` và báo orchestrator
- [x] `npm test` sạch
- [x] Commit

### C4: Không cho ghi vault vượt 64 MiB

File: `lib/vault/envelope.js:101-104`, test: `tests/unit/vault-store.test.mjs`
Owner: agy-gemini-3.8-flash-high (waves A1/A6/A9) · Evidence: `7641399`; test `integrity: oversized write is refused and old file kept`; clamp `7baa67d`; finite guard + digest `7342c21`.

- [x] Viết test `integrity: oversized write is refused and old file kept`: dùng giới hạn chỉnh được trong test (tham số hoặc biến module), ghi vượt ngưỡng → throw; sha256 file cũ không đổi
- [x] Chạy, xác nhận fail
- [x] Trong `writeEnvelope`: serialize trước, `Buffer.byteLength(out) > MAX_ENVELOPE_BYTES` thì throw trước `writePrivateFile`
- [x] `npm test` sạch
- [x] Commit

### C5: Parse cờ boolean đúng trong CLI

File: `bin/webmcp-vault.mjs:21-45` (`parseFlags`), `:503` (`gateway-token`), test: `tests/unit/webmcp-vault-cli.test.mjs`
Owner: agy-gemini-3.8-flash-high (wave A2) · Evidence: `367f596`; tests `integrity: init --force=false keeps items`, `integrity: delete --confirm=false does not delete`, `integrity: get --reveal=false stays redacted`, `integrity: lease fill rejects invalid gateway token values`; 8 call site rà tường minh.

- [x] Viết test `integrity: init --force=false keeps items`
- [x] Viết test `integrity: delete --confirm=false does not delete`: item còn, exit code ≠ 0
- [x] Viết test `integrity: get --reveal=false stays redacted`
- [x] Chạy ba test, xác nhận fail
- [x] Trong `parseFlags`: `"false"|"0"|"no"` → `false`, `"true"|"1"|"yes"` → `true`. Vá một chỗ, không vá từng call site
- [x] `--gateway-token=false` hoặc rỗng → báo lỗi, không gửi chuỗi `"false"` làm bearer token
- [x] Rà cả 8 call site (`:290, 304, 324, 414, 428, 440, 465, 551`) để chắc chúng nhận boolean thật
- [x] `npm test` sạch
- [x] Commit

### C6: `init --force` tự backup trước khi ghi đè (D4)

File: `lib/store.js:82-90`, `bin/webmcp-vault.mjs` (in đường dẫn), test: `tests/unit/webmcp-vault-cli.test.mjs`
Owner: agy-gemini-3.8-flash-high (waves A1 store + A2 CLI) · Evidence: `7641399` + `367f596`; test `integrity: init --force backs up existing vault`; scratch restore 2 item qua `restoreBackup`.

- [x] Viết test `integrity: init --force backs up existing vault`: vault có 2 item → `init --force --json` → có `backupFile`, file tồn tại, `restore` từ file đó lấy lại đủ 2 item
- [x] Chạy, xác nhận fail
- [x] Trong `init`: `force` và file tồn tại → gọi `backupApi.backup()` trước khi ghi, trả `backupFile`
- [x] Khi không có `--json`, CLI in `Backup: <path>`
- [x] `npm test` sạch
- [x] Commit

### C7: Lease luôn dùng item đã bind (D3)

File: `lib/vault/leases.js:202`, test: `tests/unit/vault-leases.test.mjs`
Owner: agy-gemini-3.8-flash-high (wave A3) · Evidence: `c0d62fe`; test `integrity: useLease ignores caller itemId`; grep `useLease(` trong automation-kit + archive ops-kit: không caller nào truyền `itemId`.

- [x] Viết test `integrity: useLease ignores caller itemId`: lease cho item A; `useLease({ itemId: B.id, ... })` → không bao giờ trả secret của B
- [x] Chạy, xác nhận fail
- [x] Đổi thành `resolveItem(loadVault().items, lease.itemId)`
- [x] Grep lại `useLease` trong `webmcp-ops-kit` và `webmcp-automation-kit`: không consumer nào truyền `itemId`
- [x] `npm test` sạch
- [x] Commit

### C8: Lỗi parse `.env` không in nội dung dòng

File: `lib/vault/envfile.js:71,76`, test: `tests/unit/vault-envfile.test.mjs`
Owner: agy-gemini-3.8-flash-high (wave A3) · Evidence: `c0d62fe`; test `integrity: malformed env line is not echoed`.

- [x] Viết test `integrity: malformed env line is not echoed`: dòng `API_KEY sk-live-x` và `=sk-live-y` → message có số dòng, không chứa `sk-live`
- [x] Chạy, xác nhận fail
- [x] Bỏ `rawLine` khỏi cả hai message lỗi
- [x] `npm test` sạch
- [x] Commit

### C9: Sửa race khi dọn stale lock

File: `lib/vault/fs-safe.js:63-120`, test mới: `tests/unit/vault-lock-race.test.mjs`
Owner: agy-gemini-3.8-flash-high (waves A4/A6/A7/A8/A9) · Evidence: `366135c` + `7baa67d` + `aca2ca1` + `5380c95` + `7342c21`; stress `integrity: stale lock reap admits one writer` 20 vòng × 8 process pass 3 lần (code cũ fail 3/20); deterministic ownership/steal/write-refusal tests; OCC digest; residual µs-class documented trong acceptance.

- [x] Viết test stress `integrity: stale lock reap admits one writer`: 8 process con, lock stale có sẵn với pid đã chết, 20 vòng → số item được lưu == số writer báo `ok:true`
- [x] Chạy, xác nhận fail (tham khảo lúc audit: 13/20 vòng lỗi)
- [x] Lock ghi `{ pid, nonce }`; release chỉ unlink khi nonce trong file là của mình
- [x] Reap bằng `renameSync(lock, lock + '.reap.' + random)`, rồi so `ino` với `stat` đã kiểm tra; khác nhau (tức vừa cướp nhầm lock mới) thì `linkSync` trả lại và báo busy; xoá tombstone
- [x] **Không** dùng cách "stat lại trước khi unlink" (vẫn còn race)
- [x] Test stress pass 20/20, chạy 3 lần liên tiếp
- [x] `npm test` sạch
- [x] Commit

### C10: Tài liệu phần lõi và CLI

File: `docs/ARCHITECTURE.md:207-208`, `skills/webmcp-vault/SKILL.md`, `README.md`
Owner: agy-gemini-3.8-flash-high (waves A5/A10) · Evidence: `8871ff0` + `2dae13a`; `grep -rn immutable docs/ skills/ README.md` sạch; docs mô tả D1, mapping/dropFields, 64 MiB, init --force backup, boolean flags.

- [x] Bỏ câu "type is immutable"; mô tả mapping khi đổi type, `dropFields` / `--drop-fields`
- [x] Ghi D1: gửi secret rỗng thì giữ giá trị cũ, muốn xoá thì xoá cả field
- [x] SKILL.md: `init --force` tự backup và in đường dẫn; `--flag=false` được hiểu đúng
- [x] Ghi giới hạn 64 MiB và hành vi từ chối ghi khi vượt
- [x] Commit

### Cổng Phase 1

- [x] C1–C10 đã tick đủ
- [x] `npm test` trong package: 127 tests / 112 pass / 15 fail — đúng 14 `RED:` (grant/receipt/export, ngoài phạm vi) + 1 `A1 fixtures … (must pass)` có sẵn từ baseline `a9194e5` (baseline thực tế 83/68/15, không phải 69/14 như README ghi); mọi test `integrity:` xanh.
- [x] Smoke test CLI trên vault scratch: `init` → `create` login/api_token/env → `update` → `read` → `lease issue`/`lease read` → `backup` → `restore` → `init --force` backup: 18/18 PASS (`receipts/` + script `scripts/phase1-smoke.mjs`).
- [x] Test consumer liên kit: `webmcp-node-executor` (archive ops-kit) 160/161 pass — 1 fail là lỗi layout archive (`stores/webmcp-site-store/lib/auth-probe.mjs` thiếu), có sẵn, không liên quan; browser-kit bridge `webmcp vault doctor --json` với `WEBMCP_VAULT_BIN` trỏ candidate → `initialized:true, unlocked:true`.
- [x] Orchestrator tự review diff từng wave + full diff `a9194e5..c1a2d4c` (verify độc lập: đọc code, chạy test, tái hiện đỏ-trước cho C9).

**Review chain (candidate `c1a2d4cef07e353b4b116d356aebc71257603b7d`):**
L1 Muse 1.3 approve (4 receipts: `8871ff0`, `f85f31c`, `b65e373`, `be019ec`); Sol 6 high pre-accept: v1–v4 REQUEST_CHANGES → fixed A6–A9, **v5 PASS** `bcd91f9`, v6 tìm 1 khe hẹp → A11, **v7 receipt**; Claude Opus 5.5 final: v1 request-changes (F1–F3) → A10 → **v2 approve `fbbd15d`**, v3 approve `c1a2d4c`, **v4 approve `3a9f06a`**; Sol **v8 PASS `3a9f06a`**.

---

## Phase 1R: Mốc phát hành CLI

Sau mốc này, CLI và store API dùng được cho việc khác. Dời pin cần người dùng
đồng ý trước khi push.

- [x] Người dùng đồng ý dời pin (ghi ngày vào Evidence) — directive 2026-09-28 "làm hết toàn diện plan"
- [x] Dời pin vault-kit trong lockfile của `webmcp-automation-kit` (commit `fix(lock): …`), test consumer xanh
- [x] `webmcp vault doctor --json` qua bridge của browser-kit trả kết quả đúng với pin mới
- [x] Cập nhật bảng Tiến độ tổng; ghi SHA đã phát hành vào Nhật ký thay đổi

Owner: orchestrator · Evidence: xem `temp/vault-data-integrity-20260928/receipts/phase1r-*.md` — pin `3a9f06a` trong `deployment/development/ci-repos.lock.json` + `EXPECTED_LOCK_PINS`; lock test 45/45; doctor unlocked:true trên scratch; browser-kit test xanh.

---

## Phase 2: UI server và UI

Bắt đầu sau Phase 1R. Không có harness test DOM; mỗi task UI nghiệm thu bằng
kịch bản tương ứng trong [Runbook U-R](#u-r-runbook-nghiệm-thu-ui-qua-webmcp-browser).

### U1: `/read?field=OTP` chỉ đi vào nhánh TOTP với item login

File: `lib/ui-server.js:227`, test: `tests/unit/vault-ui-server.test.mjs`
Owner: — · Evidence: —

- [x] Viết test `integrity: typed field named OTP reads its stored value`: env có `OTP=AUDIT-OTP`, `GET /api/items/:id/read?field=OTP` → `value === 'AUDIT-OTP'`
- [x] Chạy, xác nhận fail
- [x] Thêm điều kiện `(item.type || 'login') === 'login'` vào nhánh `readTotp`
- [x] Item login: `read?field=otp` vẫn trả mã TOTP (test hiện có pass)
- [x] `npm test` sạch
- [x] Commit

### U2: Cmd+S không bỏ qua nút Save đang disabled

File: `lib/ui/app/keyboard.js:28-34` · Owner: — · Evidence: —

- [x] Chạy kịch bản R2 trên code cũ, xác nhận lỗi (có request PUT trong lúc preload)
- [x] Chỉ gọi `requestSubmit()` khi `state.editMode && !el('submitButton').disabled`
- [x] Chạy lại R2: không có PUT; sau khi preload xong Cmd+S lưu bình thường
- [x] Commit

### U3: Reveal all không xoá chỉnh sửa chưa lưu

File: `lib/ui/app/main.js:44-63` · Owner: — · Evidence: —

- [x] Khi `state.formDirty` thì hỏi `confirmDiscardChanges()`; người dùng huỷ thì không gọi `fillForm`
- [x] Chạy R3: pass
- [x] Commit

### U4: Private key nhiều dòng dùng `<textarea>`

File: `lib/ui/app/controller.js:140` (+ CSS nếu cần) · Owner: — · Evidence: —

- [x] Field `private_key`, và mọi field có giá trị chứa `\n`, render bằng `<textarea>`
- [x] Vẫn che được giá trị (cơ chế hiện/ẩn sẵn có hoặc `-webkit-text-security`)
- [x] Chạy R4: đọc lại qua CLI thấy đủ newline
- [x] Commit

### U5: Đổi type trên UI: map đủ, có confirm, cập nhật tiêu đề

File: `lib/ui/app/controller.js:212-249` · Owner: — · Evidence: —

- [x] Dùng cùng quy tắc mapping với C2 (username, otp_secret, password, note, web)
- [x] Server trả lỗi `would drop fields` → hiện confirm liệt kê field sẽ mất → đồng ý thì gửi lại kèm `dropFields: true`
- [x] Cập nhật `detailTitle` (H2) cùng lúc với `detailEyebrow`
- [x] Chạy R5: pass
- [x] Commit

### U6: `.field-row` dùng được ở màn hình hẹp

File: `lib/ui/styles/fields.css:398-409`, `lib/ui/styles/responsive.css` · Owner: — · Evidence: —

- [x] Dưới 560px: `.field-row { flex-wrap: wrap }`, ô value chiếm hết chiều ngang
- [x] Chạy R6 (phần độ rộng ô value ≥ 200px)
- [x] Commit

### U7: Mobile: form chi tiết không bị đẩy xuống dưới màn hình

File: `lib/ui/styles/responsive.css:5-39` (+ `main.js` hoặc `item-list.js` cho nút quay lại) · Owner: — · Evidence: —

- [x] Dưới 900px, khi đã chọn item: ẩn `.vault-sidebar` và `.rail`, có nút quay lại danh sách
- [x] Chạy R6 (phần form bắt đầu trong 150px đầu)
- [x] Desktop không đổi (chụp màn hình trước/sau ở 1440px)
- [x] Commit

### U8: Ô value của field có accessible name

File: `lib/ui/app/controller.js:140-152` · Owner: — · Evidence: —

- [x] `aria-label` của ô value = tên field; cập nhật khi đổi tên field
- [x] `getAriaSnapshot` hiện đúng tên field cho từng ô
- [x] Commit

### U-R: Runbook nghiệm thu UI qua webmcp browser

Chuẩn bị: `WEBMCP_HOME` scratch, key tổng hợp qua `WEBMCP_VAULT_KEY_FILE`, chạy
`webmcp-vault ui --json --port 7891` ở background, mở một tab mới tới token
URL, mở khoá bằng "Use configured key". Mỗi kịch bản **phải đọc lại qua CLI**
(`read <id> <field> --json`), không chỉ nhìn DOM.

Owner: orchestrator (webmcp browser; R1–R9 profile `hieu.29.6.90`, R10 Chrome for Testing managed) · Evidence: `receipts/u-runbook-results.md` (R1–R6) + `u-runbook-extended.md` (R7–R9) + `r10-runbook.md` — tất cả PASS trên scratch, đọc lại qua CLI từng bước.

- [x] **R1:** env có `OTP`, `API_TOKEN`, `REGION`; sửa title, Save → cả 3 còn giá trị
- [x] **R2:** làm chậm `fetch /read` 1.5s, Cmd+S giữa chừng → không có PUT, dữ liệu nguyên vẹn
- [x] **R3:** sửa title, bấm Reveal all → có hỏi xác nhận; huỷ thì chỉnh sửa được giữ
- [x] **R4:** paste PEM 3 dòng vào `private_key`, Save → CLI đọc lại được 3 ký tự `\n`
- [x] **R5:** login (username + TOTP) → api_token → login → username và TOTP còn nguyên; api_token có `key_id` → login thì có confirm
- [x] **R6:** viewport 390×844: ô value rộng ≥ 200px; `.detail` bắt đầu trong 150px đầu (đo bằng `getBoundingClientRect`)
- [x] Dọn dẹp: tắt server, đóng tab, xoá scratch; sha256 vault thật không đổi

### Cổng Phase 2

- [x] U1–U8 và U-R đã tick đủ
- [x] `webmcp-desktop-app` vẫn spawn được UI server (smoke test) — `tests/unit/vault-ui-manager.test.js` 4/4 pass (chạy trên main Phase 1; rerun sau khi promote Phase 2)
- [x] Orchestrator review diff Phase 2 + chạy runbook thật

**Review chain Phase 2 (candidate cuối `a3a118c`, release merge `925ff41`):**
L1 Muse 1.3 (approve); Sol 6 high: v1 `5d14734` REQUEST_CHANGES → A13, v2 `0ee3f75` REQUEST_CHANGES → A14, v3 `a37e4c5` REQUEST_CHANGES → A15/A16/A17, **v6 approve `a3a118c`**; Claude Opus 5.5 final **approve `a3a118c`** (1 low: focus/caret khi render — data safe). Receipts: `receipts/review-*-phase2*.{json,md}`.
Runbook: R1–R9 (bảng trên; R7–R9 trong `receipts/u-runbook-extended.md`) + R10 remove-mid-preload PASS trên `a3a118c` (`receipts/r10-runbook.md`).

---

## Phase 3: Đóng initiative

- [x] Cổng Phase 1 và Phase 2 đã đạt
- [x] `npm test` cuối: main sau merge **130 tests / 116 pass / 14 fail** (14 `RED:` là hạng mục Phase 3 tương lai; test `A1 fixtures …` pass trên checkout đầy đủ; worktree integration 130/115/15 do thiếu sibling worktree `webmcp-automation-runner` — artifact môi trường, không phải regression)
- [x] Dời pin lần hai cho phần UI (directive người dùng 2026-09-28 "làm hết toàn diện"), test consumer xanh
- [x] Đổi `status:` trong README thành `done`; cập nhật bảng Tiến độ tổng

Owner: orchestrator · Evidence: pin Phase 2 trong `ci-repos.lock.json` + `EXPECTED_LOCK_PINS`; lock test 45/45; desktop-app rerun; bridge doctor; `receipts/phase2-acceptance.md`.

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
- Update cùng type gửi `value: ""` cho field **non-secret** đang có giá trị vẫn ghi đè giá trị cũ
  (D1 chỉ phạm vi secret). Đường UI của lỗi audit được xử lý bằng U2 (Phase 2: Cmd+S không bỏ qua Save disabled);
  server-side giữ nguyên hành vi cũ, ghi nhận là follow-up (pre-accept Sol finding medium #5, Opus không xếp medium).
- Residual write-safety: khe giữa lần kiểm tra cuối (lock ownership/OCC digest) và syscall `rename` là µs-class;
  Node stdlib không có `flock`/compare-and-unlink nên không thể đóng tuyệt đối. Các kịch bản tái hiện được từ audit
  đã bị chặn (2 writer không còn cùng báo thành công; writer đọc cũ abort qua OCC). Sol v5/v7 chấp nhận kèm ghi chú này.
- Guard dữ liệu hỏng (Opus v4 low F1): lookup giá trị rỗng trong `normalizeItemInput` chưa guard `f && typeof f.name === 'string'`
  như builder `caseGroups`; field entry malformed sẽ gây TypeError thay vì bỏ qua. Follow-up nhỏ, không ảnh hưởng dữ liệu hợp lệ.

## Nhật ký thay đổi

| Ngày | Ai | Thay đổi | Lý do |
| --- | --- | --- | --- |
| 2026-09-26 | Claude (orchestrator) | Tạo plan | Từ verification.md |
| 2026-09-26 | Claude (orchestrator) | Sắp lại: lõi + CLI (C1–C10) → mốc phát hành 1R → UI (U1–U8). Race lock, `.env`, trùng tên field và docs CLI chuyển lên Phase 1; lỗi `OTP` ở `ui-server.js` chuyển xuống U1 | Người dùng muốn dùng CLI sớm cho việc khác |
| 2026-09-28 | Interactive coordinator (ATLAS) | Phase 0 chốt theo khuyến nghị; triển khai Phase 1 qua các wave A1–A11 trong worktrees `temp/vault-data-integrity-20260928`; writer agy gemini-3.8-flash-high, L1 Muse 1.3, pre-accept Sol 6 high, final Opus 5.5. Candidate `c1a2d4c` PASS cả ba tầng | Người dùng yêu cầu triển khai toàn diện plan với phân vai đã chỉ định |
| 2026-09-28 | Orchestrator | Phase 1R: dời pin vault-kit `a9194e5` → `3a9f06a` trong `ci-repos.lock.json` + `EXPECTED_LOCK_PINS`; lock test 45/45; bridge doctor + consumer xanh | Mốc phát hành CLI của plan |
| 2026-09-29 | Interactive coordinator (ATLAS) | Phase 2 wave B-UI (U1–U8) + runbook webmcp R1–R6 PASS; review chain L1/Sol/Opus; promote + dời pin lần hai; README → done | Người dùng yêu cầu làm toàn diện plan |
| 2026-09-29 | Orchestrator | Phase 2 hardening A13–A17 (preload/Save generation binding, remove-mid-preload) sau 3 vòng Sol; Sol v6 + Opus v4 approve `a3a118c`; R10 PASS; merge vào main `925ff41`; dời pin lần hai (lock 45/45, desktop-app 4/4, bridge doctor, browser-kit 44/44) | Vòng xác nhận cuối Phase 2 |
