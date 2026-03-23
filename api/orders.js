export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const shop = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_ACCESS_TOKEN;

  if (!shop || !token) {
    res.status(500).json({
      error: "Missing SHOPIFY_STORE or SHOPIFY_ACCESS_TOKEN in Vercel environment variables."
    });
    return;
  }

  const response = await fetch(
    `https://${shop}/admin/api/2025-10/orders.json?status=open&fulfillment_status=unfulfilled`,
    {
      headers: {
        "X-Shopify-Access-Token": token,
        "Content-Type": "application/json",
      },
    }
  );

  const data = await response.json();
  res.status(200).json(data);
}
