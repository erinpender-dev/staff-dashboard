async function shopifyFetch(url, token, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "X-Shopify-Access-Token": token,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      typeof data?.errors === "string"
        ? data.errors
        : data?.error || JSON.stringify(data?.errors || data || {})
    );
  }

  return data;
}

async function shopifyGraphQL(shop, token, query, variables = {}) {
  const response = await fetch(`https://${shop}/admin/api/2025-10/graphql.json`, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": token,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ query, variables })
  });

  const data = await response.json();

  if (!response.ok || data.errors) {
    throw new Error(
      JSON.stringify(data.errors || data || { error: "GraphQL request failed" })
    );
  }

  return data.data;
}

function getManualPlaceholderConfig(schoolTag) {
  switch (String(schoolTag || "").toLowerCase()) {
    case "sta":
      return {
        name: "STA Manual Order",
        email: "sta-manual-order@bkreativeworks.local"
      };
    case "sjs":
      return {
        name: "SJS Manual Order",
        email: "sjs-manual-order@bkreativeworks.local"
      };
    case "slu":
      return {
        name: "SLU Manual Order",
        email: "slu-manual-order@bkreativeworks.local"
      };
    case "rts":
      return {
        name: "RTS Manual Order",
        email: "rts-manual-order@bkreativeworks.local"
      };
    default:
      return {
        name: "Misc Manual Order",
        email: "misc-manual-order@bkreativeworks.local"
      };
  }
}

async function findOrCreatePlaceholderCustomer(shop, token, schoolTag) {
  const placeholder = getManualPlaceholderConfig(schoolTag);

  const searchUrl = `https://${shop}/admin/api/2025-10/customers/search.json?query=${encodeURIComponent(
    `email:${placeholder.email}`
  )}`;

  const searchData = await shopifyFetch(searchUrl, token);

  if (Array.isArray(searchData.customers) && searchData.customers.length) {
    return searchData.customers[0];
  }

  const [firstName, ...rest] = placeholder.name.split(" ");
  const lastName = rest.join(" ");

  const createUrl = `https://${shop}/admin/api/2025-10/customers.json`;
  const createData = await shopifyFetch(createUrl, token, {
    method: "POST",
    body: JSON.stringify({
      customer: {
        first_name: firstName,
        last_name: lastName,
        email: placeholder.email,
        phone: "",
        tags: "manual-placeholder,bkreative-manual"
      }
    })
  });

  return createData.customer;
}

function toNoteAttributesObject(noteAttributes) {
  if (!Array.isArray(noteAttributes)) return {};
  return Object.fromEntries(
    noteAttributes.map((item) => [item.name, item.value])
  );
}

function toNoteAttributesArray(obj) {
  return Object.entries(obj).map(([name, value]) => ({
    name,
    value: value == null ? "" : String(value)
  }));
}

function splitName(fullName) {
  const clean = String(fullName || "").trim();
  if (!clean) {
    return { first_name: "", last_name: "" };
  }
  const parts = clean.split(/\s+/);
  if (parts.length === 1) {
    return { first_name: parts[0], last_name: "" };
  }
  return {
    first_name: parts.shift(),
    last_name: parts.join(" ")
  };
}

function normalizeTags(tags) {
  if (Array.isArray(tags)) {
    return tags.map((t) => String(t).trim()).filter(Boolean);
  }

  return String(tags || "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

function noteAttributesToObject(customAttributes) {
  if (!Array.isArray(customAttributes)) return {};
  return Object.fromEntries(
    customAttributes.map((item) => [item.key, item.value])
  );
}

function normalizeOrderNode(node) {
  const noteAttributes = noteAttributesToObject(node.customAttributes || []);
  const tags = Array.isArray(node.tags) ? node.tags : [];
  const shippingLineTitle = node.shippingLine?.title || "";
  const deliveryMethod = shippingLineTitle.toLowerCase().includes("pickup") ? "pickup" : "ship";
  const displayFulfillmentStatus = String(node.displayFulfillmentStatus || "").toUpperCase();

  let pickupStatus = String(noteAttributes.pickup_status || "").toLowerCase();

  if (displayFulfillmentStatus === "READY_FOR_PICKUP") {
    pickupStatus = "ready_for_pickup";
  } else if (displayFulfillmentStatus === "FULFILLED") {
    pickupStatus = pickupStatus || "picked_up";
  } else if (!pickupStatus) {
    pickupStatus = "not_ready";
  }

  let fulfillmentStatus = "unfulfilled";
  if (displayFulfillmentStatus === "FULFILLED") {
    fulfillmentStatus = "fulfilled";
  } else if (displayFulfillmentStatus === "PARTIALLY_FULFILLED") {
    fulfillmentStatus = "partial";
  }

  const customerName =
    node.customer?.displayName ||
    noteAttributes.display_customer_name ||
    node.email ||
    "No customer";

  const email =
    noteAttributes.display_customer_email ||
    node.email ||
    "";

  const phone =
    noteAttributes.display_customer_phone ||
    node.customer?.phone ||
    node.phone ||
    "";

  return {
    id: String(node.legacyResourceId),
    admin_graphql_api_id: node.id,
    name: node.name,
    created_at: node.createdAt,
    updated_at: node.updatedAt,
    source_name: node.sourceName === "shopify_draft_order" ? "shopify_draft_order" : "web",
    financial_status: String(node.displayFinancialStatus || "").toLowerCase(),
    fulfillment_status: fulfillmentStatus,
    display_fulfillment_status: displayFulfillmentStatus,
    total_price: node.currentTotalPriceSet?.shopMoney?.amount || "0.00",
    current_total_price: node.currentTotalPriceSet?.shopMoney?.amount || "0.00",
    currency: node.currentTotalPriceSet?.shopMoney?.currencyCode || "USD",
    email,
    phone,
    tags,
    customer: {
      first_name: customerName,
      last_name: "",
      phone
    },
    line_items: (node.lineItems?.edges || []).map(({ node: item }) => ({
      id: String(item.id),
      title: item.title,
      quantity: item.quantity,
      sku: item.sku || "",
      variant_title: item.variantTitle || ""
    })),
    shipping_lines: shippingLineTitle
      ? [{ title: shippingLineTitle, code: shippingLineTitle }]
      : [],
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
    }
  };
}

async function getOrderById(shop, token, orderId) {
  const query = `
    query GetOrder($id: ID!) {
      order(id: $id) {
        id
        legacyResourceId
        name
        createdAt
        updatedAt
        sourceName
        email
        phone
        tags
        displayFinancialStatus
        displayFulfillmentStatus
        customAttributes {
          key
          value
        }
        customer {
          id
          displayName
          phone
        }
        shippingLine {
          title
        }
        currentTotalPriceSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        lineItems(first: 50) {
          edges {
            node {
              id
              title
              quantity
              sku
              variantTitle
            }
          }
        }
      }
    }
  `;

  const gid = `gid://shopify/Order/${orderId}`;
  const data = await shopifyGraphQL(shop, token, query, { id: gid });
  if (!data.order) {
    throw new Error("Order not found");
  }
  return normalizeOrderNode(data.order);
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PUT, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
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
    if (req.method === "GET") {
      const order = await getOrderById(shop, token, orderId);
      return res.status(200).json({ order });
    }

    if (req.method !== "PUT") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};

    const sourceType = String(body.source_type || "web").toLowerCase();
    const tags = normalizeTags(body.tags);
    const metafields = body.metafields || {};
    const schoolTag = String(metafields.school_tag || "misc").toLowerCase();

    const existingRestUrl = `https://${shop}/admin/api/2025-10/orders/${orderId}.json?status=any`;
    const existingData = await shopifyFetch(existingRestUrl, token);
    const existingOrder = existingData.order;

    const existingNoteAttributes = toNoteAttributesObject(existingOrder.note_attributes);

    const mergedNoteAttributes = {
      ...existingNoteAttributes,
      school_tag: schoolTag,
      student_info: String(metafields.student_info || ""),
      internal_notes: String(metafields.internal_notes || ""),
      sent_with: String(metafields.sent_with || ""),
      delivery_location: String(metafields.delivery_location || ""),
      delivery_complete: String(metafields.delivery_complete || "false"),
      pickup_status: String(metafields.pickup_status || existingNoteAttributes.pickup_status || "not_ready")
    };

    const updatePayload = {
      order: {
        id: Number(orderId),
        tags: tags.join(", "),
        note_attributes: toNoteAttributesArray(mergedNoteAttributes)
      }
    };

    if (sourceType === "manual") {
      const manualCustomer = body.manual_customer || {};
      const placeholderCustomer = await findOrCreatePlaceholderCustomer(shop, token, schoolTag);

      mergedNoteAttributes.display_customer_name = String(manualCustomer.display_customer_name || "");
      mergedNoteAttributes.display_customer_email = String(manualCustomer.display_customer_email || "");
      mergedNoteAttributes.display_customer_phone = String(manualCustomer.display_customer_phone || "");

      updatePayload.order.note_attributes = toNoteAttributesArray(mergedNoteAttributes);
      updatePayload.order.customer = { id: placeholderCustomer.id };
      updatePayload.order.email =
        String(manualCustomer.display_customer_email || "").trim() ||
        getManualPlaceholderConfig(schoolTag).email;
      updatePayload.order.phone = String(manualCustomer.display_customer_phone || "").trim() || "";
    } else {
      const webCustomer = body.web_customer || {};
      const nameParts = splitName(
        webCustomer.customer_name ||
          `${existingOrder.customer?.first_name || ""} ${existingOrder.customer?.last_name || ""}`.trim()
      );

      if (existingOrder.customer?.id) {
        const customerUpdateUrl = `https://${shop}/admin/api/2025-10/customers/${existingOrder.customer.id}.json`;
        await shopifyFetch(customerUpdateUrl, token, {
          method: "PUT",
          body: JSON.stringify({
            customer: {
              id: existingOrder.customer.id,
              first_name: webCustomer.first_name || nameParts.first_name || existingOrder.customer.first_name || "",
              last_name: webCustomer.last_name || nameParts.last_name || existingOrder.customer.last_name || "",
              email: webCustomer.customer_email || existingOrder.customer.email || existingOrder.email || "",
              phone: webCustomer.customer_phone || existingOrder.customer.phone || existingOrder.phone || ""
            }
          })
        });
      }

      if (typeof webCustomer.customer_email === "string") {
        updatePayload.order.email = webCustomer.customer_email;
      }

      if (typeof webCustomer.customer_phone === "string") {
        updatePayload.order.phone = webCustomer.customer_phone;
      }
    }

    const updateUrl = `https://${shop}/admin/api/2025-10/orders/${orderId}.json`;
    await shopifyFetch(updateUrl, token, {
      method: "PUT",
      body: JSON.stringify(updatePayload)
    });

    if (body.fulfillment_status === "fulfilled") {
      const fulfillmentOrdersUrl = `https://${shop}/admin/api/2025-10/orders/${orderId}/fulfillment_orders.json`;
      const fulfillmentOrdersData = await shopifyFetch(fulfillmentOrdersUrl, token);

      const openFulfillmentOrders = Array.isArray(fulfillmentOrdersData.fulfillment_orders)
        ? fulfillmentOrdersData.fulfillment_orders.filter((fo) =>
            ["open", "in_progress", "scheduled"].includes(String(fo.status || "").toLowerCase())
          )
        : [];

      for (const fo of openFulfillmentOrders) {
        const lineItems = Array.isArray(fo.line_items)
          ? fo.line_items.map((item) => ({
              id: item.id,
              quantity: item.quantity
            }))
          : [];

        if (!lineItems.length) continue;

        const createFulfillmentUrl = `https://${shop}/admin/api/2025-10/fulfillments.json`;
        await shopifyFetch(createFulfillmentUrl, token, {
          method: "POST",
          body: JSON.stringify({
            fulfillment: {
              line_items_by_fulfillment_order: [
                {
                  fulfillment_order_id: fo.id,
                  fulfillment_order_line_items: lineItems
                }
              ],
              notify_customer: false
            }
          })
        });
      }
    }

    const order = await getOrderById(shop, token, orderId);
    return res.status(200).json({
      ok: true,
      order
    });
  } catch (error) {
    return res.status(500).json({
      error: error.message || "Could not update order"
    });
  }
}
