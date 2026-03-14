// pages/api/auth/login.ts
import type { NextApiRequest, NextApiResponse } from "next";
import { signRolePayload } from "@/lib/auth";
import { checkLoginRateLimit, recordFailedAttempt } from "@/lib/rateLimit";

function getClientIp(req: NextApiRequest): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") return forwarded.split(",")[0]?.trim() ?? "unknown";
  return req.socket?.remoteAddress ?? "unknown";
}

const ROLE_COOKIE_MAX_AGE_SEC = 43200; // 12 hours

function buildRoleCookie(role: "admin" | "judge"): string {
  const signed = signRolePayload(role);
  const parts = [
    `cacc_role=${encodeURIComponent(signed)}`,
    "Path=/",
    `Max-Age=${ROLE_COOKIE_MAX_AGE_SEC}`,
    "SameSite=Lax",
    "HttpOnly",
  ];
  if (process.env.NODE_ENV === "production") parts.push("Secure");
  return parts.join("; ");
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const ip = getClientIp(req);
  if (!checkLoginRateLimit(ip)) {
    return res.status(429).json({ error: "Too many attempts. Try again in 15 minutes." });
  }

  const { role, password } = (req.body ?? {}) as { role?: string; password?: string };

  if (!role || !password || typeof role !== "string" || typeof password !== "string") {
    return res.status(400).json({ error: "Missing role or password" });
  }

  if (role !== "admin" && role !== "judge") {
    return res.status(400).json({ error: "Invalid role" });
  }

  const envPassword =
    role === "admin"
      ? process.env.ADMIN_PASSWORD ?? "changeme"
      : process.env.JUDGE_PASSWORD ?? "judge";

  if (process.env.NODE_ENV === "production") {
    const required = role === "admin" ? "ADMIN_PASSWORD" : "JUDGE_PASSWORD";
    const pw = role === "admin" ? process.env.ADMIN_PASSWORD : process.env.JUDGE_PASSWORD;
    if (!pw || pw.length < 8) {
      return res.status(500).json({
        error: `Server misconfigured: ${required} required in production (min 8 chars)`,
      });
    }
  }

  if (password !== envPassword) {
    recordFailedAttempt(ip);
    return res.status(401).json({ error: "Invalid password" });
  }

  // Admin gets cacc_admin + cacc_role. Judge gets only cacc_role (no cacc_admin).
  const roleCookie = buildRoleCookie(role);
  const cookies = [roleCookie];
  if (role === "admin") {
    cookies.push(`cacc_admin=1; Path=/; Max-Age=${60 * 60 * 12}; SameSite=Lax; HttpOnly${process.env.NODE_ENV === "production" ? "; Secure" : ""}`);
  }
  res.setHeader("Set-Cookie", cookies);

  return res.status(200).json({ ok: true });
}
