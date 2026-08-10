// Ute Search Agent
// Searches Carsales, Gumtree, Pickles, and Manheim for a single-cab or extra-cab
// (Patrol/LandCruiser preferred, other 4x4 utes as close matches), automatic-only,
// under 15 years old, under $60,000, all conditions incl. damaged/salvage.
// Uses Haiku (cheaper) for both search and extraction, capped at 8 searches/run
// to keep API cost down.
//
// Runs weekly via GitHub Actions (manual trigger), or daily if scheduled.
// Behaviour:
//  - Mon-Sat (Perth time): emails ONLY newly-found listings since last run.
//  - Sunday (Perth time): emails the FULL list of all currently-tracked,
//    still-available listings (a weekly roundup), regardless of "new" status.
//
// State is kept in seen-listings.json, committed back to the repo each run
// so the agent has memory across runs.

import Anthropic from "@anthropic-ai/sdk";
import nodemailer from "nodemailer";
import fs from "fs";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const STATE_FILE = "seen-listings.json";

const CURRENT_YEAR = new Date().getFullYear();
const MIN_YEAR = CURRENT_YEAR - 15;

const PROMPT = `
Search Australian vehicle marketplaces for a used ute matching this spec.

TARGET SPEC:
- Body: single cab, chassis/tray back (not full dual cab). ALSO acceptable:
  "extra cab" / "space cab" / "king cab" style (small secondary cab behind the front
  seats, 2 main doors, no full rear bench) — commonly seen on Toyota HiLux, Ford
  Ranger, Isuzu D-Max, Mazda BT-50 — treat these as close matches alongside single cabs.
  Full dual cab (4 full doors, full rear bench) is still NOT acceptable.
  WAGONS ARE STRICTLY EXCLUDED — this means NO LandCruiser 76/200/300 Series wagons,
  NO Patrol wagons (GU/Y61/Y62), NO Prado, NO Pajero, NO 4Runner, and no other
  station-wagon-bodied SUV/4WD of any kind, under any circumstances, even as a
  "close match." A ute/tray-back is a fundamentally different vehicle to a wagon —
  do not include wagons even if everything else about them matches (engine, price, age).
  Before including any listing, confirm it has an open tray/deck at the back, not an
  enclosed wagon body with a rear hatch/boot.
- Ideal models: Nissan Patrol or Toyota LandCruiser (70/79 Series etc.)
- Other 4x4 utes acceptable as CLOSE MATCHES if genuinely comparable
  (e.g. similar heavy-duty single-cab tray 4x4s from other makes)
- Transmission: AUTOMATIC ONLY — manual gearbox listings must be excluded entirely,
  even if otherwise a perfect match. Do not include manual vehicles under any
  circumstances, including as "close matches."
- Ideal engine: V8. Acceptable: 6-cylinder or 4-cylinder engines (as long as automatic).
- Age: ${MIN_YEAR} model year or newer (i.e. under 15 years old, as of ${CURRENT_YEAR})
- Price: $60,000 AUD or under. Exclude anything listed above this, even if a great match.
- Condition: include listings of ALL conditions and presentation levels — this
  explicitly includes damaged, accident-affected, insurance write-off (repairable
  or statutory), and salvage-title listings from auction sites. Do not filter
  these out. Note condition/km/damage status clearly in the summary but don't
  exclude based on it.
- For auction sites (Pickles, Manheim, Grays): actively include damaged/salvage/
  repairable write-off listings alongside standard ones — these are often listed
  in separate "damaged vehicles" or "salvage" categories on those sites, so check
  those sections specifically, not just the standard used-vehicle listings.
- Location: Australia, seller can be anywhere but note state/location
- IMPORTANT: given single-cab + V8 + automatic is a very rare factory combination,
  expect few or zero "Exact matches" in many runs. Lean on "Close matches" (e.g.
  automatic dual-cabs, automatic 6-cylinder single cabs, or vehicles with a
  documented aftermarket auto conversion already fitted) so the report still has
  useful content. If truly nothing qualifies at all, say so plainly rather than
  stretching the definition of "close."

SITES TO SEARCH (use at most 8 total web searches across all sites — be efficient, don't repeat similar queries):
1. carsales.com.au
2. gumtree.com.au
3. pickles.com.au (auctions, including damaged/salvage sections)
4. manheim.com.au (auctions, including damaged/salvage sections)

RULES:
- Only include REAL listings you can verify from search results with a working link. Never invent or guess a listing.
- Separate "Exact matches" (Patrol/LandCruiser, single cab) from "Close matches" (other models/body styles).
- For each listing include: Title/model, Year, Engine, Transmission, Cab config, Price, Damage/condition status, Location, Source site, URL.
- Give each listing a short stable ID: source+year+model+price (e.g. "carsales-2015-patrol-45000").
- If a site has nothing, say so in one line rather than skipping it silently.
- Be concise — no filler commentary, just the structured findings.

Return findings as a list grouped "Exact matches" then "Close matches".
`;

async function searchListings() {
  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 4000,
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8 }],
    messages: [{ role: "user", content: PROMPT }],
  });

  const textBlocks = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  return textBlocks;
}

// Ask Claude to convert the free-text findings into a clean JSON array with
// full structured fields per listing, so we can build a consistently
// formatted email ourselves instead of relying on the model's free-text layout.
async function extractListings(findingsText) {
  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 2000,
    messages: [
      {
        role: "user",
        content: `Extract every distinct listing from this ute search output as a JSON array only (no markdown, no preamble, no code fences). Each item must have exactly these fields:
{"id": "<stable id source+year+model+price>", "matchType": "exact" or "close", "title": "<year + make + model>", "engine": "<e.g. V8 diesel>", "transmission": "<automatic>", "cab": "<single cab / extra cab / etc>", "price": "<e.g. $45,000 or 'POA'>", "condition": "<e.g. undamaged / repairable write-off>", "location": "<suburb/state>", "source": "<site name>", "url": "<link>"}

Only include automatic, tray-back utes (single/extra cab) — never wagons, never manuals. If the source text already excluded these, just extract what's there.

Text to extract from:
${findingsText}`,
      },
    ],
  });

  const raw = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");

  try {
    const clean = raw.replace(/```json|```/g, "").trim();
    return JSON.parse(clean);
  } catch (err) {
    console.error("Could not parse listings, continuing with empty list:", err);
    return [];
  }
}

// Build a clean, simple, consistently-formatted plain-text email from
// structured listing data — easier to scan than raw model output.
function formatListingsEmail(listings) {
  if (listings.length === 0) {
    return "No matching listings found in this run.";
  }

  const exact = listings.filter((l) => l.matchType === "exact");
  const close = listings.filter((l) => l.matchType === "close");

  const formatListing = (l, i) =>
    `${i + 1}. ${l.title}
   Price:      ${l.price}
   Engine:     ${l.engine}
   Trans:      ${l.transmission}
   Cab:        ${l.cab}
   Condition:  ${l.condition}
   Location:   ${l.location}
   Source:     ${l.source}
   Link:       ${l.url}`;

  const sections = [];

  sections.push("========================================");
  sections.push("EXACT MATCHES (Patrol / LandCruiser)");
  sections.push("========================================");
  sections.push(
    exact.length > 0
      ? exact.map(formatListing).join("\n\n")
      : "None found this run."
  );

  sections.push("");
  sections.push("========================================");
  sections.push("CLOSE MATCHES (other models)");
  sections.push("========================================");
  sections.push(
    close.length > 0
      ? close.map(formatListing).join("\n\n")
      : "None found this run."
  );

  return sections.join("\n");
}

function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
    } catch {
      return { seenIds: [] };
    }
  }
  return { seenIds: [] };
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function isSunday() {
  // Perth is UTC+8, no daylight saving
  const now = new Date();
  const perthTime = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return perthTime.getUTCDay() === 0; // 0 = Sunday
}

async function sendEmail(subject, body) {
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  });

  await transporter.sendMail({
    from: process.env.GMAIL_USER,
    to: process.env.TO_EMAIL,
    subject,
    text: body,
  });
}

async function main() {
  const weeklyMode = isSunday();
  const state = loadState();
  const previousIds = new Set(state.seenIds || []);

  console.log(`Running in ${weeklyMode ? "WEEKLY ROUNDUP" : "DAILY NEW-ONLY"} mode`);

  const findingsText = await searchListings();
  const listings = await extractListings(findingsText);

  const newListings = listings.filter((l) => !previousIds.has(l.id));
  const allCurrentIds = listings.map((l) => l.id);

  // Update state: union of previously seen + everything found today
  const updatedSeenIds = Array.from(new Set([...previousIds, ...allCurrentIds]));
  saveState({ seenIds: updatedSeenIds, lastRun: new Date().toISOString() });

  if (weeklyMode) {
    const subject = `Ute Search — Weekly Roundup (${listings.length} listings)`;
    const body = `WEEKLY ROUNDUP — all currently available matching listings\n\n${formatListingsEmail(listings)}`;
    await sendEmail(subject, body);
    console.log("Weekly roundup email sent.");
    return;
  }

  if (newListings.length === 0) {
    console.log("No new listings today — no email sent.");
    return;
  }

  const subject = `Ute Search — ${newListings.length} New Listing(s) Found`;
  const body = `NEW LISTINGS FOUND TODAY\n\n${formatListingsEmail(newListings)}`;
  await sendEmail(subject, body);
  console.log(`Sent email with ${newListings.length} new listing(s).`);
}

main().catch((err) => {
  console.error("Agent run failed:", err);
  process.exit(1);
});
