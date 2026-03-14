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

  return (
    <>
      <Head>
        <title>{displayTitle} — Portal</title>
      </Head>

      <main
        style={{
          minHeight: "100vh",
          background:
            "radial-gradient(1200px 600px at 50% -160px, rgba(255,215,64,0.12), transparent 60%), var(--cacc-navy)",
          color: "white",
          display: "grid",
          placeItems: "center",
          padding: 18,
          fontFamily: "system-ui",
        }}
      >
        <section
          style={{
            width: "min(820px, 100%)",
            borderRadius: 20,
            background: "rgba(255,255,255,0.055)",
            border: "1px solid rgba(255,255,255,0.13)",
            boxShadow: "0 20px 60px rgba(0,0,0,0.40)",
            padding: "32px 28px",
            display: "flex",
            flexDirection: "column",
            gap: 28,
          }}
        >
          {/* Header */}
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14, textAlign: "center" }}>
            <img
              src="/cacc-shield.png"
              alt="California Cadet Corps shield"
              style={{
                width: "clamp(72px, 13vw, 100px)",
                height: "auto",
                objectFit: "contain",
                filter: "drop-shadow(0 6px 16px rgba(0,0,0,0.4))",
              }}
            />
            <div>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: 1.8,
                  opacity: 0.6,
                  textTransform: "uppercase",
                  marginBottom: 8,
                }}
              >
                California Cadet Corps
              </div>
              <h1
                style={{
                  margin: 0,
                  fontSize: "clamp(20px, 4vw, 32px)",
                  lineHeight: 1.15,
                  letterSpacing: 0.2,
                  fontWeight: 800,
                }}
              >
                {loading ? "Loading event…" : displayTitle}
              </h1>
              {loadError && (
                <div style={{ marginTop: 6, fontSize: 12, opacity: 0.55 }}>
                  Could not reach server — showing default title.
                </div>
              )}
            </div>
          </div>

          {/* Divider */}
          <div style={{ height: 1, background: "rgba(255,255,255,0.10)" }} />

          {/* Portal cards */}
          <div>
            <div
              style={{
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: 1.4,
                opacity: 0.5,
                textTransform: "uppercase",
                textAlign: "center",
                marginBottom: 14,
              }}
            >
              Select Portal
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
                gap: 12,
              }}
            >
              <Link href="/public" className="portal-card" style={portalCardStyle("#1a4a85", "#2c6fba")}>
                <span style={portalIconStyle}>📺</span>
                <span style={portalLabelStyle}>Public Board</span>
                <span style={portalDescStyle}>Live competition display for spectators and broadcast</span>
              </Link>

              <Link href="/judge/login" className="portal-card" style={portalCardStyle("#7a5a00", "#ffc72c")}>
                <span style={portalIconStyle}>⚖️</span>
                <span style={portalLabelStyle}>Judge Console</span>
                <span style={portalDescStyle}>Operational control for assigned competition area</span>
              </Link>

              <Link href="/admin/login" className="portal-card" style={portalCardStyle("#1a1a2e", "#404060")}>
                <span style={portalIconStyle}>⚙️</span>
                <span style={portalLabelStyle}>Admin Console</span>
                <span style={portalDescStyle}>Event management, roster, and full system control</span>
              </Link>
            </div>
          </div>

          {/* Footer */}
          <div style={{ textAlign: "center", fontSize: 12, opacity: 0.45 }}>
            Competition Management System
          </div>
        </section>
      </main>
    </>
  );
}

function portalCardStyle(bgFrom: string, bgTo: string): CSSProperties {
  return {
    textDecoration: "none",
    color: "white",
    display: "flex",
    flexDirection: "column",
    gap: 8,
    borderRadius: 14,
    minHeight: 130,
    padding: "18px 16px",
    border: "1px solid rgba(255,255,255,0.16)",
    background: `linear-gradient(160deg, ${bgFrom}, rgba(0,0,0,0.30))`,
    boxShadow: "0 6px 20px rgba(0,0,0,0.30)",
    justifyContent: "flex-start",
  };
}

const portalIconStyle: CSSProperties = {
  fontSize: 22,
  lineHeight: 1,
};

const portalLabelStyle: CSSProperties = {
  fontSize: 16,
  lineHeight: 1.1,
  fontWeight: 800,
  letterSpacing: 0.2,
};

const portalDescStyle: CSSProperties = {
  fontSize: 12,
  opacity: 0.75,
  lineHeight: 1.4,
};
