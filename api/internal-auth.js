import { setCors } from "./shared-utils.js";
import {
  clearInternalSessionCookie,
  createStaffSession,
  getInternalAuth,
  setInternalSessionCookie,
  validateInternalUser
} from "./_lib/internal-auth.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, DELETE, OPTIONS");

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

  if (req.method === "POST") {
    const user = validateInternalUser(req.body?.username, req.body?.password);
    if (!user) {
      return res.status(401).json({ ok: false, error: "Invalid username or password." });
    }

    const session = createStaffSession(user);
    const sessionToken = setInternalSessionCookie(res, session);

    return res.status(200).json({
      ok: true,
      sessionToken,
      auth: {
        isAuthenticated: true,
        authMode: session.authMode,
        staffId: session.staffId,
        staffName: session.staffName,
        staffRole: session.staffRole,
        username: session.username,
        displayName: session.displayName
      }
    });
  }

  if (req.method === "DELETE") {
    clearInternalSessionCookie(res);
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: "Method not allowed." });
}
