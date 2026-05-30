// AudioWorklet processor for PCM16 playback
// Runs in audio thread — no garbage collection pauses
class PCMPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this._queue = [];
    this._offset = 0;
    this.port.onmessage = (e) => {
      if (e.data.type === 'chunk') {
        this._queue.push(e.data.samples);
      } else if (e.data.type === 'clear') {
        this._queue = [];
        this._offset = 0;
      }
    };
  }

  process(inputs, outputs) {
    const out = outputs[0][0];
    if (!out) return true;
    let written = 0;
    while (written < out.length) {
      if (!this._queue.length) { out.fill(0, written); break; }
      const chunk = this._queue[0];
      const available = chunk.length - this._offset;
      const needed = out.length - written;
      if (available <= needed) {
        out.set(chunk.subarray(this._offset), written);
        written += available;
        this._queue.shift();
        this._offset = 0;
      } else {
        out.set(chunk.subarray(this._offset, this._offset + needed), written);
        this._offset += needed;
        written = out.length;
      }
    }
    return true;
  }
}

registerProcessor('pcm-player', PCMPlayer);
