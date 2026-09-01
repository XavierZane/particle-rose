import type { GestureSnapshot } from '../types';
import { OneEuroFilter } from './oneEuroFilter';

export type Landmark = { x: number; y: number; z?: number };

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
const distance = (a: Landmark, b: Landmark) => Math.hypot(a.x - b.x, a.y - b.y);

const EMPTY_GESTURE: GestureSnapshot = {
  handPresent: false,
  palmX: 0.5,
  palmY: 0.5,
  openness: 0,
  pinch: 0.45,
  swipe: null,
  confidence: 0,
  trackingQuality: 0,
  timestamp: 0,
};

export class GestureClassifier {
  private readonly palmXFilter = new OneEuroFilter({ minCutoff: 1.2, beta: 0.08 });
  private readonly palmYFilter = new OneEuroFilter({ minCutoff: 1.2, beta: 0.08 });
  private readonly opennessFilter = new OneEuroFilter({ minCutoff: 1, beta: 0.04 });
  private readonly pinchFilter = new OneEuroFilter({ minCutoff: 1, beta: 0.04 });
  private tracked = false;
  private acquiredFrames = 0;
  private calibrationFrames = 0;
  private neutralSumX = 0;
  private neutralSumY = 0;
  private neutralX = 0.5;
  private neutralY = 0.5;
  private lastValidTimestamp = -Infinity;
  private lastSwipeTimestamp = -Infinity;
  private history: Array<{ x: number; timestamp: number }> = [];
  private lastSnapshot = EMPTY_GESTURE;

  private resetTracking() {
    this.tracked = false;
    this.acquiredFrames = 0;
    this.calibrationFrames = 0;
    this.neutralSumX = 0;
    this.neutralSumY = 0;
    this.history = [];
    this.palmXFilter.reset();
    this.palmYFilter.reset();
    this.opennessFilter.reset();
    this.pinchFilter.reset();
  }

  classify(landmarks: Landmark[], confidence: number, timestamp = performance.now()): GestureSnapshot {
    if (landmarks.length < 21 || confidence < 0.45) {
      this.acquiredFrames = 0;
      if (this.tracked && timestamp - this.lastValidTimestamp <= 250) {
        this.lastSnapshot = {
          ...this.lastSnapshot,
          swipe: null,
          confidence,
          trackingQuality: this.lastSnapshot.trackingQuality * 0.9,
          timestamp,
        };
        return this.lastSnapshot;
      }
      if (timestamp - this.lastValidTimestamp > 800) this.resetTracking();
      this.lastSnapshot = { ...EMPTY_GESTURE, confidence, timestamp };
      return this.lastSnapshot;
    }

    this.lastValidTimestamp = timestamp;
    this.acquiredFrames += 1;
    if (!this.tracked && this.acquiredFrames >= 3) this.tracked = true;
    const wrist = landmarks[0];
    const palmSize = Math.max(0.001, distance(landmarks[5], landmarks[17]));
    const rawCenterX = 1 - (landmarks[0].x + landmarks[5].x + landmarks[17].x) / 3;
    const rawCenterY = (landmarks[0].y + landmarks[5].y + landmarks[17].y) / 3;
    const filteredX = this.palmXFilter.filter(rawCenterX, timestamp);
    const filteredY = this.palmYFilter.filter(rawCenterY, timestamp);
    const tipDistances = [4, 8, 12, 16, 20].map((index) => distance(landmarks[index], wrist) / palmSize);
    const averageReach = tipDistances.reduce((sum, value) => sum + value, 0) / tipDistances.length;
    // A closed fist still leaves the fingertips roughly one palm-width from
    // the wrist. Keep that range in a hard dead zone, then use a smooth
    // response up to a fully open hand so closure can reach exactly zero.
    const rawOpenness = clamp01((averageReach - 1.08) / 1.08);
    const shapedOpenness = rawOpenness * rawOpenness * (3 - 2 * rawOpenness);
    const filteredOpenness = this.opennessFilter.filter(shapedOpenness, timestamp);
    const openness = filteredOpenness < 0.04 ? 0 : filteredOpenness;
    const pinch = this.pinchFilter.filter(clamp01((distance(landmarks[4], landmarks[8]) / palmSize - 0.22) / 0.95), timestamp);

    if (this.calibrationFrames < 12) {
      this.neutralSumX += filteredX;
      this.neutralSumY += filteredY;
      this.calibrationFrames += 1;
      this.neutralX = this.neutralSumX / this.calibrationFrames;
      this.neutralY = this.neutralSumY / this.calibrationFrames;
    }

    let deltaX = (filteredX - this.neutralX) * 1.7;
    let deltaY = (filteredY - this.neutralY) * 1.6;
    if (Math.abs(deltaX) < 0.025) deltaX = 0;
    if (Math.abs(deltaY) < 0.025) deltaY = 0;
    const palmX = clamp01(0.5 + deltaX);
    const palmY = clamp01(0.5 + deltaY);

    this.history.push({ x: rawCenterX, timestamp });
    this.history = this.history.filter((entry) => timestamp - entry.timestamp <= 320);
    let swipe: GestureSnapshot['swipe'] = null;
    if (this.tracked && this.calibrationFrames >= 12 && openness > 0.55 && timestamp - this.lastSwipeTimestamp > 800) {
      const oldest = this.history.find((entry) => timestamp - entry.timestamp <= 220 && timestamp - entry.timestamp >= 120);
      if (oldest && timestamp - oldest.timestamp >= 120) {
        const displacement = rawCenterX - oldest.x;
        const velocity = displacement / ((timestamp - oldest.timestamp) / 1000);
        const recentDirections = this.history.slice(-4).map((entry, index, entries) => index === 0 ? 0 : Math.sign(entry.x - entries[index - 1].x));
        const direction = Math.sign(displacement);
        const consistent = recentDirections.filter((value) => value === direction).length >= 2;
        if (Math.abs(displacement) > 0.18 && Math.abs(velocity) > 1.15 && consistent) {
          swipe = displacement > 0 ? 'right' : 'left';
          this.lastSwipeTimestamp = timestamp;
          this.history = [];
        }
      }
    }

    this.lastSnapshot = {
      handPresent: this.tracked,
      palmX: this.calibrationFrames < 12 ? 0.5 : palmX,
      palmY: this.calibrationFrames < 12 ? 0.5 : palmY,
      openness,
      pinch,
      swipe,
      confidence,
      trackingQuality: clamp01((confidence - 0.45) / 0.5) * Math.min(1, this.acquiredFrames / 5),
      timestamp,
    };
    return this.lastSnapshot;
  }
}
