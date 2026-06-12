export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');

  const results = await Promise.allSettled([
    fetchArbeitnow(),
    fetchEures()
  ]);

  const arbeitnow = results[0].status === 'fulfilled' ? results[0].value : [];
  const eures     = results[1].status === 'fulfilled' ? results[1].value : [];

  const all = dedupe([...arbeitnow, ...eures]);
  const visa = all.filter(j => j.visa_sponsorship === true);

  return res.status(200).json({
    total: all.length,
    visa_count: visa.length,
    sources: {
      arbeitnow: arbeitnow.length,
      eures: eures.length,
      eures_error: results[1].status === 'rejected' ? String(results[1].reason) : null
    },
    visa_jobs: visa,
    all_jobs: all
  });
}

/* ── Source 1: Arbeitnow (15 pages parallel) ───────────────── */
async function fetchArbeitnow() {
  const PAGES = 15;
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
  return all.map(j => ({ ...j, source: 'arbeitnow', fresher: isFresherTitle(j.title) }));
}

/* ── Source 2: EURES (keyword search for fresher roles) ─────── */
async function fetchEures() {
  const SEARCH_URL = 'https://europa.eu/eures/eures-searchengine/page/jv-search/search?lang=en';
  const KEYWORDS = ['junior', 'graduate', 'trainee'];

  const searches = KEYWORDS.map(kw =>
    fetch(SEARCH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (compatible; EuroAIJobs/1.0)'
      },
      body: JSON.stringify({
        resultsPerPage: 50,
        page: 1,
        sortSearch: 'MOST_RECENT',
        keywords: [{ keyword: kw, specificSearchCode: 'EVERYWHERE' }],
        publicationPeriod: null,
        occupationUris: [],
        skillUris: [],
        requiredExperienceCodes: [],
        positionScheduleCodes: [],
        sectorCodes: [],
        educationAndQualificationLevelCodes: [],
        positionOfferingCodes: [],
        locationCodes: [],
        euresFlagCodes: [],
        otherBenefitsCodes: [],
        requiredLanguages: []
      })
    }).then(async r => {
      if (!r.ok) throw new Error(`EURES ${r.status}`);
      return r.json();
    })
  );

  const settled = await Promise.allSettled(searches);
  let items = [];
  for (const s of settled) {
    if (s.status === 'fulfilled') {
      const list = s.value.jvs || s.value.results || s.value.data || [];
      items.push(...list);
    }
  }
  if (items.length === 0) {
    const firstErr = settled.find(s => s.status === 'rejected');
    if (firstErr) throw firstErr.reason;
  }
  return items.map(normalizeEures).filter(Boolean);
}

function normalizeEures(item) {
  const id = item.id || item.jvId || item.reference || item.handle;
  if (!id) return null;
  const employer =
    (item.employer && item.employer.name) ||
    item.employerName || 'EURES Employer';
  const loc =
    (Array.isArray(item.locationCodes) && item.locationCodes[0]) ||
    (item.locationMap && Object.keys(item.locationMap)[0]) ||
    item.location || 'European Union';
  return {
    slug: `eures-${id}`,
    title: item.title || 'Untitled role',
    company_name: employer,
    location: String(loc),
    url: `https://europa.eu/eures/portal/jv-se/jv-details/${id}?lang=en`,
    tags: [],
    job_types: [],
    remote: false,
    created_at: toEpoch(item.creationDate || item.publicationDate || item.lastModificationDate),
    visa_sponsorship: false,
    fresher: true,
    source: 'eures'
  };
}

function toEpoch(v) {
  if (!v) return Math.floor(Date.now() / 1000);
  if (typeof v === 'number') return v > 1e12 ? Math.floor(v / 1000) : v;
  const t = Date.parse(v);
  return isNaN(t) ? Math.floor(Date.now() / 1000) : Math.floor(t / 1000);
}

function isFresherTitle(title) {
  return /junior|graduate|entry.?level|trainee|intern|werkstudent|fresher/i.test(title || '');
}

function dedupe(list) {
  const seen = new Set();
  return list.filter(j => {
    if (seen.has(j.slug)) return false;
    seen.add(j.slug);
    return true;
  });
}
