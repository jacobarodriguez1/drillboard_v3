# Comm Architecture Verification Report

## Section 1: Persistence Scheduling — ALL Mutations

### Verified mutation sites (pages/api/socket.ts)

| # | Location | Mutation | Persist? | Verified |
|---|----------|----------|----------|----------|
| 1 | L107 `loadCommChannelsIfNeeded` | `channels[id] = msgs` | No (load) | ✓ Correct |
| 2 | L441 `ensureChannelsForPads` | `channels[id] = []` | No | ✓ Acceptable (structural only) |
| 3 | L473-476 `appendChatToPad` | `cur.push(msg)`, `channels[padId]=cur` | Yes L477 | ✓ |
| 4 | L690 `judge:comm:send` | `lastUnackedUrgent.ackedAt = Date.now()` | Yes L691 | ✓ |
| 5 | L696 `judge:comm:send` | via `appendChatToPad` | Yes | ✓ |
| 6 | L715 `judge:comm:ack` | `msg.ackedAt = Date.now()` | Yes L716 | ✓ |
| 7 | L751-754 `admin:comm:broadcast` | `cur.push(msg)`, `channels[pid]=cur` | Yes L756 | ✓ |

**Conclusion:** All message-affecting mutations schedule persist. ✓

### Additional issues found (not in original review)

**Issue A:** `comm:presence` (L646-657) updates `G.commJudges` but does not touch `G.commChannels`. Persistence is not required. ✓ Correct.

**Issue B:** `emitState` runs `ensureChannelsForPads` (L520) but does not schedule persist. If `ensureChannelsForPads` creates new empty channels (e.g. `channels[3]=[]` for a newly added pad), those are never persisted. On restart, the same structure is recreated from the pad list. No message data loss. ✓ Acceptable.

---

## Section 2: Throttle vs Debounce

### Code trace (lib/commPersistence.ts L84-106)

```ts
if (saveScheduled) return;   // ← EARLY EXIT on subsequent calls
saveScheduled = true;
if (saveTimer) clearTimeout(saveTimer);
saveTimer = setTimeout(() => {
  saveScheduled = false;
  saveTimer = null;
  // ... write ...
}, DEBOUNCE_MS);
```

**Behavior:** First call schedules; subsequent calls within 1s return immediately. No timer reset. This is a **throttle**.

**Requirement:** "at most once per second" — satisfied. ✓

### Additional issues found

**Issue C:** Comment says "debounced" (L3) but implementation is throttle. Misleading documentation.

**Issue D:** If write throws (e.g. disk full), `saveScheduled` is already reset. Next mutation will schedule again. No retry loop. Data loss for that batch. Acceptable.

---

## Section 3: Load Path Sanitization

### Code trace (lib/commPersistence.ts L66-75)

```ts
filter((m) => m && typeof m === "object" && typeof (m as any).id === "string" && typeof (m as any).ts === "number" && typeof (m as any).text === "string")
.map((m) => ({
  id: String(m.id),
  ts: Number(m.ts),
  from: m.from === "JUDGE" ? "JUDGE" : "ADMIN",
  text: String(m.text ?? ""),
  urgent: Boolean(m.urgent),
  ackedAt: m.ackedAt != null ? Number(m.ackedAt) : undefined,
}));
```

### Verification

| Field | Sanitization | NaN/Invalid handling |
|-------|--------------|----------------------|
| ts | `Number(m.ts)` | `typeof m.ts === "number"` passes for NaN. `Number(NaN)` = NaN. Loaded messages can have `ts: NaN`. → `formatHhmm(NaN)` → `new Date(NaN).toLocaleTimeString()` → "Invalid Date" or similar. **Gap.** |
| ackedAt | `m.ackedAt != null ? Number(m.ackedAt) : undefined` | `Number("x")` = NaN. `ackedAt: NaN` treated as acked (`NaN != null`). Corrupt file could hide unacked. **Gap.** |
| urgent | `Boolean(m.urgent)` | `Boolean("false")` = true. Corrupt file could mark non-urgent as urgent. **Gap.** |

### Fix

**ts:** Add `Number.isFinite(ts)` check; filter out or clamp invalid messages.

**ackedAt:** Use `Number.isFinite(Number(m.ackedAt)) ? Number(m.ackedAt) : undefined`.

**urgent:** Use `m.urgent === true || m.urgent === "true"` (strict) for intentional urgent only.

---

## Section 4: Pad Scoping — Cannot Be Bypassed

### Verification

| Attack | Code path | Result |
|--------|-----------|--------|
| Judge sends `judge:comm:ack` with `messageId` from another pad | L711: `msgs = channels[padId]` where `padId` = `socket.data.padId` (server-set). Search only in judge's pad. | ✓ Blocked |
| Judge sets `socket.data.padId` directly | Client cannot set `socket.data`; only server sets it in `comm:joinPad` L628. | ✓ Blocked |
| Judge joins pad 1, sends ack for pad 2 message | `channels[1]` does not contain pad 2 messages. `msg = undefined`. | ✓ Blocked |
| Judge sends `messageId` that doesn't exist | `msgs.find()` returns undefined. `if (!msg) return`. | ✓ Blocked |

**padId source:** `socket.data.padId` is set only in `comm:joinPad` (L608-609) from `payload.padId`, validated by `getPadById(padId)`. Judge can only join existing pads. ✓

---

## Section 5: Broadcast Object Reference Sharing

### Code (socket.ts L748-754)

```ts
const msg: ChatMessage = { id: uid(), ts: Date.now(), from: "ADMIN", text: `📣 BROADCAST: ${text}` };
for (const pid of padIds) {
  cur.push(msg);  // SAME object
  ...
}
```

**Today:** Broadcast messages have no `urgent`. `judge:comm:ack` requires `msg.urgent`. Auto-ack requires `m.urgent && m.ackedAt == null`. No path mutates broadcast `msg`. ✓ Safe today.

**Future risk:** If broadcast messages gain `urgent`, acking one would mutate the shared object and affect all pads. **Mitigation:** Use `{ ...msg }` per pad when/if broadcast supports urgent.

---

## Section 6: Break Scenarios

### Rapid admin sends

- 10× `admin:comm:send` in 100ms → first schedules, rest early-return. Single write at t=1000ms. ✓

### Ack + reply race

- Sequential processing. Reply-first: ack sees `ackedAt != null`. Ack-first: reply finds no unacked urgent. ✓

### Restart between urgent and ack

- Crash before debounced save → data loss. Inherent to throttle. ✓ Documented risk.

### Judge acks without joining

- `socket.data.padId` undefined → `!Number.isFinite(padId)` → return. ✓

### Admin sends urgent via judge:comm:send

- Handler ignores `payload.urgent`; builds `{ from: "JUDGE", text }` only. ✓

---

## Additional Issues (Not in Original Review)

**Issue E:** `loadCommChannelsIfNeeded` (L105-107) uses `Object.entries(loaded)` — keys are strings. `Math.floor(Number(k))` for `k="1"` works. For `k="1.9"` → padId 1. Overwrites channels[1] if both "1" and "1.9" exist. Unlikely. Low risk.

**Issue F:** No `data/` directory existence check before load. `fs.existsSync(filePath)` handles missing file. ✓

**Issue G:** `comm:joinPad` accepts `payload.padId` from client. Malicious judge could join pad 99 (if it exists) to view/ack that pad. By design — judges can switch pads. Pad existence validated. ✓

**Issue H:** `formatHhmm` in admin/judge has try/catch. `new Date(NaN).toLocaleTimeString()` does not throw; returns "Invalid Date". Display bug, not crash. Defensive `!Number.isFinite(ts) ? "" : ...` would help.

---

## PASS/FAIL Summary

| Section | Result | Notes |
|---------|--------|-------|
| 1. Persistence scheduling | **PASS** | All message mutations schedule persist |
| 2. Throttle vs debounce | **PASS** | Throttle; matches "at most once per second" |
| 3. Load sanitization | **FAIL** | ts/ackedAt/urgent need hardening for NaN and coercion |
| 4. Pad scoping | **PASS** | Server enforces; client cannot bypass |
| 5. Broadcast sharing | **PASS** | Safe today; document future risk |
| 6. Break scenarios | **PASS** | All scenarios behave correctly |

---

## Minimal Hardening Patch List

1. **lib/commPersistence.ts** — Load sanitization:
   - Filter messages where `!Number.isFinite(Number(m.ts))` or clamp ts to `Date.now()`.
   - `ackedAt`: use `m.ackedAt != null && Number.isFinite(Number(m.ackedAt)) ? Number(m.ackedAt) : undefined`.
   - `urgent`: use `m.urgent === true` (strict) to avoid `Boolean("false")` = true.

2. **lib/commPersistence.ts** — Atomic write:
   - Write to `filePath + '.tmp'`, then `fs.renameSync(tmpPath, filePath)` to avoid partial file on crash.

3. **lib/commPersistence.ts** — Comment fix:
   - Change "debounced" to "throttled" in L3 and JSDoc.

4. **pages/admin.tsx, pages/judge.tsx** — `formatHhmm`:
   - Add `if (!Number.isFinite(ts)) return "";` at start.

5. **pages/api/socket.ts** — Broadcast hardening (future-proof):
   - Add comment: "Broadcast msg is shared across pads; do not add urgent/ackedAt to broadcast."

---

## Must-Add Tests (8+)

1. **Persistence:** Send message → wait 1.1s → restart server → assert message in `comm_state.json` and in UI.
2. **Crash before save:** Mock `scheduleCommSave` to never fire; send message; restart → assert message lost.
3. **Load with NaN ts:** Create `comm_state.json` with `"ts": NaN` → load → assert message filtered or ts sanitized; no crash.
4. **Load with invalid ackedAt:** `"ackedAt": "x"` → assert ackedAt becomes undefined (unacked).
5. **Load with urgent: "false":** Assert message not treated as urgent (strict check).
6. **Pad scoping:** Judge on pad 1; send `judge:comm:ack` with messageId from pad 2 → assert no ack.
7. **Malicious payload:** Public socket emits `admin:comm:send` with `urgent: true` → assert rejected (role check).
8. **Broadcast shared ref:** Push broadcast to pads 1,2; assert object reference equality; assert no mutation path.
9. **Rapid sends:** 20 admin sends in 200ms → assert single write (check file mtime or mock).
10. **Ack + reply race:** Simulate both events; assert exactly one ack, no double-ack.
