export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');

  const results = await Promise.allSettled([
    fetchArbeitnow(),
    fetchEures(),
    fetchMuse(),
    fetchGreenhouse()
  ]);

  const pick = i => results[i].status === 'fulfilled' ? results[i].value : [];
  const err  = i => results[i].status === 'rejected' ? String(results[i].reason).slice(0, 200) : null;

  const all = dedupe([...pick(0), ...pick(1), ...pick(2), ...pick(3)]);
  const visa = all.filter(j => j.visa_sponsorship === true);

  return res.status(200).json({
    total: all.length,
    visa_count: visa.length,
    sources: {
      arbeitnow: { count: pick(0).length, error: err(0) },
      eures:     { count: pick(1).length, error: err(1) },
      muse:      { count: pick(2).length, error: err(2) },
      greenhouse:{ count: pick(3).length, error: err(3) }
    },
    visa_jobs: visa,
    all_jobs: all
  });
}

const VISA_RE    = /visa|sponsor|relocat/i;
const FRESHER_RE = /junior|graduate|entry.?level|trainee|intern|associate|fresher|new grad|werkstudent/i;

/* ── 1. Arbeitnow (Germany/EU, native visa flag) ───────────── */
async function fetchArbeitnow() {
  const urls = Array.from({ length: 15 }, (_, i) =>
    `https://www.arbeitnow.com/api/job-board-api?page=${i + 1}`);
  const rs = await Promise.allSettled(urls.map(u =>
    fetch(u, { headers: { 'User-Agent': 'EuroAI-Jobs/1.0' } })));
  let all = [];
  for (const r of rs) {
    if (r.status === 'fulfilled' && r.value.ok) {
      const j = await r.value.json();
      if (Array.isArray(j.data)) all.push(...j.data);
    }
  }
  return all.map(j => ({
    slug: j.slug, title: j.title, company_name: j.company_name,
    location: j.location || 'Germany', url: j.url,
    tags: (j.tags || []).slice(0, 4), job_types: (j.job_types || []).slice(0, 2),
    remote: !!j.remote, created_at: j.created_at,
    visa_sponsorship: j.visa_sponsorship === true,
    fresher: FRESHER_RE.test(j.title || ''), source: 'arbeitnow'
  }));
}

/* ── 2. EURES (EU official portal, fresher keywords) ────────── */
async function fetchEures() {
  const URL = 'https://europa.eu/eures/eures-searchengine/page/jv-search/search?lang=en';
  const KW = ['junior', 'graduate', 'trainee'];
  const reqs = KW.map(kw => fetch(URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json',
               'User-Agent': 'Mozilla/5.0 (compatible; EuroAIJobs/1.0)' },
    body: JSON.stringify({
      resultsPerPage: 50, page: 1, sortSearch: 'MOST_RECENT',
      keywords: [{ keyword: kw, specificSearchCode: 'EVERYWHERE' }],
      publicationPeriod: null, occupationUris: [], skillUris: [],
      requiredExperienceCodes: [], positionScheduleCodes: [], sectorCodes: [],
      educationAndQualificationLevelCodes: [], positionOfferingCodes: [],
      locationCodes: [], euresFlagCodes: [], otherBenefitsCodes: [], requiredLanguages: []
    })
  }).then(async r => { if (!r.ok) throw new Error(`EURES ${r.status}`); return r.json(); }));

  const settled = await Promise.allSettled(reqs);
  let items = [];
  for (const s of settled) {
    if (s.status === 'fulfilled') {
      items.push(...(s.value.jvs || s.value.results || s.value.data || []));
    }
  }
  if (items.length === 0) {
    const e = settled.find(s => s.status === 'rejected');
    if (e) throw e.reason;
  }
  return items.map(it => {
    const id = it.id || it.jvId || it.reference || it.handle;
    if (!id) return null;
    const loc = (Array.isArray(it.locationCodes) && it.locationCodes[0]) ||
                (it.locationMap && Object.keys(it.locationMap)[0]) || it.location || 'European Union';
    return {
      slug: `eures-${id}`, title: it.title || 'Untitled role',
      company_name: (it.employer && it.employer.name) || it.employerName || 'EURES Employer',
      location: String(loc),
      url: `https://europa.eu/eures/portal/jv-se/jv-details/${id}?lang=en`,
      tags: [], job_types: [], remote: false,
      created_at: toEpoch(it.creationDate || it.publicationDate),
      visa_sponsorship: false, fresher: true, source: 'eures'
    };
  }).filter(Boolean);
}

/* ── 3. The Muse (US/UK/IE/SG/JP, entry level, no key) ──────── */
async function fetchMuse() {
  const urls = [1, 2, 3].map(p =>
    `https://www.themuse.com/api/public/jobs?page=${p}&level=Entry%20Level`);
  const rs = await Promise.allSettled(urls.map(u =>
    fetch(u, { headers: { 'Accept': 'application/json' } })));
  let items = [];
  for (const r of rs) {
    if (r.status === 'fulfilled' && r.value.ok) {
      const j = await r.value.json();
      if (Array.isArray(j.results)) items.push(...j.results);
    }
  }
  return items.map(it => {
    const loc = (it.locations && it.locations[0] && it.locations[0].name) || 'Worldwide';
    const contents = it.contents || '';
    return {
      slug: `muse-${it.id}`, title: it.name || 'Untitled role',
      company_name: (it.company && it.company.name) || 'Company',
      location: loc,
      url: (it.refs && it.refs.landing_page) || '#',
      tags: (it.categories || []).slice(0, 3).map(c => c.name),
      job_types: ['Entry Level'], remote: /remote|flexible/i.test(loc),
      created_at: toEpoch(it.publication_date),
      visa_sponsorship: VISA_RE.test(contents),
      fresher: true, source: 'muse'
    };
  });
}

/* ── 4. Greenhouse public boards (known visa sponsors) ──────── */
async function fetchGreenhouse() {
  const BOARDS = ['stripe', 'datadog', 'cloudflare', 'gitlab', 'intercom', 'monzo', 'grab', 'airbnb'];
  const rs = await Promise.allSettled(BOARDS.map(b =>
    fetch(`https://boards-api.greenhouse.io/v1/boards/${b}/jobs?content=true`,
      { headers: { 'Accept': 'application/json' } })
      .then(async r => { if (!r.ok) throw new Error(`${b} ${r.status}`); return { board: b, json: await r.json() }; })
  ));
  let out = [];
  for (const r of rs) {
    if (r.status !== 'fulfilled') continue;
    const { board, json } = r.value;
    for (const it of (json.jobs || [])) {
      const loc = (it.location && it.location.name) || '';
      const content = (it.content || '').slice(0, 8000);
      out.push({
        slug: `gh-${board}-${it.id}`, title: it.title || 'Untitled role',
        company_name: board.charAt(0).toUpperCase() + board.slice(1),
        location: loc || 'Multiple locations',
        url: it.absolute_url,
        tags: [], job_types: [], remote: /remote/i.test(loc),
        created_at: toEpoch(it.updated_at),
        visa_sponsorship: VISA_RE.test(content),
        fresher: FRESHER_RE.test(it.title || ''), source: 'greenhouse'
      });
    }
  }
  return out;
}

function toEpoch(v) {
  if (!v) return Math.floor(Date.now() / 1000);
  if (typeof v === 'number') return v > 1e12 ? Math.floor(v / 1000) : v;
  const t = Date.parse(v);
  return isNaN(t) ? Math.floor(Date.now() / 1000) : Math.floor(t / 1000);
}

function dedupe(list) {
  const seen = new Set();
  return list.filter(j => {
    if (!j || seen.has(j.slug)) return false;
    seen.add(j.slug);
    return true;
  });
}
