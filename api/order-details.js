import { put } from "@vercel/blob";

function setCors(req, res) {
  const allowedOrigin = process.env.ALLOWED_ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
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

function normalizeContacts(value) {
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

function normalizePartialPayments(value) {
  const parsed = parseJsonSafe(value, value);
  if (!Array.isArray(parsed)) return [];

  return parsed
    .map((payment) => ({
      type: clean(payment?.type),
      amount: clean(payment?.amount),
      check_number: clean(payment?.check_number)
    }))
    .filter((payment) => payment.type || payment.amount || payment.check_number);
}

function normalize(body = {}) {
  return {
    custom_customer_name: clean(body.custom_customer_name),
    custom_customer_email: clean(body.custom_customer_email),
    custom_customer_phone: clean(body.custom_customer_phone),

    prepared_for: clean(body.prepared_for),
    reference: clean(body.reference),
    school: clean(body.school),
    sent_with: clean(body.sent_with),

    delivery_notes: clean(body.delivery_notes),
    staff_notes: clean(body.staff_notes),
    production_notes: clean(body.production_notes),

    internal_order_status: clean(body.internal_order_status).toLowerCase(),
    internal_payment_status: clean(body.internal_payment_status).toLowerCase(),

    payment_received_type: clean(body.payment_received_type),
    payment_received_amount: clean(body.payment_received_amount),
    payment_received_check_number: clean(body.payment_received_check_number),

    partial_payments: normalizePartialPayments(body.partial_payments),

    client_contacts: normalizeContacts(body.client_contacts),
    contact_cards: normalizeContacts(body.contact_cards),
    contacts: normalizeContacts(body.contacts),
    custom_contacts: normalizeContacts(body.custom_contacts),
    metafield_contacts: normalizeContacts(body.metafield_contacts),
    dashboard_contacts: normalizeContacts(body.dashboard_contacts),
    order_contacts: normalizeContacts(body.order_contacts),

    organizations: Array.isArray(body.organizations)
      ? body.organizations.map((value) => clean(value)).filter(Boolean)
      : [],

    updated_at: new Date().toISOString()
  };
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

async function shopifyGraphQL(shop, token, query, variables = {}) {
  const response = await fetch(`https://${shop}/admin/api/2025-10/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token
    },
    body: JSON.stringify({ query, variables })
  });

  const json = await response.json();

  if (!response.ok) {
    throw new Error(json?.errors?.[0]?.message || "Shopify GraphQL request failed.");
  }

  if (json.errors?.length) {
    throw new Error(json.errors[0].message || "Shopify GraphQL returned errors.");
  }

  return json.data;
}

async function getOrderById(shop, token, orderId) {
  const response = await fetch(`https://${shop}/admin/api/2025-10/orders/${orderId}.json`, {
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Could not load Shopify order: ${text}`);
  }

  const json = await response.json();
  return json.order;
}

async function markOrderPaid(shop, token, orderId) {
  const response = await fetch(`https://${shop}/admin/api/2025-10/orders/${orderId}/transactions.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token
    },
    body: JSON.stringify({
      transaction: {
        kind: "capture",
        status: "success",
        gateway: "manual",
        amount: undefined,
        currency: undefined
      }
    })
  });

  if (response.ok) {
    return { ok: true, method: "transactions" };
  }

  const transactionError = await response.text();

  const mutation = `
    mutation OrderMarkAsPaid($input: OrderMarkAsPaidInput!) {
      orderMarkAsPaid(input: $input) {
        order {
          id
          displayFinancialStatus
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const data = await shopifyGraphQL(shop, token, mutation, {
    input: {
      id: `gid://shopify/Order/${orderId}`
    }
  });

  const userErrors = data?.orderMarkAsPaid?.userErrors || [];
  if (userErrors.length) {
    throw new Error(userErrors.map((e) => e.message).join(" | ") || transactionError || "Could not mark order paid.");
  }

  return { ok: true, method: "graphql" };
}

async function fulfillOrder(shop, token, shopifyOrder) {
  const query = `
    query FulfillmentOrders($id: ID!) {
      order(id: $id) {
        id
        fulfillmentOrders(first: 20) {
          edges {
            node {
              id
              status
              lineItems(first: 100) {
                edges {
                  node {
                    id
                    remainingQuantity
                    lineItem {
                      id
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  const data = await shopifyGraphQL(shop, token, query, {
    id: shopifyOrder.admin_graphql_api_id
  });

  const edges = data?.order?.fulfillmentOrders?.edges || [];
  if (!edges.length) {
    return { skipped: true, reason: "No fulfillment orders found." };
  }

  const lineItemsByFulfillmentOrder = edges
    .map((edge) => edge.node)
    .filter((fulfillmentOrder) => fulfillmentOrder.status !== "CLOSED")
    .map((fulfillmentOrder) => {
      const fulfillmentOrderLineItems = (fulfillmentOrder.lineItems?.edges || [])
        .map((edge) => edge.node)
        .filter((node) => Number(node.remainingQuantity || 0) > 0)
        .map((node) => ({
          id: node.id,
          quantity: Number(node.remainingQuantity || 0)
        }));

      if (!fulfillmentOrderLineItems.length) return null;

      return {
        fulfillmentOrderId: fulfillmentOrder.id,
        fulfillmentOrderLineItems
      };
    })
    .filter(Boolean);

  if (!lineItemsByFulfillmentOrder.length) {
    return { skipped: true, reason: "Nothing left to fulfill." };
  }

  const mutation = `
    mutation CreateFulfillment($fulfillment: FulfillmentInput!) {
      fulfillmentCreateV2(fulfillment: $fulfillment) {
        fulfillment {
          id
          status
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const fulfillment = {
    lineItemsByFulfillmentOrder,
    notifyCustomer: false
  };

  const created = await shopifyGraphQL(shop, token, mutation, { fulfillment });
  const userErrors = created?.fulfillmentCreateV2?.userErrors || [];
  if (userErrors.length) {
    throw new Error(userErrors.map((e) => e.message).join(" | ") || "Could not fulfill order.");
  }

  return {
    ok: true,
    fulfillmentId: created?.fulfillmentCreateV2?.fulfillment?.id || null
  };
}

export default async function handler(req, res) {
  setCors(req, res);

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  const shop = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_ACCESS_TOKEN;

  if (!shop || !token) {
    res.status(500).json({ error: "Missing SHOPIFY_STORE or SHOPIFY_ACCESS_TOKEN" });
    return;
  }

  try {
    if (req.method === "GET") {
      const orderId = clean(req.query.order_id);
      if (!orderId) {
        res.status(400).json({ error: "Missing order id" });
        return;
      }

      const saved = await readPrivateJson(orderId);
      res.status(200).json({ ok: true, data: saved || {} });
      return;
    }

    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    const orderId = clean(req.body?.order_id);
    if (!orderId) {
      res.status(400).json({ error: "Missing order id" });
      return;
    }

    const normalized = normalize(req.body);
    const path = getPath(orderId);

    await put(path, JSON.stringify(normalized, null, 2), {
      access: "private",
      contentType: "application/json",
      token: process.env.BLOB_READ_WRITE_TOKEN,
      addRandomSuffix: false,
      allowOverwrite: true
    });

    const syncResults = {
      saved_to_blob: true,
      shopify_paid_sync: null,
      shopify_fulfillment_sync: null
    };

    const paymentStatus = clean(normalized.internal_payment_status).toLowerCase();
    const orderStatus = clean(normalized.internal_order_status).toLowerCase();

    const shouldMarkPaid = paymentStatus === "payment received" || paymentStatus === "partial payment";
    const shouldFulfill = orderStatus === "order complete";

    const shopifyOrder = await getOrderById(shop, token, orderId);

    if (shouldMarkPaid && clean(shopifyOrder.financial_status).toLowerCase() !== "paid") {
      try {
        syncResults.shopify_paid_sync = await markOrderPaid(shop, token, orderId);
      } catch (error) {
        syncResults.shopify_paid_sync = { ok: false, error: error.message || "Could not mark paid." };
      }
    } else {
      syncResults.shopify_paid_sync = { skipped: true };
    }

    if (shouldFulfill && clean(shopifyOrder.fulfillment_status).toLowerCase() !== "fulfilled") {
      try {
        syncResults.shopify_fulfillment_sync = await fulfillOrder(shop, token, shopifyOrder);
      } catch (error) {
        syncResults.shopify_fulfillment_sync = { ok: false, error: error.message || "Could not fulfill order." };
      }
    } else {
      syncResults.shopify_fulfillment_sync = { skipped: true };
    }

    res.status(200).json({
      ok: true,
      order_id: orderId,
      data: normalized,
      sync: syncResults
    });
    return;
  } catch (error) {
    res.status(500).json({
      error: error.message || "Could not save order details."
    });
  }
}
