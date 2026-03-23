export default async function handler(req, res) {
  const { code, shop } = req.query;

  if (!code || !shop) {
    res.status(400).send(`
      <h1>Missing code or shop</h1>
      <pre>${JSON.stringify(req.query, null, 2)}</pre>
    `);
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

  res.status(200).send(`
    <h1>Callback Result</h1>
    <pre style="white-space: pre-wrap; word-break: break-all;">${JSON.stringify(data, null, 2)}</pre>
  `);
}
