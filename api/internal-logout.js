import { setCors } from "./shared-utils.js";
import { clearInternalSessionCookie } from "./_lib/internal-auth.js";

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed." });
  }

  clearInternalSessionCookie(res);
  return res.status(200).json({ ok: true });
}
