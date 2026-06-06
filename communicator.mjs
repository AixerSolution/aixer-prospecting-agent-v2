// communicator.mjs — Aixer Solutions Communicator Agent
// Reads prospecting_v2 output, researches each qualified company deeply,
// and drafts hyper-personalized emails and WhatsApp messages grounded in
// specific, evidence-backed challenges.
//
// Usage:
//   node communicator.mjs                                    # latest output, all qualified
//   node communicator.mjs --file output/prospecting_XXX.json
//   node communicator.mjs --tier URGENT,PRIORITIZE
//   node communicator.mjs --file <path> --tier PRIORITIZE

import Anthropic from "@anthropic-ai/sdk";
import * as fs from "fs";
import * as path from "path";
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
        console.log(
          `    ⏳ Rate limited — waiting ${wait / 1000}s before retry ${attempt + 1}/${maxRetries}...`
        );
        await sleep(wait);
      } else {
        throw err;
      }
    }
  }
}

let CONFIG = {};
try {
  CONFIG = JSON.parse(fs.readFileSync(new URL("./config.json", import.meta.url)));
} catch {}
const MODEL = CONFIG.model || "claude-sonnet-4-6";

function parseJSON(text) {
  if (!text) return null;
  const trimmed = text.trim();
  const jsonMatch = trimmed.match(/```(?:json)?\n?([\s\S]*?)\n?```/);
  if (jsonMatch) {
    try { return JSON.parse(jsonMatch[1]); } catch {}
  }
  try { return JSON.parse(trimmed); } catch {}
  const objStart = trimmed.indexOf("{");
  if (objStart !== -1) {
    const objEnd = trimmed.lastIndexOf("}");
    if (objEnd > objStart) {
      try { return JSON.parse(trimmed.slice(objStart, objEnd + 1)); } catch {}
    }
  }
  const arrStart = trimmed.indexOf("[");
  if (arrStart !== -1) {
    const arrEnd = trimmed.lastIndexOf("]");
    if (arrEnd > arrStart) {
      try { return JSON.parse(trimmed.slice(arrStart, arrEnd + 1)); } catch {}
    }
  }
  return null;
}

const TITLE_WORDS =
  /^(mr|mrs|ms|dr|prof|sir|founder|director|ceo|coo|cfo|md|partner|manager|owner|chairman|president|head)$/i;

function normalizeDM(dm) {
  if (!dm) return "";
  if (typeof dm === "string") return dm.trim();
  if (typeof dm === "object") return [dm.name, dm.title].filter(Boolean).join(", ");
  return String(dm).trim();
}

function extractFirstName(dm) {
  const s = normalizeDM(dm);
  if (!s) return "there";
  const stripped = s.replace(/^[A-Za-z &\/]+:\s*/i, "");
  const words = stripped.split(/[\s,;(]+/);
  for (const word of words) {
    const clean = word.replace(/[^A-Za-z]/g, "");
    if (clean.length > 1 && !TITLE_WORDS.test(clean) && /^[A-Z]/.test(clean)) return clean;
  }
  return "there";
}

function findLatestOutputFile() {
  const outputDir = new URL("./output/", import.meta.url).pathname;
  if (!fs.existsSync(outputDir)) return null;
  const files = fs
    .readdirSync(outputDir)
    .filter((f) => f.startsWith("prospecting_") && f.endsWith(".json"))
    .sort()
    .reverse();
  return files.length > 0 ? path.join(outputDir, files[0]) : null;
}

// ─── AGENT 4: COMPANY INTELLIGENCE RESEARCHER ────────────────────────────────
// Performs deep per-company web research to find specific, evidence-backed
// operational challenges. This is the key differentiator vs. v2's sector-level
// pain point inference.
async function researchCompany(lead) {
  const dm = lead.verified_name || normalizeDM(lead.decision_maker) || "unknown";

  const prompt = `You are a business intelligence researcher preparing a personalised outreach brief for ${lead.company_name}, a Singapore ${lead.sector} SME.

Company details:
- Name: ${lead.company_name}
- Sector: ${lead.sector}
- Website: ${lead.website || "unknown — find it via web search"}
- Known recent signal: ${lead.recent_signal || "none provided"}
- Decision-maker: ${dm}
- Fit opportunity note: ${lead.opportunity || "none"}

RESEARCH TASKS — use web search for each:
1. Visit or search their website: understand their exact services/products, team size, and any visible operational complexity
2. Search "${lead.company_name} Singapore hiring" on JobStreet, LinkedIn, Indeed — open roles reveal scaling pain (e.g. "operations coordinator", "admin executive", "data entry clerk", "logistics planner", "customer service executive")
3. Search "${lead.company_name} Singapore 2024 2025" — awards, expansions, new contracts, news mentions
4. Search "${lead.company_name} review" or "${lead.company_name} complaints" — any operational issues mentioned publicly
5. Search "${lead.company_name} Singapore" on LinkedIn — employee count, company updates, leadership posts

OBJECTIVE: Find 2–4 SPECIFIC operational challenges this company is currently experiencing that AI agentic workflows could address. Every challenge must cite real evidence you found — a job title, quote, news snippet, or website observation.

Map each challenge to one of these Aixer Solutions capabilities:
- "process_automation" — repetitive manual work (data entry, scheduling, billing, reporting)
- "multi_agent_orchestration" — cross-team coordination (ops ↔ finance ↔ sales handoffs, multi-location sync)
- "customer_ai" — customer communication at scale (inquiry handling, follow-ups, onboarding)
- "supply_chain_visibility" — inventory, procurement, delivery tracking
- "document_intelligence" — contracts, proposals, compliance docs, reports

Return ONLY valid JSON — start your response with { and end with }:
{
  "company_name": "${lead.company_name}",
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

If you cannot find real evidence for any challenge, return challenges: [] and strongest_hook: null. Do not fabricate evidence.`;

  const response = await callWithRetry(() =>
    client.messages.create(
      {
        model: MODEL,
        max_tokens: 2000,
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
      company_name: lead.company_name,
      website_summary: null,
      employee_signal: null,
      challenges: [],
      strongest_hook: lead.recent_signal || null,
      recommended_angle: "process_automation",
      outreach_note: null,
    }
  );
}

// ─── AGENT 5A: PERSONALISED EMAIL COMPOSER ───────────────────────────────────
async function composeEmail(lead, intelligence) {
  const dm = lead.verified_name || normalizeDM(lead.decision_maker) || "the founder";
  const firstName = (lead.contact_status === "verified" || lead.verified_name) ? extractFirstName(dm) : "there";

  const challengeLines =
    intelligence.challenges?.length > 0
      ? intelligence.challenges
          .slice(0, 3)
          .map((c, i) => `${i + 1}. ${c.title} [${c.urgency}]: ${c.evidence}`)
          .join("\n")
      : "Sector-typical operational scaling pain";

  const hook = intelligence.strongest_hook || lead.recent_signal || lead.opportunity || "";
  const angle = intelligence.recommended_angle || "process_automation";

  const prompt = `Write a personalised cold email to ${dm} at ${lead.company_name}.

COMPANY INTELLIGENCE (from fresh research):
- What they do: ${intelligence.website_summary || "Singapore " + lead.sector + " SME"}
- Strongest hook: ${hook}
- Identified challenges:
${challengeLines}
- Recommended service angle: ${angle}
- Personalisation note: ${intelligence.outreach_note || "none"}

CONTACT: ${firstName} (contact status: ${lead.contact_status})

EMAIL RULES:
1. Open with the STRONGEST specific piece of evidence (exact job title, news item, website observation) — name it precisely
2. State the one operational problem that evidence reveals
3. Propose one AI agentic solution from Aixer Solutions as the direct fix — be specific about what it does, not vague
4. End with one micro-offer: "15-minute discovery call" or "2-page automation audit" — pick whichever fits better
5. Use ${firstName}'s first name only throughout
6. 3–4 sentences body maximum — no padding, no preamble
7. Consultant peer-to-peer tone — you noticed something specific about their business, not a vendor pitch
8. Reference their sector specifically — not "businesses like yours"
9. NEVER USE: "leverage", "synergy", "cutting-edge", "game-changer", "I hope this finds you well", "reach out", "touch base"
10. If contact is likely_hallucinated, address the email to their job title (e.g. "Hi there," or "Hi [role],") — never use a hallucinated name

Format exactly as follows:
SUBJECT: [subject line]

[email body]

Signature:
Hon Mun
Aixer Solutions | hmchan@aixers.com`;

  const response = await callWithRetry(() =>
    client.messages.create({
      model: MODEL,
      max_tokens: 700,
      messages: [{ role: "user", content: prompt }],
    })
  );
  return response.content[0]?.text || "";
}

// ─── AGENT 5B: PERSONALISED WHATSAPP COMPOSER ────────────────────────────────
async function composeWhatsApp(lead, intelligence) {
  const dm = lead.verified_name || normalizeDM(lead.decision_maker) || "there";
  const firstName = (lead.contact_status === "verified" || lead.verified_name) ? extractFirstName(dm) : "there";

  const topChallenge = intelligence.challenges?.[0];
  const hook = intelligence.strongest_hook || lead.recent_signal || "";
  const angle = intelligence.recommended_angle || "process_automation";

  const prompt = `Write a brief WhatsApp cold message to ${firstName} at ${lead.company_name}.

COMPANY INTELLIGENCE:
- What they do: ${intelligence.website_summary || "Singapore " + lead.sector + " SME"}
- Strongest hook: ${hook}
- Primary challenge: ${topChallenge ? topChallenge.title + " — " + topChallenge.evidence : "operational scaling pain"}
- Service angle: ${angle}
- Personalisation note: ${intelligence.outreach_note || "none"}

WHATSAPP RULES:
1. Under 100 words total — WhatsApp is a conversation, not a pitch
2. Start with "Hi ${firstName},"
3. One very specific reference to something real about their company (from the intelligence)
4. One plain-language value proposition — what changes after working with Aixer
5. Close with one simple open question — not a demand, not a calendar link
6. NEVER USE: "leverage", "synergy", "digital transformation", "I hope this finds you well"
7. Short paragraphs with blank lines between — easy to read on mobile
8. Do NOT write a sign-off (it will be appended separately)
9. If contact status is likely_hallucinated, open with "Hi there," instead

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

// ─── MAIN ────────────────────────────────────────────────────────────────────
async function runCommunicator() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("✉️  AIXER SOLUTIONS — COMMUNICATOR AGENT");
  console.log("═══════════════════════════════════════════════════════════════\n");

  // Parse CLI args
  const fileArg =
    process.argv.find((a) => a.startsWith("--file="))?.split("=").slice(1).join("=") ||
    (() => {
      const i = process.argv.indexOf("--file");
      return i !== -1 ? process.argv[i + 1] : null;
    })();
  const tierArg =
    process.argv.find((a) => a.startsWith("--tier="))?.split("=")[1] ||
    (() => {
      const i = process.argv.indexOf("--tier");
      return i !== -1 ? process.argv[i + 1] : null;
    })();

  // Resolve input file
  let inputFile = fileArg;
  if (!inputFile) {
    inputFile = findLatestOutputFile();
    if (!inputFile) {
      console.error(
        "❌ No output file found in prospecting_v2/output/. Run prospecting_v2.mjs first, or use --file <path>."
      );
      process.exit(1);
    }
    console.log(`📂 Using latest output: ${path.basename(inputFile)}\n`);
  }

  let prospectingOutput;
  try {
    prospectingOutput = JSON.parse(fs.readFileSync(inputFile, "utf8"));
  } catch (err) {
    console.error(`❌ Could not read input file: ${err.message}`);
    process.exit(1);
  }

  // Build leads list — merge outreach_drafts contact hints back in
  let leads = prospectingOutput.qualified_leads || [];
  const outreachMap = Object.fromEntries(
    (prospectingOutput.outreach_drafts || []).map((d) => [d.company, d])
  );
  leads = leads.map((l) => {
    const draft = outreachMap[l.company_name] || {};
    return {
      ...l,
      verified_name: l.verified_name || draft.contact_name || null,
      contact_status: l.contact_status || draft.contact_status || "unverified",
      phone_hint: l.phone_hint || draft.phone_hint || null,
      linkedin_url: l.linkedin_url || draft.linkedin_url || null,
    };
  });

  // Apply tier filter
  const allowedTiers = tierArg ? tierArg.toUpperCase().split(",") : null;
  if (allowedTiers) {
    const before = leads.length;
    leads = leads.filter((l) => allowedTiers.includes(l.recommendation));
    console.log(`🎯 Tier filter [${tierArg}]: ${leads.length} of ${before} leads selected\n`);
  }

  if (leads.length === 0) {
    console.log("❌ No qualified leads to process. Check the output file or adjust --tier.");
    process.exit(0);
  }

  console.log(`📊 Sector  : ${prospectingOutput.sector}`);
  console.log(`📋 Leads   : ${leads.length} to process`);
  console.log(`🤖 Model   : ${MODEL}`);
  console.log(`📁 Source  : ${path.basename(inputFile)}\n`);

  const results = [];

  for (let i = 0; i < leads.length; i++) {
    const lead = leads[i];
    const contactLabel =
      lead.verified_name ||
      normalizeDM(lead.decision_maker) ||
      "unknown contact";

    console.log(`\n${"═".repeat(63)}`);
    console.log(`  ${i + 1}/${leads.length}  ${lead.company_name}`);
    console.log(
      `  Fit: ${lead.fit_score?.toFixed(2)} | ${lead.recommendation} | Contact: ${lead.contact_status} — ${contactLabel}`
    );
    console.log(`${"─".repeat(63)}`);

    // Agent 4: Intelligence research
    console.log(`\n🔬 Researching ${lead.company_name}...`);
    let intelligence = null;
    try {
      intelligence = await researchCompany(lead);
      if (intelligence.challenges?.length > 0) {
        console.log(`  ✅ Found ${intelligence.challenges.length} challenge(s):`);
        intelligence.challenges.forEach((c) => {
          const preview = (c.evidence || "").substring(0, 80);
          console.log(`     • [${c.urgency}] ${c.title} — ${preview}${c.evidence?.length > 80 ? "…" : ""}`);
        });
        if (intelligence.outreach_note) {
          console.log(`  💡 Tip: ${intelligence.outreach_note}`);
        }
      } else {
        console.log(
          `  ⚠️  No specific evidence found — messages will use sector-level pain points`
        );
      }
    } catch (err) {
      console.error(`  ❌ Research error: ${err.message}`);
      intelligence = {
        company_name: lead.company_name,
        website_summary: null,
        employee_signal: null,
        challenges: [],
        strongest_hook: lead.recent_signal || null,
        recommended_angle: "process_automation",
        outreach_note: null,
      };
    }

    await sleep(8000);

    // Agent 5A: Email
    console.log(`\n📧 Composing email...`);
    let email = "";
    try {
      email = await composeEmail(lead, intelligence);
      console.log(`  ✅ Email drafted\n`);
      console.log("[EMAIL]");
      console.log("─".repeat(55));
      console.log(email);
      console.log("─".repeat(55));
    } catch (err) {
      console.error(`  ❌ Email error: ${err.message}`);
    }

    await sleep(5000);

    // Agent 5B: WhatsApp
    console.log(`\n💬 Composing WhatsApp...`);
    let whatsapp = "";
    try {
      whatsapp = await composeWhatsApp(lead, intelligence);
      console.log(`  ✅ WhatsApp drafted\n`);
      console.log("[WHATSAPP]");
      console.log("─".repeat(55));
      console.log(whatsapp);
      console.log("─".repeat(55));
    } catch (err) {
      console.error(`  ❌ WhatsApp error: ${err.message}`);
    }

    // Review checklist
    console.log(`\n⚠️  REVIEW BEFORE SENDING:`);
    if (lead.contact_status === "likely_hallucinated") {
      console.log(`   🚨 Contact flagged as likely_hallucinated — verify independently before sending`);
    }
    if (lead.contact_status === "unverified") {
      console.log(`   ❓ Contact is unverified — confirm name and title before sending`);
    }
    if (lead.linkedin_url) {
      console.log(`   🔗 LinkedIn: ${lead.linkedin_url}`);
    }
    if (lead.phone_hint) {
      console.log(`   📱 WhatsApp number hint: ${lead.phone_hint}`);
    }
    if (!lead.phone_hint) {
      console.log(`   📱 WhatsApp: find number via LinkedIn or company website`);
    }

    results.push({
      company_name: lead.company_name,
      sector: lead.sector,
      fit_score: lead.fit_score,
      recommendation: lead.recommendation,
      website: lead.website,
      contact: {
        name: lead.verified_name || normalizeDM(lead.decision_maker) || null,
        status: lead.contact_status,
        linkedin_url: lead.linkedin_url || null,
        phone_hint: lead.phone_hint || null,
      },
      intelligence,
      email,
      whatsapp,
    });

    if (i < leads.length - 1) {
      console.log(`\n⏳ Waiting 12s before next company...`);
      await sleep(12000);
    }
  }

  // Save output
  const timestamp = new Date().toISOString().replace(/:/g, "-").split(".")[0];
  const outputDir = new URL("./communicator_output/", import.meta.url).pathname;
  const outputFile = `${outputDir}communicator_${timestamp}.json`;

  const output = {
    date: new Date().toISOString(),
    source_file: inputFile,
    sector: prospectingOutput.sector,
    model: MODEL,
    tier_filter: tierArg || "all_qualified",
    companies_processed: results.length,
    results,
  };

  try {
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(outputFile, JSON.stringify(output, null, 2));
    console.log(`\n✅ Output saved to ${outputFile}`);
  } catch (err) {
    console.error("  Could not save output:", err.message);
  }

  // Summary
  const withChallenges = results.filter((r) => r.intelligence?.challenges?.length > 0).length;
  const emailsGenerated = results.filter((r) => r.email).length;
  const waGenerated = results.filter((r) => r.whatsapp).length;

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log(
    `📊 ${results.length} processed → ${withChallenges} with evidence-backed challenges`
  );
  console.log(`✉️  ${emailsGenerated} emails + 💬 ${waGenerated} WhatsApp drafts generated`);
  console.log("═══════════════════════════════════════════════════════════════\n");
}

runCommunicator().catch(console.error);
