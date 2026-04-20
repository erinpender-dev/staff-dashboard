import { setCors } from "./shared-utils.js";
import {
  createSharedStaffSession,
  getInternalAuth,
  passcodeMatches,
  setInternalSessionCookie
} from "./_lib/internal-auth.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method === "GET") {
    const auth = getInternalAuth(req);
    return res.status(200).json({
      ok: true,
      auth: auth || { isAuthenticated: false }
    });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed." });
  }

  const passcode = req.body?.passcode;
  if (!passcodeMatches(passcode)) {
    return res.status(401).json({ ok: false, error: "Invalid passcode." });
  }

  const session = createSharedStaffSession();
  setInternalSessionCookie(res, session);

  return res.status(200).json({
    ok: true,
    auth: {
      isAuthenticated: true,
      authMode: session.authMode,
      staffId: session.staffId,
      staffName: session.staffName,
      staffRole: session.staffRole
    }
  });
}
