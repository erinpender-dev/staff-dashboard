export function setCors(req, res, methods = "GET, OPTIONS") {
  const requestOrigin = req?.headers?.origin || "";
  const configuredOrigins = String(process.env.ALLOWED_ORIGIN || "*")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  let allowedOrigin = "*";
  if (configuredOrigins.length && !configuredOrigins.includes("*")) {
    allowedOrigin = configuredOrigins.includes(requestOrigin)
      ? requestOrigin
      : configuredOrigins[0];
  }

  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", methods);
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Dashboard-Token, Cache-Control");
}

export function setNoStore(res) {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Surrogate-Control", "no-store");
}

export function isValidOrderId(value) {
  return /^\d{6,20}$/.test(clean(value));
}

export function isValidSimpleId(value, maxLength = 80) {
  const id = clean(value);
  return Boolean(id && id.length <= maxLength && /^[a-zA-Z0-9_-]+$/.test(id));
}

export function isValidShopDomain(value) {
  return /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(clean(value));
}

export function validateAllowedKeys(body = {}, allowedKeys = []) {
  const allowed = new Set(allowedKeys);
  return Object.keys(body || {}).filter((key) => !allowed.has(key));
}

export function requireJsonRequest(req, res, maxBytes = 64 * 1024) {
  const contentType = clean(req.headers?.["content-type"]).toLowerCase();
  if (!contentType.includes("application/json")) {
    res.status(415).json({ error: "Content-Type must be application/json." });
    return false;
  }

  const contentLength = Number(req.headers?.["content-length"] || 0);
  if (contentLength && contentLength > maxBytes) {
    res.status(413).json({ error: "Request body is too large." });
    return false;
  }

  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
    res.status(400).json({ error: "JSON body must be an object." });
    return false;
  }

  return true;
}

const rateLimitBuckets = new Map();

export function rateLimit(req, res, { windowMs = 60_000, max = 120 } = {}) {
  const now = Date.now();
  const forwarded = clean(req.headers?.["x-forwarded-for"]).split(",")[0];
  const key = forwarded || req.socket?.remoteAddress || "unknown";
  const bucket = rateLimitBuckets.get(key) || { count: 0, resetAt: now + windowMs };

  if (bucket.resetAt <= now) {
    bucket.count = 0;
    bucket.resetAt = now + windowMs;
  }

  bucket.count += 1;
  rateLimitBuckets.set(key, bucket);

  if (bucket.count > max) {
    res.status(429).json({ error: "Too many requests. Please try again shortly." });
    return false;
  }

  return true;
}

export function requireDashboardAuth(req, res) {
  const expected = clean(process.env.DASHBOARD_API_TOKEN || process.env.INTERNAL_API_TOKEN);
  if (!expected) {
    res.status(500).json({ error: "Dashboard API authentication is not configured." });
    return false;
  }

  const authHeader = clean(req.headers?.authorization);
  const bearer = authHeader.toLowerCase().startsWith("bearer ")
    ? authHeader.slice(7).trim()
    : "";
  const provided = bearer || clean(req.headers?.["x-dashboard-token"]);

  if (!provided || provided !== expected) {
    res.status(401).json({ error: "Unauthorized." });
    return false;
  }

  return true;
}

export function clientError(res, status, message) {
  return res.status(status).json({ error: message });
}

export function serverError(res, fallback = "Server error.") {
  return res.status(500).json({ error: fallback });
}

export function clean(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

export function parseJsonSafe(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  if (Array.isArray(value) || typeof value === "object") return value;

  try {
    return JSON.parse(value);
  } catch (error) {
    return fallback;
  }
}

export function getOrderDetailsPath(orderId) {
  const safeOrderId = clean(orderId);
  if (!isValidOrderId(safeOrderId)) {
    throw new Error("Invalid order id.");
  }
  return `order-details/${safeOrderId}.json`;
}

export async function readPrivateJson(orderId) {
  const baseUrl = process.env.BLOB_BASE_URL;
  const token = process.env.BLOB_READ_WRITE_TOKEN;

  if (!baseUrl || !token) {
    throw new Error("Missing BLOB_BASE_URL or BLOB_READ_WRITE_TOKEN");
  }

  const url = `${baseUrl}/${getOrderDetailsPath(orderId)}`;
  const response = await fetch(`${url}?ts=${Date.now()}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Cache-Control": "no-cache"
    },
    cache: "no-store"
  });

  if (response.status === 404) return null;

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Blob read failed: ${text}`);
  }

  return await response.json();
}
