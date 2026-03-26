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

function parseJsonSafe(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  if (Array.isArray(value) || typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch (error) {
    return fallback;
  }
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

  if (response.status === 404) return null;

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Blob read failed: ${text}`);
  }

  return await response.json();
}

function getPreparedForFromShopify(order) {
  const attrs = Array.isArray(order.note_attributes) ? order.note_attributes : [];
  const found = attrs.find((attr) => {
    const name = clean(attr?.name).toLowerCase();
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
    const fullName = [order.customer.first_name, order.customer.last_name]
      .filter(Boolean)
      .join(" ");
    if (clean(fullName)) return clean(fullName);
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

function normalizeContactsFromAny(value) {
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

function getSavedContacts(saved) {
  const possibleSources = [
    saved?.client_contacts,
    saved?.contact_cards,
    saved?.contacts,
    saved?.custom_contacts,
    saved?.metafield_contacts,
    saved?.dashboard_contacts,
    saved?.order_contacts
  ];

  for (const source of possibleSources) {
    const contacts = normalizeContactsFromAny(source);
    if (contacts.length) return contacts;
  }

  return [];
}

function getOrganizations(saved, contacts) {
  const parsedSaved = parseJsonSafe(saved?.organizations, saved?.organizations);

  if (Array.isArray(parsedSaved) && parsedSaved.length) {
    return parsedSaved.map((value) => clean(value)).filter(Boolean);
  }

  if (typeof parsedSaved === "string" && clean(parsedSaved)) {
    return [clean(parsedSaved)];
  }

  const fromContacts = contacts
    .map((contact) => clean(contact.organization))
    .filter(Boolean);

  return [...new Set(fromContacts)];
}

function getReference(saved) {
  return clean(
    saved?.reference ||
    saved?.job_reference ||
    saved?.project_reference ||
    ""
  );
}

function getPartialPayments(saved) {
  const parsed = parseJsonSafe(saved?.partial_payments, []);
  if (!Array.isArray(parsed)) return [];

  return parsed
    .map((payment) => ({
      type: clean(payment?.type),
      amount: clean(payment?.amount),
      check_number: clean(payment?.check_number)
    }))
    .filter((payment) => payment.type || payment.amount || payment.check_number);
}

function computeInternalOrderStatus(saved, order) {
  const rawSaved = clean(saved?.internal_order_status);
  const shopifyFulfillment = clean(order.fulfillment_status || "unfulfilled").toLowerCase();

  if (shopifyFulfillment === "fulfilled") {
    return "order complete";
  }

  return rawSaved || "";
}

function computeInternalPaymentStatus(saved, order) {
  const rawSaved = clean(saved?.internal_payment_status).toLowerCase();
  const shopifyFinancial = clean(order.financial_status).toLowerCase();

  if (shopifyFinancial === "paid") {
    if (rawSaved === "partial payment") {
      return "partial payment";
    }
    return "payment received";
  }

  return rawSaved || "";
}

function hasPaymentDetails(saved) {
  const paymentType = clean(saved?.payment_received_type);
  const paymentAmount = clean(saved?.payment_received_amount);
  const partialPayments = getPartialPayments(saved);

  return Boolean(
    paymentType ||
    paymentAmount ||
    partialPayments.length
  );
}

function getManualOrderFlag(order) {
  const sourceName = clean(order.source_name).toLowerCase();
  return sourceName === "shopify_draft_order" || sourceName === "manual";
}

function getOrderTags(order) {
  const tags = clean(order.tags);
  if (!tags) return [];
  return tags
    .split(",")
    .map((tag) => clean(tag))
    .filter(Boolean);
}

function buildSearchText(order) {
  return [
    order.order_number,
    order.name,
    order.custom_customer_name,
    order.custom_customer_email,
    order.custom_customer_phone,
    order.prepared_for,
    order.reference,
    order.shopify_customer_name,
    order.shopify_customer_email,
    order.shopify_customer_phone,
    ...(order.organizations || []),
    ...(order.tags || [])
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function mapOrder(order, saved = {}) {
  const contacts = getSavedContacts(saved);
  const organizations = getOrganizations(saved, contacts);
  const internalOrderStatus = computeInternalOrderStatus(saved, order);
  const internalPaymentStatus = computeInternalPaymentStatus(saved, order);
  const paymentDetailsMissing = clean(order.financial_status).toLowerCase() === "paid" && !hasPaymentDetails(saved);

  const mapped = {
    id: order.id,
    admin_graphql_api_id: order.admin_graphql_api_id,
    order_number: order.order_number,
    name: clean(order.name),
    created_at: order.created_at,
    processed_at: order.processed_at,
    updated_at: order.updated_at,

    currency: clean(order.currency),
    total_price: clean(order.total_price),
    subtotal_price: clean(order.subtotal_price),
    total_tax: clean(order.total_tax),
    total_discounts: clean(order.total_discounts),

    financial_status: clean(order.financial_status).toLowerCase(),
    fulfillment_status: clean(order.fulfillment_status || "unfulfilled").toLowerCase(),
    cancel_reason: clean(order.cancel_reason),
    cancelled_at: clean(order.cancelled_at),

    source_name: clean(order.source_name),
    browser_ip: clean(order.browser_ip),
    gateway: clean(order.gateway),
    note: clean(order.note),

    tags: getOrderTags(order),
    manual_order: getManualOrderFlag(order),

    line_items: Array.isArray(order.line_items)
      ? order.line_items.map((item) => ({
          id: item.id,
          variant_id: item.variant_id,
          product_id: item.product_id,
          sku: clean(item.sku),
          title: clean(item.title),
          variant_title: clean(item.variant_title),
          vendor: clean(item.vendor),
          quantity: Number(item.quantity || 0),
          price: clean(item.price),
          fulfillable_quantity: Number(item.fulfillable_quantity || 0),
          fulfillment_status: clean(item.fulfillment_status)
        }))
      : [],

    shipping_address: order.shipping_address || null,
    billing_address: order.billing_address || null,
    shipping_lines: Array.isArray(order.shipping_lines) ? order.shipping_lines : [],
    note_attributes: Array.isArray(order.note_attributes) ? order.note_attributes : [],

    shopify_customer_name: getShopifyCustomerName(order),
    shopify_customer_email: getShopifyCustomerEmail(order),
    shopify_customer_phone: getShopifyCustomerPhone(order),

    custom_customer_name: clean(saved.custom_customer_name) || getShopifyCustomerName(order),
    custom_customer_email: clean(saved.custom_customer_email) || getShopifyCustomerEmail(order),
    custom_customer_phone: clean(saved.custom_customer_phone) || getShopifyCustomerPhone(order),

    prepared_for: clean(saved.prepared_for) || getPreparedForFromShopify(order),
    reference: getReference(saved),
    school: clean(saved.school),
    sent_with: clean(saved.sent_with),

    delivery_notes: clean(saved.delivery_notes),
    staff_notes: clean(saved.staff_notes),
    production_notes: clean(saved.production_notes),

    internal_order_status: internalOrderStatus,
    internal_payment_status: internalPaymentStatus,

    payment_received_type: clean(saved.payment_received_type),
    payment_received_amount: clean(saved.payment_received_amount),
    payment_received_check_number: clean(saved.payment_received_check_number),
    partial_payments: getPartialPayments(saved),
    payment_details_missing: paymentDetailsMissing,

    contacts,
    organizations,

    _search: ""
  };

  mapped._search = buildSearchText(mapped);
  return mapped;
}

async function fetchOrdersFromShopify({ shop, token, status = "any", limit = 100, financialStatus = "", fulfillmentStatus = "" }) {
  const params = new URLSearchParams();
  params.set("status", status || "any");
  params.set("limit", String(limit || 100));

  if (financialStatus) params.set("financial_status", financialStatus);
  if (fulfillmentStatus) params.set("fulfillment_status", fulfillmentStatus);

  const response = await fetch(`https://${shop}/admin/api/2025-10/orders.json?${params.toString()}`, {
    headers: {
      "X-Shopify-Access-Token": token,
      "Content-Type": "application/json"
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Shopify orders fetch failed: ${text}`);
  }

  const data = await response.json();
  return Array.isArray(data.orders) ? data.orders : [];
}

export default async function handler(req, res) {
  setCors(req, res);

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const shop = process.env.SHOPIFY_STORE;
    const token = process.env.SHOPIFY_ACCESS_TOKEN;

    if (!shop || !token) {
      res.status(500).json({ error: "Missing SHOPIFY_STORE or SHOPIFY_ACCESS_TOKEN" });
      return;
    }

    const status = clean(req.query.status || "any");
    const limit = Number(req.query.limit || 100);
    const financialStatus = clean(req.query.financial_status || "");
    const fulfillmentStatus = clean(req.query.fulfillment_status || "");

    const orders = await fetchOrdersFromShopify({
      shop,
      token,
      status,
      limit,
      financialStatus,
      fulfillmentStatus
    });

    const mappedOrders = await Promise.all(
      orders.map(async (order) => {
        let saved = null;
        try {
          saved = await readPrivateJson(order.id);
        } catch (error) {
          saved = null;
        }
        return mapOrder(order, saved || {});
      })
    );

    mappedOrders.sort((a, b) => {
      const aTime = new Date(a.created_at).getTime();
      const bTime = new Date(b.created_at).getTime();
      return bTime - aTime;
    });

    const stats = {
      total: mappedOrders.length,
      paid: mappedOrders.filter((order) => order.financial_status === "paid").length,
      unpaid: mappedOrders.filter((order) => order.financial_status !== "paid").length,
      fulfilled: mappedOrders.filter((order) => order.fulfillment_status === "fulfilled").length,
      unfulfilled: mappedOrders.filter((order) => order.fulfillment_status !== "fulfilled").length,
      payment_details_missing: mappedOrders.filter((order) => order.payment_details_missing).length,
      manual: mappedOrders.filter((order) => order.manual_order).length,
      web: mappedOrders.filter((order) => !order.manual_order).length
    };

    res.status(200).json({
      ok: true,
      stats,
      orders: mappedOrders
    });
  } catch (error) {
    res.status(500).json({
      error: error.message || "Could not load orders."
    });
  }
}
