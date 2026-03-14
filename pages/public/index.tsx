// pages/public/index.tsx
import Head from "next/head";
import { useEffect, useState } from "react";
import PublicBoard from "@/components/PublicBoard";
import { setRoleCookie } from "@/lib/auth";

export async function getServerSideProps(ctx: import("next").GetServerSidePropsContext) {
  setRoleCookie(ctx.res, "public");
  return { props: {} };
}

function useKioskFlag() {
  const [kiosk, setKiosk] = useState(false);

  useEffect(() => {
    const url = new URL(window.location.href);
    setKiosk(url.searchParams.get("kiosk") === "1");
  }, []);

  return kiosk;
}

export default function PublicPage() {
  const kiosk = useKioskFlag();

  // Enter fullscreen when kiosk=1 (e.g. bookmarked /public?kiosk=1)
  useEffect(() => {
    if (!kiosk) return;

    const el = document.documentElement;

    const tryFullscreen = async () => {
      try {
        if (!document.fullscreenElement) {
          // @ts-ignore
          await el.requestFullscreen?.();
        }
      } catch {}
    };

    tryFullscreen();
  }, [kiosk]);

  // Kiosk CSS: hide cursor + prevent scroll
  useEffect(() => {
    if (!kiosk) return;
    const style = document.createElement("style");
    style.textContent = "html, body { overflow: hidden; } * { cursor: none !important; }";
    document.head.appendChild(style);
    return () => style.remove();
  }, [kiosk]);

  return (
    <>
      <Head>
        <title>Competition Matrix — Public Board</title>
      </Head>

      <PublicBoard kiosk={kiosk} />
    </>
  );
}
