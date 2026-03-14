// lib/roster.ts
import fs from "fs";
import path from "path";
import { parse } from "csv-parse/sync";

import type { BoardState, Pad, Team } from "./state";
import { getDataDir } from "./dataPath";

const ROSTER_FILENAME = "drillTeamsRoster_2026.csv";

/** Roster path: env ROSTER_CSV_PATH or default. Production: /data first, then /app/data (baked-in). */
export function getRosterPath(): string {
  const envPath = process.env.ROSTER_CSV_PATH?.trim();
  if (envPath) return path.isAbsolute(envPath) ? envPath : path.join(process.cwd(), envPath);

  const dataDir = getDataDir();
  const primaryPath = path.join(dataDir, ROSTER_FILENAME);
  if (fs.existsSync(primaryPath)) return primaryPath;

  // Production fallback: baked-in default at /app/data (Dockerfile COPY)
  if (process.env.NODE_ENV === "production") {
    const fallbackPath = path.join("/app", "data", ROSTER_FILENAME);
    if (fs.existsSync(fallbackPath)) return fallbackPath;
  }

  return primaryPath;
}

type RosterRow = {
  teamId?: string;
  teamCode: string;
  brigade: string;
  schoolName: string;
  division: string; // "Junior" | "Senior" | etc.
  category: string;
};

// Map roster division -> app division
function toDivision(div: string): "Jr" | "Sr" {
  return div.toLowerCase().startsWith("jun") ? "Jr" : "Sr";
}

/**
 * IMPORTANT: Pad assignment mapping (your truth table).
 * Adjust these rules to match your WARNO categories.
 */
function assignPad(row: RosterRow): number {
  const category = (row.category ?? "").trim().toLowerCase();
  const div = toDivision(row.division ?? "");

  // Platoons
  if (category === "unarmed platoon") return 1;
  if (category === "armed platoon") return 2;

  // Color Guard split by division (Jr/Sr)
  if (category === "color guard") return div === "Jr" ? 7 : 8;

  // Unarmed Squad
  if (category === "unarmed squad") return 5;

  // Armed Squad
  if (category === "armed squad") return 6;

  // Exhibition Drill (split by division)
  if (category === "exhibition drill") return div === "Jr" ? 3 : 4;

  // Fallback: if your CSV categories don’t match exactly yet,
  // put them on Pad 1 instead of throwing.
  return 1;
}

/** Build state from CSV. Returns null if file missing or unreadable. */
export function buildStateFromRosterCsv(csvPath?: string): BoardState | null {
  const filePath = csvPath ?? getRosterPath();
  if (!fs.existsSync(filePath)) return null;
  let csvText: string;
  try {
    csvText = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }

  let rows: RosterRow[];
  try {
    rows = parse(csvText, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    }) as RosterRow[];
  } catch {
    return null;
  }

  const padLabels = [
    "Unarmed Platoon (Jr/Sr)", // Pad 1
    "Armed Platoon (Jr/Sr)",   // Pad 2
    "Exhibition (Jr)",         // Pad 3
    "Exhibition (Sr)",         // Pad 4
    "Unarmed Squad (Jr/Sr)",   // Pad 5
    "Armed Squad (Jr/Sr)",     // Pad 6
    "Color Guard (Jr)",        // Pad 7
    "Color Guard (Sr)",        // Pad 8
  ];

  const now = Date.now();

  // bucket teams into pads
  const padTeams: Record<number, Team[]> = { 1: [], 2: [], 3: [], 4: [], 5: [], 6: [], 7: [], 8: [] };

  for (const r of rows) {
    const padId = assignPad(r);

    // ✅ IMPORTANT: Team has unit/category/division — NOT "school"
    const team: Team = {
      id: r.teamCode, // stable, human-readable
      name: `${r.schoolName} (${r.teamCode})`,
      unit: r.brigade,
      category: r.category,
      division: toDivision(r.division),
    };

    padTeams[padId].push(team);
  }

  // build pads with queue order = CSV order
  const pads: Pad[] = Array.from({ length: 8 }).map((_, idx) => {
    const id = idx + 1;
    const teams = padTeams[id] ?? [];

    return {
      id,
      name: `Pad ${id}`,
      label: padLabels[idx] ?? "Event",
      now: teams[0] ?? null,
      onDeck: teams[1] ?? null,
      standby: teams.slice(2),
      note: "",
      nowArrivedAt: null,
      nowArrivedTeamId: null,
      lastCompleteAt: null,
      reportByDeadlineAt: null,
      reportByTeamId: null,
      updatedAt: now,
    };
  });

  const nextPadId = (pads.length > 0 ? Math.max(...pads.map((p) => p.id)) : 0) + 1;
  return {
    pads,
    updatedAt: now,
    nextPadId,
    eventStatus: "PLANNING" as const,
    eventStartAt: null,
    eventPaused: false,
    eventPausedAt: null,
    eventPausedAccumMs: 0,
  };
}
