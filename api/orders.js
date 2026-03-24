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

function getPreparedFor(order) {
  const attrs = order.note_attributes || [];
  const found = attrs.find((attr) => {
    const name = String(attr.name || "").toLowerCase().trim();
    return (
      name === "athlete name & sport" ||
      name === "student info" ||
      name === "prepared for"
    );
  });

  return clean(found?.value);
}

function getShopifyCustomerName(order) {
  if (order.customer) {
    return clean(
      [order.customer.first_name, order.customer.last_name]
        .filter(Boolean)
        .join(" ")
    );
  }

  return clean(
    order.billing_address?.name ||
      order.shipping_address?.name ||
      "No customer name"
  );
}

function getShopifyCustomerEmail(order) {
  return clean(
    order.email ||
      order.customer?.email ||
      order.contact_email ||
      ""
  );
}

function getShopifyCustomerPhone(order) {
  return clean(
    order.phone ||
      order.billing_address?.phone ||
      order.shipping_address?.phone ||
      order.customer?.phone ||
      ""
  );
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

  if (!shop || !token) {
    return res.status(500).json({
      error: "Missing SHOPIFY_STORE or SHOPIFY_ACCESS_TOKEN"
    });
  }

  try {
    const status = req.query.status || "any";
    const fulfillmentStatus = req.query.fulfillment_status || "";
    const financialStatus = req.query.financial_status || "";
    const limit = req.query.limit || "50";

    let url = `https://${shop}/admin/api/2025-10/orders.json?status=${encodeURIComponent(
      status
    )}&limit=${encodeURIComponent(limit)}&order=created_at desc`;

    if (fulfillmentStatus) {
      url += `&fulfillment_status=${encodeURIComponent(fulfillmentStatus)}`;
    }

    if (financialStatus) {
      url += `&financial_status=${encodeURIComponent(financialStatus)}`;
    }

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

    let data;
    try {
      data = JSON.parse(text);
    } catch (error) {
      return res.status(500).json({
        error: "Invalid Shopify response",
        details: text
      });
    }

    const rawOrders = data.orders || [];

    const orders = await Promise.all(
      rawOrders.map(async (order) => {
        let saved = null;

        try {
          saved = await readPrivateJson(order.id);
        } catch {
          saved = null;
        }

        const shopifyCustomerName = getShopifyCustomerName(order);
        const shopifyCustomerEmail = getShopifyCustomerEmail(order);
        const shopifyCustomerPhone = getShopifyCustomerPhone(order);
        const shopifyPreparedFor = getPreparedFor(order);

        return {
          id: order.id,
          name: order.name,
          order_number: order.order_number,
          created_at: order.created_at,
          financial_status: clean(order.financial_status),
          fulfillment_status: clean(order.fulfillment_status || "unfulfilled"),
          total_price: clean(order.total_price),
          currency: clean(order.currency),
          tags: clean(order.tags),
          note: clean(order.note),

          displayFinancialStatus: clean(order.financial_status),
          displayFulfillmentStatus: clean(order.fulfillment_status || "unfulfilled"),

          shopify_customer_name: shopifyCustomerName,
          shopify_customer_email: shopifyCustomerEmail,
          shopify_customer_phone: shopifyCustomerPhone,

          custom_customer_name: clean(saved?.custom_customer_name),
          custom_customer_email: clean(saved?.custom_customer_email),
          custom_customer_phone: clean(saved?.custom_customer_phone),

          customer_name:
            clean(saved?.custom_customer_name) || shopifyCustomerName,
          customer_email:
            clean(saved?.custom_customer_email) || shopifyCustomerEmail,
          customer_phone:
            clean(saved?.custom_customer_phone) || shopifyCustomerPhone,

          prepared_for:
            clean(saved?.prepared_for) || shopifyPreparedFor,

          school: clean(saved?.school),
          sent_with: clean(saved?.sent_with),
          delivery_notes: clean(saved?.delivery_notes),
          staff_notes: clean(saved?.staff_notes),
          production_notes: clean(saved?.production_notes),

          internal_order_status: clean(saved?.internal_order_status),
          internal_payment_status: clean(saved?.internal_payment_status),

          client_contacts: [],
          organizations: [],

          item_count: Array.isArray(order.line_items) ? order.line_items.length : 0,
          line_items: (order.line_items || []).map((item) => ({
            id: item.id,
            name: clean(item.name || item.title),
            title: clean(item.title),
            variant_title: clean(item.variant_title),
            sku: clean(item.sku),
            quantity: item.quantity || 0,
            vendor: clean(item.vendor),
            price: clean(item.price)
          }))
        };
      })
    );

    return res.status(200).json({ orders });
  } catch (error) {
    return res.status(500).json({
      error: "Server error",
      details: error.message
    });
  }
}
