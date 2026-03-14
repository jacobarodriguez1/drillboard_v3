// pages/login.tsx — Role chooser
import Head from "next/head";
import Link from "next/link";

export default function LoginPage() {
  return (
    <>
      <Head>
        <title>Sign In — CACC Competition</title>
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
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12, textAlign: "center", marginBottom: 24 }}>
            <img
              src="/cacc-shield.png"
              alt="California Cadet Corps"
              className="login-logo"
            />
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1.2, opacity: 0.6, textTransform: "uppercase", marginBottom: 6 }}>
                California Cadet Corps
              </div>
              <h1 className="login-title">Select Your Role</h1>
              <p className="login-subtitle">Choose the console you need to access.</p>
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <Link
              href="/judge/login"
              style={{
                display: "block",
                padding: "14px 18px",
                borderRadius: 10,
                border: "none",
                background: "var(--cacc-gold)",
                color: "#111",
                fontWeight: 800,
                fontSize: 15,
                textAlign: "center",
                textDecoration: "none",
                transition: "filter 120ms ease, transform 120ms ease",
              }}
              className="portal-card"
            >
              Judge Console
            </Link>
            <Link
              href="/admin/login"
              style={{
                display: "block",
                padding: "14px 18px",
                borderRadius: 10,
                border: "1px solid rgba(255,255,255,0.18)",
                background: "rgba(255,255,255,0.07)",
                color: "white",
                fontWeight: 800,
                fontSize: 15,
                textAlign: "center",
                textDecoration: "none",
                transition: "filter 120ms ease, transform 120ms ease",
              }}
              className="portal-card"
            >
              Admin Console
            </Link>
          </div>

          <div style={{ marginTop: 20, textAlign: "center" }}>
            <Link href="/" style={{ fontSize: 13, opacity: 0.6, color: "white", textDecoration: "underline" }}>
              ← Back to portal
            </Link>
          </div>
        </div>
      </main>
    </>
  );
}
