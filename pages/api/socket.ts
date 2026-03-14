// pages/api/socket.ts
export const config = { api: { bodyParser: false } };

import type { NextApiRequest, NextApiResponse } from "next";
import { Server as IOServer } from "socket.io";

import type { BoardState, Pad, Team, PadStatus, ScheduleEvent, CycleStats, ScheduleSlot, SlotStatus, TeamDetail, TeamMember } from "@/lib/state";
import { createInitialState, createPad, getCompetitionNowMs } from "@/lib/state";
import { buildStateFromRosterCsv, getRosterPath } from "@/lib/roster";
import { parseCookie } from "@/lib/ui";
import { verifyRoleCookie } from "@/lib/auth";
import { loadCommState, scheduleCommSave } from "@/lib/commPersistence";

type NextResWithSocket = NextApiResponse & { socket: any & { server: any } };

type AuditEntry = {
  id: string;
  ts: number;
  padId: number | null;
  action: string;
  detail: string;
};

const REPORT_WINDOW_MS = 5 * 60 * 1000;
const MAX_AUDIT = 800;
const MAX_UNDO_PER_PAD = 35;

// ====== COMM (Admin <-> Judge) ======
type CommRole = "admin" | "judge";

type JudgePresence = {
  socketId: string;
  connectedAt: number;
  lastSeenAt: number;
  padId: number | null;
  name?: string | null;
};

type ChatFrom = "ADMIN" | "JUDGE";
type ChatMessage = {
  id: string;
  ts: number;
  from: ChatFrom;
  text: string;
  urgent?: boolean;
  ackedAt?: number;
};

type PadChannel = {
  padId: number;
  name: string;
  online: boolean;
  messages: ChatMessage[];
};

type CommSnapshot = {
  channels: PadChannel[];
};

const MAX_CHAT_PER_PAD = 220;

const G = globalThis as any;

const FORBIDDEN_KEYS = /^(__proto__|constructor|prototype)$/;

function isPlainObject(obj: unknown): obj is Record<string, unknown> {
  return obj !== null && typeof obj === "object" && Object.getPrototypeOf(obj) === Object.prototype;
}

/** Safe patch: plain object, only allowed keys, no prototype pollution. */
function safePatch(obj: unknown, allowedKeys: string[]): Record<string, unknown> | null {
  if (!obj || typeof obj !== "object") return null;
  if (!isPlainObject(obj)) return null;
  const out: Record<string, unknown> = {};
  for (const k of allowedKeys) {
    if (Object.prototype.hasOwnProperty.call(obj, k) && !FORBIDDEN_KEYS.test(String(k))) {
      out[k] = obj[k];
    }
  }
  return out;
}

function uid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function ensureGlobals() {
  if (!G.boardState) G.boardState = null;
  if (!G.padHistory) G.padHistory = {};
  if (!G.audit) G.audit = [];
  if (typeof G.rosterLoaded !== "boolean") G.rosterLoaded = false;

  // comm (pad-based channels)
  if (!G.commAdmins) G.commAdmins = new Set<string>();
  if (!G.commJudges) G.commJudges = new Map<string, JudgePresence>(); // socketId -> presence (for online tracking)
  if (!G.commChannels) G.commChannels = {} as Record<number, ChatMessage[]>; // padId -> messages
  if (!G.commPadViewers) G.commPadViewers = new Map<number, Set<string>>(); // padId -> socketIds viewing
}

function loadCommChannelsIfNeeded() {
  ensureGlobals();
  if (G.commChannelsLoaded) return;
  const loaded = loadCommState();
  const channels = G.commChannels as Record<number, ChatMessage[]>;
  for (const [k, msgs] of Object.entries(loaded)) {
    const id = Math.floor(Number(k));
    if (Number.isFinite(id) && id >= 1 && Array.isArray(msgs)) channels[id] = msgs as ChatMessage[];
  }
  G.commChannelsLoaded = true;
}

function scheduleCommPersist() {
  scheduleCommSave(() => (G.commChannels as Record<number, ChatMessage[]>) ?? {});
}

function pushAudit(entry: Omit<AuditEntry, "id">) {
  ensureGlobals();
  G.audit.push({ id: uid(), ...entry });
  if (G.audit.length > MAX_AUDIT) G.audit.splice(0, G.audit.length - MAX_AUDIT);
  if (G.boardState) (G.boardState as any).audit = G.audit;
}

function snapshotForUndo(padId: number) {
  ensureGlobals();
  const key = `__stack_${padId}`;
  const stack: any[] = G.padHistory[key] ?? [];
  stack.push(JSON.parse(JSON.stringify(G.boardState)));
  if (stack.length > MAX_UNDO_PER_PAD) stack.splice(0, stack.length - MAX_UNDO_PER_PAD);
  G.padHistory[key] = stack;
}

function undoForPad(padId: number) {
  ensureGlobals();
  const key = `__stack_${padId}`;
  const stack: any[] = G.padHistory[key] ?? [];
  if (stack.length === 0) return false;
  const prev = stack.pop();
  if (!prev) return false;
  G.boardState = prev;
  return true;
}

/** ---------- PAD RESOLUTION (dynamic) ---------- */
function resolvePadId(payload: any): number | null {
  const v = payload?.padId ?? payload?.id ?? payload?.pad ?? payload;
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.floor(n);
}

function getPadById(padId: number | null | undefined): Pad | null {
  if (padId == null || !Number.isFinite(padId)) return null;
  const s = G.boardState as BoardState | null;
  if (!s?.pads) return null;
  return s.pads.find((p: Pad) => p.id === padId) ?? null;
}

/** Returns true for roles that are allowed to perform judge pad actions. */
function isJudgeRole(role: string | undefined): boolean {
  return role === "judge" || role === "admin";
}

/** Gate judge pad actions: returns padId if allowed, null if rejected. Emits judge:error on reject. */
function judgePadGate(socket: any, payload: any): number | null {
  const sid = socket?.id ?? "?";
  const assigned = socket?.data?.assignedPadId;
  const payloadPadId = payload?.padId ?? payload?.id ?? payload?.pad;

  if (!isJudgeRole((socket as any)?.data?.role)) {
    console.warn("[GATE REJECT]", sid, "role not judge/admin", { role: (socket as any)?.data?.role, assigned, payloadPadId });
    return null;
  }
  if (assigned == null || !Number.isFinite(assigned)) {
    console.warn("[GATE REJECT]", sid, "no judging area selected", { assigned, payloadPadId });
    socket.emit?.("judge:error", { message: "No judging area selected" });
    return null;
  }
  const target = resolvePadId(payload);
  if (target == null) {
    console.warn("[GATE REJECT]", sid, "no padId in payload", { assigned, payloadPadId });
    return null;
  }
  if (target !== assigned) {
    console.warn("[GATE REJECT]", sid, "padId mismatch", { assigned, target, payloadPadId });
    socket.emit?.("judge:error", { message: "Action not permitted for this area" });
    return null;
  }
  return target;
}

function recomputeNextPadId(state: BoardState) {
  const maxId = (state.pads ?? []).reduce((m, p) => Math.max(m, Number(p.id) || 0), 0);
  state.nextPadId = Math.max(state.nextPadId ?? 1, maxId + 1);
}

/** ---------- core helpers ---------- */
function setStatus(pad: Pad, status: PadStatus, nowMs: number) {
  pad.status = status;
  pad.updatedAt = nowMs;
}

function isArrivedForNow(pad: Pad): boolean {
  const nowId = pad.now?.id ?? null;
  return !!pad.nowArrivedAt && !!pad.nowArrivedTeamId && !!nowId && pad.nowArrivedTeamId === nowId;
}

function startReportTimerForNow(pad: Pad, nowMs: number) {
  // Deadline must be in competition-time space, not wall-clock space.
  // effectiveNow on the client = realNow - eventPausedAccumMs.
  // If we store the deadline in wall-clock time but read it against competition
  // time, every accumulated pause minute inflates the displayed countdown by
  // the same amount (e.g. 60-min pause → timer shows 65:00 instead of 5:00).
  const state = G.boardState as BoardState | null;
  const compNowMs = state ? (getCompetitionNowMs(state, nowMs) ?? nowMs) : nowMs;
  const accum = (state as any)?.eventPausedAccumMs ?? 0;

  pad.reportByTeamId = pad.now?.id ?? null;
  pad.reportByDeadlineAt = pad.now ? compNowMs + REPORT_WINDOW_MS : null;

  console.log(
    "[REPORT_TIMER] startReportTimerForNow",
    "pad=", pad.id,
    "team=", pad.now?.name ?? "—",
    "wallNow=", nowMs,
    "compNow=", compNowMs,
    "pausedAccumMs=", accum,
    "deadlineAt=", pad.reportByDeadlineAt,
    "windowSec=", REPORT_WINDOW_MS / 1000,
  );

  setStatus(pad, pad.now ? "REPORTING" : "IDLE", nowMs);
}

function clearArrivalForNow(pad: Pad) {
  pad.nowArrivedAt = null;
  pad.nowArrivedTeamId = null;
  pad.runStartedAt = null;
}

function markArrived(pad: Pad, nowMs: number) {
  pad.nowArrivedAt = nowMs;
  pad.nowArrivedTeamId = pad.now?.id ?? null;

  pad.reportByTeamId = null;
  pad.reportByDeadlineAt = null;

  pad.runStartedAt = nowMs;

  setStatus(pad, "ON_PAD", nowMs);
}

function markNowTeam(pad: Pad, tag: string, nowMs: number) {
  if (!pad.now) return;
  (pad.now as any).tag = tag;
  pad.updatedAt = nowMs;
}

function swapNowOnDeck(pad: Pad, nowMs: number) {
  const tmp = pad.now ?? null;
  pad.now = pad.onDeck ?? null;
  pad.onDeck = tmp;

  pad.breakUntilAt = null;
  pad.breakReason = null;
  pad.breakStartAt = null;

  clearArrivalForNow(pad);
  startReportTimerForNow(pad, nowMs);
}

function skipOnDeck(pad: Pad, nowMs: number) {
  if (!pad.onDeck) return;

  const moved = pad.onDeck;
  (moved as any).tag = "SKIPPED";

  const nextOnDeck = pad.standby.length > 0 ? pad.standby[0] : null;
  const nextStandby = pad.standby.length > 0 ? pad.standby.slice(1) : [];

  pad.onDeck = nextOnDeck;
  pad.standby = [...nextStandby, moved];
  pad.updatedAt = nowMs;
}

/** Skip current NOW team: move to end of standby, promote ON DECK (or standby[0]) to NOW. */
function skipNow(pad: Pad, nowMs: number): boolean {
  if (!pad.now) return false;
  const standby = pad.standby ?? [];
  const promoted = pad.onDeck ?? (standby.length > 0 ? standby[0] : null);
  if (!promoted) return false; // nothing to promote

  const moved = pad.now;
  (moved as any).tag = "SKIPPED";

  let nextOnDeck: Team | null;
  let nextStandby: Team[];
  if (pad.onDeck) {
    nextOnDeck = standby.length > 0 ? standby[0] : null;
    nextStandby = standby.length > 0 ? standby.slice(1) : [];
  } else {
    nextOnDeck = standby.length > 1 ? standby[1] : null;
    nextStandby = standby.length > 1 ? standby.slice(2) : [];
  }

  pad.now = promoted;
  pad.onDeck = nextOnDeck;
  pad.standby = [...nextStandby, moved];
  pad.breakUntilAt = null;
  pad.breakReason = null;
  pad.breakStartAt = null;
  pad.updatedAt = nowMs;

  clearArrivalForNow(pad);
  startReportTimerForNow(pad, nowMs);
  return true;
}

function clearPad(pad: Pad, nowMs: number) {
  pad.now = null;
  pad.onDeck = null;
  pad.standby = [];
  pad.note = "";

  pad.breakUntilAt = null;
  pad.breakReason = null;
  pad.breakStartAt = null;

  clearArrivalForNow(pad);

  pad.lastCompleteAt = null;
  pad.reportByTeamId = null;
  pad.reportByDeadlineAt = null;

  setStatus(pad, "IDLE", nowMs);
}

/** Clear break fields and resume pad into correct state. Used by judge:endBreak and auto-expiry. */
function applyBreakEnded(pad: Pad, nowMs: number) {
  pad.breakUntilAt = null;
  pad.breakReason = null;
  pad.breakStartAt = null;
  pad.note = "";

  if (isArrivedForNow(pad)) {
    pad.reportByTeamId = null;
    pad.reportByDeadlineAt = null;
    setStatus(pad, "ON_PAD", nowMs);
  } else if (pad.now) {
    const nowId = pad.now.id;
    const hasValidDeadline = !!pad.reportByDeadlineAt && !!pad.reportByTeamId && pad.reportByTeamId === nowId;
    if (!hasValidDeadline) startReportTimerForNow(pad, nowMs);
    else setStatus(pad, "REPORTING", nowMs);
  } else {
    pad.reportByTeamId = null;
    pad.reportByDeadlineAt = null;
    setStatus(pad, "IDLE", nowMs);
  }
}

/** ---------- Soft ETA model ---------- */
function updateCycleStats(state: BoardState, pad: Pad, durationSec: number, nowMs: number) {
  if (!state.cycleStatsByPad) state.cycleStatsByPad = {};
  if (!state.cycleStatsByKey) state.cycleStatsByKey = {};

  const d = Math.max(10, Math.min(60 * 30, Math.floor(durationSec)));
  const padId = pad.id;

  state.cycleStatsByPad[padId] = nextStats(state.cycleStatsByPad[padId], d, nowMs);

  const keyA = `pad:${padId}`;
  state.cycleStatsByKey[keyA] = nextStats(state.cycleStatsByKey[keyA], d, nowMs);

  const labelKey = pad.label ? `label:${pad.label}` : null;
  if (labelKey) state.cycleStatsByKey[labelKey] = nextStats(state.cycleStatsByKey[labelKey], d, nowMs);

  const teamCat = pad.now?.category ?? null;
  if (teamCat) {
    const catKey = `cat:${teamCat}`;
    state.cycleStatsByKey[catKey] = nextStats(state.cycleStatsByKey[catKey], d, nowMs);
  }
}

function nextStats(prev: CycleStats | undefined, newSec: number, nowMs: number): CycleStats {
  if (!prev) return { count: 1, avgSec: newSec, lastSec: newSec, updatedAt: nowMs };
  const count = prev.count + 1;
  const avg = (prev.avgSec * prev.count + newSec) / count;
  return { count, avgSec: avg, lastSec: newSec, updatedAt: nowMs };
}

/** ---------- Schedule helpers ---------- */
function normalizeSchedule(s: ScheduleEvent[] | undefined | null): ScheduleEvent[] {
  const list = Array.isArray(s) ? s : [];
  return list
    .filter((e) => e && e.id && e.title && e.startAt && e.endAt)
    .map((e) => ({
      ...e,
      padIds: e.scope === "PAD" ? (e.padIds ?? []) : undefined,
      createdAt: e.createdAt ?? Date.now(),
      updatedAt: e.updatedAt ?? Date.now(),
    }))
    .sort((a, b) => a.startAt - b.startAt);
}

/** ---------- BOOTSTRAP ---------- */
function loadStateIfNeeded() {
  ensureGlobals();
  if (G.boardState) return;
  G.boardState = createInitialState();
  G.rosterLoaded = false;
}

function sanitizeStateAfterAnyLoad(state: BoardState) {
  const nowMs = Date.now();

  state.pads = state.pads ?? [];
  state.nextPadId = state.nextPadId ?? 1;
  recomputeNextPadId(state);

  state.globalBreakStartAt = state.globalBreakStartAt ?? null;
  state.globalBreakUntilAt = state.globalBreakUntilAt ?? null;
  state.globalBreakReason = state.globalBreakReason ?? null;

  state.globalMessage = state.globalMessage ?? null;
  state.globalMessageUntilAt = state.globalMessageUntilAt ?? null;

  (state as any).eventHeaderLabel = (state as any).eventHeaderLabel ?? "COMPETITION MATRIX";

  (state as any).eventStatus = (state as any).eventStatus ?? "PLANNING";
  (state as any).eventStartAt = (state as any).eventStartAt ?? null;
  (state as any).eventPaused = (state as any).eventPaused ?? false;
  (state as any).eventPausedAt = (state as any).eventPausedAt ?? null;
  (state as any).eventPausedAccumMs = (state as any).eventPausedAccumMs ?? 0;

  state.schedule = normalizeSchedule(state.schedule);
  state.scheduleUpdatedAt = state.scheduleUpdatedAt ?? nowMs;

  state.cycleStatsByPad = state.cycleStatsByPad ?? {};
  state.cycleStatsByKey = state.cycleStatsByKey ?? {};
  state.avgCycleSecondsByPad = state.avgCycleSecondsByPad ?? {};

  for (const p of state.pads) {
    (p as any).name = (p as any).name ?? `Area ${p.id}`;
    (p as any).label = (p as any).label ?? "";

    p.status = (p.status ?? (p.now ? "REPORTING" : "IDLE")) as PadStatus;

    p.breakUntilAt = p.breakUntilAt ?? null;
    // Auto-end break when expired (no manual End Break required)
    if (p.breakUntilAt != null && p.breakUntilAt <= nowMs) {
      applyBreakEnded(p, nowMs);
    }
    p.breakReason = p.breakReason ?? null;
    p.breakStartAt = p.breakStartAt ?? null;

    p.runStartedAt = p.runStartedAt ?? null;
    p.lastRunEndedAt = p.lastRunEndedAt ?? null;

    p.message = p.message ?? null;
    p.messageUntilAt = p.messageUntilAt ?? null;

    p.nowArrivedAt = p.nowArrivedAt ?? null;
    p.nowArrivedTeamId = p.nowArrivedTeamId ?? null;

    p.lastCompleteAt = p.lastCompleteAt ?? null;

    p.reportByDeadlineAt = p.reportByDeadlineAt ?? null;
    p.reportByTeamId = p.reportByTeamId ?? null;

    p.updatedAt = p.updatedAt ?? nowMs;

    const breakActive = !!p.breakUntilAt && p.breakUntilAt > nowMs;

    // Only start report timer when event is LIVE; in PLANNING, never auto-start (root cause fix)
    const isLive = (state as any).eventStatus === "LIVE";
    if (isLive && !breakActive && p.now && !p.reportByDeadlineAt && !isArrivedForNow(p)) {
      startReportTimerForNow(p, nowMs);
    }

    if (isArrivedForNow(p)) {
      p.reportByTeamId = null;
      p.reportByDeadlineAt = null;
      p.status = p.status === "RUNNING" ? "RUNNING" : "ON_PAD";
      if (!p.runStartedAt) p.runStartedAt = p.nowArrivedAt;
    }
  }

  state.updatedAt = nowMs;
}

/** ---------- schedule order helpers ---------- */

/** Returns slots for a pad in ascending slotOrder, excluding terminal statuses. */
function getActiveSlotsForPad(state: BoardState, padId: number): ScheduleSlot[] {
  if (!state.scheduledSlots) return [];
  return state.scheduledSlots
    .filter(
      (sl) =>
        sl.padId === padId &&
        sl.status !== "COMPLETE" &&
        sl.status !== "SCRATCHED" &&
        sl.status !== "SKIPPED"
    )
    .sort((a, b) => a.slotOrder - b.slotOrder);
}

/** Converts a ScheduleSlot to a Team for the live queue. */
function slotToTeam(sl: ScheduleSlot): Team {
  return {
    id: sl.teamId,
    name: sl.teamName,
    unit: sl.brigade,
    category: sl.category,
    division: sl.division as any,
  };
}

/**
 * After any queue advancement, re-sorts pad.standby by slotOrder so schedule
 * order is preserved even if manual moves happened. Also promotes to onDeck if empty.
 * No-op when no schedule is imported.
 */
function enforceScheduleOrder(pad: Pad, state: BoardState) {
  if (!state.scheduledSlots || state.scheduledSlots.length === 0) return;

  const activeSlots = getActiveSlotsForPad(state, pad.id);
  if (activeSlots.length === 0) return;

  // Build slotOrder lookup for any team currently in the queue
  const orderMap = new Map<string, number>(activeSlots.map((sl) => [sl.teamId, sl.slotOrder]));

  // Re-sort standby: scheduled teams by slotOrder, then unscheduled at end
  if (pad.standby.length > 1) {
    pad.standby = pad.standby.slice().sort((a, b) => {
      const oa = orderMap.get(a.id) ?? Infinity;
      const ob = orderMap.get(b.id) ?? Infinity;
      return oa - ob;
    });
  }

  // If onDeck is missing but standby has someone, promote them
  if (!pad.onDeck && pad.standby.length > 0) {
    pad.onDeck = pad.standby.shift() ?? null;
  }
}

/** ---------- participant insertion helper ---------- */
function insertTeamIntoPad(pad: Pad, nowMs: number, where: "NOW" | "ONDECK" | "END", team: Team, state?: BoardState) {
  if (where === "NOW") {
    if (pad.onDeck) pad.standby.unshift(pad.onDeck);
    if (pad.now) pad.onDeck = pad.now;
    pad.now = team;
    clearArrivalForNow(pad);
    const isLive = (state ?? G.boardState) && ((state ?? G.boardState) as any).eventStatus === "LIVE";
    if (isLive) startReportTimerForNow(pad, nowMs);
    return;
  }

  if (where === "ONDECK") {
    if (pad.onDeck) pad.standby.unshift(pad.onDeck);
    pad.onDeck = team;
    pad.updatedAt = nowMs;
    return;
  }

  pad.standby.push(team);
  pad.updatedAt = nowMs;
}

function moveItem<T>(arr: T[], from: number, to: number): T[] {
  const a = arr.slice();
  if (from < 0 || from >= a.length) return a;
  const [item] = a.splice(from, 1);
  const clamped = Math.max(0, Math.min(a.length, to));
  a.splice(clamped, 0, item);
  return a;
}

function extractTeamFromPad(pad: Pad, teamId: string): { team: Team | null; from: "NOW" | "ONDECK" | "STANDBY" | null } {
  if (pad.now?.id === teamId) {
    const t = pad.now;
    pad.now = null;
    return { team: t, from: "NOW" };
  }
  if (pad.onDeck?.id === teamId) {
    const t = pad.onDeck;
    pad.onDeck = null;
    return { team: t, from: "ONDECK" };
  }
  const idx = (pad.standby ?? []).findIndex((t) => t.id === teamId);
  if (idx >= 0) {
    const t = pad.standby[idx];
    pad.standby = (pad.standby ?? []).filter((x) => x.id !== teamId);
    return { team: t, from: "STANDBY" };
  }
  return { team: null, from: null };
}

function advanceWithoutComplete(pad: Pad, nowMs: number) {
  const nextNow = pad.onDeck ?? null;
  const nextOnDeck = pad.standby.length > 0 ? pad.standby[0] : null;
  const nextStandby = pad.standby.length > 0 ? pad.standby.slice(1) : [];

  pad.now = nextNow;
  pad.onDeck = nextOnDeck;
  pad.standby = nextStandby;

  clearArrivalForNow(pad);
  pad.breakStartAt = null;
  startReportTimerForNow(pad, nowMs);
}

/** ---------- COMM helpers (pad-based) ---------- */
function ensureChannelsForPads() {
  ensureGlobals();
  const pads = (G.boardState as BoardState | null)?.pads ?? [];
  const channels = G.commChannels as Record<number, ChatMessage[]>;
  for (const p of pads) {
    const id = Number(p.id);
    if (!Number.isFinite(id)) continue;
    if (!Array.isArray(channels[id])) channels[id] = [];
  }
}

function getCommSnapshot(): CommSnapshot {
  ensureGlobals();
  ensureChannelsForPads();
  const pads = (G.boardState as BoardState | null)?.pads ?? [];
  const channels = G.commChannels as Record<number, ChatMessage[]>;
  const padViewers = G.commPadViewers as Map<number, Set<string>>;

  const result: PadChannel[] = pads.map((p: Pad) => {
    const id = Number(p.id);
    const viewers = padViewers.get(id);
    const online = !!(viewers && viewers.size > 0);
    const name = p.name || `Pad ${id}`;
    const messages = (channels[id] ?? []).slice(-120);
    return { padId: id, name, online, messages };
  });

  return { channels: result };
}

function emitComm(io: IOServer) {
  const snap = getCommSnapshot();
  io.emit("comm:snapshot", snap);
}

function appendChatToPad(io: IOServer, padId: number, msg: ChatMessage) {
  ensureGlobals();
  ensureChannelsForPads();
  const channels = G.commChannels as Record<number, ChatMessage[]>;
  const cur = channels[padId] ?? [];
  cur.push(msg);
  if (cur.length > MAX_CHAT_PER_PAD) cur.splice(0, cur.length - MAX_CHAT_PER_PAD);
  channels[padId] = cur;
  scheduleCommPersist();
  emitComm(io);
}

export default function handler(req: NextApiRequest, res: NextResWithSocket) {
  ensureGlobals();

  if (!res.socket.server.io) {
    const io = new IOServer(res.socket.server, {
      path: "/api/socket/io",
      addTrailingSlash: false,
    });

    res.socket.server.io = io;
    G.io = io;

    loadCommChannelsIfNeeded();

    // Derive role from server-verified cacc_role cookie only. Never trust client inputs.
    io.use((socket, next) => {
      const cookieHeader = socket.handshake.headers.cookie;
      const cookies = parseCookie(cookieHeader);
      const signedValue = cookies["cacc_role"] ?? "";
      const role = verifyRoleCookie(signedValue);

      (socket as any).data = (socket as any).data ?? {};
      if (role === "admin") {
        (socket as any).data.role = "admin";
      } else if (role === "judge") {
        (socket as any).data.role = "judge";
      } else {
        (socket as any).data.role = "public";
      }
      next();
    });

    const emitState = () => {
      loadStateIfNeeded();
      const state = G.boardState as BoardState;
      const nowMs = Date.now();
      const eventStatus = (state as any).eventStatus ?? "PLANNING";
      const eventStartAt = (state as any).eventStartAt;
      if (eventStatus === "PLANNING" && typeof eventStartAt === "number" && Number.isFinite(eventStartAt) && nowMs >= eventStartAt) {
        (state as any).eventStatus = "LIVE";
        (state as any).eventStartAt = nowMs;
        state.updatedAt = nowMs;
        pushAudit({ ts: nowMs, padId: null, action: "EVENT_START", detail: "Event auto-started (scheduled time reached)." });
      }
      sanitizeStateAfterAnyLoad(state);
      ensureChannelsForPads();
      io.emit("state", G.boardState);
      io.emit("audit", G.audit);
    };

    io.on("connection", (socket) => {
      loadStateIfNeeded();
      sanitizeStateAfterAnyLoad(G.boardState as BoardState);

      socket.emit("state", G.boardState);
      socket.emit("audit", G.audit);

      // send comm snapshot to new connection
      socket.emit("comm:snapshot", getCommSnapshot());

      // Wrap socket.on so handlers don't crash the connection on error.
      // NOTE: Use originalOn directly for any handler that uses Socket.IO ack callbacks,
      // because the wrapper catches exceptions but does NOT forward the ack — meaning an
      // uncaught exception inside a wrapped handler silently swallows the ack and the
      // client hangs. Handlers with acks must do their own try/catch.
      const originalOn = socket.on.bind(socket);
      (socket as any).on = (event: string, handler: (...args: any[]) => void) => {
        originalOn(event, (...args: any[]) => {
          try {
            handler(...args);
          } catch (e) {
            console.error(`[socket] ${event} error:`, e);
          }
        });
      };

      console.log("[socket] connection established. role=", (socket as any).data?.role, "id=", socket.id);

      socket.on("getState", () => {
        loadStateIfNeeded();
        sanitizeStateAfterAnyLoad(G.boardState as BoardState);
        socket.emit("state", G.boardState);
        socket.emit("audit", G.audit);
      });

      type ReloadAck = (arg: { ok: boolean; error?: string; detail?: string }) => void;
      const doLoadRoster = (ack?: ReloadAck) => {
        const nowMs = Date.now();
        const prev = G.boardState as BoardState;
        const sendAck = (ok: boolean, error?: string, detail?: string) => {
          try {
            ack?.({ ok, error, detail });
          } catch {}
        };

        try {
          const rosterPath = getRosterPath();
          const built = buildStateFromRosterCsv(rosterPath);

          if (built) {
            built.globalBreakStartAt = prev.globalBreakStartAt ?? null;
            built.globalBreakUntilAt = prev.globalBreakUntilAt ?? null;
            built.globalBreakReason = prev.globalBreakReason ?? null;

            built.globalMessage = prev.globalMessage ?? null;
            built.globalMessageUntilAt = prev.globalMessageUntilAt ?? null;

            built.schedule = prev.schedule ?? [];
            built.scheduleUpdatedAt = prev.scheduleUpdatedAt ?? nowMs;
            (built as any).eventHeaderLabel = (prev as any).eventHeaderLabel ?? "COMPETITION MATRIX";

            // Roster load: set PLANNING so report timers do not start (unless event already LIVE)
            // If event is LIVE, do NOT flip to PLANNING on roster reload
            const wasLive = (prev as any)?.eventStatus === "LIVE";
            (built as any).eventStatus = wasLive ? "LIVE" : "PLANNING";
            (built as any).eventStartAt = (prev as any)?.eventStartAt ?? null;
            (built as any).eventPaused = (prev as any)?.eventPaused ?? false;
            (built as any).eventPausedAt = (prev as any)?.eventPausedAt ?? null;
            (built as any).eventPausedAccumMs = (prev as any)?.eventPausedAccumMs ?? 0;

            G.boardState = built;
            G.rosterLoaded = true;

            sanitizeStateAfterAnyLoad(G.boardState as BoardState);
            pushAudit({ ts: nowMs, padId: null, action: "ROSTER_LOAD", detail: "Roster loaded from CSV." });
            emitState();
            sendAck(true);
            return;
          }

          const detail = `No roster at ${rosterPath}; using empty state.`;
          pushAudit({ ts: nowMs, padId: null, action: "ROSTER_LOAD_FAIL", detail });
          emitState();
          sendAck(false, "Roster file not found", detail);
        } catch (e: any) {
          const err = String(e?.message ?? e);
          pushAudit({ ts: nowMs, padId: null, action: "ROSTER_LOAD_ERROR", detail: `Roster load error: ${err}` });
          emitState();
          sendAck(false, err);
        }
      };

      // =========================
      // JUDGE: AREA ASSIGNMENT (must precede pad actions)
      // =========================
      socket.on("judge:area:set", (payload: any, ack?: (res: { ok: boolean; assignedPadId?: number; error?: string }) => void) => {
        const sendAck = (ok: boolean, assignedPadId?: number, error?: string) => {
          try {
            ack?.({ ok, assignedPadId, error });
          } catch {}
          if (!ok && error) {
            socket.emit("judge:bind:error", { code: "BIND_FAILED", message: error });
          }
        };

        const role = (socket as any).data?.role;
        if (!["judge", "admin"].includes(role)) {
          socket.emit("judge:bind:error", {
            code: "NOT_JUDGE",
            message: "Not authorized to bind as judge",
          });
          try {
            ack?.({ ok: false, error: "Not authorized" });
          } catch {}
          return;
        }
        const padIdRaw = payload?.padId != null ? Math.floor(Number(payload.padId)) : null;
        if (typeof padIdRaw !== "number" || !Number.isFinite(padIdRaw)) {
          sendAck(false, undefined, "Invalid padId");
          return;
        }
        const pad = getPadById(padIdRaw);
        if (!pad) {
          sendAck(false, undefined, "Pad not found");
          return;
        }

        const prevPadId = (socket as any).data?.assignedPadId;
        (socket as any).data.assignedPadId = padIdRaw;

        const nowMs = Date.now();
        if (prevPadId != null && prevPadId !== padIdRaw) {
          pushAudit({
            ts: nowMs,
            padId: padIdRaw,
            action: "JUDGE_AREA_CHANGE",
            detail: `Judge changed area: ${prevPadId} → ${padIdRaw}`,
          });
        }

        sendAck(true, padIdRaw);
      });

      // =========================
      // COMM: REGISTER (admin only) / JOIN PAD (judge)
      // =========================
      socket.on("comm:register", (payload: any) => {
        ensureGlobals();
        const role = (socket as any).data?.role;
        if (role === "admin") {
          G.commAdmins.add(socket.id);
          (socket as any).data.commRole = "admin";
          emitComm(io);
        }
      });

      socket.on("comm:joinPad", (payload: any) => {
        if (!isJudgeRole((socket as any).data?.role)) return;
        ensureGlobals();
        ensureChannelsForPads();
        const nowMs = Date.now();
        const padIdRaw = payload?.padId != null ? Math.floor(Number(payload.padId)) : null;
        if (typeof padIdRaw !== "number" || !Number.isFinite(padIdRaw) || !getPadById(padIdRaw)) return;
        const assigned = (socket as any).data?.assignedPadId;
        if (assigned == null || assigned !== padIdRaw) return; // Judge can only join assigned pad
        const padId = padIdRaw;

        const padViewers = G.commPadViewers as Map<number, Set<string>>;
        const prevPadId = (socket as any).data?.padId;
        if (Number.isFinite(prevPadId)) {
          const prevSet = padViewers.get(prevPadId);
          if (prevSet) {
            prevSet.delete(socket.id);
            if (prevSet.size === 0) padViewers.delete(prevPadId);
          }
        }

        let set = padViewers.get(padId);
        if (!set) {
          set = new Set<string>();
          padViewers.set(padId, set);
        }
        set.add(socket.id);

        (socket as any).data.padId = padId;
        (socket as any).data.commRole = "judge";

        const prev = G.commJudges.get(socket.id);
        const base: JudgePresence = prev ?? {
          socketId: socket.id,
          connectedAt: nowMs,
          lastSeenAt: nowMs,
          padId,
          name: null,
        };
        base.lastSeenAt = nowMs;
        base.padId = padId;
        G.commJudges.set(socket.id, base);

        emitComm(io);
      });

      socket.on("comm:presence", (payload: any) => {
        if (!isJudgeRole((socket as any).data?.role)) return;
        ensureGlobals();
        const assigned = (socket as any).data?.assignedPadId;
        if (assigned == null || !Number.isFinite(assigned)) return;
        const nowMs = Date.now();
        const rec = G.commJudges.get(socket.id);
        if (!rec) return;
        const padId = payload?.padId != null ? Number(payload.padId) : null;
        if (padId != null && padId !== assigned) return; // Judge can only send presence for assigned pad
        const name = payload?.name != null ? String(payload.name).trim() : null;
        rec.lastSeenAt = nowMs;
        if (typeof padId === "number" && Number.isFinite(padId)) rec.padId = Math.floor(padId);
        if (name) rec.name = name;
        G.commJudges.set(socket.id, rec);
        emitComm(io);
      });

      // =========================
      // COMM: CHAT (admin -> pad channel)
      // =========================
      socket.on("admin:comm:send", (payload: any) => {
        if ((socket as any).data?.role !== "admin") return;
        ensureGlobals();
        const toPadIdRaw = payload?.toPadId != null ? Math.floor(Number(payload.toPadId)) : null;
        const text = String(payload?.text ?? "").trim();
        if (typeof toPadIdRaw !== "number" || !Number.isFinite(toPadIdRaw) || !text) return;
        if (!getPadById(toPadIdRaw)) return;
        const toPadId = toPadIdRaw;

        const urgent = Boolean(payload?.urgent);
        const msg: ChatMessage = { id: uid(), ts: Date.now(), from: "ADMIN", text, urgent: urgent || undefined };
        appendChatToPad(io, toPadId, msg);
      });

      // judge -> current pad channel (reply auto-acks latest unacked urgent for that pad)
      socket.on("judge:comm:send", (payload: any) => {
        if (!isJudgeRole((socket as any).data?.role)) return;
        ensureGlobals();
        const text = String(payload?.text ?? "").trim();
        if (!text) return;
        const padIdRaw = (socket as any).data?.assignedPadId;
        if (typeof padIdRaw !== "number" || !Number.isFinite(padIdRaw) || !getPadById(padIdRaw)) return;
        const padId = padIdRaw;

        const channels = G.commChannels as Record<number, ChatMessage[]>;
        const msgs = channels[padId] ?? [];
        const lastUnackedUrgent = [...msgs].reverse().find((m) => m.urgent && m.ackedAt == null);
        if (lastUnackedUrgent) {
          lastUnackedUrgent.ackedAt = Date.now();
          scheduleCommPersist();
          emitComm(io);
          for (const sid of G.commAdmins) io.to(sid).emit("comm:urgentAcked", { padId, messageId: lastUnackedUrgent.id });
        }

        const msg: ChatMessage = { id: uid(), ts: Date.now(), from: "JUDGE", text };
        appendChatToPad(io, padId, msg);
      });

      // judge acknowledges urgent message (only for pad they are joined to)
      socket.on("judge:comm:ack", (payload: any) => {
        if (!isJudgeRole((socket as any).data?.role)) return;
        ensureGlobals();
        const padIdRaw = (socket as any).data?.assignedPadId;
        if (typeof padIdRaw !== "number" || !Number.isFinite(padIdRaw) || !getPadById(padIdRaw)) return;
        const padId = padIdRaw;

        const messageId = String(payload?.messageId ?? "").trim();
        if (!messageId) return;

        const channels = G.commChannels as Record<number, ChatMessage[]>;
        const msgs = channels[padId] ?? [];
        const msg = msgs.find((m) => m.id === messageId);
        if (!msg || !msg.urgent || msg.ackedAt != null) return;

        msg.ackedAt = Date.now();
        scheduleCommPersist();
        emitComm(io);
        for (const sid of G.commAdmins) io.to(sid).emit("comm:urgentAcked", { padId, messageId });
      });

      // =========================
      // COMM: BROADCAST (admin -> pad channels)
      // target = ALL | PAD
      // =========================
      socket.on("admin:comm:broadcast", (payload: any) => {
        if ((socket as any).data?.role !== "admin") return;
        ensureGlobals();
        ensureChannelsForPads();
        const text = String(payload?.text ?? "").trim();
        if (!text) return;

        const target = String(payload?.target ?? "ALL").toUpperCase();
        const padId = payload?.padId != null ? Math.floor(Number(payload.padId)) : null;

        const ttlSeconds = Math.max(20, Math.min(60 * 30, Number(payload?.ttlSeconds ?? 120)));
        const broadcast = {
          id: uid(),
          ts: Date.now(),
          text,
          target,
          padId: Number.isFinite(padId as any) ? (padId as any) : null,
          ttlSeconds,
        };

        const channels = G.commChannels as Record<number, ChatMessage[]>;
        const pads = (G.boardState as BoardState)?.pads ?? [];
        const padIds: number[] =
          target === "PAD" && typeof padId === "number" && Number.isFinite(padId)
            ? [padId]
            : pads.map((p: Pad) => Number(p.id)).filter((id): id is number => typeof id === "number" && Number.isFinite(id));

        const msg: ChatMessage = { id: uid(), ts: Date.now(), from: "ADMIN", text: `📣 BROADCAST: ${text}` };
        for (const pid of padIds) {
          const cur = channels[pid] ?? [];
          cur.push({ ...msg });
          if (cur.length > MAX_CHAT_PER_PAD) cur.splice(0, cur.length - MAX_CHAT_PER_PAD);
          channels[pid] = cur;
        }
        scheduleCommPersist();

        const padViewers = G.commPadViewers as Map<number, Set<string>>;
        const recipients =
          target === "PAD" && typeof padId === "number" && Number.isFinite(padId)
            ? (padViewers.get(padId) ?? new Set())
            : new Set(pads.flatMap((p: Pad) => [...(padViewers.get(Number(p.id)) ?? [])]));
        for (const sid of recipients) {
          io.to(sid).emit("comm:broadcast", broadcast);
        }

        emitComm(io);
      });

      socket.on("disconnect", () => {
        ensureGlobals();
        G.commAdmins.delete(socket.id);

        const padViewers = G.commPadViewers as Map<number, Set<string>>;
        const prevPadId = (socket as any).data?.padId;
        if (Number.isFinite(prevPadId)) {
          const set = padViewers.get(prevPadId);
          if (set) {
            set.delete(socket.id);
            if (set.size === 0) padViewers.delete(prevPadId);
          }
        }

        if (G.commJudges.has(socket.id)) G.commJudges.delete(socket.id);
        emitComm(io);
      });

      // =========================
      // ADMIN: PADS ENSURE (CSV import)
      // =========================
      socket.on("admin:pads:ensure", ({ maxPadId, namePrefix, labelPrefix }: any) => {
        if ((socket as any).data?.role !== "admin") return;
        if (!G.boardState) return;
        const st = G.boardState as BoardState;
        const nowMs = Date.now();

        const existing = new Set((st.pads ?? []).map((p: Pad) => p.id));
        const target = Math.max(0, Math.floor(Number(maxPadId) || 0));
        if (target <= 0) return;

        for (let id = 1; id <= target; id++) {
          if (existing.has(id)) continue;

          const pad = createPad({
            id,
            nowMs,
            name: namePrefix ? `${String(namePrefix)} ${id}` : undefined,
            label: labelPrefix ? `${String(labelPrefix)} ${id}` : undefined,
            seedDemoTeams: false,
          });

          st.pads.push(pad);
          existing.add(id);
        }

        st.nextPadId = Math.max(st.nextPadId ?? 1, target + 1);
        st.updatedAt = nowMs;

        pushAudit({ ts: nowMs, padId: null, action: "PADS_ENSURE", detail: `Ensured areas 1..${target}` });
        emitState();
      });

      // =========================
      // ADMIN: EVENT RESET (Start New Event)
      // =========================
      type ResetScope = {
        clearComm?: boolean;
        clearBroadcasts?: boolean;
        clearAudit?: boolean;
        resetQueues?: boolean;
        preservePads?: boolean;
        resetHeaderLabel?: boolean;
        clearAreas?: boolean;
      };
      type ResetAck = (arg: { ok: boolean; error?: string }) => void;
      socket.on("admin:event:reset", (payload: ResetScope | undefined, ack?: ResetAck) => {
        const sendAck = (ok: boolean, error?: string) => {
          try {
            ack?.({ ok, error });
          } catch {}
        };
        if ((socket as any).data?.role !== "admin") {
          console.warn("[admin:event:reset] Rejected: not admin");
          sendAck(false, "Not authorized");
          return;
        }
        if (!G.boardState) {
          console.warn("[admin:event:reset] Rejected: no board state");
          sendAck(false, "No board state");
          return;
        }

        try {
          ensureGlobals();
          ensureChannelsForPads();

          const scope: Required<ResetScope> = {
            clearComm: payload?.clearComm !== false,
            clearBroadcasts: payload?.clearBroadcasts !== false,
            clearAudit: payload?.clearAudit !== false,
            resetQueues: payload?.resetQueues === true,
            preservePads: payload?.preservePads !== false,
            resetHeaderLabel: payload?.resetHeaderLabel === true,
            clearAreas: payload?.clearAreas === true,
          };

          const nowMs = Date.now();
        const st = G.boardState as BoardState;
        const channels = G.commChannels as Record<number, ChatMessage[]>;

        // A) clearComm (default true)
        if (scope.clearComm) {
          G.commChannels = {} as Record<number, ChatMessage[]>;
          G.commPadViewers = new Map<number, Set<string>>();
          scheduleCommPersist();
        } else if (scope.clearBroadcasts) {
          // Filter broadcast messages from channels
          for (const [k, msgs] of Object.entries(channels)) {
            const id = Number(k);
            if (!Number.isFinite(id)) continue;
            const filtered = (msgs ?? []).filter((m) => !m.text?.startsWith?.("📣 BROADCAST:"));
            if (filtered.length === 0) delete channels[id];
            else channels[id] = filtered;
          }
          scheduleCommPersist();
        }

        // B) clearAudit (default true)
        if (scope.clearAudit) {
          G.audit = [];
          if (G.boardState) (G.boardState as any).audit = G.audit;
        }

        // C) resetQueues (default false)
        if (scope.resetQueues && st.pads) {
          for (const pad of st.pads) {
            pad.now = null;
            pad.onDeck = null;
            pad.standby = [];
            pad.note = "";
            pad.status = "IDLE";
            pad.nowArrivedAt = null;
            pad.nowArrivedTeamId = null;
            pad.runStartedAt = null;
            pad.lastRunEndedAt = null;
            pad.lastCompleteAt = null;
            pad.reportByDeadlineAt = null;
            pad.reportByTeamId = null;
            pad.breakUntilAt = null;
            pad.breakReason = null;
            pad.breakStartAt = null;
            pad.message = null;
            pad.messageUntilAt = null;
            pad.updatedAt = nowMs;
          }
          st.updatedAt = nowMs;
        }

        // D) resetHeaderLabel (default false)
        if (scope.resetHeaderLabel) {
          st.eventHeaderLabel = "COMPETITION MATRIX";
        }

        // E) clearAreas (default false) — delete ALL pads
        if (scope.clearAreas) {
          st.pads = [];
          st.nextPadId = 1;
          if (st.schedule && Array.isArray(st.schedule)) {
            st.schedule = st.schedule.filter((e) => e?.scope !== "PAD");
          }
          G.commChannels = {} as Record<number, ChatMessage[]>;
          G.commPadViewers = new Map<number, Set<string>>();
          scheduleCommPersist();
        }

        // Add audit entry for the reset (after clearing audit if applicable)
        pushAudit({
          ts: nowMs,
          padId: null,
          action: "EVENT_RESET",
          detail: JSON.stringify(scope),
        });

        emitState();
        emitComm(io);
        console.log("[admin:event:reset] OK scope=", JSON.stringify(scope));
        sendAck(true);
        } catch (e) {
          const err = e instanceof Error ? e.message : String(e);
          console.error("[admin:event:reset] Error:", e);
          sendAck(false, err);
        }
      });

      // =========================
      // ADMIN: RECOVERY ACTIONS
      // Three targeted recovery operations with explicit blast radii.
      // Each emits back via emitState() so all connected clients refresh.
      // =========================
      type RecoveryAck = (arg: { ok: boolean; error?: string; detail?: string }) => void;

      // ── 1. Reset Reporting Timers ─────────────────────────────────────────
      // Lightest action. For every pad that currently has a team in NOW,
      // recomputes reportByDeadlineAt = competitionNow + 5 min using
      // getCompetitionNowMs (not wall-clock), so eventPausedAccumMs is
      // accounted for correctly. Queue order and history are untouched.
      socket.on("admin:recovery:resetTimers", (_payload: any, ack?: RecoveryAck) => {
        const sendAck = (ok: boolean, error?: string, detail?: string) => { try { ack?.({ ok, error, detail }); } catch {} };
        if ((socket as any).data?.role !== "admin") { sendAck(false, "Not authorized"); return; }
        if (!G.boardState) { sendAck(false, "No board state"); return; }

        const nowMs = Date.now();
        const state = G.boardState as BoardState;
        let count = 0;

        for (const pad of state.pads ?? []) {
          if (pad.now) {
            // startReportTimerForNow uses getCompetitionNowMs internally
            startReportTimerForNow(pad, nowMs);
            count++;
            console.log(
              "[RECOVERY:resetTimers] pad=", pad.id,
              "team=", pad.now.name,
              "newDeadlineAt=", pad.reportByDeadlineAt,
              "wallNow=", nowMs,
            );
          }
        }

        state.updatedAt = nowMs;
        const detail = `Reset report timers on ${count} pad(s).`;
        pushAudit({ ts: nowMs, padId: null, action: "RECOVERY_RESET_TIMERS", detail });
        emitState();
        console.log("[RECOVERY:resetTimers] OK count=", count);
        sendAck(true, undefined, detail);
      });

      // ── 2. Reset Event State ──────────────────────────────────────────────
      // Returns the event to PLANNING and wipes all live runtime state:
      // event lifecycle (status/pause accumulation/start time), all pad
      // queues and timers, global break state, and scheduled slot completion
      // records. Preserves: roster (teamDetails), pad definitions (name/id),
      // schedule events, and scheduledSlot definitions (statuses reset only).
      socket.on("admin:recovery:resetEventState", (_payload: any, ack?: RecoveryAck) => {
        const sendAck = (ok: boolean, error?: string, detail?: string) => { try { ack?.({ ok, error, detail }); } catch {} };
        if ((socket as any).data?.role !== "admin") { sendAck(false, "Not authorized"); return; }
        if (!G.boardState) { sendAck(false, "No board state"); return; }

        const nowMs = Date.now();
        const state = G.boardState as BoardState;

        // Reset event lifecycle — clears pause accumulation so competition
        // clocks start fresh if the event is re-started.
        (state as any).eventStatus = "PLANNING";
        (state as any).eventStartAt = null;
        (state as any).eventPaused = false;
        (state as any).eventPausedAt = null;
        (state as any).eventPausedAccumMs = 0;

        // Reset global break and any active message. Both are live operational
        // state that has no meaning once the event returns to PLANNING.
        state.globalBreakStartAt = null;
        state.globalBreakUntilAt = null;
        state.globalBreakReason = null;
        state.globalMessage = null;
        state.globalMessageUntilAt = null;

        // Clear cycle timing stats. These accumulate actual run durations during
        // a competition and are used for ETA estimates on the public board. Carrying
        // them into a fresh event run would seed estimates with stale data from the
        // previous event's teams and conditions, which could be misleading.
        state.cycleStatsByPad = {};
        state.cycleStatsByKey = {};
        state.avgCycleSecondsByPad = {};

        // Reset all pad queue and timer state. Pad definitions (id/name/label)
        // are deliberately preserved so areas don't need to be recreated.
        const padCount = (state.pads ?? []).length;
        for (const pad of state.pads ?? []) {
          pad.now = null;
          pad.onDeck = null;
          pad.standby = [];
          pad.note = "";
          pad.status = "IDLE";
          pad.nowArrivedAt = null;
          pad.nowArrivedTeamId = null;
          pad.runStartedAt = null;
          pad.lastRunEndedAt = null;
          pad.lastCompleteAt = null;
          pad.reportByDeadlineAt = null;
          pad.reportByTeamId = null;
          pad.breakUntilAt = null;
          pad.breakReason = null;
          pad.breakStartAt = null;
          pad.message = null;
          pad.messageUntilAt = null;
          pad.updatedAt = nowMs;
          console.log("[RECOVERY:resetEventState] cleared pad=", pad.id, pad.name ?? "");
        }

        // Reset scheduled slot statuses back to PENDING and clear actual
        // timing fields so the schedule is ready for a fresh run.
        // SCRATCHED slots are intentional and remain unchanged.
        let slotCount = 0;
        if (state.scheduledSlots) {
          for (const sl of state.scheduledSlots) {
            if (sl.status !== "SCRATCHED") {
              sl.status = "PLANNED";
              sl.actualStartMs = undefined;
              sl.actualEndMs = undefined;
              slotCount++;
            }
          }
        }

        state.updatedAt = nowMs;
        const detail = `Reset to PLANNING. Cleared ${padCount} pad(s), ${slotCount} slot status(es), cycle stats, global break, and global message. eventPausedAccumMs reset to 0.`;
        pushAudit({ ts: nowMs, padId: null, action: "RECOVERY_RESET_EVENT_STATE", detail });
        emitState();
        console.log("[RECOVERY:resetEventState] OK", detail);
        sendAck(true, undefined, detail);
      });

      // ── 3. Rebuild Board ──────────────────────────────────────────────────
      // Reconstructs live pad queues from scheduledSlots — the authoritative
      // import data. Active slots (not COMPLETE / SCRATCHED / SKIPPED) are
      // loaded into NOW / ON DECK / STANDBY in ascending slotOrder.
      // Arrival and timer state is cleared; if the event is LIVE a fresh
      // 5-minute report timer starts in competition-time space.
      // No-op if no schedule has been imported.
      socket.on("admin:recovery:rebuildBoard", (_payload: any, ack?: RecoveryAck) => {
        const sendAck = (ok: boolean, error?: string, detail?: string) => { try { ack?.({ ok, error, detail }); } catch {} };
        if ((socket as any).data?.role !== "admin") { sendAck(false, "Not authorized"); return; }
        if (!G.boardState) { sendAck(false, "No board state"); return; }

        const nowMs = Date.now();
        const state = G.boardState as BoardState;
        const isLive = state.eventStatus === "LIVE";

        if (!state.scheduledSlots || state.scheduledSlots.length === 0) {
          sendAck(false, "No scheduled slots to rebuild from. Import a schedule first.");
          return;
        }

        let rebuiltPads = 0;
        for (const pad of state.pads ?? []) {
          const activeSlots = getActiveSlotsForPad(state, pad.id);
          const remaining = [...activeSlots];
          const firstSlot = remaining.shift();

          pad.now = firstSlot ? slotToTeam(firstSlot) : null;
          pad.onDeck = remaining.length > 0 ? slotToTeam(remaining.shift()!) : null;
          pad.standby = remaining.map(slotToTeam);

          // Clear all runtime state — rebuild is a clean reconciliation.
          clearArrivalForNow(pad);
          pad.reportByDeadlineAt = null;
          pad.reportByTeamId = null;
          pad.breakUntilAt = null;
          pad.breakStartAt = null;
          pad.breakReason = null;
          pad.message = null;
          pad.messageUntilAt = null;
          pad.note = "";

          if (isLive && pad.now) {
            // startReportTimerForNow uses competition time, not wall-clock
            startReportTimerForNow(pad, nowMs);
          } else {
            pad.status = pad.now ? "REPORTING" : "IDLE";
          }

          pad.updatedAt = nowMs;
          rebuiltPads++;
          console.log(
            "[RECOVERY:rebuildBoard] pad=", pad.id,
            "now=", pad.now?.name ?? "—",
            "onDeck=", pad.onDeck?.name ?? "—",
            "standby=", pad.standby.length,
            "activeSlots=", activeSlots.length,
          );
        }

        state.updatedAt = nowMs;
        const detail = `Rebuilt ${rebuiltPads} pad(s) from ${state.scheduledSlots.length} slot(s).`;
        pushAudit({ ts: nowMs, padId: null, action: "RECOVERY_REBUILD_BOARD", detail });
        emitState();
        console.log("[RECOVERY:rebuildBoard] OK", detail);
        sendAck(true, undefined, detail);
      });

      // =========================
      // ADMIN: AREA CRUD
      // =========================
      socket.on("admin:pad:add", (payload: any) => {
        const state = G.boardState as BoardState;
        const nowMs = Date.now();

        const name = payload?.name ? String(payload.name) : undefined;
        const label = payload?.label ? String(payload.label) : undefined;

        const id = state.nextPadId ?? 1;

        const pad = createPad({
          id,
          nowMs,
          name: name ?? `Area ${id}`,
          label: label ?? `Area ${id}`,
          seedDemoTeams: false,
        });

        state.pads = [...(state.pads ?? []), pad];
        state.nextPadId = id + 1;
        state.updatedAt = nowMs;

        pushAudit({ ts: nowMs, padId: id, action: "AREA_ADD", detail: `Added area: ${pad.name} (${pad.label})` });
        emitState();
      });

      socket.on("admin:pad:update", (payload: any) => {
        if ((socket as any).data?.role !== "admin") return;
        const state = G.boardState as BoardState;
        const nowMs = Date.now();

        const padId = resolvePadId(payload);
        if (padId == null) return;

        const pad = getPadById(padId);
        if (!pad) return;

        snapshotForUndo(padId);

        const name = payload?.name != null ? String(payload.name).trim() : null;
        const label = payload?.label != null ? String(payload.label).trim() : null;

        if (name !== null && name.length > 0) pad.name = name;
        if (label !== null && label.length > 0) pad.label = label;

        pad.updatedAt = nowMs;
        state.updatedAt = nowMs;

        pushAudit({ ts: nowMs, padId, action: "AREA_UPDATE", detail: `Updated area: ${pad.name} (${pad.label})` });
        emitState();
      });

      socket.on("admin:pad:delete", (payload: any) => {
        const state = G.boardState as BoardState;
        const nowMs = Date.now();

        const padId = resolvePadId(payload);
        if (padId == null) return;

        const pad = getPadById(padId);
        if (!pad) return;

        delete G.padHistory?.[`__stack_${padId}`];

        state.pads = (state.pads ?? []).filter((p) => p.id !== padId);
        state.updatedAt = nowMs;

        pushAudit({ ts: nowMs, padId, action: "AREA_DELETE", detail: `Deleted area: ${pad.name}` });
        emitState();
      });

      // =========================
      // ADMIN: CLEAR ALL QUEUES (hard reset)
      // =========================
      socket.on("admin:clearAllQueues", (payload?: { clearAreas?: boolean }, ack?: (arg: { ok?: boolean; error?: string }) => void) => {
        const sendAck = (ok: boolean, error?: string) => {
          try {
            ack?.({ ok, error });
          } catch {}
        };
        if ((socket as any).data?.role !== "admin") {
          sendAck(false, "Not authorized");
          return;
        }
        const nowMs = Date.now();
        const state = G.boardState as BoardState;
        if (!state) {
          sendAck(false, "No board state");
          return;
        }

        try {
          (state.pads ?? []).forEach((p) => clearPad(p, nowMs));
          state.updatedAt = nowMs;

          const clearAreas = payload?.clearAreas === true;
          if (clearAreas) {
            state.pads = [];
            state.nextPadId = 1;
            if (state.schedule && Array.isArray(state.schedule)) {
              state.schedule = state.schedule.filter((e) => e?.scope !== "PAD");
            }
            G.commChannels = {} as Record<number, ChatMessage[]>;
            G.commPadViewers = new Map<number, Set<string>>();
            scheduleCommPersist();
          }

          pushAudit({
            ts: nowMs,
            padId: null,
            action: "CLEAR_ALL",
            detail: clearAreas
              ? "Cleared all queues and deleted all areas."
              : "Cleared all queues across all areas.",
          });

          emitState();
          if (clearAreas) emitComm(io);
          sendAck(true);
        } catch (e) {
          const err = e instanceof Error ? e.message : String(e);
          sendAck(false, err);
        }
      });

      // =========================
      // ADMIN: LOAD/RELOAD ROSTER
      // =========================
      socket.on("admin:loadRoster", (ack?: ReloadAck) => {
        if ((socket as any).data?.role !== "admin") {
          ack?.({ ok: false, error: "Not authorized" });
          return;
        }
        doLoadRoster(ack);
      });
      socket.on("admin:reloadRoster", (ack?: ReloadAck) => {
        if ((socket as any).data?.role !== "admin") {
          ack?.({ ok: false, error: "Not authorized" });
          return;
        }
        doLoadRoster(ack);
      });

      // =========================
      // ADMIN: EVENT START GATE (schedule / start now / set planning)
      // =========================
      type EventAck = (arg: { ok: boolean; error?: string }) => void;
      socket.on("admin:event:scheduleStart", (payload: { startAt?: number }, ack?: EventAck) => {
        const sendAck = (ok: boolean, error?: string) => {
          try {
            ack?.({ ok, error });
          } catch {}
        };
        if ((socket as any).data?.role !== "admin") {
          sendAck(false, "Not authorized");
          return;
        }
        const state = G.boardState as BoardState;
        if (!state) {
          sendAck(false, "No board state");
          return;
        }
        const startAt = typeof payload?.startAt === "number" && Number.isFinite(payload.startAt) ? payload.startAt : null;
        (state as any).eventStartAt = startAt;
        (state as any).eventStatus = "PLANNING";
        state.updatedAt = Date.now();
        pushAudit({ ts: state.updatedAt, padId: null, action: "EVENT_SCHEDULE", detail: startAt ? `Scheduled start at ${new Date(startAt).toISOString()}` : "Cleared scheduled start." });
        emitState();
        sendAck(true);
      });
      socket.on("admin:event:startNow", (_payload: unknown, ack?: EventAck) => {
        const sendAck = (ok: boolean, error?: string) => {
          try {
            ack?.({ ok, error });
          } catch {}
        };
        if ((socket as any).data?.role !== "admin") {
          sendAck(false, "Not authorized");
          return;
        }
        const state = G.boardState as BoardState;
        if (!state) {
          sendAck(false, "No board state");
          return;
        }
        const nowMs = Date.now();
        (state as any).eventStatus = "LIVE";
        (state as any).eventStartAt = nowMs;
        (state as any).eventPaused = false;
        (state as any).eventPausedAt = null;
        (state as any).eventPausedAccumMs = 0;
        state.updatedAt = nowMs;
        sanitizeStateAfterAnyLoad(state);
        pushAudit({ ts: nowMs, padId: null, action: "EVENT_START", detail: "Event started (LIVE)." });
        emitState();
        sendAck(true);
      });
      socket.on("admin:event:setPlanning", (_payload: unknown, ack?: EventAck) => {
        const sendAck = (ok: boolean, error?: string) => {
          try {
            ack?.({ ok, error });
          } catch {}
        };
        if ((socket as any).data?.role !== "admin") {
          sendAck(false, "Not authorized");
          return;
        }
        const state = G.boardState as BoardState;
        if (!state) {
          sendAck(false, "No board state");
          return;
        }
        const nowMs = Date.now();
        (state as any).eventStatus = "PLANNING";
        state.updatedAt = nowMs;
        for (const p of state.pads ?? []) {
          p.reportByDeadlineAt = null;
          p.reportByTeamId = null;
          if (p.now && !(p as any).nowArrivedAt) p.status = "IDLE";
        }
        pushAudit({ ts: nowMs, padId: null, action: "EVENT_PLANNING", detail: "Event set to PLANNING." });
        emitState();
        sendAck(true);
      });

      socket.on("admin:event:pause", (_payload: unknown, ack?: EventAck) => {
        const sendAck = (ok: boolean, error?: string) => {
          try {
            ack?.({ ok, error });
          } catch {}
        };
        if ((socket as any).data?.role !== "admin") {
          sendAck(false, "Not authorized");
          return;
        }
        const state = G.boardState as BoardState;
        if (!state) {
          sendAck(false, "No board state");
          return;
        }
        if ((state as any).eventStatus !== "LIVE") {
          sendAck(true);
          return;
        }
        if ((state as any).eventPaused) {
          sendAck(true);
          return;
        }
        const nowMs = Date.now();
        (state as any).eventPaused = true;
        (state as any).eventPausedAt = nowMs;
        state.updatedAt = nowMs;
        pushAudit({ ts: nowMs, padId: null, action: "EVENT_PAUSE", detail: "Competition paused." });
        emitState();
        sendAck(true);
      });

      socket.on("admin:event:resume", (_payload: unknown, ack?: EventAck) => {
        const sendAck = (ok: boolean, error?: string) => {
          try {
            ack?.({ ok, error });
          } catch {}
        };
        if ((socket as any).data?.role !== "admin") {
          sendAck(false, "Not authorized");
          return;
        }
        const state = G.boardState as BoardState;
        if (!state) {
          sendAck(false, "No board state");
          return;
        }
        if ((state as any).eventStatus !== "LIVE") {
          sendAck(true);
          return;
        }
        if (!(state as any).eventPaused) {
          sendAck(true);
          return;
        }
        const nowMs = Date.now();
        const pausedAt = (state as any).eventPausedAt ?? nowMs;
        const delta = nowMs - pausedAt;
        (state as any).eventPausedAccumMs = ((state as any).eventPausedAccumMs ?? 0) + delta;
        (state as any).eventPaused = false;
        (state as any).eventPausedAt = null;
        state.updatedAt = nowMs;
        pushAudit({ ts: nowMs, padId: null, action: "EVENT_RESUME", detail: "Competition resumed." });
        emitState();
        sendAck(true);
      });

      // =========================
      // ADMIN: ADD PARTICIPANT (new)
      // =========================
      socket.on("admin:team:add", (payload: any) => {
        if ((socket as any).data?.role !== "admin") return;
        const nowMs = Date.now();
        const state = G.boardState as BoardState;

        const padId = resolvePadId(payload);
        if (padId == null) return;

        const pad = getPadById(padId);
        if (!pad) return;

        const where = String(payload?.where ?? "END").toUpperCase();
        const teamName = String(payload?.teamName ?? "").trim();
        if (!teamName) return;

        snapshotForUndo(padId);

        const teamId = String(payload?.teamId ?? uid()).trim();
        const team: Team = {
          id: teamId,
          name: teamName,
          unit: payload?.unit ? String(payload.unit) : undefined,
          category: payload?.category ? String(payload.category) : undefined,
          division: payload?.division === "Jr" || payload?.division === "Sr" ? payload.division : undefined,
          tag: "MANUAL",
        };

        const whereSafe: "NOW" | "ONDECK" | "END" = where === "NOW" ? "NOW" : where === "ONDECK" ? "ONDECK" : "END";

        insertTeamIntoPad(pad, nowMs, whereSafe, team);

        state.updatedAt = nowMs;
        pushAudit({ ts: nowMs, padId, action: "ADMIN_TEAM_ADD", detail: `Added participant (${whereSafe}): ${team.name} (${team.id})` });
        emitState();
      });

      // =========================
      // ADMIN: QUEUE MANAGER (linked NOW/ONDECK/STBY)
      // =========================

      socket.on("admin:standby:move", (payload: any) => {
        if ((socket as any).data?.role !== "admin") return;
        const nowMs = Date.now();
        const state = G.boardState as BoardState;

        const padId = resolvePadId(payload);
        if (padId == null) return;

        const pad = getPadById(padId);
        if (!pad) return;

        const from = Number(payload?.from);
        const to = Number(payload?.to);
        if (!Number.isFinite(from) || !Number.isFinite(to)) return;

        const len = pad.standby?.length ?? 0;
        if (len <= 1) return;

        snapshotForUndo(padId);

        pad.standby = moveItem(pad.standby ?? [], Math.floor(from), Math.floor(to));
        pad.updatedAt = nowMs;
        state.updatedAt = nowMs;

        pushAudit({ ts: nowMs, padId, action: "STANDBY_MOVE", detail: `Moved standby index ${from} -> ${to}` });
        emitState();
      });

      socket.on("admin:queue:setSlot", (payload: any) => {
        if ((socket as any).data?.role !== "admin") return;
        const nowMs = Date.now();
        const state = G.boardState as BoardState;

        const padId = resolvePadId(payload);
        if (padId == null) return;

        const pad = getPadById(padId);
        if (!pad) return;

        const teamId = String(payload?.teamId ?? "").trim();
        const target = String(payload?.target ?? "").toUpperCase();
        if (!teamId) return;
        if (target !== "NOW" && target !== "ONDECK") return;

        if (target === "ONDECK" && pad.onDeck?.id === teamId) return;
        if (target === "NOW" && pad.now?.id === teamId) return;

        snapshotForUndo(padId);

        if (target === "NOW" && pad.onDeck?.id === teamId) {
          swapNowOnDeck(pad, nowMs);
          state.updatedAt = nowMs;
          pushAudit({ ts: nowMs, padId, action: "QUEUE_SET_NOW", detail: `NOW set from ONDECK via swap` });
          emitState();
          return;
        }

        const { team } = extractTeamFromPad(pad, teamId);
        if (!team) return;

        insertTeamIntoPad(pad, nowMs, target as any, team);

        state.updatedAt = nowMs;
        pushAudit({ ts: nowMs, padId, action: "QUEUE_SET_SLOT", detail: `Set ${target}: ${team.name} (${team.id})` });
        emitState();
      });

      socket.on("admin:queue:demote", (payload: any) => {
        if ((socket as any).data?.role !== "admin") return;
        const nowMs = Date.now();
        const state = G.boardState as BoardState;

        const padId = resolvePadId(payload);
        if (padId == null) return;

        const pad = getPadById(padId);
        if (!pad) return;

        const from = String(payload?.from ?? "").toUpperCase();
        const to = String(payload?.to ?? "END").toUpperCase();

        if (from !== "NOW" && from !== "ONDECK") return;
        if (to !== "TOP" && to !== "END") return;

        snapshotForUndo(padId);

        if (from === "NOW") {
          const moved = pad.now;
          if (!moved) return;

          if (to === "TOP") pad.standby.unshift(moved);
          else pad.standby.push(moved);

          advanceWithoutComplete(pad, nowMs);

          state.updatedAt = nowMs;
          pushAudit({ ts: nowMs, padId, action: "QUEUE_DEMOTE_NOW", detail: `Demoted NOW to STBY ${to}` });
          emitState();
          return;
        }

        const moved = pad.onDeck;
        if (!moved) return;

        if (to === "TOP") pad.standby.unshift(moved);
        else pad.standby.push(moved);

        pad.onDeck = pad.standby.length > 0 ? pad.standby.shift() ?? null : null;
        pad.updatedAt = nowMs;
        state.updatedAt = nowMs;

        pushAudit({ ts: nowMs, padId, action: "QUEUE_DEMOTE_ONDECK", detail: `Demoted ONDECK to STBY ${to}` });
        emitState();
      });

      socket.on("admin:queue:swap", (payload: any) => {
        if ((socket as any).data?.role !== "admin") return;
        const nowMs = Date.now();
        const state = G.boardState as BoardState;

        const padId = resolvePadId(payload);
        if (padId == null) return;

        const pad = getPadById(padId);
        if (!pad) return;

        snapshotForUndo(padId);
        swapNowOnDeck(pad, nowMs);

        state.updatedAt = nowMs;
        pushAudit({ ts: nowMs, padId, action: "QUEUE_SWAP", detail: "Swapped NOW/ONDECK" });
        emitState();
      });

      socket.on("admin:queue:updateTeam", (payload: any) => {
        if ((socket as any).data?.role !== "admin") return;
        const nowMs = Date.now();
        const state = G.boardState as BoardState;

        const padId = resolvePadId(payload);
        if (padId == null) return;

        const pad = getPadById(padId);
        if (!pad) return;

        const teamId = String(payload?.teamId ?? "").trim();
        const patch = safePatch(payload?.patch, ["id", "name", "unit", "category", "division", "tag"]);
        if (!teamId || !patch) return;

        const allIds = new Set<string>();
        if (pad.now?.id) allIds.add(pad.now.id);
        if (pad.onDeck?.id) allIds.add(pad.onDeck.id);
        (pad.standby ?? []).forEach((t) => allIds.add(t.id));
        if (!allIds.has(teamId)) return;

        snapshotForUndo(padId);

        const applyPatch = (t: Team) => {
          if (patch.id != null) {
            const newId = String(patch.id).trim();
            if (newId && newId !== t.id) {
              const dup = (pad.now?.id === newId) || (pad.onDeck?.id === newId) || (pad.standby ?? []).some((x) => x.id === newId);
              if (!dup) t.id = newId;
            }
          }
          if (patch.name != null) {
            const newName = String(patch.name).trim();
            if (newName) t.name = newName;
          }
          if (patch.unit != null) t.unit = String(patch.unit).trim() || undefined;
          if (patch.category != null) t.category = String(patch.category).trim() || undefined;
          if (patch.division === "Jr" || patch.division === "Sr") t.division = patch.division as "Jr" | "Sr";
          if (patch.tag != null) t.tag = String(patch.tag);
        };

        if (pad.now?.id === teamId) applyPatch(pad.now);
        if (pad.onDeck?.id === teamId) applyPatch(pad.onDeck);
        const idx = (pad.standby ?? []).findIndex((t) => t.id === teamId);
        if (idx >= 0) applyPatch(pad.standby[idx]);

        pad.updatedAt = nowMs;
        state.updatedAt = nowMs;

        pushAudit({ ts: nowMs, padId, action: "QUEUE_UPDATE_TEAM", detail: `Updated team: ${teamId}` });
        emitState();
      });

      socket.on("admin:standby:remove", (payload: any) => {
        if ((socket as any).data?.role !== "admin") return;
        const nowMs = Date.now();
        const state = G.boardState as BoardState;

        const padId = resolvePadId(payload);
        if (padId == null) return;

        const pad = getPadById(padId);
        if (!pad) return;

        const teamId = String(payload?.teamId ?? "").trim();
        if (!teamId) return;

        const idx = (pad.standby ?? []).findIndex((t) => t.id === teamId);
        if (idx < 0) return;

        snapshotForUndo(padId);

        const removed = pad.standby[idx];
        pad.standby = (pad.standby ?? []).filter((t) => t.id !== teamId);

        pad.updatedAt = nowMs;
        state.updatedAt = nowMs;

        pushAudit({ ts: nowMs, padId, action: "STANDBY_REMOVE", detail: `Removed standby: ${removed.name} (${removed.id})` });
        emitState();
      });

      // =========================
      // JUDGE EVENTS (unchanged)
      // =========================
      socket.on("judge:complete", (payload: any) => {
        const padId = judgePadGate(socket, payload);
        if (padId == null) return;

        const state = G.boardState as BoardState;
        const nowMs = Date.now();
        const pad = getPadById(padId);
        if (!pad) return;

        const gbUntil = state.globalBreakUntilAt ?? null;
        const gbStart = state.globalBreakStartAt ?? null;
        const globalBreakActive = (!gbStart || nowMs >= gbStart) && !!gbUntil && nowMs < gbUntil;
        if (globalBreakActive) {
          pushAudit({ ts: nowMs, padId, action: "COMPLETE_BLOCKED", detail: "Blocked by global break." });
          return emitState();
        }

        snapshotForUndo(padId);

        const runStart = pad.runStartedAt ?? pad.nowArrivedAt ?? null;
        const durationSec = runStart ? (nowMs - runStart) / 1000 : null;

        const prevNowName = pad.now?.name ?? "—";
        const prevNowId = pad.now?.id ?? null;

        pad.lastCompleteAt = nowMs;
        pad.lastRunEndedAt = nowMs;

        const nextNow = pad.onDeck ?? null;
        const nextOnDeck = pad.standby.length > 0 ? pad.standby[0] : null;
        const nextStandby = pad.standby.length > 0 ? pad.standby.slice(1) : [];

        pad.now = nextNow;
        pad.onDeck = nextOnDeck;
        pad.standby = nextStandby;

        clearArrivalForNow(pad);
        pad.breakStartAt = null;

        console.log(
          "[QUEUE_TRANSITION] judge:complete",
          "pad=", padId,
          "completed=", prevNowName,
          "newNow=", pad.now?.name ?? "—",
          "newOnDeck=", pad.onDeck?.name ?? "—",
          "standbyLen=", pad.standby.length,
          "durationSec=", durationSec,
        );

        startReportTimerForNow(pad, nowMs);

        if (durationSec !== null) updateCycleStats(state, pad, durationSec, nowMs);

        // Re-enforce schedule order after queue advancement
        enforceScheduleOrder(pad, state);

        // Track actual end on imported schedule slot
        if (state.scheduledSlots && prevNowId) {
          const slot = state.scheduledSlots.find(
            (sl) => sl.padId === padId && sl.teamId === prevNowId &&
              sl.status !== "SCRATCHED" && sl.status !== "SKIPPED"
          );
          if (slot) { slot.actualEndMs = nowMs; slot.status = "COMPLETE"; }
        }

        state.updatedAt = nowMs;

        pushAudit({
          ts: nowMs,
          padId,
          action: "COMPLETE",
          detail: `Completed. Prev NOW: ${prevNowName}. New NOW: ${pad.now?.name ?? "—"}`,
        });

        emitState();
      });

      socket.on("judge:hold", (payload: any) => {
        const padId = judgePadGate(socket, payload);
        if (padId == null) return;

        const nowMs = Date.now();
        const pad = getPadById(padId);
        if (!pad) return;

        snapshotForUndo(padId);

        pad.note = "HOLD";
        setStatus(pad, "HOLD", nowMs);
        (G.boardState as BoardState).updatedAt = nowMs;

        pushAudit({ ts: nowMs, padId, action: "HOLD", detail: "Hold set." });
        emitState();
      });

      socket.on("judge:dns", (payload: any) => {
        const padId = judgePadGate(socket, payload);
        if (padId == null) return;

        const nowMs = Date.now();
        const pad = getPadById(padId);
        if (!pad) return;

        snapshotForUndo(padId);
        markNowTeam(pad, "DNS", nowMs);
        (G.boardState as BoardState).updatedAt = nowMs;

        pushAudit({ ts: nowMs, padId, action: "DNS", detail: "Marked NOW DNS." });
        emitState();
      });

      socket.on("judge:dq", (payload: any) => {
        if (!isJudgeRole((socket as any).data?.role)) return;
        const padId = resolvePadId(payload);
        if (padId == null) return;

        const nowMs = Date.now();
        const pad = getPadById(padId);
        if (!pad) return;

        snapshotForUndo(padId);
        markNowTeam(pad, "DQ", nowMs);
        (G.boardState as BoardState).updatedAt = nowMs;

        pushAudit({ ts: nowMs, padId, action: "DQ", detail: "Marked NOW DQ." });
        emitState();
      });

      socket.on("judge:undo", (payload: any) => {
        const padId = judgePadGate(socket, payload);
        if (padId == null) return;

        const nowMs = Date.now();
        const ok = undoForPad(padId);
        if (G.boardState) (G.boardState as BoardState).updatedAt = nowMs;

        pushAudit({ ts: nowMs, padId, action: "UNDO", detail: ok ? "Undo successful." : "Undo not available." });
        emitState();
      });

      socket.on("judge:arrived", (payload: any) => {
        const padId = judgePadGate(socket, payload);
        if (padId == null) return;

        const nowMs = Date.now();
        const pad = getPadById(padId);
        if (!pad) return;

        snapshotForUndo(padId);
        markArrived(pad, nowMs);
        const state = G.boardState as BoardState;
        state.updatedAt = nowMs;

        // Track actual start on imported schedule slot
        if (state.scheduledSlots && pad.now) {
          const teamId = pad.now.id;
          const slot = state.scheduledSlots.find(
            (sl) => sl.padId === padId && sl.teamId === teamId &&
              sl.status !== "COMPLETE" && sl.status !== "SCRATCHED" && sl.status !== "SKIPPED"
          );
          if (slot) { slot.actualStartMs = nowMs; slot.status = "ON_PAD"; }
        }

        // Check schedule order: warn if there are earlier-order slots not yet started
        if (state.scheduledSlots && pad.now) {
          const activeSlots = getActiveSlotsForPad(state, padId);
          const nowTeamId = pad.now.id;
          const nowSlot = activeSlots.find((sl) => sl.teamId === nowTeamId);
          const expectedNext = activeSlots[0] ?? null;

          if (nowSlot && expectedNext && expectedNext.teamId !== nowTeamId) {
            // There is an earlier-order slot that hasn't run yet — warn judge
            const msg = `OUT OF ORDER: ${pad.now.name} (slot #${nowSlot.slotOrder}) is starting before ${expectedNext.teamName} (slot #${expectedNext.slotOrder}). Admin override required to continue.`;
            socket.emit?.("judge:orderWarning", { padId, message: msg, nowTeamName: pad.now.name, nowSlotOrder: nowSlot.slotOrder, expectedTeamName: expectedNext.teamName, expectedSlotOrder: expectedNext.slotOrder });
            pushAudit({ ts: nowMs, padId, action: "SCHEDULE_ORDER_VIOLATION", detail: msg });
          }
        }

        pushAudit({ ts: nowMs, padId, action: "ARRIVED", detail: "Marked arrived." });
        emitState();
      });

      socket.on("judge:swap", (payload: any) => {
        const padId = judgePadGate(socket, payload);
        if (padId == null) return;

        const nowMs = Date.now();
        const pad = getPadById(padId);
        if (!pad) return;

        snapshotForUndo(padId);
        swapNowOnDeck(pad, nowMs);
        (G.boardState as BoardState).updatedAt = nowMs;

        pushAudit({ ts: nowMs, padId, action: "SWAP", detail: "Swapped NOW/ONDECK." });
        emitState();
      });

      socket.on("judge:skipNow", (payload: any, ack?: (res: { ok: boolean; error?: string }) => void) => {
        const sendAck = (ok: boolean, error?: string) => {
          try {
            ack?.({ ok, error });
          } catch {}
        };

        const assignedPadId = (socket as any).data?.assignedPadId;
        const requestedPadId = payload?.padId ?? payload?.id ?? payload?.pad;
        const padId = judgePadGate(socket, payload);

        console.log("[judge:skipNow] assignedPadId=", assignedPadId, "requestedPadId=", requestedPadId, "resolvedPadId=", padId);

        if (padId == null) {
          const err = "Not assigned to this pad or no judging area selected.";
          socket.emit?.("judge:error", { message: err });
          sendAck(false, err);
          return;
        }

        const nowMs = Date.now();
        const pad = getPadById(padId);
        if (!pad) {
          const err = "Pad not found.";
          sendAck(false, err);
          return;
        }

        console.log("[judge:skipNow] BEFORE: now=", pad.now?.id ?? null, "onDeck=", pad.onDeck?.id ?? null, "standbyLen=", (pad.standby ?? []).length);

        if (!pad.now) {
          const err = "No team on pad to skip.";
          socket.emit?.("judge:error", { message: err });
          sendAck(false, err);
          return;
        }
        if (!pad.onDeck && (pad.standby?.length ?? 0) === 0) {
          const err = "Nothing to promote; cannot skip.";
          socket.emit?.("judge:error", { message: err });
          sendAck(false, err);
          return;
        }

        snapshotForUndo(padId);
        const ok = skipNow(pad, nowMs);
        (G.boardState as BoardState).updatedAt = nowMs;

        console.log("[judge:skipNow] AFTER ok=", ok, "now=", pad.now?.id ?? null, "onDeck=", pad.onDeck?.id ?? null, "standbyLen=", (pad.standby ?? []).length);

        if (!ok) {
          sendAck(false, "Skip failed.");
          return;
        }

        pushAudit({ ts: nowMs, padId, action: "SKIP", detail: "Skipped NOW team to standby end." });
        emitState();
        sendAck(true);
      });

      socket.on("judge:clear", (payload: any) => {
        const padId = judgePadGate(socket, payload);
        if (padId == null) return;

        const nowMs = Date.now();
        const pad = getPadById(padId);
        if (!pad) return;

        snapshotForUndo(padId);
        clearPad(pad, nowMs);
        (G.boardState as BoardState).updatedAt = nowMs;

        pushAudit({ ts: nowMs, padId, action: "CLEAR_PAD", detail: "Cleared area queue." });
        emitState();
      });

      socket.on("judge:startBreak", (payload: any) => {
        const padId = judgePadGate(socket, payload);
        if (padId == null) return;

        const state = G.boardState as BoardState;
        const nowMs = Date.now();
        const pad = getPadById(padId);
        if (!pad) return;

        const gbUntil = state.globalBreakUntilAt ?? null;
        const gbStart = state.globalBreakStartAt ?? null;
        const globalBreakActive = (!gbStart || nowMs >= gbStart) && !!gbUntil && nowMs < gbUntil;
        if (globalBreakActive) {
          pushAudit({ ts: nowMs, padId, action: "BREAK_BLOCKED", detail: "Blocked by global break." });
          return emitState();
        }

        snapshotForUndo(padId);

        const minutes = Number(payload?.minutes ?? 10);
        const reason = String(payload?.reason ?? "Break");
        const until = nowMs + Math.max(1, minutes) * 60 * 1000;

        pad.breakUntilAt = until;
        pad.breakReason = reason;
        pad.note = `BREAK: ${reason}`;

        // Break pauses pad operations. Clear reporting deadline so when break
        // ends (auto or manual) we start a fresh 5:00. Do NOT overwrite
        // reportByDeadlineAt with break end time (that caused LATE on expiry).
        pad.reportByTeamId = null;
        pad.reportByDeadlineAt = null;

        setStatus(pad, "BREAK", nowMs);
        state.updatedAt = nowMs;

        pushAudit({ ts: nowMs, padId, action: "BREAK_START", detail: `Break started: ${minutes} min (${reason})` });
        emitState();
      });

      socket.on("judge:endBreak", (payload: any) => {
        const padId = judgePadGate(socket, payload);
        if (padId == null) return;

        const nowMs = Date.now();
        const pad = getPadById(padId);
        if (!pad) return;

        snapshotForUndo(padId);

        applyBreakEnded(pad, nowMs);

        (G.boardState as BoardState).updatedAt = nowMs;
        pushAudit({ ts: nowMs, padId, action: "BREAK_END", detail: "Break ended" });
        emitState();
      });

      socket.on("judge:addTeam", (payload: any) => {
        const padId = judgePadGate(socket, payload);
        if (padId == null) return;

        const nowMs = Date.now();
        const pad = getPadById(padId);
        if (!pad) return;

        const where = String(payload?.where ?? "END").toUpperCase();
        const teamName = String(payload?.teamName ?? "").trim();
        if (!teamName) return;

        snapshotForUndo(padId);

        const teamId = String(payload?.teamId ?? uid()).trim();
        const team: Team = {
          id: teamId,
          name: teamName,
          unit: payload?.unit ? String(payload.unit) : undefined,
          category: payload?.category ? String(payload.category) : undefined,
          division: payload?.division === "Jr" || payload?.division === "Sr" ? payload.division : undefined,
          tag: "MANUAL",
        };

        const whereSafe: "NOW" | "ONDECK" | "END" = where === "NOW" ? "NOW" : where === "ONDECK" ? "ONDECK" : "END";

        insertTeamIntoPad(pad, nowMs, whereSafe, team);

        (G.boardState as BoardState).updatedAt = nowMs;
        pushAudit({ ts: nowMs, padId, action: "MANUAL_ADD", detail: `Added participant (${whereSafe}): ${team.name} (${team.id})` });
        emitState();
      });

      socket.on("judge:setPadLabel", (payload: any) => {
        const padId = judgePadGate(socket, payload);
        if (padId == null) return;

        const nowMs = Date.now();
        const pad = getPadById(padId);
        if (!pad) return;

        const label = String(payload?.label ?? "").trim();
        if (!label) return;

        snapshotForUndo(padId);

        pad.label = label;
        pad.updatedAt = nowMs;
        (G.boardState as BoardState).updatedAt = nowMs;

        pushAudit({ ts: nowMs, padId, action: "SET_LABEL", detail: `Set label: ${label}` });
        emitState();
      });

      // =========================
      // SCHEDULE CRUD (admin)
      // =========================
      socket.on("admin:schedule:setAll", (payload: any) => {
        if ((socket as any).data?.role !== "admin") return;
        const state = G.boardState as BoardState;
        const nowMs = Date.now();

        const raw = Array.isArray(payload?.schedule) ? payload.schedule : [];
        const list = raw
          .map((item: unknown) => safePatch(item, ["id", "title", "type", "scope", "padIds", "startAt", "endAt", "notes", "affectedCategories", "createdAt", "updatedAt"]))
          .filter((p: unknown): p is Record<string, unknown> => {
          const r = p as Record<string, unknown> | null;
          return !!(r != null && r.id && r.title != null && typeof r.startAt === "number" && typeof r.endAt === "number");
        });
        const normalized = normalizeSchedule(list as ScheduleEvent[]);
        state.schedule = normalized;
        state.scheduleUpdatedAt = nowMs;
        state.updatedAt = nowMs;

        pushAudit({ ts: nowMs, padId: null, action: "SCHEDULE_SET_ALL", detail: `Schedule replaced (${normalized.length} blocks)` });
        emitState();
      });

      socket.on("admin:schedule:add", (payload: any) => {
        if ((socket as any).data?.role !== "admin") return;
        const state = G.boardState as BoardState;
        const nowMs = Date.now();

        const e = safePatch(payload?.event, ["id", "title", "type", "scope", "padIds", "startAt", "endAt", "notes", "affectedCategories"]);
        if (!e) return;

        const event: ScheduleEvent = {
          id: e.id ? String(e.id) : uid(),
          title: String(e.title ?? "Untitled"),
          type: (e.type as ScheduleEvent["type"]) ?? "OTHER",
          scope: (e.scope as ScheduleEvent["scope"]) ?? "GLOBAL",
          padIds: e.scope === "PAD" ? (Array.isArray(e.padIds) ? e.padIds.map((n) => Number(n)) : []) : undefined,
          startAt: Number(e.startAt ?? 0),
          endAt: Number(e.endAt ?? 0),
          notes: e.notes ? String(e.notes) : undefined,
          affectedCategories: Array.isArray(e.affectedCategories) ? e.affectedCategories : undefined,
          createdAt: nowMs,
          updatedAt: nowMs,
        };

        state.schedule = normalizeSchedule([...(state.schedule ?? []), event]);
        state.scheduleUpdatedAt = nowMs;
        state.updatedAt = nowMs;

        pushAudit({ ts: nowMs, padId: null, action: "SCHEDULE_ADD", detail: `Added block: ${event.title}` });
        emitState();
      });

      socket.on("admin:schedule:update", (payload: any) => {
        if ((socket as any).data?.role !== "admin") return;
        const state = G.boardState as BoardState;
        const nowMs = Date.now();

        const id = String(payload?.id ?? "");
        const patch = safePatch(payload?.patch, ["title", "type", "scope", "padIds", "startAt", "endAt", "notes", "affectedCategories"]);
        if (!id || !patch) return;

        const next = (state.schedule ?? []).map((e) => (e.id === id ? { ...e, ...patch, updatedAt: nowMs } : e));
        state.schedule = normalizeSchedule(next);
        state.scheduleUpdatedAt = nowMs;
        state.updatedAt = nowMs;

        pushAudit({ ts: nowMs, padId: null, action: "SCHEDULE_UPDATE", detail: `Updated block: ${id}` });
        emitState();
      });

      socket.on("admin:schedule:delete", (payload: any) => {
        if ((socket as any).data?.role !== "admin") return;
        const state = G.boardState as BoardState;
        const nowMs = Date.now();

        const id = String(payload?.id ?? "");
        if (!id) return;

        state.schedule = normalizeSchedule((state.schedule ?? []).filter((e) => e.id !== id));
        state.scheduleUpdatedAt = nowMs;
        state.updatedAt = nowMs;

        pushAudit({ ts: nowMs, padId: null, action: "SCHEDULE_DELETE", detail: `Deleted block: ${id}` });
        emitState();
      });

      // =========================
      // IMPORTED COMPETITION SCHEDULE (admin:schedule:import / admin:schedule:clear)
      // Registered via originalOn (NOT socket.on) so the wrapper's catch block cannot
      // swallow the ack callback. This handler manages its own try/catch.
      // =========================
      originalOn("admin:schedule:import", (payload: any, ack?: (res: { ok: boolean; error?: string; count?: number }) => void) => {
        console.log("[schedImport] received payload");
        console.log("[schedImport] ack type:", typeof ack);

        // sendAck: always resolves ack, logs if ack is missing (would indicate client bug)
        const sendAck = (ok: boolean, error?: string, count?: number) => {
          if (typeof ack !== "function") {
            console.warn("[schedImport] sendAck called but ack is not a function — client will not receive response");
            return;
          }
          try {
            ack({ ok, error, count });
          } catch (e) {
            console.error("[schedImport] ack() threw:", e);
          }
        };

        console.log("[schedImport] received payload, role=", (socket as any).data?.role, "payload keys=", payload ? Object.keys(payload) : null);

        if ((socket as any).data?.role !== "admin") {
          console.warn("[admin:schedule:import] rejected: not admin");
          sendAck(false, "Unauthorized"); return;
        }

        if (!G.boardState) {
          console.error("[admin:schedule:import] rejected: no board state");
          sendAck(false, "Server not ready — board state not initialized"); return;
        }

        try {
          const state = G.boardState as BoardState;
          const nowMs = Date.now();

          // ── Flexible top-level detection ──────────────────────────────────
          // Accept: { slots: [...] }  or  { schedule: [...] }  or  [...] directly
          let rawSlots: unknown = payload?.slots ?? payload?.schedule ?? payload?.entries ?? payload?.data;
          if (!rawSlots && Array.isArray(payload)) rawSlots = payload;

          console.log("[schedImport] slots length:", Array.isArray(rawSlots) ? (rawSlots as any[]).length : "NOT_ARRAY", "type=", Array.isArray(rawSlots) ? "array" : typeof rawSlots);
          console.log("[schedImport] pads in state:", state.pads.map((p) => p.id));

          if (!Array.isArray(rawSlots) || rawSlots.length === 0) {
            sendAck(false, `Invalid format: expected a non-empty array at 'slots', 'schedule', or root. Got keys: ${payload && typeof payload === "object" ? Object.keys(payload).join(", ") : typeof payload}`);
            return;
          }

          // ── Per-slot normalization (accepts camelCase OR snake_case) ──────
          const VALID_STATUSES: SlotStatus[] = ["PLANNED","READY","ON_DECK","ON_PAD","COMPLETE","SCRATCHED","HELD","SKIPPED"];
          const parsed: ScheduleSlot[] = [];
          const warnings: string[] = [];

          for (let i = 0; i < rawSlots.length; i++) {
            const s = rawSlots[i] as any;
            if (!s || typeof s !== "object") { sendAck(false, `Slot[${i}] is not an object`); return; }

            // Accept slotId / slot_id / id
            const slotId = s.slotId ?? s.slot_id ?? s.id ?? s.slotID;
            if (!slotId) { sendAck(false, `Slot[${i}] missing slotId (also tried slot_id, id). Keys present: ${Object.keys(s).join(", ")}`); return; }

            // Accept padId / pad_id / pad / area / areaId / area_id — coerce string→number
            const rawPadId = s.padId ?? s.pad_id ?? s.pad ?? s.area ?? s.areaId ?? s.area_id ?? s.ring ?? s.lane;
            const padId = rawPadId != null ? Number(rawPadId) : NaN;
            if (!Number.isFinite(padId) || !Number.isInteger(padId)) {
              sendAck(false, `Slot[${i}] padId is missing or not an integer (value: ${JSON.stringify(rawPadId)}). Keys: ${Object.keys(s).join(", ")}`); return;
            }

            // Accept slotOrder / slot_order / order / sequence / position
            const rawOrder = s.slotOrder ?? s.slot_order ?? s.order ?? s.sequence ?? s.position ?? s.index ?? i;
            const slotOrder = Number(rawOrder);
            if (!Number.isFinite(slotOrder)) { sendAck(false, `Slot[${i}] slotOrder is not a number`); return; }

            // Accept teamId / team_id / competitorId / competitor_id / unitId / unit_id
            const teamId = s.teamId ?? s.team_id ?? s.competitorId ?? s.competitor_id ?? s.unitId ?? s.unit_id;
            if (!teamId) { sendAck(false, `Slot[${i}] missing teamId (also tried team_id, competitorId, unitId). Keys: ${Object.keys(s).join(", ")}`); return; }

            // Accept teamName / team_name / competitorName / competitor_name / name / unitName
            const teamName = s.teamName ?? s.team_name ?? s.competitorName ?? s.competitor_name ?? s.name ?? s.unitName ?? s.unit_name;
            if (!teamName) { sendAck(false, `Slot[${i}] missing teamName (also tried team_name, name, competitorName). Keys: ${Object.keys(s).join(", ")}`); return; }

            // Accept brigade / unit / org / organization / school
            const brigade = s.brigade ?? s.unit ?? s.org ?? s.organization ?? s.school ?? s.corps;

            // Accept anticipatedStart / anticipated_start / anticipatedStartTime / scheduledStart / scheduled_start / startTime / start_time
            const anticipatedStart = s.anticipatedStart ?? s.anticipated_start ?? s.anticipatedStartTime ?? s.scheduledStart ?? s.scheduled_start ?? s.startTime ?? s.start_time ?? s.time;

            const rawStatus = s.status ?? "PLANNED";
            const status: SlotStatus = VALID_STATUSES.includes(String(rawStatus).toUpperCase() as SlotStatus)
              ? (String(rawStatus).toUpperCase() as SlotStatus)
              : VALID_STATUSES.includes(rawStatus)
                ? rawStatus
                : "PLANNED";

            parsed.push({
              slotId: String(slotId),
              padId: Math.floor(padId),
              slotOrder: Number(slotOrder),
              teamId: String(teamId),
              teamName: String(teamName),
              brigade: brigade ? String(brigade) : undefined,
              category: s.category ?? s.event ?? s.eventType ?? s.event_type ? String(s.category ?? s.event ?? s.eventType ?? s.event_type) : undefined,
              division: s.division ?? s.div ? String(s.division ?? s.div) : undefined,
              anticipatedStart: anticipatedStart ? String(anticipatedStart) : undefined,
              status,
            });
          }

          console.log(`[admin:schedule:import] validated ${parsed.length} slots. Warnings: ${warnings.length}`);

          // ── Store schedule ────────────────────────────────────────────────
          state.scheduledSlots = parsed;
          state.scheduleImportedAt = nowMs;
          state.scheduleEventName = payload?.eventName ?? payload?.event_name ?? payload?.name
            ? String(payload?.eventName ?? payload?.event_name ?? payload?.name)
            : undefined;
          state.scheduleGeneratedBy = payload?.generatedBy ?? payload?.generated_by ?? payload?.source
            ? String(payload?.generatedBy ?? payload?.generated_by ?? payload?.source)
            : undefined;

          console.log("[admin:schedule:import] state.scheduledSlots set. eventName=", state.scheduleEventName);

          // ── Extract full team details (roster) for the inspection panel ────
          // Key by BOTH the slot-level teamId (same value slotToTeam sets on Team.id)
          // AND the nested team.teamId, so the client lookup always hits regardless of
          // which field was used to build the queue entry.
          const teamDetails: Record<string, TeamDetail> = {};
          for (const s of rawSlots as any[]) {
            // Slot-level teamId is the canonical queue identity (matches slotToTeam → Team.id)
            const slotTeamId = String(s?.teamId ?? s?.team_id ?? "").trim();
            const t = s?.team;
            const nestedTeamId = String(t?.teamId ?? "").trim();

            // Require at least one valid teamId
            const primaryKey = slotTeamId || nestedTeamId;
            if (!primaryKey) continue;

            const members: TeamMember[] = [];
            if (t && Array.isArray(t.members)) {
              for (const m of t.members) {
                members.push({
                  memberId: String(m.memberId ?? ""),
                  firstName: String(m.firstName ?? ""),
                  lastName: String(m.lastName ?? ""),
                  fullName: String(m.fullName ?? `${m.firstName ?? ""} ${m.lastName ?? ""}`).trim(),
                  rank: String(m.rank ?? ""),
                  grade: String(m.grade ?? ""),
                  gender: String(m.gender ?? ""),
                  role: m.role ? String(m.role) : null,
                  notes: m.notes ? String(m.notes) : null,
                  status: String(m.status ?? "ACTIVE"),
                });
              }
            }
            const detail: TeamDetail = {
              teamId: primaryKey,
              teamDisplayName: String(t?.teamDisplayName ?? t?.teamCode ?? s?.teamDisplayName ?? s?.teamName ?? ""),
              brigade: t?.brigade ? String(t.brigade) : undefined,
              brigadeNumber: t?.brigadeNumber != null ? Number(t.brigadeNumber) : undefined,
              schoolName: t?.schoolName ? String(t.schoolName) : undefined,
              unitName: t?.unitName ? String(t.unitName) : undefined,
              teamNumber: t?.teamNumber != null ? Number(t.teamNumber) : undefined,
              category: t?.category ? String(t.category) : (s?.category ? String(s.category) : undefined),
              division: t?.division ? String(t.division) : (s?.division ? String(s.division) : undefined),
              members,
              notes: s.notes ? String(s.notes) : null,
              warnings: Array.isArray(s.warnings) && s.warnings.length > 0 ? s.warnings.map(String) : undefined,
              constraints: Array.isArray(s.constraints) && s.constraints.length > 0 ? s.constraints.map(String) : undefined,
              sourceRowIds: Array.isArray(s.sourceRowIds) && s.sourceRowIds.length > 0 ? s.sourceRowIds.map(String) : undefined,
            };
            // Store under primary key (slot-level teamId preferred)
            teamDetails[primaryKey] = detail;
            // Also store under the nested team.teamId if it differs (belt-and-suspenders)
            if (nestedTeamId && nestedTeamId !== primaryKey) {
              teamDetails[nestedTeamId] = detail;
            }
          }
          state.teamDetails = teamDetails;
          const detailValues = Object.values(teamDetails);
          const totalMembers = detailValues.reduce((n, d) => n + (d.members?.length ?? 0), 0);
          const withRoster = detailValues.filter(d => (d.members?.length ?? 0) > 0).length;
          console.log(`[admin:schedule:import] teamDetails: ${Object.keys(teamDetails).length} keys, ${withRoster}/${detailValues.length} teams have roster, ${totalMembers} total members`);

          // ── Populate pad queues from schedule order ────────────────────────
          const padIdsTouched = new Set(parsed.map((sl) => sl.padId));
          console.log("[admin:schedule:import] padIdsTouched=", [...padIdsTouched], "known pads=", state.pads.map((p) => p.id));

          // Build padId → human name map (pad label like "Pad 1" from export)
          const padNameMap = new Map<number, string>();
          if (Array.isArray(payload?.pads)) {
            for (const p of payload.pads as any[]) {
              const pid = Number(p?.padId ?? p?.pad_id);
              const lbl = p?.padLabel ?? p?.pad_label ?? p?.name ?? p?.label;
              if (Number.isFinite(pid) && lbl) padNameMap.set(pid, String(lbl));
            }
          }
          for (const s of rawSlots as any[]) {
            const pid = Number(s?.padId ?? s?.pad_id);
            const lbl = s?.padLabel ?? s?.pad_label ?? s?.padName ?? s?.pad_name;
            if (Number.isFinite(pid) && lbl && !padNameMap.has(pid)) {
              padNameMap.set(pid, String(lbl));
            }
          }

          // Build padId → category/division label (from first slot per pad)
          const padCatMap = new Map<number, string>();
          for (const sl of parsed) {
            if (!padCatMap.has(sl.padId) && (sl.category || sl.division)) {
              const parts = [sl.category, sl.division].filter(Boolean);
              padCatMap.set(sl.padId, parts.join(" — "));
            }
          }

          // Process pads in ascending id order so they appear in lane order
          for (const padId of [...padIdsTouched].sort((a, b) => a - b)) {
            console.log("[schedImport] seeding pad", padId);
            let pad = getPadById(padId);
            if (!pad) {
              // Auto-create the pad from schedule data so areas appear immediately
              const name = padNameMap.get(padId) ?? `Pad ${padId}`;
              const label = padCatMap.get(padId) ?? "";
              pad = createPad({ id: padId, nowMs, name, label, seedDemoTeams: false });
              state.pads.push(pad);
              state.nextPadId = Math.max(state.nextPadId ?? 1, padId + 1);
              console.log(`[schedImport] auto-created pad ${padId}: name="${name}" label="${label}"`);
            }

            const activeSlots = getActiveSlotsForPad(state, padId);
            if (activeSlots.length === 0) continue;

            const arrivedActive = isArrivedForNow(pad);
            const currentNowId = pad.now?.id ?? null;
            const nowSlotMatch = currentNowId
              ? activeSlots.find((sl) => sl.teamId === currentNowId) ?? null
              : null;

            let remaining: ScheduleSlot[];

            if (nowSlotMatch && arrivedActive) {
              remaining = activeSlots.filter((sl) => sl.teamId !== currentNowId);
            } else {
              remaining = activeSlots;
              const first = remaining.shift();
              pad.now = first ? slotToTeam(first) : null;
              clearArrivalForNow(pad);
              pad.reportByDeadlineAt = null;
              pad.reportByTeamId = null;
              const isLive = state.eventStatus === "LIVE";
              if (isLive && pad.now) startReportTimerForNow(pad, nowMs);
            }

            pad.onDeck = remaining.length > 0 ? slotToTeam(remaining.shift()!) : null;
            pad.standby = remaining.map(slotToTeam);
            pad.updatedAt = nowMs;
            console.log(`[admin:schedule:import] pad ${padId} queue seeded: now=${pad.now?.name ?? "—"} onDeck=${pad.onDeck?.name ?? "—"} standby=${pad.standby.length}`);
          }

          // Keep pads in ascending id order (matches laneOrder for display)
          state.pads.sort((a, b) => a.id - b.id);
          recomputeNextPadId(state);
          state.updatedAt = nowMs;

          pushAudit({ ts: nowMs, padId: null, action: "SCHEDULE_IMPORT", detail: `Imported ${parsed.length} slots across ${padIdsTouched.size} pads. Event: ${state.scheduleEventName ?? "—"}` });
          emitState();

          console.log("[schedImport] sending success ack, count=", parsed.length);
          sendAck(true, undefined, parsed.length);

        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error("[schedImport] ERROR:", e);
          sendAck(false, `Server error: ${msg}`);
        }
      });
      console.log("[schedImport] handler registered for socket", socket.id);

      socket.on("admin:schedule:clearImport", (_payload: any, ack?: (res: { ok: boolean }) => void) => {
        if ((socket as any).data?.role !== "admin") { try { ack?.({ ok: false }); } catch {} return; }
        const state = G.boardState as BoardState;
        const nowMs = Date.now();

        state.scheduledSlots = undefined;
        state.scheduleImportedAt = undefined;
        state.scheduleEventName = undefined;
        state.scheduleGeneratedBy = undefined;
        state.teamDetails = undefined;
        state.updatedAt = nowMs;

        pushAudit({ ts: nowMs, padId: null, action: "SCHEDULE_IMPORT_CLEAR", detail: "Imported schedule cleared." });
        emitState();
        try { ack?.({ ok: true }); } catch {}
      });

      /**
       * admin:schedule:overrideOrder — explicitly acknowledge an out-of-order start.
       * Records the override in audit and reorders the schedule slots to reflect the
       * new execution order (skips the "expected" earlier slot to end of PLANNED).
       */
      socket.on("admin:schedule:overrideOrder", (payload: any) => {
        if ((socket as any).data?.role !== "admin") return;
        const state = G.boardState as BoardState;
        const nowMs = Date.now();

        const padId = Number(payload?.padId);
        const skipTeamId = String(payload?.skipTeamId ?? ""); // the earlier slot being bypassed
        if (!padId || !skipTeamId) return;

        if (state.scheduledSlots) {
          // Mark the bypassed slot as SKIPPED so it no longer blocks order checks
          const skipped = state.scheduledSlots.find(
            (sl) => sl.padId === padId && sl.teamId === skipTeamId
          );
          if (skipped) {
            skipped.status = "SKIPPED";
            // Remove that team from the pad queue if still present
            const pad = getPadById(padId);
            if (pad) {
              if (pad.onDeck?.id === skipTeamId) {
                pad.onDeck = pad.standby.length > 0 ? pad.standby.shift() ?? null : null;
              } else {
                pad.standby = pad.standby.filter((t) => t.id !== skipTeamId);
              }
            }
          }
        }

        state.updatedAt = nowMs;
        pushAudit({ ts: nowMs, padId, action: "SCHEDULE_ORDER_OVERRIDE", detail: `Admin overrode order: skipped slot for team ${skipTeamId}` });
        emitState();
      });

      // =========================
      // GLOBAL MESSAGE / BREAK (admin)
      // =========================
      socket.on("admin:setGlobalMessage", (payload: any) => {
        const state = G.boardState as BoardState;
        const nowMs = Date.now();

        const text = String(payload?.text ?? "").trim();
        const minutes = payload?.minutes != null ? Number(payload.minutes) : null;

        state.globalMessage = text || null;
        state.globalMessageUntilAt = text && minutes && Number.isFinite(minutes) ? nowMs + Math.max(1, minutes) * 60 * 1000 : null;

        state.updatedAt = nowMs;
        pushAudit({ ts: nowMs, padId: null, action: "GLOBAL_MESSAGE_SET", detail: text ? `Message set (${minutes ?? "∞"}m)` : "Message cleared" });
        emitState();
      });

      socket.on("admin:clearGlobalMessage", () => {
        if ((socket as any).data?.role !== "admin") return;
        const state = G.boardState as BoardState;
        const nowMs = Date.now();
        state.globalMessage = null;
        state.globalMessageUntilAt = null;
        state.updatedAt = nowMs;

        pushAudit({ ts: nowMs, padId: null, action: "GLOBAL_MESSAGE_CLEAR", detail: "Global message cleared" });
        emitState();
      });

      // =========================
      // EVENT HEADER LABEL (admin)
      // =========================
      socket.on("admin:setEventHeaderLabel", (payload: any) => {
        const state = G.boardState as BoardState;
        const nowMs = Date.now();

        const text = String(payload?.text ?? "").trim();
        (state as any).eventHeaderLabel = text || "COMPETITION MATRIX";

        state.updatedAt = nowMs;

        pushAudit({
          ts: nowMs,
          padId: null,
          action: "EVENT_HEADER_SET",
          detail: `Header set: ${(state as any).eventHeaderLabel}`,
        });

        emitState();
      });

      socket.on("admin:startGlobalBreak", (payload: any) => {
        if ((socket as any).data?.role !== "admin") return;
        const state = G.boardState as BoardState;
        const nowMs = Date.now();

        const minutes = Number(payload?.minutes ?? 60);
        const reason = String(payload?.reason ?? "Break");

        state.globalBreakStartAt = nowMs;
        state.globalBreakUntilAt = nowMs + Math.max(1, minutes) * 60 * 1000;
        state.globalBreakReason = reason;

        state.updatedAt = nowMs;
        pushAudit({ ts: nowMs, padId: null, action: "GLOBAL_BREAK_START", detail: `Global break started (${minutes}m): ${reason}` });
        emitState();
      });

      socket.on("admin:scheduleGlobalBreak", (payload: any) => {
        const state = G.boardState as BoardState;
        const nowMs = Date.now();

        const startAt = Number(payload?.startAt ?? 0);
        const minutes = Number(payload?.minutes ?? 60);
        const reason = String(payload?.reason ?? "Break");

        if (!Number.isFinite(startAt) || startAt <= 0) return;

        state.globalBreakStartAt = startAt;
        state.globalBreakUntilAt = startAt + Math.max(1, minutes) * 60 * 1000;
        state.globalBreakReason = reason;

        state.updatedAt = nowMs;
        pushAudit({ ts: nowMs, padId: null, action: "GLOBAL_BREAK_SCHEDULE", detail: `Global break scheduled @${new Date(startAt).toISOString()} (${minutes}m): ${reason}` });
        emitState();
      });

      socket.on("admin:endGlobalBreak", () => {
        if ((socket as any).data?.role !== "admin") return;
        const state = G.boardState as BoardState;
        const nowMs = Date.now();

        state.globalBreakStartAt = null;
        state.globalBreakUntilAt = null;
        state.globalBreakReason = null;
        state.updatedAt = nowMs;

        pushAudit({ ts: nowMs, padId: null, action: "GLOBAL_BREAK_END", detail: "Global break ended" });
        emitState();
      });
    });
  } else {
    loadStateIfNeeded();
  }

  return res.status(200).json({ ok: true, rosterLoaded: !!G.rosterLoaded });
}

export { ensureGlobals, sanitizeStateAfterAnyLoad, pushAudit };
