# Kế Hoạch Triển Khai Tính Năng Sort, Filter by Tag & Include Subvaults Cho WebMCP Vault (Lăng Kính `/ponytail`)

- **Ngày lập**: 2026-10-20
- **Hội đồng kiến trúc**: Gemini 4 Argon (Coordinator & Codebase Trace) × Claude Opus 5.5 (Final Plan Reviewer — Verdict: `APPROVED_WITH_REFINEMENTS`)
- **Triết lý thiết kế**: `/ponytail` (YAGNI, tái sử dụng dữ liệu `state.items`, `state.vaults` và `isDescendant` sẵn có, dùng `<details>`/`<summary>` native làm popover, không sửa backend/schema/CLI, trần $\le 1.000$ LOC cho mọi file)
- **Trạng thái**: **APPROVED (Đã tích hợp R1–R10 từ Opus 5.5 + Bổ sung Filter by Tag trong Popover theo lựa chọn của User)**

---

## 1. Mục Tiêu & Tham Chiếu Giao Diện (1Password Style)

Dựa trên 2 ảnh chụp thực tế của người dùng và yêu cầu bổ sung:
1. **Thanh công cụ cột giữa (`.rail-top`)**:
   - Đặt ô `<input id="search">` và nút Sort (`38×38px`, icon vuông bo góc `var(--r-md)` có biểu tượng mũi tên xuống + 3 vạch ngang giống 1Password) nằm chung trên **1 hàng ngang (`display: flex; gap: 8px`)**.
2. **Popover Menu Sort & Filter (Tham chiếu 1Password — Hình 2 + Tag Pills + Subvault Checkbox)**:
   - **Header**: `<N> ITEMS SORTED BY` (hoặc `1 ITEM SORTED BY`, in hoa, màu `var(--muted)`, tự động cập nhật theo danh sách đang hiển thị).
   - **Nhóm 1 — Tiêu chí sắp xếp (`sortBy`)**:
     - `Title`
     - `Date Created` (`createdAt`)
     - `Date Modified` (`updatedAt` — mặc định active giống 1Password)
     - *(Cắt bỏ theo `/ponytail` & được Opus 5.5 xác nhận: Không làm `Frequently Used` và `Recently Used` vì `readField`/`getItem` hiện chỉ đọc, không giữ write lock; nếu ghi `useCount`/`lastUsedAt` mỗi lần copy sẽ phải ghi lại toàn bộ `credentials.enc.json` gây lock contention)*.
   - Đường kẻ ngang phân cách (`<hr class="sort-divider">`).
   - **Nhóm 2 — Thứ tự sắp xếp (`sortOrder`)**:
     - Nhãn tự động đổi theo `sortBy` (**R3 từ Opus 5.5**):
       - Khi `sortBy` là `Date Created` hoặc `Date Modified`: hiển thị `Newest First` (`desc`) / `Oldest First` (`asc`).
       - Khi `sortBy` là `Title`: hiển thị `A to Z` (`asc`) / `Z to A` (`desc`).
     - Khi đổi sang `sortBy` mới, `sortOrder` tự động về mặc định tự nhiên (`title` $\rightarrow$ `asc`, ngày $\rightarrow$ `desc`). Bấm lại đúng tiêu chí đang chọn thì giữ nguyên.
     - Dấu tích xanh (`✓`) nằm bên phải dòng đang được chọn (`aria-pressed="true"`).
   - **Nhóm 3 — Lọc nhanh theo Tag (`TAGS`) ngay trong Popover (Theo lựa chọn Phương án 1 của User)**:
     - Nằm ngay trên dòng checkbox cuối, tự động thu thập danh sách các `#tag` đang có trong phạm vi vault hiện tại (`state.vaultItems`). Nếu không có tag nào thì tự ẩn khối này (`hidden`).
     - Hiển thị các pill `.item-tag-badge` (`#ai-ultra`, `#ai-pro`, `#2tb`, `#pixel`...).
     - Khi bấm vào một pill `#tag` trong popover:
       - Nếu ô `#search` đang là `#tag` đó $\rightarrow$ xóa trắng `#search` (bỏ lọc tag).
       - Nếu chưa lọc $\rightarrow$ điền `#tag` vào `#search` và lọc ngay lập tức; đồng thời tô nổi bật (`.is-active`) pill đang được chọn.
   - Đường kẻ ngang phân cách (`<hr class="sort-divider">`).
   - **Dòng cuối cố định — Checkbox `Include items in subvaults`**:
     - Đặt cố định ở đáy Popover:
       ```html
       <label class="sort-subvault-row">
         <input type="checkbox" id="includeSubvaultsCheckbox" />
         <span>Include items in subvaults</span>
       </label>
       ```
     - Mặc định `false` (`localStorage.getItem('webmcp-vault-include-subvaults') === '1'`) theo **R2 của Opus 5.5** để giữ nguyên hành vi mặc định và khớp với số đếm trực tiếp trên sidebar (`GMAIL` hiện `1`); khi bật sẽ gộp toàn bộ item của subvaults (`130` items) và lưu vào `localStorage`.

---

## 2. Thiết Kế Chi Tiết Từng File (Đã tích hợp R1–R10 của Opus 5.5)

### Bước 1: Pure Sort & Subvault Helper (`lib/ui/app/item-sort.js` & `lib/ui-server.js`)

Theo **R1 & R6 của Opus 5.5**:
- **Không sửa `lib/vault/model.js`, `lib/store.js`, hay CLI `bin/webmcp-vault.mjs`**. Toàn bộ việc gộp subvault được thực hiện ngay ở client bằng cách tận dụng `isDescendant(ancestorId, candidateId)` đã có sẵn trong `lib/ui/app/vaults.js:47`!
- Tạo module thuần `lib/ui/app/item-sort.js` (~35 dòng, không phụ thuộc DOM/`window` để Node test trực tiếp như `item-icon.js`):
  ```js
  const VALID_SORT_BY = new Set(['title', 'createdAt', 'updatedAt']);
  const VALID_SORT_ORDER = new Set(['asc', 'desc']);
  const titleCollator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

  export function normalizeSortBy(value) {
    return VALID_SORT_BY.has(value) ? value : 'updatedAt';
  }

  export function normalizeSortOrder(value, sortBy = 'updatedAt') {
    if (VALID_SORT_ORDER.has(value)) return value;
    return sortBy === 'title' ? 'asc' : 'desc';
  }

  export function defaultOrderForSortBy(sortBy) {
    return normalizeSortBy(sortBy) === 'title' ? 'asc' : 'desc';
  }

  export function sortItems(items, sortBy = 'updatedAt', sortOrder = 'desc') {
    if (!Array.isArray(items)) return [];
    const by = normalizeSortBy(sortBy);
    const order = normalizeSortOrder(sortOrder, by);
    const dir = order === 'asc' ? 1 : -1;
    return [...items].sort((a, b) => {
      if (by === 'title') {
        const cmp = titleCollator.compare(String(a?.title || ''), String(b?.title || ''));
        if (cmp !== 0) return cmp * dir;
      } else {
        const key = by === 'createdAt' ? 'createdAt' : 'updatedAt';
        const cmp = String(a?.[key] || '').localeCompare(String(b?.[key] || ''));
        if (cmp !== 0) return cmp * dir;
      }
      return titleCollator.compare(String(a?.title || ''), String(b?.title || ''));
    });
  }

  export function collectAvailableTags(items) {
    if (!Array.isArray(items)) return [];
    const counts = new Map();
    for (const item of items) {
      if (!Array.isArray(item?.tags)) continue;
      for (const tag of item.tags) {
        if (tag) counts.set(tag, (counts.get(tag) || 0) + 1);
      }
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || titleCollator.compare(a[0], b[0]))
      .map(([tag, count]) => ({ tag, count }));
  }
  ```
- Đăng ký `'app/item-sort.js'` vào mảng `ASSETS` trong `lib/ui-server.js`.

---

### Bước 2: Giao Diện HTML (`lib/ui/vault-ui.html`)

Tại `.rail-top` (dòng 322–331), đặt `<input id="search">` và `<details class="sort-menu" id="sortMenu">` nằm chung trên 1 hàng (**R7 của Opus 5.5**: dùng `<button aria-pressed="...">`, không dùng `role="menu"` hay inline style):
```html
<div class="rail-top">
  <input
    class="search"
    id="search"
    type="search"
    autocomplete="off"
    aria-label="Search saved logins"
    placeholder="Search title, user, site, or #tag"
  />
  <details class="sort-menu" id="sortMenu">
    <summary
      class="sort-trigger"
      id="sortButton"
      aria-label="Sort and filter options"
      title="Sort and filter options"
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M7 4v16m0 0-3-3m3 3 3-3"></path>
        <path d="M13 6h8M13 12h6M13 18h4"></path>
      </svg>
    </summary>
    <div class="sort-popover" aria-label="Sort and filter options">
      <div class="sort-header" id="sortHeaderCount">0 ITEMS SORTED BY</div>
      <button type="button" class="sort-option" data-sort-by="title" aria-pressed="false">
        <span>Title</span>
        <span class="sort-check" aria-hidden="true">✓</span>
      </button>
      <button type="button" class="sort-option" data-sort-by="createdAt" aria-pressed="false">
        <span>Date Created</span>
        <span class="sort-check" aria-hidden="true">✓</span>
      </button>
      <button type="button" class="sort-option is-active" data-sort-by="updatedAt" aria-pressed="true">
        <span>Date Modified</span>
        <span class="sort-check" aria-hidden="true">✓</span>
      </button>
      <hr class="sort-divider" />
      <button type="button" class="sort-option is-active" data-sort-order="desc" aria-pressed="true">
        <span id="sortOrderDescLabel">Newest First</span>
        <span class="sort-check" aria-hidden="true">✓</span>
      </button>
      <button type="button" class="sort-option" data-sort-order="asc" aria-pressed="false">
        <span id="sortOrderAscLabel">Oldest First</span>
        <span class="sort-check" aria-hidden="true">✓</span>
      </button>
      <div class="sort-tags-section hidden" id="sortTagsSection">
        <hr class="sort-divider" />
        <div class="sort-header">FILTER BY TAG</div>
        <div class="sort-tags-list" id="sortTagsList"></div>
      </div>
      <hr class="sort-divider" />
      <label class="sort-subvault-row">
        <input type="checkbox" id="includeSubvaultsCheckbox" />
        <span>Include items in subvaults</span>
      </label>
    </div>
  </details>
</div>
```

---

### Bước 3: State, Lọc Subvault Client-side & Xử lý Edge Cases (`state.js`, `item-list.js`, `main.js`, `keyboard.js`)

1. **`lib/ui/app/state.js` (R2 & R9)**:
   - Đọc `localStorage` an toàn trong `try/catch` và xác thực qua `normalizeSortBy` / `normalizeSortOrder`:
     - `sortBy`: `'updatedAt'` (hoặc từ `localStorage.getItem('webmcp-vault-sort-by')`)
     - `sortOrder`: `'desc'` (hoặc từ `localStorage.getItem('webmcp-vault-sort-order')`)
     - `includeSubvaults`: `localStorage.getItem('webmcp-vault-include-subvaults') === '1'` (mặc định `false`).
     - `vaultItems`: `[]` (lưu danh sách item của vault trước khi lọc search `#tag` để danh sách tag pills trong Popover luôn hiển thị đầy đủ các tag có trong vault hiện tại kể cả khi đang lọc 1 tag!).
2. **`lib/ui/app/item-list.js` (R1, R8)**:
   - Import `isDescendant` từ `./vaults.js` và `sortItems, collectAvailableTags, normalizeSortBy, normalizeSortOrder` từ `./item-sort.js`.
   - Thêm hàm `updateSortUi()` trong `item-list.js` để đồng bộ:
     - Header `#sortHeaderCount`: `${state.items.length} ${state.items.length === 1 ? 'ITEM' : 'ITEMS'} SORTED BY`.
     - Nhãn `#sortOrderDescLabel` (`state.sortBy === 'title' ? 'Z to A' : 'Newest First'`) và `#sortOrderAscLabel` (`state.sortBy === 'title' ? 'A to Z' : 'Oldest First'`).
     - Class `.is-active` và `aria-pressed` trên các nút `[data-sort-by]` và `[data-sort-order]` (nhờ dữ liệu đã chuẩn hóa nên `<button data-sort-order="asc">` hiển thị `A to Z` khi chọn `Title` hoặc `Oldest First` khi chọn ngày).
     - Render các pill `#tag` trong `#sortTagsList` từ `collectAvailableTags(state.vaultItems?.length ? state.vaultItems : state.items)`. Nếu người dùng đang lọc `#tag` trong ô `#search`, pill tương ứng có class `.is-active`.
   - Trong `loadItems` (**R1 & R8**):
     ```js
     const scope = state.selectedVaultId;
     const withSubs = scope !== 'all' && state.includeSubvaults && state.vaults.some((v) => v.parentId === scope);
     const searchVal = el('search').value.trim();
     if (searchVal) params.set('search', searchVal);
     if (scope !== 'all' && !withSubs) params.set('vault', scope);
     const payload = await api('/items' + (params.size ? '?' + params.toString() : ''));
     if (sequence !== state.loadSequence) return false;
     let items = payload.items || [];
     if (withSubs) {
       items = items.filter((it) => it.vaultId === scope || isDescendant(scope, it.vaultId));
     }
     if (!searchVal || !searchVal.startsWith('#')) {
       state.vaultItems = items;
     }
     state.items = sortItems(items, state.sortBy, state.sortOrder);
     renderList({ fillForm, loadDemoItems });
     setItemCount(state.items.length);
     ```
3. **`lib/ui/app/keyboard.js` (R4 - Edge case E1)**:
   - Ngay đầu nhánh `if (event.key === 'Escape')`:
     ```js
     if (el('sortMenu')?.open) {
       event.preventDefault();
       el('sortMenu').open = false;
       el('sortButton')?.focus();
       return;
     }
     ```
   - Tránh hoàn toàn việc nhấn `Escape` đóng menu Sort mà vô tình hủy luôn chế độ Edit của item đang sửa!
4. **`lib/ui/app/main.js` (R3, R5 - Edge case E2)**:
   - Sự kiện click trên `[data-sort-by]` và `[data-sort-order]`:
     - Cập nhật `state.sortBy` / `state.sortOrder`, lưu vào `localStorage`, gọi `state.items = sortItems(state.items, state.sortBy, state.sortOrder)` và `renderList(...)` ngay tại chỗ (0ms latency, không gọi lại API).
   - Sự kiện `change` trên `#includeSubvaultsCheckbox`:
     - Bảo vệ bằng `confirmDiscardChanges()` (**R5 - Edge case E2**):
       ```js
       el('includeSubvaultsCheckbox')?.addEventListener('change', async (e) => {
         const cb = e.currentTarget;
         if (!(await confirmDiscardChanges())) {
           cb.checked = !cb.checked;
           return;
         }
         state.includeSubvaults = cb.checked;
         try { localStorage.setItem('webmcp-vault-include-subvaults', cb.checked ? '1' : '0'); } catch {}
         boundLoadItems().catch((err) => setStatus(err.message, 'error'));
       });
       ```
   - Đóng `#sortMenu` khi click ra ngoài (`document.addEventListener('click', ...)`).

---

### Bước 4: Styling (`lib/ui/styles/fields.css`)

- Thêm ~80 dòng CSS vào `lib/ui/styles/fields.css` (tổng số dòng sau khi thêm khoảng ~675 LOC, dưới xa ngưỡng 700–1.000 LOC):
  - `.rail-top`: `display: flex; align-items: center; gap: var(--s2);`
  - `.search`: `flex: 1; min-width: 0;`
  - `.sort-menu`: `position: relative; flex: 0 0 auto;`
  - `.sort-trigger`: `width: 38px; height: 38px; display: grid; place-items: center; border: var(--border); border-radius: var(--r-md); background: var(--surface); color: var(--muted); cursor: pointer; list-style: none;` kèm `.sort-trigger::-webkit-details-marker { display: none; }` (**R7 - Safari fix**).
  - `.sort-popover`: `position: absolute; right: 0; top: calc(100% + 6px); width: 240px; z-index: 30; padding: 6px; border: var(--border); border-radius: var(--r-lg); background: var(--surface); box-shadow: var(--shadow-float);`
  - `.sort-header`, `.sort-option`, `.sort-check`, `.sort-divider`, `.sort-tags-list`, `.sort-subvault-row`.

---

## 3. Biên Nhận Review Kế Hoạch & Triển Khai (L1 & L2 Receipts)

### 3.1. Final Plan Review (Claude Opus 5.5)
- **Role**: `reviewer_l2` (Final Plan Review)
- **Dispatched Route**: `claude-cli`
- **Exact Model ID**: `claude-opus-5-5`
- **Verdict**: `APPROVED_WITH_REFINEMENTS` (Đã tích hợp đầy đủ R1–R10 vào Plan)
- **Summary of Refinements Applied**:
  1. Chuyển lọc `includeSubvaults` về client-side qua `isDescendantVault(vaults, scope, it.vaultId)` $\rightarrow$ không chạm vào `model.js`, `store.js`, `ui-server.js` API hay CLI.
  2. Mặc định `includeSubvaults = false` (`=== '1'`).
  3. Đổi nhãn chiều sort thành `A to Z` / `Z to A` khi chọn `Title`.
  4. Xử lý phím `Escape` đóng `#sortMenu` trước trong `keyboard.js` để không làm mất trạng thái Edit.
  5. Bọc `confirmDiscardChanges()` khi đổi checkbox `includeSubvaults`.
  6. Tách hàm thuần sang `lib/ui/app/item-sort.js` kèm unit test `tests/unit/item-sort.test.mjs`.

### 3.2. L1 & L2 Post-Implementation Code Review (Claude Sonnet 5.5 High & Claude Opus 5.5)
- **L1 Reviewer**: `claude-sonnet-5-5` (`high`, `claude-cli`) — Verdict: `PASS_WITH_FIXES` $\rightarrow$ **FIXED & PASS**
- **L2 Reviewer**: `claude-opus-5-5` (`claude-cli`) — Verdict: `PASS_WITH_FIXES` $\rightarrow$ **FIXED & PASS**
- **Các điểm đã khắc phục triệt để từ L1 & L2**:
  1. **F1 (`state.vaultItems` freshness khi đang search)**: Trong `loadItems`, khi `searchVal` khác rỗng, thực hiện `Promise.all` gọi song song request có search và request phạm vi vault không search (`scopePayload`) để `state.vaultItems` luôn phản ánh đúng tập tag của vault/subvault hiện hành (kể cả khi đổi vault, bật/tắt `includeSubvaults`, hoặc kết quả lọc rỗng).
  2. **F2 (Exact `#tag` matching & Lock hygiene)**: Thêm `splitSearchAndTags(searchVal)` để hỗ trợ multi-tag AND filtering và xóa sạch `state.vaultItems = []`, `state.selectedTags = []`, `clearPendingClipboard()` khi bấm nút `Lock`.
  3. **F3 (Keyboard & Dialog guard)**: Thêm `!isDialog` vào nhánh `Escape` của `#sortMenu` trong `keyboard.js`, khôi phục focus cho `.sort-tag-pill` đang chọn (bọc `CSS.escape`) khi `sortMenu` mở, và bỏ giới hạn `max-width: 110px` trên `.sort-tag-pill` để không cắt mất phần `(count)`.

### 3.3. Phase 3 High-ROI `/ponytail` Upgrades & L1/L2 Review (Claude Sonnet 5.5 High & Claude Opus 5.5)
- **Các tính năng Phase 3 đã triển khai**:
  1. **Rolled-up parent vault counts (`computeRolledUpCounts` trong `item-sort.js` & `vaults.js`)**: Thư mục cha (như `GMAIL`) hiển thị tổng số item cộng dồn cả các subvault con (`130` thay vì `1`), có chống vòng lặp chu trình (`visited` Set).
  2. **Subvault badge trong `.meta` & chuẩn hóa Empty State (`item-list.js`)**: Khi xem `All items` hoặc bật `Include items in subvaults`, dòng `.meta` của mỗi item hiển thị tên subvault gốc (`GMAIL_PHU · user@... · google.com`); đổi thông báo trống từ `"No logins..."` thành `"No items..."`.
  3. **Active filter dot trên `#sortButton` (`item-list.js` & `fields.css`)**: Hiển thị chấm tròn xanh `.has-filter` ở góc trên phải nút Sort khi đang bật lọc `includeSubvaults` (trên thư mục cha) hoặc có tag filter đang chọn.
  4. **Nút `Generate` mật khẩu 1 dòng (`generateRandomPassword` trong `item-sort.js`, `vault-ui.html`, `main.js`, `fields.css`)**: Sinh mật khẩu ngẫu nhiên 24 ký tự bằng `crypto.getRandomValues` với rejection sampling không lệch modulo (`maxValid = 256 - (256 % len)`), hiển thị ngay cả khi tạo mới Login (`.secret-input.idle .linkbtn.generate-btn`).
  5. **Tự động xóa Clipboard sau 60s (`status.js` & `main.js`)**: Khi copy dữ liệu nhạy cảm (`password`, `one-time code`, `secret`, `token`, `key`, `note`), tự động đặt hẹn giờ 60s xóa clipboard (`wipeClipboardOnce` có fallback `fallbackCopyText(' ')` cho HTTP `0.0.0.0` và retry khi tab nhận lại `focus`), đồng thời xóa ngay lập tức khi bấm nút `Lock`.
- **Biên nhận L1 & L2 Review cho Phase 3**:
  - **L1 Reviewer**: `claude-sonnet-5-5` (`high`, `--provider claude`)
  - **L2 Reviewer**: `claude-opus-5-5` (`--provider claude`)
  - **Các điểm P1/P2 từ Claude Opus 5.5 đã được khắc phục triệt để**:
    1. **P1-1 (`status.js` — Clipboard auto-clear trên HTTP / background tab)**: Bổ sung `wipeClipboardOnce()` kết hợp `navigator.clipboard.writeText('')`, fallback `fallbackCopyText(' ')` cho ngữ cảnh HTTP (`0.0.0.0:7876`), retry 1 lần trên sự kiện `window.addEventListener('focus', ..., { once: true })` nếu tab đang ẩn, và gọi `clearPendingClipboard()` ngay khi bấm `Lock`.
    2. **P1-2 (`keyboard.js` — Phím `Escape` trong ô `#search`)**: Đưa `clearTimeout(state.searchTimer)` lên trước `dispatchEvent(new Event('input'))` và gọi `renderSearchTagPills()` ngay lập tức để xóa sạch tag pills và reload danh sách không bị hủy timer.
    3. **P2 & `/ponytail` YAGNI (`item-sort.js`, `main.js`, `item-list.js`)**: Xóa 2 hàm thừa không còn caller (`toggleTagInQuery`, `parseExactTagQuery`), export và tái sử dụng `SINGLE_TAG_TOKEN_RE` trong `main.js`, thêm `if (event.isComposing) return;` để bảo vệ bộ gõ Tiếng Việt Telex/VNI khi nhấn Space/Enter, và bọc `CSS.escape(focusedTag)` trong `item-list.js`.


