import { useCallback, useEffect, useRef, useState } from 'react';
import type { GestureSnapshot } from '../types';
import { GestureClassifier, type Landmark } from './classifier';
import { createInference, type InferenceHandle } from './inference';
import { TrackerSession, isBusyStatus, type StreamLike, type TrackerSnapshot } from './trackerSession';

export type { TrackerStatus } from './trackerSession';

const ASSET_BASE = import.meta.env.BASE_URL;
const WASM_PATH = `${ASSET_BASE}mediapipe/wasm`;
const MODEL_PATH = `${ASSET_BASE}mediapipe/models/hand_landmarker.task`;
const INFERENCE_INTERVAL = 1000 / 28;

export const EMPTY_GESTURE: GestureSnapshot = {
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

export function useHandTracker(onSwipe: (swipe: 'left' | 'right') => void) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const classifierRef = useRef(new GestureClassifier());
  const gestureRef = useRef<GestureSnapshot>({ ...EMPTY_GESTURE });
  const handleRef = useRef<InferenceHandle | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastInferenceRef = useRef(-Infinity);
  const lastVideoTimeRef = useRef(-1);
  const lastHealthCheckRef = useRef(0);
  const lastHandPresentRef = useRef(false);
  const swipeCallbackRef = useRef(onSwipe);
  const [snapshot, setSnapshot] = useState<TrackerSnapshot>({ status: 'idle', message: '' });
  const [handPresent, setHandPresent] = useState(false);

  useEffect(() => { swipeCallbackRef.current = onSwipe; }, [onSwipe]);

  const publishResult = useCallback((landmarks: Landmark[], confidence: number, timestamp: number) => {
    const next = classifierRef.current.classify(landmarks, confidence, timestamp);
    gestureRef.current = next;
    if (next.handPresent !== lastHandPresentRef.current) {
      lastHandPresentRef.current = next.handPresent;
      setHandPresent(next.handPresent);
    }
    if (next.swipe) swipeCallbackRef.current(next.swipe);
  }, []);

  const resetGesture = useCallback(() => {
    gestureRef.current = { ...EMPTY_GESTURE };
    lastHandPresentRef.current = false;
    setHandPresent(false);
  }, []);

  const stopLoop = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
  }, []);

  const startLoop = useCallback(() => {
    if (rafRef.current !== null) return;
    const tick = (now: number) => {
      rafRef.current = requestAnimationFrame(tick);
      if (now - lastHealthCheckRef.current >= 1000) {
        lastHealthCheckRef.current = now;
        sessionRef.current?.checkStreamHealth();
      }
      const video = videoRef.current;
      const handle = handleRef.current;
      if (!video || !handle || video.readyState < 2) return;
      if (now - lastInferenceRef.current < INFERENCE_INTERVAL) return;
      if (video.currentTime === lastVideoTimeRef.current) return;
      if (!handle.detect(video, now)) return;
      lastInferenceRef.current = now;
      lastVideoTimeRef.current = video.currentTime;
    };
    rafRef.current = requestAnimationFrame(tick);
  }, []);

  const beginTracking = useCallback((handle: InferenceHandle) => {
    stopLoop();
    handleRef.current = handle;
    classifierRef.current = new GestureClassifier();
    lastInferenceRef.current = -Infinity;
    lastVideoTimeRef.current = -1;
    startLoop();
  }, [startLoop, stopLoop]);

  const endTracking = useCallback(() => {
    stopLoop();
    handleRef.current?.stop();
    handleRef.current = null;
    classifierRef.current = new GestureClassifier();
    lastInferenceRef.current = -Infinity;
    lastVideoTimeRef.current = -1;
    resetGesture();
  }, [resetGesture, stopLoop]);

  const resetTracking = useCallback(() => {
    handleRef.current?.reset();
    lastInferenceRef.current = -Infinity;
    lastVideoTimeRef.current = -1;
  }, []);

  const sessionRef = useRef<TrackerSession | null>(null);
  if (!sessionRef.current) {
    sessionRef.current = new TrackerSession({
      mediaDevicesAvailable: () => Boolean(navigator.mediaDevices?.getUserMedia),
      getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints) as Promise<StreamLike>,
      getVideo: () => videoRef.current,
      createInference: (signal, onFatal) => createInference({
        wasmPath: WASM_PATH,
        modelPath: MODEL_PATH,
        signal,
        onFatal,
        onResult: (result) => publishResult(result.landmarks, result.confidence, result.timestamp),
      }),
      beginTracking,
      endTracking,
      resetTracking,
      resetGesture,
      onUpdate: (next) => setSnapshot(next),
    });
  }

  useEffect(() => {
    const session = sessionRef.current;
    if (!session) return;
    const handleVisibility = () => { void session.handleVisibility(document.visibilityState === 'visible'); };
    const handlePageHide = (event: PageTransitionEvent) => { void session.handlePageHide(event.persisted); };
    const handlePageShow = () => { void session.handlePageShow(); };
    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('pagehide', handlePageHide);
    window.addEventListener('pageshow', handlePageShow);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('pagehide', handlePageHide);
      window.removeEventListener('pageshow', handlePageShow);
      session.stop();
    };
  }, []);

  const start = useCallback(() => sessionRef.current?.start() ?? Promise.resolve(), []);
  const stop = useCallback(() => { sessionRef.current?.stop(); }, []);
  const retry = useCallback(() => sessionRef.current?.retry() ?? Promise.resolve(), []);
  const dismissError = useCallback(() => { sessionRef.current?.dismissError(); }, []);

  return {
    videoRef,
    gestureRef,
    enabled: snapshot.status === 'active',
    handPresent,
    status: snapshot.status,
    errorMessage: snapshot.message,
    isBusy: isBusyStatus(snapshot.status),
    start,
    stop,
    retry,
    dismissError,
  };
}
