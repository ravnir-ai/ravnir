import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createApp } from "../server/index.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.RAVNIR_AI_MEMORY = "off";

const GOOD = "sk_test_good_key_123";
const LIMITED = "sk_test_no_voices_read";

// A stand-in for api.elevenlabs.io that records what it was asked.
function fakeElevenLabs() {
  const seen = { stt: [], tts: [], tokens: 0 };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const key = req.headers["xi-api-key"];
    const json = (status, data) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    };
    if (key === LIMITED) return json(401, { detail: { status: "missing_permissions", message: "The API key is missing voices_read" } });
    if (key !== GOOD) return json(401, { detail: { status: "invalid_api_key", message: "Invalid API key: secret upstream text" } });
    if (req.url === "/v1/voices") {
      return json(200, { voices: [
        { voice_id: "zzVoiceRachel01", name: "Rachel", labels: { accent: "american" } },
        { voice_id: "aaVoiceLucia001", name: "Lucía", labels: { accent: "spanish" } },
      ] });
    }
    if (req.url === "/v1/single-use-token/realtime_scribe" && req.method === "POST") {
      seen.tokens += 1;
      return json(200, { token: `sutkn_${seen.tokens}` });
    }
    if (req.url === "/v1/speech-to-text" && req.method === "POST") {
      seen.stt.push({ type: req.headers["content-type"], body: body.toString("latin1") });
      return json(200, { text: "  hola buenos días  ", language_code: "es" });
    }
    const speak = /^\/v1\/text-to-speech\/([^/]+)\/stream\?(.*)$/.exec(req.url);
    if (speak && req.method === "POST") {
      seen.tts.push({ voice: speak[1], query: speak[2], body: JSON.parse(body.toString("utf8")) });
      res.writeHead(200, { "content-type": "audio/mpeg" });
      res.end(Buffer.from([9, 8, 7]));
      return;
    }
    json(404, { detail: "no such route" });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}`, seen })));
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

const put = (base, body) => fetch(`${base}/api/voice/elevenlabs`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("ElevenLabs connects with a checked key, never shows it, and takes over voice mode", async () => {
  for (const key of ["RAVNIR_STT_URL", "RAVNIR_TTS_URL", "RAVNIR_USER", "RAVNIR_PASSWORD"]) delete process.env[key];
  const eleven = await fakeElevenLabs();
  process.env.RAVNIR_ELEVENLABS_URL = eleven.url;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ravnir-eleven-"));
  const server = createApp({ home, projectRoot });
  const base = await listen(server);
  try {
    assert.deepEqual(await (await fetch(`${base}/api/voice/elevenlabs`)).json(), { connected: false, voices: [], voice: "" });
    assert.equal((await (await fetch(`${base}/api/voice/config`)).json()).stt, "browser");
    // Not connected: no realtime session and a plain message, not a crash.
    assert.equal((await fetch(`${base}/api/voice/realtime`, { method: "POST" })).status, 409);

    // A wrong key and a key without the voices permission are refused with plain words (and never as 401, which signs the user out).
    const wrong = await put(base, { apiKey: "sk_wrong" });
    assert.equal(wrong.status, 400);
    const wrongBody = await wrong.json();
    assert.equal(wrongBody.error, "ElevenLabs rejected the key.");
    assert.doesNotMatch(JSON.stringify(wrongBody), /secret upstream/);
    const limited = await put(base, { apiKey: LIMITED });
    assert.equal(limited.status, 400);
    assert.match((await limited.json()).error, /missing a permission/);
    assert.equal((await put(base, { apiKey: "has spaces in it" })).status, 400);
    assert.equal((await (await fetch(`${base}/api/voice/elevenlabs`)).json()).connected, false);

    const connected = await (await put(base, { apiKey: ` ${GOOD} ` })).json();
    assert.equal(connected.connected, true);
    assert.equal(connected.voice, "aaVoiceLucia001", "a Spanish or multilingual voice is preferred by default");
    assert.deepEqual(connected.voices.map((item) => item.name), ["Lucía", "Rachel"]);
    assert.doesNotMatch(JSON.stringify(connected), new RegExp(GOOD));
    // Stored encrypted, not in plain text on disk.
    assert.doesNotMatch(fs.readFileSync(path.join(home, "secrets.enc"), "utf8"), new RegExp(GOOD));

    const config = await (await fetch(`${base}/api/voice/config`)).json();
    assert.equal(config.live, "elevenlabs");
    assert.equal(config.stt, "server");
    assert.equal(config.tts, "server");

    // Realtime: a ready WebSocket address with a single-use token, never the key.
    const realtime = await (await fetch(`${base}/api/voice/realtime`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
    const ws = new URL(realtime.url);
    assert.equal(ws.protocol, "ws:");
    assert.equal(ws.pathname, "/v1/speech-to-text/realtime");
    assert.equal(ws.searchParams.get("token"), "sutkn_1");
    assert.equal(ws.searchParams.get("model_id"), "scribe_v2_realtime");
    assert.equal(ws.searchParams.get("audio_format"), "pcm_16000");
    assert.equal(ws.searchParams.get("commit_strategy"), "vad");
    assert.equal(ws.searchParams.get("language_code"), null, "no language hint: Scribe detects Spanish and English itself");
    assert.doesNotMatch(realtime.url, new RegExp(GOOD));

    // The composer mic: a recorded clip goes to batch Scribe.
    const heard = await (await fetch(`${base}/api/voice/transcribe`, { method: "POST", headers: { "content-type": "audio/webm;codecs=opus" }, body: Buffer.from("fake-clip") })).json();
    assert.equal(heard.text, "hola buenos días");
    assert.match(eleven.seen.stt[0].body, /name="model_id"\r\n\r\nscribe_v2/);
    assert.match(eleven.seen.stt[0].body, /filename="speech.webm"/);

    // Speaking: the chosen voice, Flash, and the language of the reply.
    const spoken = await fetch(`${base}/api/voice/speak`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Buenos días", lang: "es", voice: "af_heart" }) });
    assert.equal(spoken.status, 200);
    assert.equal(spoken.headers.get("content-type"), "audio/mpeg");
    assert.deepEqual([...Buffer.from(await spoken.arrayBuffer())], [9, 8, 7]);
    assert.equal(eleven.seen.tts[0].voice, "aaVoiceLucia001", "a Kokoro voice name from the old setting is ignored");
    assert.deepEqual(eleven.seen.tts[0].body, { text: "Buenos días", model_id: "eleven_flash_v2_5", language_code: "es" });
    assert.match(eleven.seen.tts[0].query, /output_format=mp3_44100_64/);

    // Picking another voice sticks; a made-up id is refused.
    assert.equal((await (await put(base, { voice: "zzVoiceRachel01" })).json()).voice, "zzVoiceRachel01");
    assert.equal((await put(base, { voice: "../etc" })).status, 400);
    await fetch(`${base}/api/voice/speak`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Hi" }) });
    assert.equal(eleven.seen.tts[1].voice, "zzVoiceRachel01");

    // Disconnecting hands voice mode back.
    const off = await (await fetch(`${base}/api/voice/elevenlabs`, { method: "DELETE" })).json();
    assert.equal(off.connected, false);
    assert.equal((await (await fetch(`${base}/api/voice/config`)).json()).live, undefined);
  } finally {
    delete process.env.RAVNIR_ELEVENLABS_URL;
    await close(server);
    await close(eleven.server);
  }
});
