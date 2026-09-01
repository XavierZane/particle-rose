import type { ParticleTarget } from '../types';
import { centerPositions, createTargetArrays, normalizeVector, writeScatter, writeVector } from '../particle/targetUtils';

export const MAX_IMAGES = 12;
export const MAX_FILE_SIZE = 10 * 1024 * 1024;

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

function seededRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function hashString(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function imageDimensions(width: number, height: number) {
  const scale = Math.min(3 / width, 2.35 / height);
  return { width: width * scale, height: height * scale };
}

function blurLuminance(values: Float32Array, width: number, height: number) {
  const horizontal = new Float32Array(values.length);
  const output = new Float32Array(values.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      let samples = 0;
      for (let offset = -2; offset <= 2; offset += 1) {
        const sampleX = Math.max(0, Math.min(width - 1, x + offset));
        sum += values[y * width + sampleX];
        samples += 1;
      }
      horizontal[y * width + x] = sum / samples;
    }
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      let samples = 0;
      for (let offset = -2; offset <= 2; offset += 1) {
        const sampleY = Math.max(0, Math.min(height - 1, y + offset));
        sum += horizontal[sampleY * width + x];
        samples += 1;
      }
      output[y * width + x] = sum / samples;
    }
  }
  return output;
}

export function pixelsToParticleTarget(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  count: number,
  id: string,
  seed = hashString(id),
): ParticleTarget {
  const pixelCount = width * height;
  const luminance = new Float32Array(pixelCount);
  const valid: number[] = [];
  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
    const offset = pixelIndex * 4;
    const alpha = pixels[offset + 3] / 255;
    const red = pixels[offset] / 255;
    const green = pixels[offset + 1] / 255;
    const blue = pixels[offset + 2] / 255;
    luminance[pixelIndex] = red * 0.2126 + green * 0.7152 + blue * 0.0722;
    if (alpha > 0.08) valid.push(pixelIndex);
  }
  if (valid.length === 0) throw new Error('图片没有可见像素');

  const blurred = blurLuminance(luminance, width, height);
  const edgeStrength = new Float32Array(pixelCount);
  const contrast = new Float32Array(pixelCount);
  const depth = new Float32Array(pixelCount);
  const edges: number[] = [];
  for (const pixelIndex of valid) {
    const x = pixelIndex % width;
    const y = Math.floor(pixelIndex / width);
    const left = y * width + Math.max(0, x - 1);
    const right = y * width + Math.min(width - 1, x + 1);
    const up = Math.max(0, y - 1) * width + x;
    const down = Math.min(height - 1, y + 1) * width + x;
    const gx = luminance[right] - luminance[left];
    const gy = luminance[down] - luminance[up];
    edgeStrength[pixelIndex] = Math.min(1, Math.hypot(gx, gy) * 1.8);
    const sourceOffset = pixelIndex * 4;
    let localContrast = 0;
    for (const neighbor of [left, right, up, down]) {
      const neighborOffset = neighbor * 4;
      localContrast += (
        Math.abs(pixels[sourceOffset] - pixels[neighborOffset])
        + Math.abs(pixels[sourceOffset + 1] - pixels[neighborOffset + 1])
        + Math.abs(pixels[sourceOffset + 2] - pixels[neighborOffset + 2])
      ) / (255 * 12);
    }
    contrast[pixelIndex] = Math.min(1, localContrast);
    // Relief is deliberately subtle: brightness helps shape the surface, but
    // never displaces the image enough to damage its front-facing appearance.
    depth[pixelIndex] = Math.max(-0.08, Math.min(0.08,
      (blurred[pixelIndex] - 0.5) * 0.055
      + edgeStrength[pixelIndex] * 0.035
      + contrast[pixelIndex] * 0.018,
    ));
    const alphaEdge = [left, right, up, down].some((neighbor) => pixels[neighbor * 4 + 3] <= 20);
    if (edgeStrength[pixelIndex] > 0.16 || alphaEdge) edges.push(pixelIndex);
  }

  const arrays = createTargetArrays(count);
  const random = seededRandom(seed);
  const fitted = imageDimensions(width, height);
  const frontEnd = Math.floor(count * 0.82);
  const edgeEnd = frontEnd + Math.floor(count * 0.14);
  const edgePool = edges.length > 0 ? edges : valid;

  // Build a deterministic spatial index. Each front particle is assigned to
  // a cell before jittering, so the entire visible image gets even coverage.
  const gridColumns = Math.max(1, Math.min(72, Math.round(Math.sqrt(count * width / Math.max(1, height)) / 3)));
  const gridRows = Math.max(1, Math.min(72, Math.round(gridColumns * height / Math.max(1, width))));
  const cells: number[][] = Array.from({ length: gridColumns * gridRows }, () => []);
  for (const pixelIndex of valid) {
    const x = pixelIndex % width;
    const y = Math.floor(pixelIndex / width);
    const column = Math.min(gridColumns - 1, Math.floor(x * gridColumns / width));
    const row = Math.min(gridRows - 1, Math.floor(y * gridRows / height));
    cells[row * gridColumns + column].push(pixelIndex);
  }
  const populatedCells = cells.reduce<number[]>((result, cell, index) => {
    if (cell.length > 0) result.push(index);
    return result;
  }, []);
  const pickFrontPixel = (index: number) => {
    const cellIndex = populatedCells[index % populatedCells.length];
    const cell = cells[cellIndex];
    return cell[Math.floor(random() * cell.length)];
  };

  for (let index = 0; index < count; index += 1) {
    const pixelIndex = index < frontEnd || index >= edgeEnd
      ? pickFrontPixel(index)
      : edgePool[index % edgePool.length];
    const x = pixelIndex % width;
    const y = Math.floor(pixelIndex / width);
    const cellJitter = index < frontEnd ? 0.34 : 0.18;
    const u = clamp01((x + 0.5 + (random() - 0.5) * cellJitter) / width);
    const v = clamp01((y + 0.5 + (random() - 0.5) * cellJitter) / height);
    const sourceOffset = pixelIndex * 4;
    let z = depth[pixelIndex];
    let colorScale = 1;
    let normal: [number, number, number];

    const left = y * width + Math.max(0, x - 1);
    const right = y * width + Math.min(width - 1, x + 1);
    const up = Math.max(0, y - 1) * width + x;
    const down = Math.min(height - 1, y + 1) * width + x;
    if (index < frontEnd) {
      normal = normalizeVector((depth[left] - depth[right]) * 2.5, (depth[down] - depth[up]) * 2.5, 1);
    } else if (index < edgeEnd) {
      const extrusion = random();
      z = -0.09 + (depth[pixelIndex] + 0.09) * extrusion;
      const gx = luminance[right] - luminance[left];
      const gy = luminance[down] - luminance[up];
      normal = normalizeVector(gx || random() - 0.5, -gy || random() - 0.5, 0.22);
      colorScale = 0.72 + extrusion * 0.2;
    } else {
      z = -0.09 + (random() - 0.5) * 0.008;
      normal = [0, 0, -1];
      colorScale = 0.62;
    }

    writeVector(arrays.positions, index, (u - 0.5) * fitted.width, (0.5 - v) * fitted.height, z);
    writeVector(arrays.normals, index, ...normal);
    writeVector(
      arrays.colors,
      index,
      pixels[sourceOffset] / 255 * colorScale,
      pixels[sourceOffset + 1] / 255 * colorScale,
      pixels[sourceOffset + 2] / 255 * colorScale,
    );
    arrays.sizes[index] = index < frontEnd ? 0.78 + random() * 0.38 : 0.72 + random() * 0.3;
    arrays.alphas[index] = Math.max(0.12, pixels[sourceOffset + 3] / 255) * (index >= edgeEnd ? 0.78 : 1);
    writeScatter(arrays.scatter, index, random);
  }

  return {
    ...arrays,
    kind: 'image',
    count,
    id,
    bounds: centerPositions(arrays.positions),
  };
}

export function getParticleCount() {
  const mobile = typeof window !== 'undefined' && window.matchMedia('(max-width: 700px)').matches;
  const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4;
  return mobile ? Math.min(24000, Math.max(15000, cores * 3500)) : Math.min(72000, Math.max(42000, cores * 9000));
}

export async function fileToParticleTarget(file: File, count = getParticleCount()): Promise<ParticleTarget> {
  if (!file.type.match(/^image\/(jpeg|png|webp)$/)) throw new Error('请上传 JPG、PNG 或 WebP 图片');
  if (file.size > MAX_FILE_SIZE) throw new Error('图片大小不能超过 10 MB');

  const bitmap = typeof createImageBitmap === 'function' ? await createImageBitmap(file) : null;
  try {
    const maxSide = 512;
    let source: CanvasImageSource;
    let sourceWidth: number;
    let sourceHeight: number;
    if (bitmap) {
      source = bitmap;
      sourceWidth = bitmap.width;
      sourceHeight = bitmap.height;
    } else {
      const fallbackUrl = URL.createObjectURL(file);
      try {
        const image = await new Promise<HTMLImageElement>((resolve, reject) => {
          const element = new Image();
          element.onload = () => resolve(element);
          element.onerror = () => reject(new Error('无法读取图片'));
          element.src = fallbackUrl;
        });
        source = image;
        sourceWidth = image.naturalWidth;
        sourceHeight = image.naturalHeight;
      } finally {
        URL.revokeObjectURL(fallbackUrl);
      }
    }
    const scale = Math.min(1, maxSide / Math.max(sourceWidth, sourceHeight));
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('无法初始化图片采样器');
    context.drawImage(source, 0, 0, width, height);
    const pixels = context.getImageData(0, 0, width, height).data;
    return pixelsToParticleTarget(
      pixels,
      width,
      height,
      count,
      `${file.name}-${file.lastModified}-${file.size}`,
      hashString(`${file.name}:${file.size}:${width}:${height}`),
    );
  } finally {
    bitmap?.close();
  }
}
