// pages/judge/login.tsx
import Head from "next/head";
import Link from "next/link";
import { useState } from "react";

export default function JudgeLoginPage() {
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
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
      setErr("Network error.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Head>
        <title>Competition Matrix — Judge Login</title>
      </Head>

      <main
        className="responsive-page"
        style={{
          minHeight: "100vh",
          background: "var(--cacc-navy)",
          color: "white",
          display: "grid",
          placeItems: "center",
          padding: 18,
          fontFamily: "system-ui",
        }}
      >
        <div
          style={{
            width: "min(520px, 92vw)",
            borderRadius: 18,
            background: "rgba(255,255,255,0.06)",
            border: "1px solid rgba(255,255,255,0.12)",
            padding: 18,
            boxShadow: "0 10px 30px rgba(0,0,0,0.25)",
          }}
        >
          <div style={{ fontSize: 20, fontWeight: 1000 }}>Judge Login</div>
          <div style={{ marginTop: 6, fontSize: 13, opacity: 0.8 }}>
            Enter the judge password to access the Judge Console.
          </div>

          <input
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            type="password"
            placeholder="Judge password"
            style={{
              marginTop: 14,
              width: "100%",
              padding: "12px 14px",
              minHeight: 44,
              borderRadius: 12,
              border: "1px solid rgba(255,255,255,0.18)",
              background: "rgba(0,0,0,0.25)",
              color: "white",
              outline: "none",
              fontSize: 16,
            }}
          />

          {err ? <div style={{ marginTop: 10, color: "#ffb4b4", fontWeight: 900 }}>{err}</div> : null}

          <button
            onClick={submit}
            disabled={busy || !password}
            style={{
              marginTop: 14,
              width: "100%",
              padding: "12px 14px",
              minHeight: 44,
              borderRadius: 12,
              border: "1px solid rgba(255,255,255,0.18)",
              background: "var(--cacc-gold)",
              color: "#111",
              fontWeight: 1000,
              cursor: busy ? "not-allowed" : "pointer",
              opacity: busy || !password ? 0.6 : 1,
            }}
          >
            {busy ? "Signing in…" : "Sign In"}
          </button>

          <div style={{ marginTop: 12, fontSize: 12, opacity: 0.75 }}>
            <Link href="/login" style={{ color: "var(--cacc-gold)", textDecoration: "underline" }}>
              ← Back to role chooser
            </Link>
          </div>
        </div>
      </main>
    </>
  );
}
