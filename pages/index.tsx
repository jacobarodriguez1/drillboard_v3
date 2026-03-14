import Head from "next/head";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import type { BoardState } from "@/lib/state";
import { getSocket } from "@/lib/socketClient";

const FALLBACK_TITLE = "California Cadet Corps Competition";

type AnySocket = {
  on?: (event: string, cb: (...args: any[]) => void) => void;
  off?: (event: string, cb?: (...args: any[]) => void) => void;
};

function getDisplayTitle(state: BoardState | null): string {
  const raw = String(state?.eventHeaderLabel ?? "").trim();
  return raw.length ? raw : FALLBACK_TITLE;
}

export default function Home() {
  const [state, setState] = useState<BoardState | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    let alive = true;

    async function loadInitialState() {
      try {
        const res = await fetch("/api/state", { cache: "no-store" });
        if (!res.ok) throw new Error("State fetch failed");
        const next = (await res.json()) as BoardState;
        if (!alive) return;
        setState(next);
        setLoadError(false);
      } catch {
        if (!alive) return;
        setLoadError(true);
      } finally {
        if (alive) setLoading(false);
      }
    }

    loadInitialState();

    fetch("/api/socket").catch(() => undefined);
    const socket = getSocket() as AnySocket | null;
    if (!socket?.on) {
      return () => {
        alive = false;
      };
    }

    const onState = (next: BoardState) => {
      if (!alive) return;
      setState(next);
      setLoadError(false);
      setLoading(false);
    };

    socket.on("state", onState);

    return () => {
      alive = false;
      socket.off?.("state", onState);
    };
  }, []);

  const displayTitle = useMemo(() => getDisplayTitle(state), [state]);
  const subtitle = loading ? "Loading event..." : "Select Portal";

  return (
    <>
      <Head>
        <title>{displayTitle} — Portal</title>
      </Head>

      <main
        className="responsive-page"
        style={{
          minHeight: "100vh",
          background:
            "radial-gradient(1200px 600px at 50% -160px, rgba(255,215,64,0.10), transparent 60%), var(--cacc-navy)",
          color: "white",
          display: "grid",
          placeItems: "center",
          padding: 18,
          fontFamily: "system-ui",
        }}
      >
        <section
          style={{
            width: "min(780px, 100%)",
            borderRadius: 18,
            background: "rgba(255,255,255,0.06)",
            border: "1px solid rgba(255,255,255,0.14)",
            boxShadow: "0 14px 40px rgba(0,0,0,0.35)",
            padding: "24px 20px",
            display: "flex",
            flexDirection: "column",
            gap: 18,
          }}
        >
          <div style={{ display: "grid", placeItems: "center", gap: 12, textAlign: "center" }}>
            <img
              src="/cacc-shield.png"
              alt="California Cadet Corps shield"
              style={{
                width: "clamp(92px, 16vw, 132px)",
                height: "auto",
                objectFit: "contain",
                filter: "drop-shadow(0 8px 18px rgba(0,0,0,0.35))",
              }}
            />
            <h1
              style={{
                margin: 0,
                fontSize: "clamp(22px, 4.2vw, 36px)",
                lineHeight: 1.15,
                letterSpacing: 0.3,
                fontWeight: 1000,
              }}
            >
              {displayTitle}
            </h1>
            <div style={{ fontSize: 13, opacity: 0.8 }}>{subtitle}</div>
            {loadError ? (
              <div style={{ fontSize: 12, opacity: 0.75 }}>
                Live title unavailable. Showing default event title.
              </div>
            ) : null}
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
              gap: 12,
            }}
          >
            <Link href="/public" style={portalCardStyle("rgba(32,95,170,0.35)")}>
              <span style={portalLabelStyle}>PUBLIC</span>
              <span style={portalDescStyle}>View live competition status</span>
            </Link>

            <Link href="/judge/login" style={portalCardStyle("rgba(255,193,7,0.30)")}>
              <span style={portalLabelStyle}>JUDGE</span>
              <span style={portalDescStyle}>Enter scoring and judging tasks</span>
            </Link>

            <Link href="/admin/login" style={portalCardStyle("rgba(117,117,117,0.35)")}>
              <span style={portalLabelStyle}>ADMIN</span>
              <span style={portalDescStyle}>Control event settings and operations</span>
            </Link>
          </div>

          <div style={{ textAlign: "center", fontSize: 12, opacity: 0.72 }}>
            California Cadet Corps
            <br />
            Competition Management System
          </div>
        </section>
      </main>
    </>
  );
}

function portalCardStyle(accent: string): CSSProperties {
  return {
    textDecoration: "none",
    color: "white",
    display: "flex",
    flexDirection: "column",
    gap: 8,
    borderRadius: 14,
    minHeight: 116,
    padding: "16px 14px",
    border: "1px solid rgba(255,255,255,0.2)",
    background: `linear-gradient(180deg, ${accent}, rgba(0,0,0,0.20))`,
    boxShadow: "0 8px 20px rgba(0,0,0,0.25)",
    justifyContent: "center",
    transition: "transform 120ms ease, border-color 120ms ease",
  };
}

const portalLabelStyle: CSSProperties = {
  fontSize: 22,
  lineHeight: 1.1,
  fontWeight: 1000,
  letterSpacing: 0.4,
};

const portalDescStyle: CSSProperties = {
  fontSize: 13,
  opacity: 0.88,
};
