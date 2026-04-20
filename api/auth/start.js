export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).send("Method not allowed.");
    return;
  }

  const shop = process.env.SHOPIFY_STORE;
  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const scopes = process.env.SHOPIFY_SCOPES || "read_orders";
  const appUrl = process.env.APP_URL;

  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(String(shop || ""))) {
    res.status(500).send("Authentication is not configured.");
    return;
  }

  const redirectUri = `${appUrl}/api/auth/callback`;

  const installUrl =
    `https://${shop}/admin/oauth/authorize` +
    `?client_id=${clientId}` +
    `&scope=${encodeURIComponent(scopes)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}`;

  res.writeHead(302, { Location: installUrl });
  res.end();
}
