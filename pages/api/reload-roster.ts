// pages/api/reload-roster.ts
import type { NextApiRequest, NextApiResponse } from "next";
import { createInitialState } from "@/lib/state";
import { buildStateFromRosterCsv, getRosterPath } from "@/lib/roster";
import { getAuthCookie } from "@/lib/ui";
import { ensureGlobals, sanitizeStateAfterAnyLoad, pushAudit } from "@/pages/api/socket";

const G = globalThis as any;

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!getAuthCookie(req)) return res.status(401).json({ error: "Unauthorized" });

  try {
    ensureGlobals();
    const prev = G.boardState;
    const rosterPath = getRosterPath();
    const built = buildStateFromRosterCsv(rosterPath);

    let nextState = built ?? createInitialState();
    if (prev) {
      nextState.globalBreakStartAt = prev.globalBreakStartAt ?? null;
      nextState.globalBreakUntilAt = prev.globalBreakUntilAt ?? null;
      nextState.globalBreakReason = prev.globalBreakReason ?? null;
      nextState.globalMessage = prev.globalMessage ?? null;
      nextState.globalMessageUntilAt = prev.globalMessageUntilAt ?? null;
      nextState.schedule = prev.schedule ?? [];
      nextState.scheduleUpdatedAt = prev.scheduleUpdatedAt ?? Date.now();
      (nextState as any).eventHeaderLabel = (prev as any).eventHeaderLabel ?? "COMPETITION MATRIX";
      const wasLive = (prev as any)?.eventStatus === "LIVE";
      (nextState as any).eventStatus = wasLive ? "LIVE" : "PLANNING";
      (nextState as any).eventStartAt = (prev as any)?.eventStartAt ?? null;
      (nextState as any).eventPaused = (prev as any)?.eventPaused ?? false;
      (nextState as any).eventPausedAt = (prev as any)?.eventPausedAt ?? null;
      (nextState as any).eventPausedAccumMs = (prev as any)?.eventPausedAccumMs ?? 0;
    } else {
      (nextState as any).eventStatus = "PLANNING";
      (nextState as any).eventStartAt = null;
      (nextState as any).eventPaused = false;
      (nextState as any).eventPausedAt = null;
      (nextState as any).eventPausedAccumMs = 0;
    }

    G.boardState = nextState;
    G.padHistory = {};
    G.rosterLoaded = !!built;

    const nowMs = Date.now();
    pushAudit({
      ts: nowMs,
      padId: null,
      action: built ? "ROSTER_LOAD" : "ROSTER_LOAD_FAIL",
      detail: built ? "Roster loaded from CSV." : `No roster at ${rosterPath}; using empty state.`,
    });

    sanitizeStateAfterAnyLoad(G.boardState);

    if (G.io) {
      G.io.emit("state", G.boardState);
      G.io.emit("audit", G.audit);
    }

    res.status(200).json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message ?? "Unknown error" });
  }
}
