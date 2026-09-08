import type { ParticleTarget } from '../types';
import { calculateBounds, centerPositions, createTargetArrays, normalizeVector, writeScatter, writeVector } from '../particle/targetUtils';

function seededRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function cubicBezier(a: number, b: number, c: number, d: number, t: number) {
  const inverse = 1 - t;
  return inverse ** 3 * a + 3 * inverse ** 2 * t * b + 3 * inverse * t ** 2 * c + t ** 3 * d;
}

function smoothStep01(value: number) {
  const clamped = Math.max(0, Math.min(1, value));
  return clamped * clamped * (3 - 2 * clamped);
}

function squareRadius(theta: number, halfWidth: number, halfDepth: number, exponent = 4) {
  const horizontal = Math.abs(Math.cos(theta)) / Math.max(0.001, halfWidth);
  const depth = Math.abs(Math.sin(theta)) / Math.max(0.001, halfDepth);
  return 1 / Math.pow(horizontal ** exponent + depth ** exponent, 1 / exponent);
}

// Lean the whole plant slightly toward the viewer while keeping the corolla upright.
function tiltPoint(x: number, y: number, z: number) {
  const tilt = -0.22;
  const yaw = 0.08;
  const x1 = x * Math.cos(yaw) - z * Math.sin(yaw);
  const z1 = x * Math.sin(yaw) + z * Math.cos(yaw);
  return [x1, y * Math.cos(tilt) - z1 * Math.sin(tilt), y * Math.sin(tilt) + z1 * Math.cos(tilt)] as const;
}

export function createRoseTarget(count: number): ParticleTarget {
  const arrays = createTargetArrays(count);
  const random = seededRandom(1837);
  const flowerEnd = Math.floor(count * 0.68);
  const leafEnd = flowerEnd + Math.floor(count * 0.18);
  const stemEnd = leafEnd + Math.floor(count * 0.09);
  // Reserve almost half of the flower budget for the core and inner petals;
  // the outer shoulder keeps the remaining quarter for silhouette definition.
  const layerRatios = [0.28, 0.22, 0.25, 0.14, 0.11];
  const layerEnds: number[] = [];
  let layerCursor = 0;
  for (let layer = 0; layer < layerRatios.length; layer += 1) {
    layerCursor = layer === layerRatios.length - 1
      ? flowerEnd
      : Math.floor(flowerEnd * layerRatios.slice(0, layer + 1).reduce((sum, value) => sum + value, 0));
    layerEnds.push(layerCursor);
  }
  // More overlapping instances keep the point cloud continuous while the
  // fixed flower budget preserves the existing performance envelope.
  const petalsPerLayer = [7, 9, 12, 14, 12];
  const layerScale = [0.38, 0.66, 0.88, 0.96, 1];
  const petalWidths = [0.065, 0.075, 0.1, 0.13, 0.16];
  // Keep the dense core in the upper half of the corolla. This preserves a
  // visibly tapered base while the extra core particles fill the flower's
  // center instead of lowering the body's apparent shoulder density.
  const layerBases = [1.64, 1.16, 1.04, 0.96, 0.91];
  const layerTops = [2.16, 1.96, 2.08, 2.15, 2.1];
  const sharedRootY = 0.91;
  const spiralTwists = [1.18, 0.82, 0.5, 0.3, 0.2];
  // Front/back layering: inner petals lean toward the viewer, outer petals
  // lean back. The values are balanced so the layer-weighted mean is ~zero —
  // otherwise every petal root drifts off the shared axis in +z and the
  // calyx no longer converges to one point.
  const depthBias = [0.14, 0.08, -0.02, -0.1, -0.17];

  for (let index = 0; index < count; index += 1) {
    let x = 0;
    let y = 0;
    let z = 0;
    let normal: [number, number, number] = [0, 1, 0];
    let red = 0;
    let green = 0;
    let blue = 0;
    let size = 1;

    if (index < flowerEnd) {
      const layer = layerEnds.findIndex((end) => index < end);
      const safeLayer = layer < 0 ? layerEnds.length - 1 : layer;
      const layerStart = safeLayer === 0 ? 0 : layerEnds[safeLayer - 1];
      const localIndex = index - layerStart;
      const petalCount = petalsPerLayer[safeLayer];
      // Round-robin assignment guarantees every petal receives a complete patch.
      const petalIndex = localIndex % petalCount;
      const baseAngle = safeLayer * 0.47 + petalIndex * Math.PI * 2 / petalCount;
      // Petals attach across a small receptacle instead of all starting at one
      // mathematical point. A point root turns the lower edges into long red
      // spikes whenever the flower is viewed from the side.
      const rootInset = [0.07, 0.09, 0.11, 0.13, 0.15][safeLayer];
      const sampledU = safeLayer === 0
        ? random() * 0.8
        : Math.pow(random(), safeLayer < 2 ? 0.86 : 0.72);
      const u = rootInset + sampledU * (1 - rootInset);
      const v = random() * 2 - 1;
      const heightProgress = Math.pow(u, 0.9);
      const twist = (u - 0.18) * spiralTwists[safeLayer];
      const angle = baseAngle + twist;

      // The lower flower head tapers into the calyx; the middle and upper
      // sections keep a broad rounded-square cross section instead of a cap.
      // Hold the corolla close to the calyx for longer before it reaches the
      // broad shoulder. This makes the lower fifth visibly narrower without
      // changing the dense core volume above it.
      const lowerTaper = smoothStep01(u / 0.45);
      // Keep a small rounded base at the receptacle, then open the petal
      // cross-section and tangent width together as it rises.
      const halfWidth = (0.018 + 0.36 * lowerTaper) * layerScale[safeLayer];
      const halfDepth = (0.018 + 0.28 * lowerTaper) * layerScale[safeLayer];
      const baseRadius = 0.045 + safeLayer * 0.012;
      const crownFlare = 1 + 0.4 * smoothStep01((u - 0.86) / 0.14);
      const squareEdgeRadius = squareRadius(angle, halfWidth, halfDepth)
        * (baseRadius + (1 - baseRadius) * Math.pow(lowerTaper, 1.12))
        * crownFlare;
      const width = petalWidths[safeLayer]
        * (0.1 + 0.9 * Math.pow(lowerTaper, 1.35))
        * (0.7 + 0.16 * Math.sin(Math.PI * u));
      const tangentOffset = v * width;
      if (safeLayer === 0) {
        // Fill the central spiral volume instead of leaving five thin radial
        // strips around an empty axis.
        const coreRadius = (0.018 + 0.3 * heightProgress)
          * Math.sqrt(random())
          * (0.12 + 0.88 * lowerTaper)
          * crownFlare;
        x = Math.cos(angle) * coreRadius - Math.sin(angle) * tangentOffset * 0.55;
        z = Math.sin(angle) * coreRadius + Math.cos(angle) * tangentOffset * 0.55
          + depthBias[safeLayer] * lowerTaper;
      } else {
        x = Math.cos(angle) * squareEdgeRadius - Math.sin(angle) * tangentOffset;
        z = Math.sin(angle) * squareEdgeRadius + Math.cos(angle) * tangentOffset
          + depthBias[safeLayer] * lowerTaper;
      }

      // The top reaches its final height before the last band, leaving a
      // broad, nearly level shoulder rather than a pointed dome.
      const baseY = layerBases[safeLayer];
      const topY = layerTops[safeLayer];
      const edgeLift = Math.abs(v) ** 1.35 * (0.025 + safeLayer * 0.012) * lowerTaper;
      const verticalFold = Math.sin(angle * 2 + u * 5 + petalIndex) * 0.012 * lowerTaper;
      const verticalProgress = smoothStep01(Math.min(1, u / 0.84));
      // Layer bases describe the upper fold of each petal. Blending them from
      // the receptacle keeps the underside compact without a pinched tail.
      const baseBlend = smoothStep01(Math.min(1, u / 0.28));
      const blendedBaseY = sharedRootY + (baseY - sharedRootY) * baseBlend;
      y = blendedBaseY + (topY - blendedBaseY) * verticalProgress
        + edgeLift + verticalFold + (random() - 0.5) * 0.01 * lowerTaper;

      const radialSlope = 0.38 + 0.16 * heightProgress;
      const shoulderSlope = u > 0.84 ? 0.16 : 0.3;
      normal = normalizeVector(-Math.cos(angle) * radialSlope, 0.88 + shoulderSlope, -Math.sin(angle) * radialSlope);

      const layerShade = safeLayer / 4;
      const edgeShade = Math.abs(v) > 0.72 ? 0.58 : 1;
      const highlight = (1 - Math.abs(v)) * 0.055 + (1 - u) * 0.03;
      red = (0.34 + layerShade * 0.38 + highlight + random() * 0.045) * edgeShade;
      green = (0.012 + highlight * 0.2 + random() * 0.014) * edgeShade;
      blue = (0.04 + layerShade * 0.025 + highlight * 0.4 + random() * 0.02) * edgeShade;
      size = safeLayer === 0 ? 1.02 + random() * 0.62 : 0.72 + random() * 0.58;
    } else if (index < leafEnd) {
      const localIndex = index - flowerEnd;
      const leafIndex = localIndex < (leafEnd - flowerEnd) / 2 ? 0 : 1;
      const side = leafIndex === 0 ? 1 : -1;
      const u = Math.pow(random(), 0.82);
      let v = random() * 2 - 1;
      const midrib = random() < 0.075;
      if (midrib) v *= 0.08;
      const baseT = leafIndex === 0 ? 0.5 : 0.68;
      const baseX = cubicBezier(0, -0.08, 0.05, 0.02, baseT);
      const baseY = cubicBezier(-1.1, -0.55, -0.15, 0.95, baseT);
      const baseZ = cubicBezier(-0.08, -0.22, -0.18, -0.04, baseT);
      const dirX = side * (leafIndex === 0 ? 0.83 : 0.76);
      const dirY = leafIndex === 0 ? 0.27 : -0.13;
      const dirZ = side * 0.3;
      const length = leafIndex === 0 ? 0.78 : 0.68;
      const edgeWave = 1 + Math.sin(u * Math.PI * 13) * 0.075;
      const width = Math.sin(Math.PI * u) ** 0.78 * 0.22 * edgeWave;
      const crossX = -dirY;
      const crossY = dirX;
      x = baseX + dirX * u * length + crossX * v * width;
      y = baseY + dirY * u * length + crossY * v * width;
      z = baseZ + dirZ * u * length + Math.sin(Math.PI * u) * 0.12 - v * v * 0.025;
      normal = normalizeVector(-dirZ * 0.42, 0.72, 0.58);
      const vein = midrib ? 0.13 : 0;
      red = 0.035 + vein * 0.3 + random() * 0.02;
      green = 0.27 + vein + (1 - u) * 0.09 + random() * 0.08;
      blue = 0.075 + vein * 0.25 + random() * 0.025;
      size = midrib ? 1.08 : 0.72 + random() * 0.46;
    } else if (index < stemEnd) {
      const t = random();
      const angle = random() * Math.PI * 2;
      const radius = 0.031 + Math.sin(Math.PI * t) * 0.012;
      const centerX = cubicBezier(0, -0.08, 0.06, 0.02, t);
      const centerY = cubicBezier(-1.9, -1.0, 0.1, 0.98, t);
      const centerZ = cubicBezier(-0.12, -0.2, -0.16, -0.04, t);
      x = centerX + Math.cos(angle) * radius;
      y = centerY + (random() - 0.5) * 0.012;
      z = centerZ + Math.sin(angle) * radius;
      normal = normalizeVector(Math.cos(angle), 0.35, Math.sin(angle));
      red = 0.04 + random() * 0.018;
      green = 0.24 + (1 - t) * 0.11 + random() * 0.055;
      blue = 0.065 + random() * 0.02;
      size = 0.72 + random() * 0.38;
    } else {
      const sepal = Math.floor(random() * 5);
      const angle = sepal * Math.PI * 2 / 5 + 0.2;
      const u = random();
      const v = random() * 2 - 1;
      const radius = 0.16 + u * 0.48;
      const width = Math.sin(Math.PI * u) * 0.1;
      x = Math.cos(angle) * radius - Math.sin(angle) * v * width;
      z = Math.sin(angle) * radius + Math.cos(angle) * v * width;
      y = 0.9 + 0.16 * u + Math.abs(v) * 0.035;
      normal = normalizeVector(-Math.cos(angle) * 0.3, 0.85, -Math.sin(angle) * 0.3);
      red = 0.035 + random() * 0.02;
      green = 0.3 + (1 - u) * 0.1 + random() * 0.06;
      blue = 0.07 + random() * 0.025;
      size = 0.74 + random() * 0.42;
    }

    const tilted = tiltPoint(x, y, z);
    const tiltedNormal = tiltPoint(normal[0], normal[1], normal[2]);
    writeVector(arrays.positions, index, tilted[0], tilted[1], tilted[2]);
    writeVector(arrays.normals, index, ...normalizeVector(tiltedNormal[0], tiltedNormal[1], tiltedNormal[2]));
    writeVector(arrays.colors, index, red, green, blue);
    arrays.sizes[index] = size;
    arrays.alphas[index] = 0.68 + random() * 0.3;
    writeScatter(arrays.scatter, index, random);
  }

  // Center the complete plant before correcting the inner layer. If this
  // correction ran before bounds centering, the asymmetric stem and leaves
  // would immediately shift the core back toward one side.
  centerPositions(arrays.positions);
  const coreEnd = layerEnds[0];
  let coreCenterX = 0;
  let coreCenterZ = 0;
  let bodyCenterX = 0;
  let bodyCenterZ = 0;
  for (let index = 0; index < coreEnd; index += 1) {
    coreCenterX += arrays.positions[index * 3];
    coreCenterZ += arrays.positions[index * 3 + 2];
  }
  for (let index = coreEnd; index < flowerEnd; index += 1) {
    bodyCenterX += arrays.positions[index * 3];
    bodyCenterZ += arrays.positions[index * 3 + 2];
  }
  coreCenterX /= Math.max(1, coreEnd);
  coreCenterZ /= Math.max(1, coreEnd);
  bodyCenterX /= Math.max(1, flowerEnd - coreEnd);
  bodyCenterZ /= Math.max(1, flowerEnd - coreEnd);
  const correctionX = coreCenterX - bodyCenterX;
  const correctionZ = coreCenterZ - bodyCenterZ;
  // Split the correction across both groups by mass ratio so the plant's
  // overall center is preserved. Moving only the core would leave a net
  // displacement that the final centering pass applies to every particle,
  // drifting all petal roots off the shared axis.
  const bodyShare = (flowerEnd - coreEnd) / flowerEnd;
  for (let index = 0; index < coreEnd; index += 1) {
    arrays.positions[index * 3] -= correctionX * bodyShare;
    arrays.positions[index * 3 + 2] -= correctionZ * bodyShare;
  }
  for (let index = coreEnd; index < flowerEnd; index += 1) {
    arrays.positions[index * 3] += correctionX * (1 - bodyShare);
    arrays.positions[index * 3 + 2] += correctionZ * (1 - bodyShare);
  }
  centerPositions(arrays.positions);
  // The shared petal root must sit on the plant axis. Plain bounds centering
  // spans the asymmetric stem and leaves, so the tilted flower head leaves
  // every petal root drifting off-axis. Measure the lowest flower band and
  // translate the whole plant (shape-preserving, stem included) until all
  // layers spring from one point on the axis.
  let flowerYMin = Infinity;
  let flowerYMax = -Infinity;
  for (let index = 0; index < flowerEnd; index += 1) {
    const y = arrays.positions[index * 3 + 1];
    flowerYMin = Math.min(flowerYMin, y);
    flowerYMax = Math.max(flowerYMax, y);
  }
  let rootSumX = 0;
  let rootSumZ = 0;
  let rootCount = 0;
  const rootCutoff = flowerYMin + (flowerYMax - flowerYMin) * 0.09;
  for (let index = 0; index < flowerEnd; index += 1) {
    if (arrays.positions[index * 3 + 1] > rootCutoff) continue;
    rootSumX += arrays.positions[index * 3];
    rootSumZ += arrays.positions[index * 3 + 2];
    rootCount += 1;
  }
  if (rootCount > 0) {
    const shiftX = -rootSumX / rootCount;
    const shiftZ = -rootSumZ / rootCount;
    for (let offset = 0; offset < arrays.positions.length; offset += 3) {
      arrays.positions[offset] += shiftX;
      arrays.positions[offset + 2] += shiftZ;
    }
  }
  const measured = calculateBounds(arrays.positions);

  return {
    ...arrays,
    kind: 'rose',
    count,
    id: 'rose-3d',
    bounds: { center: [0, 0, 0], radius: measured.radius },
  };
}
