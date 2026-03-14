// pages/judge/login.tsx
import Head from "next/head";
import Link from "next/link";
import { useState } from "react";

export default function JudgeLoginPage() {
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!password || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "judge", password }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        setErr(data?.error ?? "Login failed.");
        setBusy(false);
        return;
      }
      window.location.href = "/judge";
    } catch {
      setErr("Network error — check your connection.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Head>
        <title>Judge Login — CACC Competition</title>
      </Head>

      <main
        style={{
          minHeight: "100vh",
          background:
            "radial-gradient(900px 500px at 50% -100px, rgba(255,215,64,0.08), transparent 60%), var(--cacc-navy)",
          color: "white",
          display: "grid",
          placeItems: "center",
          padding: 18,
          fontFamily: "system-ui",
        }}
      >
        <div className="login-card">
          {/* Brand */}
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12, textAlign: "center" }}>
            <img
              src="/cacc-shield.png"
              alt="California Cadet Corps"
              className="login-logo"
            />
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1.2, opacity: 0.6, textTransform: "uppercase", marginBottom: 6 }}>
                California Cadet Corps
              </div>
              <h1 className="login-title">Judge Console</h1>
              <p className="login-subtitle">Sign in to access your assigned area.</p>
            </div>
          </div>

          {/* Form */}
          <input
            className="login-input"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            type="password"
            placeholder="Judge password"
            autoFocus
            autoComplete="current-password"
          />

          {err && <div className="login-error">{err}</div>}

          <button
            className="login-btn-primary"
            onClick={submit}
            disabled={busy || !password}
          >
            {busy ? "Signing in…" : "Sign In"}
          </button>

          <div className="login-back-link">
            <Link href="/">← Back to portal</Link>
          </div>
        </div>
      </main>
    </>
  );
}
