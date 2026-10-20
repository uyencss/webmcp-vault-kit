# Kế Hoạch Triển Khai Tính Năng `tags` Cho WebMCP Vault (Lăng Kính `/ponytail`)

- **Ngày lập**: 2026-10-20
- **Hội đồng kiến trúc**: Gemini 4 Argon (Coordinator & Codebase Trace) × Claude Opus 5.5 (Architectural Reviewer)
- **Triết lý thiết kế**: `/ponytail` (YAGNI, tái sử dụng cơ chế sẵn có, HTML/CSS native, không tạo file mới, không bump schema, diff tối giản $\approx 50$ dòng trên 8 file hiện hữu)
- **Trạng thái**: **PROPOSED** (Chờ duyệt trước khi triển khai code)

---

## 1. Mục Tiêu & Bài Toán Thực Tế

1. **Đánh dấu phân loại đa chiều (`tags`)**:
   - Cho phép gắn nhãn như `ai-ultra` (tài khoản `harry2906090`), `ai-pro`, `2tb`, `verified` lên bất kỳ bản ghi nào (`login`, `api_token`, `ssh_key`, `env`) mà **không cần tách rời** tài khoản khỏi thư mục Vault gốc (`GMAIL_CHINH`, `GMAIL_PHU`).
2. **Truy xuất & Lọc tốc độ tức thì ($O(n)$ in-memory)**:
   - **Cho Agent / Automation CLI**: Lọc chính xác bằng cờ `--tag`:
     ```bash
     webmcp-vault list --tag ai-ultra --json
     webmcp-vault list --tag ai-pro --json
     ```
   - **Cho thao tác gắn nhãn 1 dòng CLI**:
     ```bash
     webmcp-vault update "Gmail - harry2906090" --tags "ai-ultra"
     webmcp-vault update "Gmail - hieu2906090" --tags "ai-pro"
     ```
   - **Cho người dùng trên Web UI (`http://127.0.0.1:7876`)**:
     - Hiển thị pill `#ai-ultra`, `#ai-pro` ngay trên danh sách item và màn hình chi tiết.
     - Bấm vào bất kỳ pill `#tag` nào $\rightarrow$ tự động điền `#tag` vào ô Search sẵn có và lọc danh sách ngay lập tức (không cần xây dựng thanh Filter Bar mới).
     - Khi Edit item $\rightarrow$ dùng một ô `<input id="tags">` native ngăn cách bằng dấu phẩy (`ai-pro, 2tb`), không dùng chip-editor phức tạp.

---

## 2. Thiết Kế Chi Tiết Từng File (Exact Diff Plan)

### Bước 1: Chuẩn hóa Model & Tìm kiếm (`lib/vault/model.js`)

#### 1.1. Hàm `normalizeTags(input)` (12 dòng)
- Chấp nhận `string[]` hoặc chuỗi phân cách bằng dấu phẩy `'ai-pro, #ai-ultra'`.
- Tự động cắt khoảng trắng, chuyển về chữ thường (`toLowerCase()`), bỏ ký tự `#` ở đầu nếu người dùng nhập `#ai-pro`, và loại bỏ trùng lặp qua `new Set()`.
- Kiểm tra định dạng bằng Regex `/^[a-z0-9][a-z0-9._:-]{0,63}$/` (hỗ trợ cả namespace kiểu `plan:ultra` nếu cần) và giới hạn tối đa `20` tags/item.
- **Bảo vệ biên**: Nếu truyền boolean (ví dụ gõ `--tags` thiếu giá trị khiến parser trả về `true`), báo lỗi tường minh thay vì biến thành tag `"true"`.

```js
const MAX_TAGS_PER_ITEM = 20;
const TAG_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,63}$/;

function normalizeTags(input) {
  if (input === undefined || input === null || input === '') return [];
  if (typeof input !== 'string' && !Array.isArray(input)) {
    throw new Error('tags must be a comma-separated string or an array of strings.');
  }
  const rawList = Array.isArray(input) ? input : input.split(',');
  const tags = [
    ...new Set(
      rawList
        .map((t) => String(t).trim().toLowerCase().replace(/^#+/, ''))
        .filter(Boolean)
    ),
  ];
  if (tags.length > MAX_TAGS_PER_ITEM) {
    throw new Error(`tags cannot exceed ${MAX_TAGS_PER_ITEM} entries.`);
  }
  const invalid = tags.find((t) => !TAG_PATTERN.test(t));
  if (invalid) {
    throw new Error(`Invalid tag "${invalid}"; use lowercase letters, numbers, and . _ : -`);
  }
  return tags;
}
```

#### 1.2. Bảo toàn `tags` trong `normalizeItemInput(input, existing)`
- Trong cả 2 nhánh (`type === 'login'` và nhánh typed item):
  - Nếu `has('tags')`: `patch.tags = normalizeTags(input.tags);`
  - Nếu `!existing` (tạo mới): `patch.tags = patch.tags || [];`
- **Cơ chế bảo toàn khi Update**: Trong `lib/store.js`, `updateItem` thực hiện `Object.assign(item, patch)`. Khi cập nhật các trường khác mà không truyền `tags` (`!has('tags')`), `patch` không chứa khóa `tags` nên `item.tags` cũ được giữ nguyên 100% (kể cả khi đổi `type` qua `mapTypeFields`). Khi truyền `tags: ""` hoặc `tags: []`, `patch.tags` sẽ là `[]` giúp xóa sạch tags.

#### 1.3. Phơi bày `tags` trong `redactItem(item)` (1 dòng)
- Đặt trực tiếp vào đối tượng `base` trong `redactItem(item)` ([lib/vault/model.js](file:///Users/ttcenter/Desktop/VIBE_CODE/webmcp-automation-kit/packages/webmcp-vault-kit/lib/vault/model.js#L305-L312)):
  ```js
  const base = {
    id: item.id,
    vaultId: item.vaultId || DEFAULT_VAULT_ID,
    type,
    title: item.title,
    tags: Array.isArray(item.tags) ? item.tags : [],
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
  ```
- Vì `revealItem(item)` trải (`...redactItem(item)`), mọi đường đọc (`listItems`, `getItem`, `revealItem`, `resolve`) cho mọi loại item đều tự động có `tags: string[]`. Bản ghi cũ chưa có trường `tags` trên đĩa sẽ tự động trả về `[]` mà không cần chạy script migration.

#### 1.4. Tích hợp vào `itemMatchesSearch(item, search)` (1 dòng)
- Trong `itemMatchesSearch` ([lib/vault/model.js](file:///Users/ttcenter/Desktop/VIBE_CODE/webmcp-automation-kit/packages/webmcp-vault-kit/lib/vault/model.js#L400-L415)), chỉ cần đẩy `...(item.tags || []).map((t) => '#' + t)` vào `haystack`:
  ```js
  const haystack = [
    item.id,
    item.title,
    item.web,
    item.username,
    item.type,
    ...(Array.isArray(item.tags) ? item.tags.map((t) => `#${t}`) : []),
  ];
  ```
- **Tại sao chỉ cần `'#' + t` (Ponytail Insight từ Opus 5.5)**:
  Vì `itemMatchesSearch` kiểm tra `.includes(query)`:
  - Gõ `ai-pro` $\rightarrow$ khớp với chuỗi con trong `#ai-pro`.
  - Gõ `#ai-pro` $\rightarrow$ khớp chính xác tiền tố `#ai-pro` (không bị lẫn với username có chữ `ai-pro`).
  - Gõ `#ai-` $\rightarrow$ khớp cả `#ai-pro` lẫn `#ai-ultra`!

#### 1.5. Hàm `itemMatchesTags(item, tagFilter)`
- Hỗ trợ lọc chính xác (exact match AND) cho Agent / CLI:
  ```js
  function itemMatchesTags(item, tagFilter) {
    const wanted = normalizeTags(tagFilter);
    if (wanted.length === 0) return true;
    const itemTags = Array.isArray(item.tags) ? item.tags : [];
    return wanted.every((t) => itemTags.includes(t));
  }
  ```
- Export thêm `normalizeTags` và `itemMatchesTags` trong `module.exports`.

---

### Bước 2: Store Filter (`lib/store.js`)

- Cập nhật `listItems(filters = {})` ([lib/store.js](file:///Users/ttcenter/Desktop/VIBE_CODE/webmcp-automation-kit/packages/webmcp-vault-kit/lib/store.js#L156-L165)) và `resolveItem` ([lib/vault/model.js](file:///Users/ttcenter/Desktop/VIBE_CODE/webmcp-automation-kit/packages/webmcp-vault-kit/lib/vault/model.js#L417-L436)):
  ```js
  listItems(filters = {}) {
    const vault = loadVault();
    const vaultId = normalizeString(filters.vaultId, 'vaultId');
    if (vaultId && vaultId !== 'all') findVault(vault, vaultId);
    return vault.items
      .filter((item) => !vaultId || vaultId === 'all' || item.vaultId === vaultId)
      .filter((item) => itemMatchesTags(item, filters.tag ?? filters.tags))
      .filter((item) => itemMatchesSearch(item, filters.search))
      .filter((item) => webMatches(item.web, filters.web))
      .map(redactItem);
  },
  ```

---

### Bước 3: HTTP API (`lib/ui-server.js`) & CLI (`bin/webmcp-vault.mjs`)

1. **`lib/ui-server.js`**:
   - Trong `GET /api/items`, truyền thêm `tag: url.searchParams.get('tag') || undefined` vào `store.listItems(...)`.
2. **`bin/webmcp-vault.mjs`**:
   - **Sửa lỗi biên `parseFlags` ([bin/webmcp-vault.mjs](file:///Users/ttcenter/Desktop/VIBE_CODE/webmcp-automation-kit/packages/webmcp-vault-kit/bin/webmcp-vault.mjs#L78))**:
     Đổi `if (next && !next.startsWith('--'))` thành `if (next !== undefined && !next.startsWith('--'))` để khi truyền `--tags ""` (chuỗi rỗng nhằm xóa tags), parser nhận đúng `""` thay vì gán nhầm thành `true`.
   - **`list` & `resolve`**: Truyền `tag: flags.tag || flags.tags` vào `store.listItems` và `store.resolve`.
   - **`create` & `update`**:
     Cho phép truyền `--tags <a,b>` trực tiếp từ CLI (kể cả khi `update` không truyền `--stdin-json`, giúp gán tag bằng 1 lệnh duy nhất):
     ```js
     if (subcommand === 'update') {
       const identifier = positional[0];
       if (!identifier) throw new Error('Usage: webmcp-vault update <id-or-query> (--stdin-json | --input-json <file> | --tags <a,b>) [--vault <vault-id>]');
       const stdinInput = await readVaultItemInput(flags);
       const hasInlineFlags = Object.hasOwn(flags, 'tags') || Boolean(flags.vault);
       const input = stdinInput || (hasInlineFlags ? {} : null);
       if (!input) throw new Error('Use --stdin-json, --input-json <file>, or --tags <a,b> for vault writes.');
       if (flags.vault) input.vaultId = String(flags.vault);
       if (Object.hasOwn(flags, 'tags')) input.tags = flags.tags;
       if (flags['drop-fields'] === true) input.dropFields = true;
       const item = store.updateItem(identifier, input);
       printJsonOrHuman({ item }, json, `Updated vault item ${item.id}`);
       return;
     }
     ```

---

### Bước 4: Giao Diện Web UI (`vault-ui.html`, `item-list.js`, `view-fields.js`, `controller.js`, `layout.css`)

1. **`lib/ui/vault-ui.html`**:
   - Thêm 1 khối `.field.wide` cho `Tags` ngay dưới `Title`:
     ```html
     <div class="field wide">
       <label for="tags" class="field-label-with-icon">
         <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>
         <span>Tags</span>
       </label>
       <span class="view-field view-only" id="tagsViewField" role="button" tabindex="0" aria-label="Tags"></span>
       <input class="mono edit-only" id="tags" autocomplete="off" placeholder="ai-pro, ai-ultra, 2tb" maxlength="500" />
     </div>
     ```
2. **`lib/ui/app/item-list.js`**:
   - Trong `renderList`, render các pill `<span class="item-tag-badge" data-tag="${tag}">#${tag}</span>` bên trong `.item-badges` (dùng `<span>` thay vì `<button>` vì cả dòng `.item` đã là `<button>`).
   - Ngay đầu hàm `button.addEventListener('click', ...)` ([lib/ui/app/item-list.js](file:///Users/ttcenter/Desktop/VIBE_CODE/webmcp-automation-kit/packages/webmcp-vault-kit/lib/ui/app/item-list.js#L134-L137)):
     ```js
     const tagNode = e.target.closest('[data-tag]');
     if (tagNode) {
       el('search').value = '#' + tagNode.dataset.tag;
       loadItems({ fillForm, loadDemoItems });
       return;
     }
     ```
   - *Lưu ý đã kiểm chứng*: Hàm `loadItems` ([lib/ui/app/item-list.js](file:///Users/ttcenter/Desktop/VIBE_CODE/webmcp-automation-kit/packages/webmcp-vault-kit/lib/ui/app/item-list.js#L243-L246)) đã dùng `new URLSearchParams()` nên ký tự `#` trong `#ai-pro` được tự động mã hóa thành `%23ai-pro`, không bị trình duyệt cắt nhầm thành URL fragment.
3. **`lib/ui/app/view-fields.js` & `lib/ui/app/controller.js`**:
   - Trong `fillForm`: `el('tags').value = (item.tags || []).join(', ');`
   - Trong `formPayload`: Thêm `tags: el('tags').value` cho cả `login` và typed items.
   - Trong `updateViewFields`: Hiển thị các pill `.item-tag-badge` trong `#tagsViewField` (hoặc `—` nếu trống).
4. **`lib/ui/styles/layout.css`**:
   - Thêm 10 dòng CSS cho `.item-tag-badge` (kiểu pill nhỏ gọn dùng biến màu `var(--live-weak)` và `var(--live)` sẵn có).

---

## 3. Danh Sách Cắt Bỏ Theo Lăng Kính `/ponytail` (YAGNI — Không Làm)

| Hạng mục bị loại bỏ | Lý do cắt bỏ (`/ponytail`) |
| :--- | :--- |
| Bảng/collection `tags` riêng hoặc Tag ID | Mảng `string[]` trực tiếp trên mỗi item là đủ; toàn bộ vault nằm trong bộ nhớ. |
| Tăng version schema hoặc viết script migration | `tags` là trường tùy chọn, mặc định đọc ra `[]` khi chưa có. |
| Chip-editor phức tạp (nút `×` xóa từng tag, kéo thả) | Một thẻ `<input placeholder="ai-pro, ai-ultra">` phân tách bằng dấu phẩy là ngắn nhất, không cần state riêng. |
| Thanh Filter Bar mới hoặc Dropdown `/api/tags` | Gõ `#ai-pro` hoặc click vào pill `#ai-pro` sẽ đẩy thẳng vào ô Search sẵn có. |
| Bảng chọn màu (Color Picker) cho từng tag | Dùng chung token màu `var(--live)` sẵn có của hệ thống. |
| Ngôn ngữ truy vấn phức tạp (`OR`, `NOT`, regex) | `--tag a,b` dùng logic `AND` chuẩn xác cho Agent; ô Search hỗ trợ tìm tiền tố `#ai-` cho người dùng. |

---

## 4. Kế Hoạch Kiểm Thử & Nghiệm Thu

1. **Unit Test**:
   - Kiểm tra `normalizeTags(' AI-Pro, #ai-pro , 2tb ')` $\rightarrow$ `['ai-pro', '2tb']`.
   - Kiểm tra `updateItem` khi không truyền `tags` phải **giữ nguyên** `tags` cũ; khi truyền `tags: ''` phải xóa sạch `tags`.
   - Kiểm tra `listItems({ tag: 'ai-pro' })` và `listItems({ search: '#ai-pro' })`.
2. ** Áp dụng thực tế ngay sau khi triển khai**:
   - Gắn nhãn `ai-ultra` cho tài khoản `Gmail - harry2906090` (`5d73dd78-cf53-42d3-a317-f3eed3d27181`).
   - Gắn nhãn `ai-pro` cho danh sách các tài khoản Gmail có gói Pro theo chỉ định của người dùng.
