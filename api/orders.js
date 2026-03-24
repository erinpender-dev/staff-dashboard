export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Surrogate-Control", "no-store");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const shop = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_ACCESS_TOKEN;

  if (!shop || !token) {
    return res.status(500).json({
      error: "Missing SHOPIFY_STORE or SHOPIFY_ACCESS_TOKEN"
    });
  }

  try {
    const status = req.query.status || "any";
    const fulfillmentStatus = req.query.fulfillment_status || "";
    const financialStatus = req.query.financial_status || "";
    const limit = req.query.limit || "100";

    let url = `https://${shop}/admin/api/2025-10/orders.json?status=${encodeURIComponent(status)}&limit=${encodeURIComponent(limit)}&order=created_at%20desc`;

    if (fulfillmentStatus) {
      url += `&fulfillment_status=${encodeURIComponent(fulfillmentStatus)}`;
    }

    if (financialStatus) {
      url += `&financial_status=${encodeURIComponent(financialStatus)}`;
    }

    const response = await fetch(url, {
      headers: {
        "X-Shopify-Access-Token": token,
        "Content-Type": "application/json",
        "Cache-Control": "no-cache"
      }
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: data?.errors || data?.error || "Failed to load Shopify orders",
        raw: data
      });
    }

    const orders = Array.isArray(data.orders)
      ? data.orders.map(normalizeOrder)
      : [];

    return res.status(200).json({ orders });
  } catch (error) {
    return res.status(500).json({
      error: error.message || "Unexpected server error"
    });
  }
}

function normalizeOrder(order) {
  const noteAttributes = Array.isArray(order.note_attributes)
    ? Object.fromEntries(
        order.note_attributes.map((item) => [item.name, item.value])
      )
    : {};

  const tags = Array.isArray(order.tags)
    ? order.tags
    : String(order.tags || "")
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);

  const shippingLines = Array.isArray(order.shipping_lines) ? order.shipping_lines : [];
  const hasLocalPickup = shippingLines.some((line) => {
    const title = String(line?.title || "").toLowerCase();
    const code = String(line?.code || "").toLowerCase();
    return title.includes("pickup") || code.includes("pickup");
  });

  const deliveryMethod = hasLocalPickup ? "pickup" : "ship";

  const pickupStatus =
    noteAttributes.bk_pickup_status ||
    noteAttributes.pickup_status ||
    "";

  return {
    ...order,
    tags,
    delivery_method: deliveryMethod,
    pickup_status: pickupStatus,
    metafields: {
      school_tag: noteAttributes.school_tag || "",
      student_info: noteAttributes.student_info || "",
      internal_notes: noteAttributes.internal_notes || "",
      sent_with: noteAttributes.sent_with || "",
      delivery_location: noteAttributes.delivery_location || "",
      delivery_complete: noteAttributes.delivery_complete || "false",
      pickup_status: pickupStatus,
      display_customer_name: noteAttributes.display_customer_name || "",
      display_customer_email: noteAttributes.display_customer_email || "",
      display_customer_phone: noteAttributes.display_customer_phone || ""
    },
    normalized_note_attributes: noteAttributes
  };
}
