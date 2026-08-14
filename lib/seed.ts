// Synthetic development corpus (claude.md: no real user content on free tiers).
//
// Deterministic on purpose: `pnpm eval` compares providers over the same 400
// comments, so anything random here makes two runs incomparable. No Date.now(),
// no Math.random(), no crypto.randomUUID().
import { Comment, Platform } from "./schemas";
import { brand_rules, comments } from "./schema";

const SEED = 20260814; // bump to regenerate the corpus
const COUNT = 400;
const BASE = Date.parse("2026-08-01T00:00:00.000Z"); // fixed epoch; Date.now() would drift

// ponytail: mulberry32 — 6 lines, reproducible, not crypto and doesn't need to be.
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T,>(r: () => number, xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;

const HEX = "0123456789abcdef";
const uuid = (r: () => number) =>
  "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) =>
    c === "x" ? HEX[Math.floor(r() * 16)]! : HEX[8 + Math.floor(r() * 4)]!,
  );

/**
 * Comments under one creator's sneaker unboxing video.
 *
 * Grouped by topic so the extraction agent has real themes to find — and each
 * group is deliberately written to share *meaning* without sharing *words*.
 * "on-feet pics?" and "an unworn shoe tells me nothing" are the same request
 * with zero tokens in common: keyword grouping can't merge them, embeddings
 * can. That gap is the whole point of the demo, so seed.test.ts pins it.
 * Rephrasings of one canonical sentence would prove nothing.
 */
export const TOPICS = {
  on_feet: [
    "how do they look on",
    "show them in the street not in the box",
    "need to see these walking around",
    "on-feet pics?",
    "modeling shots when",
    "cardboard is cool but where is the fit pic",
    "lace em up already",
    "an unworn shoe tells me nothing",
    "wear test or it didn't happen",
    "does the toe crease when you bend it",
    "we want outfits, not packaging",
    "styled with jeans please",
    "how do they hold up after a full day",
    "take those outside",
    "run a few miles and report back",
    "give us a lookbook",
    "so it just sits on a shelf forever huh",
    "put them on your feet dude",
  ],
  price: [
    "how much did that set you back",
    "the price is criminal",
    "two hundred and twenty dollars for mesh and glue",
    "cheaper alternatives exist, just saying",
    "my rent looked at me funny",
    "worth every cent honestly",
    "waiting for these to hit the clearance rack",
    "resale is already double retail",
    "who is paying that in this economy",
    "drop the cost and I am in",
    "I would never spend that much on footwear",
    "great value if they survive three years",
    "the tag says what?? nope",
    "saving up, give me two paychecks",
    "quality justifies the number imo",
    "same money buys a flight to Lisbon",
    "any budget version out there",
  ],
  camera_vs_real: [
    "colour looks completely different in person",
    "your lighting is flattering these way too much",
    "saw a pair at the store, much uglier irl",
    "camera does not do them justice",
    "genuine shade or just white balance",
    "photos lie, mine are more grey than blue",
    "screens wash out all texture",
    "held some yesterday and was underwhelmed",
    "ring light doing heavy lifting here",
    "looks better through a lens than on a shelf",
    "suede reads darker under natural sun",
    "recorded footage flattens every curve",
    "tried mine on, tone is off from what I watched",
    "no filter next time please",
    "monitor calibration issue or actual colourway",
    "iphone made it pop, reality did not",
  ],
  part_two: [
    "part 2 when",
    "we need a follow up",
    "do the other colourway next",
    "sequel please",
    "make this a series",
    "give us round two",
    "one video is not enough",
    "continue this next week",
    "more of these on my feed thanks",
    "episode two, don't leave us hanging",
    "same format, different pair",
    "keep going, I subscribed for exactly this",
    "cliffhanger ending, where is the rest",
    "long term review in six months?",
    "compare them against last year's model",
    "revisit this once you break them in",
  ],
  audio: [
    "audio is blown out",
    "I can hear your fridge louder than you",
    "the mic keeps clipping when you get excited",
    "sound levels are all over the place",
    "had to crank my volume to hear anything",
    "the echo in that room is brutal",
    "background track drowns out your voice",
    "get a lav, seriously",
    "captions saved me because I could not make out a word",
    "crisp voiceover this time, big improvement",
    "there is a hum under the whole video",
    "left channel only? fix your export",
    "peaking every time the plastic crinkles",
    "whispering then shouting, my ears",
    "record somewhere smaller with curtains",
    "great picture, rough acoustics",
  ],
} as const satisfies Record<string, readonly string[]>;

const LINES = Object.values(TOPICS).flat();

// Surface noise only — the meaning lives in LINES. Empty entries are load-bearing:
// they keep zero-token-overlap pairs reachable inside a topic.
const OPENERS = ["", "ok but ", "real talk ", "not gonna lie, ", "genuine question: ", "day one and ", "", ""] as const;
const CLOSERS = ["", ".", "!", " 🙃", " 👀", " fr", " 🔥", ""] as const;
const ADJ = ["quiet", "sunny", "brisk", "amber", "fern", "north", "violet", "copper", "tiny", "loud"] as const;
const NOUN = ["otter", "lantern", "pixel", "harbor", "cedar", "comet", "marble", "sparrow", "atlas", "willow"] as const;

/** The corpus. Same input, same 400 comments, forever. */
export function generateComments(): Comment[] {
  const r = rng(SEED);
  const out: Comment[] = [];
  for (let i = 0; i < COUNT; i++) {
    out.push(
      // Parse, don't trust: the seed writes to the same table the agents read.
      Comment.parse({
        id: uuid(r),
        platform: pick(r, Platform.options),
        author: `${pick(r, ADJ)}_${pick(r, NOUN)}${Math.floor(r() * 90) + 10}`,
        text: `${pick(r, OPENERS)}${pick(r, LINES)}${pick(r, CLOSERS)}`,
        // Spread over 30 days after BASE, at minute resolution.
        posted_at: new Date(BASE + Math.floor(r() * 30 * 24 * 60) * 60_000).toISOString(),
      }),
    );
  }
  return out;
}

/**
 * What the approval agent checks drafts against, via RAG over the embeddings.
 * Every rule is written so at least one TOPICS group retrieves it — the bracket
 * names which. A rule no comment can pull back teaches nothing about the RAG
 * step, so it doesn't belong here.
 * `block` rejects the variant, `warn` sends it to the human gate.
 */
export const BRAND_RULES = [
  // price
  { rule: "Give the price plainly when asked. Do not defend it, apologise for it, or tell anyone what they can afford.", severity: "warn" },
  { rule: "Never mention a discount, code, sale or drop price that is not live on the brand's own store right now.", severity: "block" },
  { rule: "No superlatives or speculation about what a pair costs: not cheap, not a steal, not an investment, and never what it will resell for.", severity: "block" },
  // what not to promise
  { rule: "Never give a date for a follow-up video, a restock or an unannounced colourway. Nothing to announce yet is the entire answer.", severity: "block" },
  { rule: "A request for more content gets noted, never promised. Do not commit the creator to filming anything in a public reply.", severity: "warn" },
  // comparisons
  { rule: "Never name another brand or a rival model in a reply, flattering or not, even when the comment names it first.", severity: "block" },
  // the product on camera
  { rule: "When someone says the colour or shape is off from real life, put it on the lighting and the lens. Never suggest their screen or their eyes are wrong.", severity: "warn" },
  { rule: "Never state a material, measurement or colourway name that is not printed on the product page.", severity: "block" },
  { rule: "No claims about fit, sizing, comfort or how a pair wears over time until someone has actually worn them.", severity: "block" },
  // tone in public
  { rule: "Criticism of the video itself gets one line: thanks, noted. No excuses, no gear list, no arguing back.", severity: "warn" },
  { rule: "A hostile or sarcastic comment gets the same neutral tone as a kind one. Never match the sarcasm.", severity: "block" },
  // hand off to the team
  { rule: "Refunds, orders, faulty pairs, and anything about a paid partnership go to the team before a word is posted. Never ask for an order number, email or address in public.", severity: "block" },
] as const satisfies { rule: string; severity: "block" | "warn" }[];

async function main() {
  const rows = generateComments();
  // Same as drizzle.config.ts: this runs outside Next, so nothing loads .env.local for us.
  process.loadEnvFile?.(".env.local");
  const { db } = await import("./db");
  // Re-seeding replaces both corpora: ids are stable, so leftovers would be
  // duplicates. Embeddings go with them — `pnpm embed` refills from NULL.
  await db.delete(comments);
  await db.delete(brand_rules);
  await db.insert(comments).values(
    rows.map((c) => ({ ...c, posted_at: new Date(c.posted_at) })),
  );
  await db.insert(brand_rules).values([...BRAND_RULES]);
  process.stdout.write(
    `seeded ${rows.length} comments, ${BRAND_RULES.length} brand rules (run pnpm embed next)\n`,
  );
  process.exit(0);
}

if (process.argv[1]?.endsWith("/seed.ts")) {
  main().catch((err) => {
    process.stderr.write(`${err}\n`);
    process.exit(1);
  });
}
