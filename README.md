# YC Startup Leads Scraper

Standalone Node script that produces verified-email B2B leads from Y Combinator companies that are **currently hiring**.

Single file. No dependencies beyond Node 20+. Reads YC's public company list, filters by ICP (industry, size, geography, `isHiring` flag, batch recency), fetches founder names + LinkedIn URLs from each company's YC page, optionally verifies emails via [MailsFinder](https://mailsfinder.com).

This is the proven pattern that produced ~75% verified-email hit rate in production runs.

## What you get

| Field | Source |
|---|---|
| `company_name`, `company_domain`, `website` | YC `companies.json` |
| `industry`, `subindustry`, `team_size`, `batch`, `location`, `one_liner` | YC `companies.json` |
| `first_name`, `last_name`, `title`, `linkedin_url` | YC company-page founders block |
| `email`, `email_status` | MailsFinder (if API key provided) |
| `yc_page` | constructed |

Output: CSV + JSON.

## Quick start

```bash
# 1. Clone
git clone https://github.com/harsh719/yc-startup-leads-scraper.git
cd yc-startup-leads-scraper

# 2. (Optional) Get a free MailsFinder API key for email verification
#    https://mailsfinder.com — sign up, copy your API key

# 3. Run with defaults (Fintech + Healthtech + HR Tech, US + Canada, currently hiring, 2024–2025 batches)
MAILSFINDER_API_KEY=your_key_here node scrape.js
```

Without a MailsFinder key the script still produces leads — names + LinkedIn URLs are populated from YC, the `email` column is blank.

## Custom config

```bash
cp config.example.json config.json
# Edit config.json — see schema below
node scrape.js --config=config.json
```

### Config schema

```json
{
  "industries": ["fintech", "healthtech", "hr_tech"],
  "geographies": ["united_states", "canada"],
  "employeeCountMin": 3,
  "employeeCountMax": 200,
  "requireIsHiring": true,
  "batchYears": ["2024", "2025"],
  "enableEmailEnrichment": true,
  "mailsfinderApiKey": "YOUR_KEY",
  "output": {
    "csvPath": "leads.csv",
    "jsonPath": "leads.json"
  },
  "concurrency": 8
}
```

| Field | Default | Notes |
|---|---|---|
| `industries` | `["fintech","healthtech","hr_tech"]` | Multi-select. Keywords matched against YC industry/subindustry/tags/one_liner. |
| `geographies` | `["united_states","canada"]` | Hard filter on `all_locations`. Available: `united_states`, `canada`, `united_kingdom`, `germany`, `india`, `remote`. |
| `employeeCountMin/Max` | `3` / `200` | Headcount window. Companies with unknown size are kept. |
| `requireIsHiring` | `true` | Drops YC companies whose `isHiring` flag isn't `true`. **This is the "currently hiring" signal.** |
| `batchYears` | `["2024","2025"]` | Match any batch name containing one of these years (e.g., "Winter 2024", "Fall 2025"). |
| `enableEmailEnrichment` | `false` | If true and `mailsfinderApiKey` set, looks up + verifies each founder's email. |
| `mailsfinderApiKey` | — | Bearer token from your MailsFinder dashboard. Falls back to `MAILSFINDER_API_KEY` env var. |
| `concurrency` | `8` | Concurrent fetches against YC + MailsFinder. Lower if you hit rate limits. |

## Industry keyword reference

The script doesn't trust YC's top-level `industry` tag alone (many real fintech/healthtech companies are tagged "B2B"). It checks **all of** `industry + subindustry + tags + one_liner` against keyword lists:

- **fintech** — fintech, financial, banking, payment, lending, insurance, insurtech, wealth
- **healthtech** — healthtech, digital health, healthcare, hospital, clinical, patient, medical, telemedicine, mental health, biotech
- **hr_tech** — hr tech, hrtech, people ops, payroll, hris, recruiting, talent acquisition, employee benefits, workforce

Edit the `INDUSTRY_KEYWORDS` constant in `scrape.js` to extend.

## How email verification works

For each founder pulled from YC, the script POSTs to MailsFinder's `/email/findEmail` endpoint with `{first_name, last_name, domain}`. MailsFinder runs MX lookup + SMTP probe + catch-all detection. Only addresses MailsFinder confirms as deliverable get `email_status = "verified"`.

The script also tries common nicknames (Christian → Chris, Michael → Mike, etc.) when the formal first name returns no match.

## Performance

- ~5,700 YC companies in the source list
- Filter pass produces ~50–100 ICP-qualified hiring companies (depends on filters)
- Each surviving company: 1 YC page fetch + 1–3 MailsFinder calls
- At `concurrency: 8` the full run takes 2–5 minutes

## Why this exists

Built as part of a larger B2B intent-signals scraper ([b2b-intent-signals-scraper](https://github.com/harsh719/b2b-intent-signals-scraper)) that pulls from 7 sources. After production runs across all sources, **YC + MailsFinder consistently outperformed every other source** for clean post-seed B2B leads in Fintech/Healthtech/HR Tech. This standalone version captures that pattern in 300 lines, no Apify SDK overhead, no LinkedIn-Jobs noise.

## License

MIT.
