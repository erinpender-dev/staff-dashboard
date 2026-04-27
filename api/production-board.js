import { get, put } from "@vercel/blob";
import { requireInternalAuth } from "./_lib/internal-auth.js";
import { clean, setCors } from "./shared-utils.js";

const PRODUCTION_BOARD_PATH = "production-board/cards.json";

const PRODUCTION_STATUSES = [
  "new",
  "waiting_design",
  "waiting_materials",
  "ready_production",
  "in_production",
  "production_finished",
  "ready_pickup_send",
  "completed_archived"
];

const DESIGN_STATUSES = ["not_started", "needed", "in_progress", "approved", "not_needed"];
const MATERIAL_STATUSES = ["unknown", "needed", "ordered", "ready", "not_needed"];
const SUPPLY_STATUSES = ["unknown", "needed", "ordered", "ready", "not_needed"];

function normalizeChoice(value, allowed, fallback) {
  const normalized = clean(value).toLowerCase().replace(/\s+/g, "_").replace(/-/g, "_");
  return allowed.includes(normalized) ? normalized : fallback;
}

function normalizeRecordType(value) {
  const normalized = clean(value).toLowerCase();
  if (normalized === "draft" || normalized === "draft_order") return "draft_order";
  if (normalized === "manual") return "manual";
  return "order";
}

function sourceKey(recordType, sourceId) {
  const type = normalizeRecordType(recordType);
  const id = clean(sourceId);
  return type === "manual" ? "" : `${type}:${id}`;
}

function generateCardId() {
  return `prod_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function readPrivatePath(path) {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) throw new Error("Missing BLOB_READ_WRITE_TOKEN");

  const result = await get(path, {
    access: "private",
    token,
    useCache: false,
    headers: { "Cache-Control": "no-cache" }
  });

  if (!result?.stream) return null;
  return await new Response(result.stream).json();
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

function normalizeCard(payload = {}, existing = null, { touch = true } = {}) {
  const now = new Date().toISOString();
  const recordType = normalizeRecordType(payload.record_type || existing?.record_type);
  const linkedId = clean(
    payload.linked_order_id ||
    payload.linked_draft_order_id ||
    payload.source_id ||
    existing?.linked_order_id ||
    existing?.linked_draft_order_id ||
    existing?.source_id
  );

  const key = sourceKey(recordType, linkedId);

  return {
    id: clean(existing?.id || payload.id) || generateCardId(),
    source_key: key,
    record_type: recordType,
    linked_order_id: recordType === "order" ? linkedId : "",
    linked_draft_order_id: recordType === "draft_order" ? linkedId : "",
    source_id: recordType === "manual" ? clean(payload.source_id || existing?.source_id) : linkedId,
    order_name: clean(payload.order_name || existing?.order_name),
    customer: clean(payload.customer || existing?.customer),
    prepared_for: clean(payload.prepared_for || existing?.prepared_for),
    reference: clean(payload.reference || existing?.reference),
    due_date: clean(payload.due_date || existing?.due_date),
    production_status: normalizeChoice(payload.production_status || existing?.production_status, PRODUCTION_STATUSES, "new"),
    design_status: normalizeChoice(payload.design_status || existing?.design_status, DESIGN_STATUSES, "not_started"),
    material_status: normalizeChoice(payload.material_status || existing?.material_status, MATERIAL_STATUSES, "unknown"),
    supply_status: normalizeChoice(payload.supply_status || existing?.supply_status, SUPPLY_STATUSES, "unknown"),
    notes: clean(payload.notes ?? existing?.notes),
    archived: Boolean(payload.archived ?? existing?.archived ?? false),
    created_at: clean(existing?.created_at) || now,
    updated_at: touch ? now : (clean(payload.updated_at || existing?.updated_at) || now)
  };
}

async function readBoard() {
  const data = await readPrivatePath(PRODUCTION_BOARD_PATH).catch(() => null);
  const cards = Array.isArray(data?.cards) ? data.cards : [];
  return cards.map((card) => normalizeCard(card, card, { touch: false }));
}

async function writeBoard(cards = []) {
  await writePrivatePath(PRODUCTION_BOARD_PATH, {
    updated_at: new Date().toISOString(),
    cards
  });
}

function sortCards(cards = []) {
  return [...cards].sort((a, b) => {
    const dueDiff = clean(a.due_date).localeCompare(clean(b.due_date));
    if (clean(a.due_date) && clean(b.due_date) && dueDiff !== 0) return dueDiff;
    const timeDiff = new Date(b.updated_at || 0).getTime() - new Date(a.updated_at || 0).getTime();
    if (timeDiff !== 0) return timeDiff;
    return clean(b.id).localeCompare(clean(a.id));
  });
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (!(await requireInternalAuth(req, res))) return;

  try {
    if (req.method === "GET") {
      const cards = await readBoard();
      return res.status(200).json({ ok: true, cards: sortCards(cards) });
    }

    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const cards = await readBoard();
    const action = clean(req.body?.action || "upsert");

    if (action === "delete") {
      const id = clean(req.body?.id);
      const nextCards = cards.filter((card) => clean(card.id) !== id);
      await writeBoard(nextCards);
      return res.status(200).json({ ok: true, cards: sortCards(nextCards) });
    }

    const recordType = normalizeRecordType(req.body?.record_type);
    const linkedId = clean(req.body?.linked_order_id || req.body?.linked_draft_order_id || req.body?.source_id);
    const key = sourceKey(recordType, linkedId);
    const existingIndex = cards.findIndex((card) => {
      if (clean(req.body?.id) && clean(card.id) === clean(req.body.id)) return true;
      return key && clean(card.source_key) === key;
    });

    const existing = existingIndex >= 0 ? cards[existingIndex] : null;
    const card = normalizeCard(req.body, existing);

    if (card.record_type !== "manual" && !clean(card.source_id)) {
      return res.status(400).json({ error: "A linked order or draft order id is required." });
    }

    if (existingIndex >= 0) cards[existingIndex] = card;
    else cards.push(card);

    await writeBoard(cards);
    return res.status(200).json({ ok: true, card, cards: sortCards(cards) });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Could not update production board." });
  }
}
