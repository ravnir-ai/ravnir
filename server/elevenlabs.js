// ElevenLabs as the voice of voice mode: Scribe listens (realtime over a
// WebSocket from the browser, batch for the composer mic) and Flash speaks.
// Anyone running Ravnir connects it by pasting their own API key in
// Settings; the key is kept in the encrypted secret store and never reaches
// the browser. The browser only gets a single-use token for one realtime session.

const KEY = "server:elevenlabs";
const TIMEOUT_MS = 30_000;
const VOICES_TTL_MS = 10 * 60_000;
const MAX_SPEAK_CHARS = 1500;
const LANG = /^[a-z]{2,3}$/;

function clean(value) {
  return String(value || "").trim();
}

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export class ElevenLabs {
  constructor({ secrets, env = process.env, fetchImpl = (...args) => fetch(...args) }) {
    this.secrets = secrets;
    this.env = env;
    this.fetch = fetchImpl;
    this.cache = null; // { at, voices }
  }

  get base() {
    return clean(this.env.RAVNIR_ELEVENLABS_URL).replace(/\/+$/, "") || "https://api.elevenlabs.io";
  }

  get saved() {
    return this.secrets.get(KEY, null) || null;
  }

  connected() {
    return Boolean(this.saved?.apiKey);
  }

  // What the browser may know: never the key.
  async status() {
    if (!this.connected()) return { connected: false, voices: [], voice: "" };
    const voices = await this.voices().catch(() => []);
    return { connected: true, voices, voice: this.saved.voice || voices[0]?.id || "" };
  }

  async #call(route, init = {}, { key = this.saved?.apiKey, label = "ElevenLabs" } = {}) {
    if (!key) throw httpError("ElevenLabs is not connected. Add your API key in Settings.", 409);
    let response;
    try {
      response = await this.fetch(`${this.base}${route}`, {
        ...init,
        headers: { "xi-api-key": key, ...(init.headers || {}) },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      if (error?.name === "TimeoutError" || error?.name === "AbortError") throw httpError(`${label} took too long.`, 424);
      throw httpError("Could not reach ElevenLabs.", 424);
    }
    if (response.ok) return response;
    // The upstream body is read for the reason only, never passed on.
    const detail = await response.text().catch(() => "");
    if (response.status === 401) {
      const missing = /missing_permissions|permission/i.test(detail);
      throw httpError(missing
        ? "ElevenLabs refused: the key is missing a permission. Give it Text to Speech, Speech to Text and Voices (read)."
        : "ElevenLabs rejected the key.", 400);
    }
    if (response.status === 429 || /quota/i.test(detail)) throw httpError("ElevenLabs says the quota or rate limit is used up.", 429);
    throw httpError(`ElevenLabs returned ${response.status}.`, 424);
  }

  // Checks the key with a real call before it is saved.
  async connect(apiKey) {
    const key = clean(apiKey);
    if (!key) throw httpError("Paste your ElevenLabs API key.", 400);
    if (key.length > 400 || /\s/.test(key)) throw httpError("That does not look like an ElevenLabs API key.", 400);
    const voices = await this.#listVoices(key);
    const previous = this.saved?.voice;
    const voice = voices.some((item) => item.id === previous) ? previous : pickDefault(voices);
    this.secrets.set(KEY, { apiKey: key, voice });
    this.cache = { at: Date.now(), voices };
    return this.status();
  }

  disconnect() {
    this.secrets.delete(KEY);
    this.cache = null;
  }

  setVoice(voice) {
    const id = clean(voice);
    if (!this.connected()) throw httpError("ElevenLabs is not connected.", 400);
    if (!/^[A-Za-z0-9]{8,64}$/.test(id)) throw httpError("Pick a voice from the list.", 400);
    this.secrets.set(KEY, { ...this.saved, voice: id });
  }

  async voices() {
    if (this.cache && Date.now() - this.cache.at < VOICES_TTL_MS) return this.cache.voices;
    const voices = await this.#listVoices(this.saved?.apiKey);
    this.cache = { at: Date.now(), voices };
    return voices;
  }

  async #listVoices(key) {
    const response = await this.#call("/v1/voices", {}, { key });
    const data = await response.json().catch(() => ({}));
    return (Array.isArray(data.voices) ? data.voices : [])
      .filter((item) => item?.voice_id)
      .map((item) => ({
        id: String(item.voice_id),
        name: String(item.name || item.voice_id).slice(0, 80),
        accent: clean(item.labels?.accent || item.labels?.language).slice(0, 40),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  // A ready-to-open WebSocket address for one realtime session. The token is
  // single use and expires in 15 minutes, so a leaked address is worth little.
  async realtimeUrl({ lang = "" } = {}) {
    const response = await this.#call("/v1/single-use-token/realtime_scribe", { method: "POST" });
    const data = await response.json().catch(() => ({}));
    if (!data.token) throw httpError("ElevenLabs sent no token.", 424);
    const params = new URLSearchParams({
      model_id: "scribe_v2_realtime",
      token: data.token,
      audio_format: "pcm_16000",
      commit_strategy: clean(this.env.RAVNIR_ELEVENLABS_COMMIT) || "vad",
      vad_silence_threshold_secs: clean(this.env.RAVNIR_ELEVENLABS_SILENCE) || "1.0",
    });
    const language = clean(this.env.RAVNIR_ELEVENLABS_LANGUAGE) || (LANG.test(clean(lang)) ? clean(lang) : "");
    if (language) params.set("language_code", language);
    const ws = this.base.replace(/^http/, "ws");
    return { url: `${ws}/v1/speech-to-text/realtime?${params}`, sampleRate: 16000 };
  }

  // Batch speech to text for a recorded clip (the composer mic).
  async transcribe({ audio, type = "audio/webm", name = "speech.webm", lang = "" }) {
    if (!audio?.length) throw httpError("The recording is empty.", 400);
    const form = new FormData();
    form.append("model_id", clean(this.env.RAVNIR_ELEVENLABS_STT_MODEL) || "scribe_v2");
    form.append("file", new Blob([audio], { type }), name);
    if (LANG.test(clean(lang))) form.append("language_code", clean(lang));
    form.append("tag_audio_events", "false");
    const started = Date.now();
    const response = await this.#call("/v1/speech-to-text", { method: "POST", body: form }, { label: "ElevenLabs speech to text" });
    const data = await response.json().catch(() => null);
    if (!data || typeof data.text !== "string") throw httpError("ElevenLabs sent no text.", 424);
    return { text: data.text.trim(), ms: Date.now() - started };
  }

  // Returns the upstream Response so the caller can stream the mp3 on.
  async speak({ text, lang = "" }) {
    const input = String(text ?? "").replace(/\s+/g, " ").trim();
    if (!input) throw httpError("Nothing to say.", 400);
    if (input.length > MAX_SPEAK_CHARS) throw httpError("That text is too long to speak.", 413);
    let voice = this.saved?.voice;
    if (!voice) voice = pickDefault(await this.voices());
    if (!voice) throw httpError("Your ElevenLabs account has no voices.", 400);
    const body = { text: input, model_id: clean(this.env.RAVNIR_ELEVENLABS_TTS_MODEL) || "eleven_flash_v2_5" };
    if (LANG.test(clean(lang))) body.language_code = clean(lang);
    return this.#call(`/v1/text-to-speech/${encodeURIComponent(voice)}/stream?output_format=mp3_44100_64`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }, { label: "ElevenLabs text to speech" });
  }
}

// The first voice in the list is alphabetical, not a choice; prefer one made
// for many languages, since replies switch between Spanish and English.
function pickDefault(voices) {
  return (voices.find((item) => /multilingual|spanish|español|castilian|peninsular|latin|mexican|^es(?:-|$)/i.test(item.accent)) || voices[0])?.id || "";
}
