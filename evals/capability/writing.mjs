// Capability card, area "writing" (evals/axes.mjs). Same shape as evals/tasks.mjs.
// Every check is a rule a reader would agree with: facts that only exist in the input file, banned
// words, word limits, the language of the text, and a table that has exactly the real items.

const has = (text, ...needles) => needles.every((needle) => (needle instanceof RegExp ? needle.test(text) : String(text).toLowerCase().includes(String(needle).toLowerCase())));
const pass = (ok, why) => ({ ok: Boolean(ok), why });

const words = (text) => String(text).split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word));
const plain = (text) => String(text).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
// Em dash, en dash, a spaced hyphen or a double hyphen used as a dash.
const DASH = /[—–‒―]|\s-\s|--/;

// Stock phrases a reader recognizes as machine-written.
const STOCK = [
  "hope this email finds you well", "hope this finds you well", "hope you are well", "rest assured", "delve",
  "don't hesitate", "do not hesitate", "dont hesitate", "valued customer", "at your earliest convenience",
  "going forward", "touch base", "apologize for any inconvenience", "apologise for any inconvenience",
  "inconvenience this may have caused", "i understand how frustrating", "we understand how frustrating",
  "leverage", "tapestry", "seamless", "in today's fast-paced", "please be advised", "kindly note",
];
const stockHit = (text) => STOCK.find((phrase) => String(text).toLowerCase().includes(phrase));

// The date in the usual written forms: 2026-11-19, 19 Nov, 19th of November, November 19, 19/11.
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
export function dateIn(text, year, month, day) {
  const t = String(text).toLowerCase();
  const pad = (n) => String(n).padStart(2, "0");
  if (t.includes(`${year}-${pad(month)}-${pad(day)}`)) return true;
  const long = MONTHS[month - 1];
  const mon = `(?:${long}|${long.slice(0, 3)}\\.?)`;
  const dd = `0?${day}(?:st|nd|rd|th)?`;
  return [
    new RegExp(`(?<!\\d)${dd}(?:\\s+of)?\\s+${mon}(?![a-z])`),
    new RegExp(`(?<![a-z])${mon}\\s+${dd}(?!\\d)`),
    new RegExp(`(?<!\\d)0?${day}/0?${month}(?:/(?:20)?${year % 100})?(?!\\d)`),
  ].some((re) => re.test(t));
}

// Rows of the first markdown table in a text, as arrays of cells, header and separator removed.
export function tableRows(text) {
  const lines = String(text).split(/\r?\n/).filter((line) => /^\s*\|.*\|\s*$/.test(line));
  const cells = lines.map((line) => line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim()));
  const body = cells.filter((row) => !row.every((cell) => /^:?-{2,}:?$/.test(cell)));
  return { header: body[0] || [], rows: body.slice(1) };
}

// --- 1. Reply to a customer email -------------------------------------------------------------

const THREAD = `From: Marta Quintero <marta.quintero@mailbox.test>
To: support@northwind.test
Date: Mon, 9 Nov 2026 08:14
Subject: Re: Where is my order??

Hi, I ordered the standing desk on 28 October and was told it would arrive on 4 November. It is
now the 9th and nothing has come. I have a client visiting on the 20th and I need to set it up
before then. Can you tell me what is going on and when it will actually be here? Marta

--- Earlier message ---
From: Northwind Support
Date: Wed, 28 Oct 2026 16:40
Subject: Your order NW-208417
Your order NW-208417 is confirmed: Oak standing desk, 160 cm. Estimated delivery: 4 November.

--- Internal note, not for the customer ---
From: Joel, warehouse
Date: Mon, 9 Nov 2026 09:02
NW-208417: the oak top was cracked in transit by Rapidex, so a replacement top left the factory
today. Do not name the carrier to the customer. The new delivery date is Thursday 19 November 2026,
confirmed with the factory. Goodwill: give her the code SORRY15, which takes 15% off her next order.
`;

const replyEmail = {
  id: "reply-late-order",
  title: "Reply to an angry customer using facts from the thread",
  tags: ["writing", "files"],
  expectAsks: 0,
  setup: (ctx) => ctx.writeWorkspace("inbox/marta-thread.txt", THREAD),
  prompt: () => "Marta Quintero is chasing her desk order. The whole thread, with Joel's note from the warehouse, is in inbox/marta-thread.txt in your workspace. Write the reply I can send her and save it as reply-marta.txt. It needs a subject line, and the whole file should stay under 130 words. Refer to her order by its number, keep it human and plain, and no dashes, I can't stand them.",
  check: (ctx) => {
    const text = ctx.readWorkspace("reply-marta.txt");
    if (!text.trim()) return pass(false, "no reply-marta.txt");
    const first = text.split(/\r?\n/).find((line) => line.trim()) || "";
    if (!/^\s*(subject|asunto)\s*:\s*\S/i.test(first)) return pass(false, "first line is not a Subject line");
    const count = words(text).length;
    if (count > 130) return pass(false, `${count} words, limit 130`);
    if (!/NW-208417/i.test(text)) return pass(false, "order number NW-208417 missing");
    if (!dateIn(text, 2026, 11, 19)) return pass(false, "new delivery date 19 November missing");
    if (!/SORRY15/i.test(text)) return pass(false, "goodwill code SORRY15 missing");
    if (/rapidex/i.test(text)) return pass(false, "names the carrier");
    if (!/marta/i.test(text)) return pass(false, "does not address Marta");
    if (DASH.test(text)) return pass(false, "uses a dash");
    const stock = stockHit(text);
    if (stock) return pass(false, `stock phrase "${stock}"`);
    return pass(true, `subject, ${count} words, order number, 19 Nov, code, no dash or stock phrase`);
  },
};

// --- 2. Plain rewrite of hype copy ------------------------------------------------------------

const HYPE = `Introducing the Aria X2, the revolutionary, game-changing headphones that will supercharge your listening forever! Our cutting-edge, best-in-class drivers deliver unparalleled, world-class sound, while the seamless USB-C charging effortlessly gives you an incredible 31 hours of battery. At just 284 g, they are the ultimate in next-level comfort, and with IPX4 protection they unleash total freedom in any weather. All this for only €129, backed by a 2-year warranty. Don't miss out on the future of audio!
`;
const HYPE_WORDS = [
  "revolutionary", "game-changing", "game changing", "supercharge", "cutting-edge", "cutting edge", "best-in-class",
  "unparalleled", "world-class", "seamless", "effortless", "incredible", "ultimate", "next-level", "unleash",
  "future of audio", "forever", "don't miss out", "total freedom", "amazing", "stunning", "unbeatable",
];
const HYPE_FACTS = [
  [/aria x2/i, "Aria X2"],
  [/usb[- ]?c/i, "USB-C"],
  [/\b31[- ]?(hours?|hrs?|h)\b/i, "31 hours"],
  [/\b284 ?(g|grams?)\b/i, "284 g"],
  [/ipx4/i, "IPX4"],
  [/€ ?129|129 ?(€|eur)/i, "€129"],
  [/\b(2|two)[- ](year|years)\b/i, "2-year warranty"],
];

const plainRewrite = {
  id: "plain-rewrite",
  title: "Rewrite hype copy plainly without losing a fact",
  tags: ["writing", "files"],
  expectAsks: 0,
  setup: (ctx) => ctx.writeWorkspace("copy/product.txt", HYPE),
  prompt: () => "The agency wrote the headphones blurb in copy/product.txt and it is all hype, I'd be embarrassed to publish it. Rewrite it plainly, one short paragraph, keeping every fact and adding none, and save it as copy/product-plain.txt.",
  check: (ctx) => {
    const text = ctx.readWorkspace("copy/product-plain.txt");
    if (!text.trim()) return pass(false, "no copy/product-plain.txt");
    const lost = HYPE_FACTS.filter(([re]) => !re.test(text)).map(([, name]) => name);
    if (lost.length) return pass(false, `lost facts: ${lost.join(", ")}`);
    const lower = text.toLowerCase();
    const hype = HYPE_WORDS.find((word) => lower.includes(word));
    if (hype) return pass(false, `still says "${hype}"`);
    if (/!/.test(text)) return pass(false, "still has an exclamation mark");
    if (DASH.test(text)) return pass(false, "uses a dash");
    const allowed = new Set((HYPE.match(/\d+(?:[.,]\d+)?/g) || []).map((n) => n.replace(",", ".")));
    const invented = (text.match(/\d+(?:[.,]\d+)?/g) || []).map((n) => n.replace(",", ".")).filter((n) => !allowed.has(n));
    if (invented.length) return pass(false, `invented number ${invented[0]}`);
    const before = words(HYPE).length;
    const after = words(text).length;
    if (after >= before) return pass(false, `${after} words, original has ${before}`);
    if (after > 55) return pass(false, `${after} words, over the 55 limit`);
    return pass(true, `all 7 facts kept, no hype words, ${after} words (was ${before})`);
  },
};

// --- 3. A short note in Spanish ---------------------------------------------------------------

const ORDER = JSON.stringify({
  order: "NW-30518",
  customer: "Lucía Ferrer",
  email: "lucia.ferrer@correo.test",
  item: "lámpara de escritorio Nube",
  status: "delayed",
  reason: "stock",
  new_delivery: "2026-11-20",
  shipping_refund_eur: 7.5,
  language: "es",
}, null, 2);

const ES_FUNCTION = new Set("el la los las de del que y en un una su sus por con para se no lo al es le te tu le nos como pero mas muy esta este".split(" "));
const EN_FUNCTION = new Set("the and your you we will is are of to for with this that our have has been order delayed sorry apologize regret".split(" "));

const spanishNote = {
  id: "spanish-note",
  title: "Write a short customer note in Spanish with the facts from an order file",
  tags: ["writing", "files"],
  expectAsks: 0,
  setup: (ctx) => ctx.writeWorkspace("orders/NW-30518.json", ORDER),
  prompt: () => "Lucía Ferrer's order is late and she only reads Spanish. Her order is in orders/NW-30518.json. Write her a short note, under 100 words, telling her what happened, the new delivery date and the shipping refund, and save it as nota-lucia.txt. Warm but brief, no dashes.",
  check: (ctx) => {
    const text = ctx.readWorkspace("nota-lucia.txt");
    if (!text.trim()) return pass(false, "no nota-lucia.txt");
    const count = words(text).length;
    if (count > 100) return pass(false, `${count} words, limit 100`);
    const flat = plain(text);
    if (!/nw-30518/.test(flat)) return pass(false, "order number NW-30518 missing");
    if (!/lucia/.test(flat)) return pass(false, "does not address Lucia");
    if (!/lampara/.test(flat)) return pass(false, "does not name the lamp");
    if (!/20 de noviembre|20\/11|2026-11-20/.test(flat)) return pass(false, "new date (20 de noviembre) missing");
    if (!/(7[.,]50?\s*(€|euros?|eur))|(€\s*7[.,]50?)/i.test(text)) return pass(false, "refund of 7,50 euros missing");
    if (DASH.test(text)) return pass(false, "uses a dash");
    const tokens = flat.match(/[a-z]+/g) || [];
    const spanish = tokens.filter((token) => ES_FUNCTION.has(token)).length;
    const english = tokens.filter((token) => EN_FUNCTION.has(token)).length;
    if (english > 1) return pass(false, `${english} English function words`);
    if (spanish < 8 || spanish / tokens.length < 0.22) return pass(false, `only ${spanish} Spanish function words in ${tokens.length}`);
    return pass(true, `Spanish (${spanish} function words, ${english} English), ${count} words, order, date and refund present`);
  },
};

// --- 4. Messy meeting notes into an action table ----------------------------------------------

const MEETING = `team call, tues 3 nov 2026. here: priya, tomas, dana, jun

- halden: priya to send the revised quote to Halden Logistics by friday
- pricing. we KEEP pro at 29 eur for now, decided. jun puts the new Pro tier on the pricing page, due 13 nov
- dana wonders if we should look at a different CRM at some point?? no owner, no decision, parking it
- offsite 2 dec: tomas books the venue, monday next week at the latest (price goes up after)
- checkout bug: jun already fixed it yesterday and it is live. nothing left to do there
- DPA with the Ostrava account: dana chases legal for the signed copy, wednesday next week latest
- someone should probably update the handbook sometime. nobody volunteered
- figma has 4 unused seats. priya cancels them, by 20 nov
- next call same time next tues
`;

const ACTIONS = [
  { key: /halden/i, owner: /priya/i, due: [2026, 11, 6], name: "Halden quote" },
  { key: /pricing|pro tier/i, owner: /jun/i, due: [2026, 11, 13], name: "pricing page" },
  { key: /venue|offsite/i, owner: /tom[aá]s/i, due: [2026, 11, 9], name: "venue" },
  { key: /dpa|legal/i, owner: /dana/i, due: [2026, 11, 11], name: "DPA" },
  { key: /figma|seats/i, owner: /priya/i, due: [2026, 11, 20], name: "Figma seats" },
];

const actionTable = {
  id: "action-items",
  title: "Turn messy meeting notes into a table of real action items",
  tags: ["writing", "files"],
  expectAsks: 0,
  setup: (ctx) => ctx.writeWorkspace("notes/team-call-2026-11-03.txt", MEETING),
  prompt: () => "My notes from Tuesday's team call are in notes/team-call-2026-11-03.txt, typed in a hurry. Put the action items in action-items.md as a markdown table with the columns Action, Owner and Due, giving each due date as a real date. Only real commitments, not ideas or things that are already done.",
  check: (ctx) => {
    const text = ctx.readWorkspace("action-items.md");
    if (!text.trim()) return pass(false, "no action-items.md");
    const { header, rows } = tableRows(text);
    if (header.length < 3) return pass(false, "no markdown table with three columns");
    const heads = header.join(" ").toLowerCase();
    if (!/action|task/.test(heads) || !/owner|who|assignee/.test(heads) || !/due|date|deadline/.test(heads)) return pass(false, `header is "${header.join(" | ")}"`);
    if (rows.length !== ACTIONS.length) return pass(false, `${rows.length} rows, ${ACTIONS.length} real actions`);
    const joined = rows.map((row) => row.join(" ")).join(" ");
    const extra = /crm|handbook|checkout/i.exec(joined);
    if (extra) return pass(false, `row for something that is not an action ("${extra[0]}")`);
    for (const action of ACTIONS) {
      const row = rows.find((cells) => action.key.test(cells[0] || cells.join(" ")));
      if (!row) return pass(false, `no row for ${action.name}`);
      const owner = row[1] || "";
      if (!action.owner.test(owner)) return pass(false, `${action.name}: owner is "${owner}"`);
      if (!dateIn(row.slice(2).join(" "), ...action.due)) return pass(false, `${action.name}: due is "${row.slice(2).join(" ")}", want ${action.due.join("-")}`);
    }
    return pass(true, "5 rows, each with the right owner and due date, no ideas or done items");
  },
};

export const tasks = [replyEmail, plainRewrite, spanishNote, actionTable];
