// YC startup leads scraper — standalone, no dependencies beyond Node 20+.
//
// Pulls Y Combinator companies (via the yc-oss community mirror), filters by
// ICP (industry, size, geography, isHiring), fetches founder names + LinkedIn
// from each company's YC page, optionally verifies emails via MailsFinder.
// Outputs a CSV of leads with verified contact info.
//
// Usage:
//   node scrape.js [--config=config.json]
//
// See config.example.json for input shape.

import fs from 'node:fs';
import path from 'node:path';

// ============================================================================
// Defaults — override via config.json
// ============================================================================

const DEFAULTS = {
    industries: ['fintech', 'healthtech', 'hr_tech'],
    geographies: ['united_states', 'canada'],
    employeeCountMin: 3,
    employeeCountMax: 200,
    requireIsHiring: true,
    batchYears: ['2024', '2025'], // include any batch whose name contains these years
    enableEmailEnrichment: false,
    mailsfinderApiKey: '',
    output: {
        csvPath: 'leads.csv',
        jsonPath: 'leads.json',
    },
    concurrency: 8,
};

// ============================================================================
// Industry classification
// ============================================================================

const INDUSTRY_KEYWORDS = {
    fintech: ['fintech', 'financial', 'banking', 'payment', 'lending', 'insurance', 'insurtech', 'wealth'],
    healthtech: ['healthtech', 'health tech', 'digital health', 'healthcare', 'health care', 'hospital', 'clinical', 'patient', 'medical', 'telemedicine', 'telehealth', 'mental health', 'biotech'],
    hr_tech: ['hr tech', 'hrtech', 'people ops', 'payroll', 'hris', 'recruiting', 'talent acquisition', 'employee benefits', 'workforce'],
};

function matchesIndustry(blob, allowed) {
    if (!blob) return false;
    const lower = blob.toLowerCase();
    return allowed.some((ind) => (INDUSTRY_KEYWORDS[ind] || []).some((kw) => lower.includes(kw)));
}

// ============================================================================
// Geography
// ============================================================================

const GEO_KEYWORDS = {
    united_states: ['united states', 'usa', ', us'],
    canada: ['canada', ', ca'],
    united_kingdom: ['united kingdom', ', uk', 'london', 'england'],
    germany: ['germany', 'berlin'],
    india: ['india', 'bangalore', 'bengaluru'],
    remote: ['remote'],
};

function matchesGeo(location, allowed) {
    if (!location) return true; // bias toward inclusion when unknown
    const lower = location.toLowerCase();
    return allowed.some((g) => (GEO_KEYWORDS[g] || []).some((kw) => lower.includes(kw)));
}

// ============================================================================
// YC company list
// ============================================================================

async function fetchYcCompanies() {
    const res = await fetch('https://yc-oss.github.io/api/companies/all.json');
    if (!res.ok) throw new Error(`YC fetch failed: ${res.status}`);
    return res.json();
}

function filterCompanies(all, cfg) {
    // --all flag: skip every ICP filter. Only basic sanity check.
    if (cfg.all) {
        return all.filter((c) => c.name);
    }
    return all.filter((c) => {
        if (!c.name || !c.website) return false;
        if (c.status && ['Inactive', 'Dead'].includes(c.status)) return false;
        if (cfg.requireIsHiring && c.isHiring !== true) return false;
        if (c.team_size != null) {
            if (c.team_size < cfg.employeeCountMin) return false;
            if (c.team_size > cfg.employeeCountMax) return false;
        }
        const batch = c.batch || '';
        if (!cfg.batchYears.some((y) => batch.includes(y))) return false;
        const indBlob = [c.industry, c.subindustry, c.one_liner, (c.tags || []).join(' ')]
            .filter(Boolean)
            .join(' ');
        if (!matchesIndustry(indBlob, cfg.industries)) return false;
        if (!matchesGeo(c.all_locations, cfg.geographies)) return false;
        return true;
    });
}

// ============================================================================
// YC founder fetch — extract from the company's YC page
// ============================================================================

async function fetchYcFounders(slug) {
    const url = `https://www.ycombinator.com/companies/${encodeURIComponent(slug)}`;
    let html;
    try {
        const res = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
                Accept: 'text/html,application/xhtml+xml',
            },
        });
        if (!res.ok) return [];
        html = await res.text();
    } catch {
        return [];
    }
    return parseFoundersFromYcHtml(html);
}

function parseFoundersFromYcHtml(html) {
    // YC embeds founder data as HTML-entity-encoded JSON in the page source.
    const decoded = html
        .replace(/&quot;/g, '"')
        .replace(/&#x27;/g, "'")
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');

    const json = extractJsonArrayAfterKey(decoded, '"founders"');
    if (!json) return [];
    let parsed;
    try { parsed = JSON.parse(json); } catch { return []; }
    if (!Array.isArray(parsed)) return [];

    const out = [];
    for (const f of parsed) {
        if (!f || typeof f !== 'object') continue;
        const fullName = typeof f.full_name === 'string' ? f.full_name.trim() : null;
        if (!fullName) continue;
        const parts = fullName.split(/\s+/);
        if (parts.length < 2) continue;
        out.push({
            fullName,
            firstName: parts[0],
            lastName: parts.slice(1).join(' '),
            title: typeof f.title === 'string' ? f.title.trim() : 'Founder',
            linkedinUrl: typeof f.linkedin_url === 'string' ? f.linkedin_url : null,
            twitterUrl: typeof f.twitter_url === 'string' ? f.twitter_url : null,
            bio: typeof f.founder_bio === 'string' ? f.founder_bio.trim() : null,
        });
    }
    return out;
}

// Fetch open roles from workatastartup.com — YC's standalone jobs board.
// The company's WAS page contains a "jobs":[{title:..., ...}] JSON block.
// Returns array of role title strings; empty array if the company isn't
// listed there or has no open roles.
async function fetchHiringRoles(slug) {
    const url = `https://www.workatastartup.com/companies/${encodeURIComponent(slug)}`;
    let html;
    try {
        const res = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
                Accept: 'text/html,application/xhtml+xml',
            },
        });
        if (!res.ok) return [];
        html = await res.text();
    } catch {
        return [];
    }
    const decoded = html
        .replace(/&quot;/g, '"')
        .replace(/&#x27;/g, "'")
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
    const json = extractJsonArrayAfterKey(decoded, '"jobs"');
    if (!json) return [];
    try {
        const parsed = JSON.parse(json);
        if (!Array.isArray(parsed)) return [];
        return parsed
            .map((j) => (j && typeof j.title === 'string') ? j.title.trim() : null)
            .filter(Boolean);
    } catch {
        return [];
    }
}

function extractJsonArrayAfterKey(s, key) {
    const idx = s.indexOf(key);
    if (idx < 0) return null;
    let i = idx + key.length;
    while (i < s.length && /\s/.test(s[i])) i++;
    if (s[i] !== ':') return null;
    i++;
    while (i < s.length && /\s/.test(s[i])) i++;
    if (s[i] !== '[') return null;
    let depth = 1, inStr = false, escape = false, j = i + 1;
    while (j < s.length && depth > 0) {
        const ch = s[j];
        if (escape) { escape = false; j++; continue; }
        if (ch === '\\') { escape = true; j++; continue; }
        if (ch === '"') { inStr = !inStr; j++; continue; }
        if (!inStr) {
            if (ch === '[' || ch === '{') depth++;
            else if (ch === ']' || ch === '}') depth--;
        }
        j++;
    }
    return depth === 0 ? s.slice(i, j) : null;
}

// ============================================================================
// MailsFinder
// ============================================================================

async function findEmail(firstName, lastName, domain, apiKey) {
    if (!apiKey) return { email: null, status: 'not_enriched' };
    try {
        const res = await fetch('https://server.mailsfinder.com/api/access-key/email/findEmail', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({ first_name: firstName, last_name: lastName, domain }),
        });
        if (res.status === 401 || res.status === 403) return { email: null, status: 'error' };
        if (!res.ok) return { email: null, status: 'not_found' };
        const body = await res.json();
        const email = extractEmail(body);
        return email ? { email, status: 'verified' } : { email: null, status: 'not_found' };
    } catch {
        return { email: null, status: 'error' };
    }
}

function extractEmail(body) {
    if (!body || typeof body !== 'object') return null;
    const direct = pickEmail(body.email);
    if (direct) return direct;
    for (const k of ['data', 'result', 'response']) {
        if (body[k] && typeof body[k] === 'object') {
            const e = pickEmail(body[k].email);
            if (e) return e;
        }
    }
    return null;
}

function pickEmail(v) {
    if (typeof v !== 'string') return null;
    const t = v.trim();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t) ? t : null;
}

// Try formal first name, then common nicknames (Christian -> Chris, etc.)
const NICKNAMES = {
    christian: ['chris'], christopher: ['chris'], michael: ['mike'],
    robert: ['rob', 'bob'], richard: ['rick', 'rich'], william: ['will', 'bill'],
    james: ['jim'], joseph: ['joe'], daniel: ['dan'], anthony: ['tony'],
    nicholas: ['nick'], alexander: ['alex'], benjamin: ['ben'], samuel: ['sam'],
    matthew: ['matt'], patrick: ['pat'], jonathan: ['jon', 'john'],
    elizabeth: ['liz', 'beth'], jennifer: ['jen'], katherine: ['kate', 'kat'],
};

async function findEmailWithVariants(firstName, lastName, domain, apiKey) {
    const variants = [firstName, ...(NICKNAMES[firstName.toLowerCase()] || [])];
    let last = { email: null, status: 'not_found' };
    for (const v of variants) {
        const r = await findEmail(v, lastName, domain, apiKey);
        if (r.status === 'verified') return r;
        if (r.status === 'error') return r;
        last = r;
    }
    return last;
}

// ============================================================================
// Concurrency limiter
// ============================================================================

async function runWithConcurrency(items, concurrency, fn) {
    const out = new Array(items.length);
    let i = 0;
    const workers = Array.from({ length: concurrency }, async () => {
        while (true) {
            const idx = i++;
            if (idx >= items.length) return;
            try { out[idx] = await fn(items[idx], idx); }
            catch (e) { out[idx] = { error: String(e) }; }
        }
    });
    await Promise.all(workers);
    return out;
}

// ============================================================================
// Domain extraction
// ============================================================================

function extractDomain(url) {
    if (!url) return null;
    try {
        const u = new URL(url.startsWith('http') ? url : 'https://' + url);
        return u.hostname.replace(/^www\./, '').toLowerCase();
    } catch { return null; }
}

// ============================================================================
// CSV writer
// ============================================================================

function writeCsv(filePath, rows) {
    if (rows.length === 0) {
        fs.writeFileSync(filePath, '');
        return;
    }
    const cols = Object.keys(rows[0]);
    const escape = (v) => {
        if (v == null) return '';
        const s = String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [cols.join(',')];
    for (const r of rows) lines.push(cols.map((c) => escape(r[c])).join(','));
    fs.writeFileSync(filePath, lines.join('\n') + '\n');
}

// ============================================================================
// Diff + watch — detect changes between runs
// ============================================================================

// Compare two arrays of rows. Identity is (company_name + full_name).
// Returns one of three classifications per row + the list of fields that
// changed for `updated` rows.
function diffSnapshots(oldRows, newRows) {
    const keyOf = (r) => `${(r.company_name || '').toLowerCase()}|${(r.full_name || '').toLowerCase()}`;
    const oldByKey = new Map((oldRows || []).map((r) => [keyOf(r), r]));
    const newByKey = new Map((newRows || []).map((r) => [keyOf(r), r]));
    const allKeys = new Set([...oldByKey.keys(), ...newByKey.keys()]);

    // Fields we ignore in the diff (volatile or irrelevant).
    const IGNORE = new Set(['email_status', 'yc_page']);

    const changes = [];
    for (const k of allKeys) {
        const o = oldByKey.get(k);
        const n = newByKey.get(k);
        if (!o && n) { changes.push({ type: 'new', row: n }); continue; }
        if (o && !n) { changes.push({ type: 'removed', row: o }); continue; }
        const changedFields = [];
        for (const field of Object.keys(n)) {
            if (IGNORE.has(field)) continue;
            if (String(o[field] ?? '') !== String(n[field] ?? '')) changedFields.push(field);
        }
        if (changedFields.length > 0) {
            changes.push({ type: 'updated', before: o, after: n, changed_fields: changedFields });
        }
    }
    return changes;
}

function summarizeChanges(changes) {
    const out = { new: 0, updated: 0, removed: 0, by_field: {} };
    for (const c of changes) {
        out[c.type]++;
        if (c.type === 'updated') {
            for (const f of c.changed_fields) out.by_field[f] = (out.by_field[f] ?? 0) + 1;
        }
    }
    return out;
}

async function notifySlack(webhookUrl, summary, changes) {
    if (!webhookUrl) return;
    const lines = [
        `:satellite: *YC scrape complete* — ${summary.new} new, ${summary.updated} updated, ${summary.removed} removed`,
    ];
    if (Object.keys(summary.by_field).length > 0) {
        const top = Object.entries(summary.by_field).sort((a, b) => b[1] - a[1]).slice(0, 6);
        lines.push('Fields changed: ' + top.map(([f, n]) => `${f}=${n}`).join(', '));
    }
    // Surface up to 6 most interesting items
    const interesting = changes.filter((c) => c.type !== 'updated' || c.changed_fields.some((f) => ['is_hiring', 'hiring_roles', 'team_size', 'title'].includes(f))).slice(0, 6);
    for (const c of interesting) {
        if (c.type === 'new') lines.push(`• :new: ${c.row.company_name} — ${c.row.full_name} (${c.row.title})`);
        else if (c.type === 'removed') lines.push(`• :x: ${c.row.company_name} — ${c.row.full_name} (removed)`);
        else lines.push(`• :pencil2: ${c.after.company_name} — ${c.after.full_name}: ${c.changed_fields.join(', ')}`);
    }
    try {
        await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: lines.join('\n') }),
        });
    } catch (e) {
        console.error('Slack notify failed:', e.message);
    }
}

// ============================================================================
// Main
// ============================================================================

async function main() {
    const argv = process.argv.slice(2);
    const cfgPath = argv.find((a) => a.startsWith('--config='))?.split('=')[1] || 'config.json';
    const allFlag = argv.includes('--all');
    const watchFlag = argv.includes('--watch');
    const slackFlag = argv.find((a) => a.startsWith('--slack='))?.split('=')[1] || process.env.SLACK_WEBHOOK_URL || '';
    const masterFlag = argv.find((a) => a.startsWith('--master='))?.split('=')[1] || 'leads.json';
    const changesFlag = argv.find((a) => a.startsWith('--changes-out='))?.split('=')[1] || 'changes.json';
    let cfg = { ...DEFAULTS };
    if (fs.existsSync(cfgPath)) {
        try {
            const userCfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
            cfg = { ...cfg, ...userCfg, output: { ...DEFAULTS.output, ...(userCfg.output || {}) } };
            console.log(`Loaded config from ${cfgPath}`);
        } catch (e) {
            console.error(`Config parse error: ${e}. Using defaults.`);
        }
    } else {
        console.log(`No ${cfgPath} found. Using defaults. Set MAILSFINDER_API_KEY env var to enable email enrichment.`);
    }
    if (allFlag) cfg.all = true;
    if (!cfg.mailsfinderApiKey && process.env.MAILSFINDER_API_KEY) {
        cfg.mailsfinderApiKey = process.env.MAILSFINDER_API_KEY;
        cfg.enableEmailEnrichment = true;
    }

    console.log(`Fetching YC companies...`);
    const all = await fetchYcCompanies();
    console.log(`Got ${all.length} total. Filtering${cfg.all ? ' (--all flag: skipping ICP filters)' : ''}...`);

    const filtered = filterCompanies(all, cfg);
    console.log(`After filter: ${filtered.length}`);

    console.log(`Fetching founders + hiring roles for ${filtered.length} companies (concurrency=${cfg.concurrency})...`);
    const enriched = await runWithConcurrency(filtered, cfg.concurrency, async (c) => {
        // Two parallel fetches per company: YC page (founders) and Work-at-a-
        // Startup page (open roles, only if isHiring=true).
        const [founders, hiringRoles] = await Promise.all([
            fetchYcFounders(c.slug),
            c.isHiring === true ? fetchHiringRoles(c.slug) : Promise.resolve([]),
        ]);
        const domain = extractDomain(c.website);
        const rows = [];
        for (const f of founders) {
            let email = null, emailStatus = 'not_enriched';
            if (cfg.enableEmailEnrichment && cfg.mailsfinderApiKey && domain) {
                const r = await findEmailWithVariants(f.firstName, f.lastName, domain, cfg.mailsfinderApiKey);
                email = r.email;
                emailStatus = r.status;
            }
            rows.push({
                company_name: c.name,
                full_name: f.fullName,
                title: f.title,
                linkedin_url: f.linkedinUrl || '',
                twitter_url: f.twitterUrl || '',
                bio: f.bio || '',
                description_short: c.one_liner || '',
                description_long: c.long_description || '',
                team_size: c.team_size != null ? c.team_size : '',
                industry: c.industry || '',
                sub_industry: c.subindustry || '',
                location: c.all_locations || '',
                is_hiring: c.isHiring === true ? 'true' : 'false',
                hiring_roles: hiringRoles.join('; '),
                website: c.website || '',
                batch: c.batch || '',
                // bonus columns kept beyond your 14 — easy to drop if not needed:
                email: email || '',
                email_status: emailStatus,
                yc_page: `https://www.ycombinator.com/companies/${c.slug}`,
            });
        }
        return rows;
    });

    const allRows = enriched.flat().filter((r) => r && !r.error);
    const verified = allRows.filter((r) => r.email_status === 'verified');
    const withRoles = allRows.filter((r) => r.hiring_roles).length;

    // ===== Watch mode: diff vs previous master, persist updates, notify =====
    if (watchFlag) {
        let oldRows = [];
        if (fs.existsSync(masterFlag)) {
            try {
                oldRows = JSON.parse(fs.readFileSync(masterFlag, 'utf-8'));
                console.log(`Loaded previous snapshot from ${masterFlag} (${oldRows.length} rows)`);
            } catch (e) {
                console.error(`Could not parse ${masterFlag}: ${e}. Treating as first run.`);
            }
        } else {
            console.log(`No prior master at ${masterFlag} — first run, all rows will be 'new'.`);
        }
        const changes = diffSnapshots(oldRows, allRows);
        const summary = summarizeChanges(changes);
        const changeReport = {
            run_at: new Date().toISOString(),
            summary,
            changes,
        };
        fs.writeFileSync(changesFlag, JSON.stringify(changeReport, null, 2));
        // Update the master so the next run diffs against this state.
        fs.writeFileSync(masterFlag, JSON.stringify(allRows, null, 2));
        console.log(`\nWatch summary: ${summary.new} new, ${summary.updated} updated, ${summary.removed} removed`);
        if (Object.keys(summary.by_field).length > 0) {
            const top = Object.entries(summary.by_field).sort((a, b) => b[1] - a[1]).slice(0, 6);
            console.log(`  Fields changed: ${top.map(([f, n]) => `${f}=${n}`).join(', ')}`);
        }
        console.log(`  Master: ${path.resolve(masterFlag)}`);
        console.log(`  Changes: ${path.resolve(changesFlag)}`);
        await notifySlack(slackFlag, summary, changes);
    } else {
        writeCsv(cfg.output.csvPath, allRows);
        fs.writeFileSync(cfg.output.jsonPath, JSON.stringify(allRows, null, 2));
    }

    console.log(`\nDone.`);
    console.log(`  Total founder rows: ${allRows.length}`);
    console.log(`  Rows with hiring roles populated: ${withRoles}`);
    console.log(`  Verified emails: ${verified.length}`);
    if (!watchFlag) {
        console.log(`  CSV: ${path.resolve(cfg.output.csvPath)}`);
        console.log(`  JSON: ${path.resolve(cfg.output.jsonPath)}`);
    }
}

main().catch((e) => {
    console.error('Fatal:', e);
    process.exit(1);
});
