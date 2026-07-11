import 'dotenv/config';
import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fetch from 'node-fetch';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

const APIFY_BASE = 'https://api.apify.com/v2';
const ANTHROPIC_BASE = 'https://api.anthropic.com/v1';
const POLL_INTERVAL_MS = 5000;
const MAX_POLL_ATTEMPTS = 36; // 3 minutes

// ── Helpers ────────────────────────────────────────────────────────────────

function getToken(req) {
  // Prefer server-side env var; fall back to client-supplied header (optional convenience)
  return process.env.APIFY_TOKEN || req.headers['x-apify-token'] || '';
}

function getAnthropicKey(req) {
  return process.env.ANTHROPIC_API_KEY || req.headers['x-anthropic-key'] || '';
}

async function startApifyRun(token, payload) {
  const res = await fetch(
    `${APIFY_BASE}/acts/apify~facebook-ads-scraper/runs?token=${token}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Apify start error ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  return { runId: data.data.id, datasetId: data.data.defaultDatasetId };
}

async function pollRun(token, runId) {
  for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    const res = await fetch(`${APIFY_BASE}/actor-runs/${runId}?token=${token}`);
    const data = await res.json();
    const status = data.data.status;
    if (status === 'SUCCEEDED') return;
    if (['FAILED', 'ABORTED', 'TIMED-OUT'].includes(status)) {
      throw new Error(`Apify run ${status}`);
    }
  }
  // Timeout — abort run to stop credit burn
  await fetch(`${APIFY_BASE}/actor-runs/${runId}/abort?token=${token}`, { method: 'POST' }).catch(() => {});
  throw new Error(`Timed out after ${MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS / 1000}s — run was aborted`);
}

async function fetchDataset(token, datasetId, limit) {
  const limitParam = limit ? `&limit=${limit}` : '';
  const res = await fetch(
    `${APIFY_BASE}/datasets/${datasetId}/items?token=${token}&format=json${limitParam}`
  );
  if (!res.ok) throw new Error(`Dataset fetch error ${res.status}`);
  return res.json();
}

function getSnap(ad) { return ad.snapshot || {}; }

function getBody(ad) {
  const snap = getSnap(ad);
  const body = (snap.body || {}).text || '';
  if (body) return body;
  return (snap.cards || []).map(c => c.body || '').filter(Boolean).join(' | ');
}

function normalize(str) {
  return (str || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function deduplicateAds(ads) {
  const seen = new Map();

  function mergeInto(key, ad) {
    if (!seen.has(key)) {
      seen.set(key, { ad, variants: [ad] });
      return;
    }
    seen.get(key).variants.push(ad);
    const entry = seen.get(key);
    const cur = entry.ad;
    const curDate = cur.startDateFormatted || '';
    const newDate = ad.startDateFormatted || '';
    if (!cur.isActive && ad.isActive) entry.ad = ad;
    else if (cur.isActive === ad.isActive && newDate > curDate) entry.ad = ad;
  }

  // Build a map from collationId → canonical key, so fuzzy matches
  // merge into the same group as their collation siblings
  const keyForAd = new Map();

  for (const ad of ads) {
    const snap = getSnap(ad);
    const collation = ad.collationId || snap.collationId || null;
    const headline = normalize(snap.title).slice(0, 60);
    const body = normalize(getBody(ad)).slice(0, 80);
    const fuzzyKey = `fuzzy:${headline}|${body}`;
    const collKey = collation ? `col:${collation}` : null;

    // Determine canonical key: prefer collation, but unify with fuzzy
    // so ads with different collationIds but same creative merge together
    let canonical = null;

    if (collKey && seen.has(collKey)) {
      canonical = collKey;
    } else if (seen.has(fuzzyKey)) {
      canonical = fuzzyKey;
    } else if (collKey) {
      canonical = collKey;
    } else {
      canonical = fuzzyKey;
    }

    // If collation key exists but fuzzy already matched something else,
    // link them: use whichever was seen first
    if (collKey && seen.has(fuzzyKey) && !seen.has(collKey)) {
      canonical = fuzzyKey;
    } else if (collKey && !seen.has(fuzzyKey) && seen.has(collKey)) {
      canonical = collKey;
    }

    mergeInto(canonical, ad);
    keyForAd.set(ad, canonical);

    // Register the other key as an alias pointing to same group
    if (collKey && canonical !== collKey && !seen.has(collKey)) {
      seen.set(collKey, seen.get(canonical));
    }
    if (canonical !== fuzzyKey && !seen.has(fuzzyKey)) {
      seen.set(fuzzyKey, seen.get(canonical));
    }
  }

  // Deduplicate the groups (aliases point to same object)
  const uniqueGroups = [...new Set([...seen.values()])];
  return uniqueGroups.map(({ ad, variants }) => {
    ad._variantCount = variants.length;
    const dates = variants.map(v => v.startDateFormatted || '').filter(Boolean).sort();
    ad._dateRange = dates.length > 1
      ? `${dates[0].split('T')[0]} – ${dates[dates.length - 1].split('T')[0]}`
      : null;
    ad._allCtas = [...new Set(variants.map(v => (v.snapshot || {}).ctaText).filter(Boolean))];
    return ad;
  });
}

function groupByPage(ads) {
  const pages = new Map();
  for (const ad of ads) {
    const snap = getSnap(ad);
    const pageId = snap.pageId || ad.pageId || ad.pageID;
    if (!pageId) continue;
    if (!pages.has(pageId)) {
      pages.set(pageId, {
        pageId,
        pageName: snap.pageName || 'Unknown',
        pageProfilePictureUrl: snap.pageProfilePictureUrl || '',
        pageCategories: snap.pageCategories || [],
        pageLikeCount: snap.pageLikeCount || 0,
        pageProfileUri: snap.pageProfileUri || '',
        adCount: 0,
      });
    }
    pages.get(pageId).adCount += 1;
  }
  return Array.from(pages.values());
}

// ── Routes ─────────────────────────────────────────────────────────────────

// POST /api/search-pages
// Runs Apify page search and returns grouped page list
app.post('/api/search-pages', async (req, res) => {
  const token = getToken(req);
  const { searchTerm, country } = req.body;

  if (!token) return res.status(400).json({ error: 'Apify token not configured' });
  if (!searchTerm) return res.status(400).json({ error: 'searchTerm is required' });

  try {
    const countryParam = country && country !== 'ALL'
      ? `&country=${country}&is_targeted_country=false`
      : '';
    const adLibraryUrl = `https://www.facebook.com/ads/library/?active_status=all&ad_type=all${countryParam}&media_type=all&q=${encodeURIComponent(searchTerm)}&search_type=page`;

    const { runId, datasetId } = await startApifyRun(token, {
      startUrls: [{ url: adLibraryUrl }],
      count: 10,
      maxResults: 10,
      resultsLimit: 10,
      scrapeAdDetails: true,
      'scrapePageAds.activeStatus': 'all',
    });

    await pollRun(token, runId);
    const ads = (await fetchDataset(token, datasetId, 10)).slice(0, 10);

    if (!ads.length) {
      return res.json({ pages: [], rawCount: 0 });
    }

    let pages = groupByPage(ads);
    const term = searchTerm.toLowerCase();
    pages.sort((a, b) => {
      const aMatch = a.pageName.toLowerCase().includes(term) ? 1 : 0;
      const bMatch = b.pageName.toLowerCase().includes(term) ? 1 : 0;
      if (aMatch !== bMatch) return bMatch - aMatch;
      return b.adCount - a.adCount;
    });

    res.json({ pages, rawCount: ads.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/run-research
// Runs targeted Apify pull for a specific page and returns deduplicated ads
app.post('/api/run-research', async (req, res) => {
  const token = getToken(req);
  const { pageId, pageName, country, maxResults = 20 } = req.body;

  if (!token) return res.status(400).json({ error: 'Apify token not configured' });
  if (!pageId) return res.status(400).json({ error: 'pageId is required' });

  try {
    const countryParam = country && country !== 'ALL'
      ? `&country=${country}&is_targeted_country=false`
      : '';
    const adLibraryUrl = `https://www.facebook.com/ads/library/?active_status=all&ad_type=all${countryParam}&media_type=all&view_all_page_id=${pageId}&search_type=page`;
    const { runId, datasetId } = await startApifyRun(token, {
      startUrls: [{ url: adLibraryUrl }],
      count: 20,
      maxResults: 20,
      resultsLimit: 20,
      scrapeAdDetails: true,
      'scrapePageAds.activeStatus': 'all',
    });

    await pollRun(token, runId);
    const ads = (await fetchDataset(token, datasetId, 20)).slice(0, 20);
    const rawCount = ads.length;
    const deduped = deduplicateAds(ads);

    res.json({ ads: deduped, rawCount, pageName });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/roast-score
// Calls Claude to score a single ad
app.post('/api/roast-score', async (req, res) => {
  const apiKey = getAnthropicKey(req);
  const { headline, copy, cta } = req.body;

  if (!apiKey) return res.status(400).json({ error: 'Anthropic API key not configured' });
  if (!copy && !headline) return res.status(400).json({ error: 'copy or headline is required' });

  const prompt = `You are ROAST — a senior paid media creative strategist. Analyse this competitor Facebook/Instagram ad. Respond ONLY with valid JSON, no markdown, no explanation.

Headline: ${headline || 'N/A'}
CTA button: ${cta || 'N/A'}
Ad copy: ${copy || 'N/A'}

Return ONLY this exact JSON:
{
  "score": <integer 1-10 overall creative effectiveness>,
  "blurb": "<2 sentences max: (1) what angle/hook this ad is using, (2) one sharp strategic observation — a strength or a gap a competitor should know about>"
}

Score 1-10 where: 1-3 = weak (generic copy, no hook, unclear offer), 4-6 = average (clear but forgettable), 7-8 = strong (compelling hook, clear offer), 9-10 = exceptional (scroll-stopping, distinct, persuasive).`;

  try {
    const response = await fetch(`${ANTHROPIC_BASE}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 400,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Anthropic error ${response.status}: ${text.slice(0, 150)}`);
    }

    const data = await response.json();
    const textBlock = (data.content || []).find(b => b.type === 'text');
    const raw = textBlock ? textBlock.text.trim().replace(/^```json|^```|```$/gm, '').trim() : '';
    const parsed = JSON.parse(raw);
    res.json(parsed);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/campaign-summary
// Calls Claude to generate a 3-section creative strategy summary
app.post('/api/campaign-summary', async (req, res) => {
  const apiKey = getAnthropicKey(req);
  const { ads = [], themes = [] } = req.body;

  if (!apiKey) return res.status(400).json({ error: 'Anthropic API key not configured' });
  if (!ads.length) return res.status(400).json({ error: 'ads array is required' });

  const adData = ads.slice(0, 20).map((a, i) => {
    const snap = a.snapshot || {};
    const body = getBody(a).slice(0, 300);
    const headline = snap.title || '';
    const cta = snap.ctaText || '';
    const fmt = snap.displayFormat || 'unknown';
    const variants = a._variantCount || 1;
    return `Ad ${i + 1} [${fmt}${variants > 1 ? `, ${variants} variants` : ''}]: headline="${headline}" | CTA="${cta}" | copy="${body}"`;
  }).join('\n');

  const prompt = `You are a senior paid media creative strategist. Analyse the following ${ads.length} unique ads from a competitor's Facebook/Instagram ad account.

Respond ONLY with valid JSON — no markdown, no explanation, no backticks.

Return exactly this structure:
{
  "sections": [
    {
      "headline": "<5-7 word punchy strategic headline>",
      "summary": "<2-3 sentences. Sharp, opinionated, specific. No generic observations.>"
    },
    {
      "headline": "<5-7 word punchy strategic headline>",
      "summary": "<2-3 sentences. Sharp, opinionated, specific.>"
    },
    {
      "headline": "<5-7 word punchy strategic headline>",
      "summary": "<2-3 sentences. Sharp, opinionated, specific.>"
    }
  ]
}

Section 1: Core creative strategy — what offer, angle, and tone dominates their ads
Section 2: Format and hook patterns — what formats/hooks they rely on and why it works or doesn't
Section 3: The gap — one clear strategic opening their ads leave for a competitor to exploit

Detected themes: ${themes.join(', ')}

Ad data:
${adData}`;

  try {
    const response = await fetch(`${ANTHROPIC_BASE}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 600,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Anthropic error ${response.status}: ${text.slice(0, 150)}`);
    }

    const data = await response.json();
    const textBlock = (data.content || []).find(b => b.type === 'text');
    const raw = textBlock ? textBlock.text.trim().replace(/^```json|^```|```$/gm, '').trim() : '';
    const parsed = JSON.parse(raw);
    res.json(parsed);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Start ───────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`CREEP running on http://localhost:${PORT}`));
