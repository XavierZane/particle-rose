import { describe, expect, it } from 'vitest';
import { GestureClassifier } from './classifier';

function hand(open: boolean, translateX = 0) {
  const points = Array.from({ length: 21 }, () => ({ x: 0.5 + translateX, y: 0.5 }));
  points[0] = { x: 0.5 + translateX, y: 0.72 };
  points[5] = { x: 0.43 + translateX, y: 0.56 };
  points[17] = { x: 0.57 + translateX, y: 0.56 };
  const tips = [4, 8, 12, 16, 20];
  tips.forEach((index, tipIndex) => {
    points[index] = open
      ? { x: 0.35 + tipIndex * 0.075 + translateX, y: 0.23 }
      : { x: 0.49 + (tipIndex % 2) * 0.02 + translateX, y: 0.59 };
  });
  points[4] = open ? { x: 0.32 + translateX, y: 0.39 } : { x: 0.5 + translateX, y: 0.58 };
  points[8] = open ? { x: 0.42 + translateX, y: 0.24 } : { x: 0.51 + translateX, y: 0.59 };
  return points;
}

function calibrate(classifier: GestureClassifier, start = 0) {
  let snapshot = classifier.classify(hand(true), 0.9, start);
  for (let frame = 1; frame < 12; frame += 1) snapshot = classifier.classify(hand(true), 0.9, start + frame * 33);
  return snapshot;
}

describe('GestureClassifier', () => {
  it('acquires after three frames and distinguishes open from closed hands', () => {
    const classifier = new GestureClassifier();
    expect(classifier.classify(hand(true), 0.9, 0).handPresent).toBe(false);
    classifier.classify(hand(true), 0.9, 33);
    const open = classifier.classify(hand(true), 0.9, 66);
    let closed = open;
    for (let frame = 0; frame < 8; frame += 1) closed = classifier.classify(hand(false), 0.9, 99 + frame * 33);
    expect(open.handPresent).toBe(true);
    expect(open.openness).toBeGreaterThan(closed.openness);
  });

  it('holds briefly through missing frames, then releases tracking', () => {
    const classifier = new GestureClassifier();
    calibrate(classifier);
    expect(classifier.classify([], 0, 450).handPresent).toBe(true);
    expect(classifier.classify([], 0, 900).handPresent).toBe(false);
  });

  it('emits one swipe for fast consistent movement but ignores cooldown motion', () => {
    const classifier = new GestureClassifier();
    calibrate(classifier);
    const start = 430;
    classifier.classify(hand(true, 0), 0.9, start);
    classifier.classify(hand(true, -0.06), 0.9, start + 45);
    classifier.classify(hand(true, -0.13), 0.9, start + 90);
    classifier.classify(hand(true, -0.2), 0.9, start + 135);
    const swipe = classifier.classify(hand(true, -0.27), 0.9, start + 180);
    const ignored = classifier.classify(hand(true, -0.3), 0.9, start + 220);
    expect(swipe.swipe).toBe('right');
    expect(ignored.swipe).toBeNull();
  });

  it('drives a fully closed hand to a near-zero openness value', () => {
    const classifier = new GestureClassifier();
    calibrate(classifier);
    let snapshot = classifier.classify(hand(false), 0.9, 430);
    for (let frame = 1; frame < 18; frame += 1) {
      snapshot = classifier.classify(hand(false), 0.9, 430 + frame * 33);
    }
    expect(snapshot.openness).toBeLessThan(0.02);
  });
});
