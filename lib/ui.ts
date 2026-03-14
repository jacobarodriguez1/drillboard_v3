// lib/ui.ts
import type { NextApiRequest, NextApiResponse } from "next";

export function fmtTime(ms: number) {
  return new Date(ms).toLocaleTimeString();
}

export function mmssFromSeconds(totalSeconds: number) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

/** Timer for public display: MM:SS or HH:MM:SS if >= 1 hour */
export function formatTimerForDisplay(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  if (h >= 1) {
    return `${h}:${String(mm).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
  }
  return `${mm}:${String(r).padStart(2, "0")}`;
}

export function safeEmit(socket: any, event: string, payload?: any) {
  try {
    socket?.emit?.(event, payload);
  } catch {}
}

/**
 * Emit multiple event names for compatibility.
 * Server ignores unknown events.
 */
export function emitAny(socket: any, events: string[], payload?: any) {
  for (const e of events) safeEmit(socket, e, payload);
}

export function chipStyle(bg: string, fg: string = "white") {
  return {
    padding: "6px 10px",
    borderRadius: 999,
    background: bg,
    color: fg,
    fontSize: 11,
    fontWeight: 1000 as const,
    letterSpacing: 1.2,
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
  };
}

export function buttonStyle(opts: { bg: string; fg?: string; disabled?: boolean }) {
  return {
    width: "100%",
    padding: "14px 14px",
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,0.14)",
    background: opts.bg,
    color: opts.fg ?? "white",
    fontWeight: 1000 as const,
    cursor: opts.disabled ? "not-allowed" : "pointer",
    opacity: opts.disabled ? 0.55 : 1,
    letterSpacing: 0.3,
  };
}

/**
 * Compact secondary action button — does NOT set width:100%.
 * Use for inline actions like Inspect that should not stretch to fill a row.
 */
export function compactBtnStyle(opts: { bg?: string; fg?: string; disabled?: boolean } = {}) {
  return {
    padding: "5px 11px",
    borderRadius: 8,
    border: "1px solid rgba(255,255,255,0.13)",
    background: opts.bg ?? "rgba(255,255,255,0.08)",
    color: opts.fg ?? "rgba(255,255,255,0.82)",
    fontWeight: 700 as const,
    fontSize: 12,
    cursor: opts.disabled ? "not-allowed" : "pointer",
    opacity: opts.disabled ? 0.5 : 1,
    letterSpacing: 0.3,
    whiteSpace: "nowrap" as const,
    flexShrink: 0 as const,
  };
}

/* -------------------------
   Simple cookie helpers
-------------------------- */
export function parseCookie(header: string | undefined) {
  const out: Record<string, string> = {};
  if (!header) return out;
  header.split(";").forEach((part) => {
    const [k, ...rest] = part.trim().split("=");
    if (!k) return;
    out[k] = decodeURIComponent(rest.join("=") || "");
  });
  return out;
}

export function setCookie(res: NextApiResponse, name: string, value: string, opts?: {
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Lax" | "Strict" | "None";
  path?: string;
  maxAge?: number; // seconds
}) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${opts?.path ?? "/"}`,
    `SameSite=${opts?.sameSite ?? "Lax"}`,
  ];
  if (opts?.httpOnly ?? true) parts.push("HttpOnly");
  if (opts?.secure ?? (process.env.NODE_ENV === "production")) parts.push("Secure");
  if (typeof opts?.maxAge === "number") parts.push(`Max-Age=${opts.maxAge}`);
  res.setHeader("Set-Cookie", parts.join("; "));
}

export function clearCookie(res: NextApiResponse, name: string) {
  res.setHeader("Set-Cookie", `${name}=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly`);
}

export function getAuthCookie(req: NextApiRequest) {
  const c = parseCookie(req.headers.cookie);
  return c["cacc_admin"] === "1";
}
