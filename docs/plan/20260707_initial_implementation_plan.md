# WebMCP Vault Kit Implementation Plan

Date: 2026-07-07
Package: `@gyga-browser/webmcp-vault-kit`

## Context

`webmcp-vault-kit` was split out from `webmcp-browser-kit` so credential storage
can be shared by browser automation, workflow execution, and future agent
integrations without coupling them to the Chrome gateway package.

The package should provide one local encrypted vault capability with three
stable surfaces:

- Library API for Node/Electron packages.
- Standalone CLI for humans and agent scripts.
- Local web UI/REST server for manual item management.

## Goals

- Store website login items: title, website, username, password, TOTP seed, and
  note.
- Generate current TOTP codes on demand without exposing seed secrets by
  default.
- Support CLI reads that are easy for agents to compose:
  `doctor`, `list`, `resolve`, `get`, `read`.
- Support write paths that avoid shell-history leaks:
  `create --stdin-json`, `update --stdin-json`, `import <csv>`.
- Support embedders such as `webmcp-browser-kit` and `webmcp-workflow-cli`.
- Keep the storage format local, inspectable, versioned, and migration-ready.

## Non-Goals

- Cloud sync, hosted accounts, or multi-user sharing.
- Browser extension password autofill.
- Long-lived REST service intended for public network exposure.
- Recovery if the user loses the vault key.

## Current State

- `lib/store.js` owns encryption, storage, item CRUD, website resolution, TOTP,
  CSV parsing, and import dedupe.
- `bin/webmcp-vault.mjs` exposes the standalone CLI.
- `lib/ui-server.js` serves a token-gated local UI and REST API.
- `skills/webmcp-vault/SKILL.md` documents how future agents should use the CLI.
- Unit tests cover store behavior, CLI behavior, UI server behavior, and CSV
  import.

## Implementation Phases

### Phase 1: Package Boundary

Status: Done

- Create independent `@gyga-browser/webmcp-vault-kit` package.
- Move core vault logic out of `webmcp-browser-kit`.
- Expose package entrypoints:
  - `.` -> `lib/store.js`
  - `./ui-server` -> `lib/ui-server.js`
  - `./bin` -> `bin/webmcp-vault.mjs`
- Keep the vault data path compatible with existing WebMCP usage:
  `WEBMCP_HOME/vault/credentials.enc.json`.

### Phase 2: Secure Storage Core

Status: Done

- Use AES-256-GCM for encrypted vault envelopes.
- Derive the encryption key from `WEBMCP_VAULT_KEY` or
  `WEBMCP_VAULT_KEY_FILE` with scrypt.
- Save versioned envelopes with KDF metadata, IV, auth tag, and encrypted data.
- Write via temporary files and `rename` to reduce partial-write risk.
- Redact sensitive fields from list/get results unless explicitly revealed.

### Phase 3: Agent-Friendly CLI

Status: Done

- Keep read commands stable and JSON-friendly.
- Use `--stdin-json`/`--input-json` for writes.
- Add CSV import for generic and Bitwarden-style login headers.
- Return clear nonzero errors for missing key, missing vault, invalid JSON, and
  ambiguous item resolution.

### Phase 4: Local UI

Status: Done

- Serve local UI from `webmcp-vault ui`.
- Gate UI/API with a random per-process token.
- Keep vault key client-provided per request unless an embedding app chooses a
  different server-side key strategy.
- Include strict cache-control and basic security headers.

### Phase 5: Downstream Integrations

Status: Planned

- Update `webmcp-browser-kit` to depend on this package instead of carrying a
  duplicate vault implementation.
- Bridge `webmcp vault <cmd>` to `webmcp-vault <cmd>` for backwards-compatible
  UX.
- Expose read-only MCP tools in `webmcp-browser-kit` backed by this package:
  `vault_resolve`, `vault_read`.
- Update `webmcp-workflow-cli` to resolve vault references during workflow
  execution, for example:
  - `vault://web/example.com#username`
  - `vault://item/<id>#password`
  - explicit workflow step inputs resolved through `webmcp-vault read`.

### Phase 6: Hardening

Status: In progress

- Add explicit migration hooks for future vault schema versions.
- [Done 2026-07-16] Add authenticated encrypted backup and guarded restore with
  an automatic pre-restore recovery snapshot.
- [Done 2026-07-16] Add inter-process writer locking with stale-lock recovery.
- [Done 2026-07-16] Add durable atomic writes with file/directory `fsync` and
  bounded envelope/KDF validation.
- Consider keychain integration as an optional unlock-key source.
- Add E2E smoke tests for the UI form flow if the package grows a browser test
  dependency.

## Work Log

- 2026-07-07: Package split exists at `packages/webmcp-vault-kit`.
- 2026-07-07: Verified current surfaces: store API, standalone CLI, local UI,
  CSV import tests, and companion skill.
- 2026-07-07: Added package implementation plan and architecture docs.
- 2026-07-16: Added encrypted backup/restore, pre-restore recovery snapshots,
  writer locking, durable writes, and crypto envelope validation.

## Verification Checklist

- Run package tests:

```bash
npm test --prefix packages/webmcp-vault-kit
```

- Smoke-test CLI from outside the package:

```bash
WEBMCP_HOME="$(mktemp -d)" WEBMCP_VAULT_KEY="test-key" \
  node packages/webmcp-vault-kit/bin/webmcp-vault.mjs init --json
```

- Check publish contents include docs:

```bash
npm pack --dry-run --prefix packages/webmcp-vault-kit
```
