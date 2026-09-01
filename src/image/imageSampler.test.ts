import { describe, expect, it } from 'vitest';
import { pixelsToParticleTarget } from './imageSampler';

function gradientPixels(width: number, height: number) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      pixels[offset] = x / (width - 1) * 255;
      pixels[offset + 1] = y / (height - 1) * 180;
      pixels[offset + 2] = 80;
      pixels[offset + 3] = 255;
    }
  }
  return pixels;
}

describe('pixelsToParticleTarget', () => {
  it('creates a deterministic, evenly covered relief with controlled depth', () => {
    const pixels = gradientPixels(16, 12);
    const first = pixelsToParticleTarget(pixels, 16, 12, 2000, 'gradient', 42);
    const second = pixelsToParticleTarget(pixels, 16, 12, 2000, 'gradient', 42);
    const depths = Array.from({ length: first.count }, (_, index) => first.positions[index * 3 + 2]);
    expect(first.kind).toBe('image');
    expect(first.positions).toEqual(second.positions);
    expect(Math.max(...depths) - Math.min(...depths)).toBeGreaterThan(0.08);
    expect(Math.max(...depths) - Math.min(...depths)).toBeLessThan(0.21);
    const quadrants = [0, 0, 0, 0];
    for (let index = 0; index < first.count; index += 1) {
      const x = first.positions[index * 3];
      const y = first.positions[index * 3 + 1];
      const quadrant = (x >= 0 ? 1 : 0) + (y >= 0 ? 2 : 0);
      quadrants[quadrant] += 1;
    }
    expect(Math.min(...quadrants)).toBeGreaterThan(first.count * 0.18);
    expect(first.normals.length).toBe(first.count * 3);
    expect(first.bounds.center).toEqual([0, 0, 0]);
  });

  it('does not create a full rectangular plate around transparent content', () => {
    const pixels = new Uint8ClampedArray(12 * 12 * 4);
    for (let y = 4; y <= 7; y += 1) {
      for (let x = 4; x <= 7; x += 1) {
        const offset = (y * 12 + x) * 4;
        pixels[offset] = 240;
        pixels[offset + 1] = 90;
        pixels[offset + 2] = 120;
        pixels[offset + 3] = 255;
      }
    }
    const target = pixelsToParticleTarget(pixels, 12, 12, 1000, 'transparent', 7);
    let halfWidth = 0;
    for (let offset = 0; offset < target.positions.length; offset += 3) halfWidth = Math.max(halfWidth, Math.abs(target.positions[offset]));
    expect(halfWidth).toBeLessThan(0.75);
  });
});
