type OneEuroOptions = {
  minCutoff: number;
  beta: number;
  derivativeCutoff?: number;
};

class LowPassFilter {
  private initialized = false;
  private value = 0;

  filter(next: number, alpha: number) {
    if (!this.initialized) {
      this.initialized = true;
      this.value = next;
      return next;
    }
    this.value = alpha * next + (1 - alpha) * this.value;
    return this.value;
  }

  reset() {
    this.initialized = false;
    this.value = 0;
  }
}

export class OneEuroFilter {
  private readonly signal = new LowPassFilter();
  private readonly derivative = new LowPassFilter();
  private readonly minCutoff: number;
  private readonly beta: number;
  private readonly derivativeCutoff: number;
  private lastTimestamp: number | null = null;
  private lastRaw: number | null = null;

  constructor({ minCutoff, beta, derivativeCutoff = 1 }: OneEuroOptions) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.derivativeCutoff = derivativeCutoff;
  }

  private alpha(cutoff: number, deltaSeconds: number) {
    const timeConstant = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + timeConstant / Math.max(1 / 240, deltaSeconds));
  }

  filter(value: number, timestamp: number) {
    if (this.lastTimestamp === null || this.lastRaw === null) {
      this.lastTimestamp = timestamp;
      this.lastRaw = value;
      return this.signal.filter(value, 1);
    }
    const deltaSeconds = Math.max(1 / 240, Math.min(0.25, (timestamp - this.lastTimestamp) / 1000));
    const rawDerivative = (value - this.lastRaw) / deltaSeconds;
    const filteredDerivative = this.derivative.filter(rawDerivative, this.alpha(this.derivativeCutoff, deltaSeconds));
    const cutoff = this.minCutoff + this.beta * Math.abs(filteredDerivative);
    const output = this.signal.filter(value, this.alpha(cutoff, deltaSeconds));
    this.lastTimestamp = timestamp;
    this.lastRaw = value;
    return output;
  }

  reset() {
    this.signal.reset();
    this.derivative.reset();
    this.lastTimestamp = null;
    this.lastRaw = null;
  }
}
