import { put } from "@vercel/blob";

function setCors(req, res) {
  const allowedOrigin = process.env.ALLOWED_ORIGIN || "*";

  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function clean(value) {
  if (!value) return "";
  return String(value).trim();
}

const BLOB_BASE = process.env.BLOB_READ_WRITE_TOKEN
  ? "https://blob.vercel-storage.com"
  : "";

async function readDetails(orderId) {
  try {
    const res = await fetch(`${BLOB_BASE}/order-details/${orderId}.json`);
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

  const shop = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_ACCESS_TOKEN;

  const orderId = req.query.id;

  if (!orderId) {
    return res.status(400).json({ error: "Missing order id" });
  }

  try {
    const response = await fetch(
      `https://${shop}/admin/api/2025-10/orders/${orderId}.json?status=any`,
      {
        headers: {
          "X-Shopify-Access-Token": token
        }
      }
    );

    const data = await response.json();
    const order = data.order;

    const saved = (await readDetails(orderId)) || {};

    const shopifyName =
      order.customer?.first_name
        ? `${order.customer.first_name} ${order.customer.last_name}`
        : order.billing_address?.name ||
          order.shipping_address?.name ||
          "";

    const merged = {
      id: order.id,
      name: order.name,
      created_at: order.created_at,
      financial_status: order.financial_status,
      fulfillment_status: order.fulfillment_status || "unfulfilled",
      total_price: order.total_price,
      currency: order.currency,

      customer_name: clean(saved.custom_customer_name) || clean(shopifyName),
      customer_email:
        clean(saved.custom_customer_email) ||
        clean(order.email || order.customer?.email),
      customer_phone:
        clean(saved.custom_customer_phone) ||
        clean(order.phone || order.customer?.phone),

      prepared_for:
        clean(saved.prepared_for) ||
        "",

      school: clean(saved.school),
      sent_with: clean(saved.sent_with),
      delivery_notes: clean(saved.delivery_notes),
      staff_notes: clean(saved.staff_notes),
      production_notes: clean(saved.production_notes),

      line_items: (order.line_items || []).map((i) => ({
        title: i.title,
        variant_title: i.variant_title,
        sku: i.sku,
        quantity: i.quantity
      }))
    };

    res.status(200).json({ order: merged });
  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
}