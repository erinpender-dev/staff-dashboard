import crypto from "crypto";

const DEFAULT_COOKIE_NAME = "bk_internal_session";
const SESSION_TTL_SECONDS = 60 * 60 * 12;

// Edit internal staff logins here. Passwords stay server-side in this API file.
// You can also override passwords in Vercel env vars without changing code.
const INTERNAL_USERS = {
  Erin: {
    username: "Erin",
    displayName: "Erin",
    password: process.env.INTERNAL_USER_ERIN_PASSWORD || "Erin123!"
  },
  user2: {
    username: "User2",
    displayName: "User 2",
    password: process.env.INTERNAL_USER2_PASSWORD || "User2123!"
  },
  user3: {
    username: "User3",
    displayName: "User 3",
    password: process.env.INTERNAL_USER3_PASSWORD || "User3123!"
  }
};

function clean(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function base64UrlEncode(value) {
  return Buffer.from(value).toString("base64url");
}

function base64UrlJson(value) {
  return base64UrlEncode(JSON.stringify(value));
}

function sign(value, secret) {
  return crypto.createHmac("sha256", secret).update(value).digest("base64url");
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function getCookieName() {
  return clean(process.env.INTERNAL_SESSION_COOKIE_NAME) || DEFAULT_COOKIE_NAME;
}

function getSessionSecret() {
  return clean(process.env.INTERNAL_SESSION_SECRET);
}

function parseCookies(req) {
  const header = req?.headers?.cookie || "";
  return header.split(";").reduce((cookies, part) => {
    const index = part.indexOf("=");
    if (index < 0) return cookies;
    const key = clean(part.slice(0, index));
    const value = clean(part.slice(index + 1));
    if (key) {
      try {
        cookies[key] = decodeURIComponent(value);
      } catch (error) {
        cookies[key] = value;
      }
    }
    return cookies;
  }, {});
}

function getBearerToken(req) {
  const header = clean(req?.headers?.authorization || req?.headers?.Authorization);
  const match = header.match(/^Bearer\s+(.+)$/i);
  return clean(match?.[1]);
}

function cookieAttributes(maxAgeSeconds) {
  return [
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=None",
    `Max-Age=${maxAgeSeconds}`,
    `Expires=${new Date(Date.now() + maxAgeSeconds * 1000).toUTCString()}`
  ].join("; ");
}

export function createStaffSession(user) {
  const now = Math.floor(Date.now() / 1000);
  const username = clean(user?.username);
  const displayName = clean(user?.displayName) || username;
  return {
    isAuthenticated: true,
    authMode: "internal_user",
    staffId: username,
    staffName: displayName,
    staffRole: "admin",
    username,
    displayName,
    iat: now,
    exp: now + SESSION_TTL_SECONDS
  };
}

export function createSessionToken(session) {
  const secret = getSessionSecret();
  if (!secret) {
    throw new Error("INTERNAL_SESSION_SECRET is not configured.");
  }

  const payload = base64UrlJson(session);
  const signature = sign(payload, secret);
  return `${payload}.${signature}`;
}

export function verifySessionToken(token) {
  const secret = getSessionSecret();
  if (!secret) return null;

  const [payload, signature] = clean(token).split(".");
  if (!payload || !signature) return null;

  const expected = sign(payload, secret);
  if (!safeEqual(signature, expected)) return null;

  let session;
  try {
    session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch (error) {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  if (!session?.isAuthenticated || Number(session.exp || 0) <= now) {
    return null;
  }

  const username = clean(session.username) || clean(session.staffName);
  const configuredUser = INTERNAL_USERS[username];
  if (!configuredUser) return null;

  const displayName = clean(configuredUser.displayName) || clean(configuredUser.username) || username;

  return {
    isAuthenticated: true,
    authMode: clean(session.authMode) || "internal_user",
    staffId: session.staffId || username || null,
    staffName: displayName || "Internal User",
    staffRole: clean(session.staffRole) || "admin",
    username,
    displayName
  };
}

export function getInternalAuth(req) {
  const bearerToken = getBearerToken(req);
  const bearerAuth = verifySessionToken(bearerToken);
  if (bearerAuth?.isAuthenticated) {
    return bearerAuth;
  }

  const cookies = parseCookies(req);
  return verifySessionToken(cookies[getCookieName()]);
}

export function setInternalSessionCookie(res, session) {
  const token = createSessionToken(session);
  res.setHeader("Set-Cookie", `${getCookieName()}=${encodeURIComponent(token)}; ${cookieAttributes(SESSION_TTL_SECONDS)}`);
  return token;
}

export function clearInternalSessionCookie(res) {
  res.setHeader("Set-Cookie", `${getCookieName()}=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`);
}

export async function requireInternalAuth(req, res) {
  const auth = getInternalAuth(req);
  if (auth?.isAuthenticated) {
    req.internalAuth = auth;
    return auth;
  }

  res.status(401).json({
    ok: false,
    error: "Internal dashboard login required."
  });
  return null;
}

export function validateInternalUser(username, password) {
  const normalizedUsername = clean(username);
  const providedPassword = clean(password);
  const user = INTERNAL_USERS[normalizedUsername];

  if (!user || !providedPassword) return null;
  if (!safeEqual(providedPassword, user.password)) return null;

  return {
    username: user.username,
    displayName: clean(user.displayName) || user.username
  };
}
