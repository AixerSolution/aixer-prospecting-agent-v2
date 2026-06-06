# Aixer Solutions — Prospecting Agent v2 + Communicator

**GitHub:** https://github.com/AixerSolution/aixer-prospecting-agent-v2

An AI-powered Singapore SME lead generation system with directory-grounded seeding, contact verification, and dual-channel outreach (email + WhatsApp). Built for [Aixer Solutions](https://www.aixers.com).

This is v2 — a major upgrade over v1 that eliminates hallucinated companies by sourcing exclusively from official Singapore directories (BCA, SMA, CPE, SBF, SMF, etc.) and adds a contact verification gate before any outreach is drafted.

## How it works

### Prospecting pipeline (`prospecting_v2.mjs`)

Seven agents run in sequence:

| Phase | Agent | What it does |
|---|---|---|
| 0 | **Source Confirmation** | Displays proposed directory sources; prompts Y/n before starting |
| 1 (Step A) | **Prospector** | 5 parallel model-knowledge passes across different angles + 1 directory web-search pass |
| 1 (Step B) | **Enricher** | Web-searches each deduplicated candidate one at a time for real decision-makers and signals |
| 1.5 | **SME Verifier** | Discards companies that are too large (> SGD 5M), inactive, or have no web presence |
| 1.7 | **Contact Verifier** | Checks decision-maker via ACRA BizFile, LinkedIn, and company website; flags hallucinated names |
| 2 | **Fit Assessor** | Scores on 5 dimensions; qualified > 0.5, nurture 0.3–0.5 |
| 3A / 3B | **Outreach** | Generates a cold email + WhatsApp message per qualified lead |

### Communicator agent (`communicator.mjs`)

Runs **after** prospecting and adds a per-company research pass before drafting outreach. Where the prospector uses inferred sector pain points, the Communicator finds specific, evidence-backed challenges from each company's website, live job postings, news, and LinkedIn.

| Agent | What it does |
|---|---|
| **Agent 4** — Intelligence Researcher | Deep web search per company → 2–4 evidence-backed challenges with source links |
| **Agent 5A** — Email Composer | 3–4 sentence email anchored to the strongest piece of evidence |
| **Agent 5B** — WhatsApp Composer | Sub-100-word message distilling the key hook |

## Requirements

- Node.js 18+
- An [Anthropic API key](https://console.anthropic.com) with web search access enabled

## Setup

```bash
npm install
cp .env.example .env
# add your ANTHROPIC_API_KEY to .env
```

## Usage

### Prospecting

```bash
# Today's sector (rotates by day of week)
ANTHROPIC_API_KEY=sk-ant-... node prospecting_v2.mjs

# Specific sector
ANTHROPIC_API_KEY=sk-ant-... node prospecting_v2.mjs --sector "Healthcare"

# Skip the Y/n source confirmation prompt
ANTHROPIC_API_KEY=sk-ant-... node prospecting_v2.mjs --auto-confirm
```

### Communicator (run after prospecting)

```bash
# Process latest prospecting output — all qualified leads
ANTHROPIC_API_KEY=sk-ant-... node communicator.mjs

# Process a specific output file
ANTHROPIC_API_KEY=sk-ant-... node communicator.mjs --file output/prospecting_2026-06-04T18-21-28.json

# Only top-tier leads
ANTHROPIC_API_KEY=sk-ant-... node communicator.mjs --tier URGENT,PRIORITIZE

# Both filters
ANTHROPIC_API_KEY=sk-ant-... node communicator.mjs --file <path> --tier PRIORITIZE
```

## Configuration

| File | Purpose |
|---|---|
| `config.json` | Model, sector rotation, revenue/employee thresholds, max outreach per run |
| `20_SEARCH_MATRIX.json` | Per-sector directory sources, seed companies, pain signals, `low_online_presence` flag |
| `30_FIT_SCORING_RUBRIC.json` | Dimension weights and score thresholds |
| `40_EMAIL_TEMPLATES.json` | Email tone and format rules |
| `45_WHATSAPP_TEMPLATES.json` | WhatsApp tone and format rules |
| `50_SYSTEM_PROMPTS.md` | Full agent system prompts for reference |
| `60_COMMUNICATOR_PROMPTS.md` | Communicator agent prompts for reference |

**Target criteria:** Revenue SGD 100K–5M, 5–200 employees, Singapore-registered, not MNC/SGX-listed subsidiaries.

**Score thresholds:** PASS < 0.3 | NURTURE 0.3–0.5 | FOLLOW_UP 0.5–0.7 | PRIORITIZE 0.7–0.85 | URGENT > 0.85

## Directory source tiers

Companies must come from official Singapore directories — no freestyle web discovery.

- **Tier 1 (government registries):** BCA, CPE, SkillsFuture, AHPC
- **Tier 2 (professional bodies):** Law Society, ISCA, SIA, SMA, SDA, SFA, AFA
- **Tier 3 (trade/industry associations):** SBF, SMF, LAS, SPEA, RAS, SCAL, SCCCI, SMCCI, ASME

## `low_online_presence` flag

Set `"low_online_presence": true` in `20_SEARCH_MATRIX.json` for sectors where companies have limited online presence (e.g. ACMV/M&E contractors). This relaxes three checks:

- **SME Verifier:** BCA registration alone confirms existence — website check waived
- **Contact Verifier:** ACRA BizFile directors treated as verified
- **Fit Assessor:** absent tech hiring signals scored as neutral (0.45), not a penalty (0.2)

## Output

### Prospecting output (`output/prospecting_<timestamp>.json`)
- `qualified_leads` — score > 0.5, with verified contact info and outreach drafts
- `nurture_list` — score 0.3–0.5, saved for future follow-up
- `all_scored` — every company that reached fit assessment
- `outreach_drafts` — email + WhatsApp per qualified lead

### Communicator output (`communicator_output/communicator_<timestamp>.json`)
- Per-company evidence summary with source URLs
- Hyper-personalised email draft grounded in real evidence
- WhatsApp draft distilling the key hook

## Sector status

| Sector | Typical yield | Notes |
|---|---|---|
| Construction | 10–14/run | 14 BCA-verified seeds; most reliable sector |
| Healthcare | 2–4/run | SMA/SDA/AHPC directory sources |
| Education | 2–4/run | CPE/SkillsFuture registry sources |
| Electricity / ACMV | ~3/run | `low_online_presence=true`; BCA web-search pass |
| Manufacturing & Logistics | Low | HIGH hallucination risk — add seeds before use |
| Wholesale & Retail Trade | Low | Add seeds before running regularly |

## Rate limiting

- Step B enrichment: 8s sleep between each company
- SME verification: 12s sleep between each company
- Contact verification: 10s sleep between each company
- API errors: exponential backoff at 20/40/60/80s on 429 responses
