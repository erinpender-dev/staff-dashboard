import {
  clientError,
  clean,
  isValidSimpleId,
  rateLimit,
  requireDashboardAuth,
  requireJsonRequest,
  serverError,
  setCors,
  setNoStore,
  validateAllowedKeys
} from "./shared-utils.js";
import {
  deleteCustomInvoiceSender,
  readCustomInvoiceSenders,
  saveCustomInvoiceSender
} from "./custom-invoice-store.js";

const SENDER_FIELDS = [
  "id",
  "label",
  "name",
  "invoice_prefix",
  "phone",
  "email",
  "address",
  "payment_info",
  "checks_payable_to",
  "created_at"
];

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PUT, DELETE, OPTIONS");
  setNoStore(res);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (!rateLimit(req, res) || !requireDashboardAuth(req, res)) {
    return;
  }

  try {
    if (req.method === "GET") {
      const senders = await readCustomInvoiceSenders();
      return res.status(200).json({
        ok: true,
        senders
      });
    }

    if (req.method === "POST" || req.method === "PUT") {
      if (!requireJsonRequest(req, res)) return;
      const payload = req.body || {};
      const unexpectedFields = validateAllowedKeys(payload, SENDER_FIELDS);
      if (unexpectedFields.length) {
        return clientError(res, 400, `Unexpected field: ${unexpectedFields[0]}`);
      }

      if (clean(payload.id) && !isValidSimpleId(payload.id)) {
        return clientError(res, 400, "Invalid sender id.");
      }

      if (!clean(payload.label || payload.name) || !clean(payload.name)) {
        return res.status(400).json({ error: "Sender profile label and sender name are required." });
      }

      const sender = await saveCustomInvoiceSender(payload);
      const senders = await readCustomInvoiceSenders();
      return res.status(200).json({
        ok: true,
        sender,
        senders
      });
    }

    if (req.method === "DELETE") {
      const senderId = clean(req.query?.id || req.body?.id);
      if (!senderId) {
        return res.status(400).json({ error: "Sender id is required." });
      }
      if (!isValidSimpleId(senderId)) {
        return clientError(res, 400, "Invalid sender id.");
      }

      const senders = await deleteCustomInvoiceSender(senderId);
      return res.status(200).json({
        ok: true,
        senders
      });
    }

    return res.status(405).json({ error: "Method not allowed." });
  } catch (error) {
    return serverError(res, "Could not save custom invoice sender.");
  }
}
