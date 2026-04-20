export function setCors(req, res, methods = "GET, OPTIONS") {
  const requestOrigin = req?.headers?.origin || "";
  const requestedHeaders = req?.headers?.["access-control-request-headers"];
  const configuredOrigins = String(process.env.ALLOWED_ORIGIN || "*")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  const strictOrigins = String(process.env.STRICT_ALLOWED_ORIGIN || "").toLowerCase() === "true";
  const isAllowedOrigin = configuredOrigins.includes("*") || configuredOrigins.includes(requestOrigin);
  const allowedOrigin = requestOrigin && (!strictOrigins || isAllowedOrigin)
    ? requestOrigin
    : configuredOrigins[0] || "*";

  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", methods);
  res.setHeader("Access-Control-Allow-Headers", requestedHeaders || "Content-Type, Authorization, Cache-Control");
  res.setHeader("Access-Control-Allow-Credentials", "true");
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
  return `order-details/${orderId}.json`;
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
