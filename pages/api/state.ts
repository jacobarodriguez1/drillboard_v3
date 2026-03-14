// pages/api/state.ts
import type { NextApiRequest, NextApiResponse } from "next";
import type { BoardState } from "@/lib/state";
import { createInitialState } from "@/lib/state";
import { buildStateFromRosterCsv } from "@/lib/roster";

const G = globalThis as any;

function ensureGlobals() {
  if (!G.boardState) G.boardState = null;
  if (typeof G.rosterLoaded !== "boolean") G.rosterLoaded = false;
}

function loadStateIfNeeded() {
  ensureGlobals();

  if (G.boardState) return;

  try {
    const built = buildStateFromRosterCsv();
    G.boardState = built ?? createInitialState();
    G.rosterLoaded = true;
  } catch {
    G.boardState = createInitialState();
    G.rosterLoaded = true;
  }
}

export default function handler(req: NextApiRequest, res: NextApiResponse<BoardState>) {
  loadStateIfNeeded();
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json(G.boardState as BoardState);
}


