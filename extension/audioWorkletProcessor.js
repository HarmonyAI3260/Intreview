class PCM16ResamplerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.targetSampleRate = 16000;
    this.channelIndex = 0;
    this.buffer = [];
    this.residual = 0;
  }

  static get parameterDescriptors() {
    return [];
  }

  process(inputs, _outputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channelData = input[this.channelIndex] || input[0];
    if (!channelData) return true;

    const inputSampleRate = sampleRate; // AudioWorklet global
    const ratio = inputSampleRate / this.targetSampleRate;

    // Simple linear resampler
    const resampled = [];
    let i = 0;
    while (i < channelData.length) {
      const idx = Math.floor((resampled.length + this.residual) * ratio);
      if (idx >= channelData.length) break;
      resampled.push(channelData[idx]);
      i = idx + 1;
    }

    // Maintain fractional position across calls
    const totalProduced = resampled.length;
    const expectedConsumed = totalProduced * ratio;
    this.residual = (this.residual + (expectedConsumed - Math.floor(expectedConsumed))) % 1;

    // Convert to Int16 PCM
    const pcmBuffer = new ArrayBuffer(resampled.length * 2);
    const view = new DataView(pcmBuffer);
    for (let i2 = 0; i2 < resampled.length; i2++) {
      let s = Math.max(-1, Math.min(1, resampled[i2]));
      s = s < 0 ? s * 0x8000 : s * 0x7fff;
      view.setInt16(i2 * 2, s, true);
    }

    if (resampled.length > 0) {
      this.port.postMessage(pcmBuffer, [pcmBuffer]);
    }

    return true;
  }
}

registerProcessor('pcm16-resampler', PCM16ResamplerProcessor);