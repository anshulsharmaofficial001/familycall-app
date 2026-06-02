class PCMRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.targetRate = 16000;
    this.ratio = sampleRate / this.targetRate;
    this.nextIndex = 0;
    this.pending = [];
    this.chunkSize = 2048;
    this.muted = false;
    this.port.onmessage = (event) => {
      if (event.data && event.data.type === 'mute') this.muted = !!event.data.muted;
    };
  }

  process(inputs, outputs) {
    const output = outputs[0] && outputs[0][0];
    if (output) output.fill(0);

    const input = inputs[0] && inputs[0][0];
    if (!input || this.muted) return true;

    let i = this.nextIndex;
    while (i < input.length) {
      const s = Math.max(-1, Math.min(1, input[Math.floor(i)]));
      this.pending.push(s < 0 ? s * 0x8000 : s * 0x7fff);
      i += this.ratio;
    }
    this.nextIndex = i - input.length;

    while (this.pending.length >= this.chunkSize) {
      const chunk = new Int16Array(this.pending.splice(0, this.chunkSize));
      this.port.postMessage({ type: 'pcm', buffer: chunk.buffer }, [chunk.buffer]);
    }

    return true;
  }
}

registerProcessor('pcm-recorder', PCMRecorder);
