// pages/api/admin-logout.ts
import type { NextApiRequest, NextApiResponse } from "next";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  // Clear both auth cookies
  res.setHeader("Set-Cookie", [
    "cacc_admin=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly",
    "cacc_role=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly",
  ]);
  return res.status(200).json({ ok: true });
}
