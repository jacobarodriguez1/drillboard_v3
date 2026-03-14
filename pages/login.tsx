// pages/login.tsx — Role chooser (no passwords)
import Head from "next/head";
import Link from "next/link";

export default function LoginPage() {
  return (
    <>
      <Head>
        <title>Competition Matrix — Login</title>
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
            padding: 24,
            boxShadow: "0 10px 30px rgba(0,0,0,0.25)",
          }}
        >
          <div style={{ fontSize: 20, fontWeight: 1000 }}>Competition Matrix</div>
          <div style={{ marginTop: 6, fontSize: 13, opacity: 0.8 }}>
            Choose your console to sign in.
          </div>

          <div
            style={{
              marginTop: 20,
              display: "flex",
              flexDirection: "column",
              gap: 12,
            }}
          >
            <Link
              href="/admin/login"
              style={{
                display: "block",
                padding: "14px 18px",
                borderRadius: 12,
                border: "1px solid rgba(255,255,255,0.18)",
                background: "rgba(0,0,0,0.25)",
                color: "white",
                fontWeight: 1000,
                textAlign: "center",
                textDecoration: "none",
              }}
            >
              Admin Console
            </Link>
            <Link
              href="/judge/login"
              style={{
                display: "block",
                padding: "14px 18px",
                borderRadius: 12,
                border: "1px solid rgba(255,255,255,0.18)",
                background: "var(--cacc-gold)",
                color: "#111",
                fontWeight: 1000,
                textAlign: "center",
                textDecoration: "none",
              }}
            >
              Judge Console
            </Link>
          </div>

          <div style={{ marginTop: 16, fontSize: 12, opacity: 0.75 }}>
            Set <code>ADMIN_PASSWORD</code> and <code>JUDGE_PASSWORD</code> in{" "}
            <code>.env.local</code>
          </div>
        </div>
      </main>
    </>
  );
}
