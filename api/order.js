import {
  clean,
  getOrderDetailsPath,
  parseJsonSafe,
  readPrivateDraftJson,
  readPrivateJson,
  setCors
} from "./shared-utils.js";
import { requireInternalAuth } from "./_lib/internal-auth.js";
import { put } from "@vercel/blob";

function unique(values = []) {
  return [...new Set(values.filter(Boolean))];
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

const ORG_TAGS = [
  "sta",
  "sjs",
  "slu",
  "hope house",
  "rise",
  "personal",
  "other clients"
];

function normalizeTagValue(value) {
  return clean(value).toLowerCase();
}

function detectOrgTagsFromValues(values = []) {
  const normalized = values.map((value) => normalizeTagValue(value)).filter(Boolean);
  return ORG_TAGS.filter((tag) => normalized.includes(tag));
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

async function shopifyGraphQL(shop, token, query, variables = {}) {
  const response = await fetch(`https://${shop}/admin/api/2025-10/graphql.json`, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": token,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ query, variables })
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Shopify GraphQL error: ${text}`);
  }

  const data = JSON.parse(text);

  if (data.errors?.length) {
    throw new Error(`Shopify GraphQL errors: ${JSON.stringify(data.errors)}`);
  }

  return data.data;
}
async function fetchAllMetafields(shop, token, orderId) {
  const query = `
    query GetOrderMetafields($id: ID!) {
      order(id: $id) {
        metafields(first: 100) {
          edges {
            node {
              namespace
              key
              value
            }
          }
        }
      }
    }
  `;

  const data = await shopifyGraphQL(shop, token, query, {
    id: `gid://shopify/Order/${orderId}`
  });

  const edges = data?.order?.metafields?.edges || [];

  const formatted = {};

  edges.forEach(({ node }) => {
    const ns = clean(node.namespace);
    const key = clean(node.key);

    if (!ns || !key) return;

    if (!formatted[ns]) formatted[ns] = {};
    formatted[ns][key] = node.value;
  });

  return formatted;
}
function parseMetaobjectFields(metaobject) {
  const fields = Array.isArray(metaobject?.fields) ? metaobject.fields : [];

  return fields.reduce((acc, field) => {
    acc[field.key] = field;
    return acc;
  }, {});
}

function organizationFromMetaobject(metaobject) {
  if (!metaobject) return null;
  const fields = parseMetaobjectFields(metaobject);

  return {
    id: clean(metaobject.id),
    handle: clean(metaobject.handle),
    name:
      clean(fields.name?.value) ||
      clean(fields.title?.value) ||
      clean(fields.label?.value) ||
      clean(metaobject.displayName)
  };
}

function emptyContactPayload() {
  return {
    custom_customer_name: "",
    custom_customer_email: "",
    custom_customer_phone: "",
    client_contacts: [],
    contact_cards: [],
    contacts: [],
    custom_contacts: [],
    metafield_contacts: [],
    dashboard_contacts: [],
    order_contacts: [],
    organizations: []
  };
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

function getSavedContacts(saved) {
  const possibleSources = [
    saved?.client_contacts,
    saved?.contact_cards,
    saved?.contacts,
    saved?.custom_contacts,
    saved?.metafield_contacts,
    saved?.dashboard_contacts,
    saved?.order_contacts,
    saved?.contact_metafield,
    saved?.metafields?.client_contacts,
    saved?.metafields?.contact_cards,
    saved?.metafields?.contacts,
    saved?.custom_data?.client_contacts,
    saved?.custom_data?.contact_cards,
    saved?.dashboard_data?.client_contacts,
    saved?.dashboard_data?.contact_cards
  ];

  for (const source of possibleSources) {
    const contacts = normalizeContactsFromAny(source);
    if (contacts.length) return contacts;
  }

  return [];
}

function getOrganizations(saved, contacts) {
  const possibleSources = [
    saved?.organizations,
    saved?.organization,
    saved?.orgs,
    saved?.metafields?.organizations,
    saved?.custom_data?.organizations,
    saved?.dashboard_data?.organizations
  ];

  for (const source of possibleSources) {
    const parsed = parseJsonSafe(source, null);

    if (Array.isArray(parsed) && parsed.length) {
      return parsed.map((value) => clean(value)).filter(Boolean);
    }

    if (typeof parsed === "string" && clean(parsed)) {
      return [clean(parsed)];
    }
  }

  const fromContacts = contacts
    .map((contact) => clean(contact.organization))
    .filter(Boolean);

  return [...new Set(fromContacts)];
}

function computeInternalOrderStatus(saved, order) {
  const rawSaved = clean(saved?.internal_order_status).toLowerCase();
  const shopifyFulfillment = clean(order.fulfillment_status || "unfulfilled").toLowerCase();

  if (rawSaved) {
    return rawSaved;
  }

  if (shopifyFulfillment === "fulfilled") {
    return "order complete";
  }

  return "";
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

async function fetchOrderContacts(shop, token, orderId) {
  try {
    const gid = `gid://shopify/Order/${orderId}`;

    const query = `
      query OrderContactInfo($id: ID!) {
        order(id: $id) {
          id
          metafield(namespace: "custom", key: "client_contact_information") {
            value
            type
            reference {
              ... on Metaobject {
                id
                handle
                type
                displayName
                fields {
                  key
                  value
                  reference {
                    ... on Metaobject {
                      id
                      handle
                      type
                      displayName
                      fields {
                        key
                        value
                      }
                    }
                  }
                }
              }
            }
            references(first: 10) {
              nodes {
                ... on Metaobject {
                  id
                  handle
                  type
                  displayName
                  fields {
                    key
                    value
                    reference {
                      ... on Metaobject {
                        id
                        handle
                        type
                        displayName
                        fields {
                          key
                          value
                        }
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

    const data = await shopifyGraphQL(shop, token, query, { id: gid });
    const metafield = data?.order?.metafield;

    if (!metafield) {
      return emptyContactPayload();
    }

    let nodes = [];

    if (metafield.references?.nodes?.length) {
      nodes = metafield.references.nodes;
    } else if (metafield.reference) {
      nodes = [metafield.reference];
    }

    const contacts = nodes.map((node) => {
      const fields = parseMetaobjectFields(node);
      const organizationMetaobject = fields.organization?.reference || null;
      const organizationName = organizationMetaobject
        ? (organizationFromMetaobject(organizationMetaobject)?.name || "")
        : clean(fields.organization?.value);

      return normalizeContact({
        name: clean(fields.name?.value),
        phone: clean(fields.phone_number?.value || fields.phone?.value),
        email: clean(fields.email?.value),
        organization: organizationName
      });
    }).filter((contact) => {
      return contact.name || contact.phone || contact.email || contact.organization;
    });

    const organizations = unique(
      contacts.map((contact) => clean(contact.organization))
    );
    const primaryContact = contacts[0] || null;

    return {
      custom_customer_name: clean(primaryContact?.name),
      custom_customer_email: clean(primaryContact?.email),
      custom_customer_phone: clean(primaryContact?.phone),
      client_contacts: contacts,
      contact_cards: contacts,
      contacts,
      custom_contacts: [],
      metafield_contacts: contacts,
      dashboard_contacts: [],
      order_contacts: contacts,
      organizations
    };
  } catch (error) {
    return emptyContactPayload();
  }
}

async function fetchProductTagsByIds(shop, token, productIds) {
  const ids = [...new Set((productIds || []).map((id) => clean(id)).filter(Boolean))]
    .map((id) => `gid://shopify/Product/${id}`);

  if (!ids.length) return {};

  const query = `
    query GetProductTags($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on Product {
          id
          tags
        }
      }
    }
  `;

  const data = await shopifyGraphQL(shop, token, query, { ids });
  const nodes = Array.isArray(data?.nodes) ? data.nodes.filter(Boolean) : [];

  return nodes.reduce((acc, product) => {
    const numericId = clean(product?.id).split("/").pop();
    if (!numericId) return acc;
    acc[numericId] = Array.isArray(product?.tags) ? product.tags.map((tag) => clean(tag)).filter(Boolean) : [];
    return acc;
  }, {});
}

function isManualOrder(order) {
  const sourceName = clean(order?.source_name).toLowerCase();
  return sourceName === "shopify_draft_order" || sourceName === "manual";
}

function getOrderChannel(order) {
  return isManualOrder(order) ? "manual" : "web";
}

function getOrderTags(order) {
  return clean(order?.tags)
    .split(",")
    .map((tag) => clean(tag))
    .filter(Boolean);
}

function getBoosterCreditDefaults(saved, orgTags, order) {
  const hasSta = orgTags.includes("sta");
  const orderChannel = getOrderChannel(order);
  const savedStatus = clean(saved?.booster_credit_status);
  const savedPercentage = clean(saved?.booster_credit_percentage);

  return {
    booster_credit_percentage: hasSta ? savedPercentage : "",
    booster_credit_status:
      hasSta
        ? (savedStatus || (orderChannel === "web" ? "needs review/approval" : ""))
        : "",
    booster_credit_needs_review: hasSta && orderChannel === "web" && !savedStatus
  };
}

function getDraftId(req) {
  return clean(req.query?.draft_order_id || req.query?.order_id || req.query?.id || req.body?.draft_order_id || req.body?.order_id || req.body?.id);
}

function normalizeDraftInput(input = {}) {
  const source = input?.draft_order && typeof input.draft_order === "object"
    ? input.draft_order
    : input;
  const draftOrder = {};
  const copyFields = [
    "customer_id",
    "use_customer_default_address",
    "email",
    "line_items",
    "shipping_address",
    "billing_address",
    "note",
    "note_attributes",
    "tags",
    "shipping_line",
    "applied_discount",
    "tax_exempt"
  ];

  for (const field of copyFields) {
    if (Object.prototype.hasOwnProperty.call(source, field)) {
      draftOrder[field] = source[field];
    }
  }

  if (Array.isArray(draftOrder.line_items)) {
    draftOrder.line_items = draftOrder.line_items
      .map((item) => {
        if (item?.variant_id) {
          const normalized = {
            variant_id: Number(item.variant_id),
            quantity: Number(item.quantity || 1)
          };
          if (Array.isArray(item.properties)) normalized.properties = item.properties;
          if (item.applied_discount) normalized.applied_discount = item.applied_discount;
          return normalized;
        }

        if (clean(item?.title)) {
          const normalized = {
            title: clean(item.title),
            price: clean(item.price || "0.00"),
            quantity: Number(item.quantity || 1),
            taxable: Boolean(item.taxable),
            requires_shipping: item.requires_shipping !== false
          };
          if (Array.isArray(item.properties)) normalized.properties = item.properties;
          if (item.applied_discount) normalized.applied_discount = item.applied_discount;
          return normalized;
        }

        return null;
      })
      .filter(Boolean);
  }

  if (Array.isArray(draftOrder.tags)) {
    draftOrder.tags = draftOrder.tags.map((tag) => clean(tag)).filter(Boolean).join(", ");
  }

  return draftOrder;
}

async function shopifyRestRequest(shop, token, path, options = {}) {
  const response = await fetch(`https://${shop}/admin/api/2025-10/${path}`, {
    ...options,
    headers: {
      "X-Shopify-Access-Token": token,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  const text = await response.text();
  const json = text ? JSON.parse(text) : {};

  if (!response.ok) {
    throw new Error(json?.errors || json?.error || text || "Shopify request failed");
  }

  return json;
}

function getDraftCustomerName(draftOrder) {
  const fullName = [draftOrder.customer?.first_name, draftOrder.customer?.last_name]
    .filter(Boolean)
    .join(" ");

  return clean(
    fullName ||
      draftOrder.billing_address?.name ||
      draftOrder.shipping_address?.name ||
      "No customer name"
  );
}

function mapDraftOrderDetail(draftOrder, saved = {}) {
  const savedContacts = getSavedContacts(saved);
  const customerName = getDraftCustomerName(draftOrder);
  const customerEmail = clean(draftOrder.email || draftOrder.customer?.email);
  const customerPhone = clean(draftOrder.customer?.phone || draftOrder.billing_address?.phone || draftOrder.shipping_address?.phone);
  const orderTags = getOrderTags(draftOrder);
  const lineItems = (draftOrder.line_items || []).map((item) => {
    const qty = Number(item.quantity || 0);
    const price = Number(item.price || 0);

    return {
      id: item.id,
      title: item.title || item.name,
      variant_title: item.variant_title,
      sku: item.sku,
      quantity: item.quantity,
      current_quantity: item.quantity,
      fulfillable_quantity: item.quantity,
      vendor: item.vendor,
      price: item.price,
      original_price: item.original_price ?? item.price,
      total_discount: item.applied_discount?.amount || "",
      final_line_price: qty > 0 ? String(qty * price) : null,
      current_total_price: qty > 0 ? String(qty * price) : null,
      is_removed: qty <= 0,
      variant_id: item.variant_id,
      product_id: item.product_id,
      product_tags: [],
      org_tags: []
    };
  });

  return {
    id: draftOrder.id,
    name: draftOrder.name,
    order_number: draftOrder.name,
    record_type: "draft_order",
    draft_order: true,
    order_id: draftOrder.order_id || null,
    status: clean(draftOrder.status || "open").toLowerCase(),
    invoice_sent_at: draftOrder.invoice_sent_at || null,
    invoice_url: draftOrder.invoice_url || "",
    created_at: draftOrder.created_at,
    updated_at: draftOrder.updated_at,
    completed_at: draftOrder.completed_at,
    financial_status: clean(saved.internal_payment_status || draftOrder.status || "draft").toLowerCase(),
    fulfillment_status: clean(saved.internal_order_status || "draft").toLowerCase(),
    total_price: draftOrder.total_price,
    subtotal_price: draftOrder.subtotal_price,
    total_discounts: draftOrder.applied_discount?.amount || "",
    total_tax: draftOrder.total_tax,
    current_total_price: draftOrder.total_price,
    current_subtotal_price: draftOrder.subtotal_price,
    current_total_discounts: draftOrder.applied_discount?.amount || "",
    current_total_tax: draftOrder.total_tax,
    currency: draftOrder.currency,
    tags: orderTags,
    order_tags: orderTags,
    org_tags: detectOrgTagsFromValues(orderTags),
    note: draftOrder.note || "",
    manual_order: false,
    order_channel: "draft",

    shopify_customer_name: customerName,
    shopify_customer_email: customerEmail,
    shopify_customer_phone: customerPhone,
    shopify_prepared_for: getPreparedForFromShopify(draftOrder),
    custom_customer_name: clean(saved.custom_customer_name) || customerName,
    custom_customer_email: clean(saved.custom_customer_email) || customerEmail,
    custom_customer_phone: clean(saved.custom_customer_phone) || customerPhone,
    customer_name: clean(saved.custom_customer_name) || customerName,
    customer_email: clean(saved.custom_customer_email) || customerEmail,
    customer_phone: clean(saved.custom_customer_phone) || customerPhone,
    prepared_for: clean(saved.prepared_for) || getPreparedForFromShopify(draftOrder),

    school: clean(saved.school),
    sent_with: clean(saved.sent_with),
    delivery_notes: clean(saved.delivery_notes),
    staff_notes: clean(saved.staff_notes),
    production_notes: clean(saved.production_notes),
    internal_order_status: clean(saved.internal_order_status),
    internal_payment_status: clean(saved.internal_payment_status),
    booster_account_name: clean(saved.booster_account_name),
    booster_credit_percentage: clean(saved.booster_credit_percentage),
    booster_credit_status: clean(saved.booster_credit_status),
    booster_credit_needs_review: false,
    booster_credit_amount: clean(saved.booster_credit_amount),
    booster_payment_account_name: clean(saved.booster_payment_account_name),
    payment_received_note: clean(saved.payment_received_note),
    custom_updated_at: clean(saved.updated_at),

    client_contacts: savedContacts,
    contact_cards: savedContacts,
    contacts: savedContacts,
    custom_contacts: normalizeContactsFromAny(saved?.custom_contacts),
    metafield_contacts: [],
    dashboard_contacts: normalizeContactsFromAny(saved?.dashboard_contacts),
    order_contacts: savedContacts,
    organizations: getOrganizations(saved, savedContacts),

    shipping_address: draftOrder.shipping_address || null,
    billing_address: draftOrder.billing_address || null,
    shipping_line: draftOrder.shipping_line || null,
    note_attributes: Array.isArray(draftOrder.note_attributes) ? draftOrder.note_attributes : [],
    line_items: lineItems
  };
}

async function copyDraftMetadataToOrder(draftOrderId, orderId) {
  if (!draftOrderId || !orderId) {
    return { skipped: true, reason: "Missing draft or order id." };
  }

  const draftMetadata = await readPrivateDraftJson(draftOrderId).catch(() => null);
  if (!draftMetadata) {
    return { skipped: true, reason: "No draft metadata found." };
  }

  const existingOrderMetadata = await readPrivateJson(orderId).catch(() => null);
  const merged = {
    ...(existingOrderMetadata || {}),
    ...draftMetadata,
    source_draft_order_id: clean(draftOrderId),
    migrated_from_draft_at: new Date().toISOString()
  };

  await put(getOrderDetailsPath(orderId), JSON.stringify(merged, null, 2), {
    access: "private",
    contentType: "application/json",
    token: process.env.BLOB_READ_WRITE_TOKEN,
    addRandomSuffix: false,
    allowOverwrite: true
  });

  return { ok: true, order_id: orderId, draft_order_id: draftOrderId };
}

async function handleDraftOrder(req, res, shop, token) {
  const draftOrderId = getDraftId(req);

  if (req.method === "GET") {
    if (!draftOrderId) {
      return res.status(400).json({ error: "Missing draft order id" });
    }

    const data = await shopifyRestRequest(shop, token, `draft_orders/${encodeURIComponent(draftOrderId)}.json`);
    const draftOrder = data.draft_order;
    if (!draftOrder) {
      return res.status(404).json({ error: "Draft order not found" });
    }

    const saved = await readPrivateDraftJson(draftOrderId).catch(() => null);
    return res.status(200).json({ order: mapDraftOrderDetail(draftOrder, saved || {}) });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const mode = clean(req.body?.mode || req.body?.action || "").toLowerCase();

  if (mode === "create") {
    const draftOrder = normalizeDraftInput(req.body);
    if (!Array.isArray(draftOrder.line_items) || !draftOrder.line_items.length) {
      return res.status(400).json({ error: "Add at least one draft line item." });
    }

    const data = await shopifyRestRequest(shop, token, "draft_orders.json", {
      method: "POST",
      body: JSON.stringify({ draft_order: draftOrder })
    });
    return res.status(200).json({ ok: true, order: mapDraftOrderDetail(data.draft_order, {}) });
  }

  if (!draftOrderId) {
    return res.status(400).json({ error: "Missing draft order id" });
  }

  if (mode === "update") {
    const draftOrder = normalizeDraftInput(req.body);
    draftOrder.id = Number(draftOrderId);

    const data = await shopifyRestRequest(shop, token, `draft_orders/${encodeURIComponent(draftOrderId)}.json`, {
      method: "PUT",
      body: JSON.stringify({ draft_order: draftOrder })
    });
    const saved = await readPrivateDraftJson(draftOrderId).catch(() => null);
    return res.status(200).json({ ok: true, order: mapDraftOrderDetail(data.draft_order, saved || {}) });
  }

  if (mode === "send_invoice") {
    const invoice = req.body?.email || req.body?.draft_order_invoice || {};
    const data = await shopifyRestRequest(shop, token, `draft_orders/${encodeURIComponent(draftOrderId)}/send_invoice.json`, {
      method: "POST",
      body: JSON.stringify({ draft_order_invoice: invoice })
    });
    const draftOrder = data.draft_order || null;
    return res.status(200).json({ ok: true, order: draftOrder ? mapDraftOrderDetail(draftOrder, {}) : null });
  }

  if (mode === "complete") {
    const params = new URLSearchParams();
    if (req.body?.payment_pending === true || req.body?.payment_pending === "true") {
      params.set("payment_pending", "true");
    }

    const suffix = params.toString() ? `?${params.toString()}` : "";
    const data = await shopifyRestRequest(shop, token, `draft_orders/${encodeURIComponent(draftOrderId)}/complete.json${suffix}`, {
      method: "PUT"
    });
    const draftOrder = data.draft_order || {};
    const orderId = clean(draftOrder.order_id || data.order?.id || req.body?.order_id);
    const metadataCopy = orderId
      ? await copyDraftMetadataToOrder(draftOrderId, orderId).catch((error) => ({
          ok: false,
          error: error.message || "Could not copy draft metadata."
        }))
      : { skipped: true, reason: "Shopify did not return an order id." };

    return res.status(200).json({
      ok: true,
      order: mapDraftOrderDetail(draftOrder, {}),
      order_id: orderId || null,
      metadata_copy: metadataCopy
    });
  }

  return res.status(400).json({ error: "Unsupported draft order mode." });
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Surrogate-Control", "no-store");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (!(await requireInternalAuth(req, res))) {
    return;
  }

  const shop = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_ACCESS_TOKEN;

  if (!shop || !token) {
    return res.status(500).json({
      error: "Missing SHOPIFY_STORE or SHOPIFY_ACCESS_TOKEN"
    });
  }

  const type = clean(req.query.type || req.query.record_type || req.body?.type || req.body?.record_type).toLowerCase();
  if (type === "draft" || type === "draft_order") {
    try {
      return await handleDraftOrder(req, res, shop, token);
    } catch (error) {
      return res.status(500).json({
        error: "Draft order error",
        details: error.message || "Could not handle draft order."
      });
    }
  }

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const orderId = clean(req.query.order_id || req.query.id);

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
    const contactData = await fetchOrderContacts(shop, token, orderId);
    const metafields = await fetchAllMetafields(shop, token, orderId);
    const productTagsById = await fetchProductTagsByIds(
      shop,
      token,
      (order.line_items || []).map((item) => item.product_id)
    );

    const shopifyCustomerName = getShopifyCustomerName(order);
    const shopifyCustomerEmail = getShopifyCustomerEmail(order);
    const shopifyCustomerPhone = getShopifyCustomerPhone(order);
    const shopifyPreparedFor = getPreparedForFromShopify(order);
    const metafieldContacts = normalizeContactsFromAny(
      contactData?.metafield_contacts ||
      contactData?.client_contacts ||
      contactData?.contact_cards ||
      contactData?.contacts
    );
    const savedContacts = getSavedContacts(saved);
    const contacts = metafieldContacts.length ? metafieldContacts : savedContacts;
    const primaryContact = contacts[0] || {};
    const orderTags = getOrderTags(order);
    const lineItems = (order.line_items || [])
      .map((item) => {
        const productTags = Array.isArray(productTagsById[String(item.product_id)])
          ? productTagsById[String(item.product_id)]
          : [];

        const rawCurrentQty =
          item.current_quantity ??
          item.fulfillable_quantity ??
          item.quantity;

        const qty = Number(rawCurrentQty) || 0;

        return {
          id: item.id,
          title: item.title,
          variant_title: item.variant_title,
          sku: item.sku,
          quantity: item.quantity,
          current_quantity: item.current_quantity ?? null,
          fulfillable_quantity: item.fulfillable_quantity ?? null,
          vendor: item.vendor,
          price: item.price,
          original_price: item.original_price ?? item.price,
          total_discount: item.total_discount,
          final_line_price:
            item.final_line_price ??
            item.current_total_price ??
            (qty > 0 ? String(qty * Number(item.price || 0)) : null),
          current_total_price:
            item.current_total_price ??
            (qty > 0 ? String(qty * Number(item.price || 0)) : null),
          is_removed: qty <= 0,
          product_tags: productTags,
          org_tags: detectOrgTagsFromValues(productTags)
        };
      })
      .filter((item) => {
        if (item.current_quantity !== null) return Number(item.current_quantity) > 0;
        if (item.fulfillable_quantity !== null) return Number(item.fulfillable_quantity) > 0;
        return Number(item.quantity) > 0;
      });

    const orgTags = [...new Set([
      ...lineItems.flatMap((item) => item.org_tags || []),
      ...detectOrgTagsFromValues(orderTags)
    ])];
    const boosterDefaults = getBoosterCreditDefaults(saved, orgTags, order);
    const organizations = getOrganizations(
      saved?.organizations && parseJsonSafe(saved.organizations, saved.organizations)
        ? saved
        : {
            ...saved,
            organizations: contactData?.organizations || []
          },
      contacts
    );
    const internalOrderStatus = computeInternalOrderStatus(saved, order);
    const internalPaymentStatus = computeInternalPaymentStatus(saved, order);

    const merged = {
      id: order.id,
      name: order.name,
      order_number: order.order_number,
      created_at: order.created_at,
      metafields,
work_order_notes: clean(metafields?.custom?.order_notes || ""),
      financial_status: order.financial_status,
      fulfillment_status: order.fulfillment_status || "unfulfilled",
      total_price: order.current_total_price ?? order.total_price,
subtotal_price: order.current_subtotal_price ?? order.subtotal_price,
total_discounts: order.current_total_discounts ?? order.total_discounts,
total_tax: order.current_total_tax ?? order.total_tax,

current_total_price: order.current_total_price ?? order.total_price,
current_subtotal_price: order.current_subtotal_price ?? order.subtotal_price,
current_total_discounts: order.current_total_discounts ?? order.total_discounts,
current_total_tax: order.current_total_tax ?? order.total_tax,
      currency: order.currency,
      tags: [...new Set([...orderTags, ...orgTags])],
      order_tags: [...new Set([...orderTags, ...orgTags])],
      org_tags: orgTags,
      note: order.note || "",
      manual_order: isManualOrder(order),
      order_channel: getOrderChannel(order),

      shopify_customer_name: clean(shopifyCustomerName),
      shopify_customer_email: clean(shopifyCustomerEmail),
      shopify_customer_phone: clean(shopifyCustomerPhone),
      shopify_prepared_for: clean(shopifyPreparedFor),

      custom_customer_name:
        clean(saved.custom_customer_name) ||
        clean(contactData?.custom_customer_name) ||
        clean(metafieldContacts[0]?.name) ||
        shopifyCustomerName,
      custom_customer_email:
        clean(saved.custom_customer_email) ||
        clean(contactData?.custom_customer_email) ||
        clean(metafieldContacts[0]?.email) ||
        shopifyCustomerEmail,
      custom_customer_phone:
        clean(saved.custom_customer_phone) ||
        clean(contactData?.custom_customer_phone) ||
        clean(metafieldContacts[0]?.phone) ||
        shopifyCustomerPhone,

      customer_name:
        clean(saved.custom_customer_name) ||
        clean(contactData?.custom_customer_name) ||
        clean(primaryContact.name) ||
        shopifyCustomerName,

      customer_email:
        clean(saved.custom_customer_email) ||
        clean(contactData?.custom_customer_email) ||
        clean(primaryContact.email) ||
        shopifyCustomerEmail,

      customer_phone:
        clean(saved.custom_customer_phone) ||
        clean(contactData?.custom_customer_phone) ||
        clean(primaryContact.phone) ||
        shopifyCustomerPhone,

      prepared_for: clean(saved.prepared_for) || shopifyPreparedFor,

      school: clean(saved.school),
      sent_with: clean(saved.sent_with),
      delivery_notes: clean(saved.delivery_notes),
      staff_notes: clean(saved.staff_notes),
      production_notes: clean(saved.production_notes),

      internal_order_status: internalOrderStatus,
      internal_payment_status: internalPaymentStatus,
      booster_account_name: clean(saved.booster_account_name),
      booster_credit_percentage: boosterDefaults.booster_credit_percentage,
      booster_credit_status: boosterDefaults.booster_credit_status,
      booster_credit_needs_review: boosterDefaults.booster_credit_needs_review,
      booster_credit_amount: clean(saved.booster_credit_amount),
      booster_payment_account_name: clean(saved.booster_payment_account_name),
      payment_received_note: clean(saved.payment_received_note),

      custom_updated_at: clean(saved.updated_at),

      client_contacts: metafieldContacts.length ? metafieldContacts : savedContacts,
      contact_cards: metafieldContacts.length ? metafieldContacts : savedContacts,
      contacts,
      custom_contacts: normalizeContactsFromAny(saved?.custom_contacts),
      metafield_contacts: metafieldContacts,
      dashboard_contacts: normalizeContactsFromAny(saved?.dashboard_contacts),
      order_contacts: metafieldContacts.length ? metafieldContacts : savedContacts,
      organizations,

      shipping_address: order.shipping_address || null,
      billing_address: order.billing_address || null,

      line_items: lineItems
    };

    return res.status(200).json({ order: merged });
  } catch (error) {
    return res.status(500).json({
      error: "Server error",
      details: error.message
    });
  }
}
