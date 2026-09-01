import type { ParticleTarget } from '../types';

export type TargetArrays = Pick<
  ParticleTarget,
  'positions' | 'normals' | 'colors' | 'sizes' | 'alphas' | 'scatter'
>;

export function createTargetArrays(count: number): TargetArrays {
  return {
    positions: new Float32Array(count * 3),
    normals: new Float32Array(count * 3),
    colors: new Float32Array(count * 3),
    sizes: new Float32Array(count),
    alphas: new Float32Array(count),
    scatter: new Float32Array(count * 3),
  };
}

export function writeVector(array: Float32Array, index: number, x: number, y: number, z: number) {
  const offset = index * 3;
  array[offset] = x;
  array[offset + 1] = y;
  array[offset + 2] = z;
}

export function normalizeVector(x: number, y: number, z: number): [number, number, number] {
  const length = Math.hypot(x, y, z) || 1;
  return [x / length, y / length, z / length];
}

export function calculateBounds(positions: Float32Array): ParticleTarget['bounds'] {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let offset = 0; offset < positions.length; offset += 3) {
    const x = positions[offset];
    const y = positions[offset + 1];
    const z = positions[offset + 2];
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    maxZ = Math.max(maxZ, z);
  }
  const center: [number, number, number] = [
    (minX + maxX) / 2,
    (minY + maxY) / 2,
    (minZ + maxZ) / 2,
  ];
  let radius = 0;
  for (let offset = 0; offset < positions.length; offset += 3) {
    radius = Math.max(radius, Math.hypot(
      positions[offset] - center[0],
      positions[offset + 1] - center[1],
      positions[offset + 2] - center[2],
    ));
  }
  return { center, radius };
}

export function centerPositions(positions: Float32Array): ParticleTarget['bounds'] {
  const original = calculateBounds(positions);
  for (let offset = 0; offset < positions.length; offset += 3) {
    positions[offset] -= original.center[0];
    positions[offset + 1] -= original.center[1];
    positions[offset + 2] -= original.center[2];
  }
  return { center: [0, 0, 0], radius: original.radius };
}

export function writeScatter(array: Float32Array, index: number, random: () => number) {
  const theta = random() * Math.PI * 2;
  const z = random() * 2 - 1;
  const radial = Math.sqrt(Math.max(0, 1 - z * z));
  const magnitude = 0.6 + random() * 0.8;
  writeVector(array, index, Math.cos(theta) * radial * magnitude, Math.sin(theta) * radial * magnitude, z * magnitude);
}
