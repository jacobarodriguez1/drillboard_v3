# Start New Event – Fly.io Debug Guide

## Code Path (Start New Event)

| Step | Location | Action |
|------|----------|--------|
| 1 | `pages/admin.tsx` | User clicks "Start New Event" in modal → `doStartNewEvent()` |
| 2 | `pages/admin.tsx` | `socket.emit("admin:event:reset", payload, callback)` |
| 3 | `lib/socketClient.ts` | Socket connects via `io({ path: "/api/socket/io" })` – no hardcoded URL |
| 4 | `pages/api/socket.ts` | Handler `socket.on("admin:event:reset", ...)` |
| 5 | `pages/api/socket.ts` | Calls `scheduleCommPersist()` → `lib/commPersistence.ts` `scheduleCommSave()` |
| 6 | `lib/commPersistence.ts` | Writes to `getCommStatePath()` → `/data/comm_state.json` in production |

## Likely Failure Causes on Fly

1. **Auth rejection (most likely)**  
   - Handler checks `(socket as any).data?.role !== "admin"` and returns early.  
   - Role comes from cookies (`cacc_role`, `cacc_admin`) in the Socket.IO handshake.  
   - If `SESSION_SECRET` is missing in Fly secrets, `verifyRoleCookie` throws and the socket connection fails.  
   - If cookies are not sent (e.g. cross-origin, wrong domain), role is `"public"` and reset is rejected.

2. **Comm persist path**  
   - Production uses `/data` (Fly volume).  
   - `lib/commPersistence.ts` already uses `NODE_ENV === "production" ? "/data" : "./data"`.  
   - `scheduleCommSave` uses `fs.mkdirSync(dir, { recursive: true })` before writing.

3. **Socket not connected**  
   - If status shows "CONNECTING" instead of "LIVE", the socket never connects.  
   - Possible causes: WebSocket upgrade failure, `SESSION_SECRET` missing (auth throws), CORS.

## Patch Summary

### 1. Server (`pages/api/socket.ts`)

- Add acknowledgment callback: `socket.on("admin:event:reset", (payload, ack) => { ... })`
- On success: `ack({ ok: true })`
- On failure: `ack({ ok: false, error: "..." })` for:
  - Not admin
  - No board state
  - Any thrown error
- Add logging: `[admin:event:reset] Rejected: not admin` and `[admin:event:reset] OK scope=...`

### 2. Client (`pages/admin.tsx`)

- Use `socket.emit("admin:event:reset", payload, callback)` with callback
- On `ack.ok`: show success toast
- On `!ack.ok`: show error toast with `ack.error`
- Add 10s timeout: if no ack, show "No response from server"
- Add `connect_error` listener for socket issues

### 3. No Fly Config Changes Required

- Volume at `/data` is already configured in `fly.toml`
- `COMM_STATE_PATH` can override path if needed (e.g. `COMM_STATE_PATH=/data/comm_state.json`)

## Required Fly Secrets

```bash
fly secrets set SESSION_SECRET="your-min-16-char-secret"
fly secrets set ADMIN_PASSWORD="your-admin-password"
```

`SESSION_SECRET` is required in production; without it, auth fails and socket connections fail.

## Verification Checklist

### Localhost

1. [ ] `npm run dev`, open http://localhost:3000/admin
2. [ ] Log in, confirm status shows "LIVE"
3. [ ] Add chat messages in Ops Chat
4. [ ] Click "Start New Event" → confirm modal → "Start New Event"
5. [ ] Verify success toast and chat cleared
6. [ ] Restart server, reload page – chat still empty (persisted)
7. [ ] Open DevTools → Console: no errors
8. [ ] Test error path: stop server, click Start New Event – error toast after ~10s

### Fly.io

1. [ ] Deploy: `fly deploy`
2. [ ] Confirm secrets: `fly secrets list` (SESSION_SECRET, ADMIN_PASSWORD)
3. [ ] Open https://&lt;app&gt;.fly.dev/admin
4. [ ] Log in, confirm status shows "LIVE"
5. [ ] Add chat messages
6. [ ] Click "Start New Event" → confirm
7. [ ] Verify success toast and chat cleared
8. [ ] If error toast appears, note the message (e.g. "Not authorized")
9. [ ] Collect logs: `fly logs`
   - Look for `[admin:event:reset] Rejected: not admin` (auth failure)
   - Look for `[admin:event:reset] OK scope=` (success)
   - Look for `[admin:event:reset] Error:` (exception)
   - Look for `[comm] Persist error:` (filesystem write failure)

### If It Still Fails on Fly

1. Run `fly logs` and search for `admin:event:reset` or `comm`
2. If "Not authorized": check `SESSION_SECRET` and that you are logged in
3. If "No response": socket may not be connected; check for "LIVE" vs "CONNECTING"
4. If persist error: check volume mount and permissions with `fly ssh console` then `ls -la /data`
