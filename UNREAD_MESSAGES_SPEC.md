# Unread Message Awareness — Admin Ops Chat

## Overview

The Admin Ops Chat / Pad Channels UI includes unread message awareness so admins can see when judges have sent messages across many pads without opening each thread. Messages are marked **read** only when they are scrolled into view (≥60% visibility) in the message viewport—not on click.

## Rules

### Unread Definition

- Only messages **from JUDGE** (incoming to admin) count toward unread.
- A pad has unread messages if there exists a judge message with `ts > lastReadTs[padId]`.
- `lastReadTs[padId]` advances **only** when the newest unread judge message has been scrolled into view inside the message panel.

### Read Marking

- `lastReadTs[padId]` is updated when a judge message intersects the viewport at ≥60% visibility (IntersectionObserver, threshold 0.6).
- If the admin never scrolls down, unread remains unread.
- When the admin is viewing a pad thread and is already scrolled to the bottom, new incoming judge messages become read immediately when they appear (they are visible and intersect).

### Urgent Messages

- Urgent messages (`urgent === true` and not `ackedAt`) get stronger visual treatment:
  - Red badge with "!" in the pad list
  - Red toast notification
  - Row highlight in pad list
- Urgent unread clears only when the message is scrolled into view (same rule as normal unread).

## State (Client-Side)

| State | Type | Purpose |
|-------|------|---------|
| `lastReadTsByPad` | `Record<number, number>` | Per-pad timestamp of the highest-seen judge message |
| `lastJudgeMsgTsByPad` | `Record<number, number>` | Tracks latest judge message ts per pad for "new message" detection |
| `toast` | `{ open, text, kind, padId? }` | Toast notification with auto-dismiss (4s) |
| `commActiveTab` | `"inbox" \| "pads"` | Tab selection above pad list |
| `commSortMode` | `"unreadFirst" \| "recent" \| "padNumber"` | Sort order for pad list |

## Derived Data (useMemo)

- `unreadCountByPad`: Count of unread judge messages per pad
- `hasUrgentUnreadByPad`: True if any unread judge message has `urgent && !ackedAt`
- `totalUnread`: Sum of all unread counts
- `lastMsgTsByPad`, `lastSnippetByPad`: For inbox preview and sorting
- `sortedChannelsForList`: Channels sorted by `commSortMode`

## UI Components

### Global Unread Count

- Shown in Ops Chat header: `Unread: N` (only when `totalUnread > 0`)

### Pad List

- Unread badge (count or "!" for urgent) on each pad
- Subtle red highlight for unread pads
- Inbox tab: pad name, unread badge, last message snippet (1 line), timestamp
- Pads tab: pad name, unread badge, message count
- Sort dropdown: Unread first (default), Most recent, Pad #

### Toast

- Fixed top-right, auto-dismiss 4s
- "New message from Pad X" (info) or "Urgent message from Pad X" (urgent)
- "View" button switches to that pad thread

### IntersectionObserver

- Root: message viewport div (`chatViewportRef`)
- Threshold: 0.6 (60% visibility)
- Observes only judge messages in the currently selected pad
- Cleans up on pad switch, message list change, or unmount

## Testing Checklist

1. **Two pads, judge message to non-selected pad**
   - Badge increments on that pad
   - Toast appears ("New message from Pad X")
   - "View" switches to that pad

2. **Switch to pad but do NOT scroll**
   - Message remains unread (badge still shows)

3. **Scroll until message is visible (≥60% in viewport)**
   - Unread clears, badge disappears

4. **Already scrolled to bottom, new incoming message**
   - Message appears visible
   - Immediately marked read (intersects on render)

5. **Urgent message**
   - Urgent toast (red) + "!" badge
   - Clears only when scrolled into view

6. **No regressions**
   - Existing chat, broadcast, urgent, persistence, admin tools all still work

## Constraints

- No changes to socket event names, payload schemas, or server persistence
- No removal of existing UI sections
- Sort mode does not lose original ordering option (user can switch to Pad #)
- All new state is client-side; read-state does not break `comm_state.json`
