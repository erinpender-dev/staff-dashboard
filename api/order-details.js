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

function parseJsonSafe(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  if (Array.isArray(value) || typeof value === "object") return value;

  try {
    return JSON.parse(value);
  } catch (error) {
    return fallback;
  }
}

function normalizeContact(contact = {}) {
  return {
    name: clean(contact.name),
    email: clean(contact.email),
    phone: clean(contact.phone),
    organization: clean(contact.organization),
    title: clean(contact.title),
    role: clean(contact.role)
  };
}

function normalizeContacts(value) {
  const parsed = parseJsonSafe(value, value);

  if (!Array.isArray(parsed)) return [];

  return parsed
    .map((contact) => normalizeContact(contact))
    .filter((contact) => {
      return (
        contact.name ||
        contact.email ||
        contact.phone ||
        contact.organization ||
        contact.title ||
        contact.role
      );
    });
}

function normalizePartialPayments(value) {
  const parsed = parseJsonSafe(value, value);

  if (!Array.isArray(parsed)) return [];

  return parsed
    .map((payment) => ({
      type: clean(payment?.type),
      amount: clean(payment?.amount),
      check_number: clean(payment?.check_number)
    }))
    .filter((payment) => payment.type || payment.amount || payment.check_number);
}

function normalize(body = {}) {
  return {
    custom_customer_name: clean(body.custom_customer_name),
    custom_customer_email: clean(body.custom_customer_email),
    custom_customer_phone: clean(body.custom_customer_phone),

    prepared_for: clean(body.prepared_for),
    reference: clean(body.reference),
    school: clean(body.school),
    sent_with: clean(body.sent_with),

    delivery_notes: clean(body.delivery_notes),
    staff_notes: clean(body.staff_notes),
    production_notes: clean(body.production_notes),

    internal_order_status: clean(body.internal_order_status),
    internal_payment_status: clean(body.internal_payment_status),

    payment_received_type: clean(body.payment_received_type),
    payment_received_amount: clean(body.payment_received_amount),
    payment_received_check_number: clean(body.payment_received_check_number),

    partial_payments: normalizePartialPayments(body.partial_payments),

    client_contacts: normalizeContacts(body.client_contacts),
    contact_cards: normalizeContacts(body.contact_cards),
    contacts: normalizeContacts(body.contacts),
    custom_contacts: normalizeContacts(body.custom_contacts),
    metafield_contacts: normalizeContacts(body.metafield_contacts),
    dashboard_contacts: normalizeContacts(body.dashboard_contacts),
    order_contacts: normalizeContacts(body.order_contacts),

    organizations: Array.isArray(body.organizations)
      ? body.organizations.map((value) => clean(value)).filter(Boolean)
      : [],

    updated_at: new Date().toISOString()
  };
}

function getPath(orderId) {
  return `order-details/${orderId}.json`;
}

async function readPrivateJson(orderId) {
  const baseUrl = process.env.BLOB_BASE_URL;
  const token = process.env.BLOB_READ_WRITE_TOKEN;

  if (!baseUrl || !token) {
    throw new Error("Missing BLOB_BASE_URL or BLOB_READ_WRITE_TOKEN");
  }

  const url = `${baseUrl}/${getPath(orderId)}`;

  const response = await fetch(`${url}?ts=${Date.now()}`, {
  headers: {
    Authorization: `Bearer ${token}`,
    "Cache-Control": "no-cache"
  },
  cache: "no-store"
});


  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Blob read failed: ${text}`);
  }

  return await response.json();
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
      const existing = await readPrivateJson(orderId).catch((error) => {
        if (String(error.message || "").includes("404")) return null;
        throw error;
      });

      return res.status(200).json({
        order_id: String(orderId),
        details: existing || null
      });
    }

    if (req.method === "POST") {
      const payload = normalize(req.body || {});
      let existing = null;

      try {
        existing = await readPrivateJson(orderId);
      } catch (error) {
        if (!String(error.message || "").includes("404")) {
          throw error;
        }
      }

      const merged = {
        ...(existing || {}),
        ...payload,
        order_id: String(orderId)
      };

      await put(getPath(orderId), JSON.stringify(merged, null, 2), {
        access: "private",
        contentType: "application/json",
        allowOverwrite: true
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
