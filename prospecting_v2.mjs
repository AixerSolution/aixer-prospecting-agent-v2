import Anthropic from "@anthropic-ai/sdk";
import * as fs from "fs";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const client = new Anthropic();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callWithRetry(fn, maxRetries = 4) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const is429 = err.message?.includes("429") || err.status === 429;
      if (is429 && attempt < maxRetries) {
        const wait = (attempt + 1) * 20000;
        console.log(`    ⏳ Rate limited — waiting ${wait / 1000}s before retry ${attempt + 1}/${maxRetries}...`);
        await sleep(wait);
      } else {
        throw err;
      }
    }
  }
}

// Load config
let CONFIG = {};
try {
  CONFIG = JSON.parse(fs.readFileSync(new URL("./config.json", import.meta.url)));
} catch { CONFIG = {}; }

const MODEL = CONFIG.model || "claude-sonnet-4-6";

const SECTORS = CONFIG.sectors_rotation || [
  "Manufacturing & Logistics",
  "Retail & E-commerce",
  "Financial Services",
  "Professional Services",
  "Healthcare",
];

// Load search matrix
let SEARCH_MATRIX = {};
try {
  SEARCH_MATRIX = JSON.parse(fs.readFileSync(new URL("./20_SEARCH_MATRIX.json", import.meta.url)));
} catch {}

function getDirectorySources(sector) {
  return SEARCH_MATRIX.sectors?.[sector]?.directory_sources || [];
}

function getSeedCompanies(sector) {
  return SEARCH_MATRIX.sectors?.[sector]?.seed_companies || [];
}

function getSubSectorFocus(sector) {
  return SEARCH_MATRIX.sectors?.[sector]?.sub_sector_focus || null;
}

function getLowOnlinePresence(sector) {
  return SEARCH_MATRIX.sectors?.[sector]?.low_online_presence || false;
}

function selectTodaysSector() {
  const sectorArg =
    process.argv.find((a) => a.startsWith("--sector="))?.split("=")[1] ||
    (() => {
      const i = process.argv.indexOf("--sector");
      return i !== -1 ? process.argv[i + 1] : null;
    })();
  if (sectorArg) return sectorArg;
  return SECTORS[new Date().getDay() % SECTORS.length];
}

// Normalize decision_maker to a plain string regardless of how the model returned it
function normalizeDM(dm) {
  if (!dm) return "";
  if (typeof dm === "string") return dm.trim();
  if (typeof dm === "object") {
    const parts = [dm.name, dm.title].filter(Boolean);
    return parts.join(", ");
  }
  return String(dm).trim();
}

// Extract a usable first name from a potentially messy DM string
// Handles "Founder: John Tan", "Mr. John Tan, CEO", "John Tan (deceased 2020)"
const TITLE_WORDS = /^(mr|mrs|ms|dr|prof|sir|founder|director|ceo|coo|cfo|md|partner|manager|owner|chairman|president|head)$/i;
function extractFirstName(dm) {
  const s = normalizeDM(dm);
  if (!s) return "there";
  // Strip leading "Role: " prefix (e.g. "Founder: John Tan")
  const stripped = s.replace(/^[A-Za-z &\/]+:\s*/i, "");
  // Split on common delimiters and parentheses
  const words = stripped.split(/[\s,;(]+/);
  for (const word of words) {
    const clean = word.replace(/[^A-Za-z]/g, "");
    if (clean.length > 1 && !TITLE_WORDS.test(clean) && /^[A-Z]/.test(clean)) {
      return clean;
    }
  }
  return "there";
}

function parseJSON(text) {
  if (!text) return null;
  const trimmed = text.trim();
  const jsonMatch = trimmed.match(/```(?:json)?\n?([\s\S]*?)\n?```/);
  if (jsonMatch) { try { return JSON.parse(jsonMatch[1]); } catch {} }
  try { return JSON.parse(trimmed); } catch {}
  const objStart = trimmed.indexOf("{");
  if (objStart !== -1) {
    const objEnd = trimmed.lastIndexOf("}");
    if (objEnd > objStart) { try { return JSON.parse(trimmed.slice(objStart, objEnd + 1)); } catch {} }
  }
  const arrStart = trimmed.indexOf("[");
  if (arrStart !== -1) {
    const arrEnd = trimmed.lastIndexOf("]");
    if (arrEnd > arrStart) { try { return JSON.parse(trimmed.slice(arrStart, arrEnd + 1)); } catch {} }
  }
  console.error("Failed to parse JSON (first 300 chars):", trimmed.slice(0, 300));
  return null;
}

// ─── STEP 0: INTERACTIVE SEEDING SOURCE CONFIRMATION ────────────────────────
async function confirmSeedingSources(sector, directorySources) {
  const W = 68;
  const hr = "─".repeat(W);
  const pad = (s, n) => (s.length > n ? s.substring(0, n - 1) + "…" : s.padEnd(n));

  console.log(`\n┌${hr}┐`);
  console.log(`│  📋 PROPOSED SEEDING SOURCES — ${pad(sector, W - 33)}│`);
  console.log(`├${hr}┤`);
  directorySources.forEach((s, i) => {
    console.log(`│  ${i + 1}. ${pad(s.name, W - 5)}│`);
    console.log(`│     URL  : ${pad(s.url, W - 12)}│`);
    console.log(`│     Type : ${pad(s.type, W - 12)}│`);
    console.log(`│     Why  : ${pad(s.rationale, W - 12)}│`);
    if (i < directorySources.length - 1) console.log(`│${" ".repeat(W)}│`);
  });
  console.log(`└${hr}┘`);

  const autoConfirm = process.argv.includes("--auto-confirm");
  const isInteractive = process.stdin.isTTY;

  if (autoConfirm || !isInteractive) {
    console.log("✅ Auto-confirming sources (non-interactive or --auto-confirm)\n");
    return;
  }

  const { createInterface } = await import("readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ans = await rl.question("\nProceed with these sources? [Y/n]: ");
    if (ans.trim().toLowerCase() === "n") {
      console.log("\n✋ Aborted. Edit directory_sources in 20_SEARCH_MATRIX.json and re-run.\n");
      process.exit(0);
    }
    console.log("✅ Sources confirmed\n");
  } finally {
    rl.close();
  }
}

// ─── BCA WEB-SEARCH DISCOVERY (parallel with Step A) ─────────────────────────
async function runDirectoryWebSearch(sector, directorySources) {
  // Build sector-specific search queries from the directory sources in the search matrix
  const sourceList = directorySources
    .map((s, i) => `${i + 1}. Search "${s.name} Singapore SME members" at ${s.url} — ${s.search_approach}`)
    .join("\n");

  const sourceNames = directorySources.map((s) => s.name).join(", ");

  const prompt = `You are a Singapore SME researcher. Search the web to find real Singapore SMEs that are active members of these industry bodies:
${sourceNames}

Perform these targeted searches:
${sourceList}

Target criteria:
- Registered Singapore SMEs: 5–200 employees, estimated revenue SGD 100K–5M
- NOT subsidiaries of MNCs, SGX-listed groups, or GLC-linked companies
- NOT well-known consumer brands most Singaporeans would immediately recognise
- Active businesses with a web or social media presence

Return ONLY a JSON array. No preamble. Empty array [] if nothing found:
[
  {
    "company_name": "exact registered name",
    "uen": null,
    "website": "if found, else null",
    "source_directory": "name of the association/directory where found",
    "confidence": 0.8
  }
]`;

  try {
    const response = await callWithRetry(() =>
      client.messages.create(
        {
          model: MODEL,
          max_tokens: 2000,
          system: "You are a JSON-only assistant. Always respond with a valid JSON array only. Never add preamble, reasoning, explanation, or any text outside the JSON array.",
          tools: [{ type: "web_search_20250305", name: "web_search" }],
          messages: [{ role: "user", content: prompt }],
        },
        { headers: { "anthropic-beta": "web-search-2025-03-05" } }
      )
    );
    const textBlock = response.content.findLast((b) => b.type === "text");
    const result = parseJSON(textBlock?.text || "");
    if (!Array.isArray(result)) {
      console.log("    ⚠️  Directory web-search returned no parseable results");
      return [];
    }
    console.log(`    ✓ [Directory web-search] ${result.length} candidates`);
    return result.map((c) => ({
      ...c,
      sector,
      directory_seeded: true,
    }));
  } catch (err) {
    console.error(`  Directory web-search error: ${err.message}`);
    return [];
  }
}

// ─── AGENT 1: PROSPECTOR (directory-grounded, web-search backed) ─────────────
async function runProspectorAgent(sector, directorySources, seedCompanies, subSectorFocus, lowOnlinePresence) {
  console.log(`\n🔍 PROSPECTOR: Finding ${sector} companies from verified directories...\n`);

  // Pre-seeded path (e.g. Construction with BCA-verified list)
  if (seedCompanies.length > 0) {
    console.log(`  📌 Using ${seedCompanies.length} pre-seeded companies\n`);
    const seedList = seedCompanies
      .map((s) => {
        let line = `- ${s.name}`;
        if (s.uen) line += ` (UEN: ${s.uen})`;
        if (s.bca_grade) line += `, BCA: ${s.bca_grade}`;
        if (s.website) line += `, website: ${s.website}`;
        if (s.known_contact) line += `, known contact: ${s.known_contact}`;
        return line;
      })
      .join("\n");

    const prompt = `You are a Singapore SME lead researcher. Below is a verified list of companies in the ${sector} sector. All are confirmed real, active businesses. Use web search and your knowledge to fill in decision-makers, recent growth signals (2024–2025), and AI automation pain points for each.

VERIFIED COMPANIES (do NOT add or remove any):
${seedList}

For each company return:
- company_name: EXACTLY as listed above
- sector: "${sector}"
- source_directory: "pre-verified seed"
- estimated_revenue_sgd: based on any known signals
- employee_count: estimate
- website: provided or best found
- recent_signal: hiring, project wins, awards, or growth news 2024-2025 (be specific)
- decision_maker: real name + title from LinkedIn, company website, or ACRA directors if known; use "Managing Director" as title fallback only — include an actual name wherever possible
- pain_point_inferred: specific to their sub-sector
- confidence: 0-1

IMPORTANT: Return ONLY valid JSON array. Include ALL ${seedCompanies.length} companies. No preamble.`;

    const response = await callWithRetry(() =>
      client.messages.create(
        {
          model: MODEL,
          max_tokens: 8000,
          tools: [{ type: "web_search_20250305", name: "web_search" }],
          messages: [{ role: "user", content: prompt }],
        },
        { headers: { "anthropic-beta": "web-search-2025-03-05" } }
      )
    );
    const textBlock = response.content.findLast((b) => b.type === "text");
    const companies = parseJSON(textBlock?.text || "");
    if (!Array.isArray(companies)) return [];
    console.log(`✅ Enriched ${companies.length} seeded companies`);
    return companies;
  }

  // Standard path: two-step to avoid rate limit from web_search token flood
  // Step A: model-knowledge pass — name 8-10 candidate companies (no web search)
  const assocNames = directorySources.map((s) => s.name).join(", ");

  const subSectorLine = subSectorFocus
    ? `\nSUB-SECTOR FOCUS (follow exactly): ${subSectorFocus}`
    : `\nThink across sub-sectors to find diverse candidates within "${sector}".`;

  // Build 5 sector-aware discovery angles from the search matrix
  const sectorData = SEARCH_MATRIX.sectors?.[sector] || {};
  const painSignals = sectorData.pain_signals || [];
  const serviceFits = sectorData.service_fit || [];

  // Angle 1: established players (founded 10–25 yrs ago, stable revenue)
  const angle1 = `established Singapore SMEs in the "${sector}" sector incorporated 10–25 years ago with stable revenue between SGD 500K–5M. Focus on owner-operated businesses that have grown organically and are now hitting operational scaling limits.`;

  // Angle 2: growth-stage companies (founded 3–10 yrs ago, hiring or expanding)
  const angle2 = `growth-stage Singapore SMEs in the "${sector}" sector incorporated 3–10 years ago that are actively hiring or expanding. Target companies that show signs of rapid growth but limited back-office infrastructure.`;

  // Angle 3: pain-signal angle (based on sector's top pain signals)
  const painFocus = painSignals.slice(0, 2).join("; ") || `manual operations and workflow inefficiencies`;
  const angle3 = `Singapore SMEs in the "${sector}" sector that are known to suffer from: ${painFocus}. These are businesses where manual processes are a visible bottleneck.`;

  // Angle 4: service-fit angle (based on sector's service fit tags)
  const serviceFocus = serviceFits.slice(0, 2).join(" and ") || `process automation`;
  const angle4 = `Singapore SMEs in the "${sector}" sector that would benefit most from ${serviceFocus}. Look for companies with cross-department workflows, high transaction volume, or customer-facing operations that lack automation.`;

  // Angle 5: association-member angle (explicitly grounded in the listed associations)
  const angle5 = `Singapore SMEs that are verified or likely members of these industry bodies: ${assocNames}. Focus on active members in the "${sector}" sector with 10–150 employees.`;

  const discoveryAngles = [
    { label: "Established", desc: angle1 },
    { label: "Growth-stage", desc: angle2 },
    { label: "Pain-signal", desc: angle3 },
    { label: "Service-fit", desc: angle4 },
    { label: "Association", desc: angle5 },
  ];

  // Run 5 model-knowledge passes (different angles) + BCA web-search in parallel
  const runModelKnowledgePass = async (angleLabel, angleDesc) => {
    const passPrompt = `You are a Singapore SME researcher. List 12–18 real Singapore SMEs specifically focused on: ${angleDesc}

These should be known members of or mentioned in connection with these associations: ${assocNames}.
${subSectorLine}

Target criteria:
- Registered Singapore SMEs: 5–200 employees, estimated revenue SGD 100K–5M
- NOT subsidiaries of MNCs, SGX-listed groups, or GLC-linked companies
- Incorporated 3–25 years ago
- AVOID well-known consumer brands or companies most Singaporeans would immediately recognise

Return ONLY a JSON array:
[{ "company_name": "...", "sector": "${sector}", "source_directory": "...", "website": null, "confidence": 0–1 }]

Do NOT fabricate. Return fewer than 12 if not confident. Return ONLY valid JSON array.`;

    const resp = await callWithRetry(() =>
      client.messages.create({
        model: MODEL,
        max_tokens: 2000,
        messages: [{ role: "user", content: passPrompt }],
      })
    );
    const raw = parseJSON(resp.content[0]?.text || "");
    if (!Array.isArray(raw)) return [];
    console.log(`    ✓ [${angleLabel}] ${raw.length} candidates`);
    return raw;
  };

  console.log("  Step A: parallel candidate identification (5 angles + directory web-search)...");
  const passResults = await Promise.all([
    ...discoveryAngles.map(({ label, desc }) => runModelKnowledgePass(label, desc)),
    runDirectoryWebSearch(sector, directorySources),
  ]);

  // Merge and deduplicate by normalised company name
  const allCandidates = passResults.flat();
  const seenNames = new Set();
  const deduped = allCandidates.filter((c) => {
    if (!c.company_name) return false;
    const key = c.company_name.toLowerCase()
      .replace(/\s*(pte\.?\s*ltd\.?|private\s+limited)\s*/gi, "")
      .replace(/[^a-z0-9]/g, " ")
      .trim();
    if (seenNames.has(key)) return false;
    seenNames.add(key);
    return true;
  });
  console.log(`  ✓ ${deduped.length} unique candidates (${allCandidates.length} total across ${discoveryAngles.length + 1} passes)`);

  // Confidence gate: BCA web-search results bypass gate; model-knowledge filtered at 0.5
  const candidateRaw = deduped.filter((c) => c.directory_seeded || (c.confidence || 0) >= 0.5);
  const filtered = candidateRaw;
  if (candidateRaw.length < deduped.length) {
    console.log(`  ↳ Dropped ${deduped.length - candidateRaw.length} candidate(s) with confidence < 0.5`);
  }
  if (filtered.length === 0) {
    console.error("  No candidates passed confidence gate");
    return [];
  }

  // Step B: web-search enrichment — one company at a time, with sleep between calls
  console.log("  Step B: enriching candidates with web search (one at a time)...");
  const enriched = [];
  for (const candidate of filtered) {
    await sleep(8000); // prevent token/min rate limit
    const promptB = `Enrich this Singapore company profile using web search.

Company: ${candidate.company_name}
Sector: ${candidate.sector}
Website hint: ${candidate.website || "unknown"}

Search for:
1. Confirm company exists: search "${candidate.company_name} Singapore" on sgpbusiness.com or company website
2. Decision-maker: search LinkedIn or company website for the founder/MD/CEO name
3. Recent signal: any hiring, awards, expansion, or news in 2024–2025
4. Employee count and revenue estimate

Return ONLY a raw JSON object — no preamble, no markdown, no explanation before or after. Start your response with { and end with }:
{
  "company_name": "${candidate.company_name}",
  "sector": "${candidate.sector}",
  "source_directory": "${candidate.source_directory || "association search"}",
  "estimated_revenue_sgd": null,
  "employee_count": null,
  "website": null,
  "recent_signal": null,
  "decision_maker": null,
  "pain_point_inferred": null,
  "confidence": 0
}

If you cannot confirm the company exists at all, set confidence to 0.1 and leave other fields null.`;

    try {
      const responseB = await callWithRetry(() =>
        client.messages.create(
          {
            model: MODEL,
            max_tokens: 1200,
            tools: [{ type: "web_search_20250305", name: "web_search" }],
            messages: [{ role: "user", content: promptB }],
          },
          { headers: { "anthropic-beta": "web-search-2025-03-05" } }
        )
      );
      const textBlock = responseB.content.findLast((b) => b.type === "text");
      const result = parseJSON(textBlock?.text || "");
      if (result && result.company_name) {
        enriched.push(result);
        console.log(`  ✓ ${result.company_name} (confidence: ${result.confidence})`);
      } else {
        enriched.push({ ...candidate, pain_point_inferred: null });
        console.log(`  ? ${candidate.company_name}: enrichment parse failed — using candidate data`);
      }
    } catch (err) {
      console.error(`  ✗ ${candidate.company_name}: enrichment error — ${err.message}`);
      enriched.push({ ...candidate, pain_point_inferred: null });
    }
  }

  console.log(`✅ Found ${enriched.length} companies from directories`);
  return enriched;
}

// ─── AGENT 1.5: SME VERIFIER ─────────────────────────────────────────────────
async function verifySMEStatus(company, lowOnlinePresence) {
  const websiteRule = lowOnlinePresence
    ? `3. WEBSITE — For low-online-presence sectors (ACMV/electrical/M&E contractors): if the company has a confirmed BCA registration (workhead and grade found on BCA registry, ACRA, or sgpbusiness.com), the website check is WAIVED — BCA registration alone confirms the company is active. Only discard on website grounds if BOTH no BCA registration AND no website can be confirmed.`
    : `3. WEBSITE — discard if: no company website can be confirmed. Search "[company name] Singapore" and check if a resolvable domain belonging to this company exists.`;

  const prompt = `Search online for "${company.company_name}" Singapore.

Check THREE things and set discard=true if ANY of these conditions are met:

1. SIZE — discard if TOO LARGE or TOO SMALL:
   - Too large: annual revenue > SGD 5,000,000, total funding > SGD 5,000,000, or ACRA paid-up capital > SGD 5,000,000
   - Too small: estimated annual revenue < SGD 100,000 (micro-business / sole trader)
   IMPORTANT: Only use ACRA BizFile, company press releases, or credible news articles as revenue evidence.
   Do NOT discard based on RocketReach, Apollo.io, or similar third-party scraper estimates alone — those are unreliable.
   If only third-party estimates exist, set revenue_source="third_party_only" and do NOT trigger a size discard.

2. OPERATIONAL STATUS — discard if: in liquidation, struck off, wound up, ceased trading, or under judicial management.

${websiteRule}

Return ONLY a raw JSON object — start your response with { and end with }, absolutely no preamble, explanation, or markdown:
{
  "company_name": "${company.company_name}",
  "revenue_sgd": <number or null>,
  "revenue_source": "acra" | "news" | "third_party_only" | "unknown",
  "funding_sgd": <number or null>,
  "paid_up_capital_sgd": <number or null>,
  "operational_status": "active" | "liquidation" | "struck_off" | "unknown",
  "website_found": <true or false>,
  "website_url": <string or null>,
  "discard": <true or false>,
  "discard_reason": null | "too_large" | "too_small" | "inactive" | "no_website",
  "reason": "<brief explanation>"
}`;

  const response = await callWithRetry(() =>
    client.messages.create(
      {
        model: MODEL,
        max_tokens: 800,
        system: "You are a JSON-only data extraction assistant. Always respond with a single valid JSON object. Never add preamble, explanation, markdown, or any text outside the JSON object.",
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        messages: [{ role: "user", content: prompt }],
      },
      { headers: { "anthropic-beta": "web-search-2025-03-05" } }
    )
  );

  const textBlock = response.content.findLast((b) => b.type === "text");
  const result = parseJSON(textBlock?.text || "");
  return result || { company_name: company.company_name, discard: false, reason: "could not verify — keeping" };
}

// ─── AGENT 1.7: CONTACT VERIFIER (NEW) ───────────────────────────────────────
async function verifyContact(company, lowOnlinePresence) {
  const dm = normalizeDM(company.decision_maker);
  const rawName = dm.split(",")[0].trim();

  // Skip name verification if only a generic title was provided
  const isGenericTitle = !rawName || /^(director|managing director|ceo|founder|owner|manager|partner)$/i.test(rawName);
  if (isGenericTitle) {
    return {
      company_name: company.company_name,
      contact_status: "unverified",
      verified_name: null,
      verified_title: null,
      verification_source: null,
      linkedin_url: null,
      phone_hint: null,
      notes: "No specific name to verify — generic title only",
    };
  }

  const website = company.website || "";

  const acraNote = lowOnlinePresence
    ? `\nIMPORTANT FOR LOW-ONLINE-PRESENCE COMPANIES: Search sgpbusiness.com or bizfile.acra.gov.sg for the ACRA director list of "${company.company_name}" as your PRIMARY source. An ACRA-confirmed director should be returned with contact_status="verified" and verification_source="acra_directors". Do NOT flag as likely_hallucinated solely because LinkedIn has no profile — absence of LinkedIn is expected for M&E/ACMV contractors.`
    : "";

  const prompt = `Verify whether this person is a real, current employee at this company.

Person to verify: ${dm}
Company: ${company.company_name}
Company website: ${website || "unknown"}
${acraNote}
Search steps:
1. Search sgpbusiness.com or ACRA BizFile for directors of "${company.company_name}" — treat confirmed ACRA directors as verified
2. Search LinkedIn for "${rawName}" "${company.company_name}" Singapore
3. Search "${rawName}" site:${website || company.company_name.toLowerCase().replace(/[^a-z0-9]/g, "")}
4. Search news or press for "${rawName}" "${company.company_name}"

Return ONLY a raw JSON object — start your response with { and end with }, no preamble or explanation:
{
  "company_name": "${company.company_name}",
  "contact_status": "verified",
  "verified_name": "${rawName}",
  "verified_title": null,
  "verification_source": "source description",
  "linkedin_url": null,
  "phone_hint": null,
  "notes": "brief explanation max 20 words"
}

contact_status rules:
- "verified"  : found on LinkedIn currently at this company OR confirmed on company website/ACRA directors
- "unverified": not found online but no contradictory evidence found either
- "likely_hallucinated": person found at a DIFFERENT company on LinkedIn, OR company has no online presence AND name cannot be confirmed anywhere`;

  const response = await callWithRetry(() =>
    client.messages.create(
      {
        model: MODEL,
        max_tokens: 800,
        system: "You are a JSON-only data extraction assistant. Always respond with a single valid JSON object. Never add preamble, explanation, markdown, or any text outside the JSON object.",
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        messages: [{ role: "user", content: prompt }],
      },
      { headers: { "anthropic-beta": "web-search-2025-03-05" } }
    )
  );

  const textBlock = response.content.findLast((b) => b.type === "text");
  const result = parseJSON(textBlock?.text || "");
  return (
    result || {
      company_name: company.company_name,
      contact_status: "unverified",
      verified_name: null,
      verified_title: null,
      verification_source: null,
      linkedin_url: null,
      phone_hint: null,
      notes: "Verification parse error — kept as unverified",
    }
  );
}

// ─── AGENT 2: FIT ASSESSMENT ──────────────────────────────────────────────────
async function assessCompanyFit(company, lowOnlinePresence) {
  const techNote = lowOnlinePresence
    ? `\nLOW-ONLINE-PRESENCE ADJUSTMENT: For ACMV/electrical/M&E contractor sectors, absence of online tech hiring signals is NEUTRAL (score tech_maturity at 0.45), not a penalty (0.2). Only score below 0.4 if there is active evidence of technology avoidance. These companies typically lack online job postings but still operate complex scheduling and compliance workflows.`
    : "";

  const prompt = `Evaluate fit for AI consultancy services (multi-agent systems, process automation, customer AI).

Company:
${JSON.stringify(company, null, 2)}
${techNote}
Score on 5 dimensions (0-1 each):
1. Revenue Stage (10% weight): SGD 1M–5M=0.9, SGD 300K–1M=0.7, SGD 100K–300K=0.4, below 100K=0.1, above 5M=0.1
2. Tech Maturity (25%): Hiring AI/ML=1.0, Modern stack=0.85, No tech hiring 2yrs=0.45 (neutral for low-online-presence sectors)
3. Automation Readiness (30%): Ops surge without automation=1.0, Public complaints=0.95, Already automated=0.3
4. Customer AI Readiness (10%): B2C/SaaS/E-comm=0.95, Mixed B2B2C=0.7, Pure B2B small count=0.2
5. Multi-Agent Fit (25%): Cross-dept workflows=1.0, Supply chain coord=0.95, Single simple task=0.15

Formula: overall = 0.10*revenue + 0.25*tech + 0.30*automation + 0.10*customer + 0.25*multi_agent
Red flag penalties: deployed competitor AI = PASS (override_score=0), under 10 employees or <SGD 100K = -0.4
Green flag bonuses: recent funding +0.1, rapid ops hiring +0.15, competitor adopting AI +0.05, owner-operated (founder is decision-maker) +0.1, no hiring or growth signal in past 24 months -0.1

Decision: 0–0.3=PASS, 0.3–0.5=NURTURE, 0.5–0.7=FOLLOW_UP, 0.7–0.85=PRIORITIZE, 0.85–1.0=URGENT

Return ONLY valid JSON:
{
  "company_name": "...",
  "overall_fit_score": 0.75,
  "revenue_stage_score": 0.85,
  "tech_maturity_score": 0.7,
  "automation_readiness_score": 0.9,
  "customer_ai_readiness_score": 0.6,
  "multi_agent_fit_score": 0.8,
  "primary_service_fit": "process_automation",
  "key_opportunity": "...",
  "recommendation": "PRIORITIZE",
  "reasoning": "..."
}`;

  const response = await callWithRetry(() =>
    client.messages.create({
      model: MODEL,
      max_tokens: 1500,
      messages: [{ role: "user", content: prompt }],
    })
  );

  const text = response.content[0]?.text || "";
  const fit = parseJSON(text);
  return fit || { company_name: company.company_name, overall_fit_score: 0, recommendation: "PASS" };
}

// ─── AGENT 3A: EMAIL OUTREACH ─────────────────────────────────────────────────
async function generateEmail(company, fitAssessment, contactVerification) {
  const verifiedName = contactVerification?.verified_name;
  const verifiedTitle = contactVerification?.verified_title;
  const isVerified = contactVerification?.contact_status === "verified";
  const dm = verifiedName
    ? `${verifiedName}${verifiedTitle ? ", " + verifiedTitle : ""}`
    : normalizeDM(company.decision_maker) || "the founder";
  const firstName = (isVerified || verifiedName) ? extractFirstName(dm) : "there";

  const prompt = `Write a personalized cold email to ${dm} at ${company.company_name}.

Context:
- Company: ${company.company_name} (${company.sector})
- What caught our attention: ${company.recent_signal}
- Inferred pain point: ${company.pain_point_inferred}
- Recommended service: ${fitAssessment.primary_service_fit}
- Key opportunity: ${fitAssessment.key_opportunity}
- Recipient first name: ${firstName}

Rules:
1. Open with a SPECIFIC fact about their company — not a generic opener
2. Reference the exact signal noticed (numbers/events)
3. Name one specific problem it signals
4. Propose one service as the solution (sector-specific)
5. End with a micro-offer: "15-minute discovery call" or "2-page automation audit"
6. Use first name only (${firstName})
7. 3–4 sentence body + signature only
8. Peer-to-peer consultant tone — not salesy
9. Include a subject line
10. Do NOT use: "leverage", "synergy", "cutting-edge", "game-changer", "I hope this finds you well"

Format:
SUBJECT: [subject line]

[email body]

Signature:
Hon Mun
Aixer Solutions | hmchan@aixers.com`;

  const response = await callWithRetry(() =>
    client.messages.create({
      model: MODEL,
      max_tokens: 600,
      messages: [{ role: "user", content: prompt }],
    })
  );

  return response.content[0]?.text || "";
}

// ─── AGENT 3B: WHATSAPP OUTREACH (NEW) ───────────────────────────────────────
async function generateWhatsApp(company, fitAssessment, contactVerification) {
  const verifiedName = contactVerification?.verified_name;
  const isVerified = contactVerification?.contact_status === "verified";
  const dm = verifiedName || normalizeDM(company.decision_maker);
  const firstName = (isVerified || verifiedName) ? extractFirstName(dm) : "there";

  const prompt = `Write a brief WhatsApp cold message to ${firstName} at ${company.company_name}.

Context:
- Company: ${company.company_name} (${company.sector})
- Signal noticed: ${company.recent_signal}
- Pain point: ${company.pain_point_inferred}
- Service fit: ${fitAssessment.primary_service_fit}
- Key opportunity: ${fitAssessment.key_opportunity}

WhatsApp message rules:
1. Under 100 words total — conversational, not a pitch deck
2. Start with "Hi ${firstName},"
3. One specific reference to their company or sector signal
4. One plain-language value proposition
5. Close with one simple question (not a demand)
6. End the message body BEFORE the sign-off — do NOT write the sign-off, it will be appended separately
7. No corporate jargon (no "leverage", "synergy", "transformation journey")
8. No subject line format
9. Use short paragraphs with line breaks for readability

Output only the message body — stop before any sign-off line.`;

  const response = await callWithRetry(() =>
    client.messages.create({
      model: MODEL,
      max_tokens: 400,
      messages: [{ role: "user", content: prompt }],
    })
  );

  const body = (response.content[0]?.text || "").trim();
  return `${body}\n\nHon Mun\nAixer Solutions`;
}

// ─── MAIN WORKFLOW ────────────────────────────────────────────────────────────
async function runDailyProspecting() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("🤖 AIXER SOLUTIONS — DAILY PROSPECTING v2");
  console.log("═══════════════════════════════════════════════════════════════");

  const sector = selectTodaysSector();
  const directorySources = getDirectorySources(sector);
  const seedCompanies = getSeedCompanies(sector);
  const subSectorFocus = getSubSectorFocus(sector);
  const lowOnlinePresence = getLowOnlinePresence(sector);

  console.log(`\n📅 Sector  : ${sector}`);
  console.log(`🤖 Model   : ${MODEL}`);
  console.log(`📂 Sources : ${directorySources.length} directory sources, ${seedCompanies.length} seed companies`);
  if (lowOnlinePresence) console.log(`🔕 Mode    : low-online-presence (BCA/ACRA verification relaxed, tech maturity neutral)`);

  // STEP 0: Confirm seeding sources with user before starting
  if (directorySources.length > 0) {
    await confirmSeedingSources(sector, directorySources);
  } else if (seedCompanies.length === 0) {
    console.log(`\n⚠️  No directory_sources or seed_companies configured for "${sector}".`);
    console.log("Add directory_sources to 20_SEARCH_MATRIX.json and re-run.\n");
    process.exit(1);
  } else {
    console.log(`\n📌 Using pre-seeded companies (no directory confirmation needed)\n`);
  }

  // PHASE 1: PROSPECT
  let companies = [];
  try {
    companies = await runProspectorAgent(sector, directorySources, seedCompanies, subSectorFocus, lowOnlinePresence);
  } catch (err) {
    console.error("❌ Prospector failed:", err.message);
    return;
  }

  if (companies.length === 0) {
    console.log("❌ No companies found. Check directory_sources in 20_SEARCH_MATRIX.json.");
    return;
  }

  // PHASE 1.5: SME VERIFICATION
  console.log(`\n🔎 SME VERIFICATION: Checking ${companies.length} companies...\n`);
  const smeVerified = [];
  for (const company of companies) {
    try {
      const v = await verifySMEStatus(company, lowOnlinePresence);
      if (v.discard) {
        console.log(`  ✗ ${company.company_name}: REMOVED — ${v.reason}`);
      } else {
        console.log(`  ✓ ${company.company_name}: OK — ${v.reason || "within SME threshold"}`);
        smeVerified.push(company);
      }
    } catch (err) {
      console.error(`  ? ${company.company_name}: error — ${err.message}, keeping`);
      smeVerified.push(company);
    }
    await sleep(12000);
  }
  companies = smeVerified;

  if (companies.length === 0) {
    console.log("❌ No companies passed SME verification.");
    return;
  }
  console.log(`\n✅ ${companies.length} companies passed SME verification`);

  // PHASE 1.7: CONTACT VERIFICATION (NEW)
  console.log(`\n🪪 CONTACT VERIFICATION: Checking decision-makers...\n`);
  const contactResults = {};
  for (const company of companies) {
    try {
      const cv = await verifyContact(company, lowOnlinePresence);
      contactResults[company.company_name] = cv;

      const icon =
        cv.contact_status === "verified"
          ? "✅"
          : cv.contact_status === "likely_hallucinated"
          ? "⚠️ "
          : "❓";
      const display = cv.verified_name
        ? `${cv.verified_name}${cv.verified_title ? " (" + cv.verified_title + ")" : ""}`
        : normalizeDM(company.decision_maker) || "no contact";
      console.log(`  ${icon} ${company.company_name}: [${cv.contact_status}] ${display}`);
      if (cv.contact_status === "likely_hallucinated") {
        console.log(`       ↳ ${cv.notes} — will use generic fallback in outreach`);
      }
      if (cv.phone_hint) {
        console.log(`       📱 Phone hint: ${cv.phone_hint}`);
      }
    } catch (err) {
      console.error(`  ? ${company.company_name}: contact check error — ${err.message}`);
      contactResults[company.company_name] = {
        contact_status: "unverified",
        notes: err.message,
      };
    }
    await sleep(10000);
  }
  console.log("");

  // PHASE 2: FIT ASSESSMENT
  console.log(`\n🎯 FIT ASSESSMENT: Scoring ${companies.length} companies...\n`);
  const scored = [];
  for (const company of companies) {
    try {
      const fit = await assessCompanyFit(company, lowOnlinePresence);
      scored.push({ ...company, ...fit });
      console.log(
        `  ${company.company_name}: ${fit.overall_fit_score?.toFixed(2) ?? "err"} → ${fit.recommendation ?? "?"}`
      );
    } catch (err) {
      console.error(`  ${company.company_name}: assessment error — ${err.message}`);
      scored.push({ ...company, overall_fit_score: 0, recommendation: "PASS" });
    }
    await sleep(3000);
  }

  // PHASE 3: RANK & FILTER
  scored.sort((a, b) => (b.overall_fit_score || 0) - (a.overall_fit_score || 0));
  const qualified = scored.filter((s) => (s.overall_fit_score || 0) > 0.5);
  const nurture = scored.filter((s) => { const sc = s.overall_fit_score || 0; return sc >= 0.3 && sc <= 0.5; });
  console.log(`\n✅ Qualified leads (fit > 0.5): ${qualified.length}`);
  if (nurture.length > 0) {
    console.log(`📋 Nurture list (fit 0.3–0.5): ${nurture.length}`);
    nurture.forEach((n) => console.log(`   - ${n.company_name}: ${n.overall_fit_score?.toFixed(2)} — ${n.recommendation}`));
  }

  // Warn about hallucinated contacts in qualified leads
  const hallucinated = qualified.filter(
    (q) => contactResults[q.company_name]?.contact_status === "likely_hallucinated"
  );
  if (hallucinated.length > 0) {
    console.log(`\n⚠️  ${hallucinated.length} qualified lead(s) with flagged contacts:`);
    hallucinated.forEach((h) =>
      console.log(`   - ${h.company_name}: ${contactResults[h.company_name]?.notes}`)
    );
    console.log("   Outreach will use verified name if available, or safe generic fallback.\n");
  }

  // PHASE 4: OUTREACH GENERATION (email + WhatsApp)
  const outreachResults = [];
  if (qualified.length > 0) {
    const maxEmails = CONFIG.outreach?.max_emails_per_run || 5;
    console.log(`\n📨 GENERATING OUTREACH (Top ${Math.min(maxEmails, qualified.length)}):\n`);

    for (let i = 0; i < Math.min(maxEmails, qualified.length); i++) {
      const lead = qualified[i];
      const cv = contactResults[lead.company_name] || { contact_status: "unverified" };
      const contactLabel = cv.verified_name || normalizeDM(lead.decision_maker) || "unknown";

      console.log(
        `\n── ${i + 1}. ${lead.company_name} (Fit: ${lead.overall_fit_score?.toFixed(2)}) [Contact: ${cv.contact_status} — ${contactLabel}]`
      );

      let email = "";
      let whatsapp = "";

      try {
        email = await generateEmail(lead, lead, cv);
        console.log("\n[EMAIL]");
        console.log(email);
      } catch (err) {
        console.error(`  Email generation failed: ${err.message}`);
      }

      try {
        whatsapp = await generateWhatsApp(lead, lead, cv);
        console.log("\n[WHATSAPP]");
        console.log(whatsapp);
      } catch (err) {
        console.error(`  WhatsApp generation failed: ${err.message}`);
      }

      console.log("\n[REVIEW BEFORE SENDING]");
      outreachResults.push({
        company: lead.company_name,
        contact_status: cv.contact_status,
        contact_name: cv.verified_name || lead.decision_maker || null,
        linkedin_url: cv.linkedin_url || null,
        phone_hint: cv.phone_hint || null,
        email,
        whatsapp,
      });
    }
  }

  // PHASE 5: SAVE OUTPUT
  const timestamp = new Date().toISOString().replace(/:/g, "-").split(".")[0];
  const outputDir = new URL("./output/", import.meta.url).pathname;
  const outputFile = `${outputDir}prospecting_${timestamp}.json`;

  const output = {
    date: new Date().toISOString(),
    sector,
    model: MODEL,
    version: "2.0",
    total_companies_found: companies.length,
    qualified_leads: qualified.map((q) => ({
      company_name: q.company_name,
      sector: q.sector,
      source_directory: q.source_directory || null,
      fit_score: q.overall_fit_score,
      recommendation: q.recommendation,
      opportunity: q.key_opportunity,
      decision_maker: q.decision_maker,
      contact_status: contactResults[q.company_name]?.contact_status || "unverified",
      verified_name: contactResults[q.company_name]?.verified_name || null,
      linkedin_url: contactResults[q.company_name]?.linkedin_url || null,
      phone_hint: contactResults[q.company_name]?.phone_hint || null,
      website: q.website,
      recent_signal: q.recent_signal,
    })),
    all_scored: scored.map((s) => ({
      company_name: s.company_name,
      fit_score: s.overall_fit_score,
      recommendation: s.recommendation,
      contact_status: contactResults[s.company_name]?.contact_status || "unverified",
    })),
    nurture_list: nurture.map((n) => ({
      company_name: n.company_name,
      sector: n.sector,
      fit_score: n.overall_fit_score,
      recommendation: n.recommendation,
      opportunity: n.key_opportunity,
      decision_maker: normalizeDM(n.decision_maker) || null,
      contact_status: contactResults[n.company_name]?.contact_status || "unverified",
      website: n.website,
      recent_signal: n.recent_signal,
    })),
    outreach_drafts: outreachResults,
  };

  try {
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(outputFile, JSON.stringify(output, null, 2));
    console.log(`\n✅ Results saved to ${outputFile}`);
  } catch (err) {
    console.error("Could not save output:", err.message);
  }

  // Summary
  const cvValues = Object.values(contactResults);
  const verifiedCount = cvValues.filter((v) => v.contact_status === "verified").length;
  const hallucinatedCount = cvValues.filter((v) => v.contact_status === "likely_hallucinated").length;
  const unverifiedCount = cvValues.length - verifiedCount - hallucinatedCount;

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log(
    `📊 ${companies.length} found → ${qualified.length} qualified + ${nurture.length} nurture → ${outreachResults.length} drafted`
  );
  console.log(
    `🪪 Contacts: ${verifiedCount} verified / ${unverifiedCount} unverified / ${hallucinatedCount} flagged`
  );
  console.log("═══════════════════════════════════════════════════════════════\n");
}

runDailyProspecting().catch(console.error);
