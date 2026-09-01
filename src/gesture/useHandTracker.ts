import { useCallback, useEffect, useRef, useState } from 'react';
import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';
import type { GestureSnapshot } from '../types';
import { GestureClassifier, type Landmark } from './classifier';

type TrackerStatus =
  | 'idle'
  | 'requesting'
  | 'loadingModel'
  | 'active'
  | 'cameraError'
  | 'modelError'
  | 'unsupported';

type WorkerResponse =
  | { type: 'ready'; delegate: 'GPU' | 'CPU' }
  | { type: 'result'; landmarks: Landmark[]; confidence: number; timestamp: number }
  | { type: 'error' | 'frameError'; message: string };

const WASM_PATH = '/mediapipe/wasm';
const MODEL_PATH = '/mediapipe/models/hand_landmarker.task';
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
  const streamRef = useRef<MediaStream | null>(null);
  const landmarkerRef = useRef<HandLandmarker | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const rafRef = useRef<number | null>(null);
  const classifierRef = useRef(new GestureClassifier());
  const gestureRef = useRef<GestureSnapshot>({ ...EMPTY_GESTURE });
  const swipeCallbackRef = useRef(onSwipe);
  const startTokenRef = useRef(0);
  const framePendingRef = useRef(false);
  const lastHandPresentRef = useRef(false);
  const [enabled, setEnabled] = useState(false);
  const [handPresent, setHandPresent] = useState(false);
  const [status, setStatus] = useState<TrackerStatus>('idle');
  const [errorMessage, setErrorMessage] = useState('');

  useEffect(() => { swipeCallbackRef.current = onSwipe; }, [onSwipe]);

  const publishResult = useCallback((landmarks: Landmark[], confidence: number, timestamp: number) => {
    const snapshot = classifierRef.current.classify(landmarks, confidence, timestamp);
    gestureRef.current = snapshot;
    if (snapshot.handPresent !== lastHandPresentRef.current) {
      lastHandPresentRef.current = snapshot.handPresent;
      setHandPresent(snapshot.handPresent);
    }
    if (snapshot.swipe) swipeCallbackRef.current(snapshot.swipe);
  }, []);

  const stop = useCallback(() => {
    startTokenRef.current += 1;
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    framePendingRef.current = false;
    workerRef.current?.postMessage({ type: 'stop' });
    workerRef.current?.terminate();
    workerRef.current = null;
    landmarkerRef.current?.close();
    landmarkerRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    gestureRef.current = { ...EMPTY_GESTURE };
    lastHandPresentRef.current = false;
    setHandPresent(false);
    setEnabled(false);
    setStatus('idle');
    setErrorMessage('');
  }, []);

  const start = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus('unsupported');
      setErrorMessage('当前浏览器不支持摄像头访问');
      return;
    }
    const startToken = startTokenRef.current + 1;
    startTokenRef.current = startToken;
    classifierRef.current = new GestureClassifier();
    gestureRef.current = { ...EMPTY_GESTURE };
    setStatus('requesting');
    setErrorMessage('');

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } },
        audio: false,
      });
      if (startToken !== startTokenRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      setEnabled(true);
      const video = videoRef.current;
      if (!video) throw new Error('摄像头预览未准备好');
      video.srcObject = stream;
      await video.play();
      stream.getVideoTracks()[0]?.addEventListener('ended', () => {
        if (startToken !== startTokenRef.current) return;
        gestureRef.current = { ...EMPTY_GESTURE };
        setEnabled(false);
        setHandPresent(false);
        setStatus('cameraError');
        setErrorMessage('摄像头视频流已结束，请重新启用');
      }, { once: true });
    } catch (error) {
      console.error('Camera initialization failed', error);
      if (startToken !== startTokenRef.current) return;
      stop();
      setStatus(error instanceof DOMException && error.name === 'NotSupportedError' ? 'unsupported' : 'cameraError');
      setErrorMessage(error instanceof DOMException && error.name === 'NotAllowedError'
        ? '摄像头权限被拒绝，请在地址栏中允许访问'
        : '无法启动摄像头，请检查设备是否被其他应用占用');
      return;
    }

    if (startToken !== startTokenRef.current) return;
    setStatus('loadingModel');
    let trackingMode: 'worker' | 'main' = 'main';

    const setupWorker = async () => {
      if (typeof Worker === 'undefined' || typeof createImageBitmap !== 'function') throw new Error('Worker tracking is unsupported');
      const worker = new Worker(new URL('./handTracker.worker.ts', import.meta.url), { type: 'module' });
      workerRef.current = worker;
      await new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(() => reject(new Error('Worker model loading timed out')), 12000);
        worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
          const message = event.data;
          if (message.type === 'ready') {
            window.clearTimeout(timeout);
            resolve();
          } else if (message.type === 'error') {
            window.clearTimeout(timeout);
            reject(new Error(message.message));
          }
        };
        worker.onerror = (event) => {
          window.clearTimeout(timeout);
          reject(new Error(event.message || 'Worker failed'));
        };
        worker.postMessage({ type: 'init', wasmPath: WASM_PATH, modelPath: MODEL_PATH });
      });
      worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        const message = event.data;
        if (message.type === 'result') {
          framePendingRef.current = false;
          publishResult(message.landmarks, message.confidence, message.timestamp);
        } else if (message.type === 'frameError') {
          framePendingRef.current = false;
          console.warn('Worker hand tracking frame failed', message.message);
        }
      };
      worker.onerror = (event) => {
        framePendingRef.current = false;
        console.error('Worker hand tracking stopped', event.message);
        setStatus('modelError');
        setErrorMessage('手势识别暂时不可用，摄像头仍保持开启');
      };
    };

    try {
      try {
        await setupWorker();
        trackingMode = 'worker';
      } catch (workerError) {
        console.warn('Worker hand tracking unavailable; using main thread', workerError);
        workerRef.current?.terminate();
        workerRef.current = null;
      }
      if (trackingMode === 'main') {
        const vision = await FilesetResolver.forVisionTasks(WASM_PATH, true);
        const createLandmarker = (delegate: 'GPU' | 'CPU') => HandLandmarker.createFromOptions(vision, {
          baseOptions: { modelAssetPath: MODEL_PATH, delegate },
          runningMode: 'VIDEO',
          numHands: 1,
          minHandDetectionConfidence: 0.55,
          minHandPresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
        });
        try {
          landmarkerRef.current = await createLandmarker('GPU');
        } catch (gpuError) {
          console.warn('GPU hand tracking unavailable; falling back to CPU', gpuError);
          landmarkerRef.current = await createLandmarker('CPU');
        }
      }
      if (startToken !== startTokenRef.current) return;
      setStatus('active');
      let lastInference = -Infinity;
      let lastVideoTime = -1;
      const detect = (now: number) => {
        rafRef.current = requestAnimationFrame(detect);
        const video = videoRef.current;
        if (!video || video.readyState < 2 || framePendingRef.current || now - lastInference < INFERENCE_INTERVAL || video.currentTime === lastVideoTime) return;
        lastInference = now;
        lastVideoTime = video.currentTime;
        if (trackingMode === 'worker' && workerRef.current) {
          framePendingRef.current = true;
          void createImageBitmap(video).then((bitmap) => {
            if (startToken !== startTokenRef.current || !workerRef.current) {
              bitmap.close();
              framePendingRef.current = false;
              return;
            }
            workerRef.current.postMessage({ type: 'frame', bitmap, timestamp: now }, [bitmap]);
          }).catch((error) => {
            framePendingRef.current = false;
            console.warn('Unable to capture hand tracking frame', error);
          });
          return;
        }
        const activeLandmarker = landmarkerRef.current;
        if (!activeLandmarker) return;
        framePendingRef.current = true;
        try {
          const result = activeLandmarker.detectForVideo(video, now);
          publishResult(result.landmarks[0] ?? [], result.handednesses[0]?.[0]?.score ?? 0, now);
        } catch (detectError) {
          console.error('Hand tracking stopped', detectError);
          setStatus('modelError');
          setErrorMessage('手势识别暂时不可用，摄像头仍保持开启');
          return;
        } finally {
          framePendingRef.current = false;
        }
      };
      rafRef.current = requestAnimationFrame(detect);
    } catch (error) {
      console.error('Hand tracking model failed to load', error);
      if (startToken !== startTokenRef.current) return;
      setStatus('modelError');
      setErrorMessage('手势模型加载失败，摄像头仍保持开启');
    }
  }, [publishResult, stop]);

  useEffect(() => stop, [stop]);

  return { videoRef, gestureRef, enabled, handPresent, status, errorMessage, start, stop };
}
