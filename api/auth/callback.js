export default async function handler(req, res) {
  const { code, shop } = req.query;
  const successRedirect = process.env.AUTH_SUCCESS_REDIRECT || process.env.APP_URL || "/";

  if (req.method !== "GET") {
    res.status(405).send("Method not allowed.");
    return;
  }

  if (!code || !shop) {
    res.status(400).send("Authentication failed. Missing required callback parameters.");
    return;
  }

  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(String(shop))) {
    res.status(400).send("Authentication failed.");
    return;
  }

  try {
    const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: process.env.SHOPIFY_CLIENT_ID,
        client_secret: process.env.SHOPIFY_CLIENT_SECRET,
        code,
      }),
    });

    if (!response.ok) {
      res.status(502).send("Authentication failed during token exchange.");
      return;
    }

    await response.json();

    res.writeHead(302, { Location: successRedirect });
    res.end();
  } catch (error) {
    res.status(500).send("Authentication failed.");
  }
}
