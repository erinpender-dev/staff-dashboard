import { put } from "@vercel/blob";

function setCors(req, res) {
  const allowedOrigin = process.env.ALLOWED_ORIGIN || "*";

  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function clean(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function normalize(body = {}) {
  return {
    custom_customer_name: clean(body.custom_customer_name),
    custom_customer_email: clean(body.custom_customer_email),
    custom_customer_phone: clean(body.custom_customer_phone),
    prepared_for: clean(body.prepared_for),
    school: clean(body.school),
    sent_with: clean(body.sent_with),
    delivery_notes: clean(body.delivery_notes),
    staff_notes: clean(body.staff_notes),
    production_notes: clean(body.production_notes),
    updated_at: new Date().toISOString()
  };
}

const BLOB_BASE = process.env.BLOB_READ_WRITE_TOKEN
  ? "https://blob.vercel-storage.com"
  : "";

function getPath(orderId) {
  return `order-details/${orderId}.json`;
}

async function readDetails(orderId) {
  try {
    const url = `${BLOB_BASE}/${getPath(orderId)}`;
    const res = await fetch(url);

    if (!res.ok) return null;

    return await res.json();
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  setCors(req, res);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const orderId =
    req.method === "GET"
      ? req.query.order_id
      : req.body?.order_id;

  if (!orderId) {
    return res.status(400).json({ error: "Missing order_id" });
  }

  try {
    if (req.method === "GET") {
      const existing = await readDetails(orderId);

      return res.status(200).json({
        order_id: String(orderId),
        details: existing || null
      });
    }

    if (req.method === "POST") {
      const payload = normalize(req.body || {});
      const existing = (await readDetails(orderId)) || {};

      const merged = {
        ...existing,
        ...payload,
        order_id: String(orderId)
      };

      await put(getPath(orderId), JSON.stringify(merged, null, 2), {
        access: "public",
        contentType: "application/json"
      });

      return res.status(200).json({
        success: true,
        order_id: String(orderId),
        details: merged
      });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (error) {
    return res.status(500).json({
      error: "Server error",
      details: error.message
    });
  }
}