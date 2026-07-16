# WebMCP Vault Environment, UI, and CSV Implementation Plan

Date: 2026-07-16
Package: `@gyga-browser/webmcp-vault-kit`

## Context

The vault already uses one authenticated encrypted JSON envelope. For the
current single-user local workload, this remains the default storage design:
it encrypts all payload data, has no native database dependency, and is simple
to back up as one file. SQLite should only be introduced behind a storage
adapter after measurements show a need for indexed queries or larger incremental
updates; plain SQLite would not provide encryption and a live backup would also
need to account for its journal/WAL files.

This follow-up makes the existing JSON-backed vault easier to operate from the
automation kit and safer to manage through the local UI. It documents the
unlock-key environment contract, provides package-level UI commands, and adds a
confirmation gate for CSV imports without rendering secrets in a preview.

## Goals

- Make `WEBMCP_VAULT_KEY`, `WEBMCP_VAULT_KEY_FILE`, and `WEBMCP_HOME`
  discoverable through a safe published template.
- Allow an automation-kit or embedding process to provide an inherited unlock
  key without exposing it to browser state.
- Provide concise `npm run ui` and `npm run test:ui` commands.
- Let users select a CSV in the UI, review redacted import metadata, then
  explicitly confirm the write.
- Keep existing encrypted JSON storage, backups, and CLI import behavior
  compatible.

## Non-Goals

- Load `.env` files implicitly or store unlock keys in the package.
- Send a configured environment key to the browser, local storage, or the DOM.
- Show passwords, TOTP seeds, or notes in CSV preview results.
- Add SQLite or change the vault envelope format in this change.
- Add a browser E2E dependency for this dependency-free package.

## Implementation Phases

### Phase 1: Environment Contract

Status: Done

- Add a blank, publishable `.env.example` with the three supported variables.
- Ignore real `.env` variants in Git.
- Document that the package intentionally uses the process environment it
  inherits; the automation-kit runtime is responsible for loading/configuring
  any dotenv-style source.
- Add an explicit configured-key UI action. It calls the token-gated server,
  which resolves its own environment source, and never returns the key.

### Phase 2: UI Commands and Verification

Status: Done

- Add `npm run ui` as an alias for `webmcp-vault ui`.
- Add `npm run test:ui` for the local UI-server unit test.
- Add package-level tests for the template, ignored real env file, scripts, and
  publish list.
- Verify `/api/doctor` can report an inherited source without serializing the
  configured key.

### Phase 3: Redacted CSV Preview

Status: Done

- Factor import planning so preview and import use the same normalization and
  duplicate rules.
- Add `store.previewImport()` and `POST /api/import/preview`.
- Return only title, website, username, and secret-presence flags, plus counts
  for importable, duplicate, and invalid rows.
- Add a native UI confirmation dialog. Retain the selected CSV only until the
  user confirms or closes the dialog, then clear the in-memory string.
- Limit CSV upload/request size to 1 MB, matching the UI server body limit.

### Phase 4: Documentation and Package Quality

Status: Done

- Document configured-key behavior, UI commands, redacted preview behavior, and
  library/UI API boundaries.
- Replace the standalone review note with this implementation plan.
- Run unit tests, coverage, syntax validation, whitespace validation, and a
  package dry run before handoff.

## Acceptance Criteria

- `.env.example` contains blank values for all supported vault environment
  variables and is included in the npm package.
- An inherited environment key can initialize/unlock the UI without its value
  appearing in API responses or the UI DOM.
- `npm run ui` starts the existing token-gated local UI and `npm run test:ui`
  runs its focused test file.
- A CSV import requires a review/confirm step, and preview JSON does not contain
  the password, OTP seed, or note from any source row.
- CSV duplicate behavior is identical between preview and final import.
- Existing package tests and publish dry run pass.

## Work Log

- 2026-07-16: Kept encrypted JSON as the current storage backend; documented
  the threshold for a future adapter-based SQLite evaluation.
- 2026-07-16: Added environment template, inherited-key UI unlock, package UI
  scripts, redacted CSV preview, tests, and updated architecture/skill docs.

## Verification Checklist

- Run the complete package suite:

```bash
npm test
```

- Run just the UI server suite:

```bash
npm run test:ui
```

- Start a local UI with an inherited key source:

```bash
WEBMCP_VAULT_KEY_FILE=/protected/path/webmcp-vault.key npm run ui
```

- Check package contents:

```bash
npm pack --dry-run
```
