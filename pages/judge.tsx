// pages/judge.tsx
import Head from "next/head";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

import type {
  BoardState,
  Pad,
  Division,
  ScheduleEvent,
  Team,
} from "@/lib/state";
import { getCompetitionNowMs } from "@/lib/state";
import { getSocket } from "@/lib/socketClient";
import { fmtTime, buttonStyle, chipStyle, mmssFromSeconds } from "@/lib/ui";
import { requireAdminRole } from "@/lib/auth";
import {
  PadHeader,
  PadPrimarySection,
  PadOnDeckSection,
  PadStandbySection,
} from "@/components/PadLayout";

const COLOR_ORANGE = "rgba(255,152,0,0.95)"; // BREAK
const COLOR_YELLOW = "rgba(255,235,59,0.95)"; // REPORT
const COLOR_RED = "var(--danger)"; // LATE
const COLOR_BLUE = "var(--info)";

type AnySocket = {
  id?: string;
  connected?: boolean;
  on?: (event: string, cb: (...args: any[]) => void) => void;
  off?: (event: string, cb?: (...args: any[]) => void) => void;
  emit?: (event: string, payload?: any) => void;
};

type CommMessage = {
  id: string;
  ts: number;
  from: "ADMIN" | "JUDGE";
  text: string;
  urgent?: boolean;
  ackedAt?: number;
};

type PadChannel = {
  padId: number;
  name: string;
  online: boolean;
  messages: CommMessage[];
};

type CommSnapshot = {
  channels: PadChannel[];
  lastBroadcast?: {
    id: string;
    ts: number;
    text: string;
    ttlSeconds?: number;
  } | null;
};

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

function areaName(p: Pad): string {
  const n = String((p as any).name ?? "").trim();
  return n.length ? n : `AREA ${p.id}`;
}

function areaLabel(p: Pad): string {
  const l = String((p as any).label ?? "").trim();
  return l.length ? l : "";
}

function mmss(sec: number) {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

function sortSchedule(list: ScheduleEvent[]) {
  return list.slice().sort((a, b) => a.startAt - b.startAt);
}
function nowBlock(schedule: ScheduleEvent[], nowMs: number) {
  return schedule.find((e) => nowMs >= e.startAt && nowMs < e.endAt) ?? null;
}
function nextBlock(schedule: ScheduleEvent[], nowMs: number) {
  return (
    schedule
      .filter((e) => e.startAt > nowMs)
      .sort((a, b) => a.startAt - b.startAt)[0] ?? null
  );
}
function nextBreakLike(schedule: ScheduleEvent[], nowMs: number) {
  const breakLike = schedule.filter(
    (e) => e.startAt > nowMs && (e.type === "BREAK" || e.type === "LUNCH"),
  );
  return breakLike.sort((a, b) => a.startAt - b.startAt)[0] ?? null;
}

function isArrivedForNow(p: Pad): boolean {
  const nowId = p.now?.id ?? null;
  return (
    !!p.nowArrivedAt &&
    !!p.nowArrivedTeamId &&
    !!nowId &&
    p.nowArrivedTeamId === nowId
  );
}

function reportIsValid(p: Pad, nowMs: number): boolean {
  const nowId = p.now?.id ?? null;
  if (!nowId) return false;
  if (!p.reportByTeamId || p.reportByTeamId !== nowId) return false;
  if (!p.reportByDeadlineAt) return false;
  if (isArrivedForNow(p)) return false;
  // If break is active, we suppress report banner
  if (p.breakUntilAt && p.breakUntilAt > nowMs) return false;
  return true;
}

function teamLine(t?: Team | null) {
  if (!t) return <span style={{ color: "var(--text-tertiary)" }}>—</span>;
  const meta = [t.division, t.category].filter(Boolean).join(" • ");
  const tag = (t as any).tag as string | undefined;
  return (
    <span>
      <span style={{ fontWeight: 950, color: "var(--text-primary)" }}>
        {t.name}
      </span>
      {meta ? (
        <span style={{ color: "var(--text-secondary)" }}> ({meta})</span>
      ) : null}
      {tag ? (
        <span
          style={{
            marginLeft: 8,
            padding: "2px 8px",
            borderRadius: 999,
            border: "1px solid rgba(255,255,255,0.25)",
            fontSize: 11,
            fontWeight: 900,
            letterSpacing: 0.6,
            opacity: 0.9,
            whiteSpace: "nowrap",
            background: "rgba(0,0,0,0.25)",
          }}
        >
          {tag}
        </span>
      ) : null}
    </span>
  );
}

function cardStyle(): React.CSSProperties {
  return {
    borderRadius: 12,
    background: "var(--surface-1)",
    border: "1px solid var(--border-crisp)",
    boxShadow: "0 4px 16px rgba(0,0,0,0.35)",
  };
}

export default function JudgeConsole() {
  const [socket, setSocket] = useState<AnySocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [socketId, setSocketId] = useState<string>("");
  const [isMobile, setIsMobile] = useState(false);
  const [showMobileAreaList, setShowMobileAreaList] = useState(false);

  const [state, setState] = useState<BoardState | null>(null);

  const [lockedPadId, setLockedPadId] = useState<number | null>(null);
  const [pendingPadId, setPendingPadId] = useState<number | null>(null);
  const [showConfirmChangeArea, setShowConfirmChangeArea] = useState(false);
  const [lastAction, setLastAction] = useState("—");
  const [judgeBound, setJudgeBound] = useState(false);
  const [bindError, setBindError] = useState<string | null>(null);

  const activePadId = lockedPadId;

  const [, tick] = useState(0);


  // Manual add modal
  const [showAdd, setShowAdd] = useState(false);
  const [addWhere, setAddWhere] = useState<"NOW" | "ONDECK" | "END">("END");
  const [addTeamName, setAddTeamName] = useState("");
  const [addTeamId, setAddTeamId] = useState("");
  const [addUnit, setAddUnit] = useState("");
  const [addDivision, setAddDivision] = useState<Division | "">("");
  const [addCategory, setAddCategory] = useState("");

  // Local break controls
  const [breakReason, setBreakReason] = useState("Break");
  const [breakMinutes, setBreakMinutes] = useState(10);

  // Pad label editor
  const [labelDraft, setLabelDraft] = useState("");


  // Ops Chat (Judge ↔ Admin)
  const [commSnap, setCommSnap] = useState<CommSnapshot | null>(null);
  const [commDraft, setCommDraft] = useState("");
  const [commSendBusy, setCommSendBusy] = useState(false);
  const [commError, setCommError] = useState<string | null>(null);

  // used only to prevent burst presence spam on rapid pad switches
  const lastPresenceSentAtRef = useRef<number>(0);
  const assignedPadRef = useRef<number | null>(null);
  assignedPadRef.current = activePadId;

  const JUDGE_PAD_STORAGE_KEY = "cacc_judge_pad";

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(max-width: 640px)");
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener?.("change", update);
    return () => mq.removeEventListener?.("change", update);
  }, []);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(JUDGE_PAD_STORAGE_KEY);
      if (raw != null) {
        const n = parseInt(raw, 10);
        if (Number.isFinite(n) && n > 0) setLockedPadId(n);
      }
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    fetch("/api/socket");
    const s = getSocket() as any;
    setSocket(s ?? null);

    if (!s?.on) return;

    const onConnect = () => {
      setConnected(true);
      const sid = String(s.id ?? "");
      setSocketId(sid);
    };

    const onDisconnect = () => {
      setConnected(false);
      setSocketId("");
      setJudgeBound(false);
      setBindError(null);
    };

    const onState = (next: BoardState) => {
      const padId = assignedPadRef.current;
      const pad = (next?.pads ?? []).find((p: { id: number }) => p.id === padId);
      if (pad && typeof window !== "undefined") {
        console.log("[judge:state] pad", padId, "now=", pad.now?.id ?? null, "onDeck=", pad.onDeck?.id ?? null, "standbyLen=", (pad.standby ?? []).length);
      }
      setState(next);
    };

    const onJudgeError = (payload: { message?: string }) => {
      const msg = payload?.message ?? "Error";
      setLastAction(`❌ ${msg}`);
    };

    s.on("connect", onConnect);
    s.on("disconnect", onDisconnect);
    s.on("state", onState);
    s.on("judge:error", onJudgeError);

    setConnected(Boolean(s.connected));
    if (Boolean(s.connected)) {
      const sid = String(s.id ?? "");
      setSocketId(sid);
    }

    const interval = setInterval(() => tick((t) => t + 1), 1000);

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setShowAdd(false);
        setShowConfirmChangeArea(false);
      }
    };
    window.addEventListener("keydown", onKey);

    return () => {
      s.off?.("connect", onConnect);
      s.off?.("disconnect", onDisconnect);
      s.off?.("state", onState);
      s.off?.("judge:error", onJudgeError);
      clearInterval(interval);
      window.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pads = useMemo(() => state?.pads ?? [], [state]);
  const nowMs = Date.now();
  const compNowMs = getCompetitionNowMs(state ?? null, nowMs);
  const isLive = (state as any)?.eventStatus === "LIVE";

  useEffect(() => {
    if (pads.length === 0) return; // Don't clear on initial load before state
    setLockedPadId((prev) => {
      if (prev == null) return prev;
      const exists = pads.some((p) => p.id === prev);
      const next = exists ? prev : pads[0].id;
      if (next !== prev) {
        try {
          localStorage.setItem(JUDGE_PAD_STORAGE_KEY, String(next));
        } catch {
          /* ignore */
        }
      }
      return next;
    });
  }, [pads]);

  useEffect(() => {
    if (!isMobile) setShowMobileAreaList(false);
  }, [isMobile]);

  const pad: Pad | null = useMemo(
    () => pads.find((p) => p.id === activePadId) ?? null,
    [pads, activePadId],
  );

  useEffect(() => {
    if (!pad) return;
    setLabelDraft(pad.label ?? "");
  }, [pad?.id]);

  const canEmit = !!socket?.emit && connected && judgeBound;
  const canActOnPad = canEmit && !!pad;

  // ===== Ops Chat wiring (Judge ↔ Admin) =====
  useEffect(() => {
    if (!socket) return;

    const onSnap = (snap: CommSnapshot) => setCommSnap(snap);
    const onBroadcast = (payload: {
      id: string;
      ts: number;
      text: string;
      ttlSeconds?: number;
    }) => {
      setCommSnap((prev) => {
        if (!prev) return prev;
        return { ...prev, lastBroadcast: payload };
      });
    };

    socket.on?.("comm:snapshot", onSnap);
    socket.on?.("comm:broadcast", onBroadcast);

    return () => {
      socket.off?.("comm:snapshot", onSnap);
      socket.off?.("comm:broadcast", onBroadcast);
    };
  }, [socket]);

  // ===== Judge area bind handshake (must succeed before actions work) =====
  const BIND_ERROR_MSG = "Unable to connect to judge console. Please refresh or log in again.";

  useEffect(() => {
    if (!socket || lockedPadId == null) {
      setJudgeBound(false);
      setBindError(null);
      return;
    }

    setJudgeBound(false);
    setBindError(null);
    let bindFailed = false;
    let bindTimeout: ReturnType<typeof setTimeout> | null = null;

    const handleBindFailure = (reason?: string) => {
      if (bindFailed) return;
      bindFailed = true;
      if (bindTimeout) {
        clearTimeout(bindTimeout);
        bindTimeout = null;
      }
      setJudgeBound(false);
      setBindError(BIND_ERROR_MSG);
      setLastAction(reason ? `❌ ${reason}` : "❌ Bind failed");
    };

    const doBind = () => {
      bindFailed = false;
      setBindError(null);
      bindTimeout = setTimeout(() => handleBindFailure("Bind timeout"), 5000);

      (socket as any).emit?.(
        "judge:area:set",
        { padId: lockedPadId },
        (ack?: { ok?: boolean; assignedPadId?: number; error?: string }) => {
          if (bindFailed) return;
          bindFailed = true;
          if (bindTimeout) {
            clearTimeout(bindTimeout);
            bindTimeout = null;
          }
          if (ack?.ok === true) {
            setJudgeBound(true);
            setBindError(null);
            setLastAction("—");
            (socket as any).emit?.("comm:joinPad", { padId: lockedPadId });
          } else {
            handleBindFailure(ack?.error ?? "Bind failed");
          }
        },
      );
    };

    const onBindError = (payload: { message?: string; error?: string }) => {
      handleBindFailure(payload?.message ?? payload?.error ?? "Unable to bind as judge. Please log in again.");
    };

    doBind();

    const onConnect = () => {
      if (lockedPadId != null) doBind();
    };

    socket.on?.("connect", onConnect);
    socket.on?.("judge:bind:error", onBindError);
    return () => {
      if (bindTimeout) clearTimeout(bindTimeout);
      socket.off?.("connect", onConnect);
      socket.off?.("judge:bind:error", onBindError);
    };
  }, [socket, lockedPadId]);

  useEffect(() => {
    if (!socket || !judgeBound) return;

    const sendPresence = () => {
      if (activePadId == null) return;
      const now = Date.now();
      if (now - lastPresenceSentAtRef.current < 500) return; // small burst guard
      lastPresenceSentAtRef.current = now;
      socket.emit?.("comm:presence", { padId: activePadId });
    };

    sendPresence();
    const t = setInterval(sendPresence, 15000);

    return () => clearInterval(t);
  }, [socket, activePadId, judgeBound]);

  const myChat: CommMessage[] =
    commSnap?.channels?.find((c) => c.padId === activePadId)?.messages ?? [];
  const lastUnackedUrgent = useMemo(
    () =>
      [...myChat].reverse().find((m) => m.urgent && m.ackedAt == null) ?? null,
    [myChat],
  );
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const lastUrgentIdRef = useRef<string | null>(null);

  useEffect(() => {
    const unacked = [...myChat]
      .reverse()
      .find((m) => m.urgent && m.ackedAt == null);
    if (unacked && unacked.id !== lastUrgentIdRef.current) {
      lastUrgentIdRef.current = unacked.id;
      chatScrollRef.current
        ?.querySelector(`[data-msg-id="${unacked.id}"]`)
        ?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
    if (!unacked) lastUrgentIdRef.current = null;
  }, [myChat]);

  function sendJudgeChat() {
    const text = commDraft.trim();
    if (!text) return;
    if (!socket) return;
    if (!canEmit) return;

    setCommSendBusy(true);
    setCommError(null);

    socket.emit?.("judge:comm:send", { text });

    setCommDraft("");
    setTimeout(() => setCommSendBusy(false), 250);
  }

  function ackUrgent() {
    if (!lastUnackedUrgent || !socket) return;
    socket.emit?.("judge:comm:ack", { messageId: lastUnackedUrgent.id });
  }

  // schedule awareness (thin)
  const schedule = useMemo(
    () => sortSchedule(state?.schedule ?? []),
    [state?.schedule],
  );
  const globalSchedule = useMemo(
    () => schedule.filter((e) => e.scope === "GLOBAL"),
    [schedule],
  );
  const nowSched = useMemo(
    () => nowBlock(globalSchedule, nowMs),
    [globalSchedule, nowMs],
  );
  const nextSched = useMemo(
    () => nextBlock(globalSchedule, nowMs),
    [globalSchedule, nowMs],
  );
  const nextBL = useMemo(
    () => nextBreakLike(globalSchedule, nowMs),
    [globalSchedule, nowMs],
  );
  const nextBLsec = nextBL ? (nextBL.startAt - nowMs) / 1000 : null;
  const breakSoon = nextBLsec != null && nextBLsec > 0 && nextBLsec <= 15 * 60;

  // Global break / message
  const gbStart = state?.globalBreakStartAt ?? null;
  const gbUntil = state?.globalBreakUntilAt ?? null;
  const gbReason = (state?.globalBreakReason ?? "Break").trim();

  const globalBreakActive =
    (!gbStart || nowMs >= gbStart) && !!gbUntil && nowMs < gbUntil;
  const effectiveNow = compNowMs ?? nowMs;
  const globalBreakRemaining =
    globalBreakActive && gbUntil ? (gbUntil - effectiveNow) / 1000 : null;

  // Local pad state (gated by isLive in PLANNING mode)
  const localBreakActive = isLive && !!pad?.breakUntilAt && pad.breakUntilAt > effectiveNow;
  const localBreakRemaining =
    isLive && localBreakActive && pad?.breakUntilAt
      ? (pad.breakUntilAt - effectiveNow) / 1000
      : null;

  const arrivedValid = !!pad && isArrivedForNow(pad);

  // Dedicated tick for on-pad timer so it counts up even without other state updates
  const onPadUnitId = pad?.now?.id ?? null;
  const arrivedAtMs = pad?.nowArrivedAt ?? null;
  const [onPadTick, setOnPadTick] = useState(0);
  useEffect(() => {
    if (arrivedAtMs == null) return;
    const id = setInterval(() => setOnPadTick((t) => t + 1), 500);
    return () => clearInterval(id);
  }, [arrivedAtMs, onPadUnitId]);

  const reportActive = isLive && !!pad && !globalBreakActive && reportIsValid(pad, effectiveNow);
  const reportSecondsRemaining =
    isLive && reportActive && pad?.reportByDeadlineAt
      ? (pad.reportByDeadlineAt - effectiveNow) / 1000
      : null;
  const reportIsLate =
    reportSecondsRemaining !== null && reportSecondsRemaining < 0;

  void onPadTick; // ensure tick drives re-renders (prevents React optimization)
  const elapsedSec = arrivedAtMs ? Math.floor(Math.max(0, (Date.now() - arrivedAtMs) / 1000)) : 0;

  const canAdvance = canActOnPad && !globalBreakActive && !localBreakActive;
  const canMarkArrived = canAdvance && !!pad?.now && !arrivedValid;
  const canMarkComplete = canAdvance && !!pad?.now;
  const canSkipTeam =
    canAdvance &&
    !!pad?.now &&
    (!!pad?.onDeck || (pad?.standby?.length ?? 0) > 0);

  const payloadBase = {
    padId: activePadId,
    id: activePadId,
    pad: activePadId,
    padIndex: Math.max(0, (activePadId ?? 0) - 1),
  };

  function emit(event: string, payload: any, label: string) {
    if (!canEmit) return;
    setLastAction(`✅ ${label}`);
    socket!.emit!(event, payload);
  }
  const emitPad = (event: string, payload: any, label: string) => {
    if (!canActOnPad) return;
    emit(event, payload, label);
  };
  const emitPadWithAck = (
    event: string,
    payload: any,
    label: string,
    ack: (res: { ok: boolean; error?: string }) => void,
  ) => {
    if (!canActOnPad) return;
    setLastAction(`${label} …`);
    (socket as any)?.emit?.(event, payload, (res: { ok?: boolean; error?: string }) => {
      const ok = res?.ok === true;
      if (ok) {
        setLastAction(`✅ ${label}`);
      } else {
        setLastAction(`❌ ${label}${res?.error ? `: ${res.error}` : ""}`);
      }
      ack({ ok, error: res?.error });
    });
  };

  async function logout() {
    try {
      await fetch("/api/admin-logout", { method: "POST" });
    } catch {}
    window.location.href = "/judge/login";
  }

  // Primary actions
  const doArrived = () => emitPad("judge:arrived", payloadBase, "MARK ARRIVED");
  const doComplete = () => emitPad("judge:complete", payloadBase, "COMPLETE");
  const doUndo = () => emitPad("judge:undo", payloadBase, "UNDO");

  // Secondary ops
  const doSkip = () =>
    emitPadWithAck("judge:skipNow", payloadBase, "Skip Team", () => {});

  const doStartBreak = () => {
    const mins = Math.max(1, Number(breakMinutes || 10));
    emitPad(
      "judge:startBreak",
      {
        ...payloadBase,
        minutes: mins,
        reason: (breakReason || "Break").trim(),
        overrideReport: true,
      },
      `START BREAK (${mins}m)`,
    );
  };
  const doEndBreak = () => emitPad("judge:endBreak", payloadBase, "END BREAK");

  const doSetLabel = () => {
    const label = labelDraft.trim();
    if (!label) return;
    emitPad("judge:setPadLabel", { ...payloadBase, label }, "SET PAD LABEL");
  };

  const doAddTeam = () => {
    const teamName = addTeamName.trim();
    if (!teamName) return;

    emitPad(
      "judge:addTeam",
      {
        ...payloadBase,
        where: addWhere,
        teamName,
        teamId: addTeamId.trim() || undefined,
        unit: addUnit.trim() || undefined,
        division: addDivision || undefined,
        category: addCategory.trim() || undefined,
      },
      `MANUAL ADD (${addWhere})`,
    );

    setShowAdd(false);
    setAddWhere("END");
    setAddTeamName("");
    setAddTeamId("");
    setAddUnit("");
    setAddDivision("");
    setAddCategory("");
  };

  // ARRIVED button “ops-glow” when reporting is active
  const arrivedBtnStyle: React.CSSProperties = !canActOnPad
    ? buttonStyle({ bg: "rgba(0,0,0,0.25)", disabled: true })
    : arrivedValid
      ? {
          ...buttonStyle({ bg: "rgba(46,125,50,0.85)", disabled: false }),
          opacity: 0.95,
        }
      : reportActive
        ? {
            ...buttonStyle({ bg: COLOR_BLUE, fg: "#111", disabled: false }),
            border: "2px solid rgba(144, 202, 249, 0.95)",
            boxShadow:
              "0 0 0 6px rgba(144, 202, 249, 0.22), 0 10px 26px rgba(0,0,0,0.30)",
            animation: "pulseGlow 1.2s ease-in-out infinite",
          }
        : buttonStyle({ bg: "rgba(0,0,0,0.25)", disabled: false });

  return (
    <>
      <Head>
        <title>Competition Matrix — Judge Console</title>
      </Head>

      <style>{`
        @keyframes pulseGlow {
          0% { box-shadow: 0 0 0 6px rgba(144, 202, 249, 0.18), 0 10px 26px rgba(0,0,0,0.30); }
          50% { box-shadow: 0 0 0 10px rgba(144, 202, 249, 0.30), 0 10px 26px rgba(0,0,0,0.30); }
          100% { box-shadow: 0 0 0 6px rgba(144, 202, 249, 0.18), 0 10px 26px rgba(0,0,0,0.30); }
        }
        @keyframes lateFlash { 0%{opacity:1} 50%{opacity:.55} 100%{opacity:1} }
        @keyframes urgentFlash { 0%,100%{background:rgba(220,53,69,0.25)} 50%{background:rgba(220,53,69,0.45)} }

        .layout.judge-layout {
          display: grid;
          grid-template-columns: 220px minmax(0, 1fr) 360px;
          gap: 14px;
          margin-top: 14px;
        }
        @media (max-width: 1024px) {
          .layout.judge-layout { grid-template-columns: 200px minmax(0, 1fr) min(360px, 30vw); }
        }
        @media (max-width: 640px) {
          .layout.judge-layout { grid-template-columns: 1fr; }
        }
        @media (max-width: 640px) {
          .judge-header {
            padding: 12px 12px !important;
            gap: 10px !important;
          }
          .judge-header-brand {
            gap: 10px !important;
            width: 100%;
          }
          .judge-header-brand img {
            width: 58px !important;
            height: 58px !important;
            padding: 6px !important;
          }
          .judge-header-kicker {
            font-size: 13px !important;
            letter-spacing: 0.7px !important;
          }
          .judge-header-title {
            font-size: clamp(22px, 6vw, 30px) !important;
          }
          .judge-mobile-statusline {
            display: block !important;
            margin-top: 4px;
            font-size: 12px;
            color: var(--text-secondary);
          }
          .judge-header-actions {
            width: 100%;
            gap: 8px !important;
          }
          .judge-schedule-strip {
            margin-top: 8px !important;
            padding: 10px !important;
          }
          .judge-center-panel {
            padding: 12px !important;
          }
          .judge-now-actions button {
            min-height: 54px !important;
          }
          .judge-mobile-switch {
            width: 100%;
            justify-content: center;
          }
        }

        .chatScroll {
          max-height: 260px;
          overflow: auto;
          padding-right: 6px;
        }
        .chatBubble {
          border-radius: 14px;
          padding: 10px 12px;
          border: 1px solid rgba(255,255,255,0.12);
          background: rgba(0,0,0,0.20);
        }
      `}</style>

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
        {/* Header (Admin-style) */}
        <header
          className="judge-header"
          style={{
            ...cardStyle(),
            padding: "16px 18px",
            display: "flex",
            gap: 14,
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
          }}
        >
          <div className="judge-header-brand" style={{ display: "flex", gap: 16, alignItems: "center" }}>
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
                className="judge-header-kicker"
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
                  marginTop: 6,
                  display: "flex",
                  gap: 12,
                  alignItems: "baseline",
                  flexWrap: "wrap",
                }}
              >
                <div
                  className="judge-header-title"
                  style={{ fontSize: 40, fontWeight: 1000, lineHeight: 1.05 }}
                >
                  JUDGE CONSOLE
                </div>

                <div
                  className="judge-mobile-statusline"
                  style={{ display: "none" }}
                >
                  {pad
                    ? `PAD ${lockedPadId} — ${areaLabel(pad) || "UNLABELED"}`
                    : "PAD —"}{" "}
                  • {connected ? "CONNECTED" : "CONNECTING"}
                </div>

                <div style={{ fontSize: 12, opacity: 0.8 }}>
                  {state?.updatedAt
                    ? `Last update: ${fmtTime(state.updatedAt)}`
                    : "Waiting for state…"}{" "}
                  • Last action: {lastAction}
                </div>
              </div>
            </div>
          </div>

          <div
            className="judge-header-actions"
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

            {lockedPadId != null && pad ? (
              <span
                style={chipStyle(
                  judgeBound ? "rgba(76, 175, 80, 0.35)" : bindError ? "rgba(244, 67, 54, 0.35)" : "rgba(255, 152, 0, 0.35)",
                  "white",
                )}
              >
                {judgeBound ? `Assigned: Pad ${lockedPadId}` : bindError ?? "Binding…"}
              </span>
            ) : null}

            {isMobile ? (
              <button
                onClick={() => setShowMobileAreaList((v) => !v)}
                style={buttonStyle({ bg: "rgba(0,0,0,0.25)", disabled: false })}
                className="judge-mobile-switch"
              >
                {showMobileAreaList
                  ? "Close Area List"
                  : `Switch Pad${lockedPadId != null ? ` (Pad ${lockedPadId})` : ""}`}
              </button>
            ) : null}

            <button
              onClick={logout}
              style={buttonStyle({ bg: "rgba(0,0,0,0.25)", disabled: false })}
            >
              Logout
            </button>
          </div>
        </header>

        {/* Schedule strip */}
        <div className="judge-schedule-strip" style={{ marginTop: 12, ...cardStyle(), padding: 12 }}>
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
              {nowSched
                ? `${nowSched.title} (${fmtTime(nowSched.startAt)}–${fmtTime(nowSched.endAt)})`
                : "—"}
            </div>
            <div style={{ opacity: 0.85 }}>
              NEXT:{" "}
              {nextSched
                ? `${nextSched.title} (${fmtTime(nextSched.startAt)}–${fmtTime(nextSched.endAt)})`
                : "—"}
            </div>
            {breakSoon && nextBL ? (
              <div
                style={{
                  marginLeft: "auto",
                  fontWeight: 950,
                  color: "var(--cacc-gold)",
                }}
              >
                ⚠️ {nextBL.title} begins in {mmss(nextBLsec ?? 0)} (at{" "}
                {fmtTime(nextBL.startAt)})
              </div>
            ) : null}
          </div>
        </div>

        {/* Main 3-zone layout */}
        <div className="layout judge-layout">
          {/* LEFT: AREA TOGGLE */}
          {(!isMobile || showMobileAreaList) ? (
          <aside style={{ ...cardStyle(), padding: 12 }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "baseline",
              }}
            >
              <div style={{ fontWeight: 1000 }}>Areas</div>
              <div style={{ fontSize: 11, opacity: 0.75 }}>
              {lockedPadId != null ? "Assigned" : "Select area"}
            </div>
            </div>

            <div
              style={{
                marginTop: 4,
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              {pads.length === 0 ? (
                <div style={{ opacity: 0.75, fontSize: 13 }}>No areas yet.</div>
              ) : (
              pads.map((p) => {
                const isLocked = p.id === lockedPadId;
                const handleClick = () => {
                  if (lockedPadId === null) {
                    setLockedPadId(p.id);
                    if (isMobile) setShowMobileAreaList(false);
                    try {
                      localStorage.setItem(JUDGE_PAD_STORAGE_KEY, String(p.id));
                    } catch {
                      /* ignore */
                    }
                    socket?.emit?.("judge:area:set", { padId: p.id });
                  } else if (p.id === lockedPadId) {
                    /* no-op */
                  } else {
                    setPendingPadId(p.id);
                    setShowConfirmChangeArea(true);
                  }
                };
                return (
                  <button
                    key={p.id}
                    onClick={handleClick}
                    style={{
                      position: "relative",
                      textAlign: "left",
                      padding: "10px 12px",
                      borderRadius: 14,
                      border: isLocked
                        ? "2.5px solid rgba(76, 175, 80, 0.7)"
                        : "1px solid rgba(255,255,255,0.12)",
                      background: isLocked
                        ? "rgba(76, 175, 80, 0.20)"
                        : "rgba(0,0,0,0.18)",
                      color: "white",
                      cursor: "pointer",
                      opacity: isLocked ? 1 : 0.85,
                    }}
                  >
                    {isLocked ? (
                      <span
                        style={{
                          position: "absolute",
                          top: 8,
                          right: 10,
                          fontSize: 10,
                          opacity: 0.7,
                          letterSpacing: 0.3,
                        }}
                      >
                        Assigned
                      </span>
                    ) : null}
                    <div style={{ fontWeight: 950 }}>{areaName(p)}</div>
                    <div
                      style={{
                        marginTop: 4,
                        fontSize: 11,
                        opacity: 0.8,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {areaLabel(p)}
                    </div>
                  </button>
                );
              })
              )}
            </div>
          </aside>
          ) : null}

          {/* CENTER: OPERATOR */}
          <section className="judge-center-panel" style={{ ...cardStyle(), padding: 16 }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 12,
                flexWrap: "wrap",
                alignItems: "flex-start",
              }}
            >
              <PadHeader
                variant="operational"
                padName={pad ? areaName(pad) : "—"}
                subtitle={pad ? areaLabel(pad) : ""}
                statusPill={
                  <span
                    style={chipStyle(
                      pad && localBreakActive
                        ? COLOR_ORANGE
                        : pad && reportActive
                          ? reportIsLate
                            ? COLOR_RED
                            : COLOR_YELLOW
                          : pad && arrivedValid
                            ? COLOR_BLUE
                            : "rgba(255,255,255,0.12)",
                      pad && localBreakActive
                        ? "#111"
                        : pad && reportIsLate
                          ? "white"
                          : pad && reportActive
                            ? "#111"
                            : pad && arrivedValid
                              ? "#111"
                              : "white",
                    )}
                  >
                    {pad && localBreakActive
                      ? "BREAK"
                      : pad && reportActive
                        ? reportIsLate
                          ? "LATE"
                          : "REPORTING"
                        : pad && arrivedValid
                          ? "ON PAD"
                          : "IDLE"}
                  </span>
                }
                updatedAt={
                  pad?.updatedAt
                    ? `Updated: ${fmtTime(pad.updatedAt)}`
                    : undefined
                }
              />
              <div
                style={{
                  display: "flex",
                  gap: 10,
                  flexWrap: "wrap",
                  alignItems: "center",
                }}
              >
                <button
                  onClick={() => setShowAdd(true)}
                  disabled={!canEmit}
                  style={buttonStyle({
                    bg: "rgba(0,0,0,0.25)",
                    disabled: !canEmit,
                  })}
                >
                  Manual Add
                </button>
                <button
                  disabled={!canEmit}
                  onClick={doUndo}
                  style={buttonStyle({
                    bg: "rgba(0,0,0,0.25)",
                    disabled: !canEmit,
                  })}
                >
                  Undo
                </button>
              </div>
            </div>

            {/* PRIMARY SECTION (merged: status + competitor once, no duplication) */}
            <div style={{ marginTop: 14 }}>
              {pad && localBreakActive ? (
                <PadPrimarySection
                  variant={isMobile ? "display" : "operational"}
                  statusAccent={COLOR_ORANGE}
                  statusBadge={
                    <span style={chipStyle(COLOR_ORANGE, "#111")}>BREAK</span>
                  }
                  timer={
                    <span
                      style={{
                        fontFamily:
                          "ui-monospace, SFMono-Regular, Menlo, monospace",
                        fontWeight: 1000,
                      }}
                    >
                      {localBreakRemaining != null ? mmssFromSeconds(localBreakRemaining) : "—"}
                    </span>
                  }
                  competitorContent={(pad.breakReason ?? "Break").trim()}
                  subContent={`Reporting resumes at ${pad.breakUntilAt ? fmtTime(pad.breakUntilAt) : "—"}`}
                  bannerOverrides={{
                    background: "rgba(255,152,0,0.12)",
                    border: `2px solid ${COLOR_ORANGE}`,
                  }}
                />
              ) : pad && reportActive && pad.reportByDeadlineAt ? (
                <PadPrimarySection
                  variant={isMobile ? "display" : "operational"}
                  statusAccent={reportIsLate ? COLOR_RED : COLOR_YELLOW}
                  statusBadge={
                    <span
                      style={chipStyle(
                        reportIsLate ? COLOR_RED : COLOR_YELLOW,
                        reportIsLate ? "white" : "#111",
                      )}
                    >
                      {reportIsLate ? "LATE" : "REPORTING"}
                    </span>
                  }
                  timer={
                    <span
                      style={{
                        fontFamily:
                          "ui-monospace, SFMono-Regular, Menlo, monospace",
                        fontWeight: 1000,
                        color: reportIsLate ? "white" : "#111",
                      }}
                    >
                      {reportSecondsRemaining != null
                        ? reportSecondsRemaining >= 0
                          ? mmssFromSeconds(reportSecondsRemaining)
                          : mmssFromSeconds(-reportSecondsRemaining)
                        : "—"}
                    </span>
                  }
                  competitorContent={pad.now?.name ?? "—"}
                  subContent="Press MARK ARRIVED as soon as the team is physically on the pad."
                  bannerOverrides={{
                    background: reportIsLate
                      ? "rgba(198,40,40,0.16)"
                      : "rgba(255,235,59,0.14)",
                    border: `2px solid ${reportIsLate ? COLOR_RED : COLOR_YELLOW}`,
                  }}
                  lateFlash={reportIsLate}
                />
              ) : pad && arrivedValid ? (
                <PadPrimarySection
                  variant={isMobile ? "display" : "operational"}
                  statusAccent={COLOR_BLUE}
                  statusBadge={
                    <span style={chipStyle(COLOR_BLUE, "#111")}>ON PAD</span>
                  }
                  timer={
                    <span
                      style={{
                        fontFamily:
                          "ui-monospace, SFMono-Regular, Menlo, monospace",
                        fontWeight: 1000,
                      }}
                    >
                      {arrivedAtMs != null ? mmss(elapsedSec) : "—"}
                    </span>
                  }
                  competitorContent={pad.now?.name ?? "—"}
                  subContent={`Arrived at ${pad.nowArrivedAt ? fmtTime(pad.nowArrivedAt) : "—"}`}
                  bannerOverrides={{
                    background: "rgba(144,202,249,0.12)",
                    border: "2px solid rgba(144,202,249,0.85)",
                  }}
                />
              ) : (
                <PadPrimarySection
                  variant={isMobile ? "display" : "operational"}
                  statusAccent="rgba(255,255,255,0.12)"
                  statusBadge={
                    <span style={chipStyle("rgba(255,255,255,0.12)", "white")}>
                      {isLive ? "IDLE" : "PLANNING"}
                    </span>
                  }
                  competitorContent={pad?.now?.name ?? "Ready"}
                  subContent={
                    isLive
                      ? "No active timers on this pad right now."
                      : "Event not started. Admin must click Start Now to begin."
                  }
                  bannerOverrides={{
                    background: "rgba(0,0,0,0.22)",
                    border: "1px solid rgba(255,255,255,0.10)",
                  }}
                />
              )}

              {/* NOW team actions: single row under the NOW card */}
              {pad?.now ? (
                <div
                  className="judge-now-actions"
                  style={{
                    marginTop: 10,
                    display: "flex",
                    flexDirection: "row",
                    gap: 8,
                    flexWrap: "wrap",
                    alignItems: "stretch",
                  }}
                >
                  <button
                    disabled={!canMarkArrived}
                    onClick={doArrived}
                    style={{
                      ...arrivedBtnStyle,
                      flex: "1 1 0",
                      minWidth: 100,
                    }}
                  >
                    Mark Arrived
                  </button>
                  <button
                    disabled={!canMarkComplete}
                    onClick={doComplete}
                    style={{
                      ...buttonStyle({
                        bg: "var(--cacc-gold)",
                        fg: "#111",
                        disabled: !canMarkComplete,
                      }),
                      flex: "1 1 0",
                      minWidth: 100,
                    }}
                  >
                    Mark Complete
                  </button>
                  <button
                    disabled={!canSkipTeam}
                    onClick={doSkip}
                    style={{
                      ...buttonStyle({
                        bg: "rgba(0,0,0,0.25)",
                        disabled: !canSkipTeam,
                      }),
                      flex: "1 1 0",
                      minWidth: 80,
                    }}
                  >
                    Skip Team
                  </button>
                </div>
              ) : null}
            </div>

            {/* On Deck & Standby (informational only) */}
            <div style={{ marginTop: 14 }}>
              <PadOnDeckSection
                variant="operational"
                label="ON DECK"
                labelRight="NEXT"
              >
                {teamLine(pad?.onDeck)}
              </PadOnDeckSection>

              <PadStandbySection
                variant="operational"
                count={pad?.standby?.length ?? 0}
              >
                {(pad?.standby?.length ?? 0) === 0 ? (
                  <span style={{ opacity: 0.75 }}>—</span>
                ) : (
                  <div
                    style={{ display: "flex", flexDirection: "column", gap: 6 }}
                  >
                    {(pad?.standby ?? []).slice(0, 6).map((t, idx) => (
                      <div key={t.id} style={{ fontSize: 13, opacity: 0.95 }}>
                        <span
                          style={{
                            opacity: 0.7,
                            fontFamily:
                              "ui-monospace, SFMono-Regular, Menlo, monospace",
                          }}
                        >
                          #{idx + 1}
                        </span>{" "}
                        {teamLine(t)}
                      </div>
                    ))}
                    {(pad?.standby?.length ?? 0) > 6 ? (
                      <div style={{ opacity: 0.75, fontSize: 12 }}>
                        +{pad!.standby.length - 6} more…
                      </div>
                    ) : null}
                  </div>
                )}
              </PadStandbySection>
            </div>
          </section>

          {/* RIGHT: Tools */}
          <aside className="toolsCol judge-tools-col">
            <div style={{ ...cardStyle(), padding: 14 }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "baseline",
                }}
              >
                <div style={{ fontWeight: 1000 }}>Tools</div>
              </div>

              {/* =========================
                  JUDGE ↔ ADMIN CHAT
                 ========================= */}
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
                    alignItems: "center",
                    justifyContent: "space-between",
                    marginBottom: 10,
                  }}
                >
                  <div style={{ fontWeight: 1000 }}>🗨️ Ops Chat</div>
                  <div style={{ opacity: 0.75, fontSize: 12 }}>
                    <div style={{ opacity: 0.75, fontSize: 12 }}>
                      Area {activePadId ?? "—"}
                    </div>
                  </div>
                </div>

                {commSnap?.lastBroadcast?.text ? (
                  <div
                    style={{
                      border: "1px solid rgba(255,152,0,0.35)",
                      background: "rgba(255,152,0,0.12)",
                      borderRadius: 12,
                      padding: 10,
                      marginBottom: 10,
                    }}
                  >
                    <div style={{ fontWeight: 900, marginBottom: 4 }}>
                      📣 Admin Broadcast
                    </div>
                    <div style={{ opacity: 0.92 }}>
                      {commSnap.lastBroadcast.text}
                    </div>
                    <div style={{ opacity: 0.6, fontSize: 12, marginTop: 6 }}>
                      {formatHhmm(commSnap.lastBroadcast.ts)}
                    </div>
                  </div>
                ) : null}

                <div
                  ref={chatScrollRef}
                  style={{
                    height: 180,
                    overflow: "auto",
                    padding: 10,
                    borderRadius: 12,
                    border: "1px solid rgba(255,255,255,0.10)",
                    background: "rgba(0,0,0,0.25)",
                    marginBottom: 10,
                  }}
                >
                  {myChat.length === 0 ? (
                    <div style={{ opacity: 0.7, fontSize: 13 }}>
                      No messages yet.
                    </div>
                  ) : (
                    myChat.slice(-80).map((m) => (
                      <div
                        key={m.id}
                        data-msg-id={m.id}
                        style={{ marginBottom: 8, display: "flex", gap: 8 }}
                      >
                        <div
                          style={{
                            width: 70,
                            opacity: 0.7,
                            fontSize: 12,
                            paddingTop: 2,
                          }}
                        >
                          {m.from === "ADMIN" ? "ADMIN" : "YOU"} •{" "}
                          {formatHhmm(m.ts)}
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
                              {m.ackedAt ? "Acknowledged" : "⚠ Urgent"}
                            </div>
                          )}
                        </div>
                        <div
                          style={{
                            flex: 1,
                            borderRadius: 10,
                            padding: "8px 10px",
                            border:
                              m.urgent && !m.ackedAt
                                ? "2px solid var(--danger)"
                                : "1px solid rgba(255,255,255,0.10)",
                            background:
                              m.from === "ADMIN"
                                ? "rgba(0, 150, 255, 0.10)"
                                : "rgba(0, 200, 120, 0.10)",
                            whiteSpace: "pre-wrap",
                            animation:
                              m.urgent && !m.ackedAt
                                ? "urgentFlash 1.5s ease-in-out 3"
                                : undefined,
                          }}
                        >
                          {m.text}
                        </div>
                      </div>
                    ))
                  )}
                </div>

                {lastUnackedUrgent ? (
                  <div style={{ marginBottom: 8 }}>
                    <button
                      onClick={ackUrgent}
                      disabled={!canEmit}
                      style={buttonStyle({
                        bg: "var(--danger)",
                        fg: "white",
                        disabled: !canEmit,
                      })}
                    >
                      Acknowledge
                    </button>
                  </div>
                ) : null}

                {commError ? (
                  <div
                    style={{
                      color: "var(--danger)",
                      fontSize: 13,
                      marginBottom: 8,
                    }}
                  >
                    {commError}
                  </div>
                ) : null}

                <div style={{ display: "flex", gap: 8 }}>
                  <input
                    value={commDraft}
                    onChange={(e) => setCommDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        sendJudgeChat();
                      }
                    }}
                    placeholder="Message Admin… (Enter to send)"
                    style={{
                      flex: 1,
                      padding: "10px 12px",
                      borderRadius: 12,
                      border: "1px solid rgba(255,255,255,0.18)",
                      background: "rgba(0,0,0,0.25)",
                      color: "white",
                      outline: "none",
                    }}
                    disabled={!canEmit}
                  />
                  <button
                    onClick={sendJudgeChat}
                    disabled={!canEmit || commSendBusy || !commDraft.trim()}
                    style={buttonStyle({
                      bg:
                        !canEmit || commSendBusy || !commDraft.trim()
                          ? "rgba(0,0,0,0.25)"
                          : "var(--cacc-gold)",
                      fg: "#111",
                      disabled: !canEmit || commSendBusy || !commDraft.trim(),
                    })}
                  >
                    Send
                  </button>
                </div>
              </div>

              {/* Area Break */}
              <div
                style={{
                  marginTop: 12,
                  borderRadius: 16,
                  padding: 12,
                  background: "rgba(255,152,0,0.10)",
                  border: `1px solid rgba(255,152,0,0.35)`,
                }}
              >
                <div style={{ fontWeight: 1000 }}>🟠 Area Break</div>
                <div style={{ marginTop: 8, opacity: 0.75, fontSize: 12 }}>
                  Start an area-only break. If pressed during reporting, it
                  overrides the report timer.
                </div>

                <div
                  style={{
                    marginTop: 10,
                    display: "flex",
                    gap: 10,
                    flexWrap: "wrap",
                    alignItems: "center",
                  }}
                >
                  <input
                    value={breakReason}
                    onChange={(e) => setBreakReason(e.target.value)}
                    placeholder="Reason"
                    style={{
                      flex: "1 1 180px",
                      padding: "10px 12px",
                      borderRadius: 12,
                      border: "1px solid rgba(255,255,255,0.18)",
                      background: "rgba(0,0,0,0.25)",
                      color: "white",
                      outline: "none",
                    }}
                    disabled={!canEmit || globalBreakActive}
                  />
                  <input
                    type="number"
                    min={1}
                    value={breakMinutes}
                    onChange={(e) =>
                      setBreakMinutes(Number(e.target.value || 10))
                    }
                    style={{
                      width: 90,
                      padding: "10px 12px",
                      borderRadius: 12,
                      border: "1px solid rgba(255,255,255,0.18)",
                      background: "rgba(0,0,0,0.25)",
                      color: "white",
                      outline: "none",
                    }}
                    disabled={!canEmit || globalBreakActive}
                  />

                  <button
                    disabled={!canEmit || globalBreakActive}
                    onClick={doStartBreak}
                    style={buttonStyle({
                      bg: COLOR_ORANGE,
                      fg: "#111",
                      disabled: !canEmit || globalBreakActive,
                    })}
                  >
                    Start
                  </button>

                  <button
                    disabled={!canEmit || !localBreakActive}
                    onClick={doEndBreak}
                    style={buttonStyle({
                      bg: "rgba(0,0,0,0.25)",
                      disabled: !canEmit || !localBreakActive,
                    })}
                  >
                    End
                  </button>
                </div>

                {globalBreakActive && globalBreakRemaining != null ? (
                  <div style={{ marginTop: 8, fontSize: 12, opacity: 0.85 }}>
                    Global break active — resumes in{" "}
                    <b>{mmss(globalBreakRemaining)}</b> ({gbReason})
                  </div>
                ) : null}
              </div>

              {/* Area Label */}
              <div
                style={{
                  marginTop: 12,
                  borderRadius: 16,
                  padding: 12,
                  background: "rgba(0,0,0,0.22)",
                  border: "1px solid rgba(255,255,255,0.10)",
                }}
              >
                <div style={{ fontWeight: 1000 }}>Area Label</div>
                <div
                  style={{
                    marginTop: 8,
                    display: "flex",
                    gap: 10,
                    flexWrap: "wrap",
                    alignItems: "center",
                  }}
                >
                  <input
                    value={labelDraft}
                    onChange={(e) => setLabelDraft(e.target.value)}
                    placeholder="Area label"
                    style={{
                      flex: "1 1 220px",
                      padding: "10px 12px",
                      borderRadius: 12,
                      border: "1px solid rgba(255,255,255,0.18)",
                      background: "rgba(0,0,0,0.25)",
                      color: "white",
                      outline: "none",
                    }}
                  />
                  <button
                    disabled={!canEmit || !labelDraft.trim()}
                    onClick={doSetLabel}
                    style={buttonStyle({
                      bg: "rgba(0,0,0,0.25)",
                      disabled: !canEmit || !labelDraft.trim(),
                    })}
                  >
                    Save
                  </button>
                </div>
              </div>

              {/* Manual Add shortcut */}
              <div
                style={{
                  marginTop: 12,
                  borderRadius: 16,
                  padding: 12,
                  background: "rgba(255,255,255,0.05)",
                  border: "1px solid rgba(255,255,255,0.10)",
                }}
              >
                <div style={{ fontWeight: 1000 }}>Manual Add</div>
                <div style={{ marginTop: 8, fontSize: 12, opacity: 0.8 }}>
                  Insert into NOW / ON DECK / END (tagged MANUAL).
                </div>
                <div style={{ marginTop: 10 }}>
                  <button
                    disabled={!canEmit}
                    onClick={() => setShowAdd(true)}
                    style={buttonStyle({
                      bg: "rgba(0,0,0,0.25)",
                      disabled: !canEmit,
                    })}
                  >
                    Open…
                  </button>
                </div>
              </div>

            </div>
          </aside>
        </div>

        {/* Manual Add Modal */}
        {showAdd ? (
          <div
            style={{
              position: "fixed",
              inset: 0,
              background: "rgba(0,0,0,0.55)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 16,
              zIndex: 50,
            }}
            onClick={() => setShowAdd(false)}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                width: "min(760px, 100%)",
                borderRadius: 18,
                background: "rgba(10, 14, 28, 0.98)",
                border: "1px solid rgba(255,255,255,0.16)",
                boxShadow: "0 18px 50px rgba(0,0,0,0.45)",
                padding: 16,
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 10,
                  alignItems: "center",
                }}
              >
                <div style={{ fontWeight: 1000, fontSize: 18 }}>
                  Manual Add Team
                </div>
                <button
                  onClick={() => setShowAdd(false)}
                  style={buttonStyle({
                    bg: "rgba(0,0,0,0.25)",
                    disabled: false,
                  })}
                >
                  Close
                </button>
              </div>

              <div
                style={{
                  marginTop: 12,
                  display: "grid",
                  gridTemplateColumns: "160px 1fr",
                  gap: 10,
                  alignItems: "center",
                }}
              >
                <div style={{ opacity: 0.85, fontWeight: 800 }}>Insert at</div>
                <select
                  value={addWhere}
                  onChange={(e) => setAddWhere(e.target.value as any)}
                  style={{
                    padding: "10px 12px",
                    borderRadius: 12,
                    border: "1px solid rgba(255,255,255,0.18)",
                    background: "rgba(0,0,0,0.25)",
                    color: "white",
                    outline: "none",
                  }}
                >
                  <option value="END">End of Standby</option>
                  <option value="ONDECK">On Deck</option>
                  <option value="NOW">Now</option>
                </select>

                <div style={{ opacity: 0.85, fontWeight: 800 }}>
                  Team Name *
                </div>
                <input
                  value={addTeamName}
                  onChange={(e) => setAddTeamName(e.target.value)}
                  style={{
                    padding: "10px 12px",
                    borderRadius: 12,
                    border: "1px solid rgba(255,255,255,0.18)",
                    background: "rgba(0,0,0,0.25)",
                    color: "white",
                    outline: "none",
                  }}
                />

                <div style={{ opacity: 0.85, fontWeight: 800 }}>
                  Team ID (optional)
                </div>
                <input
                  value={addTeamId}
                  onChange={(e) => setAddTeamId(e.target.value)}
                  style={{
                    padding: "10px 12px",
                    borderRadius: 12,
                    border: "1px solid rgba(255,255,255,0.18)",
                    background: "rgba(0,0,0,0.25)",
                    color: "white",
                    outline: "none",
                  }}
                />

                <div style={{ opacity: 0.85, fontWeight: 800 }}>
                  Unit (optional)
                </div>
                <input
                  value={addUnit}
                  onChange={(e) => setAddUnit(e.target.value)}
                  style={{
                    padding: "10px 12px",
                    borderRadius: 12,
                    border: "1px solid rgba(255,255,255,0.18)",
                    background: "rgba(0,0,0,0.25)",
                    color: "white",
                    outline: "none",
                  }}
                />

                <div style={{ opacity: 0.85, fontWeight: 800 }}>
                  Division (optional)
                </div>
                <select
                  value={addDivision}
                  onChange={(e) => setAddDivision(e.target.value as any)}
                  style={{
                    padding: "10px 12px",
                    borderRadius: 12,
                    border: "1px solid rgba(255,255,255,0.18)",
                    background: "rgba(0,0,0,0.25)",
                    color: "white",
                    outline: "none",
                  }}
                >
                  <option value="">—</option>
                  <option value="Jr">Jr</option>
                  <option value="Sr">Sr</option>
                </select>

                <div style={{ opacity: 0.85, fontWeight: 800 }}>
                  Category (optional)
                </div>
                <input
                  value={addCategory}
                  onChange={(e) => setAddCategory(e.target.value)}
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
                  onClick={() => setShowAdd(false)}
                  style={buttonStyle({
                    bg: "rgba(0,0,0,0.25)",
                    disabled: false,
                  })}
                >
                  Cancel
                </button>
                <button
                  disabled={!canEmit || !addTeamName.trim()}
                  onClick={doAddTeam}
                  style={buttonStyle({
                    bg: "var(--cacc-gold)",
                    fg: "#111",
                    disabled: !canEmit || !addTeamName.trim(),
                  })}
                >
                  Add Team
                </button>
              </div>

              <div style={{ marginTop: 10, opacity: 0.75, fontSize: 12 }}>
                Manual adds are tagged <b>MANUAL</b>.
              </div>
            </div>
          </div>
        ) : null}

        {/* Confirm CHANGE AREA modal */}
        {showConfirmChangeArea && pendingPadId != null && pad ? (
          <div
            style={{
              position: "fixed",
              inset: 0,
              background: "rgba(0,0,0,0.60)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 16,
              zIndex: 60,
            }}
            onClick={() => {
              setShowConfirmChangeArea(false);
              setPendingPadId(null);
            }}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                width: "min(520px, 100%)",
                borderRadius: 18,
                background: "rgba(10, 14, 28, 0.98)",
                border: "1px solid rgba(255,255,255,0.16)",
                boxShadow: "0 18px 50px rgba(0,0,0,0.45)",
                padding: 16,
              }}
            >
              <div style={{ fontWeight: 1000, fontSize: 18 }}>
                Change Judging Area?
              </div>
              <div
                style={{
                  marginTop: 10,
                  opacity: 0.85,
                  fontSize: 13,
                  lineHeight: 1.35,
                }}
              >
                You are currently assigned to Pad {lockedPadId} — {areaName(pad)}.
                Changing areas may affect scoring. Continue?
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
                  onClick={() => {
                    setShowConfirmChangeArea(false);
                    setPendingPadId(null);
                  }}
                  style={buttonStyle({
                    bg: "rgba(0,0,0,0.25)",
                    disabled: false,
                  })}
                >
                  Cancel
                </button>
                <button
                  disabled={!canEmit}
                  onClick={() => {
                    if (pendingPadId == null) return;
                    const newPad = pads.find((x) => x.id === pendingPadId);
                    if (!newPad) return;
                    setLockedPadId(pendingPadId);
                    if (isMobile) setShowMobileAreaList(false);
                    try {
                      localStorage.setItem(JUDGE_PAD_STORAGE_KEY, String(pendingPadId));
                    } catch {
                      /* ignore */
                    }
                    socket?.emit?.("judge:area:set", { padId: pendingPadId });
                    setShowConfirmChangeArea(false);
                    setPendingPadId(null);
                  }}
                  style={buttonStyle({
                    bg: "var(--info)",
                    fg: "white",
                    disabled: !canEmit,
                  })}
                >
                  Confirm Change
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </main>
    </>
  );
}

export async function getServerSideProps(
  ctx: import("next").GetServerSidePropsContext,
) {
  return requireAdminRole(ctx, "judge");
}
