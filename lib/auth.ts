// lib/auth.ts
import crypto from "crypto";
import type { GetServerSidePropsContext, GetServerSidePropsResult } from "next";
import { parseCookie } from "@/lib/ui";

export type SocketRole = "admin" | "judge" | "public";

const ROLE_COOKIE_MAX_AGE_SEC = 43200; // 12 hours

function getSessionSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 16) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("SESSION_SECRET must be set (min 16 chars) in production");
    }
    return "dev-secret-change-me";
  }
  return secret;
}

/** Create HMAC-signed role payload. Format: base64url(payload).base64url(signature) */
export function signRolePayload(role: SocketRole): string {
  const exp = Math.floor(Date.now() / 1000) + ROLE_COOKIE_MAX_AGE_SEC;
  const payload = JSON.stringify({ r: role, exp });
  const secret = getSessionSecret();
  const sig = crypto.createHmac("sha256", secret).update(payload).digest();
  const payloadB64 = Buffer.from(payload, "utf8").toString("base64url");
  const sigB64 = sig.toString("base64url");
  return `${payloadB64}.${sigB64}`;
}

/** Verify signed role cookie. Returns role or null if invalid/expired. */
export function verifyRoleCookie(signedValue: string): SocketRole | null {
  if (!signedValue || typeof signedValue !== "string") return null;
  const parts = signedValue.split(".");
  if (parts.length !== 2) return null;

  const [payloadB64, sigB64] = parts;
  let payloadStr: string;
  try {
    payloadStr = Buffer.from(payloadB64, "base64url").toString("utf8");
  } catch {
    return null;
  }

  const secret = getSessionSecret();
  const expectedSig = crypto.createHmac("sha256", secret).update(payloadStr).digest().toString("base64url");
  if (sigB64 !== expectedSig) return null;

  let payload: { r?: string; exp?: number };
  try {
    payload = JSON.parse(payloadStr);
  } catch {
    return null;
  }

  const role = payload?.r;
  if (role !== "admin" && role !== "judge" && role !== "public") return null;
  if (typeof payload?.exp === "number" && payload.exp < Math.floor(Date.now() / 1000)) return null;

  return role;
}

/** Set signed cacc_role cookie for Socket.IO handshake. Tamper-proof via HMAC. */
export function setRoleCookie(
  res: GetServerSidePropsContext["res"],
  role: SocketRole
) {
  const signed = signRolePayload(role);
  const parts = [
    `cacc_role=${encodeURIComponent(signed)}`,
    "Path=/",
    `Max-Age=${ROLE_COOKIE_MAX_AGE_SEC}`,
    "SameSite=Lax",
    "HttpOnly",
  ];
  if (process.env.NODE_ENV === "production") parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

/** Check auth and role. Redirects to appropriate login if not authorized. */
export function requireAdminRole(
  ctx: GetServerSidePropsContext,
  requiredRole: "admin" | "judge"
): GetServerSidePropsResult<Record<string, never>> {
  const cookie = parseCookie(ctx.req.headers.cookie);
  const signedRole = cookie["cacc_role"];
  const role = signedRole ? verifyRoleCookie(signedRole) : null;

  if (!role) {
    const dest = requiredRole === "admin" ? "/admin/login" : "/judge/login";
    return { redirect: { destination: dest, permanent: false } } as const;
  }

  // Admin page: only role=admin allowed. Judge trying to access /admin → redirect.
  if (requiredRole === "admin" && role !== "admin") {
    return { redirect: { destination: "/admin/login", permanent: false } } as const;
  }

  // Judge page: role=judge or admin allowed (admin can access judge for testing)
  if (requiredRole === "judge" && role !== "judge" && role !== "admin") {
    return { redirect: { destination: "/judge/login", permanent: false } } as const;
  }

  // Ensure cacc_role is set for Socket.IO (refresh if expired; role already verified)
  setRoleCookie(ctx.res, role);
  return { props: {} } as const;
}
