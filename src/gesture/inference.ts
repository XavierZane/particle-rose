import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';
import type { Landmark } from './classifier';

export type FrameResult = {
  landmarks: Landmark[];
  confidence: number;
  timestamp: number;
};

export type WorkerReadyMessage = { type: 'ready'; delegate: 'GPU' | 'CPU' };
export type WorkerResultMessage = { type: 'result'; landmarks: Landmark[]; confidence: number; timestamp: number };
export type WorkerFailureMessage = { type: 'error' | 'frameError'; message: string };
export type WorkerResponse = WorkerReadyMessage | WorkerResultMessage | WorkerFailureMessage;

export type WorkerInitMessage = { type: 'init'; wasmPath: string; modelPath: string };
export type WorkerFrameMessage = { type: 'frame'; bitmap: ImageBitmap; timestamp: number };
export type WorkerStopMessage = { type: 'stop' };
export type WorkerRequest = WorkerInitMessage | WorkerFrameMessage | WorkerStopMessage;

export type WorkerLike = {
  postMessage(message: WorkerRequest, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: { message?: string }) => void) | null;
};

export type LandmarkerLike = {
  detectForVideo(video: HTMLVideoElement | ImageBitmap, timestamp: number): {
    landmarks: Landmark[][];
    handednesses?: Array<Array<{ score: number }>>;
  };
  close(): void;
};

export type LandmarkerFactory = (delegate: 'GPU' | 'CPU') => Promise<LandmarkerLike>;

export type InferenceHandle = {
  readonly mode: 'worker' | 'main';
  /** Returns whether the frame was taken; a busy worker refuses a frame without queueing it. */
  detect(video: HTMLVideoElement, timestamp: number): boolean;
  /** Clears in-flight frame state so tracking can continue after the page was hidden. */
  reset(): void;
  stop(): void;
};

export type InferenceOptions = {
  wasmPath: string;
  modelPath: string;
  signal: AbortSignal;
  onResult: (result: FrameResult) => void;
  onFatal: (message: string) => void;
  workerFactory?: () => WorkerLike;
  landmarkerFactory?: LandmarkerFactory;
  captureFrame?: (video: HTMLVideoElement) => Promise<ImageBitmap>;
  workerTimeoutMs?: number;
  workerFrameErrorLimit?: number;
};

export const WORKER_INIT_TIMEOUT_MS = 20000;
export const WORKER_FRAME_ERROR_LIMIT = 5;
export const INFERENCE_FATAL_MESSAGE = '手势识别不可用，摄像头仍保持开启';

/** Raised internally when the owner aborts tracking; callers treat it as a silent cancellation. */
class InferenceCancelledError extends Error {
  constructor() {
    super('Hand tracking inference was cancelled');
    this.name = 'InferenceCancelledError';
  }
}

function defaultWorkerFactory(): WorkerLike {
  const worker = new Worker(new URL('./handTracker.worker.ts', import.meta.url), { type: 'module' });
  return {
    postMessage: (message, transfer) => {
      if (transfer) worker.postMessage(message, transfer);
      else worker.postMessage(message);
    },
    terminate: () => worker.terminate(),
    get onmessage() {
      return worker.onmessage as WorkerLike['onmessage'];
    },
    set onmessage(handler) {
      worker.onmessage = handler as ((this: Worker, event: MessageEvent) => unknown) | null;
    },
    get onerror() {
      return worker.onerror as WorkerLike['onerror'];
    },
    set onerror(handler) {
      worker.onerror = handler as ((this: AbstractWorker, event: ErrorEvent) => unknown) | null;
    },
  };
}

function defaultCaptureFrame(video: HTMLVideoElement): Promise<ImageBitmap> {
  return createImageBitmap(video);
}

export async function createInference(options: InferenceOptions): Promise<InferenceHandle> {
  const {
    wasmPath,
    modelPath,
    signal,
    onResult,
    onFatal,
    workerTimeoutMs = WORKER_INIT_TIMEOUT_MS,
    workerFrameErrorLimit = WORKER_FRAME_ERROR_LIMIT,
  } = options;
  const captureFrame = options.captureFrame ?? defaultCaptureFrame;

  let mode: 'worker' | 'main' = 'main';
  let worker: WorkerLike | null = null;
  let landmarker: LandmarkerLike | null = null;
  let stopped = false;
  let switching = false;
  let pendingFrame = false;
  let frameErrors = 0;
  let fatalReported = false;
  let landmarkerFactoryPromise: Promise<LandmarkerFactory> | null = null;

  const abortPromise = new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(new InferenceCancelledError());
      return;
    }
    signal.addEventListener('abort', () => reject(new InferenceCancelledError()), { once: true });
  });
  // The race below may already be settled when the owner cancels; keep that
  // rejection from surfacing as a global unhandled rejection.
  void abortPromise.catch(() => {});

  const resolveLandmarkerFactory = (): Promise<LandmarkerFactory> => {
    if (options.landmarkerFactory) return Promise.resolve(options.landmarkerFactory);
    if (!landmarkerFactoryPromise) {
      landmarkerFactoryPromise = (async () => {
        const vision = await FilesetResolver.forVisionTasks(wasmPath, true);
        return (delegate: 'GPU' | 'CPU') => HandLandmarker.createFromOptions(vision, {
          baseOptions: { modelAssetPath: modelPath, delegate },
          runningMode: 'VIDEO',
          numHands: 1,
          minHandDetectionConfidence: 0.55,
          minHandPresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
        }) as Promise<LandmarkerLike>;
      })();
    }
    return landmarkerFactoryPromise;
  };

  const startMainThread = async (): Promise<void> => {
    const factory = await resolveLandmarkerFactory();
    if (signal.aborted) throw new InferenceCancelledError();
    let created: LandmarkerLike;
    try {
      created = await factory('GPU');
    } catch (gpuError) {
      console.warn('GPU hand tracking unavailable; falling back to CPU', gpuError);
      if (signal.aborted) throw new InferenceCancelledError();
      created = await factory('CPU');
    }
    if (signal.aborted) {
      created.close();
      throw new InferenceCancelledError();
    }
    landmarker = created;
    mode = 'main';
  };

  const startWorker = async (): Promise<void> => {
    if (typeof Worker === 'undefined' || typeof createImageBitmap !== 'function') {
      throw new Error('Worker tracking is unsupported');
    }
    const started = (options.workerFactory ?? defaultWorkerFactory)();
    worker = started;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const ready = new Promise<void>((resolve, reject) => {
      timeoutId = setTimeout(() => reject(new Error('Worker model loading timed out')), workerTimeoutMs);
      started.onmessage = (event) => {
        const message = event.data as WorkerResponse;
        if (message.type === 'ready') {
          if (timeoutId !== null) clearTimeout(timeoutId);
          resolve();
        } else if (message.type === 'error') {
          if (timeoutId !== null) clearTimeout(timeoutId);
          reject(new Error(message.message));
        }
      };
      started.onerror = (event) => {
        if (timeoutId !== null) clearTimeout(timeoutId);
        reject(new Error(event.message || 'Worker failed'));
      };
      started.postMessage({ type: 'init', wasmPath, modelPath });
    });
    try {
      await Promise.race([ready, abortPromise]);
    } catch (error) {
      started.terminate();
      worker = null;
      throw error;
    } finally {
      if (timeoutId !== null) clearTimeout(timeoutId);
    }
    if (signal.aborted) {
      started.terminate();
      worker = null;
      throw new InferenceCancelledError();
    }
    mode = 'worker';
  };

  const reportFatal = (message: string) => {
    if (fatalReported || stopped || signal.aborted) return;
    fatalReported = true;
    onFatal(message);
  };

  const fallbackToMainThread = async (reason: string): Promise<void> => {
    if (stopped || switching || signal.aborted) return;
    switching = true;
    console.warn('Worker hand tracking unavailable; using main thread', reason);
    try {
      worker?.terminate();
      worker = null;
      pendingFrame = false;
      frameErrors = 0;
      await startMainThread();
      frameErrors = 0;
    } catch (error) {
      if (signal.aborted || stopped) return;
      console.error('Hand tracking model failed to load', error);
      reportFatal(INFERENCE_FATAL_MESSAGE);
    } finally {
      switching = false;
    }
  };

  const registerFrameError = (message: string) => {
    console.warn('Worker hand tracking frame failed', message);
    if (stopped || switching || signal.aborted) return;
    frameErrors += 1;
    if (frameErrors >= workerFrameErrorLimit) void fallbackToMainThread(`${frameErrors} consecutive frame errors`);
  };

  const handleWorkerMessage = (message: WorkerResponse) => {
    if (message.type === 'result') {
      pendingFrame = false;
      frameErrors = 0;
      onResult({ landmarks: message.landmarks, confidence: message.confidence, timestamp: message.timestamp });
    } else if (message.type === 'frameError') {
      pendingFrame = false;
      registerFrameError(message.message);
    }
  };

  const attachWorkerRuntimeHandlers = (activeWorker: WorkerLike) => {
    activeWorker.onmessage = (event) => handleWorkerMessage(event.data as WorkerResponse);
    activeWorker.onerror = (event) => {
      pendingFrame = false;
      registerFrameError(event.message || 'Worker crashed');
    };
  };

  const detect = (video: HTMLVideoElement, timestamp: number): boolean => {
    if (stopped) return false;
    if (mode === 'worker') {
      const activeWorker = worker;
      if (!activeWorker || pendingFrame) return false;
      pendingFrame = true;
      void captureFrame(video)
        .then((bitmap) => {
          const target = worker;
          if (stopped || !target) {
            bitmap.close();
            pendingFrame = false;
            return;
          }
          target.postMessage({ type: 'frame', bitmap, timestamp }, [bitmap]);
        })
        .catch((error) => {
          pendingFrame = false;
          console.warn('Unable to capture hand tracking frame', error);
        });
      return true;
    }
    const activeLandmarker = landmarker;
    if (!activeLandmarker) return false;
    try {
      const result = activeLandmarker.detectForVideo(video, timestamp);
      onResult({ landmarks: result.landmarks[0] ?? [], confidence: result.handednesses?.[0]?.[0]?.score ?? 0, timestamp });
    } catch (error) {
      console.error('Hand tracking stopped', error);
      reportFatal(INFERENCE_FATAL_MESSAGE);
    }
    return true;
  };

  const reset = () => {
    pendingFrame = false;
    frameErrors = 0;
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    pendingFrame = false;
    worker?.terminate();
    worker = null;
    landmarker?.close();
    landmarker = null;
  };

  try {
    try {
      await startWorker();
      if (worker) attachWorkerRuntimeHandlers(worker);
    } catch (workerError) {
      if (signal.aborted) throw new InferenceCancelledError();
      await startMainThread();
    }
  } catch (error) {
    stop();
    throw error;
  }

  return {
    get mode() {
      return mode;
    },
    detect,
    reset,
    stop,
  };
}
