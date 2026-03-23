export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const shop = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_ACCESS_TOKEN;

  if (!shop || !token) {
    res.status(500).json({
      error: "Missing SHOPIFY_STORE or SHOPIFY_ACCESS_TOKEN"
    });
    return;
  }

  const status = req.query.status || "any";
  const fulfillmentStatus = req.query.fulfillment_status || "";
  const financialStatus = req.query.financial_status || "";
  const limit = req.query.limit || "50";

  let url = `https://${shop}/admin/api/2025-10/orders.json?status=${encodeURIComponent(status)}&limit=${encodeURIComponent(limit)}`;

  if (fulfillmentStatus) {
    url += `&fulfillment_status=${encodeURIComponent(fulfillmentStatus)}`;
  }

  if (financialStatus) {
    url += `&financial_status=${encodeURIComponent(financialStatus)}`;
  }

  const response = await fetch(url, {
    headers: {
      "X-Shopify-Access-Token": token,
      "Content-Type": "application/json",
    },
  });

  const data = await response.json();
  res.status(200).json(data);
}
