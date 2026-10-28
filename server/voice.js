// Voice mode: speech to text and text to speech through an OpenAI-compatible
// server (Speaches, VoiceStudio, or any /v1 endpoint). Without the env vars the
// browser does the speaking and listening itself. Settings are read on every
// call, so the env is the only thing to change.

export const MAX_AUDIO_BYTES = 15 * 1024 * 1024;
export const MAX_SPEAK_CHARS = 1500;
const TIMEOUT_MS = 30_000;
const LANG = /^[a-z]{2}(?:-[A-Za-z]{2,4})?$/;
const EXTENSIONS = { webm: "webm", mp4: "mp4", m4a: "m4a", aac: "m4a", mpeg: "mp3", mp3: "mp3", ogg: "ogg", wav: "wav", flac: "flac" };

function clean(value) {
  return String(value || "").trim();
}

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

// Which engine does each half of voice mode: the server when its URL is set,
// otherwise the browser.
export function voiceConfig(env = process.env) {
  const stt = clean(env.RAVNIR_STT_URL) ? "server" : "browser";
  const tts = clean(env.RAVNIR_TTS_URL) ? "server" : "browser";
  return {
    stt,
    tts,
    voices: clean(env.RAVNIR_TTS_VOICES).split(",").map((voice) => voice.trim()).filter(Boolean),
    voice: tts === "server" ? clean(env.RAVNIR_TTS_VOICE) || "alloy" : "",
    maxSeconds: 120,
  };
}

function endpoint(base, route) {
  return `${base.replace(/\/+$/, "")}/${route}`;
}

function auth(token) {
  return clean(token) ? { authorization: `Bearer ${clean(token)}` } : {};
}

// A fetch to the speech server with a timeout and plain errors. The upstream
// body is never passed on, so a server error page cannot leak into the UI.
async function upstream(url, init, { label, setting }) {
  let response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") throw httpError(`The ${label} server took too long.`, 504);
    throw httpError(`The ${label} server did not answer. Check ${setting}.`, 502);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw httpError(`The ${label} server returned ${response.status}. Check ${setting}.`, 502);
  }
  return response;
}

// The base type of a recorded clip ("audio/webm;codecs=opus" becomes "audio/webm").
export function baseType(type) {
  return clean(type).split(";")[0].toLowerCase();
}

// OpenAI-style servers pick the decoder from the file name, so it must match the clip.
export function audioFileName(type) {
  const sub = baseType(type).replace(/^audio\//, "");
  return `speech.${EXTENSIONS[sub] || "webm"}`;
}

export async function transcribe({ audio, type = "", lang = "", env = process.env }) {
  const base = clean(env.RAVNIR_STT_URL);
  if (!base) throw httpError("Speech to text on the server is not set up.", 503);
  if (!audio?.length) throw httpError("The recording is empty.", 400);
  if (audio.length > MAX_AUDIO_BYTES) throw httpError("The recording is too large.", 413);
  const form = new FormData();
  form.append("file", new Blob([audio], { type: baseType(type) || "audio/webm" }), audioFileName(type));
  form.append("model", clean(env.RAVNIR_STT_MODEL) || "whisper-1");
  form.append("response_format", "json");
  if (LANG.test(clean(lang))) form.append("language", clean(lang));
  const started = Date.now();
  const response = await upstream(endpoint(base, "audio/transcriptions"), {
    method: "POST",
    headers: auth(env.RAVNIR_STT_API_KEY),
    body: form,
  }, { label: "speech-to-text", setting: "RAVNIR_STT_URL" });
  const data = await response.json().catch(() => null);
  if (!data || typeof data.text !== "string") throw httpError("The speech server sent no text.", 502);
  return { text: data.text.trim(), ms: Date.now() - started };
}

// Returns the upstream Response so the caller can stream the audio on.
export async function speak({ text, voice = "", lang = "", env = process.env }) {
  const base = clean(env.RAVNIR_TTS_URL);
  if (!base) throw httpError("Text to speech on the server is not set up.", 503);
  const input = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!input) throw httpError("Nothing to say.", 400);
  if (input.length > MAX_SPEAK_CHARS) throw httpError("That text is too long to speak.", 413);
  // A Spanish-only voice can be set for Spanish replies; otherwise the voice is the one asked for.
  const spanish = clean(lang) === "es" ? clean(env.RAVNIR_TTS_VOICE_ES) : "";
  const body = {
    model: clean(env.RAVNIR_TTS_MODEL) || "tts-1",
    input,
    voice: clean(voice) || spanish || clean(env.RAVNIR_TTS_VOICE) || "alloy",
    response_format: "mp3",
  };
  return upstream(endpoint(base, "audio/speech"), {
    method: "POST",
    headers: { "content-type": "application/json", ...auth(env.RAVNIR_TTS_API_KEY) },
    body: JSON.stringify(body),
  }, { label: "text-to-speech", setting: "RAVNIR_TTS_URL" });
}

// Reads a raw audio body (not JSON) with the size cap.
export function readAudio(req, limit = MAX_AUDIO_BYTES) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"] || 0);
    if (declared > limit) {
      req.resume();
      reject(httpError("The recording is too large.", 413));
      return;
    }
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(httpError("The recording is too large.", 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks, size)));
    req.on("error", reject);
  });
}
