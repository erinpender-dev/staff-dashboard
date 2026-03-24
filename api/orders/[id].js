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

function normalizeOrder(order) {
  const noteAttributes = toNoteAttributesObject(order.note_attributes);
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

  return {
    ...order,
    tags,
    delivery_method: hasLocalPickup ? "pickup" : "ship",
    pickup_status:
      noteAttributes.bk_pickup_status ||
      noteAttributes.pickup_status ||
      "",
    metafields: {
      school_tag: noteAttributes.school_tag || "",
      student_info: noteAttributes.student_info || "",
      internal_notes: noteAttributes.internal_notes || "",
      sent_with: noteAttributes.sent_with || "",
      delivery_location: noteAttributes.delivery_location || "",
      delivery_complete: noteAttributes.delivery_complete || "false",
      pickup_status:
        noteAttributes.bk_pickup_status ||
        noteAttributes.pickup_status ||
        "",
      display_customer_name: noteAttributes.display_customer_name || "",
      display_customer_email: noteAttributes.display_customer_email || "",
      display_customer_phone: noteAttributes.display_customer_phone || ""
    },
    normalized_note_attributes: noteAttributes
  };
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
      const getUrl = `https://${shop}/admin/api/2025-10/orders/${orderId}.json?status=any`;
      const data = await shopifyFetch(getUrl, token);
      return res.status(200).json({
        order: normalizeOrder(data.order)
      });
    }

    if (req.method !== "PUT") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};

    const sourceType = String(body.source_type || "web").toLowerCase();
    const tags = normalizeTags(body.tags);
    const metafields = body.metafields || {};
    const schoolTag = String(metafields.school_tag || "misc").toLowerCase();

    const getUrl = `https://${shop}/admin/api/2025-10/orders/${orderId}.json?status=any`;
    const existingData = await shopifyFetch(getUrl, token);
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

    if (typeof body.financial_status === "string" && body.financial_status.trim()) {
      updatePayload.order.financial_status = body.financial_status.trim();
    }

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
    const updatedData = await shopifyFetch(updateUrl, token, {
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

    const freshData = await shopifyFetch(getUrl, token);
    return res.status(200).json({
      ok: true,
      order: normalizeOrder(freshData.order)
    });
  } catch (error) {
    return res.status(500).json({
      error: error.message || "Could not update order"
    });
  }
}
