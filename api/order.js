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

function unique(values = []) {
  return [...new Set(values.filter(Boolean))];
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

function parseMetaobjectFields(metaobject) {
  if (!metaobject?.fields) return {};

  return metaobject.fields.reduce((acc, field) => {
    acc[field.key] = field.value || "";
    return acc;
  }, {});
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
                fields {
                  key
                  value
                }
              }
            }
            references(first: 10) {
              nodes {
                ... on Metaobject {
                  id
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

    const data = await shopifyGraphQL(shop, token, query, { id: gid });
    const metafield = data?.order?.metafield;

    if (!metafield) {
      return {
        client_contacts: [],
        organizations: []
      };
    }

    let nodes = [];

    if (metafield.references?.nodes?.length) {
      nodes = metafield.references.nodes;
    } else if (metafield.reference) {
      nodes = [metafield.reference];
    }

    const contacts = nodes.map((node) => {
      const fields = parseMetaobjectFields(node);

      return {
        name: clean(fields.name),
        phone: clean(fields.phone),
        email: clean(fields.email),
        organization: clean(fields.organization)
      };
    }).filter((contact) => {
      return contact.name || contact.phone || contact.email || contact.organization;
    });

    const organizations = unique(
      contacts.map((contact) => clean(contact.organization))
    );

    return {
      client_contacts: contacts,
      organizations
    };
  } catch (error) {
    return {
      client_contacts: [],
      organizations: []
    };
  }
}
const RECOGNIZED_ORG_TAGS = ["STA", "SLU", "SJS", "RISE", "HOPE HOUSE", "PERSONAL", "OTHER CLIENTS"];

function isWebsiteOrder(order) {
  const sourceName = String(order.source_name || "").toLowerCase();
  const tags = String(order.tags || "").toLowerCase();

  if (tags.includes("manual order")) return false;
  if (tags.includes("draft order")) return false;
  if (sourceName === "shopify_draft_order") return false;

  return sourceName === "web";
}

function normalizeTagList(value) {
  if (!value) return [];

  if (Array.isArray(value)) {
    return value
      .map(v => String(v).trim().toUpperCase())
      .filter(Boolean);
  }

  return String(value)
    .split(",")
    .map(v => v.trim().toUpperCase())
    .filter(Boolean);
}

function parseAmount(value) {
  if (value === null || value === undefined || value === "") return null;
  const num = Number(String(value).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(num) ? num : null;
}

function getLineItemFinalTotal(item) {
  const finalLine =
    parseAmount(item.final_line_price) ??
    parseAmount(item.current_total_price);

  if (finalLine !== null) return finalLine;

  const qty =
    parseAmount(item.current_quantity) ??
    parseAmount(item.quantity) ??
    0;

  const unitPrice =
    parseAmount(item.price) ??
    parseAmount(item.original_price) ??
    0;

  const lineDiscount =
    parseAmount(item.total_discount) ??
    0;

  return Math.max(0, (qty * unitPrice) - lineDiscount);
}

function getItemTagList(item) {
  return [
    ...normalizeTagList(item.product_tags),
    ...normalizeTagList(item.tags)
  ];
}

function getMatchedOrgTagsFromOrder(order) {
  const items = Array.isArray(order.line_items) ? order.line_items : [];
  const found = new Set();

  for (const item of items) {
    const itemTags = getItemTagList(item);

    for (const orgTag of RECOGNIZED_ORG_TAGS) {
      if (itemTags.includes(orgTag)) {
        found.add(orgTag);
      }
    }
  }

  return Array.from(found);
}

function getAutoOrganizationTag(order) {
  const matchedOrgs = getMatchedOrgTagsFromOrder(order);

  if (matchedOrgs.length === 1) return matchedOrgs[0];
  if (matchedOrgs.length > 1) return "Manual Review";
  return "";
}

function getTaggedSubtotal(order, targetTag) {
  const target = String(targetTag || "").trim().toUpperCase();
  const items = Array.isArray(order.line_items) ? order.line_items : [];

  return items.reduce((sum, item) => {
    const itemTags = getItemTagList(item);
    if (!itemTags.includes(target)) return sum;
    return sum + getLineItemFinalTotal(item);
  }, 0);
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
  const orderId = req.query.id;

  if (!shop || !token) {
    return res.status(500).json({
      error: "Missing SHOPIFY_STORE or SHOPIFY_ACCESS_TOKEN"
    });
  }

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
    const websiteOrder = isWebsiteOrder(order);

    const uniqueProductIds = [
      ...new Set(
        (order.line_items || [])
          .map((item) => item.product_id)
          .filter(Boolean)
      )
    ];

    const productTagsById = {};

    if (websiteOrder && uniqueProductIds.length) {
      await Promise.all(
        uniqueProductIds.map(async (productId) => {
          try {
            const productResponse = await fetch(
              `https://${shop}/admin/api/2025-10/products/${encodeURIComponent(productId)}.json?fields=id,tags`,
              {
                headers: {
                  "X-Shopify-Access-Token": token,
                  "Content-Type": "application/json"
                }
              }
            );

            if (!productResponse.ok) return;

            const productText = await productResponse.text();
            const productData = JSON.parse(productText);
            const product = productData.product;

            if (product?.id) {
              productTagsById[String(product.id)] = product.tags || "";
            }
          } catch (e) {
            // ignore per-product errors so one bad product doesn't break the order
          }
        })
      );
    }
    const shopifyCustomerName =
      order.customer
        ? [order.customer.first_name, order.customer.last_name]
            .filter(Boolean)
            .join(" ")
        : order.billing_address?.name ||
          order.shipping_address?.name ||
          "No customer name";

    const shopifyCustomerEmail =
      order.email ||
      order.customer?.email ||
      order.contact_email ||
      "";

    const shopifyCustomerPhone =
      order.phone ||
      order.billing_address?.phone ||
      order.shipping_address?.phone ||
      order.customer?.phone ||
      "";

    const shopifyPreparedFor =
      order.note_attributes?.find((attr) => {
        const name = (attr.name || "").toLowerCase();
        return (
          name === "athlete name & sport" ||
          name === "student info" ||
          name === "prepared for"
        );
      })?.value || "";

    const primaryContact = contactData.client_contacts[0] || {};
        const mergedLineItems = (order.line_items || [])
      .map((item) => {
        const rawCurrentQty =
          item.current_quantity ??
          item.fulfillable_quantity ??
          item.quantity;

        const qty = Number(rawCurrentQty) || 0;

        return {
          id: item.id,
          product_id: item.product_id ?? null,
          product_tags: productTagsById[String(item.product_id)] || "",
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
          is_removed: qty <= 0
        };
      })
      .filter((item) => {
        if (item.current_quantity !== null) return Number(item.current_quantity) > 0;
        if (item.fulfillable_quantity !== null) return Number(item.fulfillable_quantity) > 0;
        return Number(item.quantity) > 0;
      });
        const orderForOrgLogic = {
      ...order,
      line_items: mergedLineItems
    };

    const autoOrganizationTag = websiteOrder
      ? getAutoOrganizationTag(orderForOrgLogic)
      : "";

    const staEligibleSubtotal =
      websiteOrder && autoOrganizationTag === "STA"
        ? getTaggedSubtotal(orderForOrgLogic, "STA")
        : 0;

    const defaultBoosterStatus =
      !websiteOrder
        ? "not eligible"
        : autoOrganizationTag === "STA"
          ? "needs approval"
          : autoOrganizationTag === "Manual Review"
            ? "manual review"
            : "not eligible";
    const merged = {
      id: order.id,
      name: order.name,
      order_number: order.order_number,
      created_at: order.created_at,
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
           tags: order.tags || "",
      note: order.note || "",

      is_website_order: websiteOrder,
      organization_tag: clean(saved.organization_tag) || autoOrganizationTag,
      organization_source:
        clean(saved.organization_source) ||
        (autoOrganizationTag ? "product-tags-auto" : ""),

      booster_status: clean(saved.booster_status) || defaultBoosterStatus,
      booster_percent: clean(saved.booster_percent),
      booster_eligible_subtotal:
        parseAmount(saved.booster_eligible_subtotal) ?? staEligibleSubtotal,
      booster_credit_amount:
        parseAmount(saved.booster_credit_amount) ?? 0,

      shopify_customer_name: clean(shopifyCustomerName),
      shopify_customer_email: clean(shopifyCustomerEmail),
      shopify_customer_phone: clean(shopifyCustomerPhone),
      shopify_prepared_for: clean(shopifyPreparedFor),

      custom_customer_name: clean(saved.custom_customer_name),
      custom_customer_email: clean(saved.custom_customer_email),
      custom_customer_phone: clean(saved.custom_customer_phone),

      customer_name:
        clean(saved.custom_customer_name) ||
        clean(primaryContact.name) ||
        clean(shopifyCustomerName),

      customer_email:
        clean(saved.custom_customer_email) ||
        clean(primaryContact.email) ||
        clean(shopifyCustomerEmail),

      customer_phone:
        clean(saved.custom_customer_phone) ||
        clean(primaryContact.phone) ||
        clean(shopifyCustomerPhone),

      prepared_for: clean(saved.prepared_for) || clean(shopifyPreparedFor),

      school: clean(saved.school),
      sent_with: clean(saved.sent_with),
      delivery_notes: clean(saved.delivery_notes),
      staff_notes: clean(saved.staff_notes),
      production_notes: clean(saved.production_notes),

      internal_order_status: clean(saved.internal_order_status),
      internal_payment_status: clean(saved.internal_payment_status),

      custom_updated_at: clean(saved.updated_at),

      client_contacts: contactData.client_contacts,
      organizations: contactData.organizations,

      shipping_address: order.shipping_address || null,
      billing_address: order.billing_address || null,

            line_items: mergedLineItems
    };
console.log("FINAL ORDER:", JSON.stringify(merged, null, 2));
    return res.status(200).json({ order: merged });
  } catch (error) {
    return res.status(500).json({
      error: "Server error",
      details: error.message
    });
  }
}
