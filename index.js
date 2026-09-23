#!/usr/bin/env node

const yargs = require("yargs/yargs");
const { hideBin } = require("yargs/helpers");
const FirecrawlApp = require("@mendable/firecrawl-js").default;
const pLimit = require("p-limit");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const https = require("https");


// ─── GitHub Config ────────────────────────────────────────────────────────────
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_OWNER = "samprice-max";
const GITHUB_REPO = "Loqiva-Events";
const GITHUB_BRANCH = "main";

// ─── Runtime Parsing & End Date Helpers ──────────────────────────────────────
function parseRuntime(description) {
  if (!description) return null;
  const text = description.replace(/<[^>]*>/g, " ");

  const hrsMinMatch = text.match(/run(?:ning)?\s*time[:\s]+(\d+)\s*hrs?\s*(\d+)\s*mins?/i);
  if (hrsMinMatch) return parseInt(hrsMinMatch[1]) * 60 + parseInt(hrsMinMatch[2]);

  const hrsMatch = text.match(/run(?:ning)?\s*time[:\s]+(\d+)\s*hrs?/i);
  if (hrsMatch) return parseInt(hrsMatch[1]) * 60;

  const minsMatch = text.match(/run(?:ning)?\s*time[:\s]+(\d+)\s*mins?/i);
  if (minsMatch) return parseInt(minsMatch[1]);

  return null;
}

function addMinutesToDate(dateStr, minutes) {
  const d = new Date(dateStr.replace(" ", "T"));
  d.setMinutes(d.getMinutes() + minutes);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
}

function ensureEndDate(event) {
  // Replace 23:59:59 end dates (whole-day blocks) with start + 2 hours
  if (event.end_date && event.end_date.endsWith("23:59:59")) {
    const start = new Date(event.start_date.replace(" ", "T"));
    if (!isNaN(start.getTime())) {
      const end = new Date(start.getTime() + 2 * 60 * 60 * 1000);
      const pad = (n) => String(n).padStart(2, "0");
      event.end_date = `${end.getFullYear()}-${pad(end.getMonth()+1)}-${pad(end.getDate())} ${pad(end.getHours())}:${pad(end.getMinutes())}:${pad(end.getSeconds())}`;
    }
  }
  if (event.end_date && !event.end_date.endsWith("00:00:00")) return event;
  const runtime = parseRuntime(event.description);
  const duration = runtime || 120;
  return { ...event, end_date: addMinutesToDate(event.start_date, duration) };
}

// ─── GitHub Push Function ─────────────────────────────────────────────────────
async function pushToGitHub(events, filename) {
  // Only clean event-specific fields if this is an events array
  const isEventsArray = Array.isArray(events) && events.length > 0 && events[0].title;
  const cleanEvents = isEventsArray
    ? events.map(({ _classification, _expandedPerformances, _spektrix_show_id, ...event }) => event)
    : events;
  const content = Buffer.from(JSON.stringify(cleanEvents, null, 2)).toString("base64");

  const getUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${filename}`;
  let sha = null;

  try {
    const getRes = await fetch(getUrl, {
      headers: {
        "Authorization": `Bearer ${GITHUB_TOKEN}`,
        "Accept": "application/vnd.github+json",
      }
    });
    if (getRes.ok) {
      const data = await getRes.json();
      sha = data.sha;
    }
  } catch { /* file doesn't exist yet */ }

  const putRes = await fetch(getUrl, {
    method: "PUT",
    headers: {
      "Authorization": `Bearer ${GITHUB_TOKEN}`,
      "Accept": "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message: `Updated ${filename} - ${new Date().toISOString()}`,
      content,
      branch: GITHUB_BRANCH,
      ...(sha ? { sha } : {}),
    }),
  });

  if (!putRes.ok) {
    const err = await putRes.text();
    throw new Error(`GitHub push failed: ${err}`);
  }

  console.log(`🚀 Pushed to GitHub → ${filename}`);
  console.log(`   🔗 https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/refs/heads/${GITHUB_BRANCH}/${filename}\n`);
}

// ─── CLI Argument Parsing ─────────────────────────────────────────────────────

const argv = yargs(hideBin(process.argv))
  .option("hub", {
    type: "string",
    description: "The name of the hub to scrape (must match hubs.json)",
    demandOption: true,
  })
  .option("deep", {
    type: "boolean",
    description: "Visit each event page for full description, better image and times",
    default: false,
  })
  .option("url", {
    type: "string",
    description: "Only scrape a specific URL within the hub (optional)",
    demandOption: false,
  })
  .help()
  .argv;

// ─── Load & Validate Hub ─────────────────────────────────────────────────────

const hubsPath = path.join(__dirname, "hubs.json");

if (!fs.existsSync(hubsPath)) {
  console.error("❌ ERROR: hubs.json not found. Please create it first.");
  process.exit(1);
}

const hubs = JSON.parse(fs.readFileSync(hubsPath, "utf-8"));
const hubName = argv.hub.trim();
const hub = hubs.find((h) => h.name.toLowerCase() === hubName.toLowerCase());

if (!hub) {
  const available = hubs.map((h) => `  • ${h.name}`).join("\n");
  console.error(`❌ ERROR: Hub "${hubName}" not found in hubs.json.`);
  console.error(`\nAvailable hubs:\n${available}`);
  process.exit(1);
}

console.log(`\n🏙️  Hub: ${hub.name}`);
console.log(`📍  Centre coords: ${hub.latitude}, ${hub.longitude}`);
console.log(`🔗  URLs to scrape: ${hub.urls.length}`);
console.log(`🔍  Deep mode: ${argv.deep ? "ON" : "OFF"}\n`);

// ─── Firecrawl Setup ─────────────────────────────────────────────────────────

const firecrawl = new FirecrawlApp({
  apiKey: process.env.FIRECRAWL_API_KEY || "fc-2e05ce6155e44d4f9d840aff407361eb",
});

// ─── Category Scoring Classifier ─────────────────────────────────────────────

const CATEGORIES = [
  {
    id: 1,
    name: "Dance",
    keywords: [
      { word: "ballet", weight: 3 },
      { word: "choreograph", weight: 3 },
      { word: "salsa", weight: 3 },
      { word: "tango", weight: 3 },
      { word: "ballroom", weight: 3 },
      { word: "hip hop dance", weight: 3 },
      { word: "street dance", weight: 3 },
      { word: "breakdancing", weight: 3 },
      { word: "breakdance", weight: 3 },
      { word: "contemporary dance", weight: 3 },
      { word: "flamenco", weight: 3 },
      { word: "tap dance", weight: 3 },
      { word: "latin dance", weight: 3 },
      { word: "swing dance", weight: 3 },
      { word: "lindy hop", weight: 3 },
      { word: "ceroc", weight: 3 },
      { word: "jive", weight: 3 },
      { word: "dance show", weight: 3 },
      { word: "dance performance", weight: 3 },
      { word: "dance showcase", weight: 3 },
      { word: "dance recital", weight: 3 },
      { word: "dance", weight: 2 },
      { word: "dancing", weight: 2 },
      { word: "movement", weight: 1 },
    ]
  },
  {
    id: 2,
    name: "Community",
    keywords: [
      { word: "residents association", weight: 3 },
      { word: "neighbourhood watch", weight: 3 },
      { word: "community meeting", weight: 3 },
      { word: "town hall", weight: 3 },
      { word: "community group", weight: 3 },
      { word: "community hub", weight: 3 },
      { word: "community centre", weight: 3 },
      { word: "community garden", weight: 3 },
      { word: "community cafe", weight: 3 },
      { word: "community kitchen", weight: 3 },
      { word: "community event", weight: 3 },
      { word: "local group", weight: 2 },
      { word: "community scheme", weight: 2 },
      { word: "community access", weight: 2 },
      { word: "neighbours", weight: 2 },
      { word: "local community", weight: 2 },
      { word: "community", weight: 1 },
    ]
  },
  {
    id: 3,
    name: "Comedy & Spoken Word",
    keywords: [
      { word: "stand-up", weight: 3 },
      { word: "standup", weight: 3 },
      { word: "stand up comedy", weight: 3 },
      { word: "comedian", weight: 3 },
      { word: "comedy night", weight: 3 },
      { word: "comedy show", weight: 3 },
      { word: "comedy club", weight: 3 },
      { word: "open mic", weight: 3 },
      { word: "improv", weight: 3 },
      { word: "improvisation", weight: 3 },
      { word: "spoken word", weight: 3 },
      { word: "raconteur", weight: 3 },
      { word: "comic", weight: 3 },
      { word: "one man show", weight: 3 },
      { word: "one woman show", weight: 3 },
      { word: "an evening with", weight: 2 },
      { word: "comedy", weight: 2 },
      { word: "anecdotes", weight: 2 },
      { word: "jokes", weight: 2 },
      { word: "sketch", weight: 2 },
      { word: "laughs", weight: 2 },
      { word: "laughter", weight: 2 },
      { word: "humour", weight: 1 },
      { word: "humor", weight: 1 },
    ]
  },
  {
    id: 4,
    name: "Education",
    keywords: [
      { word: "course", weight: 3 },
      { word: "lesson", weight: 3 },
      { word: "academic", weight: 3 },
      { word: "school visit", weight: 3 },
      { word: "learning programme", weight: 3 },
      { word: "masterclass", weight: 3 },
      { word: "seminar", weight: 3 },
      { word: "webinar", weight: 3 },
      { word: "workshop series", weight: 3 },
      { word: "training day", weight: 3 },
      { word: "cpd", weight: 3 },
      { word: "professional development", weight: 3 },
      { word: "training", weight: 2 },
      { word: "study", weight: 2 },
      { word: "lecture", weight: 2 },
      { word: "tuition", weight: 2 },
      { word: "learn", weight: 1 },
      { word: "class", weight: 1 },
    ]
  },
  {
    id: 5,
    name: "Kids & Family",
    keywords: [
      { word: "family fun", weight: 3 },
      { word: "toddler", weight: 3 },
      { word: "easter egg", weight: 3 },
      { word: "egg hunt", weight: 3 },
      { word: "story time", weight: 3 },
      { word: "storytime", weight: 3 },
      { word: "puppet show", weight: 3 },
      { word: "treasure hunt", weight: 3 },
      { word: "fairy tale", weight: 3 },
      { word: "school performance", weight: 3 },
      { word: "half term", weight: 3 },
      { word: "ages 3+", weight: 3 },
      { word: "ages 5+", weight: 3 },
      { word: "under 12", weight: 3 },
      { word: "baby class", weight: 3 },
      { word: "baby group", weight: 3 },
      { word: "baby cafe", weight: 3 },
      { word: "sensory play", weight: 3 },
      { word: "soft play", weight: 3 },
      { word: "kids workshop", weight: 3 },
      { word: "children's show", weight: 3 },
      { word: "family show", weight: 3 },
      { word: "kids", weight: 3 },
      { word: "children", weight: 3 },
      { word: "baby", weight: 3 },
      { word: "toddlers", weight: 3 },
      { word: "infant", weight: 3 },
      { word: "newborn", weight: 3 },
      { word: "family", weight: 2 },
      { word: "families", weight: 2 },
      { word: "youth", weight: 2 },
      { word: "junior", weight: 2 },
      { word: "young people", weight: 2 },
      { word: "all ages", weight: 1 },
      { word: "halloween", weight: 3 },
      { word: "half-term", weight: 3 },
      { word: "xmas", weight: 2 },
      { word: "school holiday", weight: 1 },
      { word: "christmas", weight: 1 },
    ]
  },
  {
    id: 6,
    name: "Festivals",
    keywords: [
      { word: "festival", weight: 3 },
      { word: "carnival", weight: 3 },
      { word: "fiesta", weight: 3 },
      { word: "fest", weight: 2 },
      { word: "celebration", weight: 2 },
      { word: "fair", weight: 1 },
    ]
  },
  {
    id: 7,
    name: "Film",
    keywords: [
      { word: "film screening", weight: 3 },
      { word: "film premiere", weight: 3 },
      { word: "screening", weight: 3 },
      { word: "cinema", weight: 3 },
      { word: "documentary", weight: 3 },
      { word: "short film", weight: 3 },
      { word: "feature film", weight: 3 },
      { word: "film club", weight: 3 },
      { word: "outdoor cinema", weight: 3 },
      { word: "film festival", weight: 3 },
      { word: "director q&a", weight: 3 },
      { word: "film", weight: 2 },
      { word: "movie", weight: 2 },
      { word: "cinema", weight: 2 },
    ]
  },
  {
    id: 8,
    name: "Food & Drink",
    keywords: [
      { word: "afternoon tea", weight: 3 },
      { word: "bottomless brunch", weight: 3 },
      { word: "wine tasting", weight: 3 },
      { word: "beer festival", weight: 3 },
      { word: "cocktail making", weight: 3 },
      { word: "chef demonstration", weight: 3 },
      { word: "cooking class", weight: 3 },
      { word: "supper club", weight: 3 },
      { word: "drag brunch", weight: 3 },
      { word: "cheese tasting", weight: 3 },
      { word: "gin tasting", weight: 3 },
      { word: "whisky tasting", weight: 3 },
      { word: "rum tasting", weight: 3 },
      { word: "food festival", weight: 3 },
      { word: "street food", weight: 3 },
      { word: "pop up restaurant", weight: 3 },
      { word: "bottomless", weight: 2 },
      { word: "food", weight: 2 },
      { word: "dining", weight: 2 },
      { word: "restaurant", weight: 2 },
      { word: "tasting", weight: 2 },
      { word: "scones", weight: 2 },
      { word: "sandwiches", weight: 2 },
      { word: "culinary", weight: 2 },
      { word: "drinks", weight: 1 },
      { word: "lunch", weight: 1 },
      { word: "dinner", weight: 1 },
      { word: "brunch", weight: 1 },
      { word: "breakfast", weight: 1 },
    ]
  },
  {
    id: 9,
    name: "Fundraising & Charity",
    keywords: [
      { word: "fundraiser", weight: 3 },
      { word: "charity gala", weight: 3 },
      { word: "charity auction", weight: 3 },
      { word: "raffle", weight: 3 },
      { word: "donate", weight: 3 },
      { word: "sponsored", weight: 3 },
      { word: "sponsor", weight: 3 },
      { word: "charity challenge", weight: 3 },
      { word: "charity run", weight: 3 },
      { word: "charity", weight: 2 },
      { word: "fundraising", weight: 2 },
      { word: "benefit night", weight: 2 },
      { word: "non-profit", weight: 2 },
      { word: "nonprofit", weight: 2 },
      { word: "proceeds", weight: 2 },
      { word: "collection", weight: 1 },
    ]
  },
  {
    id: 10,
    name: "Arts & Crafts",
    keywords: [
      { word: "life drawing", weight: 3 },
      { word: "figure drawing", weight: 3 },
      { word: "drink and draw", weight: 3 },
      { word: "printmaking", weight: 3 },
      { word: "pottery", weight: 3 },
      { word: "ceramics", weight: 3 },
      { word: "life model", weight: 3 },
      { word: "nude model", weight: 3 },
      { word: "plaster craft", weight: 3 },
      { word: "calligraphy", weight: 3 },
      { word: "clay workshop", weight: 3 },
      { word: "art workshop", weight: 3 },
      { word: "craft workshop", weight: 3 },
      { word: "jewellery making", weight: 3 },
      { word: "jewelry making", weight: 3 },
      { word: "knitting", weight: 3 },
      { word: "crocheting", weight: 3 },
      { word: "sewing", weight: 3 },
      { word: "weaving", weight: 3 },
      { word: "painting class", weight: 3 },
      { word: "drawing class", weight: 3 },
      { word: "watercolour", weight: 3 },
      { word: "watercolor", weight: 3 },
      { word: "sculpture", weight: 2 },
      { word: "illustration", weight: 2 },
      { word: "textiles", weight: 2 },
      { word: "embroidery", weight: 2 },
      { word: "mosaic", weight: 2 },
      { word: "woodworking", weight: 2 },
      { word: "glasswork", weight: 2 },
      { word: "painting", weight: 2 },
      { word: "craft", weight: 1 },
      { word: "creative", weight: 1 },
    ]
  },
  {
    id: 11,
    name: "Health & Wellness",
    keywords: [
      { word: "yoga", weight: 3 },
      { word: "pilates", weight: 3 },
      { word: "meditation", weight: 3 },
      { word: "mindfulness", weight: 3 },
      { word: "sound bath", weight: 3 },
      { word: "sound healing", weight: 3 },
      { word: "sound bowl", weight: 3 },
      { word: "reiki", weight: 3 },
      { word: "breathwork", weight: 3 },
      { word: "group run", weight: 3 },
      { word: "running session", weight: 3 },
      { word: "goodgym", weight: 3 },
      { word: "parkrun", weight: 3 },
      { word: "5k", weight: 3 },
      { word: "10k", weight: 3 },
      { word: "group cycle", weight: 3 },
      { word: "power pump", weight: 3 },
      { word: "body conditioning", weight: 3 },
      { word: "aqua aerobics", weight: 3 },
      { word: "circuit training", weight: 3 },
      { word: "dance fitness", weight: 3 },
      { word: "legs bums and tums", weight: 3 },
      { word: "legs, bums and tums", weight: 3 },
      { word: "boxfit", weight: 3 },
      { word: "core conditioning", weight: 3 },
      { word: "step aerobics", weight: 3 },
      { word: "seated exercise", weight: 3 },
      { word: "zumba", weight: 3 },
      { word: "tai chi", weight: 3 },
      { word: "qigong", weight: 3 },
      { word: "aerobics", weight: 3 },
      { word: "spinning", weight: 3 },
      { word: "hiit", weight: 3 },
      { word: "bootcamp", weight: 3 },
      { word: "boot camp", weight: 3 },
      { word: "personal training", weight: 3 },
      { word: "wellness", weight: 2 },
      { word: "wellbeing", weight: 2 },
      { word: "mental health", weight: 2 },
      { word: "fitness class", weight: 2 },
      { word: "workout", weight: 2 },
      { word: "conditioning", weight: 2 },
      { word: "combat", weight: 2 },
      { word: "cycle", weight: 2 },
      { word: "relaxation", weight: 2 },
      { word: "stress relief", weight: 2 },
      { word: "therapeutic", weight: 1 },
      { word: "fitness", weight: 1 },
      { word: "gym", weight: 1 },
      { word: "run", weight: 1 },
    ]
  },
  {
    id: 12,
    name: "Music",
    keywords: [
      { word: "concert", weight: 3 },
      { word: "gig", weight: 3 },
      { word: "live music", weight: 3 },
      { word: "jazz", weight: 3 },
      { word: "classical", weight: 3 },
      { word: "orchestra", weight: 3 },
      { word: "choir", weight: 3 },
      { word: "opera", weight: 3 },
      { word: "folk", weight: 3 },
      { word: "blues", weight: 3 },
      { word: "reggae", weight: 3 },
      { word: "funk", weight: 3 },
      { word: "swing", weight: 3 },
      { word: "big band", weight: 3 },
      { word: "acoustic", weight: 3 },
      { word: "tribute show", weight: 3 },
      { word: "tribute act", weight: 3 },
      { word: "tribute to", weight: 3 },
      { word: "live band", weight: 3 },
      { word: "open mic night", weight: 3 },
      { word: "jam session", weight: 3 },
      { word: "recital", weight: 3 },
      { word: "music festival", weight: 3 },
      { word: "album launch", weight: 3 },
      { word: "headline", weight: 3 },
      { word: "band", weight: 2 },
      { word: "singer", weight: 2 },
      { word: "musical performance", weight: 2 },
      { word: "dj set", weight: 2 },
      { word: "dj", weight: 2 },
      { word: "anthems", weight: 2 },
      { word: "vocalist", weight: 2 },
      { word: "musician", weight: 2 },
      { word: "instrument", weight: 2 },
      { word: "rock", weight: 2 },
      { word: "pop", weight: 2 },
      { word: "soul", weight: 2 },
      { word: "hip hop", weight: 2 },
      { word: "rnb", weight: 2 },
      { word: "r&b", weight: 2 },
      { word: "country", weight: 2 },
      { word: "electronic", weight: 2 },
      { word: "hits", weight: 1 },
      { word: "music", weight: 1 },
    ]
  },
  {
    id: 13,
    name: "Literary & Books",
    keywords: [
      { word: "book launch", weight: 3 },
      { word: "author talk", weight: 3 },
      { word: "author reading", weight: 3 },
      { word: "poetry reading", weight: 3 },
      { word: "poetry slam", weight: 3 },
      { word: "litfest", weight: 3 },
      { word: "lit fest", weight: 3 },
      { word: "literary festival", weight: 3 },
      { word: "book club", weight: 3 },
      { word: "writing group", weight: 3 },
      { word: "writers group", weight: 3 },
      { word: "creative writing", weight: 3 },
      { word: "screenplay", weight: 3 },
      { word: "playwriting", weight: 3 },
      { word: "novelist", weight: 3 },
      { word: "short story", weight: 3 },
      { word: "zine", weight: 3 },
      { word: "poetry", weight: 3 },
      { word: "literature", weight: 2 },
      { word: "author", weight: 2 },
      { word: "novel", weight: 2 },
      { word: "fiction", weight: 2 },
      { word: "non-fiction", weight: 2 },
      { word: "playwright", weight: 2 },
      { word: "poet", weight: 2 },
      { word: "writing", weight: 2 },
      { word: "words", weight: 1 },
      { word: "publishing", weight: 1 },
      { word: "storytelling", weight: 1 },
    ]
  },
  {
    id: 14,
    name: "Museums & Attractions",
    keywords: [
      { word: "exhibition", weight: 3 },
      { word: "permanent collection", weight: 3 },
      { word: "gallery tour", weight: 3 },
      { word: "curator tour", weight: 3 },
      { word: "guided tour", weight: 3 },
      { word: "palace tour", weight: 3 },
      { word: "historic house", weight: 3 },
      { word: "art exhibition", weight: 3 },
      { word: "gallery exhibition", weight: 3 },
      { word: "open studios", weight: 3 },
      { word: "art show", weight: 3 },
      { word: "works on paper", weight: 3 },
      { word: "retrospective", weight: 3 },
      { word: "installation art", weight: 3 },
      { word: "artist talk", weight: 3 },
      { word: "private view", weight: 3 },
      { word: "vernissage", weight: 3 },
      { word: "display", weight: 2 },
      { word: "museum", weight: 2 },
      { word: "heritage", weight: 2 },
      { word: "palace", weight: 2 },
      { word: "gallery", weight: 2 },
      { word: "artefact", weight: 2 },
      { word: "artifact", weight: 2 },
      { word: "historic", weight: 1 },
      { word: "collection", weight: 1 },
    ]
  },
  {
    id: 16,
    name: "Markets",
    keywords: [
      { word: "market stall", weight: 3 },
      { word: "craft market", weight: 3 },
      { word: "food market", weight: 3 },
      { word: "farmers market", weight: 3 },
      { word: "pop-up market", weight: 3 },
      { word: "antique market", weight: 3 },
      { word: "vintage market", weight: 3 },
      { word: "flea market", weight: 3 },
      { word: "artisan market", weight: 3 },
      { word: "christmas market", weight: 3 },
      { word: "market", weight: 2 },
      { word: "vendor", weight: 2 },
      { word: "artisan stall", weight: 2 },
      { word: "traders", weight: 2 },
      { word: "stall", weight: 1 },
    ]
  },
  {
    id: 17,
    name: "Nightlife",
    keywords: [
      { word: "drag show", weight: 3 },
      { word: "cabaret", weight: 3 },
      { word: "dragaoke", weight: 3 },
      { word: "karaoke", weight: 3 },
      { word: "drag queen", weight: 3 },
      { word: "drag king", weight: 3 },
      { word: "burlesque", weight: 3 },
      { word: "club night", weight: 3 },
      { word: "late night bar", weight: 3 },
      { word: "after dark", weight: 3 },
      { word: "pub quiz", weight: 3 },
      { word: "quiz night", weight: 3 },
      { word: "bingo night", weight: 3 },
      { word: "comedy club", weight: 3 },
      { word: "nightlife", weight: 3 },
      { word: "dancefloor", weight: 2 },
      { word: "disco", weight: 2 },
      { word: "night out", weight: 2 },
      { word: "late night", weight: 2 },
      { word: "rave", weight: 2 },
      { word: "club", weight: 1 },
      { word: "party", weight: 1 },
    ]
  },
  {
    id: 19,
    name: "Talks & Tours",
    keywords: [
      { word: "heritage tour", weight: 3 },
      { word: "theatre tour", weight: 3 },
      { word: "panel discussion", weight: 3 },
      { word: "keynote", weight: 3 },
      { word: "walking tour", weight: 3 },
      { word: "guided walk", weight: 3 },
      { word: "study day", weight: 3 },
      { word: "lecture series", weight: 3 },
      { word: "in conversation with", weight: 3 },
      { word: "q&a", weight: 3 },
      { word: "fireside chat", weight: 3 },
      { word: "symposium", weight: 3 },
      { word: "conference", weight: 3 },
      { word: "history of", weight: 2 },
      { word: "architecture", weight: 2 },
      { word: "heritage guide", weight: 2 },
      { word: "talk", weight: 2 },
      { word: "panel", weight: 2 },
      { word: "discussion", weight: 2 },
      { word: "debate", weight: 2 },
      { word: "speaker", weight: 2 },
      { word: "tour", weight: 1 },
      { word: "presentation", weight: 1 },
    ]
  },
  {
    id: 20,
    name: "Sport & Outdoors",
    keywords: [
      { word: "tournament", weight: 3 },
      { word: "marathon", weight: 3 },
      { word: "cycling event", weight: 3 },
      { word: "football match", weight: 3 },
      { word: "cricket match", weight: 3 },
      { word: "rugby match", weight: 3 },
      { word: "tennis tournament", weight: 3 },
      { word: "swimming gala", weight: 3 },
      { word: "athletics", weight: 3 },
      { word: "nature walk", weight: 3 },
      { word: "birdwatching", weight: 3 },
      { word: "conservation", weight: 3 },
      { word: "habitat", weight: 3 },
      { word: "lake workday", weight: 3 },
      { word: "workday", weight: 3 },
      { word: "planting day", weight: 3 },
      { word: "volunteer conservation", weight: 3 },
      { word: "open water", weight: 3 },
      { word: "wild swimming", weight: 3 },
      { word: "parkbathe", weight: 3 },
      { word: "sport", weight: 2 },
      { word: "sports", weight: 2 },
      { word: "outdoor activity", weight: 2 },
      { word: "wildlife", weight: 2 },
      { word: "hiking", weight: 2 },
      { word: "climbing", weight: 2 },
      { word: "kayaking", weight: 2 },
      { word: "canoeing", weight: 2 },
      { word: "outdoors", weight: 1 },
      { word: "park", weight: 1 },
      { word: "garden", weight: 1 },
    ]
  },
  {
    id: 21,
    name: "Theatre",
    keywords: [
      { word: "play", weight: 3 },
      { word: "musical", weight: 3 },
      { word: "pantomime", weight: 3 },
      { word: "stage performance", weight: 3 },
      { word: "theatre production", weight: 3 },
      { word: "drama", weight: 3 },
      { word: "west end", weight: 3 },
      { word: "touring production", weight: 3 },
      { word: "stage show", weight: 3 },
      { word: "magic show", weight: 3 },
      { word: "illusionist", weight: 3 },
      { word: "magic", weight: 3 },
      { word: "opera", weight: 3 },
      { word: "mime", weight: 3 },
      { word: "physical theatre", weight: 3 },
      { word: "devised theatre", weight: 3 },
      { word: "immersive theatre", weight: 3 },
      { word: "site specific", weight: 3 },
      { word: "fringe", weight: 3 },
      { word: "curtain", weight: 2 },
      { word: "theatre", weight: 2 },
      { word: "acting", weight: 2 },
      { word: "cast", weight: 2 },
      { word: "matinee", weight: 2 },
      { word: "rehearsal", weight: 2 },
      { word: "audition", weight: 2 },
      { word: "performance", weight: 1 },
      { word: "stage", weight: 1 },
    ]
  },
  {
    id: 22,
    name: "Pets",
    keywords: [
      { word: "dog show", weight: 3 },
      { word: "pet event", weight: 3 },
      { word: "animal sanctuary", weight: 3 },
      { word: "dog agility", weight: 3 },
      { word: "dog training", weight: 3 },
      { word: "cat show", weight: 3 },
      { word: "rabbit show", weight: 3 },
      { word: "pets", weight: 2 },
      { word: "dogs", weight: 2 },
      { word: "cats", weight: 2 },
      { word: "animal", weight: 1 },
    ]
  },
  {
    id: 23,
    name: "Politics & Activism",
    keywords: [
      { word: "protest", weight: 3 },
      { word: "campaign", weight: 3 },
      { word: "political rally", weight: 3 },
      { word: "climate action", weight: 3 },
      { word: "climate protest", weight: 3 },
      { word: "march", weight: 3 },
      { word: "demonstration", weight: 3 },
      { word: "activism", weight: 3 },
      { word: "activist", weight: 3 },
      { word: "politics", weight: 2 },
      { word: "political", weight: 2 },
      { word: "democracy", weight: 2 },
      { word: "rights", weight: 2 },
      { word: "justice", weight: 2 },
      { word: "equality", weight: 1 },
    ]
  },
  {
    id: 25,
    name: "Science",
    keywords: [
      { word: "astronomy", weight: 3 },
      { word: "biology", weight: 3 },
      { word: "physics", weight: 3 },
      { word: "chemistry", weight: 3 },
      { word: "stem workshop", weight: 3 },
      { word: "space exploration", weight: 3 },
      { word: "stargazing", weight: 3 },
      { word: "robotics", weight: 3 },
      { word: "science fair", weight: 3 },
      { word: "nature science", weight: 3 },
      { word: "science", weight: 2 },
      { word: "scientific", weight: 2 },
      { word: "experiment", weight: 2 },
      { word: "research", weight: 1 },
    ]
  },
  {
    id: 26,
    name: "Religion & Spirituality",
    keywords: [
      { word: "church service", weight: 3 },
      { word: "mosque", weight: 3 },
      { word: "temple", weight: 3 },
      { word: "synagogue", weight: 3 },
      { word: "prayer", weight: 3 },
      { word: "worship", weight: 3 },
      { word: "sufi", weight: 3 },
      { word: "buddhist", weight: 3 },
      { word: "buddhist retreat", weight: 3 },
      { word: "tibetan", weight: 3 },
      { word: "chakra", weight: 3 },
      { word: "crystal healing", weight: 3 },
      { word: "astrology", weight: 3 },
      { word: "tarot", weight: 3 },
      { word: "psychic", weight: 3 },
      { word: "mediumship", weight: 3 },
      { word: "galactic", weight: 3 },
      { word: "starseed", weight: 3 },
      { word: "empath", weight: 3 },
      { word: "retreat", weight: 2 },
      { word: "religious", weight: 2 },
      { word: "spiritual", weight: 2 },
      { word: "spirituality", weight: 2 },
      { word: "faith", weight: 2 },
      { word: "sacred", weight: 2 },
      { word: "divine", weight: 1 },
    ]
  },
  {
    id: 28,
    name: "Technology",
    keywords: [
      { word: "coding", weight: 3 },
      { word: "programming", weight: 3 },
      { word: "hackathon", weight: 3 },
      { word: "ai workshop", weight: 3 },
      { word: "software", weight: 3 },
      { word: "startup pitch", weight: 3 },
      { word: "app development", weight: 3 },
      { word: "machine learning", weight: 3 },
      { word: "artificial intelligence", weight: 3 },
      { word: "virtual reality", weight: 3 },
      { word: "augmented reality", weight: 3 },
      { word: "game development", weight: 3 },
      { word: "technology", weight: 2 },
      { word: "digital", weight: 2 },
      { word: "tech", weight: 2 },
      { word: "cyber", weight: 2 },
      { word: "blockchain", weight: 2 },
      { word: "innovation", weight: 1 },
      { word: "data", weight: 1 },
    ]
  },
  {
    id: 29,
    name: "Other",
    keywords: []
  }
];

const MIN_SCORE = 4;

function classifyEvent(title, description) {
  const titleLower = title.toLowerCase();
  const descLower = (description || "").toLowerCase().replace(/<[^>]*>/g, "");

  const scores = {};

  for (const category of CATEGORIES) {
    if (category.id === 29) continue;

    let score = 0;

    for (const { word, weight } of category.keywords) {
      if (titleLower.includes(word)) score += weight * 2;
      if (descLower.includes(word)) score += weight;
    }

    if (score > 0) scores[category.id] = { score, name: category.name };
  }

  let bestId = 29;
  let bestScore = 0;

  for (const [id, { score }] of Object.entries(scores)) {
    if (score > bestScore) {
      bestScore = score;
      bestId = parseInt(id);
    }
  }

  if (bestScore < MIN_SCORE) bestId = 29;

  return {
    id: bestId,
    name: CATEGORIES.find(c => c.id === bestId)?.name || "Other",
    score: bestScore
  };
}

// ─── JSON Schema (listing page) ───────────────────────────────────────────────

const LISTING_SCHEMA = {
  type: "object",
  properties: {
    events: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string", description: "The name of the event." },
          description: { type: "string", description: "A summary of the event. IMPORTANT: This MUST be wrapped in HTML <p> tags." },
          address: { type: "string", description: "The full physical address of the event." },
          longitude: { type: ["number", "null"] },
          latitude: { type: ["number", "null"] },
          venue_name: { type: "string", description: "The name of the venue or site." },
          image_url: { type: "string", description: "The absolute URL of the event image (must start with https://)." },
          tickets_url: { type: ["string", "null"], description: "The direct link to buy tickets or the booking page." },
          url: { type: "string", description: "The specific permalink for this event on the venue website." },
          start_date: { type: "string", description: "The start date and time. STRICT FORMAT: YYYY-MM-DD HH:MM:SS" },
          end_date: { type: "string", description: "The end date and time. STRICT FORMAT: YYYY-MM-DD HH:MM:SS" }
        },
        required: ["title", "description", "start_date", "venue_name", "image_url", "url"]
      }
    }
  }
};

// ─── JSON Schema (individual event page) ─────────────────────────────────────

const EVENT_PAGE_SCHEMA = {
  type: "object",
  properties: {
    description: { type: "string", description: "The full description of the event. IMPORTANT: This MUST be wrapped in HTML <p> tags. Include all paragraphs of detail." },
    image_url: { type: "string", description: "The best, largest image URL for this event (must start with https://)." },
    start_date: { type: "string", description: "The start date AND time of the FIRST performance. STRICT FORMAT: YYYY-MM-DD HH:MM:SS." },
    end_date: { type: "string", description: "The end date AND time of the FIRST performance. STRICT FORMAT: YYYY-MM-DD HH:MM:SS." },
    performances: {
      type: "array",
      description: "List of ALL individual performance dates and times shown on this page. Only populate if the page shows multiple distinct performance dates/times.",
      items: {
        type: "object",
        properties: {
          start_date: { type: "string", description: "Performance start date and time. STRICT FORMAT: YYYY-MM-DD HH:MM:SS." },
          end_date: { type: "string", description: "Performance end date and time. STRICT FORMAT: YYYY-MM-DD HH:MM:SS." }
        }
      }
    }
  }
};

// ─── Utility: Generate Unique Integer ID ─────────────────────────────────────

function generateEventId(title, startDate, venueName) {
  const raw = `${title}|${startDate}|${venueName}`.toLowerCase().trim();
  const hash = crypto.createHash("md5").update(raw).digest("hex");
  return parseInt(hash.substring(0, 8), 16);
}

// ─── Utility: Format Date ─────────────────────────────────────────────────────

function formatDate(dateStr) {
  if (!dateStr) return null;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(dateStr)) return dateStr;
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    const pad = (n) => String(n).padStart(2, "0");
    return (
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
      `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    );
  } catch {
    return dateStr;
  }
}

// ─── Utility: Extract Date From URL ──────────────────────────────────────────

const MONTH_MAP = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12"
};

function extractDateFromUrl(url, defaultTime = "19:00:00") {
  if (!url) return null;
  const match = url.match(/-(mon|tue|wed|thu|fri|sat|sun)-(\d{1,2})-(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\/?$/i);
  if (!match) return null;

  const day = match[2].padStart(2, "0");
  const monthAbbr = match[3].toLowerCase();
  const monthNum = MONTH_MAP[monthAbbr];

  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;

  const year = parseInt(monthNum) < currentMonth ? currentYear + 1 : currentYear;

  return `${year}-${monthNum}-${day} ${defaultTime}`;
}

// ─── Utility: Wrap Description in <p> Tags ───────────────────────────────────

function wrapDescription(desc) {
  if (!desc) return "<p></p>";
  const trimmed = desc.trim();
  if (trimmed.startsWith("<p>") && trimmed.endsWith("</p>")) return trimmed;
  return `<p>${trimmed}</p>`;
}

// ─── Utility: Check Image URL is Valid ───────────────────────────────────────

function checkImageUrl(url) {
  return new Promise((resolve) => {
    if (!url || typeof url !== "string") return resolve(false);
    if (url.includes("#")) return resolve(false);
    if (url.startsWith("/")) return resolve(false);
    const checkUrl = url.startsWith("http://") ? url.replace("http://", "https://") : url;
    if (!checkUrl.startsWith("https://")) return resolve(false);
    if (checkUrl.length > 500) return resolve(false);
    try {
      const req = https.request(checkUrl, { method: "HEAD", timeout: 8000 }, (res) => {
        resolve(res.statusCode === 200);
      });
      req.on("error", () => resolve(false));
      req.on("timeout", () => { req.destroy(); resolve(false); });
      req.end();
    } catch {
      resolve(false);
    }
  });
}

// ─── Utility: Sleep ───────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Deep Scrape: Individual Event Page ──────────────────────────────────────

async function scrapeEventPage(event) {
  try {
    const hasSeparateUrls = event.tickets_url && event.url && event.tickets_url !== event.url;

    const dateTarget = hasSeparateUrls ? event.tickets_url : event.url;
    const dateResponse = await firecrawl.scrapeUrl(dateTarget, {
      timeout: 60000,
      waitFor: 3000,
      formats: ["extract"],
      extract: {
        schema: EVENT_PAGE_SCHEMA,
        systemPrompt:
          "You are an expert event data extractor. From this event page extract: " +
          "1. If the page shows MULTIPLE performance dates/times (e.g. 'Thu 9 Jul 7:00pm', 'Fri 10 Jul 7:00pm'), " +
          "extract ALL of them into the performances array, each with start_date in YYYY-MM-DD HH:MM:SS format. " +
          "If only ONE date/time is shown, just populate start_date and end_date fields directly. " +
          "Search thoroughly for times — they may appear as '7pm', '7:00pm', '19:00', in a <time> element, " +
          "or next to words like 'Doors', 'Start', 'Begins', 'Time'. Default to 12:00:00 if no time found. " +
          "2. The event description — include paragraphs describing the event, atmosphere and highlights. " +
          "Do NOT include ticket prices, ticket types, booking instructions, meal options or seating info. Wrap in <p> tags. " +
          "3. The best/largest image URL for this event (must be https://).",
      },
    });

    if (dateResponse.success && dateResponse.extract) {
      const extracted = dateResponse.extract;

      // Apply description and image first
      if (!hasSeparateUrls) {
        if (extracted.description) {
          const newDesc = wrapDescription(extracted.description);
          if (newDesc.length > event.description.length) event.description = newDesc;
        }
        if (extracted.image_url) {
          const imageValid = await checkImageUrl(extracted.image_url);
          if (imageValid) {
            event.image_url = extracted.image_url.startsWith("http://")
              ? extracted.image_url.replace("http://", "https://")
              : extracted.image_url;
          }
        }
      }

      // Expand multiple performances into separate events
      if (extracted.performances && extracted.performances.length > 1) {
        const expandedEvents = [];
        for (const perf of extracted.performances) {
          let perfStart = formatDate(perf.start_date);
          let perfEnd = perf.end_date ? formatDate(perf.end_date) : null;
          // Fix midnight times
          if (perfStart && perfStart.endsWith("00:00:00")) perfStart = perfStart.replace("00:00:00", "12:00:00");
          if (perfEnd && perfEnd.endsWith("00:00:00")) perfEnd = perfEnd.replace("00:00:00", "12:00:00");
          if (!perfStart) continue;
          const perfEvent = {
            ...event,
            start_date: perfStart,
            end_date: perfEnd,
            id: generateEventId(event.title, perfStart, event.venue_name),
          };
          expandedEvents.push(ensureEndDate(perfEvent));
        }
        if (expandedEvents.length > 0) {
          event._expandedPerformances = expandedEvents;
          return event;
        }
      }

      // Single date fallback
      if (extracted.start_date) {
        let formatted = formatDate(extracted.start_date);
        if (formatted) {
          if (formatted.endsWith("00:00:00")) formatted = formatted.replace("00:00:00", "12:00:00");
          event.start_date = formatted;
        }
      }
      if (extracted.end_date) {
        let formatted = formatDate(extracted.end_date);
        if (formatted) {
          if (formatted.endsWith("00:00:00")) formatted = formatted.replace("00:00:00", "12:00:00");
          event.end_date = formatted;
        }
      }
    }

    if (hasSeparateUrls) {
      const contentResponse = await firecrawl.scrapeUrl(event.url, {
        timeout: 120000,
        waitFor: 8000,
        formats: ["extract"],
        extract: {
          schema: EVENT_PAGE_SCHEMA,
          systemPrompt:
            "You are an expert event data extractor. From this event page extract: " +
            "1. The event description — include all paragraphs describing what the event is about, the atmosphere, highlights and performers. " +
            "Do NOT include ticket prices, ticket types, booking instructions, meal options, seating information or terms and conditions. Wrap in <p> tags. " +
            "2. The best/largest image URL for this event (must be https://). " +
            "3. Ignore any date or time information — return null for start_date and end_date.",
        },
      });

      if (contentResponse.success && contentResponse.extract) {
        const extracted = contentResponse.extract;

        if (extracted.description) {
          const newDesc = wrapDescription(extracted.description);
          if (newDesc.length > event.description.length) event.description = newDesc;
        }

        if (extracted.image_url) {
          const imageValid = await checkImageUrl(extracted.image_url);
          if (imageValid) {
            event.image_url = extracted.image_url.startsWith("http://")
              ? extracted.image_url.replace("http://", "https://")
              : extracted.image_url;
          }
        }
      }
    }

    return event;
  } catch {
    return event;
  }
}

// ─── Utility: Extract Address From Description ────────────────────────────────

const ADDRESS_TRIGGERS = [
  "located at", "find us at", "venue:", "address:", "join us at",
  "held at", "taking place at", "the event is at", "we are at",
  "our address is", "come to", "visit us at", "you can find us at"
];

const UK_POSTCODE_REGEX = /[A-Z]{1,2}\d{1,2}[A-Z]?\s?\d[A-Z]{2}/i;

function extractAddressFromDescription(description) {
  if (!description) return null;

  const text = description.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  const lowerText = text.toLowerCase();

  for (const trigger of ADDRESS_TRIGGERS) {
    const idx = lowerText.indexOf(trigger);
    if (idx !== -1) {
      const after = text.substring(idx + trigger.length, idx + trigger.length + 120).trim();
      const postcodeMatch = after.match(UK_POSTCODE_REGEX);
      if (postcodeMatch) {
        const postcodeEnd = after.indexOf(postcodeMatch[0]) + postcodeMatch[0].length;
        const address = after.substring(0, postcodeEnd).replace(/^[,\s:]+/, "").trim();
        if (address.length > 5) return address;
      }
    }
  }

  const postcodeMatch = text.match(UK_POSTCODE_REGEX);
  if (postcodeMatch) {
    const postcodeIdx = text.indexOf(postcodeMatch[0]);
    const before = text.substring(Math.max(0, postcodeIdx - 100), postcodeIdx + postcodeMatch[0].length);
    const cleaned = before.replace(/.*[.!?]\s*/s, "").replace(/^[,\s]+/, "").trim();
    if (cleaned.length > 5) return cleaned;
  }

  return null;
}

// ─── Parse Modal Performance Dates from Raw HTML ─────────────────────────────

function parseModalPerformances(rawHtml) {
  const performances = [];

  if (!rawHtml) {
    console.warn("  ⚠️  No rawHtml received for modal parsing");
    return performances;
  }

  console.log(`  🔍 Searching for modal data in HTML (${rawHtml.length} chars)...`);

  const hasModal = rawHtml.includes("instance-modal") || rawHtml.includes("data-modal");
  console.log(`  🔍 Modal data found: ${hasModal}`);

  if (!hasModal) return performances;

  const modalMatches = [...rawHtml.matchAll(/data-modal=["']([^"']+(?:["'][^"']*["'][^"']*)*)["']/g),
                        ...rawHtml.matchAll(/data-modal="([\s\S]*?)(?<!\\)"/g)];

  console.log(`  🔍 Modal attribute matches found: ${modalMatches.length}`);

  for (const modalMatch of modalMatches) {
    const modalHtml = modalMatch[1]
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, "&")
      .replace(/&#039;/g, "'")
      .replace(/\\/g, "");

    const titleMatch = modalHtml.match(/instance-modal__title[^>]*>([\s\S]*?)<\/div>/);
    const titleBlock = titleMatch ? titleMatch[1].replace("Dates and times for ", "") : null;
    if (!titleBlock) continue;

    // Extract show page URL from anchor tag in title block if present
    const titleLinkMatch = titleBlock.match(/href=["']([^"']+)["']/);
    const showUrl = titleLinkMatch ? titleLinkMatch[1].trim() : null;

    const title = titleBlock.replace(/<[^>]*>/g, "").trim();
    if (!title) continue;

    const itemMatches = [...modalHtml.matchAll(
      /instance-modal__date[^>]*>\s*([\s\S]*?)\s*<\/p>[\s\S]*?instance-modal__time[^>]*>\s*([\s\S]*?)\s*<\/time>[\s\S]*?instance-modal__btn[^>]*href="([^"]+)"/g
    )];

    for (const itemMatch of itemMatches) {
      const dateStr = itemMatch[1].replace(/<[^>]*>/g, "").trim();
      const timeStr = itemMatch[2].replace(/<[^>]*>/g, "").trim();
      const bookingUrl = itemMatch[3].trim();

      const dateFormatted = parseDateTimeString(dateStr, timeStr);
      if (dateFormatted) {
        performances.push({ title, show_url: showUrl, start_date: dateFormatted, tickets_url: bookingUrl });
      }
    }
  }

  console.log(`  🎭 Total performances parsed: ${performances.length}`);
  return performances;
}

// ─── Parse Date/Time String from Modal ───────────────────────────────────────

function parseDateTimeString(dateStr, timeStr) {
  try {
    const cleanDate = dateStr.replace(/(\d+)(st|nd|rd|th)/, "$1");
    const combined = `${cleanDate} ${timeStr}`;
    const d = new Date(combined);
    if (isNaN(d.getTime())) return null;

    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
  } catch {
    return null;
  }
}



// ─── Ticketsolve XML Fetcher ──────────────────────────────────────────────────

async function fetchTicketsolveEvents(clientName, hub, urlConfig) {
  const feedUrl = `https://${clientName}.ticketsolve.com/shows.xml`;
  console.log(`  🎟️  Fetching Ticketsolve feed: ${feedUrl}`);

  const res = await fetch(feedUrl);
  if (!res.ok) throw new Error(`Ticketsolve feed returned ${res.status}`);
  const xml = await res.text();

  console.log(`  🎟️  Feed received (${xml.length} chars)`);

  const venueName = urlConfig.default_venue || "Canterbury Festival";
  const results = [];
  const venueCoordCache = {};

  // Helper to decode CDATA content
  const cdata = (str) => {
    if (!str) return "";
    return str.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim();
  };

  // Helper to strip HTML tags
  const stripHtml = (str) => str.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

  // Helper to geocode a venue name
  async function geocodeVenue(name) {
    if (venueCoordCache[name]) return venueCoordCache[name];

    const fallback = {
      latitude: urlConfig.latitude || hub.latitude,
      longitude: urlConfig.longitude || hub.longitude,
      address: `${name}, Canterbury`,
    };

    try {
      const googleKey = process.env.GOOGLE_MAPS_API_KEY || "AIzaSyBvC6abEfjda7JLwTQd8dLfG_H0lMDhnM4";
      const query = encodeURIComponent(`${name}, Canterbury, Kent, UK`);
      const geoRes = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=${query}&key=${googleKey}`);
      const geoData = await geoRes.json();
      if (geoData.status === "OK" && geoData.results.length > 0) {
        const result = {
          latitude: parseFloat(geoData.results[0].geometry.location.lat.toFixed(7)),
          longitude: parseFloat(geoData.results[0].geometry.location.lng.toFixed(7)),
          address: geoData.results[0].formatted_address.replace(", UK", ""),
        };
        venueCoordCache[name] = result;
        console.log(`  📍 Geocoded: ${name} → ${result.address}`);
        return result;
      } else {
        console.warn(`  ⚠️  Google Maps no result for: ${name} (${geoData.status})`);
      }
    } catch (err) {
      console.warn(`  ⚠️  Geocoding failed for ${name}: ${err.message}`);
    }

    // Cache fallback so we don't retry failed venues
    venueCoordCache[name] = fallback;
    console.log(`  📍 Fallback: ${name} → ${fallback.address}`);
    return fallback;
  }

  // Parse venue blocks
  const venueBlocks = [...xml.matchAll(/<venue id="([^"]+)">([\s\S]*?)<\/venue>/g)];
  console.log(`  🎟️  Found ${venueBlocks.length} venue(s) in feed`);

  for (const [, venueId, venueContent] of venueBlocks) {
    // Get venue name
    const venueNameMatch = venueContent.match(/<name>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/name>/);
    const eventVenueName = venueNameMatch ? venueNameMatch[1].trim() : venueName;

    // Parse shows within this venue
    const showBlocks = [...venueContent.matchAll(/<show id="([^"]+)">([\s\S]*?)<\/show>/g)];

    for (const [, showId, showContent] of showBlocks) {
      // Extract show data
      const showName = cdata(showContent.match(/<name>([\s\S]*?)<\/name>/)?.[1] || "");
      const showDesc = cdata(showContent.match(/<description>([\s\S]*?)<\/description>/)?.[1] || "");
      const showCategory = showContent.match(/<event_category>(.*?)<\/event_category>/)?.[1] || "";
      const showStatus = showContent.match(/<status>(.*?)<\/status>/)?.[1] || "";

      // Skip unavailable shows
      if (showStatus && showStatus !== "available") continue;
      if (!showName) continue;

      // Get image URL
      const imageMatch = showContent.match(/<url size="large">(.*?)<\/url>/) || showContent.match(/<url size="medium">(.*?)<\/url>/) || showContent.match(/<url size="thumb">(.*?)<\/url>/);
      const imageUrl = imageMatch ? imageMatch[1].trim() : null;

      // Clean description
      const cleanDesc = stripHtml(showDesc);
      const description = cleanDesc ? `<p>${cleanDesc}</p>` : "<p></p>";

      // Map Ticketsolve category to Loqiva category
      const categoryMap = {
        // Family
        "Family": 5,
        // Music
        "Music": 12,
        "Classical": 12,
        "Jazz": 12,
        "Folk": 12,
        "Choral": 12,
        "World Music": 12,
        "Pop": 12,
        // Theatre & Performance
        "Theatre": 21,
        "Performance": 21,
        "Opera": 21,
        "Circus": 21,
        "Dance": 1,
        "Ballet": 1,
        // Comedy
        "Comedy": 3,
        "Cabaret": 17,
        // Literature & Books
        "Literature": 13,
        "Books & Ideas": 13,
        "Books and Ideas": 13,
        "Literary": 13,
        "Poetry": 13,
        // Talks
        "Talks": 19,
        "Talk": 19,
        "Lecture": 19,
        "Panel": 19,
        // Outdoors & Walks
        "Walks": 20,
        "Walk": 20,
        "Outdoors": 20,
        "Nature": 20,
        // Exhibition & Visual Arts
        "Exhibition": 14,
        "Visual Arts": 14,
        "Art": 14,
        // Film
        "Film": 7,
        "Cinema": 7,
        "Screening": 7,
        // Science
        "Science": 25,
        "STEM": 25,
        // Community
        "Community": 2,
        // Workshops & Education
        "Workshops": 4,
        "Workshop": 4,
        "Education": 4,
        // Festival
        "Festival": 6,
        // Food & Drink
        "Food": 8,
        "Food & Drink": 8,
        // Charity & Fundraising
        "Charity": 9,
        "Fundraising": 9,
        // Religion & Spirituality
        "Religion": 26,
        "Spiritual": 26,
        "Church": 26,
      };

      // Try category from feed first, then classify from title/description
      let category = categoryMap[showCategory] || null;
      if (!category) {
        const classification = classifyEvent(showName, cleanDesc);
        category = classification.id;
      }

      // Parse individual events
      const eventBlocks = [...showContent.matchAll(/<event id="([^"]+)">([\s\S]*?)<\/event>/g)];

      for (const [, eventId, eventContent] of eventBlocks) {
        const eventStatus = eventContent.match(/<status>(.*?)<\/status>/)?.[1] || "";
        if (eventStatus && eventStatus !== "available") continue;

        const dateTimeIso = eventContent.match(/<date_time_iso[^>]*>(.*?)<\/date_time_iso>/)?.[1] || "";
        if (!dateTimeIso) continue;

        const ticketsUrl = cdata(eventContent.match(/<url>([\s\S]*?)<\/url>/)?.[1] || "");

        // Parse ISO date to our format
        const startDate = dateTimeIso.substring(0, 19).replace("T", " ");

        // Geocode venue
        const coords = await geocodeVenue(eventVenueName);

        const eventObj = {
          id: generateEventId(showName, startDate, eventVenueName),
          title: showName,
          description,
          address: coords.address,
          longitude: coords.longitude,
          latitude: coords.latitude,
          venue_name: eventVenueName,
          image_url: imageUrl,
          tickets_url: ticketsUrl,
          url: ticketsUrl,
          start_date: startDate,
          end_date: null,
          category,
          _classification: `Ticketsolve: ${showCategory || "uncategorised"} → cat:${category}`,
        };

        results.push(ensureEndDate(eventObj));
      }
    }
  }

  console.log(`  🎟️  Built ${results.length} event(s) from Ticketsolve`);
  return results;
}

// ─── Spektrix API Fetcher ─────────────────────────────────────────────────────


async function fetchSkiddleEvents(venueId, hub, urlConfig) {
  const SKIDDLE_API_KEY = "2c23d4e16f68197e8f62437d73499f45";
  const results = [];
  let offset = 0;
  const limit = 100;
  let totalcount = null;

  const skiddleCategoryMap = {
    "CLUB": 11, "LIVE": 12, "COMEDY": 3, "THEATRE": 21,
    "FEST": 6, "KIDS": 5, "EXHIB": 14, "BARPUB": 11,
    "DATE": 11, "LGB": 11, "SPORT": 22,
  };

  console.log(`  🎫 Fetching Skiddle API for venue ${venueId}...`);

  do {
    const url = `https://www.skiddle.com/api/v1/events/search/?api_key=${SKIDDLE_API_KEY}&venueid=${venueId}&description=1&limit=${limit}&offset=${offset}`;
    const res = await fetch(url);
    const data = await res.json();

    if (data.error) {
      console.warn(`  ⚠️  Skiddle API error: ${data.errormessage}`);
      break;
    }

    if (totalcount === null) {
      totalcount = parseInt(data.totalcount);
      console.log(`  🎫 ${totalcount} event(s) found on Skiddle`);
    }

    for (const event of data.results) {
      if (event.cancelled === "1") continue;

      const startDate = event.startdate
        ? event.startdate.replace("T", " ").substring(0, 19)
        : event.date + " 00:00:00";
      const endDate = event.enddate
        ? event.enddate.replace("T", " ").substring(0, 19)
        : null;

      const category = skiddleCategoryMap[event.EventCode] || 11;
      const description = event.description
        ? `<p>${event.description.trim()}</p>`
        : "<p></p>";

      const eventObj = {
        id: generateEventId(event.eventname + startDate, startDate, urlConfig.default_venue || hub.name),
        title: event.eventname,
        description,
        address: urlConfig.default_address || `${event.venue.address}, ${event.venue.town}, ${event.venue.postcode}`,
        longitude: urlConfig.longitude || event.venue.longitude,
        latitude: urlConfig.latitude || event.venue.latitude,
        venue_name: urlConfig.default_venue || event.venue.name,
        image_url: event.largeimageurl || event.imageurl || null,
        tickets_url: event.link,
        url: event.link,
        start_date: startDate,
        end_date: endDate,
        category,
        _classification: `Skiddle: ${event.EventCode}`,
      };

      results.push(ensureEndDate(eventObj));
    }

    offset += limit;
  } while (offset < totalcount);

  console.log(`  🎫 Built ${results.length} Skiddle event(s)`);
  return results;
}

async function fetchSpektrixEvents(clientName, hub, urlConfig, showPageCache, events) {
  console.log(`  🎫 Building ${events.length} show(s) into performances...`);

  // Filter out events with 404/error descriptions
  const BAD_DESCRIPTION_PHRASES = [
    "we couldn't find that page",
    "404 error",
    "page not found",
    "nothing was found",
    "timed out",
    "cloudflare",
  ];

  const venueName = urlConfig.default_venue || "Unknown Venue";
  const address = urlConfig.default_address || null;
  const results = [];

  // Filter out merchandise/non-show events (ice cream, programmes etc.)
  const NON_EVENT_KEYWORDS = ["ice cream", "programme", "merchandise", "donation", "gift voucher", "membership", "parking", "interval"];
  const filteredEvents = events.filter(event => {
    const nameLower = event.name.toLowerCase();
    return !NON_EVENT_KEYWORDS.some(kw => nameLower.includes(kw));
  });

  // Venue filter for multi-venue Spektrix accounts (e.g. Tolbooth vs Albert Halls)
  const venueFilter = urlConfig.spektrix_venue_filter || null;
  const venueFilterAttr = urlConfig.spektrix_venue_filter_attr || 'TicketVenue';

  for (const event of filteredEvents) {
    if (!event.instances || event.instances.length === 0) continue;

    // Filter by venue attribute if specified
    if (venueFilter) {
      const attrValue = (event[`attribute_${venueFilterAttr}`] || "").toUpperCase();
      if (!attrValue.includes(venueFilter.toUpperCase())) continue;
    }

    // Use htmlDescription if available (rich HTML from Spektrix)
    let description = "<p></p>";
    const cached = showPageCache[event.name] || showPageCache[event.name.toLowerCase()] || null;
    if (cached?.description && cached.description !== "<p></p>") {
      description = cached.description;
    } else if (event.htmlDescription) {
      // Clean up Spektrix htmlDescription
      const cleaned = event.htmlDescription
        .replace(/<div[^>]*>/gi, "").replace(/<\/div>/gi, "")
        .replace(/<span>/gi, "").replace(/<\/span>/gi, "")
        .replace(/<br\/>/gi, " ").replace(/<br>/gi, " ")
        .replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&ldquo;/g, '"').replace(/&rdquo;/g, '"')
        .replace(/&rsquo;/g, "'").replace(/&lsquo;/g, "'").replace(/&ndash;/g, "–").replace(/&apos;/g, "'")
        .replace(/\s+/g, " ").trim();
      if (cleaned.length > 20) description = `<p>${cleaned}</p>`;
    }

    // Use Spektrix image, fall back to show page cache image
    const spektrixImage = (event.imageUrl && event.imageUrl.startsWith("https://")) ? event.imageUrl : null;
    const cachedImage = cached?.image_url && cached.image_url.startsWith("https://") ? cached.image_url : null;
    const imageUrl = spektrixImage || cachedImage || null;
    // Construct show URL — use event ID if spektrix_use_id_url is set, otherwise use cached URL
    const showUrl = (urlConfig.spektrix_use_id_url && event.id)
      ? `${new URL(urlConfig.url).origin}/shows/${event.id}`
      : cached?.url || urlConfig.url;

    // Use plain text description field if htmlDescription was empty
    if ((!description || description === "<p></p>") && event.description && event.description.trim().length > 20) {
      description = `<p>${event.description.trim()}</p>`;
    }

    // Use attribute_ShortDescription if description is still empty
    if ((!description || description === "<p></p>") && event.attribute_ShortDescription) {
      description = `<p>${event.attribute_ShortDescription.trim()}</p>`;
    }

    // Use attribute_EventType for classification if available
    const eventType = event.attribute_EventType || event.attribute_EventTypeV2 || event.attribute_EventTagV2 || "";
    const eventTypeMap = {
      "Film": 7, "Cinema": 7, "Theatre": 21, "Music": 12, "Comedy": 3,
      "Dance": 1, "Family": 5, "Talk": 19, "Workshop": 4, "Exhibition": 14,
      "Classical": 12, "Folk": 12, "Jazz": 12, "Opera": 21,
    };

    // Use attribute_EventType for classification
    let category = eventTypeMap[eventType] || null;
    const spektrixCategoryMap = {
      "CategoryComedy": 3, "CategoryClassical": 12, "CategoryFolk": 12,
      "CategoryRockPop": 12, "CategoryJazz": 12, "CategoryTrad": 12,
      "CategoryTheatre": 21, "CategoryMusical": 21, "CategoryVariety": 21,
      "CategoryFamily": 5, "CategoryFilm": 7, "CategoryTalk": 19,
      "CategoryWorkshop": 4, "CategoryElectronic": 12, "CategoryExhibitions": 14,
      "CategoryFestivals": 6, "CategoryBloodyScotland": 13,
    };
    for (const [attr, catId] of Object.entries(spektrixCategoryMap)) {
      if (event[`attribute_${attr}`] === true) { category = catId; break; }
    }

    // Fall back to keyword classifier
    const cleanDesc = description.replace(/<[^>]*>/g, " ").trim();
    if (!category) {
      const classification = classifyEvent(event.name, cleanDesc);
      category = classification.id;
    }
    const classification = { id: category, name: "Spektrix", score: 10 };

    // Sort instances by start date and cap at 5 per show
    const sortedInstances = event.instances
      .filter(i => i.start && i.isOnSale === true)
      .sort((a, b) => new Date(a.start) - new Date(b.start))

    for (const instance of sortedInstances) {
      const startDate = instance.start.replace("T", " ").substring(0, 19);
      const instanceEndDate = instance.end ? instance.end.replace("T", " ").substring(0, 19) : null;
      // Use show page URL for tickets — Spektrix booking URL not publicly accessible
      const ticketsUrl = showUrl || cached?.url || urlConfig.url;

      // Use full datetime in ID so same-day performances aren't deduplicated
      const eventObj = {
        id: generateEventId(event.name + startDate, startDate, venueName),
        title: event.name,
        description,
        address,
        longitude: urlConfig.longitude || hub.longitude,
        latitude: urlConfig.latitude || hub.latitude,
        venue_name: venueName,
        image_url: imageUrl,
        tickets_url: ticketsUrl,
        url: showUrl,
        start_date: startDate,
        end_date: instanceEndDate,
        category: category,
        _classification: `Spektrix: cat ${category}`,
        _spektrix_show_id: event.id,
      };

      results.push(ensureEndDate(eventObj));
    }
  }

  console.log(`  🎫 Built ${results.length} individual performance(s) from Spektrix`);
  return results;
}

// ─── ChurchSuite Public Calendar Feed ────────────────────────────────────────

async function fetchChurchSuiteEvents(clientName, hub, urlConfig) {
  const feedUrl = `https://${clientName}.churchsuite.com/embed/calendar/json`;
  console.log(`  ⛪ Fetching ChurchSuite feed: ${feedUrl}`);

  const res = await fetch(feedUrl);
  if (!res.ok) throw new Error(`ChurchSuite API returned ${res.status}`);
  const data = await res.json();

  // data may be { events: [...] } or an array directly
  const rawEvents = Array.isArray(data) ? data : (data.events || []);

  const venueName = urlConfig.default_venue || "Unknown Venue";
  const address = urlConfig.default_address || null;

  // Categories to exclude — only if explicitly set in hubs.json
  const excludeCategories = urlConfig.churchsuite_exclude_categories || [];
  // Keywords in title to exclude — only if explicitly set in hubs.json (no defaults)
  const excludeTitleKeywords = urlConfig.churchsuite_exclude_title_keywords || [];

  const results = [];

  for (const event of rawEvents) {
    // Skip if category is excluded
    if (excludeCategories.length > 0 && event.category?.name) {
      if (excludeCategories.some(c => event.category.name.toLowerCase().includes(c.toLowerCase()))) {
        continue;
      }
    }

    // Skip by title keywords
    const titleLower = (event.name || "").toLowerCase();
    if (excludeTitleKeywords.some(kw => titleLower.includes(kw))) continue;

    // Skip events with no start date
    if (!event.datetime_start) continue;

    // Parse dates — ChurchSuite format: "2026-09-23 10:00:00"
    const startDate = event.datetime_start.substring(0, 19);
    const endDate = event.datetime_end ? event.datetime_end.substring(0, 19) : null;

    // Skip past events
    if (new Date(startDate) < new Date()) continue;

    // Description — already HTML with <p> tags in ChurchSuite
    let description = "<p></p>";
    if (event.description && event.description.trim().length > 10) {
      description = event.description.trim();
      // Wrap in <p> if not already wrapped
      if (!description.startsWith("<")) description = `<p>${description}</p>`;
    }

    // Image — prefer md (512px) over sm
    const imageUrl = event.images?.md?.url || event.images?.sm?.url || urlConfig.default_image || null;

    // Location — use event location if available, fall back to urlConfig
    const eventLat = event.location?.latitude ? parseFloat(event.location.latitude) : null;
    const eventLng = event.location?.longitude ? parseFloat(event.location.longitude) : null;
    const latitude = (eventLat && !isNaN(eventLat)) ? eventLat : (urlConfig.latitude || hub.latitude);
    const longitude = (eventLng && !isNaN(eventLng)) ? eventLng : (urlConfig.longitude || hub.longitude);

    const eventVenueName = event.location?.name || venueName;
    const eventAddress = event.location?.address
      ? `${event.location.name ? event.location.name + ", " : ""}${event.location.address}`
      : address;

    // Tickets URL
    const ticketsUrl = event.signup_options?.tickets?.url || urlConfig.url;
    const eventUrl = event.signup_options?.tickets?.url || urlConfig.url;

    // Category classification
    const cleanDesc = description.replace(/<[^>]*>/g, " ").trim();
    const classification = classifyEvent(event.name, cleanDesc);

    const eventObj = {
      id: generateEventId(event.name + startDate, startDate, eventVenueName),
      title: event.name,
      description,
      address: eventAddress,
      longitude,
      latitude,
      venue_name: eventVenueName,
      image_url: imageUrl,
      tickets_url: ticketsUrl,
      url: eventUrl,
      start_date: startDate,
      end_date: endDate,
      category: classification.id,
      _classification: `ChurchSuite: ${classification.name}`,
    };

    results.push(ensureEndDate(eventObj));
  }

  console.log(`  ⛪ Built ${results.length} ChurchSuite event(s) (from ${rawEvents.length} total)`);
  return results;
}

// ─── Momence Public Schedule API ─────────────────────────────────────────────

async function fetchMomenceEvents(hostId, hub, urlConfig) {
  const TZ = "Europe/London";
  const SESSION_TYPES = [
    "course-class", "fitness", "retreat",
    "special-event", "special-event-new",
  ];
  const PAGE_SIZE = 50;

  const venueName = urlConfig.default_venue || "Unknown Venue";
  const address   = urlConfig.default_address || null;
  const latitude  = urlConfig.latitude || hub.latitude;
  const longitude = urlConfig.longitude || hub.longitude;

  const results = [];
  let page = 0;
  let totalFetched = 0;

  console.log(`  🧘 Fetching Momence schedule for hostId=${hostId}`);

  while (true) {
    const fromDate = new Date().toISOString(); // always from now
    const params = new URLSearchParams();
    SESSION_TYPES.forEach(t => params.append("sessionTypes[]", t));
    params.set("fromDate", fromDate);
    params.set("pageSize", String(PAGE_SIZE));
    params.set("page", String(page));
    params.set("timeZone", TZ);

    const apiUrl = `https://readonly-api.momence.com/host-plugins/host/${hostId}/host-schedule/sessions?${params}`;
    const res = await fetch(apiUrl);
    if (!res.ok) throw new Error(`Momence API returned ${res.status}`);
    const data = await res.json();

    const sessions = data.payload || [];
    totalFetched += sessions.length;

    for (const session of sessions) {
      // Skip virtual / online sessions
      if (!session.inPerson) continue;
      // Skip cancelled sessions
      if (session.isCancelled) continue;

      // Convert UTC ISO strings to Europe/London local time strings
      // Format needed: "YYYY-MM-DD HH:MM:SS"
      const toLocalStr = (isoUtc) => {
        if (!isoUtc) return null;
        const dt = new Date(isoUtc);
        // Use Intl to get parts in the target TZ
        const parts = new Intl.DateTimeFormat("en-GB", {
          timeZone: TZ,
          year: "numeric", month: "2-digit", day: "2-digit",
          hour: "2-digit", minute: "2-digit", second: "2-digit",
          hour12: false,
        }).formatToParts(dt);
        const p = {};
        parts.forEach(({ type, value }) => { p[type] = value; });
        return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
      };

      const startDate = toLocalStr(session.startsAt);
      const endDate   = toLocalStr(session.endsAt);
      if (!startDate) continue;

      // Description — level field is plain text, wrap in <p>
      let description = "<p></p>";
      if (session.level && session.level.trim().length > 0) {
        // Replace newlines with </p><p> for multi-paragraph
        const cleaned = session.level.trim().replace(/\n+/g, "</p><p>");
        description = `<p>${cleaned}</p>`;
      }

      // Image: prefer session image, fall back to teacher picture
      const imageUrl = session.image || session.teacherPicture || urlConfig.default_image || null;

      // Link: use session.link if present, otherwise construct from id
      const eventLink = session.link || `https://momence.com/s/${session.id}`;

      // Venue — use session location string if available
      const eventVenueName = session.location || venueName;

      const classification = classifyEvent(session.sessionName, description.replace(/<[^>]*>/g, " "));

      const eventObj = {
        id: generateEventId(session.sessionName, startDate, eventVenueName),
        title: session.sessionName,
        description,
        address,
        longitude,
        latitude,
        venue_name: eventVenueName,
        image_url: imageUrl,
        tickets_url: eventLink,
        url: eventLink,
        start_date: startDate,
        end_date: endDate,
        category: classification.id,
        _classification: `Momence: ${classification.name}`,
      };

      results.push(ensureEndDate(eventObj));
    }

    // Stop if we got fewer than a full page (no more pages)
    if (sessions.length < PAGE_SIZE) break;
    page++;
  }

  console.log(`  🧘 Built ${results.length} Momence event(s) (fetched ${totalFetched} total, skipping virtual/cancelled)`);
  return results;
}

// ─── Places Leisure / Gladstone Go Timetable (hidden HTML input) ─────────────

async function fetchPlacesLeisureEvents(pageUrl, hub, urlConfig) {
  const TZ = "Europe/London";

  // Activity group code → readable title (null = exclude)
  const AG_TITLES = {
    SWIMLANE:       null,          // Lane swim — exclude
    AQUA:           "Aqua Aerobics",
    SWIM:           "Swimming Lessons",
    SWIMFAMILY:     "Family Swim",
    SWIMDISABILITY: "Disability Swimming",
    SWIMLADIES:     "Ladies Swim",
    GROUP:          "Fitness Class",
    GROUPVIRTUAL:   null,          // Virtual — exclude
    TABLETENNIS:    "Table Tennis",
    ACTIVATE:       "Activate",
    FOCUS:          "Focus",
    GYMJNR:         "Junior Gym",
    GYMJNRINTRO:    "Junior Gym Introduction",
  };

  const venueName = urlConfig.default_venue || hub.default_venue || "Unknown Venue";
  const address   = urlConfig.default_address || hub.default_address || null;
  const latitude  = urlConfig.latitude || hub.latitude;
  const longitude = urlConfig.longitude || hub.longitude;
  const timetableIds = urlConfig.places_leisure_timetable_ids || [];
  const maxPerDay = urlConfig.max_per_day || null;
  const excludeKeywords = urlConfig.exclude_title_keywords || [];
  const classDescriptions = urlConfig.class_descriptions || {};

  console.log(`  🏊 Fetching Places Leisure timetable from: ${pageUrl}`);

  // Fetch the static HTML page
  const res = await fetch(pageUrl, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; EventScraper/1.0)" }
  });
  if (!res.ok) throw new Error(`Places Leisure page returned ${res.status}`);
  const html = await res.text();

  // Extract the hidden timetable-data input value
  const match = html.match(/<input[^>]+id=["']timetable-data["'][^>]+value=["']([^"']+)["']/i)
    || html.match(/<input[^>]+value=["']([^"']+)["'][^>]+id=["']timetable-data["']/i);
  if (!match) throw new Error("Could not find #timetable-data input in page HTML");

  // Decode HTML entities and parse JSON
  const rawJson = match[1]
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/');

  let timetableData;
  try {
    timetableData = JSON.parse(rawJson);
  } catch (e) {
    throw new Error(`Failed to parse timetable JSON: ${e.message}`);
  }

  // timetableData is an array of timetable objects, each with a .sessions array
  const timetables = Array.isArray(timetableData) ? timetableData : [timetableData];
  console.log(`  🏊 Found ${timetables.length} timetable(s) in page`);

  const toLocalStr = (utcMs) => {
    const dt = new Date(utcMs);
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: TZ,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hour12: false,
    }).formatToParts(dt);
    const p = {};
    parts.forEach(({ type, value }) => { p[type] = value; });
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
  };

  const results = [];
  const countPerDay = {};

  for (const timetable of timetables) {
    // Filter to requested timetable IDs (if specified)
    if (timetableIds.length > 0 && !timetableIds.includes(timetable.id)) continue;

    const sessions = timetable.sessions || [];
    console.log(`  🏊 Timetable ${timetable.id} (${timetable.name || ''}): ${sessions.length} session(s)`);

    for (const session of sessions) {
      // s and e are UTC millisecond timestamps
      const startMs = session.s;
      const endMs   = session.e;
      if (!startMs) continue;

      // Skip past events
      if (startMs < Date.now()) continue;

      const ag = session.ag || "";
      // Skip excluded activity groups
      if (AG_TITLES[ag] === null) continue;

      const title = AG_TITLES[ag] || ag;

      // Apply exclude_title_keywords
      if (excludeKeywords.some(kw => title.toLowerCase().includes(kw.toLowerCase()))) continue;

      const startDate = toLocalStr(startMs);
      const endDate   = endMs ? toLocalStr(endMs) : null;

      // Apply max_per_day
      if (maxPerDay) {
        const dayKey = startDate.slice(0, 10);
        countPerDay[dayKey] = (countPerDay[dayKey] || 0);
        if (countPerDay[dayKey] >= maxPerDay) continue;
        countPerDay[dayKey]++;
      }

      // Description from class_descriptions lookup, or empty
      const descText = classDescriptions[title] || "";
      const description = descText ? `<p>${descText}</p>` : "<p></p>";

      const classification = classifyEvent(title, descText);

      const eventObj = {
        id: generateEventId(title, startDate, venueName),
        title,
        description,
        address,
        longitude,
        latitude,
        venue_name: venueName,
        image_url: urlConfig.default_image || null,
        tickets_url: pageUrl,
        url: pageUrl,
        start_date: startDate,
        end_date: endDate || addMinutesToDate(startDate, 60),
        category: classification.id,
        _classification: `PlacesLeisure: ${classification.name}`,
      };

      results.push(eventObj);
    }
  }

  // Sort by start_date
  results.sort((a, b) => a.start_date.localeCompare(b.start_date));

  console.log(`  🏊 Built ${results.length} Places Leisure event(s)`);
  return results;
}

// ─── Scrape a Single Listing URL ─────────────────────────────────────────────

async function scrapeUrl(url, hub, retries = 2) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      let modalPerformances = [];
      if (hub.expand_dates) {
        console.log(`  🔍 Fetching raw HTML for modal date parsing...`);
        try {
          const htmlResponse = await firecrawl.scrapeUrl(url, {
            timeout: 120000,
            waitFor: hub.wait_for || 8000,
            formats: ["rawHtml"],
          });
          if (htmlResponse.success && htmlResponse.rawHtml) {
            console.log(`  🔍 Raw HTML received (${htmlResponse.rawHtml.length} chars)`);
            modalPerformances = parseModalPerformances(htmlResponse.rawHtml);
          } else {
            console.warn(`  ⚠️  No rawHtml returned`);
          }
        } catch (err) {
          console.warn(`  ⚠️  Failed to fetch rawHtml: ${err.message}`);
        }
      }

      const firecrawlOptions = {
        timeout: 120000,
        waitFor: hub.wait_for || 5000,
        formats: ["extract"],
        extract: {
          schema: LISTING_SCHEMA,
          systemPrompt:
            "You are an expert event data extractor. Extract all upcoming events from this page. " +
            "Always wrap descriptions in <p> tags. " +
            "Return dates in YYYY-MM-DD HH:MM:SS format. " +
            "Only include events with a valid title and start date.",
        },
      };

      // Add scroll/click actions if configured
      if (hub.firecrawl_actions && hub.firecrawl_actions.length > 0) {
        firecrawlOptions.actions = hub.firecrawl_actions;
        console.log(`  🖱️  Applying ${hub.firecrawl_actions.length} Firecrawl action(s) before scrape`);
      }

      const response = await firecrawl.scrapeUrl(url, firecrawlOptions);

      if (!response.success || !response.extract?.events) {
        throw new Error(`No events extracted from ${url}`);
      }

      const events = await Promise.all(response.extract.events.map(async (event) => {
        const urlDateFromTickets = extractDateFromUrl(event.tickets_url);
        const urlDateFromUrl = extractDateFromUrl(event.url);
        const startDate = (() => {
          const raw = urlDateFromTickets || urlDateFromUrl || formatDate(event.start_date);
          if (raw && raw.endsWith("00:00:00")) return raw.replace("00:00:00", "12:00:00");
          return raw;
        })();

        const venueName = hub.default_venue
          ? hub.default_venue
          : (event.venue_name && event.venue_name !== "Unknown Venue" && event.venue_name !== "Not specified")
            ? event.venue_name
            : "Unknown Venue";

        const imageValid = await checkImageUrl(event.image_url);
        const imageUrl = imageValid
          ? (event.image_url.startsWith("http://")
            ? event.image_url.replace("http://", "https://")
            : event.image_url)
          : null;

        const classification = classifyEvent(event.title, event.description || "");

        return {
          id: generateEventId(event.title, startDate, venueName),
          title: event.title,
          description: wrapDescription(event.description),
          address: event.address && event.address !== "N/A" && event.address !== "Not specified" && event.address !== "TBA" && event.address !== "Not Available"
            ? event.address
            : extractAddressFromDescription(event.description) || hub.default_address || null,
          longitude: event.longitude ?? hub.longitude,
          latitude: event.latitude ?? hub.latitude,
          venue_name: venueName,
          image_url: imageUrl,
          tickets_url: event.tickets_url || event.url || null,
          url: event.url || url,
          start_date: startDate,
          end_date: (urlDateFromTickets || urlDateFromUrl)
            ? startDate.replace("19:00:00", "23:30:00")
            : (event.end_date ? formatDate(event.end_date) : null),
          category: classification.id,
          _classification: `${classification.name} (score: ${classification.score})`,
        };
      }));

      // ── Expand events using modal performance data ──────────────────────────
      let expandedEvents = [...events];

      if (hub.expand_dates && modalPerformances.length > 0) {
        expandedEvents = [];

        for (const event of events) {
          const runStart = event.start_date ? new Date(event.start_date.replace(" ", "T")) : null;
          const runEnd = event.end_date ? new Date(event.end_date.replace(" ", "T")) : null;

          const matchingPerfs = modalPerformances.filter(p => {
            if (p.title.toLowerCase() !== event.title.toLowerCase()) return false;
            if (runStart && runEnd) {
              const perfDate = new Date(p.start_date.replace(" ", "T"));
              if (perfDate < runStart || perfDate > runEnd) return false;
            }
            return true;
          });

          if (matchingPerfs.length > 0) {
            for (const perf of matchingPerfs) {
              const perfId = generateEventId(event.title, perf.start_date, event.venue_name);
              expandedEvents.push(ensureEndDate({
                ...event,
                id: perfId,
                start_date: perf.start_date,
                end_date: null,
                tickets_url: perf.tickets_url || event.tickets_url,
              }));
            }
          } else {
            expandedEvents.push(ensureEndDate({ ...event, _needsDeepScrape: true }));
          }
        }

        console.log(`  🎭 Expanded ${events.length} events → ${expandedEvents.length} individual performances`);

        // ── Scrape each unique show page once for description + category ────
        console.log(`
📖 Scraping ${events.length} show page(s) for descriptions...
`);

        const showPageLimit = pLimit(3);
        const showPageCache = {};

        await Promise.all(
          events.map(event =>
            showPageLimit(async () => {
              const showUrl = event.url;
              if (!showUrl || showPageCache[showUrl] !== undefined) return;

              try {
                const res = await firecrawl.scrapeUrl(showUrl, {
                  timeout: 120000,
                  waitFor: 8000,
                  formats: ["extract"],
                  extract: {
                    schema: EVENT_PAGE_SCHEMA,
                    systemPrompt:
                      "You are an expert event copywriter. From this event page extract ONLY the marketing description — " +
                      "the paragraphs that describe the story, performers, atmosphere and what makes the show worth seeing. " +
                      "STOP extracting as soon as you encounter any of the following: ticket prices, running times, booking instructions, " +
                      "accessibility information, discounts, loyalty schemes, group rates, meal options, seating details, " +
                      "terms and conditions, or calls to action like 'Book now' or 'Find out more'. " +
                      "Do NOT include section headers such as 'Overview', 'Show information', 'Discounts & Offers'. " +
                      "Wrap the description in <p> tags. " +
                      "Also extract the best/largest image URL for this event (must be https://). " +
                      "Return null for start_date and end_date.",
                  },
                });

                if (res.success && res.extract) {
                  showPageCache[showUrl] = {
                    description: res.extract.description || null,
                    image_url: res.extract.image_url || null,
                  };
                  console.log(`  ✅ Got description for: ${event.title.substring(0, 50)}`);
                } else {
                  showPageCache[showUrl] = null;
                }
              } catch {
                showPageCache[showUrl] = null;
              }
            })
          )
        );

        // Apply descriptions and reclassify
        expandedEvents = expandedEvents.map(event => {
          const cached = showPageCache[event.url];
          if (!cached) return event;

          const description = cached.description
            ? wrapDescription(cached.description)
            : event.description;

          const imageUrl = cached.image_url
            ? (cached.image_url.startsWith("http://")
              ? cached.image_url.replace("http://", "https://")
              : cached.image_url)
            : event.image_url;

          const classification = classifyEvent(event.title, description || "");

          return {
            ...event,
            description,
            image_url: imageUrl || event.image_url,
            category: classification.id,
            _classification: `${classification.name} (score: ${classification.score})`,
          };
        });

        // Print category breakdown
        const cats = {};
        expandedEvents.forEach(e => {
          const name = e._classification?.split(" (")[0] || "Other";
          cats[name] = (cats[name] || 0) + 1;
        });
        console.log(`
📋 Category breakdown after show page scrape:`);
        Object.entries(cats).sort((a, b) => b[1] - a[1]).forEach(([name, count]) => {
          console.log(`   ${name}: ${count}`);
        });
        console.log();

        // ── Targeted deep scrape for no-modal events ────────────────────────
        const noModalEvents = expandedEvents.filter(e => e._needsDeepScrape);
        if (noModalEvents.length > 0) {
          console.log(`
🔍 Deep scraping ${noModalEvents.length} single-date show(s) for accurate times...
`);
          const deepLimit = pLimit(3);

          await Promise.all(
            noModalEvents.map(event =>
              deepLimit(async () => {
                try {
                  const res = await firecrawl.scrapeUrl(event.url, {
                    timeout: 120000,
                    waitFor: 8000,
                    formats: ["extract"],
                    extract: {
                      schema: EVENT_PAGE_SCHEMA,
                      systemPrompt:
                        "You are an expert event data extractor. From this event page extract: " +
                        "1. The start date AND time in YYYY-MM-DD HH:MM:SS format. Look carefully for the show time. " +
                        "2. The end date AND time in YYYY-MM-DD HH:MM:SS format. " +
                        "3. Return null for description and image_url.",
                    },
                  });

                  if (res.success && res.extract?.start_date) {
                    const formatted = formatDate(res.extract.start_date);
                    if (formatted && !formatted.endsWith("12:00:00")) {
                      const idx = expandedEvents.findIndex(e => e.id === event.id);
                      if (idx !== -1) {
                        expandedEvents[idx] = ensureEndDate({
                          ...expandedEvents[idx],
                          start_date: formatted,
                          end_date: res.extract.end_date ? formatDate(res.extract.end_date) : null,
                          _needsDeepScrape: undefined,
                        });
                        console.log(`  ✅ Got time for: ${event.title.substring(0, 50)} → ${formatted}`);
                      }
                    }
                  }
                } catch (err) {
                  console.warn(`  ⚠️  Deep scrape failed for ${event.title}: ${err.message}`);
                }

                const idx = expandedEvents.findIndex(e => e.id === event.id);
                if (idx !== -1) delete expandedEvents[idx]._needsDeepScrape;
              })
            )
          );
        }

        expandedEvents = expandedEvents.map(({ _needsDeepScrape, ...e }) => e);

      } else {
        expandedEvents = events.map(ensureEndDate);
      }

      const validEvents = (argv.deep || hub.default_image)
        ? expandedEvents
        : expandedEvents.filter(e => {
            if (!e.image_url) {
              console.warn(`     ⚠️  Skipped (broken image): ${e.title.substring(0, 50)}`);
              return false;
            }
            return true;
          });

      return validEvents;

    } catch (err) {
      if (attempt < retries) {
        console.warn(`     ⚠️  Attempt ${attempt} failed, retrying in 5s...`);
        await sleep(5000);
      } else {
        throw err;
      }
    }
  }
}


// ─── Save Events to JSON File ─────────────────────────────────────────────

function saveToFile(events, hubName, deep) {
  const outputDir = path.join(__dirname, "output");
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);
  const safeName = hubName.toLowerCase().replace(/\s+/g, "-");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const suffix = deep ? "_deep" : "";
  const filename = `${safeName}${suffix}_${timestamp}.json`;
  const filepath = path.join(outputDir, filename);

  const cleanEvents = events.map(({ _classification, _expandedPerformances, ...event }) => event);
  fs.writeFileSync(filepath, JSON.stringify(cleanEvents, null, 2), "utf-8");
  return filepath;
}

// ─── Seen IDs System ─────────────────────────────────────────────────────────

function getSeenIdsPath(filename) {
  const seenDir = path.join(__dirname, "seen_ids");
  if (!fs.existsSync(seenDir)) fs.mkdirSync(seenDir);
  return path.join(seenDir, filename);
}

function loadSeenIds(filename) {
  const filepath = getSeenIdsPath(filename);
  if (!fs.existsSync(filepath)) return new Set();
  try {
    const data = JSON.parse(fs.readFileSync(filepath, "utf-8"));
    return new Set(data);
  } catch {
    return new Set();
  }
}

function saveSeenIds(filename, ids) {
  const filepath = getSeenIdsPath(filename);
  fs.writeFileSync(filepath, JSON.stringify([...ids], null, 2), "utf-8");
}

// ─── Generate Filename from Hub + URL ────────────────────────────────────────

function generateFilename(hubName, url, venueName) {
  const hubSlug = hubName.toLowerCase().replace(/\s+/g, "-");
  if (venueName) {
    const venueSlug = venueName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    return `${hubSlug}-${venueSlug}.json`;
  }
  try {
    const domain = new URL(url).hostname
      .replace(/^www\./, "")
      .replace(/\./g, "-")
      .replace(/[^a-z0-9-]/gi, "");
    return `${hubSlug}-${domain}.json`;
  } catch {
    return `${hubSlug}-unknown.json`;
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const errors = [];
  const venueLog = [];
  const runStart = Date.now();

  let urlsToProcess = hub.urls;
  if (argv.url) {
    urlsToProcess = hub.urls.filter(entry => {
      const urlString = typeof entry === "string" ? entry : entry.url;
      return urlString === argv.url;
    });
    if (urlsToProcess.length === 0) {
      console.error(`❌ ERROR: URL "${argv.url}" not found in hub "${hub.name}".`);
      console.error(`\nAvailable URLs for ${hub.name}:`);
      hub.urls.forEach(entry => {
        const urlString = typeof entry === "string" ? entry : entry.url;
        console.error(`  • ${urlString}`);
      });
      process.exit(1);
    }
  }

  console.log(`⏳ Processing ${urlsToProcess.length} URL(s) for "${hub.name}"...\n`);

  for (let i = 0; i < urlsToProcess.length; i++) {
    const urlEntry = urlsToProcess[i];
    const urlString = typeof urlEntry === "string" ? urlEntry : urlEntry.url;
    const urlConfig = typeof urlEntry === "object" ? urlEntry : {};

    const urlHub = {
      ...hub,
      default_venue: urlConfig.default_venue || hub.default_venue || null,
      default_address: urlConfig.default_address || hub.default_address || null,
      default_image: urlConfig.default_image || null,
      default_description: urlConfig.default_description || null,
      exclude_title_keywords: urlConfig.exclude_title_keywords || [],
      expand_dates: urlConfig.expand_dates || false,
      wait_for: urlConfig.wait_for || null,
      spektrix_client: urlConfig.spektrix_client || null,
      spektrix_exclude: urlConfig.spektrix_exclude || null,
      spektrix_website_attr: urlConfig.spektrix_website_attr || null,
      spektrix_listing_url: urlConfig.spektrix_listing_url || null,
      spektrix_use_id_url: urlConfig.spektrix_use_id_url || false,
      skiddle_venue_id: urlConfig.skiddle_venue_id || null,
      spektrix_venue_filter: urlConfig.spektrix_venue_filter || null,
      spektrix_venue_filter_attr: urlConfig.spektrix_venue_filter_attr || 'TicketVenue',
      ticketsolve_client: urlConfig.ticketsolve_client || null,
      churchsuite_client: urlConfig.churchsuite_client || null,
      churchsuite_exclude_categories: urlConfig.churchsuite_exclude_categories || [],
      churchsuite_exclude_title_keywords: urlConfig.churchsuite_exclude_title_keywords || [],
      momence_host_id: urlConfig.momence_host_id || null,
      places_leisure_url: urlConfig.places_leisure_url || null,
      places_leisure_timetable_ids: urlConfig.places_leisure_timetable_ids || [],
      merge_with: urlConfig.merge_with || null,
      firecrawl_actions: urlConfig.firecrawl_actions || null,
      latitude: urlConfig.latitude || hub.latitude,
      longitude: urlConfig.longitude || hub.longitude,
      max_per_day: urlConfig.max_per_day || null,
      no_repeat_titles: urlConfig.no_repeat_titles || false,
      class_descriptions: urlConfig.class_descriptions || null,
    };

    // ── Generate URLs to scrape (supports date_range_days) ──────────────────
    const dateRangeDays = urlConfig.date_range_days || 0;
    const urlsForEntry = [];

    if (dateRangeDays > 0) {
      const datePattern = /\d{4}-\d{2}-\d{2}/;
      if (datePattern.test(urlString)) {
        // Always start from today regardless of date in URL
        for (let d = 0; d < dateRangeDays; d++) {
          const date = new Date();
          date.setDate(date.getDate() + d);
          const pad = (n) => String(n).padStart(2, '0');
          const dateStr = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
          urlsForEntry.push(urlString.replace(datePattern, dateStr));
        }
        console.log(`\u{1f4c5} Date range mode: scraping ${dateRangeDays} days from today`);
      } else {
        urlsForEntry.push(urlString);
      }
    } else {
      urlsForEntry.push(urlString);
    }

    const useVenueFilename = urlConfig.use_venue_as_filename && urlConfig.default_venue;
    let filename = generateFilename(hub.name, urlString, useVenueFilename ? urlConfig.default_venue : null);

    // merge_with overrides filename — both entries share the same target file
    if (urlConfig.merge_with) {
      const hubSlug = hub.name.toLowerCase().replace(/\s+/g, "-");
      const mergeSlug = urlConfig.merge_with.toLowerCase().replace(/\s+/g, "-");
      filename = `${hubSlug}-${mergeSlug}.json`;
      console.log(`🔀 merge_with mode → target file: ${filename}`);
    }

    console.log(`${'─'.repeat(50)}`);
    console.log(`[${i + 1}/${urlsToProcess.length}] Scraping: ${urlString}`);
    console.log(`📄 Output file: ${filename}`);
    if (urlConfig.default_venue) console.log(`🏛️  Default venue: ${urlConfig.default_venue}`);
    if (urlConfig.default_image) console.log(`🖼️  Default image: ON`);
    console.log(`${'─'.repeat(50)}\n`);

    let events = [];

    // ── Pass 1: Scrape listing page(s) or fetch from Spektrix API ────────────
    try {
      const allEvents = [];
      if (urlHub.ticketsolve_client) {
        // Use Ticketsolve XML feed
        const ticketsolveEvents = await fetchTicketsolveEvents(urlHub.ticketsolve_client, hub, urlConfig);
        allEvents.push(...ticketsolveEvents);
      } else if (urlHub.skiddle_venue_id) {
        // Skiddle API — zero Firecrawl credits
        const skiddleEvents = await fetchSkiddleEvents(urlHub.skiddle_venue_id, hub, urlConfig);
        allEvents.push(...skiddleEvents);
      } else if (urlHub.churchsuite_client) {
        // ChurchSuite public calendar feed — zero Firecrawl credits
        const churchSuiteEvents = await fetchChurchSuiteEvents(urlHub.churchsuite_client, hub, urlConfig);
        allEvents.push(...churchSuiteEvents);
      } else if (urlHub.momence_host_id) {
        // Momence public schedule API — zero Firecrawl credits
        const momenceEvents = await fetchMomenceEvents(urlHub.momence_host_id, hub, urlConfig);
        allEvents.push(...momenceEvents);
      } else if (urlHub.places_leisure_url) {
        // Places Leisure / Gladstone Go — parse hidden timetable-data input
        const plEvents = await fetchPlacesLeisureEvents(urlHub.places_leisure_url, hub, urlConfig);
        allEvents.push(...plEvents);
      } else if (urlHub.spektrix_client) {
        // Pure Spektrix API — no Firecrawl needed at all!
        const today = new Date().toISOString().split("T")[0];
        const sixMonthsAhead = new Date();
        sixMonthsAhead.setMonth(sixMonthsAhead.getMonth() + 6);
        const endDate = sixMonthsAhead.toISOString().split("T")[0];

        const apiUrl = `https://system.spektrix.com/${urlHub.spektrix_client}/api/v3/events?instanceStart_from=${today}&instanceStart_to=${endDate}&$expand=instances`;
        console.log(`  🎫 Fetching Spektrix API (zero Firecrawl credits)...`);
        const apiRes = await fetch(apiUrl);
        if (!apiRes.ok) throw new Error(`Spektrix API returned ${apiRes.status}`);
        const allSpektrixShows = await apiRes.json();

        // Filter to shows marked for this venue's website only
        const websiteAttr = urlHub.spektrix_website_attr || null;
        const realShows = allSpektrixShows.filter(show => {
          // If a website attribute is specified, use it as filter
          if (websiteAttr && show[`attribute_${websiteAttr}`] === false) return false;
          // Filter out common junk add-ons by keyword
          const excludeKeywords = urlHub.spektrix_exclude || [
            "pre-order", "pre order", "ice cream", "meal", "ticket protection",
            "backstage tour", "add-on", "tubs", "merchandise", "car park",
            "programme", "gift voucher", "donation", "upgrade", "parking", "cancelled"
          ];
          const title = show.name.toLowerCase();
          return !excludeKeywords.some(kw => title.toLowerCase().includes(kw.toLowerCase()));
        });

        console.log(`  🎫 ${realShows.length}/${allSpektrixShows.length} real show(s) after filtering`);

        // Step 2: Scrape load-more.php to get exact show page URLs (only if spektrix_listing_url is set)
        const baseUrl = new URL(urlString);
        const siteBase = `${baseUrl.protocol}//${baseUrl.host}`;
        const loadMoreUrl = urlHub.spektrix_listing_url || null;

        const SHOW_URLS_SCHEMA = {
          type: "object",
          properties: {
            shows: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  title: { type: "string", description: "The show title" },
                  url: { type: "string", description: "The full URL of the show page" },
                }
              }
            }
          }
        };

        // Build a title -> URL map from load-more.php (skipped if no spektrix_listing_url)
        const showUrlMap = {};
        if (loadMoreUrl) { try {
          console.log(`  📋 Fetching show URLs from load-more.php...`);
          const loadMoreRes = await firecrawl.scrapeUrl(loadMoreUrl, {
            timeout: 120000,
            waitFor: 5000,
            formats: ["extract"],
            extract: {
              schema: SHOW_URLS_SCHEMA,
              systemPrompt: "Extract the title and full URL of every show listed on this page. Return exact URLs as they appear.",
            },
          });
          if (loadMoreRes.success && loadMoreRes.extract?.shows) {
            for (const show of loadMoreRes.extract.shows) {
              if (show.title && show.url) {
                showUrlMap[show.title.toLowerCase().trim()] = show.url;
              }
            }
            console.log(`  📋 Got exact URLs for ${Object.keys(showUrlMap).length} show(s)`);
          }
          // Also try page 2
          const loadMoreRes2 = await firecrawl.scrapeUrl(loadMoreUrl.replace("page=1", "page=2"), {
            timeout: 120000,
            waitFor: 5000,
            formats: ["extract"],
            extract: {
              schema: SHOW_URLS_SCHEMA,
              systemPrompt: "Extract the title and full URL of every show listed on this page. Return exact URLs as they appear.",
            },
          });
          if (loadMoreRes2.success && loadMoreRes2.extract?.shows) {
            for (const show of loadMoreRes2.extract.shows) {
              if (show.title && show.url) {
                showUrlMap[show.title.toLowerCase().trim()] = show.url;
              }
            }
            console.log(`  📋 Total after page 2: ${Object.keys(showUrlMap).length} show(s)`);
          }
        } catch (err) {
          console.warn(`  ⚠️  load-more.php scrape failed: ${err.message}`);
        } } // end if loadMoreUrl

        // Step 3: Deep scrape each unique show page for description
        // Skip deep scrape if spektrix_use_id_url is set — descriptions come directly from Spektrix API
        const showPageCache = {};
        if (!urlHub.spektrix_use_id_url) {
        const showPageLimit = pLimit(3);

        await Promise.all(
          realShows.map(show =>
            showPageLimit(async () => {
              if (showPageCache[show.name]) return;

              // Get exact URL from load-more.php map, fall back to slug
              const exactUrl = showUrlMap[show.name.toLowerCase().trim()];
              const slug = show.name.toLowerCase().replace(/['''`]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
              const showUrl = exactUrl || `${siteBase}/shows/${slug}/`;

              const rawImageUrl = show.imageUrl || show.thumbnailUrl || null;
              const imageUrl = (rawImageUrl && rawImageUrl.startsWith("https://")) ? rawImageUrl : null;

              try {
                const res = await firecrawl.scrapeUrl(showUrl, {
                  timeout: 120000,
                  waitFor: 8000,
                  formats: ["extract"],
                  extract: {
                    schema: EVENT_PAGE_SCHEMA,
                    systemPrompt:
                      "You are an expert event copywriter. From this event page extract ONLY the marketing description — " +
                      "the paragraphs that describe the story, performers, atmosphere and what makes the show worth seeing. " +
                      "STOP extracting as soon as you encounter any of the following: ticket prices, running times, booking instructions, " +
                      "accessibility information, discounts, loyalty schemes, group rates, meal options, seating details, " +
                      "terms and conditions, or calls to action like 'Book now' or 'Find out more'. " +
                      "Do NOT include section headers. Wrap in <p> tags. " +
                      "Also extract the best/largest event image URL from the page (must start with https://). " +
                      "Return null for start_date and end_date.",
                  },
                });
                if (res.success && res.extract?.description) {
                  const extractedImage = res.extract.image_url && res.extract.image_url.startsWith("https://") ? res.extract.image_url : null;
                  showPageCache[show.name] = {
                    description: wrapDescription(res.extract.description),
                    image_url: imageUrl || extractedImage,
                    url: showUrl,
                  };
                  console.log(`  ✅ ${show.name.substring(0, 50)}${extractedImage && !imageUrl ? " (image from page)" : ""}`);
                } else {
                  const extractedImage = res.extract?.image_url && res.extract.image_url.startsWith("https://") ? res.extract.image_url : null;
                  showPageCache[show.name] = { description: "<p></p>", image_url: imageUrl || extractedImage, url: showUrl };
                  console.log(`  ⚠️  No description: ${show.name.substring(0, 50)}`);
                }
              } catch {
                showPageCache[show.name] = { description: "<p></p>", image_url: imageUrl, url: showUrl };
              }
            })
          )
        );

        } // end if !spektrix_use_id_url
        if (!urlHub.spektrix_use_id_url) console.log(`  📋 Show page cache built for ${Object.keys(showPageCache).length} show(s)`);

        // Build one event per Spektrix performance
        const spektrixEvents = await fetchSpektrixEvents(urlHub.spektrix_client, hub, urlConfig, showPageCache, realShows);
        allEvents.push(...spektrixEvents);
      } else {
        for (const scrapeUrlStr of urlsForEntry) {
          const dayEvents = await scrapeUrl(scrapeUrlStr, urlHub);
          allEvents.push(...dayEvents);
        }
      }
      // Deduplicate by ID across multiple days
      const seenEventIds = new Set();
      events = allEvents.filter(e => {
        if (seenEventIds.has(e.id)) return false;
        seenEventIds.add(e.id);
        return true;
      });
      // Apply default_image override if set
      if (urlHub.default_image) {
        events = events.map(e => ({ ...e, image_url: urlHub.default_image }));
      }
      console.log(`  ✅ Pass 1 complete: ${events.length} event(s) found\n`);
    } catch (err) {
      console.error(`  ❌ Failed to scrape: ${urlString}`);
      console.error(`     Reason: ${err.message}`);
      errors.push({ url: urlString, error: err.message });
      continue;
    }

    if (events.length === 0) {
      console.warn(`  ⚠️  No events found for ${urlString}, skipping.\n`);
      continue;
    }

    // ── Pass 2: Deep scrape ─────────────────────────────────────────────────
    if (argv.deep && !urlHub.expand_dates) {
      const seenIds = loadSeenIds(filename);
      const newEvents = events.filter(e => !seenIds.has(e.id));
      const knownEvents = events.filter(e => seenIds.has(e.id));

      console.log(`🔍 Pass 2: ${newEvents.length} new event(s) to deep scrape, ${knownEvents.length} already known\n`);
      console.log(`🔍 Pass 2: ${newEvents.length} new event(s), scraping unique shows for descriptions...\n`);

      if (newEvents.length > 0) {
        // For Spektrix venues: show pages already scraped in Pass 1, skip Pass 2
        const isSpektrix = !!urlHub.spektrix_client;

        if (isSpektrix) {
          // Show pages already scraped in Pass 1 — just clean up internal fields
          const cleanedEvents = newEvents.map(({ _spektrix_show_id, ...e }) => ensureEndDate(e));
          newEvents.splice(0, newEvents.length, ...cleanedEvents);
          console.log(`  ✅ Spektrix: descriptions/images already applied from Pass 1\n`);
        } else {
          // Standard deep scrape - one per event
          const deepLimit = pLimit(3);
          let completed = 0;

          await Promise.all(
            newEvents.map((event, j) =>
              deepLimit(async () => {
                console.log(`  [${j + 1}/${newEvents.length}] Deep scraping: ${event.title.substring(0, 50)}`);
                const enriched = await scrapeEventPage(event);
                const classification = classifyEvent(enriched.title, enriched.description || "");
                enriched.category = classification.id;
                enriched._classification = `${classification.name} (score: ${classification.score})`;

                if (enriched._expandedPerformances && enriched._expandedPerformances.length > 0) {
                  const expanded = enriched._expandedPerformances.map(({ _expandedPerformances, ...e }) => ({
                    ...e,
                    description: enriched.description,
                    image_url: enriched.image_url || e.image_url,
                    category: enriched.category,
                    _classification: enriched._classification,
                  }));
                  newEvents.splice(j, 1, ...expanded);
                  console.log(`  🎭 Expanded "${enriched.title}" → ${expanded.length} performances`);
                } else {
                  const { _expandedPerformances, ...cleanEnriched } = enriched;
                  newEvents[j] = ensureEndDate(cleanEnriched);
                }
                completed++;
                console.log(`  ✅ (${completed}/${newEvents.length}) → ${classification.name} (score: ${classification.score})`);
              })
            )
          );
        }
      }


      events = [...newEvents, ...knownEvents];

      const beforeFilter = events.length;
      events = events.filter(e => {
        if (!e.image_url) {
          console.warn(`  ⚠️  Skipped (no image): ${e.title.substring(0, 50)}`);
          return false;
        }
        return true;
      });

      console.log(`\n  📅 Events after image filter: ${events.length}/${beforeFilter}\n`);

      const allIds = new Set(events.map(e => e.id));
      saveSeenIds(filename, allIds);
      console.log(`  💾 Saved ${allIds.size} seen IDs for future runs\n`);

    } else if (urlHub.expand_dates && argv.deep) {
      console.log(`ℹ️  Deep scrape skipped — expand_dates handles individual performances for this URL\n`);
    }

    // ── Deduplicate by ID ───────────────────────────────────────────────────
    const seenIds = new Set();
    events = events.filter(e => {
      if (seenIds.has(e.id)) return false;
      seenIds.add(e.id);
      return true;
    });

    // ── Filter past events ──────────────────────────────────────────────────
    const now = new Date();
    const beforePastFilter = events.length;
    events = events.filter(e => {
      if (!e.start_date) return false;
      const start = new Date(e.start_date.replace(" ", "T"));
      const end = e.end_date ? new Date(e.end_date.replace(" ", "T")) : null;
      // Keep if start is in future OR end is in future (catches ongoing exhibitions)
      return start >= now || (end && end >= now);
    });
    if (beforePastFilter !== events.length) {
      console.log(`  🗓️  Removed ${beforePastFilter - events.length} past event(s)\n`);
    }

    // ── Filter bad descriptions (404, error pages) ───────────────────────
    const BAD_DESC_PHRASES = [
      "we couldn't find that page",
      "something's not quite gone to plan",
      "somethings not quite gone to plan",
      "404 error",
      "page not found",
      "nothing was found",
      "timed out",
      "cloudflare",
      "it looks like nothing was found",
    ];
    const beforeBadDescFilter = events.length;
    events = events.filter(e => {
      if (!e.description) return true;
      const desc = e.description.toLowerCase();
      return !BAD_DESC_PHRASES.some(phrase => desc.includes(phrase));
    });
    if (beforeBadDescFilter !== events.length) {
      console.log(`  🚫 Removed ${beforeBadDescFilter - events.length} event(s) with bad descriptions\n`);
    }

    // ── Majority description voting (deep scrape only) ──────────────────────
    // Not needed for expand_dates — show page cache already gives consistent descriptions
    if (!urlHub.expand_dates) {
      const urlGroups = {};
      events.forEach(e => {
        const key = e.url;
        if (!urlGroups[key]) urlGroups[key] = [];
        urlGroups[key].push(e.description);
      });

      const bestDescriptions = {};
      for (const [url, descriptions] of Object.entries(urlGroups)) {
        if (descriptions.length <= 1) {
          bestDescriptions[url] = descriptions[0];
          continue;
        }
        const freq = {};
        descriptions.forEach(d => { freq[d] = (freq[d] || 0) + 1; });
        const best = Object.entries(freq).sort((a, b) => {
          if (b[1] !== a[1]) return b[1] - a[1];
          return b[0].length - a[0].length;
        })[0][0];
        bestDescriptions[url] = best;
      }

      let votingFixed = 0;
      events = events.map(e => {
        const best = bestDescriptions[e.url];
        if (best && best !== e.description) {
          votingFixed++;
          const classification = classifyEvent(e.title, best);
          return {
            ...e,
            description: best,
            category: classification.id,
            _classification: `${classification.name} (score: ${classification.score})`,
          };
        }
        return e;
      });

      if (votingFixed > 0) {
        console.log(`  🗳️  Applied majority description to ${votingFixed} event(s)\n`);
      }
    }

    // ── Apply class_descriptions lookup if set (before majority voting so it always wins) ──
    if (urlHub.class_descriptions) {
      events = events.map(e => {
        const desc = urlHub.class_descriptions[e.title];
        if (desc) {
          return { ...e, description: `<p>${desc}</p>` };
        }
        return e;
      });
      console.log(`  📝 Applied class descriptions lookup\n`);
    }

    // ── Apply exclude_title_keywords filter ──────────────────────────────
    if (urlHub.exclude_title_keywords && urlHub.exclude_title_keywords.length > 0) {
      const before = events.length;
      events = events.filter(e => !urlHub.exclude_title_keywords.some(kw => e.title?.toLowerCase().includes(kw.toLowerCase())));
      if (events.length < before) console.log(`  🚫 Excluded ${before - events.length} event(s) by title keyword`);
    }

    // ── Apply default_image override (final, wins over everything) ────────
    if (urlHub.default_image) {
      events = events.map(e => ({ ...e, image_url: urlHub.default_image }));
    }

    // ── Apply default_description override (final, wins over everything) ──
    if (urlHub.default_description) {
      events = events.map(e => ({ ...e, description: urlHub.default_description }));
    }

    // ── max_per_day + no_repeat_titles filtering ─────────────────────────────
    if (urlHub.max_per_day) {
      // Group events by date (YYYY-MM-DD)
      const byDate = {};
      events.forEach(e => {
        const day = e.start_date.substring(0, 10);
        if (!byDate[day]) byDate[day] = [];
        byDate[day].push(e);
      });

      const filtered = [];
      let prevTitles = []; // titles used on previous day

      const sortedDays = Object.keys(byDate).sort();
      for (const day of sortedDays) {
        let dayEvents = byDate[day];

        // Sort by start time so earliest comes first
        dayEvents.sort((a, b) => a.start_date.localeCompare(b.start_date));

        const picked = [];
        for (const event of dayEvents) {
          if (picked.length >= urlHub.max_per_day) break;

          // If no_repeat_titles, skip if title was used on previous day
          if (urlHub.no_repeat_titles && prevTitles.includes(event.title)) continue;

          picked.push(event);
        }

        // Fallback: if no_repeat_titles filtered everything out, just take first
        if (picked.length === 0 && dayEvents.length > 0) {
          picked.push(dayEvents[0]);
        }

        filtered.push(...picked);
        prevTitles = picked.map(e => e.title);
      }

      const before = events.length;
      events = filtered;
      console.log(`  📅 max_per_day filter: ${before} → ${events.length} event(s)\n`);
    }

    // ── Classification summary ──────────────────────────────────────────────
    console.log(`📋 Category breakdown for ${filename}:`);
    const categoryCounts = {};
    events.forEach(e => {
      const name = e._classification?.split(" (")[0] || "Other";
      categoryCounts[name] = (categoryCounts[name] || 0) + 1;
    });
    Object.entries(categoryCounts)
      .sort((a, b) => b[1] - a[1])
      .forEach(([name, count]) => {
        console.log(`   ${name}: ${count}`);
      });
    console.log();

    // ── Save to local file ──────────────────────────────────────────────────
    try {
      const filepath = saveToFile(events, filename.replace(".json", ""), false);
      console.log(`💾 Saved locally: ${filepath}\n`);
    } catch (err) {
      console.error(`❌ Failed to save file: ${err.message}`);
    }

    // ── Merge with existing GitHub file if merge_with is set ────────────────
    if (urlConfig.merge_with) {
      try {
        const getUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${filename}`;
        const getRes = await fetch(getUrl, {
          headers: {
            Authorization: `Bearer ${GITHUB_TOKEN}`,
            Accept: "application/vnd.github+json",
          },
        });
        if (getRes.ok) {
          const existing = await getRes.json();
          const existingEvents = JSON.parse(Buffer.from(existing.content, "base64").toString("utf-8"));
          const existingIds = new Set(existingEvents.map(e => e.id));
          const newEvents = events.filter(e => !existingIds.has(e.id));
          events = [...existingEvents, ...newEvents];
          console.log(`🔀 Merged: ${existingEvents.length} existing + ${newEvents.length} new = ${events.length} total events`);
        } else {
          console.log(`🔀 No existing file found — creating fresh merged file`);
        }
      } catch (err) {
        console.warn(`⚠️  merge_with fetch failed: ${err.message} — writing fresh file`);
      }
    }

    // ── Push to GitHub ──────────────────────────────────────────────────────
    try {
      await pushToGitHub(events, filename);
    } catch (err) {
      console.error(`❌ Failed to push to GitHub: ${err.message}`);
    }

    // ── Track venue result for run log ──────────────────────────────────────
    const eventCount = events.length;
    venueLog.push({
      venue: urlConfig.default_venue || urlString,
      url: urlString,
      filename,
      events: eventCount,
      status: eventCount === 0 ? "empty" : eventCount < 3 ? "low" : "healthy",
    });
  }

  if (errors.length > 0) {
    console.log(`\n⚠️  The following URLs had errors:`);
    errors.forEach(({ url, error }) => {
      console.log(`   • ${url}`);
      console.log(`     ${error}`);
    });
  }

  // ── Push run log to GitHub ─────────────────────────────────────────────────
  try {
    const RUN_LOG_FILE = "run-log.json";
    const duration = Math.round((Date.now() - runStart) / 1000);

    const newEntry = {
      timestamp: new Date().toISOString(),
      hub: hub.name,
      venues: venueLog,
      total_events: venueLog.reduce((s, v) => s + v.events, 0),
      errors: errors.map(e => ({ url: e.url, error: e.error })),
      duration_seconds: duration,
    };

    // Fetch existing log
    let existingLog = [];
    try {
      const logUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${RUN_LOG_FILE}`;
      const res = await fetch(logUrl, {
        headers: {
          Authorization: `token ${GITHUB_TOKEN}`,
          Accept: "application/vnd.github.v3+json",
        },
      });
      if (res.ok) {
        const data = await res.json();
        existingLog = JSON.parse(Buffer.from(data.content, "base64").toString("utf-8"));
      }
    } catch { /* first run, no log yet */ }

    // Prepend new entry and keep last 50 runs
    const updatedLog = [newEntry, ...existingLog].slice(0, 50);

    // Push updated log
    await pushToGitHub(updatedLog, RUN_LOG_FILE);
    console.log(`📋 Run log updated (${updatedLog.length} entries)
`);
  } catch (err) {
    console.error(`⚠️  Failed to update run log: ${err.message}`);
  }

  console.log(`\n🎉 Done!\n`);
}

main().catch((err) => {
  console.error("💥 Unexpected error:", err.message);
  process.exit(1);
});
