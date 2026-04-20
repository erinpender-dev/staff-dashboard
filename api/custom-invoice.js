import { clean, setCors } from "./shared-utils.js";
import {
  buildCustomInvoiceIndexEntry,
  readCustomInvoice,
  readCustomInvoiceIndex,
  saveCustomInvoiceRecord
} from "./custom-invoice-store.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PUT, OPTIONS");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
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
      const invoice = await saveCustomInvoiceRecord(req.body || {});
      return res.status(201).json({
        ok: true,
        invoice,
        summary: buildCustomInvoiceIndexEntry(invoice)
      });
    }

    if (req.method === "PUT") {
      const id = clean(req.query?.id || req.body?.id);
      if (!id) {
        return res.status(400).json({ error: "Custom invoice id is required." });
      }

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
    return res.status(500).json({
      error: error.message || "Could not load custom invoice."
    });
  }
}
