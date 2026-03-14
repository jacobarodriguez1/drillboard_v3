# Event Start Gate

## Overview

The Event Start Gate prevents competition clocks (report timers, break countdowns, on-pad timers) from starting when the roster is loaded. Admins can load or import rosters days, weeks, or months in advance without triggering any report deadlines.

## Event Lifecycle

| Status   | Meaning                                                                 |
|----------|-------------------------------------------------------------------------|
| PLANNING | Roster can be loaded and configured. No report timers or deadlines.     |
| LIVE     | Competition is running. Report timers and countdowns behave as normal.  |

## How to Start Now

1. In Admin Console, find the **Event Status** section.
2. Click **Start Now**.
3. Confirm in the modal ("Start Competition Now?").
4. The event immediately transitions to LIVE. Report timers are created for any pads that have a team in the NOW slot and meet the usual conditions.

## Pause / Resume (LIVE only)

When the event is LIVE:

- **Pause Event**: Freezes all competition clocks (report timers, on-pad timers, break countdowns).
- **Resume Event**: Continues clocks from the frozen state with no time jump.

See [EVENT_PAUSE.md](./EVENT_PAUSE.md) for details.

## Expected UI Behavior

### PLANNING Mode

- **Judge**: Report countdown shows "—". Local break countdown shows "—". On-pad timer shows "—". Status pill shows "PLANNING" when no active timers.
- **Public**: No REPORT, BREAK_ACTIVE, or ONPAD banners with countdowns. Pads show queue (NOW/ONDECK/STANDBY) but no timers.
- **Admin**: Pad status shows IDLE (no reportByDeadlineAt). Event Status chip shows "PLANNING".

### LIVE Mode

- **Judge**: Report countdown, break countdown, and on-pad timer display as before.
- **Public**: REPORT, BREAK_ACTIVE, ONPAD banners with countdowns display as before.
- **Admin**: Event Status chip shows "LIVE".

## Roster Load Behavior

- When Admin loads or reloads roster (Reload Roster, Import Roster), the event is set to **PLANNING** unless it was already **LIVE**.
- If the event was LIVE and Admin reloads roster, it stays LIVE (no silent flip to PLANNING).
- Report timers are never auto-created in PLANNING. They are created only when the event becomes LIVE (via Start Now or scheduled auto-start).

## Socket Events (Additive)

| Event                     | Payload              | Behavior                                      |
|---------------------------|----------------------|-----------------------------------------------|
| admin:event:scheduleStart | { startAt?: number } | Set eventStartAt; keep PLANNING (server-only) |
| admin:event:startNow      | {}                   | Set LIVE, eventStartAt = now; run sanitize    |
| admin:event:setPlanning  | {}                   | Set PLANNING; clear report deadlines (server-only) |
| admin:event:pause         | {}                   | Freeze competition clocks (LIVE only)         |
| admin:event:resume        | {}                   | Resume clocks from frozen state               |

Note: Schedule Start and Set Planning are not exposed in the Admin UI but remain available for server/future use.

## Backward Compatibility

- If `eventStatus` is missing from state, it defaults to `"PLANNING"`.
- If `eventStartAt` is missing, it defaults to `null`.
- Existing socket events and API routes are unchanged.
