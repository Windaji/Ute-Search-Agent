// Ute Search Agent
// Searches Carsales, Gumtree, Pickles, Manheim, and Facebook Marketplace
// for a single-cab Nissan Patrol / Toyota LandCruiser (or close alternatives)
// under 15 years old, ideally V8 + auto (6/4-cyl and manual acceptable).
//
// Runs daily via GitHub Actions. Behaviour:
//  - Mon-Sat (Perth time): emails ONLY newly-found listings since last run.
//  - Sunday (Perth time): emails the FULL list of all currently-tracked,
//    still-available listings (a weekly roundup), regardless of "new" status.
//
// State is kept in seen-listings.json, committed back to the repo each run
// so the agent has memory across days.

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
- Body: single cab, chassis/tray back (not full dual cab, not wagon). ALSO acceptable:
  "extra cab" / "space cab" / "king cab" style (small secondary cab behind the front
  seats, 2 main doors, no full rear bench) — commonly seen on Toyota HiLux, Ford
  Ranger, Isuzu D-Max, Mazda BT-50 — treat these as close matches alongside single cabs.
  Full dual cab (4 full doors, full rear bench) is still NOT acceptable.
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

SITES TO SEARCH:
1. carsales.com.au
2. gumtree.com.au
3. pickles.com.au (auctions)
4. manheim.com.au (auctions)
5. Facebook Marketplace (best effort only — often not indexed; skip cleanly if inaccessible, do not guess or invent listings)

RULES:
- Only include REAL listings you can verify from search results with a working link. Never invent or guess a listing.
- Clearly separate "Exact matches" (Patrol/LandCruiser, single cab) from "Close matches" (other models or slightly off-spec).
- For each listing include: Title/model, Year, Engine (cylinders/V8, fuel type if known), Transmission, Tray/cab configuration, Price (if listed), Damage/condition status (e.g. "undamaged", "repairable write-off", "salvage", "accident damage — front end" if stated), General location, Source site, and a working URL.
- Give each listing a short stable ID formed from: source site + year + model + price (e.g. "carsales-2015-patrol-45000") so duplicates can be detected across days.
- If nothing matches at all on a given site, say so briefly rather than omitting the site silently.

Return your findings as a clearly structured list grouped by "Exact matches" then "Close matches", each listing with its ID and details as above.
`;

async function searchListings() {
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 6000,
    tools: [{ type: "web_search_20250305", name: "web_search" }],
    messages: [{ role: "user", content: PROMPT }],
  });

  const textBlocks = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  return textBlocks;
}

// Ask Claude to convert the free-text findings into a clean JSON array of
// {id, summary} so we can diff against previous runs reliably.
async function extractListingIds(findingsText) {
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2000,
    messages: [
      {
        role: "user",
        content: `From the following ute search results, extract every distinct listing as a JSON array only (no markdown, no preamble, no code fences). Each item: {"id": "<the short stable ID given>", "summary": "<one line: year, model, engine, trans, price, source>"}.\n\n${findingsText}`,
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
    console.error("Could not parse listing IDs, continuing with empty diff list:", err);
    return [];
  }
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
  const listings = await extractListingIds(findingsText);

  const newListings = listings.filter((l) => !previousIds.has(l.id));
  const allCurrentIds = listings.map((l) => l.id);

  // Update state: union of previously seen + everything found today
  const updatedSeenIds = Array.from(new Set([...previousIds, ...allCurrentIds]));
  saveState({ seenIds: updatedSeenIds, lastRun: new Date().toISOString() });

  if (weeklyMode) {
    const subject = `Ute Search — Weekly Roundup (${listings.length} listings tracked)`;
    const body = `Full weekly roundup of currently available matching listings:\n\n${findingsText}`;
    await sendEmail(subject, body);
    console.log("Weekly roundup email sent.");
    return;
  }

  if (newListings.length === 0) {
    console.log("No new listings today — no email sent.");
    return;
  }

  const subject = `Ute Search — ${newListings.length} New Listing(s) Found`;
  const newSummaries = newListings.map((l) => `- ${l.summary}`).join("\n");
  const body = `New listings found today:\n\n${newSummaries}\n\n---\nFull details:\n\n${findingsText}`;
  await sendEmail(subject, body);
  console.log(`Sent email with ${newListings.length} new listing(s).`);
}

main().catch((err) => {
  console.error("Agent run failed:", err);
  process.exit(1);
});
