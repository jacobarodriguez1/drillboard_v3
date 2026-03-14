# PR: Comm Persistence Hardening

## Summary

Implements hardening changes for the Comm persistence and urgent message system: load sanitization, atomic writes, documentation fixes, UI guards for invalid timestamps, and broadcast per-pad cloning.

---

## Changes by File

### lib/commPersistence.ts

- **Load sanitization:**
  - `ts`: Filter out messages where `ts` is NaN or ±Infinity (chose filter over clamp to avoid corrupting sort/display; invalid ts would break `formatHhmm` and ordering).
  - `ackedAt`: Treat invalid values (NaN, Infinity, non-numeric) as `undefined` (unacked).
  - `urgent`: Strict parsing — `true` only if `m.urgent === true` or `m.urgent === "true"` (legacy).
  - `padId`: Only accept positive integer keys; reject `"1.9"`, `"x"`, etc. via `parsePadKey()`.
- **Atomic write:** Write to `<path>.tmp`, then `renameSync` to final path; tmp file does not linger on success.
- **Docs:** Header and JSDoc updated to "throttled/coalesced writes (max once per second)".

### pages/api/socket.ts

- **Broadcast:** Push per-pad clone `{ ...msg }` instead of shared reference to avoid future cross-pad mutation if broadcast gains urgent/ackedAt.

### pages/admin.tsx, pages/judge.tsx

- **formatHhmm:** Add `if (!Number.isFinite(ts)) return "";` before timestamp formatting.

### lib/commPersistence.test.ts (new)

- Tests for load sanitization: ts NaN/invalid, ackedAt invalid, urgent="false", pad key "1.9".
- Test for atomic write (tmp + rename, no lingering tmp).

### package.json

- Added `tsx` devDependency for running TS tests.
- Added `test:comm` script: `node --test --import tsx lib/commPersistence.test.ts`.

---

## Design Choices

| Choice | Rationale |
|--------|-----------|
| Filter invalid ts vs clamp | Filtering avoids corrupting sort order and display; clamping to `Date.now()` would make old messages appear as "now". |
| Strict urgent | `Boolean("false")` is true; strict check avoids misclassifying non-urgent messages. |
| Per-pad broadcast clone | Prevents shared-reference bugs if broadcast messages later support urgent/ackedAt. |

---

## Test Results

```
✔ filters messages with invalid ts (NaN from 'x' or Infinity)
✔ ackedAt='x' becomes undefined (unacked)
✔ urgent='false' does NOT become urgent
✔ pad key '1.9' is rejected (does not overwrite pad 1)
✔ valid data passes through unchanged
✔ writes to .tmp then renames; tmp does not linger
```
