async function shopifyGraphQL(shop, token, query, variables = {}) {
  const response = await fetch(`https://${shop}/admin/api/2025-10/graphql.json`, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": token,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ query, variables })
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok || data.errors) {
    throw new Error(JSON.stringify(data.errors || data || {}));
  }

  return data.data;
}

function mapDisplayFulfillmentStatus(displayStatus, fallbackFulfillmentStatus, currentPickupStatus) {
  const normalized = String(displayStatus || "").toUpperCase();

  if (normalized === "READY_FOR_PICKUP") {
    return {
      fulfillment_status: "unfulfilled",
      pickup_status: "ready_for_pickup",
      display_fulfillment_status: normalized
    };
  }

  if (normalized === "FULFILLED") {
    return {
      fulfillment_status: "fulfilled",
      pickup_status: currentPickupStatus || "picked_up",
      display_fulfillment_status: normalized
    };
  }

  if (normalized === "PARTIALLY_FULFILLED") {
    return {
      fulfillment_status: "partial",
      pickup_status: currentPickupStatus || "not_ready",
      display_fulfillment_status: normalized
    };
  }

  return {
    fulfillment_status: fallbackFulfillmentStatus,
    pickup_status: currentPickupStatus || "not_ready",
    display_fulfillment_status: normalized || ""
  };
}

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

    if (fulfillmentStatus && fulfillmentStatus !== "needs_fulfillment") {
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

    let orders = Array.isArray(data.orders) ? data.orders.map(normalizeOrder) : [];

    // Safe GraphQL overlay for Shopify display fulfillment status
    try {
      const gqlQuery = `
        query GetOrderStatuses($first: Int!) {
          orders(first: $first, reverse: true, sortKey: CREATED_AT) {
            edges {
              node {
                legacyResourceId
                displayFulfillmentStatus
              }
            }
          }
        }
      `;

      const gqlData = await shopifyGraphQL(shop, token, gqlQuery, {
        first: Math.min(Number(limit || 100), 100)
      });

      const statusMap = new Map(
        (gqlData?.orders?.edges || []).map((edge) => [
          String(edge.node.legacyResourceId),
          String(edge.node.displayFulfillmentStatus || "")
        ])
      );

      orders = orders.map((order) => {
        const displayStatus = statusMap.get(String(order.id)) || "";
        const mapped = mapDisplayFulfillmentStatus(
          displayStatus,
          String(order.fulfillment_status || "").toLowerCase(),
          String(order.pickup_status || "").toLowerCase()
        );

        return {
          ...order,
          fulfillment_status: mapped.fulfillment_status,
          pickup_status: mapped.pickup_status,
          display_fulfillment_status: mapped.display_fulfillment_status,
          metafields: {
            ...(order.metafields || {}),
            pickup_status: mapped.pickup_status
          }
        };
      });
    } catch (overlayError) {
      console.error("GraphQL status overlay failed:", overlayError.message);
    }

    if (fulfillmentStatus === "needs_fulfillment") {
      orders = orders.filter((order) => String(order.fulfillment_status || "").toLowerCase() !== "fulfilled");
    }

    return res.status(200).json({ orders });
  } catch (error) {
    return res.status(500).json({
      error: error.message || "Unexpected server error"
    });
  }
}

function normalizeOrder(order) {
  const noteAttributes = Array.isArray(order.note_attributes)
    ? Object.fromEntries(order.note_attributes.map((item) => [item.name, item.value]))
    : {};

  const tags = Array.isArray(order.tags)
    ? order.tags
    : String(order.tags || "")
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);

  const shippingLines = Array.isArray(order.shipping_lines) ? order.shipping_lines : [];
  const shippingTitle = shippingLines.map((line) => String(line?.title || "")).join(" ").toLowerCase();
  const shippingCode = shippingLines.map((line) => String(line?.code || "")).join(" ").toLowerCase();

  const hasLocalPickup =
    shippingTitle.includes("pickup") ||
    shippingCode.includes("pickup") ||
    shippingTitle.includes("store") ||
    shippingCode.includes("store");

  const deliveryMethod = hasLocalPickup ? "pickup" : "ship";

  let pickupStatus = String(
    noteAttributes.bk_pickup_status ||
    noteAttributes.pickup_status ||
    ""
  ).toLowerCase();

  if (!pickupStatus) {
    if (String(order.fulfillment_status || "").toLowerCase() === "fulfilled") {
      pickupStatus = "picked_up";
    } else {
      pickupStatus = "not_ready";
    }
  }

  return {
    ...order,
    tags,
    delivery_method: deliveryMethod,
    pickup_status: pickupStatus,
    display_fulfillment_status: "",
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
