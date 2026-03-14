// lib/state.ts

export type Division = "Jr" | "Sr";

export type Team = {
  id: string;
  name: string;
  unit?: string; // brigade/unit/org
  division?: Division; // "Jr" | "Sr"
  category?: string; // event/category
  tag?: "SKIPPED" | string; // allow DNS/DQ/MANUAL etc via string
};

export type PadStatus = "IDLE" | "REPORTING" | "ON_PAD" | "RUNNING" | "HOLD" | "BREAK";

export type ScheduleType = "COMPETE" | "BREAK" | "LUNCH" | "CEREMONY" | "OTHER";
export type ScheduleScope = "GLOBAL" | "PAD";

export type ScheduleEvent = {
  id: string;
  title: string;
  type: ScheduleType;
  scope: ScheduleScope;
  padIds?: number[]; // if scope === "PAD"
  startAt: number;
  endAt: number;
  notes?: string;
  affectedCategories?: string[]; // optional
  createdAt?: number;
  updatedAt?: number;
};

export type Pad = {
  /** Unique stable ID (dynamic system; not fixed 1..8) */
  id: number;

  /** Human-friendly name ("Pad 1", "Classroom A", "Station 3") */
  name: string;

  /** Category/label shown on UI ("Exhibition (Jr)", "Room 204", etc.) */
  label: string;

  now: Team | null;
  onDeck: Team | null;
  standby: Team[];

  note: string;

  // arrival & pacing
  nowArrivedAt: number | null;
  nowArrivedTeamId: string | null;

  // completes
  lastCompleteAt: number | null;

  // reporting window
  reportByDeadlineAt: number | null;
  reportByTeamId: string | null;

  // pad state + break + run clock
  status?: PadStatus;
  breakUntilAt?: number | null;
  breakReason?: string | null;

  // optional scheduled local break support (future)
  breakStartAt?: number | null;

  runStartedAt?: number | null;
  lastRunEndedAt?: number | null;

  // optional per-pad message (admin)
  message?: string | null;
  messageUntilAt?: number | null;

  updatedAt: number;
};

export type CycleStats = {
  count: number;
  avgSec: number; // rolling avg
  lastSec?: number;
  updatedAt: number;
};

export type EventStatus = "PLANNING" | "LIVE";

export type BoardState = {

  eventHeaderLabel?: string;

  /** Event lifecycle: PLANNING = no report timers; LIVE = competition running */
  eventStatus?: EventStatus;
  /** Scheduled start time (ms UTC) or null; when set and now >= this, can auto-transition to LIVE */
  eventStartAt?: number | null;
  /** When LIVE, pause freezes competition clocks */
  eventPaused?: boolean;
  eventPausedAt?: number | null;
  eventPausedAccumMs?: number;

  /** Dynamic list of competition areas (pads/classrooms/training stations/etc.) */
  pads: Pad[];

  /** Used by the server to safely allocate new pad IDs */
  nextPadId: number;

  updatedAt: number;

  // ===== Global break/message (Admin) =====
  globalBreakStartAt?: number | null;
  globalBreakUntilAt?: number | null;
  globalBreakReason?: string | null;

  globalMessage?: string | null;
  globalMessageUntilAt?: number | null;

  // ===== Schedule v1 =====
  schedule?: ScheduleEvent[];
  scheduleUpdatedAt?: number;

  // ===== Soft ETA model =====
  cycleStatsByPad?: Record<number, CycleStats>;
  cycleStatsByKey?: Record<string, CycleStats>;
  avgCycleSecondsByPad?: Record<number, number>;
};

/**
 * Create a new pad/area with safe defaults.
 * Server uses this when Admin adds an area.
 */
export function createPad(params: {
  id: number;
  nowMs: number;
  name?: string;
  label?: string;
  seedDemoTeams?: boolean;
}): Pad {
  const { id, nowMs, name, label, seedDemoTeams } = params;

  const demoNow: Team | null = seedDemoTeams ? { id: `T${id}-1`, name: `Team ${id}-1` } : null;
  const demoOnDeck: Team | null = seedDemoTeams ? { id: `T${id}-2`, name: `Team ${id}-2` } : null;

  const initialStatus: PadStatus = demoNow ? "REPORTING" : "IDLE";

  return {
    id,
    name: name ?? `Area ${id}`,
    label: label ?? `Area ${id}`,

    now: demoNow,
    onDeck: demoOnDeck,
    standby: [],

    note: "",

    nowArrivedAt: null,
    nowArrivedTeamId: null,

    lastCompleteAt: null,

    reportByDeadlineAt: null,
    reportByTeamId: null,

    status: initialStatus,
    breakUntilAt: null,
    breakReason: null,
    breakStartAt: null,

    runStartedAt: null,
    lastRunEndedAt: null,

    message: null,
    messageUntilAt: null,

    updatedAt: nowMs,
  };
}

/**
 * NEW DEFAULT BOOT STATE
 * - starts with ZERO areas
 * - Admin creates areas manually
 * - roster import (optional) can populate areas later
 */
export function createInitialState(): BoardState {
  
  const now = Date.now();

  return {
    pads: [],
    nextPadId: 1,
    updatedAt: now,

    globalBreakStartAt: null,
    globalBreakUntilAt: null,
    globalBreakReason: null,

    globalMessage: null,
    globalMessageUntilAt: null,

    schedule: [],
    scheduleUpdatedAt: now,

    cycleStatsByPad: {},
    cycleStatsByKey: {},
    avgCycleSecondsByPad: {},

    eventHeaderLabel: "COMPETITION MATRIX",

    eventStatus: "PLANNING",
    eventStartAt: null,
    eventPaused: false,
    eventPausedAt: null,
    eventPausedAccumMs: 0,
  };
}

/**
 * Effective competition time for countdowns/timers.
 * When LIVE and paused: frozen at pause moment.
 * When LIVE and not paused: real time minus accumulated pause duration.
 */
export function getCompetitionNowMs(
  state: BoardState | null,
  realNowMs: number
): number | null {
  if (!state || state.eventStatus !== "LIVE") return null;
  const accum = state.eventPausedAccumMs ?? 0;
  if (state.eventPaused && state.eventPausedAt != null) {
    return state.eventPausedAt - accum;
  }
  return realNowMs - accum;
}
