// Turns the microphone into 16 kHz 16-bit PCM for realtime speech to text.
// Runs on the audio thread and posts about 100 ms of audio at a time.
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.pos = 0;
    this.out = new Int16Array(1600);
    this.fill = 0;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    // Linear interpolation from the device rate (44.1 or 48 kHz) down to 16 kHz.
    while (this.pos < input.length - 1) {
      const i = Math.floor(this.pos);
      const frac = this.pos - i;
      const value = input[i] + (input[i + 1] - input[i]) * frac;
      const clipped = Math.max(-1, Math.min(1, value));
      this.out[this.fill++] = clipped < 0 ? clipped * 0x8000 : clipped * 0x7fff;
      if (this.fill === this.out.length) {
        this.port.postMessage(this.out.buffer, [this.out.buffer]);
        this.out = new Int16Array(1600);
        this.fill = 0;
      }
      this.pos += this.ratio;
    }
    this.pos -= input.length - 1;
    return true;
  }
}

registerProcessor("pcm-capture", PcmCapture);
