export default async function handler(req, res) {
  const { code, shop } = req.query;

  if (!code || !shop) {
    res.status(400).send("Missing code or shop");
    return;
  }

  if (shop !== process.env.SHOPIFY_STORE) {
    res.status(400).send("Shop does not match expected store");
    return;
  }

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

  const data = await response.json();

  if (!data.access_token) {
    res.status(500).send(`<pre>${JSON.stringify(data, null, 2)}</pre>`);
    return;
  }

  res.status(200).send(`
    <h1>Success</h1>
    <p>Copy this token and save it in Vercel as <strong>SHOPIFY_ACCESS_TOKEN</strong>.</p>
    <pre style="white-space: pre-wrap; word-break: break-all;">${data.access_token}</pre>
    <p>After you save it in Vercel, redeploy your project.</p>
  `);
}
