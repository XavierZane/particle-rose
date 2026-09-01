export type ParticleMode = 'image' | 'rose' | 'transition' | 'idle';

export type ParticleTarget = {
  kind: 'rose' | 'image';
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  sizes: Float32Array;
  alphas: Float32Array;
  scatter: Float32Array;
  bounds: {
    center: [number, number, number];
    radius: number;
  };
  count: number;
  id: string;
};

export type GestureSnapshot = {
  handPresent: boolean;
  palmX: number;
  palmY: number;
  openness: number;
  pinch: number;
  swipe: 'left' | 'right' | null;
  confidence: number;
  trackingQuality: number;
  timestamp: number;
};

export type ManualGesture = {
  yaw: number;
  pitch: number;
  scale: number;
  active: boolean;
};

export type ImageParticle = {
  id: string;
  name: string;
  url: string;
  target: ParticleTarget;
};
