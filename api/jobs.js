export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');

  const PAGES = 15;

  try {
    const urls = Array.from({ length: PAGES }, (_, i) =>
      `https://www.arbeitnow.com/api/job-board-api?page=${i + 1}`
    );

    const responses = await Promise.allSettled(
      urls.map(u => fetch(u, { headers: { 'User-Agent': 'EuroAI-Jobs/1.0' } }))
    );

    let all = [];
    for (const r of responses) {
      if (r.status === 'fulfilled' && r.value.ok) {
        const json = await r.value.json();
        if (Array.isArray(json.data)) all.push(...json.data);
      }
    }

    // de-duplicate by slug
    const seen = new Set();
    all = all.filter(j => {
      if (seen.has(j.slug)) return false;
      seen.add(j.slug);
      return true;
    });

    const visa = all.filter(j => j.visa_sponsorship === true);

    return res.status(200).json({
      total: all.length,
      visa_count: visa.length,
      visa_jobs: visa,
      all_jobs: all
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
