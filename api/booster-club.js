import { put } from "@vercel/blob";

const BOOSTER_ACCOUNTS_PATH = "booster-club/accounts.json";
const BOOSTER_LEDGER_PATH = "booster-club/ledger.json";

function setCors(req, res) {
  const allowedOrigin = process.env.ALLOWED_ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function clean(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function parseAmount(value) {
  if (value === null || value === undefined || value === "") return 0;
  const cleaned = String(value).replace(/[^0-9.-]/g, "");
  if (!cleaned) return 0;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
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

async function readAccounts() {
  const data = await readPrivatePath(BOOSTER_ACCOUNTS_PATH).catch(() => null);
  return Array.isArray(data?.accounts) ? data.accounts : [];
}

async function readLedger() {
  const data = await readPrivatePath(BOOSTER_LEDGER_PATH).catch(() => null);
  return Array.isArray(data?.entries) ? data.entries : [];
}

function summarizeAccounts(accounts = [], entries = []) {
  const balances = entries.reduce((acc, entry) => {
    const accountName = clean(entry?.account_name);
    if (!accountName) return acc;
    acc[accountName] = (acc[accountName] || 0) + parseAmount(entry?.amount);
    return acc;
  }, {});

  const knownAccounts = new Map();

  accounts.forEach((account) => {
    const key = clean(account?.name).toLowerCase();
    if (!key) return;
    knownAccounts.set(key, {
      ...account,
      balance: Number((balances[clean(account.name)] || 0).toFixed(2))
    });
  });

  Object.keys(balances).forEach((accountName) => {
    const key = clean(accountName).toLowerCase();
    if (!key || knownAccounts.has(key)) return;

    knownAccounts.set(key, {
      name: accountName,
      organization: "sta",
      status: "active",
      notes: "",
      created_at: "",
      updated_at: "",
      balance: Number((balances[accountName] || 0).toFixed(2))
    });
  });

  return [...knownAccounts.values()]
    .sort((a, b) => clean(a.name).localeCompare(clean(b.name)));
}

export default async function handler(req, res) {
  setCors(req, res);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  try {
    if (req.method === "GET") {
      const [accounts, entries] = await Promise.all([readAccounts(), readLedger()]);
      return res.status(200).json({
        ok: true,
        accounts: summarizeAccounts(accounts, entries),
        entries: entries.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      });
    }

    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const accounts = await readAccounts();
    const name = clean(req.body?.name);
    const organization = clean(req.body?.organization || "sta");
    const status = clean(req.body?.status || "active");
    const notes = clean(req.body?.notes);

    if (!name) {
      return res.status(400).json({ error: "Booster account name is required." });
    }

    const existingIndex = accounts.findIndex(
      (account) => clean(account?.name).toLowerCase() === name.toLowerCase()
    );

    const record = {
      name,
      organization,
      status,
      notes,
      updated_at: new Date().toISOString(),
      created_at: existingIndex >= 0 ? accounts[existingIndex].created_at : new Date().toISOString()
    };

    if (existingIndex >= 0) {
      accounts[existingIndex] = { ...accounts[existingIndex], ...record };
    } else {
      accounts.push(record);
    }

    await writePrivatePath(BOOSTER_ACCOUNTS_PATH, {
      updated_at: new Date().toISOString(),
      accounts
    });

    const entries = await readLedger();
    return res.status(200).json({
      ok: true,
      accounts: summarizeAccounts(accounts, entries)
    });
  } catch (error) {
    return res.status(500).json({
      error: error.message || "Could not load booster club data."
    });
  }
}
