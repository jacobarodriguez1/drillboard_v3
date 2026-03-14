# Ops Chat: Persistence + Urgent Messages — Test Checklist

## Commit 1: Persistence

- [ ] **Load on start**: Restart server; verify existing messages in `data/comm_state.json` appear in Admin and Judge UIs
- [ ] **Save on send**: Send a message from Admin; wait 1+ second; stop server; restart; verify message persists
- [ ] **Save on broadcast**: Broadcast to ALL or PAD; wait 1+ second; restart server; verify broadcast message persists
- [ ] **Debounce**: Send 5 messages rapidly; verify only one write occurs (check file mtime or add temporary log)
- [ ] **No presence**: Verify `data/comm_state.json` contains only `channels` (padId → messages), no online/offline data

## Commit 2: Urgent Messages

- [ ] **Admin send urgent**: Admin checks "Urgent", sends message; Judge sees message with "⚠ Urgent" label and flashing style
- [ ] **Auto-scroll**: When urgent arrives, Judge chat auto-scrolls so urgent message is in view
- [ ] **Acknowledge button**: Judge sees "Acknowledge" button when unacked urgent exists; clicking updates message to "Acknowledged"
- [ ] **Reply auto-acks**: Judge replies in chat; latest unacked urgent for that pad is auto-acknowledged
- [ ] **Admin sees ack**: After Judge acknowledges, Admin sees "Acknowledged" instead of "Urgent" on the message
- [ ] **Security**: Only admin can send urgent (judge cannot); only judge can acknowledge; judge can only ack urgent for pad they are joined to
- [ ] **Persistence**: Urgent messages and ackedAt persist across server restarts
