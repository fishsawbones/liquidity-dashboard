export default async function handler(req, res) {
  const { series_id, observation_start } = req.query;

  if (!series_id) {
    return res.status(400).json({ error: "Missing series_id parameter" });
  }

  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "FRED_API_KEY not configured" });
  }

  const start = observation_start || "2014-01-01";
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${series_id}&api_key=${apiKey}&file_type=json&observation_start=${start}&sort_order=asc`;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      return res.status(response.status).json({ error: `FRED API error: ${response.status}` });
    }
    const data = await response.json();
    
    // Cache for 1 hour since FRED data updates weekly
    res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=7200");
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
