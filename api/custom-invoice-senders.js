import { clean, setCors } from "./shared-utils.js";
import { requireInternalAuth } from "./_lib/internal-auth.js";
import {
  deleteCustomInvoiceSender,
  readCustomInvoiceSenders,
  saveCustomInvoiceSender
} from "./custom-invoice-store.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Cache-Control", "no-store, no-cache, max-age=0, must-revalidate");
  console.info("custom-invoice-senders request received", {
    method: req.method,
    hasOrigin: !!req.headers?.origin,
    hasAuthorization: !!(req.headers?.authorization || req.headers?.Authorization)
  });

  if (req.method === "OPTIONS") {
    console.info("custom-invoice-senders preflight ok");
    return res.status(200).end();
  }

  const auth = await requireInternalAuth(req, res);
  if (!auth) {
    console.warn("custom-invoice-senders auth failed");
    return;
  }
  console.info("custom-invoice-senders auth passed");

  try {
    if (req.method === "GET") {
      const senders = await readCustomInvoiceSenders();
      console.info("custom-invoice-senders GET ok", {
        count: Array.isArray(senders) ? senders.length : 0
      });
      return res.status(200).json({
        ok: true,
        senders
      });
    }

    if (req.method === "POST" || req.method === "PUT") {
      const payload = req.body || {};
      if (!clean(payload.label || payload.name) || !clean(payload.name)) {
        return res.status(400).json({ error: "Sender profile label and sender name are required." });
      }

      const sender = await saveCustomInvoiceSender(payload);
      const senders = await readCustomInvoiceSenders();
      console.info("custom-invoice-senders save ok", {
        method: req.method,
        count: Array.isArray(senders) ? senders.length : 0
      });
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

      const senders = await deleteCustomInvoiceSender(senderId);
      console.info("custom-invoice-senders delete ok", {
        count: Array.isArray(senders) ? senders.length : 0
      });
      return res.status(200).json({
        ok: true,
        senders
      });
    }

    console.warn("custom-invoice-senders method not allowed", {
      method: req.method
    });
    return res.status(405).json({ error: "Method not allowed." });
  } catch (error) {
    console.error("custom-invoice-senders route error", {
      message: error.message,
      stack: error.stack
    });
    return res.status(500).json({
      error: error.message || "Could not save custom invoice sender."
    });
  }
}
