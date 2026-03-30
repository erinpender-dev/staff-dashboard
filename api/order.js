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

  if (response.status === 404) return null;
  if (!response.ok) throw new Error(await response.text());

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

  const data = await response.json();
  if (data.errors?.length) throw new Error(JSON.stringify(data.errors));

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
      query ($id: ID!) {
        order(id: $id) {
          metafield(namespace: "custom", key: "client_contact_information") {
            reference { ... on Metaobject { fields { key value } } }
            references(first: 10) { nodes { ... on Metaobject { fields { key value } } } }
          }
        }
      }
    `;

    const data = await shopifyGraphQL(shop, token, query, { id: gid });
    const metafield = data?.order?.metafield;

    let nodes = [];
    if (metafield?.references?.nodes?.length) nodes = metafield.references.nodes;
    else if (metafield?.reference) nodes = [metafield.reference];

    const contacts = nodes.map(node => {
      const fields = parseMetaobjectFields(node);
      return {
        name: clean(fields.name),
        phone: clean(fields.phone_number || fields.phone),
        email: clean(fields.email),
        organization: clean(fields.organizations || fields.organization)
      };
    });

    return {
      client_contacts: contacts,
      organizations: unique(contacts.map(c => c.organization))
    };
  } catch {
    return { client_contacts: [], organizations: [] };
  }
}

/* =========================
   BOOSTER / ORG LOGIC
========================= */

const RECOGNIZED_ORG_TAGS = ["STA", "SLU", "SJS", "RISE", "HOPE HOUSE"];
const BOOSTER_ELIGIBLE_TAG = "STA";

function isWebsiteOrder(order) {
  const source = String(order.source_name || "").toLowerCase();
  const tags = String(order.tags || "").toLowerCase();

  if (tags.includes("manual") || tags.includes("draft")) return false;
  if (source === "shopify_draft_order") return false;

  return source === "web";
}

function normalizeTags(tags) {
  return String(tags || "")
    .split(",")
    .map(t => t.trim().toUpperCase())
    .filter(Boolean);
}

function parseAmount(v) {
  return Number(String(v || 0).replace(/[^0-9.-]/g, "")) || 0;
}

function getLineQty(item) {
  return parseAmount(
    item.current_quantity ??
    item.fulfillable_quantity ??
    item.quantity ??
    0
  );
}

function getLineTotal(item) {
  const finalLine =
    parseAmount(item.final_line_price) ||
    parseAmount(item.current_total_price);

  if (finalLine > 0) return finalLine;

  const unitPrice =
    parseAmount(item.price) ||
    parseAmount(item.original_price) ||
    0;

  const qty = getLineQty(item);
  const discount = parseAmount(item.total_discount) || 0;

  return Math.max(0, unitPrice * qty - discount);
}

function getFoundOrgTags(items) {
  const found = new Set();

  items.forEach(item => {
    const tags = normalizeTags(item.product_tags);
    RECOGNIZED_ORG_TAGS.forEach(org => {
      if (tags.includes(org)) found.add(org);
    });
  });

  return [...found];
}

function getOrgFromItems(items) {
  const found = getFoundOrgTags(items);

  if (found.length === 1) return found[0];
  if (found.length > 1) return "Manual Review";
  return "";
}

function getSubtotalByTag(items, tag) {
  const normalizedTag = String(tag || "").trim().toUpperCase();

  return items.reduce((sum, item) => {
    const tags = normalizeTags(item.product_tags);
    if (!tags.includes(normalizedTag)) return sum;
    return sum + getLineTotal(item);
  }, 0);
}

function toPercentNumber(value) {
  if (value === null || value === undefined || value === "") return null;

  const raw = parseAmount(value);

  if (!Number.isFinite(raw)) return null;

  // supports either 10 or 0.10
  if (raw > 0 && raw <= 1) return raw;
  return raw / 100;
}

function roundMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

/* ========================= */

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

  if (!orderId) return res.status(400).json({ error: "Missing order id" });

  try {
    const response = await fetch(
      `https://${shop}/admin/api/2025-10/orders/${orderId}.json?status=any`,
      { headers: { "X-Shopify-Access-Token": token } }
    );

    if (!response.ok) {
      throw new Error(`Shopify order fetch failed: ${response.status} ${await response.text()}`);
    }

    const { order } = await response.json();
    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    const saved = (await readPrivateJson(orderId)) || {};
    const contactData = await fetchOrderContacts(shop, token, orderId);

    /* ===== PRODUCT TAG FETCH ===== */
    const productTagsById = {};
    const ids = [...new Set(order.line_items.map(i => i.product_id).filter(Boolean))];

    await Promise.all(
      ids.map(async id => {
        try {
          const r = await fetch(
            `https://${shop}/admin/api/2025-10/products/${id}.json?fields=id,tags`,
            { headers: { "X-Shopify-Access-Token": token } }
          );

          if (!r.ok) return;
          const data = await r.json();
          productTagsById[id] = data.product?.tags || "";
        } catch {
          // ignore individual product tag lookup failures
        }
      })
    );

    /* ===== BUILD LINE ITEMS ===== */
    const line_items = order.line_items.map(item => ({
      ...item,
      product_tags: productTagsById[item.product_id] || ""
    }));

    /* ===== ORG + BOOSTER ===== */
    const isWeb = isWebsiteOrder(order);
    const orgFromItems = isWeb ? getOrgFromItems(line_items) : "";
    const foundOrgTags = isWeb ? getFoundOrgTags(line_items) : [];

    const staEligibleSubtotal = isWeb
      ? getSubtotalByTag(line_items, BOOSTER_ELIGIBLE_TAG)
      : 0;

    const savedPercentRaw = saved.booster_percent ?? "";
    const boosterPercentDecimal = toPercentNumber(savedPercentRaw);

    const computedBoosterAmount =
      isWeb && staEligibleSubtotal > 0 && boosterPercentDecimal !== null
        ? roundMoney(staEligibleSubtotal * boosterPercentDecimal)
        : 0;

    const defaultBoosterStatus = !isWeb
      ? "not eligible"
      : foundOrgTags.length > 1
        ? "manual review"
        : foundOrgTags.includes("STA")
          ? "needs approval"
          : "not eligible";

    const merged = {
      id: order.id,
      name: order.name,
      tags: order.tags || "",

      is_website_order: isWeb,

      // org tagging logic
      organization_tag: saved.organization_tag || orgFromItems,
      recognized_org_tags: foundOrgTags,
      suggested_order_tags: foundOrgTags,

      // booster logic
      booster_status: saved.booster_status || defaultBoosterStatus,
      booster_percent: savedPercentRaw,
      booster_percent_decimal: boosterPercentDecimal,
      booster_eligible_subtotal: saved.booster_eligible_subtotal ?? staEligibleSubtotal,
      booster_credit_amount:
        saved.booster_credit_amount !== undefined &&
        saved.booster_credit_amount !== null &&
        saved.booster_credit_amount !== ""
          ? parseAmount(saved.booster_credit_amount)
          : computedBoosterAmount,
      booster_is_sta_eligible: isWeb && staEligibleSubtotal > 0,

      line_items,
      client_contacts: contactData.client_contacts,
      organizations: contactData.organizations
    };

    return res.status(200).json({ order: merged });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
