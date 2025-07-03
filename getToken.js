require("dotenv").config();

async function getEbayToken() {
  const clientId = process.env.CLIENT_ID;
  const clientSecret = process.env.CLIENT_SECRET;
  const scope = process.env.EBAY_SCOPE;

  const encodedCredentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const response = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
    method: "POST",
    headers: {
      "Authorization": `Basic ${encodedCredentials}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: `grant_type=client_credentials&scope=${scope}`
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`❌ eBay token error (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  return data.access_token;
}

module.exports = getEbayToken;

