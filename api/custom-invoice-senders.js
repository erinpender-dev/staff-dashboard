import { clean, setCors } from "./shared-utils.js";
import {
  readCustomInvoiceSenders,
  saveCustomInvoiceSender
} from "./custom-invoice-store.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  try {
    if (req.method === "GET") {
      const senders = await readCustomInvoiceSenders();
      return res.status(200).json({
        ok: true,
        senders
      });
    }

    if (req.method === "POST") {
      const payload = req.body || {};
      if (!clean(payload.name)) {
        return res.status(400).json({ error: "Sender name is required." });
      }

      const sender = await saveCustomInvoiceSender(payload);
      const senders = await readCustomInvoiceSenders();
      return res.status(200).json({
        ok: true,
        sender,
        senders
      });
    }

    return res.status(405).json({ error: "Method not allowed." });
  } catch (error) {
    return res.status(500).json({
      error: error.message || "Could not save custom invoice sender."
    });
  }
}
