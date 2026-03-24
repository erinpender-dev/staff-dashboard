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

  const response = await fetch(`${url}?ts=${Date.now()}`, {
  headers: {
    Authorization: `Bearer ${token}`,
    "Cache-Control": "no-cache"
  },
  cache: "no-store"
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

function getClientContacts(saved) {
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
    const parsed = parseJsonSafe(source, null);
    if (Array.isArray(parsed) && parsed.length) {
      return parsed
        .map(normalizeContact)
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

function getReference(saved, shopifyReference) {
  return clean(
    saved?.reference ||
      saved?.job_reference ||
      saved?.project_reference ||
      shopifyReference ||
      ""
  );
}

function getPaymentReceivedType(saved) {
  return clean(saved?.payment_received_type);
}

function getPaymentReceivedAmount(saved) {
  return clean(saved?.payment_received_amount);
}

function getPaymentReceivedCheckNumber(saved) {
  return clean(saved?.payment_received_check_number);
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

function metaobjectFieldsToMap(metaobject) {
  const map = {};
  const fields = Array.isArray(metaobject?.fields) ? metaobject.fields : [];

  for (const field of fields) {
    if (!field?.key) continue;
    map[field.key] = field;
  }

  return map;
}

function getReferencedMetaobjectName(field) {
  const reference = field?.reference;
  if (!reference) return "";

  const refFields = Array.isArray(reference.fields) ? reference.fields : [];
  const nameField = refFields.find((item) => item?.key === "name");

  return clean(nameField?.value);
}

function parseClientContactMetaobject(metaobject) {
  if (!metaobject) return null;

  const fields = metaobjectFieldsToMap(metaobject);

  const contact = {
    name: clean(fields.name?.value),
    email: clean(fields.email?.value),
    phone: clean(fields.phone_number?.value),
    organization: getReferencedMetaobjectName(fields.organization),
    title: "",
    role: ""
  };

  if (
    !contact.name &&
    !contact.email &&
    !contact.phone &&
    !contact.organization
  ) {
    return null;
  }

  return contact;
}

function parseMetaobjectIdsFromMetafieldValue(value) {
  const parsed = parseJsonSafe(value, []);

  if (Array.isArray(parsed)) {
    return parsed.map((id) => clean(id)).filter(Boolean);
  }

  if (typeof parsed === "string" && clean(parsed)) {
    return [clean(parsed)];
  }

  return [];
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

  const json = await response.json();

  if (!response.ok) {
    throw new Error(
      json?.errors?.[0]?.message ||
      json?.error ||
      "Shopify GraphQL request failed"
    );
  }

  if (json.errors?.length) {
    throw new Error(json.errors.map((e) => e.message).join(" | "));
  }

  return json.data;
}

async function fetchOrderMetafields(shop, token, orderId) {
  const query = `
    query GetOrderMetafields($id: ID!) {
      node(id: $id) {
        ... on Order {
          id
          clientContactInformation: metafield(namespace: "custom", key: "client_contact_information") {
            id
            type
            value
          }
          reference: metafield(namespace: "custom", key: "reference") {
            id
            type
            value
          }
        }
      }
    }
  `;

  const data = await shopifyGraphQL(
    shop,
    token,
    query,
    { id: `gid://shopify/Order/${orderId}` }
  );

  return {
    clientContactInformation: data?.node?.clientContactInformation || null,
    reference: data?.node?.reference || null
  };
}

async function fetchMetaobjectsByIds(shop, token, ids) {
  if (!Array.isArray(ids) || !ids.length) return [];

  const query = `
    query GetMetaobjectsByIds($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on Metaobject {
          id
          type
          handle
          fields {
            key
            value
            reference {
              ... on Metaobject {
                id
                type
                handle
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
  `;

  const data = await shopifyGraphQL(shop, token, query, { ids });
  return Array.isArray(data?.nodes) ? data.nodes.filter(Boolean) : [];
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
    const debugMode = String(req.query.debug || "") === "1";

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
        let clientContactMetafield = null;
        let referenceMetafield = null;
        let metafieldError = "";
        let metafieldContacts = [];
        let metafieldMetaobjectIds = [];
        let fetchedMetaobjects = [];

        try {
          saved = await readPrivateJson(order.id);
        } catch {
          saved = null;
        }

        try {
          const metafields = await fetchOrderMetafields(shop, token, order.id);
          clientContactMetafield = metafields.clientContactInformation;
          referenceMetafield = metafields.reference;

          metafieldMetaobjectIds = parseMetaobjectIdsFromMetafieldValue(clientContactMetafield?.value);
          fetchedMetaobjects = await fetchMetaobjectsByIds(shop, token, metafieldMetaobjectIds);
          metafieldContacts = fetchedMetaobjects
            .map((metaobject) => parseClientContactMetaobject(metaobject))
            .filter(Boolean);
        } catch (error) {
          metafieldError = error.message || String(error);
          clientContactMetafield = null;
          referenceMetafield = null;
          metafieldContacts = [];
        }

        const shopifyCustomerName = getShopifyCustomerName(order);
        const shopifyCustomerEmail = getShopifyCustomerEmail(order);
        const shopifyCustomerPhone = getShopifyCustomerPhone(order);
        const shopifyPreparedFor = getPreparedFor(order);
        const shopifyReference = clean(referenceMetafield?.value);

        const savedContacts = getClientContacts(saved);
        const clientContacts = metafieldContacts.length ? metafieldContacts : savedContacts;
        const organizations = getOrganizations(saved, clientContacts);
        const partialPayments = getPartialPayments(saved);

        const result = {
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

          customer_name: clean(saved?.custom_customer_name) || "",
          customer_email: clean(saved?.custom_customer_email) || "",
          customer_phone: clean(saved?.custom_customer_phone) || "",

          prepared_for:
            clean(saved?.prepared_for) || shopifyPreparedFor || shopifyCustomerName,

          reference: getReference(saved, shopifyReference),
          shopify_reference: shopifyReference,
          school: clean(saved?.school),
          sent_with: clean(saved?.sent_with),
          delivery_notes: clean(saved?.delivery_notes),
          staff_notes: clean(saved?.staff_notes),
          production_notes: clean(saved?.production_notes),

          internal_order_status: clean(saved?.internal_order_status),
          internal_payment_status: clean(saved?.internal_payment_status),

          payment_received_type: getPaymentReceivedType(saved),
          payment_received_amount: getPaymentReceivedAmount(saved),
          payment_received_check_number: getPaymentReceivedCheckNumber(saved),
          partial_payments: partialPayments,

          client_contacts: clientContacts,
          contact_metafield: metafieldContacts,
          organizations: organizations,

          item_count: Array.isArray(order.line_items)
            ? order.line_items.reduce((sum, item) => sum + Number(item.quantity || 0), 0)
            : 0,

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

        if (debugMode) {
          result.metafield_debug = {
            has_client_contact_metafield: !!clientContactMetafield,
            client_contact_metafield_type: clientContactMetafield?.type || "",
            client_contact_metafield_value: clientContactMetafield?.value || "",
            has_reference_metafield: !!referenceMetafield,
            reference_metafield_type: referenceMetafield?.type || "",
            reference_metafield_value: referenceMetafield?.value || "",
            metaobject_ids: metafieldMetaobjectIds,
            fetched_metaobjects_count: fetchedMetaobjects.length,
            parsed_contacts_count: metafieldContacts.length,
            parsed_contacts: metafieldContacts,
            graphql_error: metafieldError
          };
        }

        return result;
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
