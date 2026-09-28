---
title: Vault Data Integrity Hardening
type: initiative
status: done
created: 2026-09-26
updated: 2026-09-29
package: "@gyga-browser/webmcp-vault-kit"
baseline: a9194e5
owner: vault-kit lane
---

# Vault Data Integrity Hardening

## Vì sao có initiative này

Hai vòng review độc lập (Codex + CUA, rồi Claude + webmcp browser) trên
`a9194e5` báo ~15 lỗi và **mâu thuẫn nhau** về nguyên nhân lẫn mức độ. Ngày
2026-09-26 ba subagent Sonnet đã tái hiện lại từng claim trên vault scratch với
dữ liệu tổng hợp (`WEBMCP_HOME` riêng, vault thật giữ nguyên sha256
`5f66ca25…19ca`). Kết quả chi tiết: [verification.md](verification.md).

Kết luận: package có **nhiều đường làm mất dữ liệu âm thầm, và đường nào cũng
báo thành công** ("Saved", "Vault initialized", `ok:true`). Hầu hết các lỗi
không nằm ở UI mà ở chỗ **server/store tin tưởng hoàn toàn input**:

| Choke point | Hiện trạng | Hệ quả |
| --- | --- | --- |
| `lib/vault/model.js:136-146` `normalizeItemInput` | Nhận nguyên mảng `fields[]` từ client; chỉ validate required fields khi tạo mới hoặc đổi type | Mọi client (UI race, UI OTP bug, CLI) có thể xoá secret của item typed mà không bị chặn |
| `lib/store.js:163-172` `updateItem` | Đổi type thì `delete` các field của type cũ | Mất `username`/`otpSecret`/field tuỳ ý, không cảnh báo |
| `lib/vault/envelope.js:101` `writeEnvelope` | Không kiểm size; `readEnvelope` từ chối >64 MiB | Ghi hợp lệ tạo ra vault không đọc/backup/restore được |
| `bin/webmcp-vault.mjs:21` `parseFlags` | `--x=false` là chuỗi `"false"`, 8 call site dùng truthiness | `init --force=false` xoá vault, `delete --confirm=false` vẫn xoá |
| `lib/vault/fs-safe.js:63` `removeStaleLock` | stat → check → unlink không nguyên tử; release unlink lock bất kể của ai | 13/20 lần thử: 2–3 writer cùng `ok:true`, chỉ 1 bản ghi còn |

Vá tại choke point thì mọi caller (UI, CLI, import, broker) được bảo vệ cùng
lúc. Các lỗi UI chỉ còn là lỗi UX, không còn làm mất dữ liệu.

## Mục tiêu

1. Không còn đường nào làm mất secret đã lưu mà vẫn báo thành công.
2. Mỗi lỗi đã xác nhận có **một test đỏ trước khi vá** ở tầng nó thực sự xảy ra.
3. Tài liệu (`ARCHITECTURE.md`, `SKILL.md`) khớp với hành vi code.

## Ngoài phạm vi

- 14 test `RED:` (credential grant/receipt/export). Đây là capability chưa
  triển khai, không phải regression, và cần initiative riêng.
- Viết lại `preloadTypedFields` thành cơ chế patch từng field. Quyết định D1
  bên dưới đã làm việc preload không còn nguy hiểm.
- Thêm jsdom hay harness test DOM. Guard phía server đã bảo vệ dữ liệu; lỗi UI
  được nghiệm thu bằng runbook trình duyệt (xem plan, Phase 2).

## Quyết định cần chốt

| # | Câu hỏi | Khuyến nghị |
| --- | --- | --- |
| D1 | Update gửi `value: ""` cho một secret field đang có giá trị thì sao? | **Giữ giá trị cũ.** Muốn xoá secret thì xoá cả dòng field. Đây là cách password manager xử lý secret "không đổi", đồng thời vô hiệu hoá cả bug OTP lẫn race Cmd+S ngay ở server. |
| D2 | Đổi type làm rơi dữ liệu thì sao? | **Map đủ** (`username` ↔ field `username`, `otpSecret` ↔ field `otp_secret` secret). Field không map được thì **từ chối** trừ khi request có `dropFields: true`; UI hiện confirm liệt kê các field sẽ mất. Giữ quyết định của 11746f3 (type được phép đổi), không quay lại "immutable". |
| D3 | `lease.use` có nhận `itemId` từ caller không? | **Không.** Luôn dùng `lease.itemId`. Không consumer nào ngoài package gọi `useLease` (đã grep `webmcp-ops-kit`, `webmcp-automation-kit`). |
| D4 | `init --force` trên vault đã có item? | Luôn tạo backup trước khi ghi đè và in đường dẫn backup. Không thêm `--yes`: backup là đủ để khôi phục. |

## Tài liệu

- [plan.md](plan.md): checklist chi tiết từng task (agent tick khi xong), cổng nghiệm thu từng phase, phân công
- [verification.md](verification.md): bảng đối chiếu claim → verdict → bằng chứng

## Tiêu chí hoàn thành

- Mọi task P1 và P2 trong plan đều đã merge, kèm test đỏ-rồi-xanh.
- `npm test`: 69 test xanh hiện có giữ xanh, test mới xanh, 14 RED không đổi.
- Runbook UI (Phase 2) chạy qua webmcp browser trên vault scratch: không kịch
  bản nào làm mất dữ liệu.
- Test của các consumer liên kit vẫn xanh: `webmcp-node-executor` (lease),
  `webmcp-browser-kit/bin/webmcp.mjs` (vault doctor), `webmcp-desktop-app`
  (spawn UI server).
