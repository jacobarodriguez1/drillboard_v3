// pages/admin.tsx
import Head from "next/head";
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";

import type {
  BoardState,
  ScheduleEvent,
  ScheduleType,
  ScheduleScope,
  Pad,
  Team,
} from "@/lib/state";
import { getCompetitionNowMs } from "@/lib/state";
import { getSocket } from "@/lib/socketClient";
import { fmtTime, buttonStyle, chipStyle } from "@/lib/ui";
import { requireAdminRole } from "@/lib/auth";
import {
  PadPrimarySection,
  PadOnDeckSection,
  PadStandbySection,
} from "@/components/PadLayout";
import { DateTimeField } from "@/components/DateTimeField";

const COLOR_ORANGE = "rgba(255,152,0,0.95)";
const COLOR_YELLOW = "rgba(255,235,59,0.95)";
const COLOR_RED = "var(--danger)";
const COLOR_BLUE = "var(--info)";

type AnySocket = {
  id?: string;
  connected?: boolean;
  on?: (event: string, cb: (...args: any[]) => void) => void;
  off?: (event: string, cb?: (...args: any[]) => void) => void;
  emit?: (event: string, payload?: any, callback?: (resp: any) => void) => void;
};

type AddWhere = "NOW" | "ONDECK" | "END";
type QueueFocus = "NOW" | "ONDECK" | "STANDBY";

/* =======================
   Shared styles (no TS errors)
   ======================= */
const modalBackdrop: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.60)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 16,
  zIndex: 120,
};

const modalCard: React.CSSProperties = {
  width: "min(560px, 100%)",
  borderRadius: 18,
  background: "rgba(10, 14, 28, 0.98)",
  border: "1px solid rgba(255,255,255,0.16)",
  boxShadow: "0 18px 50px rgba(0,0,0,0.45)",
  padding: 16,
};

const flatInput: React.CSSProperties = {
  padding: "8px 10px",
  borderRadius: 10,
  border: "1px solid rgba(255,255,255,0.14)",
  background: "rgba(0,0,0,0.25)",
  color: "white",
  outline: "none",
  width: "100%",
};

const pillButton = (active = false): React.CSSProperties => ({
  ...buttonStyle({
    bg: active ? "rgba(255,215,64,0.18)" : "rgba(0,0,0,0.25)",
    disabled: false,
  }),
  padding: "6px 10px",
  borderRadius: 999,
  fontWeight: 900,
});

/* =======================
   Helpers
   ======================= */
function isArrivedForNow(p: Pad): boolean {
  const nowId = p.now?.id ?? null;
  return (
    !!p.nowArrivedAt &&
    !!p.nowArrivedTeamId &&
    !!nowId &&
    p.nowArrivedTeamId === nowId
  );
}

function isReportValid(p: Pad, nowMs: number): boolean {
  const nowId = p.now?.id ?? null;
  if (!nowId) return false;
  if (!p.reportByTeamId || p.reportByTeamId !== nowId) return false;
  if (!p.reportByDeadlineAt) return false;
  if (isArrivedForNow(p)) return false;
  if (p.breakUntilAt && p.breakUntilAt > nowMs) return false;
  return true;
}

function padOpsStatus(
  p: Pad,
  nowMs: number,
): "ON PAD" | "REPORTING" | "LATE" | "BREAK" | "IDLE" {
  if (p.breakUntilAt && p.breakUntilAt > nowMs) return "BREAK";
  if (isArrivedForNow(p)) return "ON PAD";
  if (isReportValid(p, nowMs) && p.reportByDeadlineAt)
    return p.reportByDeadlineAt - nowMs < 0 ? "LATE" : "REPORTING";
  return "IDLE";
}

function statusPillColors(status: string) {
  switch (status) {
    case "BREAK":
      return { bg: COLOR_ORANGE, fg: "#111" };
    case "REPORTING":
      return { bg: COLOR_YELLOW, fg: "#111" };
    case "LATE":
      return { bg: COLOR_RED, fg: "white" };
    case "ON PAD":
      return { bg: COLOR_BLUE, fg: "#111" };
    default:
      return { bg: "rgba(255,255,255,0.16)", fg: "white" };
  }
}

function parsePadIdsAny(s: string): number[] {
  return s
    .split(",")
    .map((x) => Number(String(x).trim()))
    .filter((n) => Number.isFinite(n) && n > 0)
    .map((n) => Math.floor(n));
}

/**
 * Minimal CSV parser (no deps).
 * Supports: commas, quoted fields, CRLF, header row.
 */
function parseCsv(text: string): {
  headers: string[];
  rows: Record<string, string>[];
} {
  const s = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = s.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { headers: [], rows: [] };

  const parseLine = (line: string): string[] => {
    const out: string[] = [];
    let cur = "";
    let inQ = false;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];

      if (ch === '"') {
        const next = line[i + 1];
        if (inQ && next === '"') {
          cur += '"';
          i++;
        } else {
          inQ = !inQ;
        }
        continue;
      }

      if (ch === "," && !inQ) {
        out.push(cur.trim());
        cur = "";
        continue;
      }

      cur += ch;
    }

    out.push(cur.trim());
    return out.map((v) => v.replace(/^\uFEFF/, "").trim());
  };

  const headers = parseLine(lines[0]).map((h) => h.trim());
  const rows: Record<string, string>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = parseLine(lines[i]);
    const row: Record<string, string> = {};
    for (let c = 0; c < headers.length; c++)
      row[headers[c]] = (cols[c] ?? "").trim();
    rows.push(row);
  }

  return { headers, rows };
}

function normalizeHeader(h: string) {
  return String(h || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[_-]/g, "");
}

function pickFirstHeader(headers: string[], aliases: string[]): string | null {
  const normToRaw = new Map<string, string>();
  headers.forEach((h) => normToRaw.set(normalizeHeader(h), h));
  for (const a of aliases) {
    const raw = normToRaw.get(normalizeHeader(a));
    if (raw) return raw;
  }
  return null;
}

/* =======================
   COMM types (pad-based channels)
   ======================= */
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

type CommBroadcastTarget = "ALL" | "PAD";

function formatHhmm(ts: number) {
  if (!Number.isFinite(ts)) return "";
  try {
    return new Date(ts).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

/* =======================
   Page
   ======================= */
export default function AdminPage() {
  const [socket, setSocket] = useState<AnySocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [state, setState] = useState<BoardState | null>(null);
  const [, tick] = useState(0);

  // ✅ Event Header Label (live edit)
  const [eventHeaderDraft, setEventHeaderDraft] = useState("");
  const headerDebounceRef = useRef<number | null>(null);

  useEffect(() => {
    const live = (state as any)?.eventHeaderLabel ?? "COMPETITION MATRIX";
    setEventHeaderDraft(live);
  }, [(state as any)?.eventHeaderLabel]);

  // Global message
  const [msgText, setMsgText] = useState("");
  const [msgMinutes, setMsgMinutes] = useState(30);

  // Global break
  const [gbReason, setGbReason] = useState("Lunch");
  const [gbMinutes, setGbMinutes] = useState(60);
  const [gbStartLocal, setGbStartLocal] = useState("");

  // Schedule editor
  const [schTitle, setSchTitle] = useState("");
  const [schType, setSchType] = useState<ScheduleType>("COMPETE");
  const [schScope, setSchScope] = useState<ScheduleScope>("GLOBAL");
  const [schStart, setSchStart] = useState("");
  const [schEnd, setSchEnd] = useState("");
  const [schPadIds, setSchPadIds] = useState("1");
  const [schNotes, setSchNotes] = useState("");
  const [schError, setSchError] = useState<string | null>(null);

  // Areas
  const [newAreaName, setNewAreaName] = useState("");
  const [newAreaLabel, setNewAreaLabel] = useState("");
  const [confirmDeletePadId, setConfirmDeletePadId] = useState<number | null>(
    null,
  );

  // ✅ Clear All
  const [confirmClearAll, setConfirmClearAll] = useState(false);
  const [clearAllSuccessMsg, setClearAllSuccessMsg] = useState<string | null>(null);

  // Event Start Gate
  const [eventStatusMsg, setEventStatusMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirmStartNow, setConfirmStartNow] = useState(false);

  // ✅ Start New Event (reset)
  const [confirmStartNewEvent, setConfirmStartNewEvent] = useState(false);
  const [resetScope, setResetScope] = useState({
    clearComm: true,
    clearAudit: true,
    resetQueues: false,
    resetHeaderLabel: false,
    clearAreas: false,
  });
  const [resetSuccessMsg, setResetSuccessMsg] = useState<string | null>(null);
  const [resetError, setResetError] = useState<string | null>(null);
  const [resetErrorToast, setResetErrorToast] = useState<string | null>(null);

  // Add Participant modal (legacy quick-add)
  const [addModalPadId, setAddModalPadId] = useState<number | null>(null);
  const [addTeamName, setAddTeamName] = useState("");
  const [addTeamId, setAddTeamId] = useState("");
  const [addWhere, setAddWhere] = useState<AddWhere>("END");
  const [addError, setAddError] = useState<string | null>(null);

  // Import Roster (CSV)
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importNote, setImportNote] = useState<string | null>(null);

  // ✅ Queue Manager modal (linked NOW/ONDECK/STBY)
  const [queueModalPadId, setQueueModalPadId] = useState<number | null>(null);
  const [queueFocus, setQueueFocus] = useState<QueueFocus>("STANDBY");

  const [qmAddName, setQmAddName] = useState("");
  const [qmAddId, setQmAddId] = useState("");

  const [qmEditOriginalId, setQmEditOriginalId] = useState<string | null>(null);
  const [qmEditName, setQmEditName] = useState("");
  const [qmEditId, setQmEditId] = useState("");

  /* =======================
     Admin comm state (pad-based channels)
     ======================= */
  const [commSnap, setCommSnap] = useState<CommSnapshot | null>(null);
  const [commSelectedPadId, setCommSelectedPadId] = useState<number | null>(
    null,
  );
  const [commDraft, setCommDraft] = useState("");
  const [commUrgent, setCommUrgent] = useState(false);
  const [commBusy, setCommBusy] = useState(false);
  const [commErr, setCommErr] = useState<string | null>(null);

  const [bcText, setBcText] = useState("");
  const [bcTarget, setBcTarget] = useState<CommBroadcastTarget>("ALL");
  const [bcPadId, setBcPadId] = useState("1");
  const [bcTtl, setBcTtl] = useState<number>(120);

  /* Unread message awareness (client-side only) */
  const [lastReadTsByPad, setLastReadTsByPad] = useState<Record<number, number>>(
    () => ({}),
  );
  const [lastJudgeMsgTsByPad, setLastJudgeMsgTsByPad] = useState<
    Record<number, number>
  >(() => ({}));
  const [toast, setToast] = useState<{
    open: boolean;
    text: string;
    kind: "info" | "urgent";
    padId?: number;
  }>({ open: false, text: "", kind: "info" });
  const toastTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [commListTab, setCommListTab] = useState<"inbox" | "pads">("inbox");
  const [inboxFilter, setInboxFilter] = useState<"unread" | "recent">("unread");
  const chatViewportRef = useRef<HTMLDivElement | null>(null);
  const msgElByIdRef = useRef<Record<string, HTMLDivElement | null>>({});

  useEffect(() => {
    fetch("/api/socket");
    const s = getSocket() as any;
    setSocket(s ?? null);
    if (!s?.on) return;

    const onConnect = () => {
      setConnected(true);
      // ✅ register admin for comms
      try {
        s.emit?.("comm:register", { role: "admin" });
      } catch {}
    };
    const onDisconnect = () => setConnected(false);
    const onConnectError = (err: Error) => {
      console.error("[socket] connect_error:", err?.message ?? err);
    };
    const onState = (next: BoardState) => setState(next);
    const onCommSnapshot = (snap: CommSnapshot) => setCommSnap(snap);

    s.on("connect", onConnect);
    s.on("disconnect", onDisconnect);
    s.on("connect_error", onConnectError);
    s.on("state", onState);
    s.on("comm:snapshot", onCommSnapshot);

    setConnected(Boolean(s.connected));
    if (Boolean(s.connected)) {
      try {
        s.emit?.("comm:register", { role: "admin" });
      } catch {}
    }

    const interval = setInterval(() => tick((t) => t + 1), 1000);

    return () => {
      s.off?.("connect", onConnect);
      s.off?.("disconnect", onDisconnect);
      s.off?.("connect_error", onConnectError);
      s.off?.("state", onState);
      s.off?.("comm:snapshot", onCommSnapshot);
      clearInterval(interval);
    };
  }, []);

  const canAct = !!socket?.emit && connected;
  const nowMs = Date.now();
  const compNowMs = getCompetitionNowMs(state ?? null, nowMs);
  const effectiveNow = compNowMs ?? nowMs;

  function emit(event: string, payload?: any) {
    if (!canAct) return;
    socket!.emit!(event, payload);
  }

  const setEventHeaderLabelLive = (text: string) =>
    emit("admin:setEventHeaderLabel", { text });

  const onChangeEventHeaderLabel = (v: string) => {
    setEventHeaderDraft(v);
    if (headerDebounceRef.current)
      window.clearTimeout(headerDebounceRef.current);
    headerDebounceRef.current = window.setTimeout(
      () => setEventHeaderLabelLive(v),
      200,
    );
  };

  // Header controls
  const [reloadRosterMsg, setReloadRosterMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const doReloadRoster = () => {
    setReloadRosterMsg(null);
    socket?.emit?.("admin:reloadRoster", (ack?: { ok?: boolean; error?: string; detail?: string }) => {
      if (ack?.ok) {
        setReloadRosterMsg({ ok: true, text: "Roster reloaded." });
      } else {
        setReloadRosterMsg({ ok: false, text: ack?.error ?? ack?.detail ?? "Reload failed." });
      }
      setTimeout(() => setReloadRosterMsg(null), 5000);
    });
  };

  // ✅ Clear All handler (deletes ALL areas + clears queues)
  const doClearAll = () => {
    setConfirmClearAll(false);
    socket?.emit?.(
      "admin:clearAllQueues",
      { clearAreas: true },
      (ack?: { ok?: boolean; error?: string }) => {
        if (ack?.ok) {
          setClearAllSuccessMsg("All areas cleared.");
          setTimeout(() => setClearAllSuccessMsg(null), 5000);
        }
      },
    );
  };

  // ✅ Start New Event handler
  const doStartNewEvent = () => {
    setResetError(null);
    const payload = {
      clearComm: resetScope.clearComm,
      clearBroadcasts: resetScope.clearComm,
      clearAudit: resetScope.clearAudit,
      resetQueues: resetScope.resetQueues,
      preservePads: true,
      resetHeaderLabel: resetScope.resetHeaderLabel,
      clearAreas: resetScope.clearAreas,
    };
    const errMsg = "No response from server. Check connection and try again.";
    const ackTimeout = setTimeout(() => {
      setConfirmStartNewEvent(false);
      setResetError(null);
      setResetErrorToast(errMsg);
      setTimeout(() => setResetErrorToast(null), 8000);
    }, 10000);
    socket?.emit?.("admin:event:reset", payload, (ack?: { ok?: boolean; error?: string }) => {
      clearTimeout(ackTimeout);
      setConfirmStartNewEvent(false);
      if (ack?.ok) {
        setResetSuccessMsg("New event started. Ops Chat cleared.");
        setTimeout(() => setResetSuccessMsg(null), 5000);
      } else {
        const err = ack?.error ?? "Reset failed (no response)";
        setResetError(err);
        setResetErrorToast(err);
        console.error("[Start New Event]", err);
        setTimeout(() => {
          setResetError(null);
          setResetErrorToast(null);
        }, 8000);
      }
    });
  };

  // Global message
  const doSetMessage = () =>
    emit("admin:setGlobalMessage", {
      text: msgText.trim(),
      minutes: msgMinutes,
    });
  const doClearMessage = () => emit("admin:clearGlobalMessage");

  // Global break
  const doStartGlobalBreakNow = () =>
    emit("admin:startGlobalBreak", {
      minutes: gbMinutes,
      reason: gbReason.trim() || "Break",
    });
  const doScheduleGlobalBreak = () => {
    if (!gbStartLocal) return;
    const startAt = new Date(gbStartLocal).getTime();
    emit("admin:scheduleGlobalBreak", {
      startAt,
      minutes: gbMinutes,
      reason: gbReason.trim() || "Break",
    });
  };
  const doEndGlobalBreak = () => emit("admin:endGlobalBreak");

  // Schedule
  const schedule = useMemo(
    () => (state?.schedule ?? []).slice().sort((a, b) => a.startAt - b.startAt),
    [state?.schedule],
  );

  const nowGlobal = useMemo(
    () =>
      schedule
        .filter((e) => e.scope === "GLOBAL")
        .find((e) => nowMs >= e.startAt && nowMs < e.endAt) ?? null,
    [schedule, nowMs],
  );

  const nextGlobal = useMemo(
    () =>
      schedule
        .filter((e) => e.scope === "GLOBAL" && e.startAt > nowMs)
        .sort((a, b) => a.startAt - b.startAt)[0] ?? null,
    [schedule, nowMs],
  );

  function addScheduleEvent() {
    setSchError(null);
    if (!canAct) return setSchError("Not connected (LIVE).");
    if (!schTitle.trim()) return setSchError("Title is required.");
    if (!schStart || !schEnd)
      return setSchError("Start and End time are required.");

    const startAt = new Date(schStart).getTime();
    const endAt = new Date(schEnd).getTime();
    if (!Number.isFinite(startAt) || !Number.isFinite(endAt))
      return setSchError("Invalid date/time format.");
    if (endAt <= startAt)
      return setSchError("End time must be after Start time.");

    const padIds = schScope === "PAD" ? parsePadIdsAny(schPadIds) : undefined;
    if (schScope === "PAD" && (!padIds || padIds.length === 0))
      return setSchError("Pad IDs required for PAD-scoped events (e.g., 3,4).");

    const event: Omit<ScheduleEvent, "id"> & { id?: never } = {
      title: schTitle.trim(),
      type: schType,
      scope: schScope,
      padIds,
      startAt,
      endAt,
      notes: schNotes.trim() || undefined,
    };

    emit("admin:schedule:add", { event });
  }

  const updateEvent = (id: string, patch: Partial<ScheduleEvent>) =>
    emit("admin:schedule:update", { id, patch });
  const deleteEvent = (id: string) => emit("admin:schedule:delete", { id });

  // Pad health (admin only)
  const padHealth = useMemo(() => {
    const pads = state?.pads ?? [];
    return pads.map((p) => ({
      id: p.id,
      label: p.label,
      status: padOpsStatus(p, effectiveNow),
    }));
  }, [state?.pads, effectiveNow]);

  // Areas
  const areas = useMemo(
    () => (state?.pads ?? []).slice().sort((a, b) => a.id - b.id),
    [state?.pads],
  );

  const addArea = () => {
    emit("admin:pad:add", {
      name: newAreaName.trim() || undefined,
      label: newAreaLabel.trim() || undefined,
    });
    setNewAreaName("");
    setNewAreaLabel("");
  };

  const saveArea = (padId: number, name: string, label: string) => {
    emit("admin:pad:update", { padId, name: name.trim(), label: label.trim() });
  };

  const requestDelete = (padId: number) => setConfirmDeletePadId(padId);
  const confirmDelete = () => {
    if (confirmDeletePadId == null) return;
    emit("admin:pad:delete", { padId: confirmDeletePadId });
    setConfirmDeletePadId(null);
  };

  // Add Participant actions (legacy quick-add)
  const openAddModal = (padId: number) => {
    setAddModalPadId(padId);
    setAddTeamName("");
    setAddTeamId("");
    setAddWhere("END");
    setAddError(null);
  };

  const closeAddModal = () => {
    setAddModalPadId(null);
    setAddTeamName("");
    setAddTeamId("");
    setAddWhere("END");
    setAddError(null);
  };

  const confirmAddParticipant = () => {
    setAddError(null);
    if (!canAct) return setAddError("Not connected (LIVE).");
    if (addModalPadId == null) return setAddError("No area selected.");
    const teamName = addTeamName.trim();
    const teamId = addTeamId.trim();
    if (!teamName) return setAddError("Team Name is required.");
    if (!teamId) return setAddError("Team ID is required.");

    emit("admin:team:add", {
      padId: addModalPadId,
      where: addWhere,
      teamName,
      teamId,
    });
    closeAddModal();
  };

  // Import Roster actions
  const IMPORT_TOOLTIP =
    `CSV only (must include a header row).\n\n` +
    `Required columns:\n` +
    `[pad/area/station/location/ring/lane/classroom/number], teamId, teamName\n\n` +
    `• First column sets the Area number (e.g., 1, 2, 3)\n` +
    `• Missing Areas are created automatically (1..max)\n` +
    `• Teams import in file order into Standby (END)\n` +
    `• Admin can rearrange/promote in Queue Manager`;

  const clickImport = () => {
    setImportError(null);
    setImportNote(null);
    fileInputRef.current?.click();
  };

  const handleImportFile = async (file: File | null) => {
    setImportError(null);
    setImportNote(null);
    if (!file) return;

    if (!/\.csv$/i.test(file.name)) {
      setImportError("CSV only. Please upload a .csv file.");
      return;
    }

    if (!canAct) {
      setImportError("Not connected (LIVE).");
      return;
    }

    let text = "";
    try {
      text = await file.text();
    } catch {
      setImportError("Could not read file.");
      return;
    }

    const { headers, rows } = parseCsv(text);
    if (!headers.length) {
      setImportError("CSV appears empty (no header row found).");
      return;
    }

    const locationAliases = [
      "pad",
      "area",
      "station",
      "location",
      "ring",
      "lane",
      "classroom",
      "number",
      "padid",
      "areaid",
      "stationid",
    ];
    const locHeader = pickFirstHeader(headers, locationAliases);
    const teamIdHeader = pickFirstHeader(headers, [
      "teamId",
      "teamID",
      "id",
      "team",
    ]);
    const teamNameHeader = pickFirstHeader(headers, [
      "teamName",
      "team",
      "name",
    ]);

    if (!locHeader)
      return setImportError(
        `Missing location column. Accepted headers: pad, area, station, location, ring, lane, classroom, number.`,
      );
    if (!teamIdHeader)
      return setImportError(
        `Missing teamId column (accepted: teamId, teamID, id, team).`,
      );
    if (!teamNameHeader)
      return setImportError(
        `Missing teamName column (accepted: teamName, team, name).`,
      );

    const errors: string[] = [];
    const cleaned: { padId: number; teamId: string; teamName: string }[] = [];

    rows.forEach((r, idx) => {
      const rowNum = idx + 2;
      const rawLoc = String(r[locHeader] ?? "").trim();
      const rawTeamId = String(r[teamIdHeader] ?? "").trim();
      const rawTeamName = String(r[teamNameHeader] ?? "").trim();

      const padId = Number(rawLoc);

      if (!rawLoc) errors.push(`Row ${rowNum}: missing ${locHeader}`);
      if (!Number.isFinite(padId) || padId <= 0)
        errors.push(
          `Row ${rowNum}: invalid ${locHeader} "${rawLoc}" (must be 1,2,3...)`,
        );
      if (!rawTeamId) errors.push(`Row ${rowNum}: missing ${teamIdHeader}`);
      if (!rawTeamName) errors.push(`Row ${rowNum}: missing ${teamNameHeader}`);

      if (
        rawLoc &&
        Number.isFinite(padId) &&
        padId > 0 &&
        rawTeamId &&
        rawTeamName
      ) {
        cleaned.push({
          padId: Math.floor(padId),
          teamId: rawTeamId,
          teamName: rawTeamName,
        });
      }
    });

    if (errors.length) {
      setImportError(
        errors.slice(0, 25).join("\n") +
          (errors.length > 25 ? `\n...and ${errors.length - 25} more` : ""),
      );
      return;
    }
    if (cleaned.length === 0) return setImportError("No valid rows found.");

    const maxPadId = Math.max(...cleaned.map((r) => r.padId));
    emit("admin:pads:ensure", { maxPadId });

    setTimeout(() => {
      cleaned.forEach((row) => {
        emit("admin:team:add", {
          padId: row.padId,
          where: "END",
          teamId: row.teamId,
          teamName: row.teamName,
        });
      });
    }, 200);

    const padsTouched = new Set(cleaned.map((r) => r.padId));
    setImportNote(
      `Imported ${cleaned.length} team(s) into Standby across ${padsTouched.size} area(s), in file order.`,
    );
  };

  const globalBreakActive = useMemo(() => {
    const start = state?.globalBreakStartAt ?? null;
    const until = state?.globalBreakUntilAt ?? null;
    if (start && start > nowMs) return false;
    return !!until && nowMs < until;
  }, [state?.globalBreakStartAt, state?.globalBreakUntilAt, nowMs]);

  const globalBreakRemaining =
    globalBreakActive && state?.globalBreakUntilAt
      ? (state.globalBreakUntilAt - effectiveNow) / 1000
      : null;

  // ✅ Queue Manager derived
  const queuePad = useMemo(() => {
    if (queueModalPadId == null) return null;
    return (state?.pads ?? []).find((p) => p.id === queueModalPadId) ?? null;
  }, [state?.pads, queueModalPadId]);

  const openQueueManager = (padId: number, focus: QueueFocus) => {
    setQueueModalPadId(padId);
    setQueueFocus(focus);
    setQmAddName("");
    setQmAddId("");
    setQmEditOriginalId(null);
    setQmEditName("");
    setQmEditId("");
  };

  const closeQueueManager = () => {
    setQueueModalPadId(null);
    setQmAddName("");
    setQmAddId("");
    setQmEditOriginalId(null);
    setQmEditName("");
    setQmEditId("");
  };

  const startEdit = (teamId: string, name: string) => {
    setQmEditOriginalId(teamId);
    setQmEditId(teamId);
    setQmEditName(name);
  };

  const cancelEdit = () => {
    setQmEditOriginalId(null);
    setQmEditName("");
    setQmEditId("");
  };

  const saveEditTeam = (padId: number) => {
    if (!qmEditOriginalId) return;
    const name = qmEditName.trim();
    const id = qmEditId.trim();
    if (!name || !id) return;
    emit("admin:queue:updateTeam", {
      padId,
      teamId: qmEditOriginalId,
      patch: { name, id },
    });
    cancelEdit();
  };

  const qmAddToStandby = (padId: number) => {
    const name = qmAddName.trim();
    const id = qmAddId.trim();
    if (!name || !id) return;
    emit("admin:team:add", { padId, where: "END", teamName: name, teamId: id });
    setQmAddName("");
    setQmAddId("");
  };

  const qmMoveStandby = (padId: number, from: number, to: number) =>
    emit("admin:standby:move", { padId, from, to });
  const qmRemoveStandby = (padId: number, teamId: string) =>
    emit("admin:standby:remove", { padId, teamId });
  const qmSetSlot = (padId: number, teamId: string, target: "NOW" | "ONDECK") =>
    emit("admin:queue:setSlot", { padId, teamId, target });
  const qmDemote = (padId: number, from: "NOW" | "ONDECK", to: "TOP" | "END") =>
    emit("admin:queue:demote", { padId, from, to });
  const qmSwap = (padId: number) => emit("admin:queue:swap", { padId });

  /* =======================
     Comm derived + actions (pad-based)
     ======================= */
  const commChannels = useMemo(
    () => (commSnap?.channels ?? []).slice(),
    [commSnap?.channels],
  );

  useEffect(() => {
    if (commChannels.length === 0) {
      setCommSelectedPadId(null);
      return;
    }
    if (commSelectedPadId == null) setCommSelectedPadId(commChannels[0].padId);
    else if (!commChannels.some((c) => c.padId === commSelectedPadId)) {
      setCommSelectedPadId(commChannels[0]?.padId ?? null);
    }
  }, [commChannels, commSelectedPadId]);

  const selectedChannel = useMemo(
    () => commChannels.find((c) => c.padId === commSelectedPadId) ?? null,
    [commChannels, commSelectedPadId],
  );

  const selectedChat = useMemo(
    () => (selectedChannel?.messages ?? []).slice(),
    [selectedChannel?.messages],
  );

  /* Unread counts + per-pad metadata for list rendering */
  const {
    unreadCountByPad,
    hasUrgentUnreadByPad,
    totalUnread,
    lastMsgTsByPad,
    lastSnippetByPad,
    lastUnreadJudgeTsByPad,
    renderChannels,
  } = useMemo(() => {
    const unread: Record<number, number> = {};
    const urgent: Record<number, boolean> = {};
    const lastTs: Record<number, number> = {};
    const snippet: Record<number, string> = {};
    const lastUnreadTs: Record<number, number> = {};
    let total = 0;

    for (const c of commChannels) {
      const lastRead = lastReadTsByPad[c.padId] ?? 0;
      let count = 0;
      let hasUrgent = false;
      let latestTs = 0;
      let latestSnippet = "";
      let maxUnreadJudgeTs = 0;

      for (const m of c.messages) {
        if (m.ts > latestTs) {
          latestTs = m.ts;
          latestSnippet = m.text.slice(0, 60).replace(/\n/g, " ") || "(no text)";
        }
        if (m.from !== "JUDGE") continue;
        if (m.ts > lastRead) {
          count++;
          if (m.urgent && !m.ackedAt) hasUrgent = true;
          if (m.ts > maxUnreadJudgeTs) maxUnreadJudgeTs = m.ts;
        }
      }

      unread[c.padId] = count;
      urgent[c.padId] = hasUrgent;
      lastTs[c.padId] = latestTs;
      snippet[c.padId] = latestSnippet;
      lastUnreadTs[c.padId] = maxUnreadJudgeTs;
      total += count;
    }

    let channels: PadChannel[];
    if (commListTab === "pads") {
      channels = [...commChannels].sort((a, b) => a.padId - b.padId);
    } else {
      if (inboxFilter === "unread") {
        channels = commChannels
          .filter((c) => (unread[c.padId] ?? 0) > 0)
          .sort(
            (a, b) =>
              (lastUnreadTs[b.padId] ?? 0) - (lastUnreadTs[a.padId] ?? 0),
          );
      } else {
        channels = commChannels
          .filter((c) => (lastTs[c.padId] ?? 0) > 0)
          .sort((a, b) => (lastTs[b.padId] ?? 0) - (lastTs[a.padId] ?? 0));
      }
    }

    return {
      unreadCountByPad: unread,
      hasUrgentUnreadByPad: urgent,
      totalUnread: total,
      lastMsgTsByPad: lastTs,
      lastSnippetByPad: snippet,
      lastUnreadJudgeTsByPad: lastUnreadTs,
      renderChannels: channels,
    };
  }, [
    commChannels,
    lastReadTsByPad,
    commListTab,
    inboxFilter,
  ]);

  const hasSeenInitialCommRef = useRef(false);
  /* Incoming judge message detection: show toast, update lastJudgeMsgTsByPad */
  useEffect(() => {
    if (!commChannels.length) return;
    for (const c of commChannels) {
      const judgeMsgs = c.messages.filter((m) => m.from === "JUDGE");
      if (judgeMsgs.length === 0) continue;
      const latest = judgeMsgs.reduce((a, b) => (b.ts > a.ts ? b : a), judgeMsgs[0]);
      const prev = lastJudgeMsgTsByPad[c.padId] ?? 0;
      if (latest.ts > prev) {
        setLastJudgeMsgTsByPad((p) => ({ ...p, [c.padId]: latest.ts }));
        if (!hasSeenInitialCommRef.current) {
          hasSeenInitialCommRef.current = true;
          continue;
        }
        const isUrgent = !!latest.urgent && !latest.ackedAt;
        setToast({
          open: true,
          text: isUrgent
            ? `Urgent message from ${c.name}`
            : `New message from ${c.name}`,
          kind: isUrgent ? "urgent" : "info",
          padId: c.padId,
        });
        if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
        toastTimeoutRef.current = setTimeout(() => {
          setToast((t) => ({ ...t, open: false }));
          toastTimeoutRef.current = null;
        }, 4000);
      }
    }
    if (commChannels.length > 0) hasSeenInitialCommRef.current = true;
  }, [commSnap?.channels]);

  /* IntersectionObserver: mark judge messages READ when >=60% visible */
  useEffect(() => {
    const padId = commSelectedPadId;
    if (padId == null) return;
    const viewport = chatViewportRef.current;
    if (!viewport) return;
    const chat = selectedChat.filter((m) => m.from === "JUDGE");
    if (chat.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const el = entry.target as HTMLElement;
          const mts = Number(el.getAttribute("data-mts"));
          const pid = Number(el.getAttribute("data-padid"));
          if (!Number.isFinite(mts) || !Number.isFinite(pid)) continue;
          setLastReadTsByPad((prev) => {
            const cur = prev[pid] ?? 0;
            if (mts <= cur) return prev;
            return { ...prev, [pid]: Math.max(cur, mts) };
          });
        }
      },
      { root: viewport, threshold: 0.6 },
    );

    const raf = requestAnimationFrame(() => {
      for (const m of chat) {
        const el = msgElByIdRef.current[m.id];
        if (el) observer.observe(el);
      }
    });

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, [commSelectedPadId, selectedChat]);

  /* Toast cleanup on unmount */
  useEffect(
    () => () => {
      if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
    },
    [],
  );

  const sendAdminChat = () => {
    setCommErr(null);
    const text = commDraft.trim();
    if (!text) return;
    if (!canAct) return setCommErr("Not connected (LIVE).");
    if (commSelectedPadId == null)
      return setCommErr("Select a pad channel first.");

    setCommBusy(true);
    emit("admin:comm:send", {
      toPadId: commSelectedPadId,
      text,
      urgent: commUrgent,
    });
    setCommDraft("");
    setTimeout(() => setCommBusy(false), 250);
  };

  const sendBroadcast = () => {
    setCommErr(null);
    const text = bcText.trim();
    if (!text) return;
    if (!canAct) return setCommErr("Not connected (LIVE).");

    const ttlSeconds = Math.max(20, Math.min(1800, Number(bcTtl || 120)));

    if (bcTarget === "PAD") {
      const pid = Math.floor(Number(bcPadId));
      if (!Number.isFinite(pid) || pid <= 0)
        return setCommErr("PAD broadcast requires a valid padId (e.g., 3).");
      emit("admin:comm:broadcast", {
        text,
        target: "PAD",
        padId: pid,
        ttlSeconds,
      });
    } else {
      emit("admin:comm:broadcast", { text, target: "ALL", ttlSeconds });
    }

    setBcText("");
  };

  return (
    <>
      <Head>
        <title>Competition Matrix — Admin</title>
      </Head>

      {toast.open ? (
        <div
          style={{
            position: "fixed",
            top: 16,
            right: 16,
            zIndex: 200,
            padding: "12px 16px",
            borderRadius: 12,
            border: "1px solid rgba(255,255,255,0.2)",
            background:
              toast.kind === "urgent"
                ? "rgba(198,40,40,0.95)"
                : "rgba(33,150,243,0.95)",
            color: "white",
            boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
            display: "flex",
            alignItems: "center",
            gap: 12,
          }}
        >
          <span style={{ fontWeight: 600 }}>{toast.text}</span>
          {toast.padId != null ? (
            <button
              onClick={() => {
                setCommSelectedPadId(toast.padId!);
                setToast((t) => ({ ...t, open: false }));
                if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
              }}
              style={{
                padding: "6px 12px",
                borderRadius: 8,
                border: "1px solid rgba(255,255,255,0.5)",
                background: "rgba(255,255,255,0.2)",
                color: "white",
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              View
            </button>
          ) : null}
        </div>
      ) : null}

      <main
        className="responsive-page"
        style={{
          minHeight: "100vh",
          background: "var(--page-bg)",
          color: "var(--text-primary)",
          padding: 18,
          fontFamily: "system-ui",
        }}
      >
        {/* =======================
            Header
           ======================= */}
        <header
          className="admin-header-inner"
          style={{
            borderRadius: 12,
            background: "var(--surface-1)",
            border: "1px solid var(--border-crisp)",
            padding: "16px 18px",
            display: "flex",
            gap: 14,
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
            boxShadow: "0 4px 16px rgba(0,0,0,0.35)",
          }}
        >
          <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
            <img
              src="/cacc-shield.png"
              alt="California Cadet Corps"
              style={{
                width: 132,
                height: 132,
                objectFit: "contain",
                borderRadius: 14,
                background: "rgba(0,0,0,0.25)",
                border: "1px solid rgba(255,255,255,0.14)",
                padding: 10,
              }}
            />

            <div>
              <div
                style={{
                  fontSize: 22,
                  fontWeight: 900,
                  letterSpacing: 1.2,
                  opacity: 0.92,
                  lineHeight: 1.1,
                }}
              >
                CALIFORNIA CADET CORPS
              </div>

              <div
                style={{
                  display: "flex",
                  gap: 12,
                  alignItems: "baseline",
                  flexWrap: "wrap",
                  marginTop: 6,
                }}
              >
                <div
                  style={{ fontSize: 40, fontWeight: 1000, lineHeight: 1.05 }}
                >
                  ADMIN CONSOLE
                </div>
                <div style={{ fontSize: 12, color: "var(--text-tertiary)" }}>
                  {state?.updatedAt
                    ? `Last update: ${fmtTime(state.updatedAt)}`
                    : "Waiting for state…"}
                </div>
              </div>

              {/* Event Header Label editor */}
              <div
                style={{
                  marginTop: 12,
                  display: "flex",
                  gap: 10,
                  alignItems: "center",
                  flexWrap: "wrap",
                }}
              >
                <span style={chipStyle("rgba(0,0,0,0.25)", "white")}>
                  EVENT HEADER LABEL
                </span>

                <input
                  value={eventHeaderDraft}
                  onChange={(e) => onChangeEventHeaderLabel(e.target.value)}
                  placeholder="COMPETITION MATRIX"
                  style={{
                    width: 420,
                    maxWidth: "70vw",
                    padding: "10px 12px",
                    borderRadius: 12,
                    border: "1px solid rgba(255,255,255,0.18)",
                    background: "rgba(0,0,0,0.25)",
                    color: "white",
                    outline: "none",
                  }}
                />

                {/* ✅ Smaller Set button (your refinement) */}
                <button
                  disabled={!canAct}
                  onClick={() => setEventHeaderLabelLive(eventHeaderDraft)}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: "auto",
                    minWidth: "unset",
                    padding: "4px 10px",
                    height: 28,
                    borderRadius: 6,
                    background: "rgba(255,255,255,0.12)",
                    color: "white",
                    fontWeight: 700,
                    fontSize: 13,
                    letterSpacing: 0.4,
                    border: "1px solid rgba(255,255,255,0.18)",
                    cursor: canAct ? "pointer" : "not-allowed",
                    opacity: canAct ? 1 : 0.5,
                  }}
                  title="Apply header label"
                >
                  Set
                </button>
              </div>

              {/* Event Status (compact) */}
              <div
                style={{
                  marginTop: 10,
                  display: "flex",
                  gap: 10,
                  alignItems: "center",
                  flexWrap: "wrap",
                }}
              >
                <span style={chipStyle("rgba(0,0,0,0.25)", "white")}>
                  COMPETITION STATUS
                </span>
                <span
                  style={chipStyle(
                    (state as any)?.eventStatus === "LIVE"
                      ? "rgba(46,125,50,0.85)"
                      : "rgba(255,152,0,0.75)",
                    "white",
                  )}
                >
                  {(state as any)?.eventStatus === "LIVE" ? "RUNNING" : "PLANNING"}
                </span>
                {(state as any)?.eventStatus === "LIVE" && (state as any)?.eventPaused ? (
                  <span style={chipStyle("rgba(255,152,0,0.75)", "white")}>
                    PAUSED
                  </span>
                ) : null}
                {(state as any)?.eventStatus === "PLANNING" ? (
                  <button
                    disabled={!canAct}
                    onClick={() => setConfirmStartNow(true)}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      padding: "4px 10px",
                      height: 28,
                      borderRadius: 6,
                      background: "rgba(46,125,50,0.75)",
                      color: "white",
                      fontWeight: 700,
                      fontSize: 12,
                      border: "1px solid rgba(255,255,255,0.18)",
                      cursor: canAct ? "pointer" : "not-allowed",
                      opacity: canAct ? 1 : 0.5,
                    }}
                  >
                    Start Now
                  </button>
                ) : (state as any)?.eventPaused ? (
                  <button
                    disabled={!canAct}
                    onClick={() => {
                      setEventStatusMsg(null);
                      socket?.emit?.("admin:event:resume", {}, (ack?: { ok?: boolean; error?: string }) => {
                        if (ack?.ok) {
                          setEventStatusMsg({ ok: true, text: "Competition resumed." });
                        } else {
                          setEventStatusMsg({ ok: false, text: ack?.error ?? "Failed." });
                        }
                        setTimeout(() => setEventStatusMsg(null), 4000);
                      });
                    }}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      padding: "4px 10px",
                      height: 28,
                      borderRadius: 6,
                      background: "rgba(46,125,50,0.75)",
                      color: "white",
                      fontWeight: 700,
                      fontSize: 12,
                      border: "1px solid rgba(255,255,255,0.18)",
                      cursor: canAct ? "pointer" : "not-allowed",
                      opacity: canAct ? 1 : 0.5,
                    }}
                  >
                    Resume Clocks
                  </button>
                ) : (
                  <button
                    disabled={!canAct}
                    onClick={() => {
                      setEventStatusMsg(null);
                      socket?.emit?.("admin:event:pause", {}, (ack?: { ok?: boolean; error?: string }) => {
                        if (ack?.ok) {
                          setEventStatusMsg({ ok: true, text: "Competition paused." });
                        } else {
                          setEventStatusMsg({ ok: false, text: ack?.error ?? "Failed." });
                        }
                        setTimeout(() => setEventStatusMsg(null), 4000);
                      });
                    }}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      padding: "4px 10px",
                      height: 28,
                      borderRadius: 6,
                      background: "rgba(255,152,0,0.55)",
                      color: "white",
                      fontWeight: 700,
                      fontSize: 12,
                      border: "1px solid rgba(255,255,255,0.18)",
                      cursor: canAct ? "pointer" : "not-allowed",
                      opacity: canAct ? 1 : 0.5,
                    }}
                  >
                    Pause Clocks
                  </button>
                )}
              </div>
              {eventStatusMsg ? (
                <div
                  style={{
                    marginTop: 6,
                    fontSize: 12,
                    color: eventStatusMsg.ok ? "#a5d6a7" : "#f48fb1",
                  }}
                >
                  {eventStatusMsg.ok ? "✅ " : "❌ "}
                  {eventStatusMsg.text}
                </div>
              ) : null}
              <div style={{ marginTop: 4, fontSize: 11, opacity: 0.6 }}>
                {(state as any)?.eventStatus === "PLANNING"
                  ? "Competition clocks are inactive. Start the event to enable reporting timers."
                  : (state as any)?.eventStatus === "LIVE" && (state as any)?.eventPaused
                    ? "Competition clocks are paused."
                    : (state as any)?.eventStatus === "LIVE"
                      ? "Competition clocks are running."
                      : "Competition clocks are inactive. Start the event to enable reporting timers."}
              </div>
            </div>
          </div>

          <div
            className="admin-header-actions"
            style={{
              display: "flex",
              gap: 10,
              alignItems: "center",
              flexWrap: "wrap",
            }}
          >
            <span
              style={chipStyle(
                connected ? "var(--success)" : "var(--warning)",
                connected ? "white" : "#111",
              )}
            >
              {connected ? "CONNECTED" : "CONNECTING"}
            </span>

            <Link
              href="/judge"
              style={{
                ...buttonStyle({ bg: "rgba(0,0,0,0.25)", disabled: false }),
                textDecoration: "none",
              }}
            >
              Judge
            </Link>

            <Link
              href="/public"
              style={{
                ...buttonStyle({ bg: "rgba(0,0,0,0.25)", disabled: false }),
                textDecoration: "none",
              }}
            >
              Public
            </Link>

            <button
              onClick={() => setConfirmStartNewEvent(true)}
              disabled={!canAct}
              title="Clear Ops Chat and optionally reset queues"
              style={buttonStyle({
                bg: "rgba(45, 55, 72, 0.95)",
                fg: "white",
                disabled: !canAct,
              })}
            >
              Reset Event…
            </button>
          </div>
        </header>

        {/* =======================
            Reset Event success / error toast
           ======================= */}
        {resetSuccessMsg ? (
          <div
            style={{
              marginTop: 12,
              padding: 12,
              borderRadius: 12,
              background: "rgba(76,175,80,0.2)",
              border: "1px solid rgba(76,175,80,0.5)",
              color: "#a5d6a7",
            }}
          >
            ✅ {resetSuccessMsg}
          </div>
        ) : null}
        {resetErrorToast ? (
          <div
            style={{
              marginTop: 12,
              padding: 12,
              borderRadius: 12,
              background: "rgba(198,40,40,0.16)",
              border: "1px solid rgba(198,40,40,0.5)",
              color: "#f48fb1",
            }}
          >
            <b>Reset Event failed:</b> {resetErrorToast}
          </div>
        ) : null}
        {reloadRosterMsg ? (
          <div
            style={{
              marginTop: 12,
              padding: 12,
              borderRadius: 12,
              background: reloadRosterMsg.ok
                ? "rgba(76,175,80,0.2)"
                : "rgba(198,40,40,0.16)",
              border: reloadRosterMsg.ok
                ? "1px solid rgba(76,175,80,0.5)"
                : "1px solid rgba(198,40,40,0.5)",
              color: reloadRosterMsg.ok ? "#a5d6a7" : "#f48fb1",
            }}
          >
            {reloadRosterMsg.ok ? "✅ " : "❌ "}
            {reloadRosterMsg.text}
          </div>
        ) : null}
        {clearAllSuccessMsg ? (
          <div
            style={{
              marginTop: 12,
              padding: 12,
              borderRadius: 12,
              background: "rgba(76,175,80,0.2)",
              border: "1px solid rgba(76,175,80,0.5)",
              color: "#a5d6a7",
            }}
          >
            ✅ {clearAllSuccessMsg}
          </div>
        ) : null}

        {/* =======================
            NEW: Ops Chat / Broadcast (Admin) — additive only
           ======================= */}
        <div
          style={{
            marginTop: 12,
            borderRadius: 16,
            padding: 12,
            background: "rgba(0,0,0,0.22)",
            border: "1px solid rgba(255,255,255,0.10)",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: 12,
              flexWrap: "wrap",
              alignItems: "center",
            }}
          >
            <div style={{ fontWeight: 1000 }}>
              🗨️ Ops Chat / Broadcast (Pad Channels)
            </div>
            <span style={chipStyle("rgba(0,0,0,0.25)", "white")}>
              Channels: {commChannels.length}
            </span>
            {totalUnread > 0 ? (
              <span
                style={chipStyle(
                  "rgba(198,40,40,0.9)",
                  "white",
                )}
              >
                Unread: {totalUnread}
              </span>
            ) : null}
          </div>

          {commErr ? (
            <div
              style={{
                marginTop: 10,
                padding: 10,
                borderRadius: 12,
                border: `1px solid ${COLOR_RED}`,
                background: "rgba(198,40,40,0.16)",
              }}
            >
              <b>Error:</b> {commErr}
            </div>
          ) : null}

          {/* Broadcast row */}
          <div
            className="admin-broadcast-grid"
            style={{
              marginTop: 10,
              display: "grid",
              gridTemplateColumns: "1fr 120px 110px 110px 140px",
              gap: 10,
              alignItems: "center",
            }}
          >
            <input
              value={bcText}
              onChange={(e) => setBcText(e.target.value)}
              placeholder="Broadcast to judges…"
              style={flatInput}
              disabled={!canAct}
            />
            <select
              value={bcTarget}
              onChange={(e) => setBcTarget(e.target.value as any)}
              style={flatInput as any}
              disabled={!canAct}
            >
              <option value="ALL">ALL</option>
              <option value="PAD">PAD</option>
            </select>
            <input
              value={bcPadId}
              onChange={(e) => setBcPadId(e.target.value)}
              placeholder="Pad"
              style={{ ...flatInput, opacity: bcTarget === "PAD" ? 1 : 0.5 }}
              disabled={!canAct || bcTarget !== "PAD"}
            />
            <input
              type="number"
              min={20}
              max={1800}
              value={bcTtl}
              onChange={(e) => setBcTtl(Number(e.target.value || 120))}
              style={flatInput}
              disabled={!canAct}
            />
            <button
              disabled={!canAct || !bcText.trim()}
              onClick={sendBroadcast}
              style={buttonStyle({
                bg: COLOR_ORANGE,
                fg: "#111",
                disabled: !canAct || !bcText.trim(),
              })}
            >
              Broadcast
            </button>
          </div>

          {/* Channel list + chat */}
          <div
            className="admin-comm-layout"
            style={{
              marginTop: 12,
              display: "grid",
              gridTemplateColumns: "340px 1fr",
              gap: 12,
            }}
          >
            <div
              className="comm-left-panel"
              style={{
                borderRadius: 14,
                padding: 10,
                background: "rgba(0,0,0,0.18)",
                border: "1px solid rgba(255,255,255,0.10)",
                maxHeight: 320,
                display: "flex",
                flexDirection: "column",
                minHeight: 0,
              }}
            >
              {commChannels.length === 0 ? (
                <div style={{ opacity: 0.75 }}>
                  No pad channels yet. Load roster or add pads.
                </div>
              ) : (
                <>
                  <div
                    className="comm-left-header"
                    style={{
                      flexShrink: 0,
                      display: "flex",
                      flexDirection: "column",
                      gap: 8,
                      marginBottom: 8,
                    }}
                  >
                    <div style={{ display: "flex", gap: 6 }}>
                      <button
                        onClick={() => setCommListTab("inbox")}
                        style={{
                          ...pillButton(commListTab === "inbox"),
                          flex: 1,
                        }}
                      >
                        Inbox
                      </button>
                      <button
                        onClick={() => setCommListTab("pads")}
                        style={{
                          ...pillButton(commListTab === "pads"),
                          flex: 1,
                        }}
                      >
                        Areas
                      </button>
                    </div>
                    {commListTab === "inbox" ? (
                      <select
                        value={inboxFilter}
                        onChange={(e) =>
                          setInboxFilter(e.target.value as typeof inboxFilter)
                        }
                        style={{
                          ...flatInput,
                          padding: "6px 10px",
                          fontSize: 12,
                        }}
                      >
                        <option value="unread">Unread</option>
                        <option value="recent">Recent</option>
                      </select>
                    ) : null}
                  </div>
                  <div
                    className="comm-left-list-scroll"
                    style={{
                      flex: 1,
                      minHeight: 0,
                      overflowY: "auto",
                      paddingRight: 6,
                      display: "flex",
                      flexDirection: "column",
                      gap: 8,
                    }}
                  >
                    {renderChannels.map((c) => {
                        const active = c.padId === commSelectedPadId;
                        const unread = unreadCountByPad[c.padId] ?? 0;
                        const urgent = hasUrgentUnreadByPad[c.padId];
                        return (
                          <button
                            key={c.padId}
                            onClick={() => setCommSelectedPadId(c.padId)}
                            style={{
                              textAlign: "left",
                              padding: "10px 12px",
                              borderRadius: 14,
                              border: active
                                ? "2px solid rgba(255,255,255,0.35)"
                                : "1px solid rgba(255,255,255,0.12)",
                              background:
                                active
                                  ? "rgba(0,0,0,0.30)"
                                  : unread > 0
                                    ? "rgba(198,40,40,0.12)"
                                    : "rgba(0,0,0,0.18)",
                              color: "white",
                              cursor: "pointer",
                            }}
                            title={c.name}
                          >
                            <div
                              style={{
                                display: "flex",
                                justifyContent: "space-between",
                                gap: 10,
                                alignItems: "baseline",
                              }}
                            >
                              <div style={{ fontWeight: 950 }}>{c.name}</div>
                              <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
                                {unread > 0 ? (
                                  <span
                                    style={{
                                      ...chipStyle(
                                        urgent
                                          ? "rgba(198,40,40,0.95)"
                                          : "rgba(255,152,0,0.85)",
                                        "white",
                                      ),
                                      minWidth: 20,
                                      justifyContent: "center",
                                    }}
                                  >
                                    {urgent ? "!" : unread}
                                  </span>
                                ) : null}
                                <span
                                  style={chipStyle(
                                    c.online
                                      ? "rgba(46,125,50,0.85)"
                                      : "rgba(0,0,0,0.25)",
                                    "white",
                                  )}
                                >
                                  {c.online ? "online" : "offline"}
                                </span>
                              </span>
                            </div>
                            <div
                              style={{
                                marginTop: 4,
                                opacity: 0.7,
                                fontSize: 12,
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {lastSnippetByPad[c.padId]
                                ? `${lastSnippetByPad[c.padId]} • ${formatHhmm(lastMsgTsByPad[c.padId] ?? 0)}`
                                : "(no messages)"}
                            </div>
                          </button>
                        );
                    })}
                  </div>
                </>
              )}
            </div>

            <div
              style={{
                borderRadius: 14,
                padding: 10,
                background: "rgba(0,0,0,0.18)",
                border: "1px solid rgba(255,255,255,0.10)",
                maxHeight: 320,
                display: "flex",
                flexDirection: "column",
                minHeight: 0,
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 10,
                  alignItems: "baseline",
                  flexWrap: "wrap",
                }}
              >
                <div style={{ fontWeight: 950 }}>
                  {selectedChannel
                    ? `${selectedChannel.name} • ${selectedChannel.online ? "online" : "offline"}`
                    : "Select a pad channel"}
                </div>
              </div>

              <div
                ref={chatViewportRef}
                style={{
                  marginTop: 10,
                  flex: 1,
                  minHeight: 0,
                  overflow: "auto",
                  padding: 10,
                  borderRadius: 12,
                  border: "1px solid rgba(255,255,255,0.10)",
                  background: "rgba(0,0,0,0.25)",
                }}
              >
                {selectedChat.length === 0 ? (
                  <div style={{ opacity: 0.7, fontSize: 13 }}>
                    No messages yet.
                  </div>
                ) : (
                  selectedChat.slice(-140).map((m) => (
                    <div
                      key={m.id}
                      ref={(el) => {
                        if (el) msgElByIdRef.current[m.id] = el;
                        else delete msgElByIdRef.current[m.id];
                      }}
                      data-mid={m.id}
                      data-mts={m.ts}
                      data-padid={commSelectedPadId ?? undefined}
                      style={{ marginBottom: 8, display: "flex", gap: 8 }}
                    >
                      <div
                        style={{
                          width: 90,
                          opacity: 0.7,
                          fontSize: 12,
                          paddingTop: 2,
                        }}
                      >
                        {m.from} • {formatHhmm(m.ts)}
                        {m.urgent && (
                          <div
                            style={{
                              fontSize: 10,
                              fontWeight: 900,
                              color: m.ackedAt
                                ? "rgba(46,125,50,0.9)"
                                : "var(--danger)",
                            }}
                          >
                            {m.ackedAt ? "Acknowledged" : "Urgent"}
                          </div>
                        )}
                      </div>
                      <div
                        style={{
                          flex: 1,
                          borderRadius: 10,
                          padding: "8px 10px",
                          border: "1px solid rgba(255,255,255,0.10)",
                          background:
                            m.from === "ADMIN"
                              ? "rgba(255,152,0,0.10)"
                              : "rgba(0,150,255,0.10)",
                          whiteSpace: "pre-wrap",
                        }}
                      >
                        {m.text}
                      </div>
                    </div>
                  ))
                )}
              </div>

              <div
                style={{
                  marginTop: 10,
                  display: "flex",
                  gap: 8,
                  alignItems: "center",
                  flexWrap: "wrap",
                  flexShrink: 0,
                }}
              >
                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    cursor: "pointer",
                    fontSize: 13,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={commUrgent}
                    onChange={(e) => setCommUrgent(e.target.checked)}
                  />
                  Urgent
                </label>
                <input
                  value={commDraft}
                  onChange={(e) => setCommDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      sendAdminChat();
                    }
                  }}
                  placeholder="Message pad channel… (Enter to send)"
                  style={flatInput}
                  disabled={!canAct || commSelectedPadId == null}
                />
                <button
                  onClick={sendAdminChat}
                  disabled={
                    !canAct ||
                    commBusy ||
                    !commDraft.trim() ||
                    commSelectedPadId == null
                  }
                  style={buttonStyle({
                    bg:
                      !canAct ||
                      commBusy ||
                      !commDraft.trim() ||
                      commSelectedPadId == null
                        ? "rgba(0,0,0,0.25)"
                        : "var(--cacc-gold)",
                    fg: "#111",
                    disabled:
                      !canAct ||
                      commBusy ||
                      !commDraft.trim() ||
                      commSelectedPadId == null,
                  })}
                >
                  Send
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* =======================
            Schedule bulletin
           ======================= */}
        <div
          style={{
            marginTop: 12,
            borderRadius: 16,
            padding: 12,
            background: "rgba(0,0,0,0.22)",
            border: "1px solid rgba(255,255,255,0.10)",
          }}
        >
          <div
            style={{
              display: "flex",
              gap: 10,
              flexWrap: "wrap",
              alignItems: "center",
            }}
          >
            <span style={chipStyle("rgba(255,255,255,0.16)", "white")}>
              SCHEDULE
            </span>
            <div style={{ fontWeight: 900 }}>
              NOW:{" "}
              {nowGlobal
                ? `${nowGlobal.title} (${fmtTime(nowGlobal.startAt)}–${fmtTime(nowGlobal.endAt)})`
                : "—"}
            </div>
            <div style={{ opacity: 0.85 }}>
              NEXT:{" "}
              {nextGlobal
                ? `${nextGlobal.title} (${fmtTime(nextGlobal.startAt)}–${fmtTime(nextGlobal.endAt)})`
                : "—"}
            </div>
          </div>
          <div style={{ marginTop: 6, fontSize: 12, opacity: 0.75 }}>
            Schedule is informational only (does not pause areas).
          </div>
        </div>

        {/* =======================
            Pad health
           ======================= */}
        <div
          style={{
            marginTop: 12,
            borderRadius: 16,
            padding: 12,
            background: "rgba(255,255,255,0.05)",
            border: "1px solid rgba(255,255,255,0.10)",
          }}
        >
          <div
            style={{
              fontSize: 12,
              fontWeight: 900,
              opacity: 0.85,
              letterSpacing: 1.1,
            }}
          >
            AREA HEALTH
          </div>
          <div
            style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap" }}
          >
            {padHealth.map((p) => {
              const { bg, fg } = statusPillColors(p.status);
              return (
                <span key={p.id} style={chipStyle(bg, fg)} title={p.label}>
                  AREA {p.id}: {p.status}
                </span>
              );
            })}
          </div>
        </div>

        {/* =======================
            Dashboard Controls
           ======================= */}
        <style>{`
          .dash3 {
            margin-top: 12px;
            display: grid;
            grid-template-columns: repeat(3, minmax(280px, 1fr));
            gap: 12px;
            align-items: stretch;
          }
          @media (max-width: 1024px) { .dash3 { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
          @media (max-width: 640px) { .dash3 { grid-template-columns: 1fr; } }
          .dashCard { display: flex; flex-direction: column; height: 100%; min-height: 280px; min-width: 0; }
          .dashCardBody { flex: 1; min-height: 0; min-width: 0; overflow-x: hidden; overflow-y: auto; margin-top: 10px; }
        `}</style>

        <div className="dash3">
          {/* GLOBAL MESSAGE */}
          <div
            className="dashCard"
            style={{
              borderRadius: 16,
              padding: 12,
              background: "rgba(144,202,249,0.10)",
              border: "1px solid rgba(144,202,249,0.35)",
              boxShadow: "0 10px 26px rgba(0,0,0,0.18)",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 10,
                alignItems: "center",
                flexWrap: "wrap",
              }}
            >
              <div style={{ fontWeight: 1000 }}>📢 GLOBAL MESSAGE</div>
              <span style={chipStyle("rgba(0,0,0,0.22)", "white")}>
                Broadcast
              </span>
            </div>

            <div className="dashCardBody">
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 96px",
                  gap: 10,
                  alignItems: "center",
                }}
              >
                <input
                  value={msgText}
                  onChange={(e) => setMsgText(e.target.value)}
                  placeholder="Message… (e.g., ROTATE AT 0500)"
                  style={{
                    padding: "10px 12px",
                    borderRadius: 12,
                    border: "1px solid rgba(255,255,255,0.18)",
                    background: "rgba(0,0,0,0.25)",
                    color: "white",
                    outline: "none",
                  }}
                />
                <input
                  type="number"
                  min={1}
                  value={msgMinutes}
                  onChange={(e) => setMsgMinutes(Number(e.target.value || 30))}
                  style={{
                    padding: "10px 12px",
                    borderRadius: 12,
                    border: "1px solid rgba(255,255,255,0.18)",
                    background: "rgba(0,0,0,0.25)",
                    color: "white",
                    outline: "none",
                    width: "100%",
                  }}
                  title="Minutes"
                />
              </div>

              {state?.globalMessage ? (
                <div
                  style={{
                    marginTop: 10,
                    opacity: 0.9,
                    fontSize: 13,
                    lineHeight: 1.35,
                  }}
                >
                  <div>
                    <b>Active:</b> {state.globalMessage}
                  </div>
                  <div style={{ opacity: 0.85 }}>
                    {state.globalMessageUntilAt
                      ? `Ends ${fmtTime(state.globalMessageUntilAt)}`
                      : "No expiry"}
                  </div>
                </div>
              ) : (
                <div style={{ marginTop: 10, opacity: 0.75, fontSize: 13 }}>
                  No active global message.
                </div>
              )}
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 10,
                marginTop: 10,
              }}
            >
              <button
                disabled={!canAct}
                onClick={doSetMessage}
                style={buttonStyle({
                  bg: "rgba(0,0,0,0.25)",
                  disabled: !canAct,
                })}
              >
                Set
              </button>
              <button
                disabled={!canAct}
                onClick={doClearMessage}
                style={buttonStyle({
                  bg: "rgba(0,0,0,0.25)",
                  disabled: !canAct,
                })}
              >
                Clear
              </button>
            </div>
          </div>

          {/* GLOBAL BREAK */}
          <div
            className="dashCard"
            style={{
              borderRadius: 16,
              padding: 12,
              background: "rgba(255,152,0,0.10)",
              border: "1px solid rgba(255,152,0,0.35)",
              boxShadow: "0 10px 26px rgba(0,0,0,0.18)",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 10,
                alignItems: "center",
                flexWrap: "wrap",
              }}
            >
              <div style={{ fontWeight: 1000 }}>🟠 GLOBAL BREAK</div>
              <span style={chipStyle("rgba(0,0,0,0.22)", "white")}>
                Pauses all
              </span>
            </div>

            <div className="dashCardBody">
              {globalBreakActive ? (
                <div
                  style={{ fontWeight: 950, fontSize: 13, lineHeight: 1.35 }}
                >
                  <div>
                    <b>ACTIVE:</b> {state?.globalBreakReason ?? "Break"}
                  </div>
                  <div style={{ opacity: 0.85 }}>
                    Resumes in{" "}
                    {Math.max(0, Math.floor(globalBreakRemaining ?? 0))}s (at{" "}
                    {fmtTime(state!.globalBreakUntilAt!)})
                  </div>
                </div>
              ) : state?.globalBreakStartAt &&
                state?.globalBreakStartAt > nowMs ? (
                <div
                  style={{ fontWeight: 950, fontSize: 13, lineHeight: 1.35 }}
                >
                  <div>
                    <b>SCHEDULED:</b> {state?.globalBreakReason ?? "Break"}
                  </div>
                  <div style={{ opacity: 0.85 }}>
                    Starts {fmtTime(state.globalBreakStartAt)} • Ends{" "}
                    {state.globalBreakUntilAt
                      ? fmtTime(state.globalBreakUntilAt)
                      : "—"}
                  </div>
                </div>
              ) : (
                <div style={{ opacity: 0.75, fontSize: 13 }}>
                  No active global break.
                </div>
              )}

              <div
                style={{
                  marginTop: 10,
                  display: "grid",
                  gridTemplateColumns: "1fr 96px",
                  gap: 10,
                  alignItems: "center",
                }}
              >
                <input
                  value={gbReason}
                  onChange={(e) => setGbReason(e.target.value)}
                  placeholder="Reason (e.g., Lunch)"
                  style={{
                    padding: "10px 12px",
                    borderRadius: 12,
                    border: "1px solid rgba(255,255,255,0.18)",
                    background: "rgba(0,0,0,0.25)",
                    color: "white",
                    outline: "none",
                  }}
                />
                <input
                  type="number"
                  min={1}
                  value={gbMinutes}
                  onChange={(e) => setGbMinutes(Number(e.target.value || 60))}
                  style={{
                    padding: "10px 12px",
                    borderRadius: 12,
                    border: "1px solid rgba(255,255,255,0.18)",
                    background: "rgba(0,0,0,0.25)",
                    color: "white",
                    outline: "none",
                    width: "100%",
                  }}
                  title="Minutes"
                />
              </div>

              <button
                disabled={!canAct}
                onClick={doStartGlobalBreakNow}
                style={{
                  ...buttonStyle({
                    bg: COLOR_ORANGE,
                    fg: "#111",
                    disabled: !canAct,
                  }),
                  width: "100%",
                  marginTop: 10,
                }}
              >
                Start Now
              </button>

              <div
                style={{
                  marginTop: 10,
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: 10,
                  alignItems: "center",
                }}
              >
                <DateTimeField
                  value={gbStartLocal}
                  onChange={setGbStartLocal}
                  style={{
                    padding: "10px 12px",
                    borderRadius: 12,
                    border: "1px solid rgba(255,255,255,0.18)",
                    background: "rgba(0,0,0,0.25)",
                    color: "white",
                    outline: "none",
                    width: "100%",
                  }}
                />
                <button
                  disabled={!canAct || !gbStartLocal}
                  onClick={doScheduleGlobalBreak}
                  style={buttonStyle({
                    bg: "rgba(0,0,0,0.25)",
                    disabled: !canAct || !gbStartLocal,
                  })}
                >
                  Schedule
                </button>
              </div>
            </div>

            <button
              disabled={!canAct}
              onClick={doEndGlobalBreak}
              style={{
                ...buttonStyle({ bg: "rgba(0,0,0,0.25)", disabled: !canAct }),
                width: "100%",
                marginTop: 10,
              }}
            >
              End
            </button>
          </div>

          {/* SCHEDULE (Manual Entry) */}
          <div
            className="dashCard"
            style={{
              borderRadius: 16,
              padding: 12,
              background: "rgba(0,0,0,0.20)",
              border: "1px solid rgba(255,255,255,0.10)",
              boxShadow: "0 10px 26px rgba(0,0,0,0.18)",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 10,
                alignItems: "center",
                flexWrap: "wrap",
              }}
            >
              <div style={{ fontWeight: 1000 }}>🗓️ SCHEDULE</div>
              <span style={chipStyle("rgba(0,0,0,0.22)", "white")}>
                Manual entry
              </span>
            </div>

            <div className="dashCardBody">
              <input
                value={schTitle}
                onChange={(e) => setSchTitle(e.target.value)}
                placeholder="Title (required)"
                style={{
                  padding: "10px 12px",
                  borderRadius: 12,
                  border: "1px solid rgba(255,255,255,0.18)",
                  background: "rgba(0,0,0,0.25)",
                  color: "white",
                  outline: "none",
                  width: "100%",
                }}
              />

              <div
                style={{
                  marginTop: 10,
                  display: "grid",
                  gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
                  gap: 10,
                  minWidth: 0,
                }}
              >
                <select
                  value={schType}
                  onChange={(e) => setSchType(e.target.value as any)}
                  style={{
                    padding: "10px 12px",
                    borderRadius: 12,
                    border: "1px solid rgba(255,255,255,0.18)",
                    background: "rgba(0,0,0,0.25)",
                    color: "white",
                    outline: "none",
                  }}
                >
                  <option value="COMPETE">COMPETE</option>
                  <option value="BREAK">BREAK</option>
                  <option value="LUNCH">LUNCH</option>
                  <option value="CEREMONY">CEREMONY</option>
                  <option value="OTHER">OTHER</option>
                </select>

                <select
                  value={schScope}
                  onChange={(e) => setSchScope(e.target.value as any)}
                  style={{
                    padding: "10px 12px",
                    borderRadius: 12,
                    border: "1px solid rgba(255,255,255,0.18)",
                    background: "rgba(0,0,0,0.25)",
                    color: "white",
                    outline: "none",
                  }}
                >
                  <option value="GLOBAL">GLOBAL</option>
                  <option value="PAD">AREA(S)</option>
                </select>
              </div>

              <div
                style={{
                  marginTop: 10,
                  display: "grid",
                  gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
                  gap: 10,
                  minWidth: 0,
                }}
              >
                <DateTimeField
                  value={schStart}
                  onChange={setSchStart}
                  style={{
                    padding: "10px 12px",
                    borderRadius: 12,
                    border: "1px solid rgba(255,255,255,0.18)",
                    background: "rgba(0,0,0,0.25)",
                    color: "white",
                    outline: "none",
                  }}
                />
                <DateTimeField
                  value={schEnd}
                  onChange={setSchEnd}
                  style={{
                    padding: "10px 12px",
                    borderRadius: 12,
                    border: "1px solid rgba(255,255,255,0.18)",
                    background: "rgba(0,0,0,0.25)",
                    color: "white",
                    outline: "none",
                  }}
                />
              </div>

              {schScope === "PAD" ? (
                <input
                  value={schPadIds}
                  onChange={(e) => setSchPadIds(e.target.value)}
                  placeholder="Area IDs (e.g., 3,4)"
                  style={{ marginTop: 10, ...flatInput }}
                />
              ) : null}

              <input
                value={schNotes}
                onChange={(e) => setSchNotes(e.target.value)}
                placeholder="Notes (optional)"
                style={{ marginTop: 10, ...flatInput }}
              />

              {schError ? (
                <div
                  style={{
                    marginTop: 10,
                    padding: 10,
                    borderRadius: 12,
                    border: `1px solid ${COLOR_RED}`,
                    background: "rgba(198,40,40,0.16)",
                  }}
                >
                  <b>Error:</b> {schError}
                </div>
              ) : null}

              <div
                style={{
                  marginTop: 10,
                  borderRadius: 12,
                  background: "rgba(255,255,255,0.05)",
                  border: "1px solid rgba(255,255,255,0.10)",
                  padding: 10,
                  maxHeight: 180,
                  overflowX: "hidden",
                  overflowY: "auto",
                }}
              >
                {schedule.length === 0 ? (
                  <div style={{ opacity: 0.75 }}>No schedule blocks yet.</div>
                ) : (
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: 10,
                    }}
                  >
                    {schedule.map((e) => (
                      <div
                        key={e.id}
                        style={{
                          borderRadius: 12,
                          padding: 10,
                          background: "rgba(0,0,0,0.18)",
                          border: "1px solid rgba(255,255,255,0.10)",
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            gap: 10,
                            alignItems: "flex-start",
                          }}
                        >
                          <div style={{ minWidth: 0 }}>
                            <div
                              style={{
                                display: "flex",
                                gap: 8,
                                flexWrap: "wrap",
                                alignItems: "center",
                              }}
                            >
                              <span
                                style={chipStyle("rgba(0,0,0,0.25)", "white")}
                              >
                                {e.type}
                              </span>
                              <span
                                style={chipStyle("rgba(0,0,0,0.25)", "white")}
                              >
                                {e.scope === "PAD" ? "AREA" : e.scope}
                              </span>
                              <div
                                style={{
                                  fontWeight: 950,
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  whiteSpace: "nowrap",
                                  maxWidth: 220,
                                }}
                              >
                                {e.title}
                              </div>
                            </div>
                            <div
                              style={{
                                marginTop: 6,
                                opacity: 0.85,
                                fontSize: 12,
                              }}
                            >
                              {fmtTime(e.startAt)}–{fmtTime(e.endAt)}
                              {e.scope === "PAD" && e.padIds?.length
                                ? ` • Areas: ${e.padIds.join(",")}`
                                : ""}
                            </div>
                            {e.notes ? (
                              <div
                                style={{
                                  marginTop: 6,
                                  opacity: 0.85,
                                  fontSize: 12,
                                }}
                              >
                                Notes: {e.notes}
                              </div>
                            ) : null}
                          </div>

                          <div
                            style={{
                              display: "flex",
                              gap: 8,
                              flexWrap: "wrap",
                            }}
                          >
                            <button
                              disabled={!canAct}
                              onClick={() =>
                                updateEvent(e.id, {
                                  title:
                                    prompt("What's the new title?", e.title) ??
                                    e.title,
                                })
                              }
                              style={buttonStyle({
                                bg: "rgba(0,0,0,0.25)",
                                disabled: !canAct,
                              })}
                            >
                              Rename
                            </button>
                            <button
                              disabled={!canAct}
                              onClick={() => deleteEvent(e.id)}
                              style={buttonStyle({
                                bg: "rgba(0,0,0,0.25)",
                                disabled: !canAct,
                              })}
                            >
                              Delete
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div style={{ marginTop: 10, fontSize: 12, opacity: 0.75 }}>
                Schedule is informational only (does not pause areas).
              </div>
            </div>

            <button
              disabled={!canAct}
              onClick={addScheduleEvent}
              style={{
                ...buttonStyle({
                  bg: "var(--cacc-gold)",
                  fg: "#111",
                  disabled: !canAct,
                }),
                width: "100%",
                marginTop: 10,
              }}
            >
              Add Block
            </button>
          </div>
        </div>

        {/* =======================
            AREAS (this section matches your screenshot UI)
           ======================= */}
        <div
          style={{
            marginTop: 14,
            borderRadius: 16,
            padding: 12,
            background: "rgba(255,255,255,0.05)",
            border: "1px solid rgba(255,255,255,0.10)",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: 10,
              alignItems: "center",
              flexWrap: "wrap",
            }}
          >
            <div style={{ fontWeight: 1000 }}>AREAS</div>

            {/* Header actions: side-by-side, smaller */}
            <div
              style={{
                display: "flex",
                gap: 10,
                flexWrap: "nowrap",
                alignItems: "center",
              }}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,text/csv"
                style={{ display: "none" }}
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? null;
                  e.currentTarget.value = "";
                  handleImportFile(f);
                }}
              />

              <button
                disabled={!canAct}
                onClick={clickImport}
                title={IMPORT_TOOLTIP}
                style={{
                  ...buttonStyle({ bg: "rgba(0,0,0,0.22)", disabled: !canAct }),
                  display: "inline-flex",
                  width: "auto",
                  minWidth: "unset",
                  height: 32,
                  padding: "0 12px",
                  borderRadius: 10,
                  fontWeight: 850,
                  fontSize: 13,
                  letterSpacing: 0.2,
                  whiteSpace: "nowrap",
                }}
              >
                Import Roster (CSV)
              </button>

              <button
                disabled={!canAct}
                onClick={doReloadRoster}
                title="Reload roster from server CSV baseline"
                style={{
                  ...buttonStyle({ bg: "rgba(0,0,0,0.22)", disabled: !canAct }),
                  display: "inline-flex",
                  width: "auto",
                  minWidth: "unset",
                  height: 32,
                  padding: "0 12px",
                  borderRadius: 10,
                  fontWeight: 850,
                  fontSize: 13,
                  letterSpacing: 0.2,
                  whiteSpace: "nowrap",
                }}
              >
                Reload Roster
              </button>

              <button
                disabled={!canAct}
                onClick={() => setConfirmClearAll(true)}
                title="Hard reset: clears NOW/ONDECK/STANDBY across all areas"
                style={{
                  ...buttonStyle({
                    bg: "rgba(198,40,40,0.18)",
                    fg: "#ffd2d2",
                    disabled: !canAct,
                  }),
                  display: "inline-flex",
                  width: "auto",
                  minWidth: "unset",
                  height: 32,
                  padding: "0 12px",
                  borderRadius: 10,
                  fontWeight: 850,
                  fontSize: 13,
                  letterSpacing: 0.2,
                  whiteSpace: "nowrap",
                }}
              >
                Clear All
              </button>
            </div>
          </div>

          <div style={{ marginTop: 6, fontSize: 12, opacity: 0.75 }}>
            Admin controls areas. Creating/deleting areas live-updates Judge +
            Public. Click queue controls to open Queue Manager.
          </div>

          {importError ? (
            <div
              style={{
                marginTop: 10,
                padding: 10,
                borderRadius: 12,
                border: `1px solid ${COLOR_RED}`,
                background: "rgba(198,40,40,0.16)",
                whiteSpace: "pre-wrap",
              }}
            >
              <b>Import error:</b> {importError}
            </div>
          ) : null}

          {importNote ? (
            <div
              style={{
                marginTop: 10,
                padding: 10,
                borderRadius: 12,
                border: "1px solid rgba(255,255,255,0.16)",
                background: "rgba(0,0,0,0.18)",
              }}
            >
              ✅ {importNote}
            </div>
          ) : null}

          {/* add area row */}
          <div
            style={{
              marginTop: 10,
              display: "grid",
              gridTemplateColumns: "1fr 1fr 160px",
              gap: 10,
              alignItems: "center",
            }}
          >
            <input
              value={newAreaName}
              onChange={(e) => setNewAreaName(e.target.value)}
              placeholder="Name (optional) e.g., Classroom A"
              style={{
                padding: "10px 12px",
                borderRadius: 12,
                border: "1px solid rgba(255,255,255,0.18)",
                background: "rgba(0,0,0,0.25)",
                color: "white",
                outline: "none",
              }}
            />
            <input
              value={newAreaLabel}
              onChange={(e) => setNewAreaLabel(e.target.value)}
              placeholder="Label (optional) e.g., Map & Compass"
              style={{
                padding: "10px 12px",
                borderRadius: 12,
                border: "1px solid rgba(255,255,255,0.18)",
                background: "rgba(0,0,0,0.25)",
                color: "white",
                outline: "none",
              }}
            />
            <button
              disabled={!canAct}
              onClick={addArea}
              style={buttonStyle({
                bg: "var(--cacc-gold)",
                fg: "#111",
                disabled: !canAct,
              })}
            >
              Add Area
            </button>
          </div>

          {/* areas list */}
          <div
            style={{
              marginTop: 10,
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            {areas.length === 0 ? (
              <div style={{ opacity: 0.75 }}>No areas created.</div>
            ) : (
              areas.map((a) => (
                <AreaRow
                  key={a.id}
                  pad={a}
                  canAct={canAct}
                  onSave={(name, label) => saveArea(a.id, name, label)}
                  onDelete={() => requestDelete(a.id)}
                  onAddParticipant={() => openAddModal(a.id)}
                  onOpenQueue={(focus) => openQueueManager(a.id, focus)}
                />
              ))
            )}
          </div>
        </div>

        {/* =======================
            Start Now confirm modal
           ======================= */}
        {confirmStartNow && (
          <div onClick={() => setConfirmStartNow(false)} style={modalBackdrop}>
            <div onClick={(e) => e.stopPropagation()} style={modalCard}>
              <div style={{ fontWeight: 1000, fontSize: 18 }}>
                Start Competition Now?
              </div>
              <div
                style={{
                  marginTop: 10,
                  opacity: 0.85,
                  fontSize: 13,
                  lineHeight: 1.35,
                }}
              >
                This will start competition clocks and report timers. This cannot be undone (unless you reset the event).
              </div>

              <div
                style={{
                  marginTop: 14,
                  display: "flex",
                  gap: 10,
                  justifyContent: "flex-end",
                  flexWrap: "wrap",
                }}
              >
                <button
                  onClick={() => setConfirmStartNow(false)}
                  style={buttonStyle({
                    bg: "rgba(0,0,0,0.25)",
                    disabled: false,
                  })}
                >
                  Cancel
                </button>
                <button
                  onClick={() => {
                    setConfirmStartNow(false);
                    setEventStatusMsg(null);
                    socket?.emit?.("admin:event:startNow", {}, (ack?: { ok?: boolean; error?: string }) => {
                      if (ack?.ok) {
                        setEventStatusMsg({ ok: true, text: "Event started (LIVE)." });
                      } else {
                        setEventStatusMsg({ ok: false, text: ack?.error ?? "Failed." });
                      }
                      setTimeout(() => setEventStatusMsg(null), 4000);
                    });
                  }}
                  disabled={!canAct}
                  style={buttonStyle({
                    bg: "rgba(46,125,50,0.85)",
                    fg: "white",
                    disabled: !canAct,
                  })}
                >
                  Start Now
                </button>
              </div>
            </div>
          </div>
        )}

        {/* =======================
            CLEAR ALL confirm modal
           ======================= */}
        {confirmClearAll && (
          <div onClick={() => setConfirmClearAll(false)} style={modalBackdrop}>
            <div onClick={(e) => e.stopPropagation()} style={modalCard}>
              <div style={{ fontWeight: 1000, fontSize: 18 }}>
                Clear ALL Areas?
              </div>
              <div
                style={{
                  marginTop: 10,
                  opacity: 0.85,
                  fontSize: 13,
                  lineHeight: 1.35,
                }}
              >
                This will <b>DELETE ALL training areas</b> and remove ALL
                participants from NOW, ON DECK, and STANDBY. This cannot be
                undone.
              </div>

              <div
                style={{
                  marginTop: 14,
                  display: "flex",
                  gap: 10,
                  justifyContent: "flex-end",
                  flexWrap: "wrap",
                }}
              >
                <button
                  onClick={() => setConfirmClearAll(false)}
                  style={buttonStyle({
                    bg: "rgba(0,0,0,0.25)",
                    disabled: false,
                  })}
                >
                  Cancel
                </button>
                <button
                  onClick={doClearAll}
                  disabled={!canAct}
                  style={buttonStyle({
                    bg: COLOR_RED,
                    fg: "white",
                    disabled: !canAct,
                  })}
                >
                  Clear Everything
                </button>
              </div>
            </div>
          </div>
        )}

        {/* =======================
            Reset Event confirm modal
           ======================= */}
        {confirmStartNewEvent && (
          <div
            onClick={() => {
              setConfirmStartNewEvent(false);
              setResetError(null);
            }}
            style={modalBackdrop}
          >
            <div onClick={(e) => e.stopPropagation()} style={modalCard}>
              <div style={{ fontWeight: 1000, fontSize: 18 }}>
                Reset Event?
              </div>
              <div
                style={{
                  marginTop: 10,
                  opacity: 0.85,
                  fontSize: 13,
                  lineHeight: 1.35,
                }}
              >
                {resetScope.clearAreas
                  ? "This will clear Ops Chat and DELETE ALL training areas. This cannot be undone."
                  : "This will clear Ops Chat and (optionally) reset queues. This cannot be undone."}
                <div style={{ marginTop: 8 }}>
                  This resets selected data (chat/audit/queues/etc.). It does not change competition status unless you choose options that reset queues.
                </div>
              </div>

              {resetError ? (
                <div
                  style={{
                    marginTop: 12,
                    padding: 10,
                    borderRadius: 12,
                    border: "1px solid rgba(198,40,40,0.6)",
                    background: "rgba(198,40,40,0.16)",
                    color: "#f48fb1",
                    fontSize: 13,
                  }}
                >
                  <b>Error:</b> {resetError}
                </div>
              ) : null}

              <div
                style={{
                  marginTop: 14,
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                }}
              >
                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    cursor: "default",
                    opacity: 0.8,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={true}
                    disabled
                    readOnly
                  />
                  Clear Ops Chat (always)
                </label>
                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    cursor: "pointer",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={resetScope.clearAudit}
                    onChange={(e) =>
                      setResetScope((s) => ({
                        ...s,
                        clearAudit: e.target.checked,
                      }))
                    }
                  />
                  Clear Audit Log
                </label>
                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    cursor: "pointer",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={resetScope.resetQueues}
                    onChange={(e) =>
                      setResetScope((s) => ({
                        ...s,
                        resetQueues: e.target.checked,
                      }))
                    }
                  />
                  Reset Queues
                </label>
                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    cursor: "pointer",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={resetScope.resetHeaderLabel}
                    onChange={(e) =>
                      setResetScope((s) => ({
                        ...s,
                        resetHeaderLabel: e.target.checked,
                      }))
                    }
                  />
                  Reset Event Header Label
                </label>
                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    cursor: "pointer",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={resetScope.clearAreas}
                    onChange={(e) =>
                      setResetScope((s) => ({
                        ...s,
                        clearAreas: e.target.checked,
                      }))
                    }
                  />
                  Clear training areas (delete ALL areas)
                </label>
              </div>

              <div
                style={{
                  marginTop: 18,
                  display: "flex",
                  gap: 10,
                  justifyContent: "flex-end",
                  flexWrap: "wrap",
                }}
              >
                <button
                  onClick={() => {
                    setConfirmStartNewEvent(false);
                    setResetError(null);
                  }}
                  style={buttonStyle({
                    bg: "rgba(0,0,0,0.25)",
                    disabled: false,
                  })}
                >
                  Cancel
                </button>
                <button
                  onClick={doStartNewEvent}
                  disabled={!canAct}
                  style={buttonStyle({
                    bg: "rgba(45, 55, 72, 0.95)",
                    fg: "white",
                    disabled: !canAct,
                  })}
                >
                  Reset Event
                </button>
              </div>
            </div>
          </div>
        )}

        {/* =======================
            Queue Manager modal (your full layout)
           ======================= */}
        {queueModalPadId != null && queuePad ? (
          <div
            onClick={closeQueueManager}
            style={{
              ...modalBackdrop,
              background: "rgba(0,0,0,0.45)",
              zIndex: 95,
            }}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                width: "min(1040px, 100%)",
                maxHeight: "88vh",
                overflow: "auto",
                borderRadius: 18,
                background: "rgba(24,34,60,0.98)",
                border: "1px solid rgba(255,255,255,0.16)",
                boxShadow: "0 18px 60px rgba(0,0,0,0.55)",
                padding: 16,
              }}
            >
              {/* Top bar */}
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 12,
                  alignItems: "center",
                  flexWrap: "wrap",
                }}
              >
                <div>
                  <div style={{ fontWeight: 1100, fontSize: 18 }}>
                    Queue Manager — Area {queuePad.id}
                  </div>
                  <div style={{ fontSize: 13, opacity: 0.8 }}>
                    NOW {queuePad.now ? 1 : 0} • ON {queuePad.onDeck ? 1 : 0} •
                    STBY {queuePad.standby?.length ?? 0}
                  </div>
                </div>

                <button
                  onClick={closeQueueManager}
                  style={{
                    ...buttonStyle({ bg: "rgba(0,0,0,0.25)", disabled: false }),
                    display: "inline-flex",
                    width: "auto",
                    minWidth: "unset",
                    height: 30,
                    padding: "0 12px",
                    borderRadius: 10,
                    fontWeight: 900,
                  }}
                >
                  Close
                </button>
              </div>

              {/* Tabs */}
              <div
                style={{
                  marginTop: 12,
                  display: "flex",
                  gap: 8,
                  flexWrap: "wrap",
                }}
              >
                {(["NOW", "ONDECK", "STANDBY"] as QueueFocus[]).map((t) => {
                  const active = queueFocus === t;
                  return (
                    <button
                      key={t}
                      onClick={() => setQueueFocus(t)}
                      style={{
                        ...buttonStyle({
                          bg: active
                            ? "rgba(255,215,64,0.90)"
                            : "rgba(0,0,0,0.22)",
                          fg: active ? "#111" : "white",
                          disabled: false,
                        }),
                        display: "inline-flex",
                        width: "auto",
                        minWidth: "unset",
                        height: 32,
                        padding: "0 14px",
                        borderRadius: 999,
                        fontWeight: 950,
                      }}
                    >
                      {t === "ONDECK" ? "ON DECK" : t}
                    </button>
                  );
                })}
              </div>

              {/* NOW (Primary) */}
              <div style={{ marginTop: 12 }}>
                <PadPrimarySection
                  variant="control"
                  statusAccent="rgba(255,255,255,0.16)"
                  statusBadge={
                    <span style={chipStyle("rgba(255,255,255,0.16)", "white")}>
                      NOW
                    </span>
                  }
                  competitorContent={
                    <>
                      {queuePad.now ? (
                        queuePad.now.name
                      ) : (
                        <span style={{ opacity: 0.6 }}>— empty —</span>
                      )}
                      {queuePad.now ? (
                        <div
                          style={{
                            marginTop: 3,
                            opacity: 0.8,
                            fontFamily:
                              "ui-monospace, SFMono-Regular, Menlo, monospace",
                            fontSize: 11,
                          }}
                        >
                          {queuePad.now.id}
                        </div>
                      ) : null}
                    </>
                  }
                  actions={
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <button
                        disabled={!canAct || !queuePad.now}
                        onClick={() => qmDemote(queuePad.id, "NOW", "TOP")}
                        style={buttonStyle({
                          bg: "rgba(0,0,0,0.22)",
                          disabled: !canAct || !queuePad.now,
                        })}
                      >
                        Demote → Top
                      </button>
                      <button
                        disabled={!canAct || !queuePad.now}
                        onClick={() => qmDemote(queuePad.id, "NOW", "END")}
                        style={buttonStyle({
                          bg: "rgba(0,0,0,0.22)",
                          disabled: !canAct || !queuePad.now,
                        })}
                      >
                        Demote → End
                      </button>
                    </div>
                  }
                />
              </div>

              {/* ON DECK */}
              <PadOnDeckSection
                variant="control"
                label="ON DECK"
                labelRight="NEXT"
                actions={
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button
                      disabled={!canAct}
                      onClick={() => qmSwap(queuePad.id)}
                      style={buttonStyle({
                        bg: "rgba(0,0,0,0.22)",
                        disabled: !canAct,
                      })}
                    >
                      Swap NOW/ON
                    </button>
                    <button
                      disabled={!canAct || !queuePad.onDeck}
                      onClick={() => qmDemote(queuePad.id, "ONDECK", "TOP")}
                      style={buttonStyle({
                        bg: "rgba(0,0,0,0.22)",
                        disabled: !canAct || !queuePad.onDeck,
                      })}
                    >
                      Demote → Top
                    </button>
                    <button
                      disabled={!canAct || !queuePad.onDeck}
                      onClick={() => qmDemote(queuePad.id, "ONDECK", "END")}
                      style={buttonStyle({
                        bg: "rgba(0,0,0,0.22)",
                        disabled: !canAct || !queuePad.onDeck,
                      })}
                    >
                      Demote → End
                    </button>
                  </div>
                }
              >
                <>
                  {queuePad.onDeck ? (
                    queuePad.onDeck.name
                  ) : (
                    <span style={{ opacity: 0.6 }}>— empty —</span>
                  )}
                  {queuePad.onDeck ? (
                    <div
                      style={{
                        marginTop: 3,
                        opacity: 0.8,
                        fontFamily:
                          "ui-monospace, SFMono-Regular, Menlo, monospace",
                        fontSize: 11,
                      }}
                    >
                      {queuePad.onDeck.id}
                    </div>
                  ) : null}
                </>
              </PadOnDeckSection>

              {/* Add participant (Standby) */}
              <div
                style={{
                  marginTop: 12,
                  borderRadius: 10,
                  padding: 12,
                  background: "rgba(255,255,255,0.05)",
                  border: "1px solid rgba(255,255,255,0.10)",
                }}
              >
                <div style={{ fontWeight: 950, fontSize: 13 }}>
                  Add Participant (Standby)
                </div>
                <div
                  style={{
                    marginTop: 8,
                    display: "grid",
                    gridTemplateColumns: "1fr 220px 140px",
                    gap: 10,
                  }}
                >
                  <input
                    value={qmAddName}
                    onChange={(e) => setQmAddName(e.target.value)}
                    placeholder="Team Name (required)"
                    style={flatInput}
                  />
                  <input
                    value={qmAddId}
                    onChange={(e) => setQmAddId(e.target.value)}
                    placeholder="Team ID (required)"
                    style={flatInput}
                  />
                  <button
                    disabled={!canAct}
                    onClick={() => qmAddToStandby(queuePad.id)}
                    style={buttonStyle({
                      bg: "rgba(255,215,64,0.92)",
                      fg: "#111",
                      disabled: !canAct,
                    })}
                  >
                    Add
                  </button>
                </div>
              </div>

              {/* Standby list */}
              <PadStandbySection
                variant="control"
                count={queuePad.standby?.length ?? 0}
              >
                {(queuePad.standby ?? []).length === 0 ? (
                  <div style={{ opacity: 0.75 }}>No standby participants.</div>
                ) : (
                  <div
                    style={{ display: "flex", flexDirection: "column", gap: 8 }}
                  >
                    {(queuePad.standby ?? []).map((t: Team, idx: number) => {
                      const isEditing = qmEditOriginalId === t.id;

                      return (
                        <div
                          key={t.id}
                          style={{
                            display: "grid",
                            gridTemplateColumns: "60px 1fr 220px 260px 260px",
                            gap: 10,
                            alignItems: "center",
                            padding: "10px 12px",
                            borderRadius: 14,
                            background: "rgba(0,0,0,0.14)",
                            border: "1px solid rgba(255,255,255,0.10)",
                          }}
                        >
                          <div style={{ fontWeight: 900, opacity: 0.9 }}>
                            #{idx + 1}
                          </div>

                          {isEditing ? (
                            <input
                              value={qmEditName}
                              onChange={(e) => setQmEditName(e.target.value)}
                              style={flatInput}
                            />
                          ) : (
                            <div style={{ fontWeight: 900 }}>{t.name}</div>
                          )}

                          {isEditing ? (
                            <input
                              value={qmEditId}
                              onChange={(e) => setQmEditId(e.target.value)}
                              style={flatInput}
                            />
                          ) : (
                            <div
                              style={{
                                opacity: 0.85,
                                fontFamily:
                                  "ui-monospace, SFMono-Regular, Menlo, monospace",
                              }}
                            >
                              {t.id}
                            </div>
                          )}

                          <div
                            style={{
                              display: "flex",
                              gap: 8,
                              flexWrap: "wrap",
                            }}
                          >
                            <button
                              disabled={!canAct || idx === 0}
                              onClick={() =>
                                qmMoveStandby(queuePad.id, idx, idx - 1)
                              }
                              style={buttonStyle({
                                bg: "rgba(0,0,0,0.22)",
                                disabled: !canAct || idx === 0,
                              })}
                              title="Move up"
                            >
                              ▲
                            </button>
                            <button
                              disabled={
                                !canAct ||
                                idx === (queuePad.standby?.length ?? 1) - 1
                              }
                              onClick={() =>
                                qmMoveStandby(queuePad.id, idx, idx + 1)
                              }
                              style={buttonStyle({
                                bg: "rgba(0,0,0,0.22)",
                                disabled:
                                  !canAct ||
                                  idx === (queuePad.standby?.length ?? 1) - 1,
                              })}
                              title="Move down"
                            >
                              ▼
                            </button>

                            <button
                              disabled={!canAct}
                              onClick={() =>
                                qmSetSlot(queuePad.id, t.id, "NOW")
                              }
                              style={buttonStyle({
                                bg: "rgba(0,0,0,0.22)",
                                disabled: !canAct,
                              })}
                            >
                              Set NOW
                            </button>
                            <button
                              disabled={!canAct}
                              onClick={() =>
                                qmSetSlot(queuePad.id, t.id, "ONDECK")
                              }
                              style={buttonStyle({
                                bg: "rgba(0,0,0,0.22)",
                                disabled: !canAct,
                              })}
                            >
                              Set ON
                            </button>
                          </div>

                          <div
                            style={{
                              display: "flex",
                              gap: 8,
                              justifyContent: "flex-end",
                              flexWrap: "wrap",
                            }}
                          >
                            {isEditing ? (
                              <>
                                <button
                                  disabled={!canAct}
                                  onClick={() => saveEditTeam(queuePad.id)}
                                  style={buttonStyle({
                                    bg: "rgba(255,215,64,0.92)",
                                    fg: "#111",
                                    disabled: !canAct,
                                  })}
                                >
                                  Save
                                </button>
                                <button
                                  onClick={cancelEdit}
                                  style={buttonStyle({
                                    bg: "rgba(0,0,0,0.22)",
                                    disabled: false,
                                  })}
                                >
                                  Cancel
                                </button>
                              </>
                            ) : (
                              <>
                                <button
                                  disabled={!canAct}
                                  onClick={() => startEdit(t.id, t.name)}
                                  style={buttonStyle({
                                    bg: "rgba(0,0,0,0.22)",
                                    disabled: !canAct,
                                  })}
                                >
                                  Edit
                                </button>
                                <button
                                  disabled={!canAct}
                                  onClick={() =>
                                    qmRemoveStandby(queuePad.id, t.id)
                                  }
                                  style={buttonStyle({
                                    bg: "rgba(0,0,0,0.22)",
                                    disabled: !canAct,
                                  })}
                                >
                                  Remove
                                </button>
                              </>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </PadStandbySection>
            </div>
          </div>
        ) : null}

        {/* =======================
            Legacy Add Participant modal
           ======================= */}
        {addModalPadId != null ? (
          <div onClick={closeAddModal} style={{ ...modalBackdrop, zIndex: 90 }}>
            <div
              onClick={(e) => e.stopPropagation()}
              style={{ ...modalCard, width: "min(620px, 100%)" }}
            >
              <div style={{ fontWeight: 1000, fontSize: 18 }}>
                Add Participant — Area {addModalPadId}
              </div>
              <div
                style={{
                  marginTop: 8,
                  opacity: 0.8,
                  fontSize: 13,
                  lineHeight: 1.35,
                }}
              >
                Quick insert. (Queue Manager is recommended for full control.)
              </div>

              <div
                style={{
                  marginTop: 12,
                  display: "grid",
                  gridTemplateColumns: "1fr 220px",
                  gap: 10,
                }}
              >
                <input
                  value={addTeamName}
                  onChange={(e) => setAddTeamName(e.target.value)}
                  placeholder="Team Name (required)"
                  style={flatInput}
                />
                <input
                  value={addTeamId}
                  onChange={(e) => setAddTeamId(e.target.value)}
                  placeholder="Team ID (required)"
                  style={flatInput}
                />
              </div>

              <div
                style={{
                  marginTop: 10,
                  display: "grid",
                  gridTemplateColumns: "220px 1fr",
                  gap: 10,
                  alignItems: "center",
                }}
              >
                <select
                  value={addWhere}
                  onChange={(e) => setAddWhere(e.target.value as AddWhere)}
                  style={{
                    padding: "10px 12px",
                    borderRadius: 12,
                    border: "1px solid rgba(255,255,255,0.18)",
                    background: "rgba(0,0,0,0.25)",
                    color: "white",
                    outline: "none",
                  }}
                >
                  <option value="NOW">NOW</option>
                  <option value="ONDECK">ON DECK</option>
                  <option value="END">END (Standby)</option>
                </select>

                <div style={{ fontSize: 12, opacity: 0.8 }}>
                  Emits: <span style={{ opacity: 0.95 }}>admin:team:add</span> —{" "}
                  <span style={{ opacity: 0.95 }}>
                    {"{ padId, where, teamName, teamId }"}
                  </span>
                </div>
              </div>

              {addError ? (
                <div
                  style={{
                    marginTop: 10,
                    padding: 10,
                    borderRadius: 12,
                    border: `1px solid ${COLOR_RED}`,
                    background: "rgba(198,40,40,0.16)",
                  }}
                >
                  <b>Error:</b> {addError}
                </div>
              ) : null}

              <div
                style={{
                  marginTop: 14,
                  display: "flex",
                  gap: 10,
                  justifyContent: "flex-end",
                  flexWrap: "wrap",
                }}
              >
                <button
                  onClick={closeAddModal}
                  style={buttonStyle({
                    bg: "rgba(0,0,0,0.25)",
                    disabled: false,
                  })}
                >
                  Cancel
                </button>
                <button
                  onClick={confirmAddParticipant}
                  disabled={!canAct}
                  style={buttonStyle({
                    bg: "var(--cacc-gold)",
                    fg: "#111",
                    disabled: !canAct,
                  })}
                >
                  Add Participant
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {/* =======================
            Delete area confirm modal
           ======================= */}
        {confirmDeletePadId != null && (
          <div
            onClick={() => setConfirmDeletePadId(null)}
            style={{ ...modalBackdrop, zIndex: 80 }}
          >
            <div onClick={(e) => e.stopPropagation()} style={modalCard}>
              <div style={{ fontWeight: 1000, fontSize: 18 }}>
                Delete Area {confirmDeletePadId}?
              </div>

              <div
                style={{
                  marginTop: 10,
                  opacity: 0.85,
                  fontSize: 13,
                  lineHeight: 1.35,
                }}
              >
                This removes the area from Admin/Judge/Public immediately.
              </div>

              <div
                style={{
                  marginTop: 14,
                  display: "flex",
                  gap: 10,
                  justifyContent: "flex-end",
                  flexWrap: "wrap",
                }}
              >
                <button
                  onClick={() => setConfirmDeletePadId(null)}
                  style={buttonStyle({
                    bg: "rgba(0,0,0,0.25)",
                    disabled: false,
                  })}
                >
                  Cancel
                </button>

                <button
                  onClick={confirmDelete}
                  disabled={!canAct}
                  style={buttonStyle({
                    bg: COLOR_RED,
                    fg: "white",
                    disabled: !canAct,
                  })}
                >
                  Yes, Delete
                </button>
              </div>
            </div>
          </div>
        )}
      </main>
    </>
  );
}

function AreaRow({
  pad,
  canAct,
  onSave,
  onDelete,
  onAddParticipant,
  onOpenQueue,
}: {
  pad: Pad;
  canAct: boolean;
  onSave: (name: string, label: string) => void;
  onDelete: () => void;
  onAddParticipant: () => void;
  onOpenQueue: (focus: QueueFocus) => void;
}) {
  const [name, setName] = useState(pad.name);
  const [label, setLabel] = useState(pad.label);

  useEffect(() => {
    setName(pad.name);
    setLabel(pad.label);
  }, [pad.id, pad.name, pad.label]);

  const nowCount = pad.now ? 1 : 0;
  const onDeckCount = pad.onDeck ? 1 : 0;
  const standbyCount = pad.standby?.length ?? 0;

  // Smart default focus
  const smartFocus: QueueFocus = !pad.now
    ? "NOW"
    : !pad.onDeck
      ? "ONDECK"
      : "STANDBY";

  const inputStyle: React.CSSProperties = {
    height: 34,
    padding: "6px 10px",
    borderRadius: 10,
    border: "1px solid rgba(255,255,255,0.16)",
    background: "rgba(0,0,0,0.22)",
    color: "white",
    outline: "none",
    width: "100%",
  };

  const smallBtn = (opts: {
    bg: string;
    fg?: string;
    disabled?: boolean;
  }): React.CSSProperties => ({
    ...buttonStyle({ bg: opts.bg, fg: opts.fg, disabled: !!opts.disabled }),
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "auto",
    minWidth: "unset",
    height: 30,
    padding: "0 10px",
    borderRadius: 10,
    fontWeight: 850,
    letterSpacing: 0.2,
    whiteSpace: "nowrap",
  });

  // Non-button status badges (look like labels, not clickable)
  const badge: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    height: 24,
    padding: "0 10px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,0.14)",
    background: "rgba(255,255,255,0.06)",
    fontSize: 12,
    fontWeight: 900,
    letterSpacing: 0.2,
    whiteSpace: "nowrap",
    cursor: "default",
    userSelect: "none",
  };

  return (
    <div
      className="admin-areas-row"
      style={{
        display: "grid",
        gridTemplateColumns: "60px 1.2fr 1.2fr auto 1fr",
        gap: 10,
        alignItems: "center",
        padding: "8px 10px",
        borderRadius: 12,
        background: "rgba(0,0,0,0.18)",
        border: "1px solid rgba(255,255,255,0.10)",
      }}
    >
      <div style={{ fontWeight: 950 }}>#{pad.id}</div>

      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Area name"
        style={inputStyle}
      />
      <input
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder="Area label"
        style={inputStyle}
      />

      {/* Queue + indicators (THIS matches your screenshot layout) */}
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button
          onClick={() => onOpenQueue(smartFocus)}
          style={smallBtn({ bg: "rgba(33,150,243,0.28)" })}
          title="Open Queue Manager"
        >
          Manage Queue
        </button>

        <span style={badge}>NOW {nowCount}</span>
        <span style={badge}>ON {onDeckCount}</span>
        <span style={badge}>STBY {standbyCount}</span>
      </div>

      {/* Actions */}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button
          disabled={!canAct}
          onClick={() => onSave(name, label)}
          style={smallBtn({
            bg: "rgba(255,215,64,0.90)",
            fg: "#111",
            disabled: !canAct,
          })}
        >
          Save
        </button>

        <button
          disabled={!canAct}
          onClick={onAddParticipant}
          style={smallBtn({ bg: "rgba(0,0,0,0.25)", disabled: !canAct })}
          title="Quick add participant (legacy)"
        >
          Add Participant
        </button>

        <button
          disabled={!canAct}
          onClick={onDelete}
          style={smallBtn({ bg: "rgba(0,0,0,0.25)", disabled: !canAct })}
        >
          Delete
        </button>
      </div>
    </div>
  );
}

export async function getServerSideProps(
  ctx: import("next").GetServerSidePropsContext,
) {
  return requireAdminRole(ctx, "admin");
}
