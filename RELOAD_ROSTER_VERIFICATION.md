# Reload Roster – Verification Checklist

## Root Cause (Exact)

**File:** `lib/roster.ts` line 12 (before fix)

```ts
return path.join(process.cwd(), "data", "drillTeamsRoster_2026.csv");
```

- On Fly: `process.cwd()` = `/app` → path = `/app/data/drillTeamsRoster_2026.csv`
- **Dockerfile** runner stage: copies only `package.json`, `public`, `.next`, `node_modules` — **does NOT copy `data/`**
- Result: `/app/data/drillTeamsRoster_2026.csv` **does not exist** in the container
- `fs.existsSync(filePath)` returns `false` → `buildStateFromRosterCsv()` returns `null`
- No exception; roster simply fails to load silently

## Patch Summary

1. **`lib/dataPath.ts`** (new): Shared `getDataDir()` — production `/data`, local `./data`
2. **`lib/roster.ts`**: `getRosterPath()` uses `getDataDir()`, prefers `/data`, fallback to `/app/data` (baked-in)
3. **`lib/commPersistence.ts`**: Uses `getDataDir()` instead of inline logic
4. **Dockerfile**: `COPY --from=builder /app/data ./data` — roster file in image
5. **`pages/api/socket.ts`**: `admin:reloadRoster` accepts ack callback; `doLoadRoster` sends `{ ok, error, detail }`
6. **`pages/admin.tsx`**: Reload button uses callback; shows success/error toast

## Verification

### Localhost

1. [ ] `npm run dev`, open http://localhost:3000/admin
2. [ ] Log in, confirm "LIVE"
3. [ ] Click "Reload Roster"
4. [ ] Verify success toast: "Roster reloaded."
5. [ ] Verify board shows teams from `data/drillTeamsRoster_2026.csv`
6. [ ] Restart server, reload page — roster still loaded (in-memory; persists until restart)

### Fly.io

1. [ ] Deploy: `fly deploy`
2. [ ] Open https://&lt;app&gt;.fly.dev/admin, log in
3. [ ] Click "Reload Roster"
4. [ ] Verify success toast: "Roster reloaded."
5. [ ] Verify board shows teams from baked-in roster
6. [ ] Restart machine: `fly machine restart` — roster still loads (from /app/data in image)

### Custom Roster on Fly

To use a custom roster at runtime:

1. Place `drillTeamsRoster_2026.csv` in `/data` (e.g. via `fly ssh console` then `ls /data`)
2. Or set `ROSTER_CSV_PATH=/data/drillTeamsRoster_2026.csv` in Fly secrets
3. Reload Roster will prefer `/data` over `/app/data`
