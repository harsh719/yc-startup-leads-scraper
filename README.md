# YC Startup Leads Scraper

Standalone Node script that exports founder-level data for **every Y Combinator company** (or a filtered ICP slice). Pulls company metadata + founder names, titles, LinkedIn, Twitter, bio + currently-open hiring roles from Work-at-a-Startup. Optional verified-email lookup via [MailsFinder](https://mailsfinder.com).

Single file. No dependencies beyond Node 20+. Three modes:

| Mode | Command | Purpose |
|---|---|---|
| **Filtered ICP leads** (default) | `node scrape.js` | Only currently-hiring YC companies in your ICP. Designed for B2B outbound. |
| **Full export** | `node scrape.js --all` | Every YC company (~5,690), every listed founder. No filters. |
| **Watch (diff vs prior run)** | `node scrape.js --watch` | Run on a schedule. Detects new/updated/removed rows since last run. Optional Slack notification. |

All three modes use the same output schema.

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

## Watch mode — detect changes between runs

YC doesn't push notifications. To stay in sync with what changes upstream, run the scraper on a schedule and let it diff each run against the previous one.

```bash
# Initial baseline
node scrape.js --all --watch --master=master.json --changes-out=changes.json

# Subsequent runs (cron / GitHub Action / Apify schedule)
node scrape.js --all --watch --master=master.json --changes-out=changes.json
```

Each run:
1. Re-scrapes the configured set (filtered or `--all`).
2. Loads the previous snapshot from `--master` (the rolling truth file).
3. Diffs new vs old, keyed by `company_name + full_name`.
4. Writes a structured `changes.json` containing `new`, `updated` (with the exact list of fields that changed), and `removed` rows.
5. Overwrites `--master` with the new state.

### Watch flags

| Flag | Default | Purpose |
|---|---|---|
| `--watch` | off | Enables diff mode. |
| `--master=path` | `leads.json` | Rolling master file. Read on entry, overwritten on exit. |
| `--changes-out=path` | `changes.json` | Diff output for the current run only. |
| `--slack=URL` *(or `SLACK_WEBHOOK_URL` env)* | none | Slack incoming webhook. When set, posts a summary of the diff. |

### `changes.json` shape

```json
{
  "run_at": "2026-04-28T16:00:00.000Z",
  "summary": {
    "new": 12,
    "updated": 47,
    "removed": 3,
    "by_field": { "team_size": 18, "hiring_roles": 22, "is_hiring": 9 }
  },
  "changes": [
    { "type": "new", "row": { ... full row ... } },
    {
      "type": "updated",
      "before": { ... old row ... },
      "after":  { ... new row ... },
      "changed_fields": ["team_size", "hiring_roles"]
    },
    { "type": "removed", "row": { ... old row ... } }
  ]
}
```

### What changes get caught

| Source | Fields that move |
|---|---|
| `yc-oss/api/companies/all.json` (refreshed daily) | `team_size`, `is_hiring`, `industry`, `sub_industry`, `location`, `website`, `batch`, `description_short`, `description_long` |
| `ycombinator.com/companies/<slug>` | Founder added/removed, `title`, `linkedin_url`, `twitter_url`, `bio` |
| `workatastartup.com/companies/<slug>` | `hiring_roles` (each posted/removed job) |

Volatile fields (`email_status`, `yc_page`) are **excluded** from the diff so transient enrichment differences don't generate noise.

### Scheduling examples

**Local cron (daily at 06:00):**
```cron
0 6 * * * cd /path/to/yc-startup-leads-scraper && /usr/local/bin/node scrape.js --all --watch --slack="$SLACK_WEBHOOK_URL" >> /var/log/yc-watch.log 2>&1
```

**GitHub Actions (free, public repos)** — drop this into `.github/workflows/watch.yml`:
```yaml
name: YC watch
on:
  schedule: [{ cron: '0 6 * * *' }]
  workflow_dispatch:
jobs:
  watch:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - name: Restore master from previous run
        uses: actions/cache@v4
        with: { path: master.json, key: yc-master-v1 }
      - run: node scrape.js --all --watch --master=master.json --changes-out=changes.json
        env: { SLACK_WEBHOOK_URL: ${{ secrets.SLACK_WEBHOOK_URL }} }
      - uses: actions/upload-artifact@v4
        with: { name: changes, path: changes.json }
```

**Apify schedule** — wrap the standalone in an Apify actor (see the companion [`b2b-intent-signals-scraper`](https://github.com/harsh719/b2b-intent-signals-scraper) for the structure), then set a daily schedule from the Apify Console.

### Slack notification

When `--slack=URL` (or `SLACK_WEBHOOK_URL` env) is set, each watch run posts a summary message:

```
:satellite: *YC scrape complete* — 12 new, 47 updated, 3 removed
Fields changed: hiring_roles=22, team_size=18, is_hiring=9, title=4, location=2, bio=1
• :new: Acme Health — Jane Doe (CEO)
• :pencil2: ClaimSorted — Pavel Gertsberg: hiring_roles, team_size
• :pencil2: Coval — Brooke Hopkins: bio
• :x: ZombieCo — John Smith (removed)
```

Only "interesting" updates are surfaced inline (changes to `is_hiring`, `hiring_roles`, `team_size`, `title`). The full diff is always in `changes.json`.

## License

MIT.
