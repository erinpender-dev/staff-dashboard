export default async function handler(req, res) {
  const allowedOrigin = process.env.ALLOWED_ORIGIN || "*";

  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

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

  const orderId = req.query.id;

  if (!orderId) {
    return res.status(400).json({ error: "Missing order id" });
  }

  try {
    const url = `https://${shop}/admin/api/2025-10/orders/${encodeURIComponent(
      orderId
    )}.json?status=any`;

    const response = await fetch(url, {
      method: "GET",
      headers: {
        "X-Shopify-Access-Token": token,
        "Content-Type": "application/json"
      }
    });

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

    const customerName =
      order.customer
        ? [order.customer.first_name, order.customer.last_name]
            .filter(Boolean)
            .join(" ")
        : order.billing_address?.name ||
          order.shipping_address?.name ||
          "No customer name";

    const customerEmail =
      order.email ||
      order.customer?.email ||
      order.contact_email ||
      "";

    const customerPhone =
      order.phone ||
      order.billing_address?.phone ||
      order.shipping_address?.phone ||
      order.customer?.phone ||
      "";

    const preparedFor =
      order.note_attributes?.find(
        (attr) =>
          (attr.name || "").toLowerCase() === "athlete name & sport" ||
          (attr.name || "").toLowerCase() === "student info" ||
          (attr.name || "").toLowerCase() === "prepared for"
      )?.value || "";

    return res.status(200).json({
      order: {
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
        customer_name: customerName,
        customer_email: customerEmail,
        customer_phone: customerPhone,
        prepared_for: preparedFor,
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
      }
    });
  } catch (error) {
    return res.status(500).json({
      error: "Server error",
      details: error.message
    });
  }
}
