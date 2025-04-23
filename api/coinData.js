export default async function handler(req, res) {
  const { coin } = req.query;

  if (!coin) {
    return res.status(400).json({ error: "Missing 'coin' parameter" });
  }

  const url = `https://api.coingecko.com/api/v3/coins/${coin}/market_chart?vs_currency=usd&days=1&interval=hourly`;

  try {
    const response = await fetch(url);
    const data = await response.json();
    return res.status(200).json(data);
  } catch (error) {
    return res.status(500).json({ error: "Failed to fetch CoinGecko data" });
  }
}
