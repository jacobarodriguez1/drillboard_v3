# Judge Area Gating — Implementation Note

## Summary

Judges share the same login. To prevent accidental pad switching and cross-pad actions, the UI enforces "first selection is immediate, all changes require confirmation," and the server gates all judge pad actions by `socket.data.assignedPadId`.

## Client (Judge UI)

- **State:** `lockedPadId`, `pendingPadId`, `showConfirmChangeArea`
- **Persistence:** `localStorage` key `cacc_judge_pad`
- **First selection:** Clicking a pad when `lockedPadId === null` immediately assigns, persists, and emits `judge:area:set`
- **Change selection:** Clicking a different pad opens confirmation modal; Cancel keeps current, Confirm updates and re-emits
- **Reconnect:** On socket connect, client re-emits `judge:area:set` with stored `lockedPadId` so server re-binds

## Server (Socket)

- **Handler:** `judge:area:set` — validates `padId`, sets `socket.data.assignedPadId`, logs `JUDGE_AREA_CHANGE` in audit when pad changes
- **Gate helper:** `judgePadGate(socket, payload)` — returns `padId` if allowed, `null` if rejected; emits `judge:error` on reject

## Gated Judge Events

| Event | Gated by `assignedPadId` |
|-------|--------------------------|
| `judge:complete` | ✓ |
| `judge:hold` | ✓ |
| `judge:dns` | ✓ |
| `judge:dq` | ✓ |
| `judge:undo` | ✓ |
| `judge:arrived` | ✓ |
| `judge:swap` | ✓ |
| `judge:skipNow` | ✓ |
| `judge:clear` | ✓ |
| `judge:startBreak` | ✓ |
| `judge:endBreak` | ✓ |
| `judge:addTeam` | ✓ |
| `judge:setPadLabel` | ✓ |
| `judge:comm:send` | ✓ (uses `assignedPadId` instead of `padId`) |
| `judge:comm:ack` | ✓ (uses `assignedPadId` instead of `padId`) |
| `comm:joinPad` | ✓ (judge can only join `assignedPadId`) |
| `comm:presence` | ✓ (judge can only send presence for `assignedPadId`) |

## Rejection Behavior

- If `assignedPadId` is null: reject with "No judging area selected"
- If `targetPadId !== assignedPadId`: reject with "Action not permitted for this area"
- Server logs rejections; client receives `judge:error` event (optional to display)
