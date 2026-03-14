# Event Pause / Resume

## Overview

When an event is LIVE, admins can **Pause** to freeze all competition clocks (report timers, on-pad timers, break countdowns). **Resume** continues clocks from the frozen state with no time jump.

## State Fields (BoardState)

| Field              | Type         | Default | Description                                      |
|--------------------|--------------|---------|--------------------------------------------------|
| eventPaused        | boolean      | false   | When true, competition clocks are frozen        |
| eventPausedAt      | number \| null | null  | Timestamp when pause was triggered               |
| eventPausedAccumMs | number       | 0       | Total accumulated paused duration (ms)          |

## Socket Events

| Event               | Payload | Behavior                                                                 |
|---------------------|---------|---------------------------------------------------------------------------|
| admin:event:pause   | {}      | If LIVE and not paused: set eventPaused=true, eventPausedAt=now           |
| admin:event:resume  | {}      | If LIVE and paused: add delta to eventPausedAccumMs, clear eventPaused    |

## Effective Competition Time

The UI uses `getCompetitionNowMs(state, realNowMs)` for all competition-related countdowns:

- When **LIVE and paused**: returns `eventPausedAt - eventPausedAccumMs` (frozen)
- When **LIVE and not paused**: returns `realNowMs - eventPausedAccumMs`
- When **PLANNING**: returns `null` (no competition timers)

This ensures report countdowns, on-pad timers, and break countdowns freeze during pause and resume without jumping.

## Admin UI

| Event Status | Button Shown    |
|--------------|-----------------|
| PLANNING     | Start Now       |
| LIVE, !paused| Pause Event     |
| LIVE, paused | Resume Event    |

- **Start Now**: Opens confirmation modal before starting.
- **Pause / Resume**: No modal; small toast on success.

## Test Checklist

1. **Start Now → LIVE**
   - Click Start Now, confirm in modal.
   - Event Status chip shows LIVE.
   - Report countdown (if applicable) begins ticking.

2. **Let report countdown tick ~10s**
   - Observe countdown decreasing.

3. **Pause → countdown stops**
   - Click Pause Event.
   - Countdown freezes at current value.
   - Toast: "Competition paused."

4. **Wait 30s real time**
   - Countdown remains frozen.

5. **Resume → countdown continues (no jump)**
   - Click Resume Event.
   - Countdown continues from where it left off (no 30s jump).
   - Toast: "Competition resumed."

6. **Same behavior for on-pad timer and break timers**
   - On-pad: Mark team arrived, observe timer. Pause → freeze. Resume → continues.
   - Break: Start area break, observe countdown. Pause → freeze. Resume → continues.
