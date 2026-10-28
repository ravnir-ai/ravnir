// Voice mode for the agent thread. A mic in the composer dictates one message.
// The Voice sheet listens hands-free: it sends what you say to the current
// agent, speaks the quick plan as soon as it arrives, speaks the final reply,
// and listens again. Speech runs on the server when RAVNIR_STT_URL and
// RAVNIR_TTS_URL are set, otherwise on the browser's own speech engines. With
// ElevenLabs connected, the sheet streams the mic to Scribe realtime and
// replies are spoken by ElevenLabs.
import { detectLanguage, speakableText, speechChunks, takeSentences, turnWait } from "/speakable.js";

const MIC = { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } };
const RECORD_TYPES = ["audio/webm;codecs=opus", "audio/mp4", "audio/aac"];
const TICK_MS = 40;
const START_FRAMES = 3; // about 120 ms above the threshold before it counts as speech
const BARGE_FRAMES = 7; // about 280 ms of louder sound interrupts a reply
const SILENCE_MS = 1500; // quiet this long ends an utterance (energy detection)
const VOICE_HOLD_MS = 900; // sound on the mic this recently means you are still talking: keep waiting
const SCRIBE_SILENCE_MS = 1000; // the pause Scribe waits before it commits a phrase (vad_silence_threshold_secs)
const RECOG_FAILS = ["not-allowed", "service-not-allowed", "network"];
const FAST_TIMEOUT_MS = 12_000; // the server falls back after 8 s; this only guards a dead connection
const MIN_SPEECH_MS = 400; // shorter blips are ignored
const MAX_UTTERANCE_MS = 120_000;
const PHASE_LINE = { idle: "Tap to talk", listening: "Listening", thinking: "Thinking", working: "Working on it", speaking: "Speaking" };
const PHASE_LABEL = { idle: "Start talking", listening: "Send what you said", thinking: "Waiting for the reply", working: "Working on it, you can keep talking", speaking: "Interrupt" };
const SVG = {
  mic: '<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="7.5" y="2.5" width="5" height="9" rx="2.5"></rect><path d="M4.5 9.5a5.5 5.5 0 0 0 11 0M10 15v2.5"></path></svg>',
};

const $ = (id) => document.getElementById(id);
const synth = "speechSynthesis" in window ? window.speechSynthesis : null;
const RecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition || null;
const AudioCtor = window.AudioContext || window.webkitAudioContext || null;

let config = { stt: "browser", tts: "browser", voices: [], voice: "" };
let els = null;

// One session at a time: the sheet (mode "talk") or the composer mic (mode "dictate").
const session = {
  mode: "",
  bot: null,
  stream: null,
  ctx: null,
  source: null,
  analyser: null,
  samples: null,
  timer: 0,
  floor: 0.004,
  inSpeech: false,
  speechStart: 0,
  lastVoiceAt: 0,
  lastLoudAt: 0, // last time the mic heard a voice, also while the recognizer listens
  liveCarry: "", // words heard before the browser restarted its recognizer on its own
  aboveFrames: 0,
  bargeFrames: 0,
  capture: null,
  transcribing: 0,
  turns: new Set(), // voice turns still waiting for a reply
  muted: new Set(), // turns the user talked over: their replies are not spoken
  delegated: new Set(), // agent turns started from a voice reply: their result is read aloud when done
  live: null, // the recognizer listening for the next utterance
  recogFailed: false, // the browser recognizer is unusable this session: use the server path
  replying: 0, // fast replies still streaming
  fastSeq: 0,
  fastIds: new Set(),
  pumpWait: 0,
  current: "",
  queue: [],
  speaking: false,
  playing: null,
  pumpId: 0,
  audio: null,
  silentUrl: "",
  lang: firstLang(),
  scribe: null, // the open ElevenLabs realtime connection, kept for the whole sheet
  scribeFailed: false, // realtime did not work this session: record and transcribe instead
};

// The language the browser recognizer starts in: the one you spoke last time,
// else Spanish when the device lists Spanish at all (an English iPhone used in
// Spanish would otherwise hear "Hola" and drop the rest).
function firstLang() {
  try {
    const saved = localStorage.getItem("ravnir.voiceLang");
    if (saved === "es" || saved === "en") return saved;
  } catch {
    // No storage: guess from the device.
  }
  const langs = navigator.languages?.length ? navigator.languages : [navigator.language || "en"];
  return langs.some((lang) => String(lang).toLowerCase().startsWith("es")) ? "es" : "en";
}

function rememberLang(text) {
  session.lang = detectLanguage(text);
  try {
    localStorage.setItem("ravnir.voiceLang", session.lang);
  } catch {
    // Not kept; the next session guesses again.
  }
}

const host = () => window.RavnirHost || { bot: () => null, send: async () => null, toast: () => {} };

function hasMic() {
  return Boolean(navigator.mediaDevices?.getUserMedia);
}

// The server records and transcribes when it has speech to text; the browser's
// recognizer is the fallback.
function sttMode() {
  if (config.stt === "server" && hasMic() && typeof window.MediaRecorder === "function") return "server";
  return RecognitionCtor ? "browser" : "";
}

function canListen() {
  return hasMic() && Boolean(sttMode());
}

function ttsMode() {
  if (config.tts === "server" && typeof Audio === "function") return "server";
  return synth ? "browser" : "";
}

function recordType() {
  return RECORD_TYPES.find((type) => window.MediaRecorder?.isTypeSupported?.(type)) || "";
}

// --- The thread's buttons ------------------------------------------------

// app.js calls this whenever the header changes. The buttons only show when an agent is open and a mic exists.
export function sync(bot) {
  if (!els) return;
  const on = Boolean(bot) && canListen();
  els.voice.hidden = !on;
  els.mic.hidden = !on;
  if (!bot && session.mode === "talk") closeSheet();
}

// --- The Voice sheet -----------------------------------------------------

function openSheet() {
  const bot = host().bot();
  if (!bot || session.mode) return;
  // Taps unlock the audio engines. Browsers only allow sound inside a tap.
  unlockAudio();
  unlockSpeech();
  session.bot = bot;
  window.paintCreature?.(els.avatar, { ...bot, busy: false });
  els.name.textContent = bot.name;
  els.line.textContent = "";
  els.sheet.hidden = false;
  document.body.classList.add("voice-open");
  paintPhase("idle");
  els.orb.focus({ preventScroll: true });
}

function closeSheet() {
  if (!els) return;
  session.mode = "";
  cancelCapture();
  session.liveCarry = "";
  stopLive();
  closeScribe();
  session.scribeFailed = false;
  stopSpeaking();
  session.turns.clear();
  session.muted.clear();
  session.delegated.clear();
  session.fastIds.clear();
  clearTimeout(session.pumpWait);
  session.pumpWait = 0;
  els.sheet.hidden = true;
  document.body.classList.remove("voice-open");
  paintPhase("idle");
  if (session.audio) session.audio.pause();
  // The mic goes now, even if a clip is still being transcribed (it no longer needs the mic).
  releaseMic();
  if (session.ctx) session.ctx.close().catch(() => {});
  session.ctx = null;
  refreshMicButton();
}

function paintPhase(phase) {
  els.sheet.dataset.phase = phase;
  els.state.textContent = PHASE_LINE[phase];
  els.orb.setAttribute("aria-label", PHASE_LABEL[phase]);
  window.RavnirAvatar?.setState(els.avatar, phase === "thinking" || phase === "working" ? "working" : phase === "speaking" ? "speaking" : "");
  if (phase !== "speaking") stopMouth();
}

// Derived, not stored, so the sheet cannot disagree with what the engines are doing.
function refreshPhase() {
  if (!els) return;
  const phase = session.mode !== "talk" ? "idle"
    : session.speaking ? "speaking"
      : session.transcribing || session.replying || session.turns.size > session.delegated.size ? "thinking"
        : session.delegated.size ? "working" : "listening";
  paintPhase(phase);
  refreshMicButton();
}

function refreshMicButton() {
  if (!els) return;
  const active = session.mode === "dictate";
  els.mic.setAttribute("aria-pressed", active ? "true" : "false");
  els.mic.classList.toggle("recording", active && session.inSpeech);
}

function showLine(text, { error = false } = {}) {
  if (!els) return;
  els.line.textContent = text;
  els.line.classList.toggle("error", error);
}

function showError(message) {
  showLine(message, { error: true });
  host().toast(message, "error");
}

// --- Audio unlock --------------------------------------------------------

// A short silent WAV, played once inside a tap so the <audio> element may play later.
function silentWav() {
  const rate = 8000;
  const samples = 800;
  const buffer = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(buffer);
  const text = (offset, value) => {
    for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i));
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + samples * 2, true);
  text(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples * 2, true);
  return new Blob([buffer], { type: "audio/wav" });
}

function unlockAudio() {
  try {
    if (!session.audio) {
      session.audio = new Audio();
      session.audio.preload = "auto";
      session.audio.setAttribute("playsinline", "");
    }
    if (!session.silentUrl) session.silentUrl = URL.createObjectURL(silentWav());
    session.audio.src = session.silentUrl;
    session.audio.play().then(() => {
      if (session.audio.src === session.silentUrl) session.audio.pause();
    }).catch(() => {});
    if (AudioCtor && !session.ctx) session.ctx = new AudioCtor();
    if (session.ctx?.state === "suspended") session.ctx.resume().catch(() => {});
  } catch {
    // No audio engine: the sheet still shows text.
  }
}

function unlockSpeech() {
  if (!synth) return;
  try {
    const utterance = new SpeechSynthesisUtterance(" ");
    utterance.volume = 0;
    synth.speak(utterance);
  } catch {
    // Some browsers refuse; the reply then stays as text.
  }
}

// --- Microphone and level meter -------------------------------------------

async function ensureMic() {
  if (session.stream?.active && session.analyser) return;
  session.stream = await navigator.mediaDevices.getUserMedia(MIC);
  if (!session.ctx && AudioCtor) session.ctx = new AudioCtor();
  if (session.ctx?.state === "suspended") await session.ctx.resume().catch(() => {});
  if (!session.ctx) throw new Error("This browser cannot listen for speech.");
  session.source = session.ctx.createMediaStreamSource(session.stream);
  session.analyser = session.ctx.createAnalyser();
  session.analyser.fftSize = 1024;
  session.source.connect(session.analyser);
  session.samples = new Float32Array(session.analyser.fftSize);
}

// The microphone is held only while it is needed: an open sheet, or a dictation in progress.
function releaseMic() {
  stopTicking();
  session.stream?.getTracks().forEach((track) => track.stop());
  session.stream = null;
  session.source?.disconnect();
  session.source = null;
  session.analyser = null;
}

function startTicking() {
  if (!session.timer) session.timer = setInterval(tick, TICK_MS);
}

function stopTicking() {
  clearInterval(session.timer);
  session.timer = 0;
}

// Ends the session once nothing needs the mic: the sheet is closed, dictation is over, and no clip is still being finished.
function settle() {
  if (session.mode || session.capture || session.transcribing) return;
  releaseMic();
  refreshPhase();
}

function readLevel() {
  if (!session.analyser) return 0;
  session.analyser.getFloatTimeDomainData(session.samples);
  let sum = 0;
  for (const value of session.samples) sum += value * value;
  return Math.sqrt(sum / session.samples.length);
}

// Energy voice activity detection. The noise floor adapts while the room is quiet.
// While a reply plays, only a clearly louder voice counts, so the speaker's own sound does not trigger it.
function tick() {
  // Nothing to listen for once the talk sheet and the dictation are both done.
  if (!session.mode) return;
  const now = performance.now();
  const level = readLevel();
  if (els && session.mode === "talk") els.sheet.style.setProperty("--level", Math.min(1, level * 9).toFixed(3));
  const start = Math.max(session.floor * 3.5, 0.018);
  const loud = session.speaking ? Math.max(session.floor * 6, 0.05) : start;
  if (level < start) session.floor = session.floor * 0.95 + level * 0.05;
  if (!session.speaking && level > start * 0.8) session.lastLoudAt = now;
  session.aboveFrames = level > loud ? session.aboveFrames + 1 : 0;
  session.bargeFrames = session.speaking && level > loud ? session.bargeFrames + 1 : 0;
  if (!session.inSpeech && session.aboveFrames >= START_FRAMES && !usesLive()) beginSpeech(now);
  if (session.inSpeech) {
    if (level > loud * 0.6) session.lastVoiceAt = now;
    if (now - session.lastVoiceAt >= SILENCE_MS || now - session.speechStart >= MAX_UTTERANCE_MS) endSpeech();
  }
  if (session.speaking && session.bargeFrames >= BARGE_FRAMES) interruptSpeech();
}

// --- Utterances ------------------------------------------------------------

function beginSpeech(now) {
  session.inSpeech = true;
  session.speechStart = now - START_FRAMES * TICK_MS;
  session.lastVoiceAt = now;
  session.bargeFrames = 0;
  session.capture = startCapture();
  refreshPhase();
}

function endSpeech() {
  if (!session.inSpeech) return;
  session.inSpeech = false;
  const capture = session.capture;
  session.capture = null;
  const spokenMs = session.lastVoiceAt - session.speechStart;
  // A dictation is one message: once its speech ends, the mic is done.
  if (session.mode === "dictate") session.mode = "";
  if (capture) finishCapture(capture, spokenMs);
  refreshPhase();
}

function startCapture() {
  const mode = session.mode;
  if (sttMode() === "server") {
    const type = recordType();
    let recorder;
    try {
      recorder = new MediaRecorder(session.stream, type ? { mimeType: type } : undefined);
    } catch {
      recorder = new MediaRecorder(session.stream);
    }
    const chunks = [];
    recorder.ondataavailable = (event) => {
      if (event.data?.size) chunks.push(event.data);
    };
    recorder.start(250);
    return { kind: "server", mode, recorder, chunks };
  }
  if (RecognitionCtor && !session.recogFailed) return { kind: "browser", mode, ...startRecognizer() };
  return null;
}

function cancelCapture() {
  const capture = session.capture;
  session.capture = null;
  session.inSpeech = false;
  if (!capture) return;
  if (capture.kind === "server") {
    capture.recorder.onstop = null;
    try {
      capture.recorder.stop();
    } catch {
      // Already stopped.
    }
  } else {
    capture.cancel();
  }
}

function stopRecorder(capture) {
  return new Promise((resolve) => {
    const { recorder, chunks } = capture;
    const done = () => resolve(new Blob(chunks, { type: recorder.mimeType || "audio/webm" }));
    if (recorder.state === "inactive") return done();
    recorder.onstop = done;
    try {
      recorder.stop();
    } catch {
      done();
    }
  });
}

// The browser's own recognizer. It runs until we stop it, so the pauses between sentences are ours to judge.
function startRecognizer() {
  const recognizer = new RecognitionCtor();
  recognizer.lang = session.lang === "es" ? "es-ES" : "en-US";
  recognizer.interimResults = true;
  recognizer.continuous = true;
  let finals = "";
  let interim = "";
  recognizer.onresult = (event) => {
    interim = "";
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i];
      if (result.isFinal) finals += `${result[0].transcript} `;
      else interim += result[0].transcript;
    }
    if (session.mode === "talk") showLine(`${finals}${interim}`.trim());
  };
  const ended = new Promise((resolve) => {
    recognizer.onend = resolve;
    recognizer.onerror = resolve;
  });
  try {
    recognizer.start();
  } catch {
    // Already running: the recognizer just keeps going.
  }
  return {
    stop: async () => {
      try {
        recognizer.stop();
      } catch {
        // Already stopped.
      }
      await ended;
      return `${finals} ${interim}`.trim();
    },
    cancel: () => {
      try {
        recognizer.abort();
      } catch {
        // Already stopped.
      }
    },
  };
}

// No language hint: people switch between Spanish and English, and Whisper
// detects the language better than a guess from the last reply.
async function transcribeBlob(blob) {
  const response = await fetch("/api/voice/transcribe", {
    method: "POST",
    headers: { "content-type": blob.type || "audio/webm" },
    body: blob,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Speech did not come through.");
  return String(data.text || "").trim();
}

async function finishCapture(capture, spokenMs) {
  const keep = spokenMs >= MIN_SPEECH_MS;
  let text = "";
  session.transcribing += 1;
  try {
    if (capture.kind === "server") {
      const blob = await stopRecorder(capture);
      if (keep && blob.size) text = await transcribeBlob(blob);
    } else {
      const heard = await capture.stop();
      if (keep) text = heard;
    }
  } catch (error) {
    session.transcribing -= 1;
    showError(error.message || "Speech did not come through.");
    settle();
    return;
  }
  session.transcribing -= 1;
  // The sheet was closed while this was being heard: drop it rather than send it later.
  const stillOpen = capture.mode !== "talk" || session.mode === "talk";
  if (keep && !text && stillOpen) showLine("I did not catch that. Try again.");
  if (text && stillOpen) await deliver(text, capture.mode);
  settle();
}

// Sends what was said through the same path as a typed message, marked as voice.
async function deliver(text, mode) {
  if (mode === "talk") return deliverTalk(text);
  rememberLang(text);
  if (mode === "talk") showLine(`You: ${text}`);
  const sent = await host().send(text, "voice");
  if (!sent?.turnId) {
    showError("Could not send that. Try again.");
    return;
  }
  if (mode === "talk") session.turns.add(sent.turnId);
  refreshPhase();
}

// --- Live listening and fast replies ----------------------------------------

// In talk mode the browser's own recognizer (Apple dictation on iPhone) shows the
// words as they come. The turn ends only after a real pause: 1.6 s with no new
// words (longer after "and", "pero" or a comma) and no sound on the mic. iPhone
// marks phrases final at every small pause and restarts itself, so neither ends
// the turn: the words carry over to the next recognizer.
function usesScribe() {
  return config.live === "elevenlabs" && !session.scribeFailed && Boolean(AudioCtor && window.AudioWorkletNode && window.WebSocket);
}

function usesLive() {
  if (session.mode !== "talk") return false;
  if (config.live === "elevenlabs") return usesScribe();
  return Boolean(RecognitionCtor) && !session.recogFailed;
}

function startLive() {
  if (!usesLive() || session.live || session.speaking || !session.analyser) return;
  if (usesScribe()) return startScribeLive();
  const recognizer = new RecognitionCtor();
  recognizer.lang = session.lang === "es" ? "es-ES" : "en-US";
  recognizer.interimResults = true;
  recognizer.continuous = true;
  const carry = session.liveCarry;
  const live = { recognizer, text: carry, timer: 0, failed: false };
  session.live = live;
  recognizer.onresult = (event) => {
    let text = carry ? `${carry} ` : "";
    for (let i = 0; i < event.results.length; i += 1) text += `${event.results[i][0].transcript} `;
    text = text.trim();
    if (!text || text === live.text || session.live !== live) return;
    live.text = text;
    showLine(text);
    armLive(live);
  };
  recognizer.onerror = (event) => {
    if (RECOG_FAILS.includes(event?.error)) live.failed = true;
  };
  recognizer.onend = () => {
    if (session.live !== live) return;
    clearTimeout(live.timer);
    session.live = null;
    if (live.failed) {
      // Fall back to recording and the server's speech to text for the rest of the session.
      session.recogFailed = true;
      if (sttMode() !== "server") showError("Speech recognition is not available in this browser.");
      return;
    }
    // Browsers end recognition on their own after a pause or a no-speech error.
    // Keep what was said and listen again; the quiet timer decides when the turn is over.
    session.liveCarry = live.text.trim();
    setTimeout(() => {
      startLive();
      if (session.live && session.liveCarry) armLive(session.live);
    }, 150);
  };
  try {
    recognizer.start();
  } catch {
    session.live = null;
  }
}

function stopLive() {
  const live = session.live;
  if (!live) return;
  session.live = null;
  clearTimeout(live.timer);
  if (live.kind === "scribe") return releaseScribeLive(live);
  try {
    live.recognizer.abort();
  } catch {
    // Already stopped.
  }
}

// --- ElevenLabs realtime --------------------------------------------------

// One WebSocket to Scribe for as long as the sheet is open. The mic streams
// into it all the time; while a reply plays, or between turns, it gets silence
// instead, so the speaker's own voice is never transcribed and Scribe can
// close the phrase it was on. Scribe sends partial text as you speak and
// commits a phrase at each pause; the turn itself still ends on our own wait
// (turnWait plus no sound on the mic), so a pause mid-sentence does not cut you off.
async function openScribe() {
  if (session.scribe) {
    // Another call is connecting it: wait for that one. A failed one is gone from session.scribe.
    await session.scribe.ready?.catch(() => {});
    return session.scribe;
  }
  const scribe = { ws: null, node: null, sink: null, ready: null, live: null, consumed: "", failures: session.scribe?.failures || 0, closing: false };
  session.scribe = scribe;
  scribe.ready = (async () => {
    const ctx = session.ctx;
    if (!ctx.pcmReady) ctx.pcmReady = ctx.audioWorklet.addModule("/pcm-worklet.js");
    await ctx.pcmReady;
    const response = await fetch("/api/voice/realtime", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.url) throw new Error(data.error || "ElevenLabs did not start.");
    const ws = new WebSocket(data.url);
    scribe.ws = ws;
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error("Could not reach ElevenLabs."));
    });
    // The sheet closed while this was connecting.
    if (scribe.closing || !session.source) {
      ws.close();
      return;
    }
    ws.onmessage = (event) => onScribeMessage(scribe, event.data);
    ws.onclose = () => onScribeClose(scribe);
    ws.onerror = null;
    const node = new AudioWorkletNode(ctx, "pcm-capture");
    const sink = ctx.createGain();
    sink.gain.value = 0;
    node.connect(sink);
    sink.connect(ctx.destination);
    session.source.connect(node);
    node.port.onmessage = (event) => sendPcm(scribe, event.data);
    scribe.node = node;
    scribe.sink = sink;
  })();
  try {
    await scribe.ready;
  } catch (error) {
    closeScribe();
    scribeTrouble(error.message);
    return null;
  }
  return scribe;
}

function sendPcm(scribe, buffer) {
  if (scribe.ws?.readyState !== WebSocket.OPEN) return;
  // Silence unless someone is meant to be heard right now.
  const bytes = new Uint8Array(buffer);
  if (!scribe.live || session.speaking) bytes.fill(0);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x2000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x2000));
  scribe.ws.send(JSON.stringify({ message_type: "input_audio_chunk", audio_base_64: btoa(binary), commit: false, sample_rate: 16000 }));
}

// Text Scribe already gave us in a turn we sent: drop it from what comes next.
function withoutConsumed(scribe, text) {
  const consumed = scribe.consumed;
  if (!consumed) return text;
  if (text.startsWith(consumed)) return text.slice(consumed.length).trim();
  return consumed.startsWith(text) ? "" : text;
}

function onScribeMessage(scribe, raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }
  const type = message.message_type;
  if (type === "partial_transcript" || type === "committed_transcript") {
    const text = withoutConsumed(scribe, String(message.text || "").trim());
    if (type === "committed_transcript") scribe.consumed = "";
    const live = scribe.live;
    if (!live || session.live !== live) return;
    if (type === "committed_transcript") {
      live.committed = `${live.committed} ${text}`.trim();
      live.partial = "";
    } else {
      live.partial = text;
    }
    const combined = `${live.committed} ${live.partial}`.trim();
    if (!combined || combined === live.text) return;
    live.text = combined;
    showLine(combined);
    armLive(live, type === "committed_transcript" ? SCRIBE_SILENCE_MS : 0);
    return;
  }
  if (type === "error" || /_error$|exceeded|limited|overflow|exhausted|unaccepted_terms|invalid_request/.test(type || "")) {
    const fatal = ["auth_error", "quota_exceeded", "unaccepted_terms", "invalid_request"].includes(type);
    if (fatal) {
      session.scribeFailed = true;
      closeScribe();
      scribeTrouble(type === "quota_exceeded" ? "Your ElevenLabs quota is used up." : type === "auth_error" ? "ElevenLabs rejected the key." : "ElevenLabs refused the session.");
    }
  }
}

// Scribe closed on its own (time limit, network): open a new one while the sheet is still up.
function onScribeClose(scribe) {
  if (session.scribe !== scribe || scribe.closing) return;
  const live = scribe.live;
  closeScribe();
  if (session.mode !== "talk") return;
  const failures = scribe.failures + 1;
  if (failures >= 3) {
    session.scribeFailed = true;
    scribeTrouble("Lost ElevenLabs.");
    return;
  }
  setTimeout(async () => {
    if (session.mode !== "talk" || session.scribe) return;
    const next = await openScribe();
    if (next) next.failures = failures;
    if (next && live && session.live === live) {
      next.live = live;
      live.committed = live.text;
      live.partial = "";
    }
  }, 400 * failures);
}

function closeScribe() {
  const scribe = session.scribe;
  if (!scribe) return;
  session.scribe = null;
  scribe.closing = true;
  try {
    session.source?.disconnect(scribe.node);
  } catch {
    // Already disconnected.
  }
  scribe.node?.disconnect();
  scribe.sink?.disconnect();
  if (scribe.node) scribe.node.port.onmessage = null;
  try {
    scribe.ws?.close();
  } catch {
    // Already closed.
  }
}

// Realtime is out for this session: the sheet falls back to recording each
// phrase and transcribing it with ElevenLabs on the server.
function scribeTrouble(message) {
  session.scribeFailed = true;
  if (session.live?.kind === "scribe") stopLive();
  showError(`${message} Switching to slower listening.`);
}

function startScribeLive() {
  const live = { kind: "scribe", text: "", committed: "", partial: "", timer: 0 };
  session.live = live;
  openScribe().then((scribe) => {
    if (!scribe || session.live !== live) return;
    scribe.live = live;
  });
  // Until the socket is up nothing is sent; the words start with the first chunk after.
}

function releaseScribeLive(live) {
  const scribe = session.scribe;
  if (!scribe || scribe.live !== live) return;
  scribe.live = null;
  // The phrase still open at Scribe was already used: its final copy is dropped.
  if (live.partial) scribe.consumed = live.partial;
}

// Waits for the end of the turn: no new words for turnWait(text) and no voice on the mic.
// `credit` is quiet time already counted elsewhere: Scribe commits a phrase only
// after its own second of silence, so that second is not waited twice.
function armLive(live, credit = 0) {
  clearTimeout(live.timer);
  live.timer = setTimeout(() => {
    if (session.live !== live) return;
    if (performance.now() - session.lastLoudAt < VOICE_HOLD_MS) return armLive(live);
    commitLive();
  }, Math.max(300, turnWait(live.text) - credit));
}

function commitLive() {
  const live = session.live;
  if (!live) return;
  const text = live.text.trim();
  session.liveCarry = "";
  stopLive();
  if (text) deliverTalk(text);
  startLive();
}

// Sends the words to the fast reply route and speaks the answer sentence by
// sentence as it arrives. Real work comes back later as an agent turn.
async function deliverTalk(text) {
  const bot = session.bot || host().bot();
  if (!bot) return;
  rememberLang(text);
  showLine(`You: ${text}`);
  const fastId = `fast-${++session.fastSeq}`;
  session.fastIds.add(fastId);
  session.replying += 1;
  refreshPhase();
  let heard = false;
  let finished = false;
  let buffer = "";
  const speakNow = (final) => {
    const { sentences, rest } = takeSentences(buffer, { final });
    buffer = rest;
    for (const sentence of sentences) say(sentence, fastId);
  };
  const handle = (line) => {
    let item;
    try {
      item = JSON.parse(line);
    } catch {
      return;
    }
    if (item.type === "delta" && item.text) {
      heard = true;
      buffer += item.text;
      speakNow(false);
    } else if (item.type === "done") {
      finished = true;
      speakNow(true);
      if (item.turnId) {
        session.turns.add(item.turnId);
        if (item.delegated) session.delegated.add(item.turnId);
      }
    } else if (item.type === "error" && !heard) {
      throw new Error(item.error || "The quick reply failed.");
    }
  };
  try {
    const response = await fetch(`/api/bots/${encodeURIComponent(bot.id)}/voice/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(FAST_TIMEOUT_MS + 60_000),
    });
    if (!response.ok || !response.body) throw new Error("The quick reply failed.");
    const decoder = new TextDecoder();
    let pending = "";
    for await (const part of response.body) {
      pending += decoder.decode(part, { stream: true });
      let newline;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        if (line) handle(line);
      }
    }
    if (pending.trim()) handle(pending.trim());
    if (!finished) speakNow(true);
  } catch (error) {
    speakNow(true);
    // Nothing came back: send it the ordinary way so the message is not lost.
    if (!heard && !finished) {
      const sent = await host().send(text, "voice").catch(() => null);
      if (sent?.turnId) session.turns.add(sent.turnId);
      else showError(error.message || "Could not send that. Try again.");
    }
  } finally {
    session.replying -= 1;
    refreshPhase();
  }
}

// --- Replies ---------------------------------------------------------------

function lastReply(messages) {
  const replies = (messages || []).filter((message) => message.role === "assistant" && message.kind !== "ack" && String(message.content || "").trim());
  return replies.length ? String(replies.at(-1).content) : "";
}

// app.js passes every event of the open agent here. Only voice turns are spoken.
export function onEvent(event) {
  if (!els || !event?.turnId || !session.turns.has(event.turnId)) return;
  if (event.type === "turn.end") {
    session.turns.delete(event.turnId);
    const delegated = session.delegated.delete(event.turnId);
    if (session.muted.has(event.turnId) && !delegated) return refreshPhase();
    const reply = lastReply(event.messages);
    if (reply) say(reply, event.turnId);
    else if (event.error) showError(event.error);
    return refreshPhase();
  }
  if (event.type === "ack" && event.message?.content && !session.muted.has(event.turnId)) say(event.message.content, event.turnId);
}

function say(text, turnId) {
  if (session.muted.has(turnId)) return;
  const chunks = speechChunks(speakableText(text));
  if (!chunks.length) return;
  const lang = detectLanguage(text);
  for (const chunk of chunks) session.queue.push({ text: chunk, lang, turnId });
  pump();
}

// Someone talking, or words still being recognised, comes first: a reply waits for them to finish.
function userTalking() {
  return session.mode === "talk" && (session.inSpeech || Boolean(session.live?.text.trim()));
}

async function pump() {
  if (session.speaking) return;
  if (userTalking()) {
    if (!session.pumpWait) session.pumpWait = setTimeout(() => { session.pumpWait = 0; pump(); }, 300);
    return;
  }
  session.speaking = true;
  stopLive(); // the recognizer must not hear the voice that is playing
  const token = ++session.pumpId;
  refreshPhase();
  while (session.queue.length && token === session.pumpId) {
    const item = session.queue.shift();
    session.current = item.turnId;
    if (session.muted.has(item.turnId)) {
      if (item.clip) item.clip.then((url) => url && URL.revokeObjectURL(url));
      continue;
    }
    await speakItem(item, token);
  }
  if (token === session.pumpId) {
    session.speaking = false;
    startLive();
  }
  refreshPhase();
}

async function speakItem(item, token) {
  if (ttsMode() === "server") {
    // Start the next clip while this one plays, so the gaps stay short.
    const next = session.queue[0];
    item.clip ||= fetchClip(item);
    if (next && !next.clip) next.clip = fetchClip(next);
    const url = await item.clip;
    if (token !== session.pumpId) {
      if (url) URL.revokeObjectURL(url);
      return;
    }
    if (url) return playUrl(url, await item.envelope);
    // The speech server failed: this chunk still gets spoken by the browser.
  }
  if (token === session.pumpId) await speakBrowser(item);
}

// The voice picked in Settings (this device). Empty means the server's default.
function chosenVoice() {
  try {
    const voice = localStorage.getItem("ravnir.voice");
    return voice ? { voice } : {};
  } catch {
    return {};
  }
}

function fetchClip(item) {
  return fetch("/api/voice/speak", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: item.text, lang: item.lang, ...chosenVoice() }),
  })
    .then(async (response) => {
      if (!response.ok) throw new Error("The voice server did not answer.");
      const blob = await response.blob();
      item.envelope = envelopeOf(blob);
      return URL.createObjectURL(blob);
    })
    .catch(() => "");
}

// --- The avatar's mouth -----------------------------------------------------
// It follows the reply: the clip's own loudness for server voices (decoded on the side, so the
// audio path is untouched), word boundaries for the browser's voice.
const ENVELOPE_MS = 20;
const mouth = { timer: 0, pulse: 0 };

async function envelopeOf(blob) {
  try {
    const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!Offline) return null;
    const buffer = await new Offline(1, 1, 22050).decodeAudioData(await blob.arrayBuffer());
    const data = buffer.getChannelData(0);
    const step = Math.max(1, Math.round((buffer.sampleRate * ENVELOPE_MS) / 1000));
    const levels = new Float32Array(Math.ceil(data.length / step));
    let peak = 0;
    for (let index = 0; index < levels.length; index += 1) {
      let sum = 0;
      const end = Math.min(data.length, (index + 1) * step);
      for (let sample = index * step; sample < end; sample += 1) sum += data[sample] * data[sample];
      levels[index] = Math.sqrt(sum / Math.max(1, end - index * step));
      peak = Math.max(peak, levels[index]);
    }
    if (peak > 0) for (let index = 0; index < levels.length; index += 1) levels[index] = Math.min(1, levels[index] / (peak * 0.8));
    return { levels, stepMs: ENVELOPE_MS };
  } catch {
    return null;
  }
}

function moveMouth(level) {
  if (els) window.RavnirAvatar?.speak?.(els.avatar, level);
}

function followClip(audio, envelope) {
  stopMouth();
  let smooth = 0;
  mouth.timer = setInterval(() => {
    const levels = envelope?.levels;
    const raw = levels ? levels[Math.min(levels.length - 1, Math.floor((audio.currentTime * 1000) / envelope.stepMs))] || 0 : 0.45;
    smooth += (raw - smooth) * 0.6;
    moveMouth(smooth);
  }, TICK_MS);
}

function followWords() {
  stopMouth();
  mouth.pulse = 0;
  mouth.timer = setInterval(() => {
    mouth.pulse *= 0.78;
    moveMouth(mouth.pulse);
  }, TICK_MS);
}

function stopMouth() {
  clearInterval(mouth.timer);
  mouth.timer = 0;
  moveMouth(0);
}

function playUrl(url, envelope) {
  return new Promise((resolve) => {
    const audio = session.audio || (session.audio = new Audio());
    const finish = () => {
      audio.onended = null;
      audio.onerror = null;
      audio.onplaying = null;
      stopMouth();
      session.playing = null;
      URL.revokeObjectURL(url);
      resolve();
    };
    session.playing = { stop: () => { audio.pause(); finish(); } };
    audio.onended = finish;
    audio.onerror = finish;
    audio.onplaying = () => followClip(audio, envelope);
    audio.src = url;
    audio.play().catch(finish);
  });
}

function pickVoice(lang) {
  const prefix = lang === "es" ? "es" : "en";
  const voices = synth.getVoices();
  return voices.find((voice) => voice.lang?.toLowerCase().startsWith(prefix) && voice.localService)
    || voices.find((voice) => voice.lang?.toLowerCase().startsWith(prefix))
    || null;
}

function speakBrowser(item) {
  return new Promise((resolve) => {
    if (!synth) return resolve();
    const utterance = new SpeechSynthesisUtterance(item.text);
    utterance.lang = item.lang === "es" ? "es-ES" : "en-US";
    const voice = pickVoice(item.lang);
    if (voice) utterance.voice = voice;
    // Some engines never report the end; a watchdog keeps the loop moving.
    let guard = 0;
    const finish = () => {
      clearTimeout(guard);
      stopMouth();
      session.playing = null;
      resolve();
    };
    guard = setTimeout(finish, 4000 + item.text.length * 150);
    utterance.onstart = followWords;
    utterance.onboundary = () => { mouth.pulse = 0.95; };
    utterance.onend = finish;
    utterance.onerror = finish;
    session.playing = { stop: () => { synth.cancel(); finish(); } };
    synth.speak(utterance);
  });
}

// The user talked over the reply, or tapped the circle: stop, mute the replies still to come, and listen.
function interruptSpeech() {
  if (!session.speaking && !session.queue.length) return;
  // Only what is playing or queued is muted. A task still running keeps its result for later.
  const ids = new Set([...session.queue.map((item) => item.turnId), session.current]);
  for (const id of ids) if (id && !session.delegated.has(id)) session.muted.add(id);
  stopSpeaking();
}

function stopSpeaking() {
  for (const item of session.queue) if (item.clip) item.clip.then((url) => url && URL.revokeObjectURL(url));
  session.queue.length = 0;
  session.pumpId += 1;
  session.speaking = false;
  session.playing?.stop();
  session.playing = null;
  synth?.cancel();
  startLive();
  if (els) refreshPhase();
}

// --- Taps ------------------------------------------------------------------

async function startTalking() {
  if (!host().bot() || session.mode) return;
  // Create and resume the audio engines inside this tap, before the microphone prompt can take the gesture.
  unlockAudio();
  unlockSpeech();
  session.mode = "talk";
  refreshPhase();
  try {
    await ensureMic();
  } catch {
    session.mode = "";
    showError("Microphone access is off. Allow it in the browser settings, then tap again.");
    refreshPhase();
    settle();
    return;
  }
  if (session.mode !== "talk") return;
  startTicking();
  startLive();
  refreshPhase();
}

function onOrbTap() {
  if (session.mode !== "talk") return startTalking();
  if (session.speaking) return interruptSpeech();
  if (session.live?.text.trim()) return commitLive();
  if (session.inSpeech) return endSpeech();
  return undefined;
}

async function toggleDictation() {
  if (session.mode === "talk") return;
  if (session.mode === "dictate") {
    if (session.inSpeech) return endSpeech();
    session.mode = "";
    cancelCapture();
    refreshMicButton();
    return settle();
  }
  const bot = host().bot();
  if (!bot) return;
  unlockAudio();
  session.mode = "dictate";
  refreshMicButton();
  try {
    await ensureMic();
  } catch {
    session.mode = "";
    refreshMicButton();
    host().toast("Microphone access is off. Allow it in the browser settings.", "error");
    return;
  }
  if (session.mode !== "dictate") return settle();
  startTicking();
  refreshMicButton();
}

// --- Setup -----------------------------------------------------------------

function bind() {
  els = {
    mic: $("mic-btn"),
    voice: $("voice-btn"),
    sheet: $("voice-sheet"),
    avatar: $("voice-avatar"),
    name: $("voice-name"),
    state: $("voice-state"),
    line: $("voice-line"),
    orb: $("voice-orb"),
    end: $("voice-end"),
  };
  if (!els.mic || !els.voice || !els.sheet) return;
  els.mic.innerHTML = SVG.mic;
  els.voice.hidden = true;
  els.mic.hidden = true;
  els.voice.addEventListener("click", openSheet);
  els.end.addEventListener("click", closeSheet);
  els.orb.addEventListener("click", onOrbTap);
  els.mic.addEventListener("click", toggleDictation);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && session.mode === "talk") closeSheet();
  });
  // Leaving the page releases the microphone and ends the call.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      closeSheet();
      if (session.mode === "dictate") {
        session.mode = "";
        cancelCapture();
        settle();
      }
    }
  });
}

async function loadConfig() {
  try {
    const response = await fetch("/api/voice/config");
    if (response.ok) config = { stt: "browser", tts: "browser", voices: [], voice: "", ...(await response.json()) };
  } catch {
    // Without the config the browser engines are used.
  }
  sync(host().bot());
}

window.RavnirVoice = { sync, onEvent, open: openSheet, reload: loadConfig };
bind();
loadConfig();
