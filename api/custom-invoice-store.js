import { put } from "@vercel/blob";
import { clean } from "./shared-utils.js";

const CUSTOM_INVOICE_INDEX_PATH = "custom-invoices/index.json";
const CUSTOM_INVOICE_SENDERS_PATH = "custom-invoices/senders.json";
const CUSTOM_INVOICE_NUMBER_PATTERN = /^([A-Z0-9]+)-(\d{2})-(\d+)$/i;

function parseAmount(value) {
  if (value === null || value === undefined || value === "") return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;

  const cleaned = String(value).replace(/[^0-9.-]/g, "");
  if (!cleaned) return 0;

  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
}

function roundMoney(value) {
  return Number(parseAmount(value).toFixed(2));
}

function normalizeInvoicePrefix(value) {
  const cleaned = clean(value).toUpperCase().replace(/[^A-Z0-9]/g, "");
  return cleaned || "CUS";
}

function getInvoiceYearSuffix(baseDate) {
  const date = baseDate ? new Date(baseDate) : new Date();
  const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;
  return String(safeDate.getFullYear()).slice(-2);
}

function parseCustomInvoiceSequence(invoiceNumber, expectedPrefix, expectedYearSuffix) {
  const match = clean(invoiceNumber).match(CUSTOM_INVOICE_NUMBER_PATTERN);
  if (!match) return null;
  if (normalizeInvoicePrefix(match[1]) !== normalizeInvoicePrefix(expectedPrefix)) return null;
  if (clean(match[2]) !== clean(expectedYearSuffix)) return null;

  const sequence = Number.parseInt(match[3], 10);
  return Number.isFinite(sequence) && sequence > 0 ? sequence : null;
}

function normalizeLineItem(item = {}, index = 0) {
  const quantity = parseAmount(item.quantity);
  const unitPrice = parseAmount(item.unit_price ?? item.unitPrice);
  const lineTotal = roundMoney((quantity || 0) * (unitPrice || 0));

  return {
    id: clean(item.id) || `line_${Date.now()}_${index}`,
    description: clean(item.description || item.name || item.title),
    quantity: quantity || 0,
    unit_price: roundMoney(unitPrice),
    line_total: lineTotal
  };
}

function normalizeSender(sender = {}) {
  return {
    id: clean(sender.id),
    name: clean(sender.name),
    invoice_prefix: normalizeInvoicePrefix(sender.invoice_prefix),
    phone: clean(sender.phone),
    email: clean(sender.email),
    address: clean(sender.address),
    payment_info: clean(sender.payment_info),
    checks_payable_to: clean(sender.checks_payable_to)
  };
}

function normalizeInvoiceRecord(payload = {}, { id, createdAt } = {}) {
  const lineItems = Array.isArray(payload.line_items)
    ? payload.line_items.map((item, index) => normalizeLineItem(item, index)).filter((item) => {
        return item.description || item.quantity || item.unit_price || item.line_total;
      })
    : [];

  const subtotal = roundMoney(lineItems.reduce((sum, item) => sum + parseAmount(item.line_total), 0));
  const discount = roundMoney(payload.discount);
  const shipping = roundMoney(payload.shipping);
  const tax = roundMoney(payload.tax);
  const total = roundMoney(subtotal - discount + shipping + tax);
  const now = new Date().toISOString();

  return {
    id: clean(id || payload.id),
    invoice_number: clean(payload.invoice_number),
    invoice_date: clean(payload.invoice_date),
    due_date: clean(payload.due_date),
    billed_to: clean(payload.billed_to),
    prepared_for: clean(payload.prepared_for),
    email: clean(payload.email),
    phone: clean(payload.phone),
    address: clean(payload.address),
    reference: clean(payload.reference),
    memo: clean(payload.memo),
    notes: clean(payload.notes),
    sender_profile_id: clean(payload.sender_profile_id),
    sender: normalizeSender(payload.sender),
    line_items: lineItems,
    subtotal,
    discount,
    shipping,
    tax,
    total,
    updated_at: now,
    created_at: clean(createdAt || payload.created_at) || now
  };
}

function getCustomInvoicePath(id) {
  return `custom-invoices/invoices/${clean(id)}.json`;
}

async function readPrivatePath(path) {
  const baseUrl = process.env.BLOB_BASE_URL;
  const token = process.env.BLOB_READ_WRITE_TOKEN;

  if (!baseUrl || !token) {
    throw new Error("Missing BLOB_BASE_URL or BLOB_READ_WRITE_TOKEN");
  }

  const response = await fetch(`${baseUrl}/${path}?ts=${Date.now()}`, {
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

export function generateCustomInvoiceId() {
  return `ci_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function generateNextCustomInvoiceNumber(existingInvoices = [], baseDate = "", prefix = "CUS") {
  const yearSuffix = getInvoiceYearSuffix(baseDate);
  const normalizedPrefix = normalizeInvoicePrefix(prefix);
  const highestSequence = (Array.isArray(existingInvoices) ? existingInvoices : []).reduce((max, invoice) => {
    const sequence = parseCustomInvoiceSequence(invoice?.invoice_number, normalizedPrefix, yearSuffix);
    return sequence && sequence > max ? sequence : max;
  }, 0);

  return `${normalizedPrefix}-${yearSuffix}-${highestSequence + 1}`;
}

export async function readCustomInvoice(id) {
  if (!clean(id)) return null;
  return readPrivatePath(getCustomInvoicePath(id)).catch(() => null);
}

export async function readCustomInvoiceIndex() {
  const data = await readPrivatePath(CUSTOM_INVOICE_INDEX_PATH).catch(() => null);
  return Array.isArray(data?.invoices) ? data.invoices : [];
}

export async function writeCustomInvoiceIndex(entries = []) {
  await writePrivatePath(CUSTOM_INVOICE_INDEX_PATH, {
    updated_at: new Date().toISOString(),
    invoices: entries
  });
}

export function buildCustomInvoiceIndexEntry(record = {}) {
  return {
    id: clean(record.id),
    invoice_number: clean(record.invoice_number),
    invoice_date: clean(record.invoice_date),
    due_date: clean(record.due_date),
    billed_to: clean(record.billed_to),
    prepared_for: clean(record.prepared_for),
    total: roundMoney(record.total),
    updated_at: clean(record.updated_at),
    created_at: clean(record.created_at)
  };
}

export async function saveCustomInvoiceRecord(payload = {}, existingRecord = null) {
  const id = clean(existingRecord?.id || payload.id || generateCustomInvoiceId());
  const existingInvoices = await readCustomInvoiceIndex();
  const resolvedSender = normalizeSender(payload.sender || existingRecord?.sender || {});
  const resolvedInvoiceNumber = clean(existingRecord?.invoice_number || payload.invoice_number) || generateNextCustomInvoiceNumber(
    existingInvoices.filter((entry) => clean(entry?.id) !== id),
    payload.invoice_date || existingRecord?.invoice_date || new Date().toISOString()
    ,
    resolvedSender.invoice_prefix
  );
  const normalized = normalizeInvoiceRecord(payload, {
    id,
    createdAt: existingRecord?.created_at
  });
  normalized.sender = resolvedSender;
  normalized.invoice_number = resolvedInvoiceNumber;

  await writePrivatePath(getCustomInvoicePath(id), normalized);

  const nextEntry = buildCustomInvoiceIndexEntry(normalized);
  const existingIndex = existingInvoices.findIndex((entry) => clean(entry?.id) === id);

  if (existingIndex >= 0) {
    existingInvoices[existingIndex] = nextEntry;
  } else {
    existingInvoices.push(nextEntry);
  }

  existingInvoices.sort((a, b) => {
    const timeDiff = new Date(b.updated_at || 0).getTime() - new Date(a.updated_at || 0).getTime();
    if (timeDiff !== 0) return timeDiff;
    return clean(b.id).localeCompare(clean(a.id));
  });

  await writeCustomInvoiceIndex(existingInvoices);
  return normalized;
}

export async function readCustomInvoiceSenders() {
  const data = await readPrivatePath(CUSTOM_INVOICE_SENDERS_PATH).catch(() => null);
  return Array.isArray(data?.senders) ? data.senders : [];
}

export async function saveCustomInvoiceSender(payload = {}) {
  const senders = await readCustomInvoiceSenders();
  const name = clean(payload.name);

  if (!name) {
    throw new Error("Sender name is required.");
  }

  const record = {
    id: clean(payload.id) || `sender_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    name,
    invoice_prefix: normalizeInvoicePrefix(payload.invoice_prefix),
    phone: clean(payload.phone),
    email: clean(payload.email),
    address: clean(payload.address),
    payment_info: clean(payload.payment_info),
    checks_payable_to: clean(payload.checks_payable_to),
    updated_at: new Date().toISOString(),
    created_at: clean(payload.created_at) || new Date().toISOString()
  };

  const existingIndex = senders.findIndex((sender) => {
    return clean(sender?.id) === record.id || clean(sender?.name).toLowerCase() === record.name.toLowerCase();
  });

  if (existingIndex >= 0) {
    record.created_at = clean(senders[existingIndex]?.created_at) || record.created_at;
    senders[existingIndex] = { ...senders[existingIndex], ...record };
  } else {
    senders.push(record);
  }

  senders.sort((a, b) => clean(a.name).localeCompare(clean(b.name)));

  await writePrivatePath(CUSTOM_INVOICE_SENDERS_PATH, {
    updated_at: new Date().toISOString(),
    senders
  });

  return record;
}
