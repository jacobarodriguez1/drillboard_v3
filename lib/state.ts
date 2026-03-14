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

export type SlotStatus =
  | "PLANNED"
  | "READY"
  | "ON_DECK"
  | "ON_PAD"
  | "COMPLETE"
  | "SCRATCHED"
  | "HELD"
  | "SKIPPED";

export type ScheduleSlot = {
  slotId: string;
  padId: number;
  slotOrder: number;
  teamId: string;
  teamName: string;
  brigade?: string;
  category?: string;
  division?: string;
  anticipatedStart?: string; // "HH:MM" local time estimate
  actualStartMs?: number;    // set by judge:arrived
  actualEndMs?: number;      // set by judge:complete
  status: SlotStatus;
};

// ---------------------------------------------------------------------------
// Full team roster data — populated from schedule import, used by inspection UI
// ---------------------------------------------------------------------------

export type TeamMember = {
  memberId: string;
  firstName: string;
  lastName: string;
  fullName: string;
  rank: string;
  grade: string;
  gender: string;
  role: string | null;
  notes: string | null;
  status: string;
};

export type TeamDetail = {
  teamId: string;
  teamDisplayName: string;
  brigade?: string;
  brigadeNumber?: number;
  schoolName?: string;
  unitName?: string;
  teamNumber?: number;
  category?: string;
  division?: string;
  members: TeamMember[];
  notes?: string | null;
  warnings?: string[];
  constraints?: string[];
  sourceRowIds?: string[];
};

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

  // ===== Imported competition schedule (from roster_chipper) =====
  scheduledSlots?: ScheduleSlot[];
  scheduleImportedAt?: number;
  scheduleEventName?: string;
  scheduleGeneratedBy?: string;
  /** teamId → full detail (roster, school, brigade, etc.) populated at import time */
  teamDetails?: Record<string, TeamDetail>;

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
    name: name ?? `Pad ${id}`,
    label: label ?? "",

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
 * Derives the current category/division label for a pad.
 *
 * Priority:
 *   A. NOW team's category + division
 *   B. ON DECK team's category + division
 *   C. Next non-terminal scheduled slot for the pad
 *   D. Static pad.label (admin-saved fallback)
 *   E. "" (blank)
 */
export function resolveAreaLabel(pad: Pad, scheduledSlots?: ScheduleSlot[]): string {
  function teamCatDiv(t: Team): string {
    const parts = [t.category, t.division].filter(Boolean);
    return parts.join(" — ");
  }

  // A. NOW team
  if (pad.now) {
    const l = teamCatDiv(pad.now);
    if (l) return l;
  }

  // B. ON DECK team
  if (pad.onDeck) {
    const l = teamCatDiv(pad.onDeck);
    if (l) return l;
  }

  // C. Next scheduled slot (lowest slotOrder, non-terminal)
  if (scheduledSlots) {
    const TERMINAL: SlotStatus[] = ["COMPLETE", "SCRATCHED", "SKIPPED"];
    const next = scheduledSlots
      .filter((s) => s.padId === pad.id && !TERMINAL.includes(s.status))
      .sort((a, b) => a.slotOrder - b.slotOrder)[0];
    if (next) {
      const parts = [next.category, next.division].filter(Boolean);
      const l = parts.join(" — ");
      if (l) return l;
    }
  }

  // D. Static pad label
  const staticLabel = String(pad.label ?? "").trim();
  if (staticLabel) return staticLabel;

  // E. Blank
  return "";
}

/**
 * Resolves a full TeamDetail for a queue Team entry using multiple strategies:
 *   1. Direct lookup in state.teamDetails by team.id
 *   2. Bridge via state.scheduledSlots — finds matching slot, then looks up teamDetails
 *   3. Scan teamDetails values by display name (covers any residual ID mismatch)
 *   4. Minimal fallback built from the queue Team object (members: [])
 *
 * Never returns null — always returns at minimum a minimal object so the
 * inspection panel can open.
 */
export function resolveTeamDetail(team: Team, state: BoardState | null): TeamDetail {
  if (state) {
    // 1. Direct: team.id is set by slotToTeam → sl.teamId, same value keyed in teamDetails
    const direct = state.teamDetails?.[team.id];
    if (direct) return direct;

    // 2. Bridge via scheduledSlots in case there's any indirect lookup needed
    if (state.scheduledSlots) {
      const slot = state.scheduledSlots.find((sl) => sl.teamId === team.id);
      if (slot) {
        const viaSlot = state.teamDetails?.[slot.teamId];
        if (viaSlot) return viaSlot;
      }
    }

    // 3. Name-based scan as last-resort fallback (handles any ID transformation edge cases)
    if (state.teamDetails && team.name) {
      const match = Object.values(state.teamDetails).find(
        (d) => d.teamDisplayName === team.name,
      );
      if (match) return match;
    }
  }

  // 4. Minimal fallback — shows metadata but no roster
  return {
    teamId: team.id,
    teamDisplayName: team.name,
    category: team.category,
    division: team.division ?? undefined,
    brigade: team.unit,
    members: [],
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
