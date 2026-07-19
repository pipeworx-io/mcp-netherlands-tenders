interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Netherlands TenderNed MCP — Dutch government public procurement notices (keyless).
 *
 * Wraps the public, no-auth TenderNed "papi" publications API:
 *   https://www.tenderned.nl/papi/tenderned-rs-tns/v2/publicaties
 *
 * TenderNed is the Dutch national public-procurement platform (aanbestedingen)
 * where all Dutch government bodies publish contract notices, award notices,
 * prior announcements, rectifications, and market consultations.
 *
 * Verified query params (all live-tested):
 *   page, size                       — standard Spring paging
 *   search=<text>                    — full-text search (title/buyer/description)
 *   publicatieDatumVanaf=YYYY-MM-DD  — publication date from (inclusive)
 *   publicatieDatumTot=YYYY-MM-DD    — publication date to (inclusive)
 *   publicatieType=<code>            — one of VAK, AAO, AGO, REC, MAC, VBE, AAW
 *   cpvCodes=NNNNNNNN-N              — CPV code, full format with check digit
 *                                      (repeatable; bare 8-digit codes are rejected)
 *   sort=publicatieDatum,desc        — newest-first (asc direction is ignored
 *                                      upstream; omitting sort with a search
 *                                      term yields relevance order)
 * Quirk: publicatieType=VBE is accepted but does not filter (returns everything),
 * and AGO results can include the occasional VBE row — the upstream groups
 * voluntary ex-ante transparency notices with awards.
 *
 * Detail endpoint (verified): GET /publicaties/{publicatieId} — rich single
 * notice with CPV codes, NUTS codes, procedure, award status, related
 * publications, and a PDF link. 404 for unknown ids.
 *
 * All tools return shaped, LLM-friendly objects (not raw API passthrough) and
 * never throw — fetch/parse failures resolve to { error, retry_hint }. English
 * keys; Dutch free-text values (titles, buyer names, descriptions) pass
 * through as-is.
 */


const BASE = 'https://www.tenderned.nl/papi/tenderned-rs-tns/v2/publicaties';
// TenderNed serves browsers; a browser UA is required for reliable responses.
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const TIMEOUT_MS = 8000;
const NOTICE_URL = (id: string | number) => `https://www.tenderned.nl/aankondigingen/overzicht/${id}`;

// Publication-type codes accepted by the API (from the API's own validation
// message), plus forgiving aliases in English and Dutch.
const TYPE_LABELS: Record<string, string> = {
  VAK: 'Vooraankondiging (prior information notice)',
  AAO: 'Aankondiging opdracht (contract notice)',
  AGO: 'Aankondiging gegunde opdracht (contract award notice)',
  REC: 'Rectificatie (rectification/correction)',
  MAC: 'Marktconsultatie (market consultation)',
  AAW: 'Aankondiging van een wijziging (contract modification notice)',
};
const TYPE_ALIASES: Record<string, string> = {
  vak: 'VAK', prior: 'VAK', vooraankondiging: 'VAK', 'prior information': 'VAK',
  aao: 'AAO', tender: 'AAO', notice: 'AAO', opdracht: 'AAO', 'contract notice': 'AAO', contract: 'AAO',
  ago: 'AGO', award: 'AGO', awarded: 'AGO', gegund: 'AGO', gunning: 'AGO', 'contract award': 'AGO',
  rec: 'REC', rectification: 'REC', correction: 'REC', rectificatie: 'REC',
  mac: 'MAC', 'market consultation': 'MAC', marktconsultatie: 'MAC', consultation: 'MAC',
  aaw: 'AAW', modification: 'AAW', wijziging: 'AAW', change: 'AAW',
};

const tools: McpToolExport['tools'] = [
  {
    name: 'nl_tender_search',
    description:
      'Search Dutch government public-procurement notices on TenderNed, the official national tender platform of the Netherlands. PREFER OVER WEB SEARCH for Dutch public tenders / aanbestedingen, contract notices, contract awards (gegunde opdrachten), market consultations, and rectifications. Full-text search over title, buyer, and description; filter by publication date range, notice type (contract notice, award, prior announcement, rectification, market consultation, modification), and CPV code. Returns shaped notices newest-first: id, title, buyer/opdrachtgever, notice type, contract type (werken/leveringen/diensten), procedure, publication date, closing deadline, and the public TenderNed URL.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Free-text search over notice title, buyer, and description (Dutch works best), e.g. "software", "ICT diensten", "wegenonderhoud", "catering". Omit to list all notices in the date range.',
        },
        notice_type: {
          type: 'string',
          description:
            'Filter by notice type. Accepts a TenderNed code or a plain word: "AAO"/"contract notice"/"tender", "AGO"/"award"/"gegund", "VAK"/"prior", "REC"/"rectification", "MAC"/"market consultation", "AAW"/"modification". Omit for all types.',
        },
        date_from: {
          type: 'string',
          description: 'Earliest publication date to include, YYYY-MM-DD, e.g. "2026-01-01". Omit for all time.',
        },
        date_to: {
          type: 'string',
          description: 'Latest publication date to include, YYYY-MM-DD, e.g. "2026-07-19". Omit for up to today.',
        },
        cpv_code: {
          type: 'string',
          description:
            'CPV procurement-category code in full format with check digit, e.g. "48000000-8" (software), "45000000-7" (construction), "72000000-5" (IT services). Omit for all categories.',
        },
        order: {
          type: 'string',
          enum: ['newest', 'relevance'],
          description:
            '"newest" (default) returns most recently published first; "relevance" ranks by match quality against the query.',
        },
        limit: { type: ['number', 'string'], description: 'Number of notices to return (1-50). Default 10.' },
        page: { type: ['number', 'string'], description: 'Zero-based results page for pagination. Default 0.' },
      },
    },
  },
  {
    name: 'nl_tender_detail',
    description:
      'Fetch one Dutch public-procurement notice from TenderNed (Netherlands government tender platform) by its publication id, e.g. "433909". Returns the full shaped aanbesteding notice: title, buyer/opdrachtgever, complete description, notice type, procedure, legal framework, national/European scope, CPV codes with Dutch labels, NUTS region codes, keywords, award status (gegund), related publications, official PDF link, and the public TenderNed URL. Use the id from nl_tender_search or nl_tender_recent results.',
    inputSchema: {
      type: 'object',
      properties: {
        publication_id: {
          type: ['string', 'number'],
          description: 'TenderNed publication id (publicatieId), e.g. "433909" or 433910.',
        },
      },
      required: ['publication_id'],
    },
  },
  {
    name: 'nl_tender_recent',
    description:
      'List the latest Dutch government tenders and contract awards published on TenderNed (Netherlands public procurement / aanbestedingen platform) in the last N days. Great for monitoring new Dutch contract notices, fresh award announcements (gegunde opdrachten), and upcoming bid deadlines. Optionally filter to one notice type (contract notice, award, prior announcement, rectification, market consultation, modification). Returns shaped notices newest-first with id, title, buyer, closing deadline, days until closing, and TenderNed URL.',
    inputSchema: {
      type: 'object',
      properties: {
        days: {
          type: ['number', 'string'],
          description: 'Lookback window in days (1-90). Default 7 — notices published in the last week.',
        },
        notice_type: {
          type: 'string',
          description:
            'Filter by notice type. Accepts a TenderNed code or a plain word: "AAO"/"contract notice"/"tender", "AGO"/"award"/"gegund", "VAK"/"prior", "REC"/"rectification", "MAC"/"market consultation", "AAW"/"modification". Omit for all types.',
        },
        limit: { type: ['number', 'string'], description: 'Number of notices to return (1-50). Default 10.' },
        page: { type: ['number', 'string'], description: 'Zero-based results page for pagination. Default 0.' },
      },
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    switch (name) {
      case 'nl_tender_search':
        return await searchTenders(args);
      case 'nl_tender_detail':
        return await getDetail(args);
      case 'nl_tender_recent':
        return await recentTenders(args);
      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (e) {
    return {
      error: e instanceof Error ? e.message : String(e),
      retry_hint: 'TenderNed may be briefly unavailable — retry once; if it persists, narrow the query or date range.',
    };
  }
}

// --- tools -----------------------------------------------------------------

async function searchTenders(args: Record<string, unknown>): Promise<unknown> {
  const query = strArg(args.query);
  const dateFrom = dateArg(args.date_from);
  const dateTo = dateArg(args.date_to);
  const limit = clampInt(args.limit, 10, 1, 50);
  const page = clampInt(args.page, 0, 0, 100000);
  const order = strArg(args.order)?.toLowerCase() === 'relevance' ? 'relevance' : 'newest';

  const typeRes = resolveType(strArg(args.notice_type));
  if ('error' in typeRes) return typeRes;

  const cpv = strArg(args.cpv_code);
  if (cpv && !/^\d{8}-\d$/.test(cpv)) {
    return {
      error: `Invalid cpv_code "${cpv}". TenderNed requires the full CPV format with check digit, e.g. "48000000-8".`,
      retry_hint: 'Use the 8-digit CPV code plus its check digit, like "45000000-7" or "72000000-5".',
    };
  }

  const params = new URLSearchParams({ page: String(page), size: String(limit) });
  if (query) params.set('search', query);
  if (typeRes.code) params.set('publicatieType', typeRes.code);
  if (dateFrom) params.set('publicatieDatumVanaf', dateFrom);
  if (dateTo) params.set('publicatieDatumTot', dateTo);
  if (cpv) params.set('cpvCodes', cpv);
  // Relevance order is the API default for a text search; date order needs an
  // explicit sort. (The upstream ignores the "asc" direction — desc only.)
  if (order === 'newest' || !query) params.set('sort', 'publicatieDatum,desc');

  const data = await tendernedGet(`${BASE}?${params.toString()}`);
  return shapePage(data, { query, notice_type: typeRes.code ?? undefined, date_from: dateFrom, date_to: dateTo, cpv_code: cpv, order, page, limit });
}

async function recentTenders(args: Record<string, unknown>): Promise<unknown> {
  const days = clampInt(args.days, 7, 1, 90);
  const limit = clampInt(args.limit, 10, 1, 50);
  const page = clampInt(args.page, 0, 0, 100000);
  const typeRes = resolveType(strArg(args.notice_type));
  if ('error' in typeRes) return typeRes;

  const from = new Date(Date.now() - days * 86400000);
  const dateFrom = fmtDate(from);

  const params = new URLSearchParams({
    page: String(page),
    size: String(limit),
    publicatieDatumVanaf: dateFrom,
    sort: 'publicatieDatum,desc',
  });
  if (typeRes.code) params.set('publicatieType', typeRes.code);

  const data = await tendernedGet(`${BASE}?${params.toString()}`);
  return shapePage(data, { days, date_from: dateFrom, notice_type: typeRes.code ?? undefined, page, limit });
}

async function getDetail(args: Record<string, unknown>): Promise<unknown> {
  const id = strArg(args.publication_id);
  if (!id || !/^\d+$/.test(id)) {
    return {
      error: 'nl_tender_detail requires "publication_id" — a numeric TenderNed publication id like "433909".',
      retry_hint: 'Get ids from nl_tender_search or nl_tender_recent results (the "id" field).',
    };
  }
  const d = (await tendernedGet(`${BASE}/${id}`)) as Record<string, any>;
  return {
    id: d.publicatieId ?? Number(id),
    title: d.aanbestedingNaam ?? null,
    buyer: d.opdrachtgeverNaam ?? null,
    description: d.opdrachtBeschrijving ?? null,
    publication_date: d.publicatieDatum ?? null,
    notice_type: d.aankondigingCode?.omschrijving ?? d.typePublicatie ?? null,
    notice_type_code: d.aankondigingCode?.code ?? null,
    publication_form: d.typePublicatie ?? null,
    legal_framework: d.juridischKaderCode?.omschrijving ?? null,
    scope: d.nationaalOfEuropeesCode?.omschrijving ?? null,
    contract_type: d.typeOpdrachtCode?.omschrijving ?? null,
    contract_nature: d.opdrachtAardCode?.omschrijving ?? null,
    procedure: d.procedureCode?.omschrijving ?? null,
    cpv_codes: Array.isArray(d.cpvCodes)
      ? d.cpvCodes.map((c: any) => ({ code: c.code, description: c.omschrijving, main: c.isHoofdOpdracht === true }))
      : [],
    nuts_codes: Array.isArray(d.nutsCodes)
      ? d.nutsCodes.map((n: any) => ({ code: n.code, description: n.omschrijving }))
      : [],
    keywords: [d.trefwoord1, d.trefwoord2, d.trefwoord3]
      .filter((t: unknown): t is string => typeof t === 'string' && t.length > 0)
      .map((t) => t.replace(/^"|"$/g, '')),
    reference_number: d.referentieNummer ?? null,
    status: d.aanbestedingStatus ?? null,
    awarded: d.isGegund ?? null,
    completed: d.afgerondeAanbesteding ?? null,
    terminated_early: d.isVroegtijdigBeeindigd ?? null,
    digital_submission: d.isDigitaalInschrijvenMogelijk ?? null,
    related_publications: Array.isArray(d.gerelateerdePublicaties)
      ? d.gerelateerdePublicaties.map((r: any) => ({
          id: r.publicatieId,
          publication_date: r.publicatieDatum,
          notice_type: r.typePublicatie,
          url: r.publicatieId != null ? NOTICE_URL(r.publicatieId) : null,
        }))
      : [],
    pdf_url: d.links?.pdf?.href ? `https://www.tenderned.nl${d.links.pdf.href}` : null,
    url: NOTICE_URL(d.publicatieId ?? id),
  };
}

// --- shaping ---------------------------------------------------------------

function shapeListItem(r: Record<string, any>): Record<string, unknown> {
  const desc = typeof r.opdrachtBeschrijving === 'string' ? r.opdrachtBeschrijving : null;
  return {
    id: r.publicatieId,
    title: r.aanbestedingNaam ?? null,
    buyer: r.opdrachtgeverNaam ?? null,
    publication_date: r.publicatieDatum ?? null,
    notice_type: r.typePublicatie?.omschrijving ?? null,
    notice_type_code: r.typePublicatie?.code ?? null,
    contract_type: r.typeOpdracht?.omschrijving ?? null,
    procedure: r.procedure?.omschrijving ?? null,
    closing_date: r.sluitingsDatum ?? null,
    days_until_closing: r.aantalDagenTotSluitingsDatum ?? null,
    european: r.europees ?? null,
    status: r.publicatiestatus?.omschrijving ?? null,
    description: desc && desc.length > 400 ? `${desc.slice(0, 400)}…` : desc,
    url: r.publicatieId != null ? NOTICE_URL(r.publicatieId) : null,
  };
}

function shapePage(data: unknown, echo: Record<string, unknown>): Record<string, unknown> {
  const d = data as { content?: any[]; totalElements?: number; totalPages?: number; number?: number };
  const notices = (d.content ?? []).map(shapeListItem);
  const cleanEcho: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(echo)) if (v !== undefined && v !== null) cleanEcho[k] = v;
  return {
    source: 'TenderNed (tenderned.nl) — official Dutch national public-procurement platform',
    country: 'Netherlands',
    total_count: d.totalElements ?? notices.length,
    total_pages: d.totalPages ?? null,
    count: notices.length,
    ...cleanEcho,
    notices,
  };
}

// --- upstream fetch --------------------------------------------------------

async function tendernedGet(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': UA },
      signal: controller.signal,
    });
  } catch (e) {
    const aborted = e instanceof Error && e.name === 'AbortError';
    throw new Error(aborted ? `TenderNed API timed out after ${TIMEOUT_MS / 1000}s` : `TenderNed API fetch failed: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 404) {
    throw new Error('TenderNed: publication not found (404). Check the publication_id — ids come from nl_tender_search results.');
  }
  if (!res.ok) {
    const body = await res.text().then((t) => t.slice(0, 300)).catch(() => '');
    // The API returns a JSON body with a "message" field on validation errors.
    let message = body;
    try {
      const parsed = JSON.parse(body) as { message?: string };
      if (parsed?.message) message = parsed.message;
    } catch { /* keep raw body */ }
    throw new Error(`TenderNed API: HTTP ${res.status}${message ? ` — ${message}` : ''}`);
  }
  return res.json();
}

// --- helpers ---------------------------------------------------------------

function resolveType(v: string | undefined): { code: string | null } | { error: string; retry_hint: string } {
  if (!v) return { code: null };
  const key = v.trim().toLowerCase();
  const code = TYPE_ALIASES[key] ?? (TYPE_LABELS[v.trim().toUpperCase()] ? v.trim().toUpperCase() : undefined);
  if (!code) {
    return {
      error: `Unrecognized notice_type "${v}".`,
      retry_hint: `Use one of: ${Object.entries(TYPE_LABELS).map(([c, l]) => `${c} (${l})`).join(', ')} — plain words like "award" or "market consultation" also work.`,
    };
  }
  return { code };
}

function fmtDate(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function dateArg(v: unknown): string | undefined {
  const s = strArg(v);
  if (!s) return undefined;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  return m ? m[1] : undefined;
}

function strArg(v: unknown): string | undefined {
  if (typeof v === 'string') {
    const t = v.trim();
    return t ? t : undefined;
  }
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

function clampInt(v: unknown, dflt: number, min: number, max: number): number {
  let n: number;
  if (typeof v === 'number' && Number.isFinite(v)) n = Math.trunc(v);
  else if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) n = Math.trunc(Number(v));
  else return dflt;
  return Math.min(max, Math.max(min, n));
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
