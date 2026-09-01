/// <reference lib="webworker" />

import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';

type InitMessage = { type: 'init'; wasmPath: string; modelPath: string };
type FrameMessage = { type: 'frame'; bitmap: ImageBitmap; timestamp: number };
type StopMessage = { type: 'stop' };

let landmarker: HandLandmarker | null = null;

async function initialize({ wasmPath, modelPath }: InitMessage) {
  const vision = await FilesetResolver.forVisionTasks(wasmPath, true);
  const create = (delegate: 'GPU' | 'CPU') => HandLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: modelPath, delegate },
    runningMode: 'VIDEO',
    numHands: 1,
    minHandDetectionConfidence: 0.55,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
  let delegate: 'GPU' | 'CPU' = 'GPU';
  try {
    landmarker = await create('GPU');
  } catch {
    delegate = 'CPU';
    landmarker = await create('CPU');
  }
  self.postMessage({ type: 'ready', delegate });
}

self.onmessage = async (event: MessageEvent<InitMessage | FrameMessage | StopMessage>) => {
  const message = event.data;
  if (message.type === 'init') {
    try {
      await initialize(message);
    } catch (error) {
      self.postMessage({ type: 'error', message: error instanceof Error ? error.message : 'Worker initialization failed' });
    }
    return;
  }
  if (message.type === 'stop') {
    landmarker?.close();
    landmarker = null;
    self.close();
    return;
  }
  try {
    if (!landmarker) throw new Error('Hand tracker is not initialized');
    const result = landmarker.detectForVideo(message.bitmap, message.timestamp);
    message.bitmap.close();
    self.postMessage({
      type: 'result',
      landmarks: result.landmarks[0] ?? [],
      confidence: result.handednesses[0]?.[0]?.score ?? 0,
      timestamp: message.timestamp,
    });
  } catch (error) {
    message.bitmap.close();
    self.postMessage({ type: 'frameError', message: error instanceof Error ? error.message : 'Hand tracking failed' });
  }
};
