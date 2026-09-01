import { describe, expect, it } from 'vitest';
import { createRoseTarget } from './roseTarget';

function axisSpan(values: Float32Array, axis: 0 | 1 | 2) {
  const coordinates: number[] = [];
  for (let offset = axis; offset < values.length; offset += 3) coordinates.push(values[offset]);
  return Math.max(...coordinates) - Math.min(...coordinates);
}

function rangeAxis(values: Float32Array, start: number, end: number, axis: 0 | 1 | 2) {
  let minimum = Infinity;
  let maximum = -Infinity;
  for (let index = start; index < end; index += 1) {
    const value = values[index * 3 + axis];
    minimum = Math.min(minimum, value);
    maximum = Math.max(maximum, value);
  }
  return { minimum, maximum, span: maximum - minimum };
}

describe('createRoseTarget', () => {
  it('creates a stable, complete target with the requested attributes', () => {
    const first = createRoseTarget(1024);
    const second = createRoseTarget(1024);
    expect(first.kind).toBe('rose');
    expect(first.count).toBe(1024);
    expect(first.positions.length).toBe(1024 * 3);
    expect(first.normals.length).toBe(1024 * 3);
    expect(first.scatter.length).toBe(1024 * 3);
    expect(first.sizes.length).toBe(1024);
    expect(first.colors).toEqual(second.colors);
    expect(first.positions).toEqual(second.positions);
  });

  it('has meaningful three-dimensional depth and red/green plant regions', () => {
    const target = createRoseTarget(4096);
    expect(axisSpan(target.positions, 0)).toBeGreaterThan(1.0);
    expect(axisSpan(target.positions, 1)).toBeGreaterThan(3.1);
    expect(axisSpan(target.positions, 2)).toBeGreaterThan(0.8);
    let redParticles = 0;
    let greenParticles = 0;
    for (let offset = 0; offset < target.colors.length; offset += 3) {
      const red = target.colors[offset];
      const green = target.colors[offset + 1];
      if (red > green * 1.7) redParticles += 1;
      if (green > red * 1.7) greenParticles += 1;
    }
    expect(redParticles / target.count).toBeGreaterThan(0.62);
    expect(greenParticles / target.count).toBeGreaterThan(0.25);
    expect(target.bounds.center).toEqual([0, 0, 0]);
    expect(Math.min(...target.alphas)).toBeGreaterThan(0);
    expect(Math.max(...target.alphas)).toBeLessThanOrEqual(1);
    let upwardNormals = 0;
    const flowerEnd = Math.floor(target.count * 0.68);
    for (let index = 0; index < flowerEnd; index += 1) {
      if (target.normals[index * 3 + 1] > 0.72) upwardNormals += 1;
    }
    expect(upwardNormals / flowerEnd).toBeGreaterThan(0.8);

    const centerCount = { inner: 0, outer: 0 };
    let innerHeight = 0;
    let outerHeight = 0;
    const innerCutoff = Math.floor(flowerEnd * 0.15);
    const outerStart = Math.floor(flowerEnd * 0.77);
    for (let index = 0; index < flowerEnd; index += 1) {
      const x = target.positions[index * 3];
      const y = target.positions[index * 3 + 1];
      const z = target.positions[index * 3 + 2];
      const radius = Math.hypot(x, z);
      if (index < innerCutoff && radius < 0.36) {
        centerCount.inner += 1;
        innerHeight += y;
      }
      if (index >= outerStart) {
        centerCount.outer += 1;
        outerHeight += y;
      }
    }
    expect(centerCount.inner / innerCutoff).toBeGreaterThan(0.72);
    expect(outerHeight / centerCount.outer).toBeGreaterThan(1.2);
  });

  it('forms a tall flower head with a broad square shoulder and tapered base', () => {
    const target = createRoseTarget(4096);
    const flowerEnd = Math.floor(target.count * 0.68);
    const xRange = rangeAxis(target.positions, 0, flowerEnd, 0);
    const yRange = rangeAxis(target.positions, 0, flowerEnd, 1);
    const zRange = rangeAxis(target.positions, 0, flowerEnd, 2);
    expect(yRange.span).toBeGreaterThan(1.0);
    expect(xRange.span).toBeLessThan(1.2);
    expect(zRange.span).toBeGreaterThan(0.55);

    const heights: number[] = [];
    for (let index = 0; index < flowerEnd; index += 1) heights.push(target.positions[index * 3 + 1]);
    const sortedHeights = [...heights].sort((a, b) => a - b);
    const bottomBand = sortedHeights[Math.floor(sortedHeights.length * 0.2)];
    const lower = sortedHeights[Math.floor(sortedHeights.length * 0.35)];
    const upper = sortedHeights[Math.floor(sortedHeights.length * 0.65)];
    let bottomRadius = 0;
    let bottomCount = 0;
    let middleRadius = 0;
    let middleCount = 0;
    let capRadius = 0;
    let capCount = 0;
    for (let index = 0; index < flowerEnd; index += 1) {
      const x = target.positions[index * 3];
      const y = target.positions[index * 3 + 1];
      const z = target.positions[index * 3 + 2];
      const radius = Math.hypot(x, z);
      if (y >= lower && y <= upper) {
        middleRadius += radius;
        middleCount += 1;
      }
      if (y <= bottomBand) {
        bottomRadius += radius;
        bottomCount += 1;
      }
      if (y >= sortedHeights[Math.floor(sortedHeights.length * 0.82)]) {
        capRadius += radius;
        capCount += 1;
      }
    }
    expect(bottomRadius / bottomCount).toBeLessThan(middleRadius / middleCount * 0.94);
    expect(middleRadius / middleCount).toBeGreaterThan(0.25);
    expect(capRadius / capCount).toBeGreaterThan(middleRadius / middleCount * 0.82);
    expect(capRadius / capCount).toBeLessThan(middleRadius / middleCount * 1.22);
  });

  it('keeps the dense inner petals centered on the flower axis', () => {
    const target = createRoseTarget(4096);
    const flowerEnd = Math.floor(target.count * 0.68);
    const coreEnd = Math.floor(flowerEnd * 0.28);
    let coreX = 0;
    let coreZ = 0;
    let bodyX = 0;
    let bodyZ = 0;
    for (let index = 0; index < coreEnd; index += 1) {
      coreX += target.positions[index * 3];
      coreZ += target.positions[index * 3 + 2];
    }
    for (let index = coreEnd; index < flowerEnd; index += 1) {
      bodyX += target.positions[index * 3];
      bodyZ += target.positions[index * 3 + 2];
    }
    expect(Math.abs(coreX / coreEnd - bodyX / (flowerEnd - coreEnd))).toBeLessThan(0.015);
    expect(Math.abs(coreZ / coreEnd - bodyZ / (flowerEnd - coreEnd))).toBeLessThan(0.015);
  });

  it('brings the lower petal roots back to one shared head root', () => {
    const target = createRoseTarget(4096);
    const flowerEnd = Math.floor(target.count * 0.68);
    const heights = Array.from({ length: flowerEnd }, (_, index) => target.positions[index * 3 + 1]);
    const rootCutoff = [...heights].sort((a, b) => a - b)[Math.floor(flowerEnd * 0.1)];
    let radiusTotal = 0;
    let rootCount = 0;
    let rootX = 0;
    let rootZ = 0;
    for (let index = 0; index < flowerEnd; index += 1) {
      const x = target.positions[index * 3];
      const z = target.positions[index * 3 + 2];
      if (target.positions[index * 3 + 1] <= rootCutoff) {
        radiusTotal += Math.hypot(x, z);
        rootX += x;
        rootZ += z;
        rootCount += 1;
      }
    }
    expect(radiusTotal / rootCount).toBeLessThan(0.12);
    expect(Math.abs(rootX / rootCount)).toBeLessThan(0.04);
    expect(Math.abs(rootZ / rootCount)).toBeLessThan(0.04);
  });
});
