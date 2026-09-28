---
title: Vault Data Integrity — Verification Record
type: verification
created: 2026-09-26
baseline: a9194e5
---

# Verification record, 2026-09-26

## Phương pháp

Có ba subagent Sonnet chạy độc lập, không agent nào sửa file dự án:

| Agent | Phạm vi | Công cụ |
| --- | --- | --- |
| UI | Tái hiện lỗi UI trên server `ui --port 7891` | skill `webmcp`, `mcp__webmcp__*` (newTab, getAriaSnapshot, clickByRef, typeByRef, evaluateJS, pressKey); đọc lại dữ liệu qua CLI |
| CLI/store | Tái hiện CLI, envelope, lease, lock, envfile; chạy `npm test` | CLI `webmcp-vault`, script node trong scratch |
| Static | Tìm lỗi anh em, tìm choke point, lập bản đồ khoảng trống test, đối chiếu tài liệu với code | Chỉ đọc code |

An toàn: mọi lệnh chạy với `WEBMCP_HOME` scratch (đã xác nhận qua `doctor`
trước lần ghi đầu tiên), dùng key tổng hợp và dữ liệu `AUDIT-*`. Vault thật
`~/.webmcp/vault/credentials.enc.json` có sha256
`5f66ca257677456ebc185d38e6c822a9d0ac5fc0c77fc5f14f3fffa0ba6619ca` (4839 bytes,
mtime 2026-09-25 21:41), không đổi trước và sau audit. Scratch đã được xoá.

Orchestrator đã tự đọc lại source tại mọi file:line bên dưới.

## Đối chiếu

Cột A là báo cáo Codex + CUA, cột B là báo cáo Claude + webmcp browser.

| Lỗi | A | B | Kết quả xác minh | Mức |
| --- | --- | --- | --- | --- |
| Sửa item typed làm mất secret | P1, quy cho preload chung | Chỉ khi field tên `OTP`/`TOTP`; `ui-server.js:227` | **B đúng.** Field thường giữ nguyên, field `OTP` bị ghi `""`. Nguyên nhân gốc sâu hơn: `model.js:139-146` nhận nguyên `fields[]` và không validate lại | P1 |
| CLI `read <id> otp` cùng lỗi? | — | — | **Không.** CLI luôn đi qua `store.readField`; lỗi chỉ có ở UI server | — |
| Cmd+S trong lúc preload | — | P1 | **Xác nhận.** Chậm 1.5s → xoá `token`, `key_id`; UI báo "Saved". `keyboard.js:28-34` | P1 |
| Enter trong lúc preload | — | — | **An toàn.** Nút submit duy nhất đang disabled nên form không tự submit | — |
| `init --force=false` | P1 | P1, im lặng | **Xác nhận**, và không có backup: `store.js:82-90`. Lỗi mang tính hệ thống: `get --reveal=false` vẫn reveal, `list --json=false` vẫn in JSON, `delete --confirm=false` vẫn xoá; `restore --force=false`, `backup --force=false`, `rotate-key --force-backup=false` cùng dạng | P1 |
| Giới hạn 64 MiB | P1 | P1, `doctor` báo sai | **Xác nhận**: 6 item × 256 field × 32 KiB → 67,218,747 byte, mọi `list`/`get`/`backup` báo "too large". **`doctor` không báo sai**: nó trả `unlocked:false` kèm `unlockError` (phần này của B sai). Thêm: `restore` cũng từ chối (`backup.js:101-104`), nên không có đường khôi phục trong sản phẩm | P1 |
| Lease đổi `itemId` | P2 | P1 | **Xác nhận ở tầng library.** CLI `lease read` và `broker.fillLoginFormWithLease` không truyền `itemId`; ngoài package không có caller `useLease` nào | P2 (sửa 1 dòng, làm luôn) |
| Stale lock TOCTOU | P2 | P3, "race hẹp" | **A đúng hơn.** 8 process, 20 vòng: 13/20 có 2–3 writer `ok:true`, chỉ 1 item được lưu. Điều kiện: phải có sẵn một lock mồ côi (process chết giữa chừng). Cách vá "stat lại trước unlink" mà agent đề xuất vẫn còn race | P2 |
| Đổi type login ↔ typed | P2, map thiếu | P1, select không bị disable | **Xác nhận mất dữ liệu cả hai chiều**, không có confirm. Nhưng hướng sửa của B (disable select) đi ngược commit 11746f3, commit cố ý cho phép đổi type. Lỗi nằm ở server: `store.js:163-172` xoá field của type cũ; `controller.js:212-226` chỉ map password/note/web | P1 |
| Reveal all ghi đè | P2 | Chỉ edit non-secret | **B đúng.** Title chưa lưu bị revert, thoát edit mode, không cảnh báo. `main.js:59-63` | P2 |
| SSH PEM nhiều dòng | P2 | Hỏng âm thầm | **Xác nhận**: đọc lại qua CLI thấy 0 newline. `controller.js:140` | P2 |
| `.env` in secret khi lỗi | P2 | Chỉ dòng không có `=` | **B đúng.** `KEY=VALUE` không bao giờ bị in; `=SECRET` và `KEY secret` in nguyên dòng (`envfile.js:71,76`). Chỉ lộ qua CLI `env-import`; UI server không dùng envfile | P3 |
| detailTitle, aria-label, env mặc định secret | — | Có | **Xác nhận cả ba** | P3 |
| `.field-row` mobile | — | "bị bóp" | **Tệ hơn mô tả**: ở 390px ô value chỉ còn 16px, không có thanh cuộn để cảnh báo | P2 |
| Mobile chrome | "cuộn nhiều" | ≈680px | **Đo thực tế**: 104 + 226 + 178 = 509px (60% chiều cao 844) trước form | P2 |

## Phát hiện mới

- `model.js:141-146`: update không validate lại required fields. Có thể PUT
  item api_token mà không có field `token`.
- Mọi cờ boolean của CLI dùng truthiness (8 call site). Cách xử lý an toàn đã
  có sẵn trong cùng file (`=== true` ở `:503`, `!== true` ở `:272`).
- `--gateway-token=false` gửi chuỗi `"false"` làm bearer token.
- Không có trần cho tổng số item. `importItems` (CSV, env) đi qua cùng vòng
  lặp không giới hạn, là một đường khác dẫn tới vượt 64 MiB.
- Tên field: dedup phân biệt hoa/thường (`model.js:56,69`) nhưng lookup không
  phân biệt (`:346-349`), nên `Token` và `token` cùng tồn tại được và bị đọc
  nhập nhằng.
- Bảng tên field dành riêng (`otp`, `totp`, `user`…) bị lặp ở ba nơi
  (`ui-server.js`, `model.js`, `leases.js`). Chỉ bản trong `ui-server.js`
  thiếu guard theo type.
- `.env` với quote không đóng được giữ nguyên dạng literal, không báo lỗi.
- `ARCHITECTURE.md:207-208` vẫn ghi "type is immutable", trái với code và với
  test `vault-typed.test.mjs:231`.

## Test

`node --test tests/unit/*.test.mjs`: 83 test, 69 pass, 14 fail. Cả 14 là test
`RED:` cố ý cho capability chưa triển khai, không phải regression:
`vault-broker-fill-no-value` (4), `vault-grant-scope` (6), `vault-receipt` (4).

Vì sao test không bắt được các lỗi trên:

- Không test nào chạm `lib/ui/app/*.js`, nên toàn bộ lỗi keyboard/controller
  không có coverage.
- `vault-typed.test.mjs:110-115, 231-249` chỉ có happy path: đổi type luôn gửi
  lại đủ field, không test field bị bỏ sót.
- `webmcp-vault-cli.test.mjs:376` chỉ test `--force` không có giá trị.
- `vault-leases.test.mjs` luôn truyền `itemId` trùng với item của lease.
- Chỉ phía read có test giới hạn envelope; phía write không có.
