/**
 * Persist pad chat channels/messages to data/comm_state.json.
 * Load on server start. Throttled/coalesced writes (max once per second).
 * Does NOT persist online/offline presence.
 */

import fs from "fs";
import path from "path";
import { getDataDir } from "./dataPath";

export type PersistedChatMessage = {
  id: string;
  ts: number;
  from: "ADMIN" | "JUDGE";
  text: string;
  urgent?: boolean;
  ackedAt?: number;
};

export type PersistedCommState = {
  channels: Record<string, PersistedChatMessage[]>;
};

const COMM_STATE_FILENAME = "comm_state.json";
const DEBOUNCE_MS = 1000;

function getCommStatePath(): string {
  const envPath = process.env.COMM_STATE_PATH?.trim();
  if (envPath) return path.isAbsolute(envPath) ? envPath : path.join(process.cwd(), envPath);
  return path.join(getDataDir(), COMM_STATE_FILENAME);
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let saveScheduled = false;

/** Strict: urgent is true only if m.urgent === true or m.urgent === "true" (legacy). */
function parseUrgent(m: { urgent?: unknown }): boolean {
  const v = m.urgent;
  if (v === true) return true;
  if (v === "true") return true; // legacy
  return false;
}

/** Parse pad key: only accept positive integers. Reject "1.9", "x", etc. */
function parsePadKey(k: string): number | null {
  const n = Number(k);
  if (!Number.isInteger(n) || n < 1) return null;
  return n;
}

/**
 * Load persisted comm state. Returns Record<padId, messages>.
 * Sanitizes: filters invalid ts (NaN/Infinity), invalid ackedAt → undefined, strict urgent.
 * Pad keys must be positive integers (e.g. "1.9" rejected).
 */
export function loadCommState(): Record<number, PersistedChatMessage[]> {
  const filePath = getCommStatePath();
  if (!fs.existsSync(filePath)) return {};

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }

  if (!parsed || typeof parsed !== "object") return {};
  const obj = parsed as Record<string, unknown>;
  const channels = obj.channels;
  if (!channels || typeof channels !== "object") return {};

  const result: Record<number, PersistedChatMessage[]> = {};
  for (const [k, v] of Object.entries(channels)) {
    const padId = parsePadKey(k);
    if (padId == null) continue;
    if (!Array.isArray(v)) continue;
    const msgs = v
      .filter(
        (m): m is Record<string, unknown> =>
          m != null &&
          typeof m === "object" &&
          typeof (m as any).id === "string" &&
          typeof (m as any).text === "string"
      )
      .map((m) => {
        const ts = Number((m as any).ts);
        const ackedNum = (m as any).ackedAt;
        const ackedAt = ackedNum != null ? Number(ackedNum) : undefined;
        return {
          id: String((m as any).id),
          ts,
          from: ((m as any).from === "JUDGE" ? "JUDGE" : "ADMIN") as "ADMIN" | "JUDGE",
          text: String((m as any).text ?? ""),
          urgent: parseUrgent(m as { urgent?: unknown }),
          ackedAt: ackedAt != null && Number.isFinite(ackedAt) ? ackedAt : undefined,
        };
      })
      .filter(
        (m) => Number.isFinite(m.ts) && !Number.isNaN(m.ts) && m.ts !== Infinity && m.ts !== -Infinity
      ) as PersistedChatMessage[];
    result[padId] = msgs;
  }
  return result;
}

/**
 * Schedule a throttled/coalesced save. Writes at most once per DEBOUNCE_MS.
 * Uses atomic write: write to .tmp then rename to final path.
 */
export function scheduleCommSave(getChannels: () => Record<number, PersistedChatMessage[]>) {
  if (saveScheduled) return;
  saveScheduled = true;

  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveScheduled = false;
    saveTimer = null;
    try {
      const channels = getChannels();
      const filePath = getCommStatePath();
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      const toWrite: PersistedCommState = {
        channels: Object.fromEntries(Object.entries(channels).map(([k, v]) => [String(k), v])),
      };
      const tmpPath = filePath + ".tmp";
      fs.writeFileSync(tmpPath, JSON.stringify(toWrite, null, 2), "utf8");
      fs.renameSync(tmpPath, filePath);
    } catch (e) {
      console.error("[comm] Persist error:", e);
    }
  }, DEBOUNCE_MS);
}