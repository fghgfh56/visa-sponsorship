export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');

  const page = req.query.page || 1;

  try {
    const r = await fetch(`https://www.arbeitnow.com/api/job-board-api?page=${page}`, {
      headers: { 'User-Agent': 'EuroAI-Jobs/1.0' }
    });

    if (!r.ok) {
      return res.status(r.status).json({ error: `Arbeitnow API returned ${r.status}` });
    }

    const data = await r.json();
    return res.status(200).json(data);

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
