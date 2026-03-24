export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const shop = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_ACCESS_TOKEN;

  if (!shop || !token) {
    return res.status(500).json({
      error: "Missing SHOPIFY_STORE or SHOPIFY_ACCESS_TOKEN",
    });
  }

  try {
    const limit = Number(req.query.limit || 50);
    const status = req.query.status || "open";
    const financialStatus = req.query.financial_status || "";
    const fulfillmentStatus = req.query.fulfillment_status || "";
    const search = (req.query.search || "").trim();

    const queryParts = [];

    if (status && status !== "any") queryParts.push(`status:${status}`);
    if (financialStatus) queryParts.push(`financial_status:${financialStatus}`);

    // These work for broad filtering; final filtering also happens below.
    if (fulfillmentStatus === "unfulfilled") queryParts.push(`fulfillment_status:unfulfilled`);
    if (fulfillmentStatus === "fulfilled") queryParts.push(`fulfillment_status:fulfilled`);
    if (fulfillmentStatus === "partial") queryParts.push(`fulfillment_status:partial`);

    if (search) {
      queryParts.push(`(${[
        `name:${search}*`,
        `email:${search}*`,
        `tag:${search}*`,
        `note:${search}*`,
      ].join(" OR ")})`);
    }

    const searchQuery = queryParts.join(" AND ");

    const graphqlQuery = `
      query GetOrders($first: Int!, $query: String) {
        orders(first: $first, sortKey: CREATED_AT, reverse: true, query: $query) {
          edges {
            node {
              id
              legacyResourceId
              name
              createdAt
              cancelledAt
              closed
              tags
              note
              displayFinancialStatus
              displayFulfillmentStatus
              totalPriceSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
              customer {
                id
                firstName
                lastName
                displayName
                email
                phone
              }
              shippingAddress {
                name
                address1
                address2
                city
                province
                zip
              }
              noteAttributes {
                name
                value
              }
              shippingLine {
                title
              }
              lineItems(first: 50) {
                edges {
                  node {
                    title
                    quantity
                    sku
                    variant {
                      id
                      title
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;

    const response = await fetch(`https://${shop}/admin/api/2025-10/graphql.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
      body: JSON.stringify({
        query: graphqlQuery,
        variables: {
          first: limit,
          query: searchQuery || null,
        },
      }),
    });

    const data = await response.json();

    if (!response.ok || data.errors) {
      return res.status(500).json({
        error: "Shopify GraphQL error",
        details: data.errors || data,
      });
    }

    let orders = data.data.orders.edges.map(({ node }) => {
      const amount = node.totalPriceSet?.shopMoney?.amount || "0.00";
      const currency = node.totalPriceSet?.shopMoney?.currencyCode || "USD";
      const customerName =
        node.customer?.displayName ||
        [node.customer?.firstName, node.customer?.lastName].filter(Boolean).join(" ") ||
        node.shippingAddress?.name ||
        "No customer";

      const lineItems = node.lineItems.edges.map(({ node: item }) => ({
        title: item.title,
        quantity: item.quantity,
        sku: item.sku || "",
        variant_title: item.variant?.title || "",
        variant_id: item.variant?.id || null,
      }));

      return {
        id: node.legacyResourceId,
        admin_graphql_api_id: node.id,
        order_number: node.name,
        name: node.name,
        created_at: node.createdAt,
        cancelled_at: node.cancelledAt,
        closed: node.closed,
        tags: node.tags || [],
        note: node.note || "",
        financial_status: node.displayFinancialStatus || "",
        fulfillment_status: node.displayFulfillmentStatus || "",
        total_price: amount,
        currency,
        customer: {
          name: customerName,
          email: node.customer?.email || "",
          phone: node.customer?.phone || "",
        },
        shipping_address: node.shippingAddress || null,
        shipping_line: node.shippingLine?.title || "",
        note_attributes: node.noteAttributes || [],
        line_items: lineItems,
      };
    });

    // Extra frontend-friendly filtering for statuses Shopify shows in admin
    if (fulfillmentStatus) {
      const wanted = fulfillmentStatus.toLowerCase().replace(/_/g, " ");
      orders = orders.filter((order) => {
        const current = (order.fulfillment_status || "").toLowerCase().replace(/_/g, " ");
        return current === wanted;
      });
    }

    return res.status(200).json({ orders });
  } catch (error) {
    return res.status(500).json({
      error: "Failed to load orders",
      details: error.message,
    });
  }
}
