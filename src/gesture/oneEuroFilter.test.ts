import { describe, expect, it } from 'vitest';
import { OneEuroFilter } from './oneEuroFilter';

function rms(values: number[]) {
  return Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length);
}

describe('OneEuroFilter', () => {
  it('reduces stationary jitter by at least sixty percent', () => {
    const filter = new OneEuroFilter({ minCutoff: 1.2, beta: 0.08 });
    const raw: number[] = [];
    const filtered: number[] = [];
    for (let frame = 0; frame < 120; frame += 1) {
      const jitter = Math.sin(frame * 2.31) * 0.018 + Math.sin(frame * 0.73) * 0.009;
      raw.push(jitter);
      filtered.push(filter.filter(jitter, frame * 33));
    }
    expect(rms(filtered.slice(20))).toBeLessThan(rms(raw.slice(20)) * 0.4);
  });

  it('responds to a deliberate step within four video frames', () => {
    const filter = new OneEuroFilter({ minCutoff: 1.2, beta: 0.08 });
    for (let frame = 0; frame < 20; frame += 1) filter.filter(0, frame * 33);
    let reachedAt = Infinity;
    for (let frame = 0; frame < 8; frame += 1) {
      if (filter.filter(1, (20 + frame) * 33) >= 0.7 && reachedAt === Infinity) reachedAt = frame;
    }
    expect(reachedAt).toBeLessThanOrEqual(4);
  });
});
