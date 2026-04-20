import { put } from "@vercel/blob";
import {
  clean,
  getOrderDetailsPath,
  parseJsonSafe,
  readPrivateJson,
  setCors
} from "./shared-utils.js";

function parseAmount(value) {
  if (value === null || value === undefined || value === "") return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;

  const cleaned = String(value).replace(/[^0-9.-]/g, "");
  if (!cleaned) return 0;

  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatAmount(value) {
  const amount = Number(value || 0);
  return amount.toFixed(2);
}

function normalizeLower(value) {
  return clean(value).toLowerCase();
}

function parseTags(value) {
  if (Array.isArray(value)) {
    return value.map((tag) => clean(tag)).filter(Boolean);
  }

  return clean(value)
    .split(",")
    .map((tag) => clean(tag))
    .filter(Boolean);
}

function buildTagsString(tags = []) {
  return [...new Set((Array.isArray(tags) ? tags : []).map((tag) => clean(tag)).filter(Boolean))].join(", ");
}

function getLoggedPayments(normalized = {}) {
  const partialPayments = Array.isArray(normalized.partial_payments) ? normalized.partial_payments : [];
  if (partialPayments.length) return partialPayments;

  const singlePayment = {
    type: clean(normalized.payment_received_type),
    amount: clean(normalized.payment_received_amount),
    check_number: clean(normalized.payment_received_check_number),
    note: clean(normalized.payment_received_note),
    booster_account_name: clean(normalized.booster_payment_account_name)
  };

  if (
    singlePayment.type ||
    singlePayment.amount ||
    singlePayment.check_number ||
    singlePayment.note ||
    singlePayment.booster_account_name
  ) {
    return [singlePayment];
  }

  return [];
}

function getLoggedPaymentTotal(normalized = {}) {
  return getLoggedPayments(normalized).reduce((sum, payment) => sum + parseAmount(payment?.amount), 0);
}

const BOOSTER_ACCOUNTS_PATH = "booster-club/accounts.json";
const BOOSTER_LEDGER_PATH = "booster-club/ledger.json";

async function readPrivatePath(path) {
  const baseUrl = process.env.BLOB_BASE_URL;
  const token = process.env.BLOB_READ_WRITE_TOKEN;

  if (!baseUrl || !token) {
    throw new Error("Missing BLOB_BASE_URL or BLOB_READ_WRITE_TOKEN");
  }

  const url = `${baseUrl}/${path}`;
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

async function writePrivatePath(path, data) {
  await put(path, JSON.stringify(data, null, 2), {
    access: "private",
    contentType: "application/json",
    token: process.env.BLOB_READ_WRITE_TOKEN,
    addRandomSuffix: false,
    allowOverwrite: true
  });
}

async function readBoosterAccounts() {
  const data = await readPrivatePath(BOOSTER_ACCOUNTS_PATH).catch(() => null);
  return Array.isArray(data?.accounts) ? data.accounts : [];
}

async function writeBoosterAccounts(accounts) {
  await writePrivatePath(BOOSTER_ACCOUNTS_PATH, {
    updated_at: new Date().toISOString(),
    accounts
  });
}

async function readBoosterLedger() {
  const data = await readPrivatePath(BOOSTER_LEDGER_PATH).catch(() => null);
  return Array.isArray(data?.entries) ? data.entries : [];
}

async function writeBoosterLedger(entries) {
  await writePrivatePath(BOOSTER_LEDGER_PATH, {
    updated_at: new Date().toISOString(),
    entries
  });
}

function getLedgerBalances(entries = []) {
  return entries.reduce((acc, entry) => {
    const accountName = clean(entry?.account_name);
    if (!accountName) return acc;
    acc[accountName] = (acc[accountName] || 0) + parseAmount(entry?.amount);
    return acc;
  }, {});
}

function ensureBoosterAccount(accounts = [], name = "") {
  const accountName = clean(name);
  if (!accountName) return accounts;

  const exists = accounts.some((account) => normalizeLower(account?.name) === normalizeLower(accountName));
  if (exists) return accounts;

  return [
    ...accounts,
    {
      name: accountName,
      organization: "sta",
      status: "active",
      created_at: new Date().toISOString()
    }
  ];
}

function getOrderTotalFromShopifyOrder(order) {
  return parseAmount(order?.current_total_price || order?.total_price);
}

function getBoosterCreditAmount(orderTotal, percentage) {
  const total = parseAmount(orderTotal);
  const percent = parseAmount(percentage);
  if (total <= 0 || percent <= 0) return 0;
  return Number(((total * percent) / 100).toFixed(2));
}

function buildLedgerEntry({
  type,
  accountName,
  orderId,
  amount,
  note = "",
  meta = {}
}) {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    created_at: new Date().toISOString(),
    type,
    account_name: clean(accountName),
    order_id: clean(orderId),
    amount: formatAmount(amount),
    note: clean(note),
    meta
  };
}

async function syncBoosterLedger({ existing = {}, normalized, orderId, orderTotal, syncPayment = true }) {
  let accounts = await readBoosterAccounts();
  let ledgerEntries = await readBoosterLedger();
  const balances = getLedgerBalances(ledgerEntries);
  const pendingEntries = [];

  const existingCreditAccount = clean(
    existing.booster_credit_synced_account || existing.booster_account_name
  );
  const existingCreditAmount = parseAmount(
    existing.booster_credit_synced_amount || existing.booster_credit_amount
  );
  const nextCreditAccount = clean(normalized.booster_account_name);
  const nextCreditAmount =
    normalizeLower(normalized.booster_credit_status) === "approved" && nextCreditAccount
      ? getBoosterCreditAmount(orderTotal, normalized.booster_credit_percentage)
      : 0;

  const existingPaymentAccount = clean(
    existing.booster_payment_synced_account || existing.booster_payment_account_name
  );
  const existingPaymentAmount = parseAmount(
    existing.booster_payment_synced_amount || existing.payment_received_amount
  );
  const nextPaymentAccount =
    syncPayment && normalizeLower(normalized.payment_received_type) === "booster club"
      ? clean(normalized.booster_payment_account_name || normalized.booster_account_name)
      : "";
  const nextPaymentAmount =
    syncPayment && normalizeLower(normalized.payment_received_type) === "booster club"
      ? parseAmount(normalized.payment_received_amount)
      : 0;

  accounts = ensureBoosterAccount(accounts, nextCreditAccount);
  accounts = ensureBoosterAccount(accounts, nextPaymentAccount);

  if (existingCreditAccount && existingCreditAmount > 0) {
    pendingEntries.push(
      buildLedgerEntry({
        type: "credit_reversal",
        accountName: existingCreditAccount,
        orderId,
        amount: -existingCreditAmount,
        note: "Reversed prior approved booster credit"
      })
    );
    balances[existingCreditAccount] = (balances[existingCreditAccount] || 0) - existingCreditAmount;
  }

  if (nextCreditAccount && nextCreditAmount > 0) {
    pendingEntries.push(
      buildLedgerEntry({
        type: "credit_approved",
        accountName: nextCreditAccount,
        orderId,
        amount: nextCreditAmount,
        note: "Approved booster credit from order",
        meta: {
          percentage: clean(normalized.booster_credit_percentage),
          order_total: formatAmount(orderTotal)
        }
      })
    );
    balances[nextCreditAccount] = (balances[nextCreditAccount] || 0) + nextCreditAmount;
  }

  if (syncPayment && existingPaymentAccount && existingPaymentAmount > 0) {
    pendingEntries.push(
      buildLedgerEntry({
        type: "payment_reversal",
        accountName: existingPaymentAccount,
        orderId,
        amount: existingPaymentAmount,
        note: "Reversed prior booster club payment"
      })
    );
    balances[existingPaymentAccount] = (balances[existingPaymentAccount] || 0) + existingPaymentAmount;
  }

  if (syncPayment && nextPaymentAccount && nextPaymentAmount > 0) {
    const available = balances[nextPaymentAccount] || 0;
    if (available < nextPaymentAmount) {
      throw new Error(`Booster account "${nextPaymentAccount}" only has $${formatAmount(available)} available.`);
    }

    pendingEntries.push(
      buildLedgerEntry({
        type: "payment_applied",
        accountName: nextPaymentAccount,
        orderId,
        amount: -nextPaymentAmount,
        note: "Applied booster club balance to order"
      })
    );
    balances[nextPaymentAccount] = available - nextPaymentAmount;
  }

  if (pendingEntries.length) {
    ledgerEntries = [...ledgerEntries, ...pendingEntries];
    await writeBoosterLedger(ledgerEntries);
  }

  await writeBoosterAccounts(accounts);

  return {
    normalized: {
      ...normalized,
      booster_credit_amount: nextCreditAmount > 0 ? formatAmount(nextCreditAmount) : "",
      booster_credit_synced_account: nextCreditAmount > 0 ? nextCreditAccount : "",
      booster_credit_synced_amount: nextCreditAmount > 0 ? formatAmount(nextCreditAmount) : "",
      booster_payment_account_name: syncPayment ? nextPaymentAccount : clean(existing.booster_payment_account_name),
      booster_payment_synced_account: syncPayment
        ? (nextPaymentAmount > 0 ? nextPaymentAccount : "")
        : clean(existing.booster_payment_synced_account),
      booster_payment_synced_amount: syncPayment
        ? (nextPaymentAmount > 0 ? formatAmount(nextPaymentAmount) : "")
        : clean(existing.booster_payment_synced_amount)
    },
    ledger_entries_added: pendingEntries.length
  };
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
      check_number: clean(payment?.check_number),
      note: clean(payment?.note),
      booster_account_name: clean(payment?.booster_account_name)
    }))
    .filter((payment) => payment.type || payment.amount || payment.check_number || payment.note || payment.booster_account_name);
}

function normalize(body = {}, existing = {}) {
  const has = (key) => Object.prototype.hasOwnProperty.call(body, key);

  return {
    custom_customer_name: has("custom_customer_name")
      ? clean(body.custom_customer_name)
      : clean(existing.custom_customer_name),

    custom_customer_email: has("custom_customer_email")
      ? clean(body.custom_customer_email)
      : clean(existing.custom_customer_email),

    custom_customer_phone: has("custom_customer_phone")
      ? clean(body.custom_customer_phone)
      : clean(existing.custom_customer_phone),

    prepared_for: has("prepared_for")
      ? clean(body.prepared_for)
      : clean(existing.prepared_for),

    reference: has("reference")
      ? clean(body.reference)
      : clean(existing.reference),

    school: has("school")
      ? clean(body.school)
      : clean(existing.school),

    sent_with: has("sent_with")
      ? clean(body.sent_with)
      : clean(existing.sent_with),

    delivery_notes: has("delivery_notes")
      ? clean(body.delivery_notes)
      : clean(existing.delivery_notes),

    staff_notes: has("staff_notes")
      ? clean(body.staff_notes)
      : clean(existing.staff_notes),

    production_notes: has("production_notes")
      ? clean(body.production_notes)
      : clean(existing.production_notes),

    internal_order_status: has("internal_order_status")
      ? clean(body.internal_order_status).toLowerCase()
      : clean(existing.internal_order_status).toLowerCase(),

    internal_payment_status: has("internal_payment_status")
      ? clean(body.internal_payment_status).toLowerCase()
      : clean(existing.internal_payment_status).toLowerCase(),

    booster_credit_percentage: has("booster_credit_percentage")
      ? clean(body.booster_credit_percentage)
      : clean(existing.booster_credit_percentage),

    booster_credit_status: has("booster_credit_status")
      ? clean(body.booster_credit_status).toLowerCase()
      : clean(existing.booster_credit_status).toLowerCase(),

    booster_account_name: has("booster_account_name")
      ? clean(body.booster_account_name)
      : clean(existing.booster_account_name),

    booster_credit_amount: has("booster_credit_amount")
      ? clean(body.booster_credit_amount)
      : clean(existing.booster_credit_amount),

    booster_credit_synced_account: clean(existing.booster_credit_synced_account),
    booster_credit_synced_amount: clean(existing.booster_credit_synced_amount),

    booster_payment_account_name: has("booster_payment_account_name")
      ? clean(body.booster_payment_account_name)
      : clean(existing.booster_payment_account_name),

    booster_payment_synced_account: clean(existing.booster_payment_synced_account),
    booster_payment_synced_amount: clean(existing.booster_payment_synced_amount),

    payment_received_type: has("payment_received_type")
      ? clean(body.payment_received_type)
      : clean(existing.payment_received_type),

    payment_received_amount: has("payment_received_amount")
      ? clean(body.payment_received_amount)
      : clean(existing.payment_received_amount),

    payment_received_note: has("payment_received_note")
      ? clean(body.payment_received_note)
      : clean(existing.payment_received_note),

    payment_received_check_number: has("payment_received_check_number")
      ? clean(body.payment_received_check_number)
      : clean(existing.payment_received_check_number),

    partial_payments: has("partial_payments")
      ? normalizePartialPayments(body.partial_payments)
      : normalizePartialPayments(existing.partial_payments),

    client_contacts: has("client_contacts")
      ? normalizeContacts(body.client_contacts)
      : normalizeContacts(existing.client_contacts),

    contact_cards: has("contact_cards")
      ? normalizeContacts(body.contact_cards)
      : normalizeContacts(existing.contact_cards),

    contacts: has("contacts")
      ? normalizeContacts(body.contacts)
      : normalizeContacts(existing.contacts),

    custom_contacts: has("custom_contacts")
      ? normalizeContacts(body.custom_contacts)
      : normalizeContacts(existing.custom_contacts),

    metafield_contacts: has("metafield_contacts")
      ? normalizeContacts(body.metafield_contacts)
      : normalizeContacts(existing.metafield_contacts),

    dashboard_contacts: has("dashboard_contacts")
      ? normalizeContacts(body.dashboard_contacts)
      : normalizeContacts(existing.dashboard_contacts),

    order_contacts: has("order_contacts")
      ? normalizeContacts(body.order_contacts)
      : normalizeContacts(existing.order_contacts),

    organizations: has("organizations")
      ? (Array.isArray(body.organizations)
          ? body.organizations.map((value) => clean(value)).filter(Boolean)
          : [])
      : (Array.isArray(existing.organizations)
          ? existing.organizations.map((value) => clean(value)).filter(Boolean)
          : []),

    updated_at: new Date().toISOString()
  };
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

function fieldMapFromMetaobject(metaobject) {
  const map = {};
  const fields = Array.isArray(metaobject?.fields) ? metaobject.fields : [];
  for (const field of fields) {
    map[field.key] = field;
  }
  return map;
}

function organizationFromMetaobject(metaobject) {
  if (!metaobject) return null;
  const fields = fieldMapFromMetaobject(metaobject);

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

async function getOrderContactMeta(shop, token, orderId) {
  const query = `
    query OrderContactInfo($id: ID!) {
      order(id: $id) {
        id
        metafield(namespace: "custom", key: "client_contact_information") {
          id
          type
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
                references(first: 20) {
                  nodes {
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

  const data = await shopifyGraphQL(shop, token, query, {
    id: `gid://shopify/Order/${orderId}`
  });

  const contactMeta = data?.order?.metafield?.reference;
  if (!contactMeta) {
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

  const fields = fieldMapFromMetaobject(contactMeta);

  const name = clean(
    fields.name?.value ||
    fields.full_name?.value ||
    fields.contact_name?.value ||
    fields.customer_name?.value
  );
  const email = clean(
    fields.email?.value ||
    fields.email_address?.value ||
    fields.contact_email?.value
  );
  const phone = clean(
    fields.phone_number?.value ||
    fields.phone?.value ||
    fields.contact_phone?.value
  );

  const organizations = [];
  const orgField = fields.organization || fields.organizations;

  if (Array.isArray(orgField?.references?.nodes) && orgField.references.nodes.length) {
    for (const node of orgField.references.nodes) {
      const org = organizationFromMetaobject(node);
      if (org?.name || org?.handle || org?.id) {
        organizations.push(org.name || org.handle || org.id);
      }
    }
  } else if (orgField?.reference) {
    const org = organizationFromMetaobject(orgField.reference);
    if (org?.name || org?.handle || org?.id) {
      organizations.push(org.name || org.handle || org.id);
    }
  }

  const primaryContact = normalizeContact({
    name,
    email,
    phone,
    organization: organizations[0] || "",
    title: "",
    role: ""
  });

  const contacts = primaryContact.name || primaryContact.email || primaryContact.phone
    ? [primaryContact]
    : [];

  return {
    custom_customer_name: name,
    custom_customer_email: email,
    custom_customer_phone: phone,
    client_contacts: contacts,
    contact_cards: contacts,
    contacts,
    custom_contacts: [],
    metafield_contacts: contacts,
    dashboard_contacts: [],
    order_contacts: contacts,
    organizations
  };
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

async function updateOrderTags(shop, token, orderId, tags = []) {
  const response = await fetch(`https://${shop}/admin/api/2025-10/orders/${orderId}.json`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token
    },
    body: JSON.stringify({
      order: {
        id: Number(orderId),
        tags: buildTagsString(tags)
      }
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Could not update tags: ${text}`);
  }

  const json = await response.json().catch(() => ({}));
  return {
    ok: true,
    tags: buildTagsString(parseTags(json?.order?.tags || tags))
  };
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
    mutation CreateFulfillment($fulfillment: FulfillmentV2Input!) {
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
  setCors(req, res, "GET, POST, OPTIONS");

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

      const [saved, metafieldData] = await Promise.all([
        readPrivateJson(orderId).catch(() => null),
        getOrderContactMeta(shop, token, orderId).catch(() => ({
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
        }))
      ]);

      const merged = {
        ...(saved || {}),
        ...metafieldData,
        custom_customer_name: metafieldData.custom_customer_name,
        custom_customer_email: metafieldData.custom_customer_email,
        custom_customer_phone: metafieldData.custom_customer_phone,
        client_contacts: metafieldData.client_contacts,
        contact_cards: metafieldData.contact_cards,
        contacts: metafieldData.contacts,
        metafield_contacts: metafieldData.metafield_contacts,
        order_contacts: metafieldData.order_contacts,
        organizations: metafieldData.organizations,
        booster_account_name: clean(saved?.booster_account_name),
        booster_credit_percentage: clean(saved?.booster_credit_percentage),
        booster_credit_status: clean(saved?.booster_credit_status),
        booster_credit_amount: clean(saved?.booster_credit_amount),
        booster_payment_account_name: clean(saved?.booster_payment_account_name)
      };

      res.status(200).json({ ok: true, data: merged });
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

    const existing = await readPrivateJson(orderId).catch(() => null);
    const shopifyOrder = await getOrderById(shop, token, orderId);
    const normalized = normalize(req.body, existing || {});
    const saveScope = clean(req.body?.save_scope);
    const boosterSync = await syncBoosterLedger({
      existing: existing || {},
      normalized,
      orderId,
      orderTotal: getOrderTotalFromShopifyOrder(shopifyOrder),
      syncPayment: saveScope !== "booster_credit"
    });
    const finalNormalized = boosterSync.normalized;
    const path = getOrderDetailsPath(orderId);

    await put(path, JSON.stringify(finalNormalized, null, 2), {
      access: "private",
      contentType: "application/json",
      token: process.env.BLOB_READ_WRITE_TOKEN,
      addRandomSuffix: false,
      allowOverwrite: true
    });

    const syncResults = {
      saved_to_blob: true,
      booster_ledger_sync: { ok: true, entries_added: boosterSync.ledger_entries_added },
      shopify_paid_sync: null,
      shopify_tag_sync: null,
      shopify_fulfillment_sync: null
    };

    const paymentStatus = clean(finalNormalized.internal_payment_status).toLowerCase();
    const orderStatus = clean(finalNormalized.internal_order_status).toLowerCase();
    const orderTotal = getOrderTotalFromShopifyOrder(shopifyOrder);
    const loggedPaymentTotal = getLoggedPaymentTotal(finalNormalized);
    const isFullyCovered = orderTotal <= 0 || loggedPaymentTotal + 0.0001 >= orderTotal;
    const isPartiallyPaid = loggedPaymentTotal > 0 && !isFullyCovered;
    const existingTags = parseTags(shopifyOrder.tags);
    const nextTags = existingTags.filter((tag) => normalizeLower(tag) !== "partially paid");
    if (isPartiallyPaid) {
      nextTags.push("Partially Paid");
    }

    const shouldMarkPaid = paymentStatus === "payment received" && isFullyCovered;
    const shouldFulfill = orderStatus === "order complete";

    if (buildTagsString(existingTags) !== buildTagsString(nextTags)) {
      try {
        syncResults.shopify_tag_sync = await updateOrderTags(shop, token, orderId, nextTags);
      } catch (error) {
        syncResults.shopify_tag_sync = { ok: false, error: error.message || "Could not update tags." };
      }
    } else {
      syncResults.shopify_tag_sync = { skipped: true };
    }

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
      data: finalNormalized,
      sync: syncResults
    });
    return;
  } catch (error) {
    res.status(500).json({
      error: error.message || "Could not save order details."
    });
  }
}
