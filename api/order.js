function setCors(req, res) {
  const allowedOrigin = process.env.ALLOWED_ORIGIN || "*";

  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function clean(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
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

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`
    }
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

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const shop = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_ACCESS_TOKEN;
  const orderId = req.query.id;

  if (!shop || !token) {
    return res.status(500).json({
      error: "Missing SHOPIFY_STORE or SHOPIFY_ACCESS_TOKEN"
    });
  }

  if (!orderId) {
    return res.status(400).json({ error: "Missing order id" });
  }

  try {
    const response = await fetch(
      `https://${shop}/admin/api/2025-10/orders/${encodeURIComponent(orderId)}.json?status=any`,
      {
        headers: {
          "X-Shopify-Access-Token": token,
          "Content-Type": "application/json"
        }
      }
    );

    const text = await response.text();

    if (!response.ok) {
      return res.status(response.status).json({
        error: "Shopify API error",
        details: text
      });
    }

    const data = JSON.parse(text);
    const order = data.order;

    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    const saved = (await readPrivateJson(orderId)) || {};

    const shopifyCustomerName =
      order.customer
        ? [order.customer.first_name, order.customer.last_name]
            .filter(Boolean)
            .join(" ")
        : order.billing_address?.name ||
          order.shipping_address?.name ||
          "No customer name";

    const shopifyCustomerEmail =
      order.email ||
      order.customer?.email ||
      order.contact_email ||
      "";

    const shopifyCustomerPhone =
      order.phone ||
      order.billing_address?.phone ||
      order.shipping_address?.phone ||
      order.customer?.phone ||
      "";

    const shopifyPreparedFor =
      order.note_attributes?.find((attr) => {
        const name = (attr.name || "").toLowerCase();
        return (
          name === "athlete name & sport" ||
          name === "student info" ||
          name === "prepared for"
        );
      })?.value || "";

    const merged = {
      id: order.id,
      name: order.name,
      order_number: order.order_number,
      created_at: order.created_at,
      financial_status: order.financial_status,
      fulfillment_status: order.fulfillment_status || "unfulfilled",
      total_price: order.total_price,
      subtotal_price: order.subtotal_price,
      total_discounts: order.total_discounts,
      total_tax: order.total_tax,
      currency: order.currency,
      tags: order.tags || "",
      note: order.note || "",

      shopify_customer_name: clean(shopifyCustomerName),
      shopify_customer_email: clean(shopifyCustomerEmail),
      shopify_customer_phone: clean(shopifyCustomerPhone),
      shopify_prepared_for: clean(shopifyPreparedFor),

      custom_customer_name: clean(saved.custom_customer_name),
      custom_customer_email: clean(saved.custom_customer_email),
      custom_customer_phone: clean(saved.custom_customer_phone),

      customer_name: clean(saved.custom_customer_name) || clean(shopifyCustomerName),
      customer_email: clean(saved.custom_customer_email) || clean(shopifyCustomerEmail),
      customer_phone: clean(saved.custom_customer_phone) || clean(shopifyCustomerPhone),
      prepared_for: clean(saved.prepared_for) || clean(shopifyPreparedFor),

      school: clean(saved.school),
      sent_with: clean(saved.sent_with),
      delivery_notes: clean(saved.delivery_notes),
      staff_notes: clean(saved.staff_notes),
      production_notes: clean(saved.production_notes),
      custom_updated_at: clean(saved.updated_at),

      shipping_address: order.shipping_address || null,
      billing_address: order.billing_address || null,

      line_items: (order.line_items || []).map((item) => ({
        id: item.id,
        title: item.title,
        variant_title: item.variant_title,
        sku: item.sku,
        quantity: item.quantity,
        vendor: item.vendor,
        price: item.price
      }))
    };

    return res.status(200).json({ order: merged });
  } catch (error) {
    return res.status(500).json({
      error: "Server error",
      details: error.message
    });
  }
}