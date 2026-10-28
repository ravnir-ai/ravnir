import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createApp } from "../server/index.js";
import { startMock } from "../scripts/mock-openai.js";
import { CODE_NOTE, CUT_NOTE, capForSpeech, detectLanguage, speakableText, speechChunks } from "../public/speakable.js";
import { MAX_AUDIO_BYTES, MAX_SPEAK_CHARS, audioFileName, voiceConfig } from "../server/voice.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.RAVNIR_AI_MEMORY = "off";

const VOICE_ENV = [
  "RAVNIR_STT_URL", "RAVNIR_STT_MODEL", "RAVNIR_STT_API_KEY",
  "RAVNIR_TTS_URL", "RAVNIR_TTS_MODEL", "RAVNIR_TTS_API_KEY", "RAVNIR_TTS_VOICE", "RAVNIR_TTS_VOICES",
  "RAVNIR_USER", "RAVNIR_PASSWORD",
];

function clearVoiceEnv() {
  for (const key of VOICE_ENV) delete process.env[key];
}

// A stand-in for Speaches or VoiceStudio: OpenAI-compatible /v1 routes that record what they were asked.
function fakeSpeech() {
  const seen = { transcribe: [], speak: [] };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    if (req.url === "/v1/audio/transcriptions") {
      seen.transcribe.push({ auth: req.headers.authorization || "", type: req.headers["content-type"], body: body.toString("latin1") });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ text: "  hola, ¿me oyes?  " }));
      return;
    }
    if (req.url === "/v1/audio/speech") {
      seen.speak.push({ auth: req.headers.authorization || "", body: JSON.parse(body.toString("utf8")) });
      res.writeHead(200, { "content-type": "audio/mpeg" });
      res.end(Buffer.from([1, 2, 3, 4, 5]));
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("no such route");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/v1`, seen }));
  });
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

const basic = (user, password) => ({ authorization: `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}` });

test("voice config says which engine each half uses, from the env", () => {
  assert.deepEqual(voiceConfig({}), { stt: "browser", tts: "browser", voices: [], voice: "", maxSeconds: 120 });
  assert.deepEqual(
    voiceConfig({ RAVNIR_STT_URL: "http://speech.local/v1", RAVNIR_TTS_URL: "http://speech.local/v1", RAVNIR_TTS_VOICES: "af_heart, em_alex,", RAVNIR_TTS_VOICE: "af_heart" }),
    { stt: "server", tts: "server", voices: ["af_heart", "em_alex"], voice: "af_heart", maxSeconds: 120 },
  );
  // Only the TTS half set: speech in stays with the browser.
  assert.equal(voiceConfig({ RAVNIR_TTS_URL: "http://speech.local/v1" }).stt, "browser");
  assert.equal(voiceConfig({ RAVNIR_TTS_URL: "http://speech.local/v1" }).voice, "alloy");
});

test("recorded clips get a file name the speech server can decode", () => {
  assert.equal(audioFileName("audio/webm;codecs=opus"), "speech.webm");
  assert.equal(audioFileName("audio/mp4"), "speech.mp4");
  assert.equal(audioFileName("audio/aac"), "speech.m4a");
  assert.equal(audioFileName(""), "speech.webm");
});

test("voice routes proxy to the speech server, keep the limits, and fail plainly", async () => {
  clearVoiceEnv();
  const speech = await fakeSpeech();
  process.env.RAVNIR_STT_URL = speech.url;
  process.env.RAVNIR_STT_MODEL = "test-stt";
  process.env.RAVNIR_STT_API_KEY = "stt-secret";
  process.env.RAVNIR_TTS_URL = speech.url;
  process.env.RAVNIR_TTS_MODEL = "test-tts";
  process.env.RAVNIR_TTS_API_KEY = "tts-secret";
  process.env.RAVNIR_TTS_VOICE = "af_heart";
  process.env.RAVNIR_TTS_VOICES = "af_heart,em_alex";
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-voice-"));
  const server = createApp({ home, projectRoot });
  const base = await listen(server);
  try {
    const config = await (await fetch(`${base}/api/voice/config`)).json();
    assert.deepEqual(config, { stt: "server", tts: "server", voices: ["af_heart", "em_alex"], voice: "af_heart", maxSeconds: 120 });

    // Speech in: the raw clip goes out as multipart with the model, the language hint and the key.
    const clip = Buffer.from("fake-webm-clip-0123456789");
    const heard = await fetch(`${base}/api/voice/transcribe?lang=es`, {
      method: "POST",
      headers: { "content-type": "audio/webm;codecs=opus" },
      body: clip,
    });
    assert.equal(heard.status, 200);
    const transcript = await heard.json();
    assert.equal(transcript.text, "hola, ¿me oyes?");
    assert.equal(typeof transcript.ms, "number");
    const sent = speech.seen.transcribe.at(-1);
    assert.equal(sent.auth, "Bearer stt-secret");
    assert.match(sent.type, /^multipart\/form-data; boundary=/);
    assert.match(sent.body, /name="model"\r\n\r\ntest-stt\r\n/);
    assert.match(sent.body, /name="language"\r\n\r\nes\r\n/);
    assert.match(sent.body, /filename="speech\.webm"/);
    assert.match(sent.body, /Content-Type: audio\/webm\r\n\r\nfake-webm-clip-0123456789/);

    // Speech out: the text goes to /audio/speech and the audio streams back with its type.
    const spoken = await fetch(`${base}/api/voice/speak`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Hola  **mundo**", lang: "es" }),
    });
    assert.equal(spoken.status, 200);
    assert.equal(spoken.headers.get("content-type"), "audio/mpeg");
    assert.deepEqual([...Buffer.from(await spoken.arrayBuffer())], [1, 2, 3, 4, 5]);
    const said = speech.seen.speak.at(-1);
    assert.equal(said.auth, "Bearer tts-secret");
    assert.deepEqual(said.body, { model: "test-tts", input: "Hola **mundo**", voice: "af_heart", response_format: "mp3" });

    // Limits and bad input answer with JSON errors.
    const longText = await fetch(`${base}/api/voice/speak`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "a".repeat(MAX_SPEAK_CHARS + 1) }),
    });
    assert.equal(longText.status, 413);
    assert.match((await longText.json()).error, /too long/);
    const noText = await fetch(`${base}/api/voice/speak`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(noText.status, 400);
    const empty = await fetch(`${base}/api/voice/transcribe`, { method: "POST", headers: { "content-type": "audio/webm" }, body: Buffer.alloc(0) });
    assert.equal(empty.status, 400);
    const huge = await fetch(`${base}/api/voice/transcribe`, {
      method: "POST",
      headers: { "content-type": "audio/webm" },
      body: Buffer.alloc(MAX_AUDIO_BYTES + 1),
    }).catch(() => null);
    assert.ok(!huge || huge.status === 413, "an oversized clip is refused");
    if (huge) assert.match((await huge.json()).error, /too large/);

    // A dead speech server gives a short message, not its body.
    process.env.RAVNIR_TTS_URL = "http://127.0.0.1:1/v1";
    const dead = await fetch(`${base}/api/voice/speak`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Hola" }) });
    assert.equal(dead.status, 502);
    assert.match((await dead.json()).error, /text-to-speech server did not answer/);
  } finally {
    clearVoiceEnv();
    await close(server);
    await close(speech.server);
  }
});

test("without speech servers the config says the browser speaks and listens, and no route pretends otherwise", async () => {
  clearVoiceEnv();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-voice-browser-"));
  const server = createApp({ home, projectRoot });
  const base = await listen(server);
  try {
    assert.deepEqual(await (await fetch(`${base}/api/voice/config`)).json(), { stt: "browser", tts: "browser", voices: [], voice: "", maxSeconds: 120 });
    const speak = await fetch(`${base}/api/voice/speak`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Hola" }) });
    assert.equal(speak.status, 503);
    const transcribe = await fetch(`${base}/api/voice/transcribe`, { method: "POST", headers: { "content-type": "audio/webm" }, body: Buffer.from("x") });
    assert.equal(transcribe.status, 503);
  } finally {
    await close(server);
  }
});

test("voice routes need the same sign-in as every other API", async () => {
  clearVoiceEnv();
  process.env.RAVNIR_USER = "owner";
  process.env.RAVNIR_PASSWORD = "test-password";
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-voice-auth-"));
  const server = createApp({ home, projectRoot });
  const base = await listen(server);
  try {
    assert.equal((await fetch(`${base}/api/voice/config`)).status, 401);
    const anonymous = await fetch(`${base}/api/voice/speak`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Hola" }) });
    assert.equal(anonymous.status, 401);
    const audio = await fetch(`${base}/api/voice/transcribe`, { method: "POST", headers: { "content-type": "audio/webm" }, body: Buffer.from("x") });
    assert.equal(audio.status, 401);
    assert.equal((await fetch(`${base}/api/voice/config`, { headers: basic("owner", "test-password") })).status, 200);
  } finally {
    delete process.env.RAVNIR_USER;
    delete process.env.RAVNIR_PASSWORD;
    await close(server);
  }
});

test("a message sent by voice is marked as voice in the thread and the reply still comes", async () => {
  clearVoiceEnv();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-voice-turn-"));
  const mock = await startMock();
  const server = createApp({ home, projectRoot });
  const base = await listen(server);
  const call = async (method, route, body) => {
    const response = await fetch(`${base}${route}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || response.statusText);
    return data;
  };
  try {
    const created = await call("POST", "/api/bots", {
      name: "Voice Tester",
      job: "Checks voice messages.",
      model: { provider: "openai", baseUrl: mock.url, model: "mock-model" },
    });
    const id = created.bot.id;
    const typed = await call("POST", `/api/bots/${id}/messages`, { text: "Typed hello" });
    const voiced = await call("POST", `/api/bots/${id}/messages`, { text: "Spoken hello", via: "voice" });
    let cursor = 0;
    const turnEnds = [];
    for (let attempt = 0; attempt < 200 && turnEnds.length < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const data = await call("GET", `/api/bots/${id}/events?after=${cursor}`);
      cursor = data.cursor;
      turnEnds.push(...data.events.filter((event) => event.type === "turn.end"));
    }
    assert.equal(turnEnds.length, 2);
    const voiceEnd = turnEnds.find((event) => event.turnId === voiced.turnId);
    assert.match(voiceEnd.messages.map((message) => message.content).join("\n"), /Mock reply: Spoken hello/);
    const detail = await call("GET", `/api/bots/${id}`);
    const userMessages = detail.conversation.filter((message) => message.role === "user");
    const spoken = userMessages.find((message) => message.content === "Spoken hello");
    const typedMessage = userMessages.find((message) => message.content === "Typed hello");
    assert.equal(spoken.via, "voice");
    assert.equal(typedMessage.via, undefined);
    assert.ok(typed.turnId);
  } finally {
    await close(server);
    await mock.close();
  }
});

test("replies are cleaned for the ear: no markdown, code or raw links", () => {
  const markdown = [
    "## Plan",
    "",
    "I'll check the **budget** in [the sheet](https://docs.example.com/x) and send `npm test` output.",
    "",
    "- First item",
    "- Second item:",
    "",
    "```js",
    "console.log(1)",
    "```",
    "",
    "See https://example.com/a for more.",
  ].join("\n");
  assert.equal(
    speakableText(markdown),
    `Plan. I'll check the budget in the sheet and send npm test output. First item. Second item. ${CODE_NOTE} See the link in the chat for more.`,
  );
  assert.equal(speakableText("| name | total |\n|---|---|\n| rent | 900 |"), "name, total. rent, 900.");
  assert.equal(speakableText("Use <b>bold</b> and ![the chart](https://x.io/c.png) here."), "Use bold and the chart here.");
  assert.equal(speakableText("Unclosed fence:\n```\nlet x = 1"), `Unclosed fence. ${CODE_NOTE}`);
  assert.equal(speakableText(""), "");
});

// Voice mode read a cited note aloud as "people slash Alex M D" (2026-10-26).
test("file paths are not read aloud: citations go, a path in a sentence is said as its name", () => {
  assert.equal(
    speakableText("One fixed item: **Ravnir launches Friday, Oct 30** (People/Alex.md). Also set up: weekday 8am digest."),
    "One fixed item: Ravnir launches Friday, Oct 30. Also set up: weekday 8am digest.",
  );
  assert.equal(speakableText("The launch is on Friday 30 Oct (People/Alex.md, saved today)."), "The launch is on Friday 30 Oct.");
  assert.equal(speakableText("Want me to open a `Projects/Ravnir-Launch.md` with a plan?"), "Want me to open a Ravnir Launch with a plan?");
  assert.equal(speakableText("Guardado en Perfil/Alex.md y en Decisiones/Año-2026.md."), "Guardado en Alex y en Año 2026.");
  assert.equal(speakableText("I changed server/models.js and Node.js stays. See Alex.md."), "I changed models.js and Node.js stays. See Alex.");
  assert.equal(speakableText("Use 1/2 cup and e.g. v2.6 (and/or more)."), "Use 1/2 cup and e.g. v2.6 (and/or more).");
  assert.equal(speakableText("Read https://hf.co/hexgrad/Kokoro-82M today."), "Read the link in the chat today.");
});

test("long replies are capped on a sentence and say the rest is in the chat", () => {
  const long = "Ya tengo el resumen del mes. ".repeat(60);
  const spoken = speakableText(long);
  assert.ok(spoken.length <= 1200, `got ${spoken.length}`);
  assert.ok(spoken.endsWith(CUT_NOTE));
  assert.match(spoken, /Ya tengo el resumen del mes\. The rest is in the chat\.$/);
  // A reply with no punctuation still ends cleanly.
  const plain = capForSpeech("palabra ".repeat(300).trim(), 200);
  assert.ok(plain.length <= 200);
  assert.ok(plain.endsWith(`. ${CUT_NOTE}`));
  // Short replies are left alone.
  assert.equal(speakableText("Vale, lo miro."), "Vale, lo miro.");
});

test("speech is split into sentence-sized pieces, short ones joined, long ones broken", () => {
  const chunks = speechChunks("Hola. Esto es una prueba larga para comprobar el corte de frases en el oído humano. Ok. Bien.");
  assert.deepEqual(chunks, ["Hola. Esto es una prueba larga para comprobar el corte de frases en el oído humano.", "Ok. Bien."]);
  const words = Array.from({ length: 120 }, (_, index) => `palabra${index}`).join(" ");
  const pieces = speechChunks(words, { max: 240 });
  assert.ok(pieces.length > 1);
  for (const piece of pieces) assert.ok(piece.length <= 240, `piece of ${piece.length}`);
  assert.equal(pieces.join(" "), words);
});

test("the spoken language follows the words, with accents as a strong sign", () => {
  assert.equal(detectLanguage("Vale. Reviso el gasto de octubre y te preparo un resumen."), "es");
  assert.equal(detectLanguage("¿Qué tal va el presupuesto?"), "es");
  assert.equal(detectLanguage("Okay. I'll pull October's spend and compare it with the budget."), "en");
  assert.equal(detectLanguage(""), "en");
});

test("a spoken turn waits longer when the sentence is clearly not finished", async () => {
  const { turnWait } = await import("../public/speakable.js");
  assert.equal(turnWait("Revisa mis correos de hoy."), 1600);
  assert.equal(turnWait("Quiero que revises los correos y"), 2800);
  assert.equal(turnWait("I was thinking about the plan, but"), 2800);
  assert.equal(turnWait("Mira,"), 2800);
  assert.equal(turnWait("Oye"), 2200);
  assert.equal(turnWait(""), 1600);
});
