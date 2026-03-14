// components/PublicBoard.tsx
import { useEffect, useMemo, useRef, useState } from "react";

import type { BoardState, Pad, Team, ScheduleEvent } from "@/lib/state";
import { getCompetitionNowMs, resolveAreaLabel } from "@/lib/state";
import { getSocket } from "@/lib/socketClient";
import { fmtTime, mmssFromSeconds, formatTimerForDisplay, chipStyle } from "@/lib/ui";

/** ---------- Color tokens (operational status) ---------- */
const COLOR_ORANGE = "rgba(255,152,0,0.95)"; // AREA BREAK
const COLOR_YELLOW = "rgba(255,235,59,0.95)"; // REPORTING
const COLOR_RED = "var(--danger)"; // LATE – REPORT NOW
const COLOR_BLUE = "var(--info)"; // ON NOW
const COLOR_STANDBY = "rgba(255,255,255,0.45)"; // STANDBY dot
const COLOR_ON_DECK = "var(--cacc-gold)";
const COLOR_CATEGORY = "#A8B1C7";

/** ---------- Helpers ---------- */
/** School name only for public display (strip team ID, division, category) */
function schoolNameForDisplay(t?: Team | null): string {
  if (!t) return "—";
  const name = String(t.name ?? "").trim();
  if (!name) return "—";
  return name.replace(/\s*\([^)]*\)\s*$/, "").trim() || name;
}

/** Dynamic category label for public display: resolved from live queue, then schedule, then static label. */
function categoryForDisplay(p: Pad, scheduledSlots?: import("@/lib/state").ScheduleSlot[]): string {
  const l = resolveAreaLabel(p, scheduledSlots).trim();
  if (!l) return "";
  return l.replace(/\s*\([^)]*\)\s*$/, "").trim().toUpperCase();
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

type Banner =
  | null
  | {
      kind: "GLOBAL_BREAK_ACTIVE";
      title: string;
      rightText: string;
      sub?: string;
    }
  | {
      kind: "GLOBAL_BREAK_SCHEDULED";
      title: string;
      rightText: string;
      sub?: string;
    }
  | { kind: "GLOBAL_MSG"; title: string; rightText?: string; sub?: string }
  | { kind: "PAD_MSG"; title: string; rightText?: string; sub?: string }
  | { kind: "BREAK_ACTIVE"; title: string; rightText: string; sub?: string }
  | { kind: "ONPAD"; title: string; rightText: string; sub?: string }
  | {
      kind: "REPORT";
      title: string;
      rightText: string;
      sub?: string;
      late?: boolean;
    };

type NonNullBanner = Exclude<Banner, null>;

function statusColors(status: string) {
  switch (status) {
    case "GLOBAL BREAK":
    case "BREAK":
      return { bg: COLOR_ORANGE, fg: "#111" };
    case "REPORTING":
      return { bg: COLOR_YELLOW, fg: "#111" };
    case "LATE":
      return { bg: COLOR_RED, fg: "white" };
    case "ON PAD":
      return { bg: COLOR_BLUE, fg: "#111" };
    case "NOW":
      return { bg: "var(--cacc-gold)", fg: "#111" };
    default:
      return { bg: "rgba(255,255,255,0.12)", fg: "white" };
  }
}

function bannerStyle(b: Banner) {
  if (!b) return null;

  if (b.kind === "GLOBAL_BREAK_ACTIVE" || b.kind === "BREAK_ACTIVE") {
    return {
      border: `2px solid ${COLOR_ORANGE}`,
      background: "rgba(255,152,0,0.12)",
    };
  }
  if (b.kind === "GLOBAL_BREAK_SCHEDULED") {
    return {
      border: "2px solid rgba(255,255,255,0.22)",
      background: "rgba(255,255,255,0.08)",
    };
  }
  if (b.kind === "GLOBAL_MSG" || b.kind === "PAD_MSG") {
    return {
      border: "2px solid rgba(255,255,255,0.20)",
      background: "rgba(0,0,0,0.22)",
    };
  }
  if (b.kind === "ONPAD") {
    return {
      border: "2px solid rgba(144,202,249,0.85)",
      background: "rgba(144,202,249,0.12)",
    };
  }
  if (b.kind === "REPORT") {
    if (b.late)
      return {
        border: `2px solid ${COLOR_RED}`,
        background: "rgba(198,40,40,0.16)",
      };
    return {
      border: `2px solid ${COLOR_YELLOW}`,
      background: "rgba(255,235,59,0.14)",
    };
  }
  return null;
}

/** ---------- schedule helpers ---------- */
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
function nextRelevantEventForPad(
  schedule: ScheduleEvent[],
  padId: number,
  nowMs: number,
) {
  const relevant = schedule.filter((e) => {
    if (e.startAt <= nowMs) return false;
    if (e.scope === "GLOBAL") return true;
    if (e.scope === "PAD" && e.padIds?.includes(padId)) return true;
    return false;
  });
  return relevant.sort((a, b) => a.startAt - b.startAt)[0] ?? null;
}
function nextBreakLike(schedule: ScheduleEvent[], nowMs: number) {
  const breakLike = schedule.filter(
    (e) => e.startAt > nowMs && (e.type === "BREAK" || e.type === "LUNCH"),
  );
  return breakLike.sort((a, b) => a.startAt - b.startAt)[0] ?? null;
}

/** ---------- per-pad banners ---------- */
function getPadBanner(
  p: Pad,
  nowMs: number,
  globalBreakActive: boolean,
  isLive = true,
): Banner {
  if (globalBreakActive) return null;

  if (p.message && (!p.messageUntilAt || nowMs < p.messageUntilAt)) {
    return {
      kind: "PAD_MSG",
      title: p.message,
      rightText: p.messageUntilAt
        ? mmssFromSeconds((p.messageUntilAt - nowMs) / 1000)
        : undefined,
      sub: p.messageUntilAt
        ? `Ends at ${fmtTime(p.messageUntilAt)}`
        : undefined,
    };
  }

  if (isLive && p.breakUntilAt && p.breakUntilAt > nowMs) {
    return {
      kind: "BREAK_ACTIVE",
      title: `BREAK: ${(p.breakReason ?? "Break").trim()}`,
      rightText: mmssFromSeconds((p.breakUntilAt - nowMs) / 1000),
      sub: `Resumes at ${fmtTime(p.breakUntilAt)}`,
    };
  }

  if (isLive && isArrivedForNow(p) && p.nowArrivedAt) {
    return {
      kind: "ONPAD",
      title: `ON PAD: ${p.now?.name ?? "—"}`,
      rightText: mmssFromSeconds((nowMs - p.nowArrivedAt) / 1000),
      sub: `Arrived at ${fmtTime(p.nowArrivedAt)}`,
    };
  }

  const validReport =
    isLive &&
    !!p.reportByDeadlineAt &&
    !!p.reportByTeamId &&
    !!p.now?.id &&
    p.now.id === p.reportByTeamId &&
    !(p.breakUntilAt && p.breakUntilAt > nowMs);

  if (validReport && p.reportByDeadlineAt) {
    const diffSec = (p.reportByDeadlineAt - nowMs) / 1000;
    if (diffSec >= 0) {
      return {
        kind: "REPORT",
        title: `REPORT NOW: ${p.now?.name ?? "—"}`,
        rightText: mmssFromSeconds(diffSec),
        sub: p.lastCompleteAt
          ? `Started at ${fmtTime(p.lastCompleteAt)}`
          : undefined,
      };
    }
    return {
      kind: "REPORT",
      title: `LATE — REPORT NOW: ${p.now?.name ?? "—"}`,
      rightText: mmssFromSeconds(-diffSec),
      sub: p.lastCompleteAt
        ? `Started at ${fmtTime(p.lastCompleteAt)}`
        : undefined,
      late: true,
    };
  }

  return null;
}

function deriveStatus(
  p: Pad,
  banner: Banner | null,
  nowMs: number,
  globalBreakActive: boolean,
) {
  if (globalBreakActive) return "GLOBAL BREAK";
  if (p.breakUntilAt && p.breakUntilAt > nowMs) return "BREAK";
  if (banner?.kind === "REPORT") return banner.late ? "LATE" : "REPORTING";
  if (banner?.kind === "ONPAD") return "ON PAD";
  if (p.now) return "NOW";
  return "IDLE";
}

/** beep on late in kiosk mode */
function beep() {
  try {
    const Ctx =
      (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "sine";
    o.frequency.value = 880;
    g.gain.value = 0.05;
    o.connect(g);
    g.connect(ctx.destination);
    o.start();
    setTimeout(() => {
      o.stop();
      ctx.close?.();
    }, 120);
  } catch {}
}

function nowAccentForStatus(status: string) {
  switch (status) {
    case "BREAK":
    case "GLOBAL BREAK":
      return COLOR_ORANGE;
    case "REPORTING":
      return COLOR_YELLOW;
    case "LATE":
      return COLOR_RED;
    case "ON PAD":
      return COLOR_BLUE;
    default:
      return "var(--cacc-gold)";
  }
}

/** Operational display state for pad card */
type OpStatus = "REPORTING" | "ON_NOW" | "LATE" | "AREA_BREAK" | "IDLE";

function getOpStatus(
  p: Pad,
  banner: Banner | null,
  nowMs: number,
  globalBreakActive: boolean,
): OpStatus {
  if (globalBreakActive) return "IDLE";
  if (p.breakUntilAt && p.breakUntilAt > nowMs) return "AREA_BREAK";
  if (banner?.kind === "REPORT") return banner.late ? "LATE" : "REPORTING";
  if (banner?.kind === "ONPAD" || p.now) return "ON_NOW";
  return "IDLE";
}

/** Timer seconds and label for display */
function getTimerInfo(
  p: Pad,
  banner: Banner | null,
  nowMs: number,
  opStatus: OpStatus,
): { seconds: number; label: string } | null {
  if (opStatus === "AREA_BREAK" && p.breakUntilAt) {
    return {
      seconds: Math.max(0, (p.breakUntilAt - nowMs) / 1000),
      label: "Next round begins in",
    };
  }
  if (opStatus === "REPORTING" && p.reportByDeadlineAt) {
    const sec = Math.max(0, (p.reportByDeadlineAt - nowMs) / 1000);
    return { seconds: sec, label: "REPORT IN" };
  }
  if (opStatus === "ON_NOW" && p.nowArrivedAt) {
    return {
      seconds: (nowMs - p.nowArrivedAt) / 1000,
      label: "TIME ON PAD",
    };
  }
  if (opStatus === "LATE" && p.reportByDeadlineAt) {
    return {
      seconds: (nowMs - p.reportByDeadlineAt) / 1000,
      label: "LATE BY",
    };
  }
  return null;
}

export default function PublicBoard({ kiosk = false }: { kiosk?: boolean }) {
  const [state, setState] = useState<BoardState | null>(null);
  const [, tick] = useState(0);
  const [nowCompetingPads, setNowCompetingPads] = useState<Set<number>>(new Set());

  const lastBeepByPad = useRef<Record<number, number>>({});
  const prevLateByPad = useRef<Record<number, boolean>>({});
  const prevNowTeamByPad = useRef<Record<number, string | null>>({});

  useEffect(() => {
    fetch("/api/socket");

    const socket = getSocket();
    if (socket) socket.on("state", (s: BoardState) => setState(s));

    const interval = setInterval(() => tick((t) => t + 1), 1000);

    const resync = setInterval(async () => {
      try {
        const r = await fetch("/api/state");
        if (r.ok) setState(await r.json());
      } catch {}
    }, 60000);

    return () => {
      if (socket) socket.off("state");
      clearInterval(interval);
      clearInterval(resync);
    };
  }, []);

  const pads = useMemo(() => state?.pads ?? [], [state]);
  const nowMs = Date.now();
  const compNowMs = getCompetitionNowMs(state ?? null, nowMs);
  const effectiveNow = compNowMs ?? nowMs;
  const isLive = (state as any)?.eventStatus === "LIVE";

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

  const nextBreakLunch = useMemo(
    () => nextBreakLike(globalSchedule, nowMs),
    [globalSchedule, nowMs],
  );

  const gbStart = state?.globalBreakStartAt ?? null;
  const gbUntil = state?.globalBreakUntilAt ?? null;
  const gbReason = (state?.globalBreakReason ?? "Break").trim();

  const globalBreakActive =
    (!gbStart || nowMs >= gbStart) && !!gbUntil && nowMs < gbUntil;
  const globalBreakScheduled = !!gbStart && gbStart > nowMs;

  const globalMessageActive =
    !!state?.globalMessage &&
    (!state?.globalMessageUntilAt || state.globalMessageUntilAt > nowMs);

  const globalBanners: NonNullBanner[] = useMemo(() => {
    const banners: NonNullBanner[] = [];

    if (globalBreakScheduled && gbStart) {
      banners.push({
        kind: "GLOBAL_BREAK_SCHEDULED",
        title: `GLOBAL BREAK SCHEDULED: ${gbReason}`,
        rightText: mmssFromSeconds((gbStart - nowMs) / 1000),
        sub: `Starts at ${fmtTime(gbStart)} • Ends at ${gbUntil ? fmtTime(gbUntil) : "—"}`,
      });
    } else if (globalBreakActive && gbUntil) {
      banners.push({
        kind: "GLOBAL_BREAK_ACTIVE",
        title: `GLOBAL BREAK: ${gbReason}`,
        rightText: mmssFromSeconds((gbUntil - effectiveNow) / 1000),
        sub: `Resumes at ${fmtTime(gbUntil)}`,
      });
    }

    if (globalMessageActive && state?.globalMessage) {
      banners.push({
        kind: "GLOBAL_MSG",
        title: state.globalMessage,
        rightText: state.globalMessageUntilAt
          ? mmssFromSeconds((state.globalMessageUntilAt - nowMs) / 1000)
          : undefined,
        sub: state.globalMessageUntilAt
          ? `Ends at ${fmtTime(state.globalMessageUntilAt)}`
          : undefined,
      });
    }

    return banners;
  }, [
    globalBreakScheduled,
    globalBreakActive,
    globalMessageActive,
    gbStart,
    gbUntil,
    gbReason,
    effectiveNow,
    nowMs,
    state?.globalMessage,
    state?.globalMessageUntilAt,
  ]);

  useEffect(() => {
    if (!kiosk) return;
    if (globalBreakActive) return;

    for (const p of pads) {
      const b = getPadBanner(p, effectiveNow, globalBreakActive, isLive);
      const isLate = b?.kind === "REPORT" && !!b.late;
      const wasLate = !!prevLateByPad.current[p.id];

      if (!wasLate && isLate) {
        const last = lastBeepByPad.current[p.id] ?? 0;
        if (nowMs - last > 30_000) {
          lastBeepByPad.current[p.id] = nowMs;
          beep();
        }
      }
      prevLateByPad.current[p.id] = isLate;
    }
  }, [pads, effectiveNow, kiosk, globalBreakActive, isLive]);

  const initialPadSync = useRef(false);
  useEffect(() => {
    for (const p of pads) {
      const nowId = p.now?.id ?? null;
      const prevId = prevNowTeamByPad.current[p.id];
      if (!initialPadSync.current) {
        prevNowTeamByPad.current[p.id] = nowId ?? null;
      } else if (nowId && nowId !== prevId) {
        prevNowTeamByPad.current[p.id] = nowId;
        setNowCompetingPads((s) => new Set(s).add(p.id));
        setTimeout(() => {
          setNowCompetingPads((s) => {
            const next = new Set(s);
            next.delete(p.id);
            return next;
          });
        }, 2000);
      } else {
        prevNowTeamByPad.current[p.id] = nowId ?? null;
      }
    }
    if (pads.length > 0) initialPadSync.current = true;
  }, [pads]);

  return (
    <div
      className="responsive-page"
      style={{
        minHeight: "100vh",
        background: "var(--page-bg)",
        color: "var(--text-primary)",
        padding: 18,
        fontFamily: "system-ui",
      }}
    >
      <style>{`
        @keyframes lateFlash { 0%{opacity:1} 50%{opacity:.55} 100%{opacity:1} }
      `}</style>

      {/* Event banner header — centered title block */}
      <div
        className="public-header"
        style={{
          position: "relative",
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          padding: "22px 24px",
          borderRadius: 12,
          background: "rgba(255,255,255,0.06)",
          border: "1px solid rgba(255,255,255,0.12)",
          boxShadow: "0 10px 30px rgba(0,0,0,0.25)",
        }}
      >
        {/* Centered logo + title block */}
        <div
          className="public-header-main"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 20,
          }}
        >
          <img
            src="/cacc-shield.png"
            alt="California Cadet Corps"
            className="public-header-logo"
            style={{
              width: 96,
              height: 96,
              objectFit: "contain",
              borderRadius: 12,
              background: "rgba(0,0,0,0.25)",
              border: "1px solid rgba(255,255,255,0.14)",
              padding: 8,
              flexShrink: 0,
            }}
          />

          <div
            className="public-header-text"
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-start",
              gap: 4,
            }}
          >
            <div
              className="public-header-org"
              style={{
                fontSize: 20,
                fontWeight: 900,
                letterSpacing: 1.6,
                color: "rgba(255,255,255,0.80)",
                lineHeight: 1.1,
              }}
            >
              CALIFORNIA CADET CORPS
            </div>
            <div
              className="public-header-title"
              style={{
                fontWeight: 800,
                fontSize: 38,
                letterSpacing: -0.2,
                lineHeight: 1.0,
                color: "var(--text-primary, white)",
              }}
            >
              {(state as any)?.eventHeaderLabel?.trim() || "DRILL COMPETITION BOARD"}
            </div>
          </div>
        </div>

        {/* Last Update — de-emphasized, bottom-right */}
        <div
          className="public-header-updated"
          style={{
            position: "absolute",
            bottom: 10,
            right: 18,
            fontSize: 11,
            color: "rgba(255,255,255,0.35)",
            whiteSpace: "nowrap",
          }}
        >
          {state?.updatedAt
            ? `Updated ${fmtTime(state.updatedAt)}`
            : "Connecting…"}
        </div>
      </div>

      {/* Schedule NOW/NEXT */}
      <div
        style={{
          marginTop: 12,
          borderRadius: 10,
          padding: "8px 12px",
          background: "var(--surface-1)",
          border: "1px solid var(--border-crisp)",
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

          <div style={{ fontWeight: 800 }}>
            NOW:{" "}
            {nowSched
              ? `${nowSched.title} (${fmtTime(nowSched.startAt)}–${fmtTime(nowSched.endAt)})`
              : "—"}
          </div>

          <div style={{ color: "var(--text-secondary)" }}>
            NEXT:{" "}
            {nextSched
              ? `${nextSched.title} (${fmtTime(nextSched.startAt)}–${fmtTime(nextSched.endAt)})`
              : "—"}
          </div>
        </div>
      </div>

      {/* Global banners (stacked) — Global Break dominant, GLOBAL_MSG contextual */}
      {globalBanners.length > 0 ? (
        <div
          style={{
            marginTop: 12,
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          {globalBanners.map((b, idx) => {
            const isBreakActive = b.kind === "GLOBAL_BREAK_ACTIVE";
            const isBreakScheduled = b.kind === "GLOBAL_BREAK_SCHEDULED";
            const isMsg = b.kind === "GLOBAL_MSG";
            const baseStyle = bannerStyle(b) ?? {};
            const breakActiveOverrides = isBreakActive
              ? {
                  padding: "14px 18px" as const,
                  background: "rgba(255,152,0,0.18)" as const,
                  border: `2px solid ${COLOR_ORANGE}` as const,
                }
              : {};
            const breakScheduledOverrides = isBreakScheduled
              ? { padding: "12px 16px" as const }
              : {};
            const msgOverrides = isMsg
              ? {
                  padding: "10px 14px" as const,
                  background: "rgba(0,0,0,0.18)" as const,
                  border: "1px solid rgba(255,255,255,0.12)" as const,
                }
              : {};
            const style = isBreakActive
              ? { ...baseStyle, ...breakActiveOverrides }
              : isBreakScheduled
                ? { ...baseStyle, ...breakScheduledOverrides }
                : isMsg
                  ? { ...baseStyle, ...msgOverrides }
                  : baseStyle;
            return (
              <div
                key={`${b.kind}-${idx}`}
                style={{ borderRadius: 12, ...style }}
              >
                <div
                  className="public-pad-header-band"
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 10,
                    flexWrap: "wrap",
                  }}
                >
                  <div style={{ fontWeight: 800, fontSize: 16 }}>
                    {b.kind.includes("BREAK") ? "🟠 " : "📢 "}
                    {b.title}
                  </div>

                  {b.rightText ? (
                    <div
                      style={{
                        fontFamily:
                          "ui-monospace, SFMono-Regular, Menlo, monospace",
                        fontWeight: 900,
                      }}
                    >
                      {b.rightText}
                    </div>
                  ) : null}
                </div>

                {b.sub ? (
                  <div
                    style={{
                      marginTop: 6,
                      fontSize: 12,
                      color: isMsg
                        ? "var(--text-tertiary)"
                        : "var(--text-secondary)",
                    }}
                  >
                    {b.sub}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}

      {/* Grid */}
      <div
        className="public-board-grid"
        style={{
          marginTop: 14,
          gap: 14,
        }}
      >
        {pads.length === 0 ? (
          <div
            style={{
              gridColumn: "1 / -1",
              padding: 24,
              textAlign: "center",
              opacity: 0.75,
              fontSize: 15,
            }}
          >
            No areas yet.
          </div>
        ) : (
          pads.map((p, padIdx) => {
            const banner = getPadBanner(p, effectiveNow, globalBreakActive, isLive);
            const opStatus = getOpStatus(p, banner, effectiveNow, globalBreakActive);
            const timerInfo = getTimerInfo(p, banner, effectiveNow, opStatus);
            const category = categoryForDisplay(p, state?.scheduledSlots);
            const showNowCompeting = nowCompetingPads.has(p.id);
            const standbyCount = p.standby?.length ?? 0;
            const reportTargetDuringBreak =
              opStatus === "AREA_BREAK" &&
              p.reportByTeamId &&
              p.now &&
              p.reportByTeamId === p.now.id
                ? p.now
                : null;

            const borderColor =
              opStatus === "REPORTING"
                ? COLOR_YELLOW
                : opStatus === "ON_NOW"
                  ? COLOR_BLUE
                  : opStatus === "LATE"
                    ? COLOR_RED
                    : opStatus === "AREA_BREAK"
                      ? COLOR_ORANGE
                      : "var(--border-crisp)";

            const statusConfig =
              opStatus === "REPORTING"
                ? { label: "REPORTING", color: COLOR_YELLOW }
                : opStatus === "ON_NOW"
                  ? { label: "ON NOW", color: COLOR_BLUE }
                  : opStatus === "LATE"
                    ? { label: "LATE – REPORT NOW", color: COLOR_RED }
                    : opStatus === "AREA_BREAK"
                      ? { label: "AREA BREAK", color: COLOR_ORANGE }
                      : null;

            const isLate = opStatus === "LATE";
            const timerStr =
              timerInfo != null
                ? formatTimerForDisplay(Math.abs(timerInfo.seconds))
                : null;

            return (
              <div
                key={p.id}
                className={`public-scoreboard-card ${isLate ? "public-scoreboard-late-flash" : ""}`}
                style={{
                  borderRadius: 12,
                  overflow: "hidden",
                  background: "var(--surface-1)",
                  border: `2px solid ${borderColor}`,
                  boxShadow: "0 4px 16px rgba(0,0,0,0.35)",
                  minHeight: 360,
                }}
              >
                <div style={{ height: 4, background: borderColor }} />
                {/* Header band — category/division dominant, pad number secondary */}
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                    padding: "8px 20px",
                    minHeight: 60,
                    background: "rgba(0,0,0,0.35)",
                    borderBottom: "1px solid var(--divider)",
                    textAlign: "center",
                    gap: 3,
                  }}
                >
                  {category ? (
                    <span
                      style={{
                        fontSize: 17,
                        fontWeight: 900,
                        letterSpacing: "0.10em",
                        color: "var(--text-primary)",
                        textTransform: "uppercase",
                        lineHeight: 1.15,
                      }}
                    >
                      {category}
                    </span>
                  ) : null}
                  <span
                    style={{
                      fontSize: category ? 11 : 20,
                      fontWeight: category ? 500 : 800,
                      letterSpacing: category ? 1.8 : 1.2,
                      color: category ? "var(--text-tertiary)" : "var(--text-primary)",
                      textTransform: "uppercase",
                      lineHeight: 1,
                    }}
                  >
                    PAD {padIdx + 1}
                  </span>
                </div>

                <div className="public-pad-body" style={{ padding: 24 }}>
                  {opStatus === "AREA_BREAK" ? (
                    /* AREA BREAK layout */
                    <>
                      <div
                        className="public-pad-section public-pad-section-primary"
                        style={{
                          marginBottom: 16,
                          borderBottom: "1px solid var(--divider)",
                          paddingBottom: 16,
                        }}
                      >
                        <div
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 8,
                            marginBottom: 12,
                          }}
                        >
                          <span
                            style={{
                              width: 10,
                              height: 10,
                              borderRadius: "50%",
                              background: COLOR_ORANGE,
                              flexShrink: 0,
                            }}
                          />
                          <span
                            style={{
                              fontSize: 14,
                              fontWeight: 900,
                              letterSpacing: 1,
                              color: COLOR_ORANGE,
                            }}
                          >
                            AREA BREAK
                          </span>
                        </div>
                        {timerStr && timerInfo ? (
                          <>
                            <div
                              style={{
                                fontSize: 12,
                                fontWeight: 700,
                                letterSpacing: 1,
                                color: "var(--text-secondary)",
                                marginBottom: 6,
                              }}
                            >
                              {timerInfo.label}
                            </div>
                            <div
                              style={{
                                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                                fontSize: 36,
                                fontWeight: 900,
                                color: "var(--text-primary)",
                                fontVariantNumeric: "tabular-nums",
                              }}
                            >
                              {timerStr}
                            </div>
                          </>
                        ) : null}
                        {reportTargetDuringBreak && timerStr ? (
                          <div
                            style={{
                              marginTop: 16,
                              paddingTop: 16,
                              borderTop: "1px solid var(--divider)",
                            }}
                          >
                            <div
                              style={{
                                fontSize: 18,
                                fontWeight: 600,
                                color: "var(--text-primary)",
                                marginBottom: 6,
                              }}
                            >
                              {schoolNameForDisplay(reportTargetDuringBreak)}
                            </div>
                            <div
                              style={{
                                fontSize: 13,
                                fontWeight: 700,
                                letterSpacing: 1,
                                color: "var(--text-secondary)",
                              }}
                            >
                              REPORT IN {timerStr}
                            </div>
                          </div>
                        ) : null}
                      </div>
                      {/* On deck - always shown, no REPORT IN for on deck during break */}
                      <div
                        className="public-pad-section public-pad-section-ondeck"
                        style={{
                          marginBottom: 16,
                          borderBottom: "1px solid var(--divider)",
                          paddingBottom: 16,
                        }}
                      >
                        <div
                          style={{
                            fontSize: 12,
                            fontWeight: 900,
                            letterSpacing: 1,
                            color: COLOR_ON_DECK,
                            marginBottom: 8,
                          }}
                        >
                          ON DECK
                        </div>
                        <div
                          style={{
                            fontSize: 20,
                            fontWeight: 600,
                            color: "var(--text-primary)",
                          }}
                        >
                          {schoolNameForDisplay(p.onDeck)}
                        </div>
                      </div>
                      {/* Standby */}
                      <div className="public-pad-section public-pad-section-standby">
                        <div
                          style={{
                            fontSize: 12,
                            fontWeight: 900,
                            letterSpacing: 1,
                            color: "var(--text-tertiary)",
                            marginBottom: 8,
                          }}
                        >
                          STANDBY
                        </div>
                        <div
                          style={{
                            fontSize: 18,
                            fontWeight: 600,
                            color: "var(--text-primary)",
                            opacity: 0.85,
                          }}
                        >
                          {standbyCount > 0
                            ? schoolNameForDisplay(p.standby![0])
                            : "—"}
                        </div>
                        {standbyCount > 1 ? (
                          <div
                            style={{
                              marginTop: 6,
                              fontSize: 13,
                              color: "var(--text-tertiary)",
                            }}
                          >
                            {standbyCount - 1} teams waiting
                          </div>
                        ) : null}
                      </div>
                    </>
                  ) : (
                    /* Normal operation: REPORTING, ON_NOW, LATE, IDLE */
                    <>
                      <div
                        className="public-pad-section public-pad-section-primary"
                        style={{
                          marginBottom: 16,
                          borderBottom: "1px solid var(--divider)",
                          paddingBottom: 16,
                        }}
                      >
                        {showNowCompeting && opStatus === "ON_NOW" ? (
                          <div
                            className="public-scoreboard-now-competing"
                            style={{
                              marginBottom: 12,
                              padding: "8px 12px",
                              background: "rgba(21,101,192,0.25)",
                              borderRadius: 8,
                              border: "1px solid rgba(21,101,192,0.5)",
                              textAlign: "center",
                              fontSize: 14,
                              fontWeight: 900,
                              letterSpacing: 1,
                              color: COLOR_BLUE,
                            }}
                          >
                            NOW COMPETING
                          </div>
                        ) : null}
                        {statusConfig ? (
                          <div
                            className={
                              isLate ? "public-scoreboard-late-status" : ""
                            }
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              gap: 8,
                              marginBottom: 10,
                            }}
                          >
                            <span
                              style={{
                                width: 10,
                                height: 10,
                                borderRadius: "50%",
                                background: statusConfig.color,
                                flexShrink: 0,
                              }}
                            />
                            <span
                              style={{
                                fontSize: 12,
                                fontWeight: 900,
                                letterSpacing: 1,
                                color: statusConfig.color,
                              }}
                            >
                              {statusConfig.label}
                            </span>
                          </div>
                        ) : null}
                        <div
                          key={p.now?.id ?? "empty"}
                          className="public-scoreboard-team-in"
                          style={{
                            fontSize: 30,
                            fontWeight: 800,
                            letterSpacing: 0.5,
                            color: "var(--text-primary)",
                            lineHeight: 1.2,
                            marginBottom: 8,
                          }}
                        >
                          {schoolNameForDisplay(p.now).toUpperCase()}
                        </div>
                        {timerStr && timerInfo ? (
                          <>
                            <div
                              style={{
                                fontSize: 11,
                                fontWeight: 700,
                                letterSpacing: 1,
                                color: "var(--text-tertiary)",
                                marginBottom: 4,
                              }}
                            >
                              {timerInfo.label}
                            </div>
                            <div
                              style={{
                                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                                fontSize: 36,
                                fontWeight: 900,
                                color: "var(--text-primary)",
                                fontVariantNumeric: "tabular-nums",
                              }}
                            >
                              {timerStr}
                            </div>
                          </>
                        ) : null}
                      </div>

                      {/* On deck */}
                      <div
                        className="public-pad-section public-pad-section-ondeck"
                        style={{
                          marginBottom: 16,
                          borderBottom: "1px solid var(--divider)",
                          paddingBottom: 16,
                        }}
                      >
                        <div
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 8,
                            marginBottom: 8,
                          }}
                        >
                          <span
                            style={{
                              width: 8,
                              height: 8,
                              borderRadius: "50%",
                              background: COLOR_ON_DECK,
                              flexShrink: 0,
                            }}
                          />
                          <span
                            style={{
                              fontSize: 12,
                              fontWeight: 900,
                              letterSpacing: 1,
                              color: COLOR_ON_DECK,
                            }}
                          >
                            ON DECK
                          </span>
                        </div>
                        <div
                          style={{
                            fontSize: 20,
                            fontWeight: 600,
                            color: "var(--text-primary)",
                          }}
                        >
                          {schoolNameForDisplay(p.onDeck)}
                        </div>
                      </div>

                      {/* Standby */}
                      <div className="public-pad-section public-pad-section-standby">
                        <div
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 8,
                            marginBottom: 8,
                          }}
                        >
                          <span
                            style={{
                              width: 8,
                              height: 8,
                              borderRadius: "50%",
                              background: COLOR_STANDBY,
                              flexShrink: 0,
                            }}
                          />
                          <span
                            style={{
                              fontSize: 12,
                              fontWeight: 900,
                              letterSpacing: 1,
                              color: "var(--text-tertiary)",
                            }}
                          >
                            STANDBY
                          </span>
                        </div>
                        <div
                          style={{
                            fontSize: 18,
                            fontWeight: 600,
                            color: "var(--text-primary)",
                            opacity: 0.85,
                          }}
                        >
                          {standbyCount > 0
                            ? schoolNameForDisplay(p.standby![0])
                            : "—"}
                        </div>
                        {standbyCount > 1 ? (
                          <div
                            style={{
                              marginTop: 6,
                              fontSize: 13,
                              color: "var(--text-tertiary)",
                            }}
                          >
                            {standbyCount - 1} teams waiting
                          </div>
                        ) : null}
                      </div>
                    </>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
