import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  INFERENCE_FATAL_MESSAGE,
  WORKER_FRAME_ERROR_LIMIT,
  WORKER_INIT_TIMEOUT_MS,
  createInference,
  type FrameResult,
  type LandmarkerLike,
  type WorkerLike,
  type WorkerRequest,
} from './inference';

vi.mock('@mediapipe/tasks-vision', () => ({
  FilesetResolver: { forVisionTasks: vi.fn() },
  HandLandmarker: { createFromOptions: vi.fn() },
}));

type FakeWorker = WorkerLike & {
  posted: Array<{ message: WorkerRequest; transfer?: Transferable[] }>;
  terminated: number;
  emit(message: unknown): void;
  fail(message: string): void;
};

function createFakeWorker(options: { autoReady?: boolean; autoError?: string } = {}): FakeWorker {
  const worker: FakeWorker = {
    posted: [],
    terminated: 0,
    onmessage: null,
    onerror: null,
    postMessage(message, transfer) {
      worker.posted.push({ message, transfer });
      if (message.type !== 'init') return;
      if (options.autoReady) {
        setTimeout(() => worker.emit({ type: 'ready', delegate: 'GPU' }), 0);
      }
      if (options.autoError) {
        setTimeout(() => worker.fail(options.autoError as string), 0);
      }
    },
    terminate() {
      worker.terminated += 1;
    },
    emit(message) {
      worker.onmessage?.({ data: message } as unknown as MessageEvent);
    },
    fail(message) {
      worker.onerror?.({ message });
    },
  };
  return worker;
}

type FakeLandmarker = LandmarkerLike & { detectCalls: number; closed: number };

function createFakeLandmarker(options: { throwOnDetect?: boolean } = {}): FakeLandmarker {
  const landmarker: FakeLandmarker = {
    detectCalls: 0,
    closed: 0,
    detectForVideo() {
      landmarker.detectCalls += 1;
      if (options.throwOnDetect) throw new Error('detect failed');
      return { landmarks: [[{ x: 0.2, y: 0.3 }]], handednesses: [[{ score: 0.87 }]] };
    },
    close() {
      landmarker.closed += 1;
    },
  };
  return landmarker;
}

const video = {} as HTMLVideoElement;

function baseOptions(onResult: (result: FrameResult) => void, onFatal: (message: string) => void) {
  return {
    wasmPath: '/mediapipe/wasm',
    modelPath: '/mediapipe/models/hand_landmarker.task',
    signal: new AbortController().signal,
    onResult,
    onFatal,
  };
}

beforeEach(() => {
  vi.stubGlobal('Worker', function WorkerStub() {});
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ close: vi.fn() }) as unknown as ImageBitmap));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('createInference worker 模式', () => {
  it('优先使用 worker，逐帧投递位图并回传结果', async () => {
    const worker = createFakeWorker({ autoReady: true });
    const results: FrameResult[] = [];
    const handle = await createInference({
      ...baseOptions((result) => results.push(result), vi.fn()),
      workerFactory: () => worker,
      landmarkerFactory: vi.fn(),
    });
    expect(handle.mode).toBe('worker');
    expect(worker.posted[0].message).toEqual({
      type: 'init',
      wasmPath: '/mediapipe/wasm',
      modelPath: '/mediapipe/models/hand_landmarker.task',
    });

    expect(handle.detect(video, 120)).toBe(true);
    await vi.waitFor(() => expect(worker.posted.some((entry) => entry.message.type === 'frame')).toBe(true));
    const frame = worker.posted.find((entry) => entry.message.type === 'frame');
    expect(frame?.message).toMatchObject({ type: 'frame', timestamp: 120 });
    expect(frame?.transfer?.[0]).toBe((frame?.message as { bitmap: unknown }).bitmap);

    worker.emit({ type: 'result', landmarks: [{ x: 0.1, y: 0.2 }], confidence: 0.9, timestamp: 120 });
    expect(results).toEqual([{ landmarks: [{ x: 0.1, y: 0.2 }], confidence: 0.9, timestamp: 120 }]);

    handle.stop();
    expect(worker.terminated).toBe(1);
    handle.stop();
    expect(worker.terminated).toBe(1);
  });

  it('worker 忙碌时拒绝新帧，收到结果后恢复', async () => {
    const worker = createFakeWorker({ autoReady: true });
    const handle = await createInference({
      ...baseOptions(vi.fn(), vi.fn()),
      workerFactory: () => worker,
    });
    expect(handle.detect(video, 1)).toBe(true);
    expect(handle.detect(video, 2)).toBe(false);
    worker.emit({ type: 'result', landmarks: [], confidence: 0, timestamp: 1 });
    expect(handle.detect(video, 3)).toBe(true);
  });

  it('worker 初始化失败时终止它并回落到主线程模型', async () => {
    const worker = createFakeWorker({ autoError: 'worker boom' });
    const landmarker = createFakeLandmarker();
    const delegates: Array<'GPU' | 'CPU'> = [];
    const handle = await createInference({
      ...baseOptions(vi.fn(), vi.fn()),
      workerFactory: () => worker,
      landmarkerFactory: async (delegate) => {
        delegates.push(delegate);
        return landmarker;
      },
    });
    expect(handle.mode).toBe('main');
    expect(worker.terminated).toBe(1);
    expect(delegates).toEqual(['GPU']);
    handle.detect(video, 10);
    expect(landmarker.detectCalls).toBe(1);
    handle.stop();
    expect(landmarker.closed).toBe(1);
  });

  it('worker 超时后终止它并回落到主线程模型', async () => {
    vi.useFakeTimers();
    const worker = createFakeWorker();
    const landmarker = createFakeLandmarker();
    const creation = createInference({
      ...baseOptions(vi.fn(), vi.fn()),
      workerFactory: () => worker,
      landmarkerFactory: async () => landmarker,
    });
    await vi.advanceTimersByTimeAsync(WORKER_INIT_TIMEOUT_MS);
    const handle = await creation;
    expect(handle.mode).toBe('main');
    expect(worker.terminated).toBe(1);
  });

  it('初始化途中被取消：不再回落主线程，worker 被终止', async () => {
    const worker = createFakeWorker();
    const landmarkerFactory = vi.fn(async () => createFakeLandmarker());
    const controller = new AbortController();
    const creation = createInference({
      ...baseOptions(vi.fn(), vi.fn()),
      signal: controller.signal,
      workerFactory: () => worker,
      landmarkerFactory,
    });
    controller.abort();
    await expect(creation).rejects.toThrow();
    expect(landmarkerFactory).not.toHaveBeenCalled();
    expect(worker.terminated).toBe(1);
  });

  it('连续帧错误后切换主线程继续识别', async () => {
    const worker = createFakeWorker({ autoReady: true });
    const landmarker = createFakeLandmarker();
    const handle = await createInference({
      ...baseOptions(vi.fn(), vi.fn()),
      workerFactory: () => worker,
      landmarkerFactory: async () => landmarker,
    });
    expect(handle.mode).toBe('worker');
    for (let index = 0; index < WORKER_FRAME_ERROR_LIMIT; index += 1) {
      worker.emit({ type: 'frameError', message: 'frame failed' });
    }
    await vi.waitFor(() => expect(handle.mode).toBe('main'));
    expect(worker.terminated).toBe(1);
    handle.detect(video, 5);
    expect(landmarker.detectCalls).toBe(1);
  });

  it('切换主线程也失败时上报致命错误', async () => {
    const worker = createFakeWorker({ autoReady: true });
    const onFatal = vi.fn();
    let attempts = 0;
    const handle = await createInference({
      ...baseOptions(vi.fn(), onFatal),
      workerFactory: () => worker,
      landmarkerFactory: async () => {
        attempts += 1;
        throw new Error('no landmarker');
      },
    });
    for (let index = 0; index < WORKER_FRAME_ERROR_LIMIT; index += 1) {
      worker.emit({ type: 'frameError', message: 'frame failed' });
    }
    await vi.waitFor(() => expect(onFatal).toHaveBeenCalledWith(INFERENCE_FATAL_MESSAGE));
    expect(attempts).toBe(2);
  });
});

describe('createInference 主线程模式', () => {
  it('GPU 失败时回落到 CPU', async () => {
    const landmarker = createFakeLandmarker();
    const delegates: Array<'GPU' | 'CPU'> = [];
    const handle = await createInference({
      ...baseOptions(vi.fn(), vi.fn()),
      workerFactory: () => {
        throw new Error('worker unsupported');
      },
      landmarkerFactory: async (delegate) => {
        delegates.push(delegate);
        if (delegate === 'GPU') throw new Error('no webgl');
        return landmarker;
      },
    });
    expect(delegates).toEqual(['GPU', 'CPU']);
    expect(handle.mode).toBe('main');
  });

  it('主线程推理抛错时上报致命错误', async () => {
    const landmarker = createFakeLandmarker({ throwOnDetect: true });
    const onFatal = vi.fn();
    const handle = await createInference({
      ...baseOptions(vi.fn(), onFatal),
      workerFactory: () => {
        throw new Error('worker unsupported');
      },
      landmarkerFactory: async () => landmarker,
    });
    handle.detect(video, 1);
    expect(onFatal).toHaveBeenCalledWith(INFERENCE_FATAL_MESSAGE);
    expect(onFatal).toHaveBeenCalledTimes(1);
  });

  it('取消后 stop() 关闭 landmarker 且可重复调用', async () => {
    const landmarker = createFakeLandmarker();
    const controller = new AbortController();
    const handle = await createInference({
      ...baseOptions(vi.fn(), vi.fn()),
      signal: controller.signal,
      workerFactory: () => {
        throw new Error('worker unsupported');
      },
      landmarkerFactory: async () => landmarker,
    });
    controller.abort();
    handle.stop();
    expect(landmarker.closed).toBe(1);
    handle.stop();
    expect(landmarker.closed).toBe(1);
  });
});
