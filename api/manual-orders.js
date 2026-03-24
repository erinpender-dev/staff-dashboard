async function shopifyFetch(path, token, options = {}) {
  const response = await fetch(path, {
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

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
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
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};

    const schoolTag = String(body.school_tag || "misc").toLowerCase();
    const lineItems = Array.isArray(body.line_items) ? body.line_items : [];
    const manualCustomer = body.manual_customer || {};
    const internal = body.internal || {};

    if (!lineItems.length) {
      return res.status(400).json({ error: "At least one line item is required." });
    }

    const placeholderCustomer = await findOrCreatePlaceholderCustomer(shop, token, schoolTag);

    const tags = Array.from(
      new Set(
        [
          "manual",
          schoolTag,
          ...(Array.isArray(internal.tags) ? internal.tags : [])
        ]
          .map((t) => String(t || "").trim())
          .filter(Boolean)
      )
    );

    const noteAttributes = [
      { name: "school_tag", value: schoolTag },
      { name: "display_customer_name", value: String(manualCustomer.display_customer_name || "") },
      { name: "display_customer_email", value: String(manualCustomer.display_customer_email || "") },
      { name: "display_customer_phone", value: String(manualCustomer.display_customer_phone || "") },
      { name: "student_info", value: String(manualCustomer.student_info || "") },
      { name: "internal_notes", value: String(internal.internal_notes || "") },
      { name: "sent_with", value: String(internal.sent_with || "") },
      { name: "delivery_location", value: String(internal.delivery_location || "") },
      { name: "delivery_complete", value: String(internal.delivery_complete || "false") },
      { name: "pickup_status", value: String(internal.pickup_status || "not_ready") }
    ];

    const orderPayload = {
      order: {
        send_receipt: false,
        send_fulfillment_receipt: false,
        customer: {
          id: placeholderCustomer.id
        },
        email:
          String(manualCustomer.display_customer_email || "").trim() ||
          getManualPlaceholderConfig(schoolTag).email,
        phone: String(manualCustomer.display_customer_phone || "").trim() || "",
        tags: tags.join(", "),
        note:
          String(manualCustomer.student_info || "").trim() ||
          String(internal.internal_notes || "").trim() ||
          "",
        note_attributes: noteAttributes,
        line_items: lineItems.map((item) => ({
          variant_id: Number(item.variant_id),
          quantity: Number(item.quantity || 1)
        })),
        shipping_lines: [
          {
            title: "Local Pickup",
            code: "local_pickup",
            price: "0.00"
          }
        ]
      }
    };

    const createUrl = `https://${shop}/admin/api/2025-10/orders.json`;
    const createData = await shopifyFetch(createUrl, token, {
      method: "POST",
      body: JSON.stringify(orderPayload)
    });

    return res.status(200).json({
      ok: true,
      order: createData.order
    });
  } catch (error) {
    return res.status(500).json({
      error: error.message || "Could not create manual order"
    });
  }
}
