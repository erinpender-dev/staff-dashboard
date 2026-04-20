import {
  clientError,
  clean,
  isValidSimpleId,
  rateLimit,
  requireJsonRequest,
  serverError,
  setCors,
  setNoStore,
  validateAllowedKeys
} from "./shared-utils.js";
import {
  buildCustomInvoiceIndexEntry,
  readCustomInvoice,
  readCustomInvoiceIndex,
  saveCustomInvoiceRecord
} from "./custom-invoice-store.js";

const CUSTOM_INVOICE_FIELDS = [
  "id",
  "invoice_number",
  "invoice_date",
  "due_date",
  "billed_to",
  "prepared_for",
  "email",
  "phone",
  "address",
  "reference",
  "memo",
  "notes",
  "sender_profile_id",
  "sender_profile_key",
  "sender_snapshot",
  "sender",
  "line_items",
  "discount",
  "shipping",
  "tax",
  "payment_status",
  "invoice_status",
  "created_at"
];

function validateInvoicePayload(body = {}) {
  const unexpectedFields = validateAllowedKeys(body, CUSTOM_INVOICE_FIELDS);
  if (unexpectedFields.length) return `Unexpected field: ${unexpectedFields[0]}`;

  if (Object.prototype.hasOwnProperty.call(body, "line_items") && !Array.isArray(body.line_items)) {
    return "Line items must be an array.";
  }

  if (Array.isArray(body.line_items) && body.line_items.length > 100) {
    return "Too many line items.";
  }

  return "";
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PUT, OPTIONS");
  setNoStore(res);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (!rateLimit(req, res)) {
    return;
  }

  try {
    if (req.method === "GET") {
      const id = clean(req.query?.id);

      if (!id) {
        const invoices = await readCustomInvoiceIndex();
        return res.status(200).json({
          ok: true,
          invoices
        });
      }

      if (!isValidSimpleId(id)) {
        return clientError(res, 400, "Invalid custom invoice id.");
      }

      const invoice = await readCustomInvoice(id);
      if (!invoice) {
        return res.status(404).json({ error: "Custom invoice not found." });
      }

      return res.status(200).json({
        ok: true,
        invoice
      });
    }

    if (req.method === "POST") {
      if (!requireJsonRequest(req, res)) return;
      const validationError = validateInvoicePayload(req.body || {});
      if (validationError) return clientError(res, 400, validationError);

      const invoice = await saveCustomInvoiceRecord(req.body || {});
      return res.status(201).json({
        ok: true,
        invoice,
        summary: buildCustomInvoiceIndexEntry(invoice)
      });
    }

    if (req.method === "PUT") {
      if (!requireJsonRequest(req, res)) return;
      const id = clean(req.query?.id || req.body?.id);
      if (!id) {
        return res.status(400).json({ error: "Custom invoice id is required." });
      }
      if (!isValidSimpleId(id)) {
        return clientError(res, 400, "Invalid custom invoice id.");
      }

      const validationError = validateInvoicePayload(req.body || {});
      if (validationError) return clientError(res, 400, validationError);

      const existing = await readCustomInvoice(id);
      if (!existing) {
        return res.status(404).json({ error: "Custom invoice not found." });
      }

      const invoice = await saveCustomInvoiceRecord({ ...(req.body || {}), id }, existing);
      return res.status(200).json({
        ok: true,
        invoice,
        summary: buildCustomInvoiceIndexEntry(invoice)
      });
    }

    return res.status(405).json({ error: "Method not allowed." });
  } catch (error) {
    return serverError(res, "Could not load custom invoice.");
  }
}
