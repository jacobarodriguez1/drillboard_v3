# EVENT_RESET Manual Test Checklist

Use this checklist to verify the "Start New Event" admin reset feature works correctly.

## Prerequisites

- Admin logged in at `/admin`
- Server running (`npm run dev` or equivalent)
- At least one pad/area with some state (chat messages, queue entries, audit entries)

---

## 1. Reset with default scope clears chat and persists

- [ ] Add some messages to Ops Chat (pad channels)
- [ ] Click **Start New Event**
- [ ] Leave defaults: Clear Ops Chat (checked, disabled), Clear Audit Log (checked), Reset Queues (unchecked), Reset Event Header Label (unchecked)
- [ ] Click **Start New Event** in the modal
- [ ] Verify: Ops Chat is empty for all pads
- [ ] Verify: Success toast appears: "New event started. Ops Chat cleared."
- [ ] **Restart the server** (stop and start `npm run dev`)
- [ ] Reload the admin page
- [ ] Verify: Ops Chat is still empty (persisted to disk)

---

## 2. Reset with resetQueues clears NOW/ONDECK/STANDBY but preserves pads

- [ ] Ensure at least one pad has teams in NOW, ON DECK, or STANDBY
- [ ] Note the pad names/labels (e.g. "Pad 1", "Area 2")
- [ ] Click **Start New Event**
- [ ] Check **Reset Queues**
- [ ] Click **Start New Event** in the modal
- [ ] Verify: All pads still exist (same names, same count)
- [ ] Verify: NOW, ON DECK, and STANDBY are empty for every pad
- [ ] Verify: Pad status is IDLE

---

## 3. Non-admin cannot trigger reset (server rejects)

- [ ] Open Judge view (`/judge`) or Public view (`/public`) in another tab
- [ ] Or use browser dev tools to emit `admin:event:reset` from a non-admin socket
- [ ] Verify: Server does not process the reset (chat/queues unchanged)
- [ ] Note: Admin page is the only UI that shows the button; server enforces `role === "admin"`

---

## 4. Admin triggers reset and all connected clients refresh

- [ ] Open Admin in Tab A, Judge in Tab B, Public in Tab C (all connected)
- [ ] Add chat messages and/or queue entries
- [ ] From Admin (Tab A), click **Start New Event** and confirm
- [ ] Verify: Admin chat panel updates immediately (empty)
- [ ] Verify: Judge view reflects empty chat / updated state
- [ ] Verify: Public view reflects updated board state (if queues were reset)

---

## 5. Reset Header Label option

- [ ] Set a custom event header label (e.g. "Regionals 2025")
- [ ] Click **Start New Event**
- [ ] Leave **Reset Event Header Label** unchecked
- [ ] Confirm reset
- [ ] Verify: Header label remains "Regionals 2025"
- [ ] Click **Start New Event** again
- [ ] Check **Reset Event Header Label**
- [ ] Confirm reset
- [ ] Verify: Header label is now "COMPETITION MATRIX"

---

## 6. Clear Audit Log option

- [ ] Perform some actions to generate audit entries
- [ ] Click **Start New Event** with **Clear Audit Log** checked
- [ ] Confirm reset
- [ ] Verify: Audit log shows only one entry: `EVENT_RESET` with scope detail
- [ ] Perform more actions, then reset with **Clear Audit Log** unchecked
- [ ] Verify: Previous audit entries remain; new EVENT_RESET entry appended
