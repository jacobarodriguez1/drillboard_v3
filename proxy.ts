// proxy.ts — Route protection for /admin and /judge (presence checks only)
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

function parseCookie(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  header.split(";").forEach((part) => {
    const [k, ...rest] = part.trim().split("=");
    if (!k) return;
    out[k] = decodeURIComponent(rest.join("=") || "");
  });
  return out;
}

export function proxy(req: NextRequest) {
  const path = req.nextUrl.pathname;

  // Skip non-page routes (matcher should handle this, but be explicit)
  if (path.startsWith("/api/") || path.startsWith("/_next/") || path === "/favicon.ico") {
    return NextResponse.next();
  }

  // /admin/* (except /admin/login)
  if (path.startsWith("/admin")) {
    if (path === "/admin/login" || path === "/admin/login/") {
      return NextResponse.next();
    }
    const cookie = parseCookie(req.headers.get("cookie") ?? undefined);
    // Admin: require cacc_admin=1 (only admins get this cookie; getServerSideProps verifies role)
    if (cookie["cacc_admin"] !== "1") {
      return NextResponse.redirect(new URL("/admin/login", req.url));
    }
    return NextResponse.next();
  }

  // /judge/* (except /judge/login)
  if (path.startsWith("/judge")) {
    if (path === "/judge/login" || path === "/judge/login/") {
      return NextResponse.next();
    }
    const cookie = parseCookie(req.headers.get("cookie") ?? undefined);
    // Judge: require cacc_role present only (no cacc_admin; getServerSideProps verifies HMAC)
    const hasRole = (cookie["cacc_role"]?.length ?? 0) > 0;
    if (!hasRole) {
      return NextResponse.redirect(new URL("/judge/login", req.url));
    }
    return NextResponse.next();
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/admin/:path*", "/judge/:path*"],
};
