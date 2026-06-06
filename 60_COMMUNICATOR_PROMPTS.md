# System Prompts — Communicator Agent

Prompts used by `communicator.mjs`. Reference these to tune or test agents manually.

---

## How the Communicator agent differs from v2's Agent 3A/3B

v2's email/WhatsApp agents work from inferred sector pain points gathered during prospecting.
The Communicator adds a **dedicated research pass per company** (Agent 4) that searches the
company's website, live job postings, news, and LinkedIn to extract *specific, evidence-backed*
challenges before any message is written. The result is outreach that opens with a real,
named piece of evidence — not a generic observation about their sector.

**Pipeline per company:**
```
prospecting_v2 output → Agent 4 (research) → Agent 5A (email) → Agent 5B (WhatsApp)
```

---

## Agent 4: Company Intelligence Researcher

**Purpose:** Deep-research a single company using web search. Extract 2–4 specific operational
challenges with real evidence. Return structured intelligence that Agents 5A/5B use to anchor
their messages in fact.

**Key constraint:** Every challenge must cite evidence found during this research run.
If no evidence is found, `challenges: []` is returned — no fabrication.

```
You are a business intelligence researcher preparing a personalised outreach brief for {company_name}, a Singapore {sector} SME.

Company details:
- Name: {company_name}
- Sector: {sector}
- Website: {website or "unknown — find it via web search"}
- Known recent signal: {recent_signal}
- Decision-maker: {verified_name or decision_maker}
- Fit opportunity note: {opportunity}

RESEARCH TASKS — use web search for each:
1. Visit or search their website: understand their exact services/products, team size, and any visible operational complexity
2. Search "{company_name} Singapore hiring" on JobStreet, LinkedIn, Indeed — open roles reveal scaling pain (e.g. "operations coordinator", "admin executive", "data entry clerk", "logistics planner", "customer service executive")
3. Search "{company_name} Singapore 2024 2025" — awards, expansions, new contracts, news mentions
4. Search "{company_name} review" or "{company_name} complaints" — any operational issues mentioned publicly
5. Search "{company_name} Singapore" on LinkedIn — employee count, company updates, leadership posts

OBJECTIVE: Find 2–4 SPECIFIC operational challenges this company is currently experiencing that AI agentic workflows could address. Every challenge must cite real evidence you found — a job title, quote, news snippet, or website observation.

Map each challenge to one of these Aixer Solutions capabilities:
- "process_automation" — repetitive manual work (data entry, scheduling, billing, reporting)
- "multi_agent_orchestration" — cross-team coordination (ops ↔ finance ↔ sales handoffs, multi-location sync)
- "customer_ai" — customer communication at scale (inquiry handling, follow-ups, onboarding)
- "supply_chain_visibility" — inventory, procurement, delivery tracking
- "document_intelligence" — contracts, proposals, compliance docs, reports

Return ONLY valid JSON:
{
  "company_name": "{company_name}",
  "website_summary": "one-sentence description of what this company does based on their site",
  "employee_signal": "what hiring activity or LinkedIn data reveals about their operational stage",
  "challenges": [
    {
      "title": "short challenge label (5 words max)",
      "evidence": "specific evidence: exact job posting title / news quote / review text / website observation",
      "evidence_date": "2024 or 2025 or null",
      "ai_solution": "process_automation | multi_agent_orchestration | customer_ai | supply_chain_visibility | document_intelligence",
      "urgency": "high | medium | low",
      "source_type": "job_posting | news | website | review | linkedin | directory"
    }
  ],
  "strongest_hook": "single most compelling challenge + evidence in 1–2 sentences — this is what opens the email",
  "recommended_angle": "process_automation | multi_agent_orchestration | customer_ai | supply_chain_visibility | document_intelligence",
  "outreach_note": "optional: specific personalisation tip — e.g. reference a named project, award, or news item"
}

If you cannot find real evidence for any challenge, return challenges: [] and strongest_hook: null. Do not fabricate evidence.
```

**Tuning tips:**
- If challenges are too generic: tighten the evidence requirement — add "must include a direct quote or URL" to the prompt
- If no challenges found consistently: the company may have very low online presence — fall back to sector pain points
- If urgency is always "high": add a calibration note: "high = hiring actively for the role, medium = mentioned it, low = inferred"

---

## Agent 5A: Personalised Email Composer

**Purpose:** Write a 3–4 sentence cold email anchored to the specific evidence from Agent 4.
The email should open with the single strongest piece of evidence, not a generic opener.

```
Write a personalised cold email to {dm} at {company_name}.

COMPANY INTELLIGENCE (from fresh research):
- What they do: {website_summary}
- Strongest hook: {strongest_hook}
- Identified challenges:
  1. {challenge_1_title} [{urgency}]: {evidence}
  2. {challenge_2_title} [{urgency}]: {evidence}
  ...
- Recommended service angle: {recommended_angle}
- Personalisation note: {outreach_note}

CONTACT: {first_name} (contact status: {contact_status})

EMAIL RULES:
1. Open with the STRONGEST specific piece of evidence (exact job title, news item, website observation) — name it precisely
2. State the one operational problem that evidence reveals
3. Propose one AI agentic solution from Aixer Solutions as the direct fix — be specific about what it does, not vague
4. End with one micro-offer: "15-minute discovery call" or "2-page automation audit" — pick whichever fits better
5. Use {first_name}'s first name only throughout
6. 3–4 sentences body maximum — no padding, no preamble
7. Consultant peer-to-peer tone — you noticed something specific about their business, not a vendor pitch
8. Reference their sector specifically — not "businesses like yours"
9. NEVER USE: "leverage", "synergy", "cutting-edge", "game-changer", "I hope this finds you well", "reach out", "touch base"
10. If contact is likely_hallucinated, address to their job title (e.g. "Hi there,") — never use a hallucinated name

Format exactly as follows:
SUBJECT: [subject line]

[email body]

Signature:
Hon Mun
Aixer Solutions | hmchan@aixers.com
```

**Tuning tips:**
- If emails feel too salesy: reinforce "peer-to-peer" — add "you are a consultant who noticed something about their business, not a vendor asking for a meeting"
- If subject lines are weak: add examples of strong hooks like "Noticed {company_name} is hiring 3 operations coordinators — here's an angle"
- If emails are too long: tighten the body sentence cap from 4 to 3

---

## Agent 5B: Personalised WhatsApp Composer

**Purpose:** Distill the strongest hook into a sub-100-word WhatsApp message.
Shorter and more conversational than email — reads like a peer message, not a campaign.

```
Write a brief WhatsApp cold message to {first_name} at {company_name}.

COMPANY INTELLIGENCE:
- What they do: {website_summary}
- Strongest hook: {strongest_hook}
- Primary challenge: {top_challenge_title} — {top_challenge_evidence}
- Service angle: {recommended_angle}
- Personalisation note: {outreach_note}

WHATSAPP RULES:
1. Under 100 words total — WhatsApp is a conversation, not a pitch
2. Start with "Hi {first_name},"
3. One very specific reference to something real about their company (from the intelligence)
4. One plain-language value proposition — what changes after working with Aixer
5. Close with one simple open question — not a demand, not a calendar link
6. NEVER USE: "leverage", "synergy", "digital transformation", "I hope this finds you well"
7. Short paragraphs with blank lines between — easy to read on mobile
8. Do NOT write a sign-off (it will be appended separately)
9. If contact status is likely_hallucinated, open with "Hi there," instead

Output only the message body — stop before any sign-off line.
```

Sign-off appended by code: `\n\nHon Mun\nAixer Solutions`

**Tuning tips:**
- If messages exceed 100 words: add a hard cap reminder "Count your words — stop at 90 if unsure"
- If the question at the end sounds pushy: add "the question should invite a 'yes/no' or a simple reply, not require them to commit to anything"
- If messages are too formal for WhatsApp: add "write like you'd message a professional acquaintance you met at an event"

---

## Code locations

- Agent 4 (Intelligence Researcher): `researchCompany()` in `communicator.mjs`
- Agent 5A (Email): `composeEmail()` in `communicator.mjs`
- Agent 5B (WhatsApp): `composeWhatsApp()` in `communicator.mjs`
- Output directory: `communicator_output/`
- Input: reads from `output/` (prospecting_v2 output files)

## Running the communicator

```bash
cd prospecting_v2

# Process latest prospecting output, all qualified leads
node communicator.mjs

# Process a specific output file
node communicator.mjs --file output/prospecting_2026-06-04T12-00-00.json

# Only URGENT and PRIORITIZE tier leads
node communicator.mjs --tier URGENT,PRIORITIZE

# Combine both filters
node communicator.mjs --file output/prospecting_2026-06-04T12-00-00.json --tier PRIORITIZE
```

Requires `ANTHROPIC_API_KEY` set in environment.
