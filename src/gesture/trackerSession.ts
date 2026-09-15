import type { InferenceHandle } from './inference';

export type TrackerStatus =
  | 'idle'
  | 'requesting'
  | 'loadingModel'
  | 'active'
  | 'recovering'
  | 'cameraError'
  | 'modelError'
  | 'unsupported';

export type TrackerSnapshot = {
  status: TrackerStatus;
  message: string;
};

export type TrackLike = {
  readyState?: string;
  muted?: boolean;
  stop(): void;
  addEventListener(type: string, listener: () => void, options?: { once?: boolean }): void;
  removeEventListener?(type: string, listener: () => void): void;
};

export type StreamLike = {
  getTracks(): TrackLike[];
  getVideoTracks(): TrackLike[];
};

export type TrackerDeps = {
  mediaDevicesAvailable: () => boolean;
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<StreamLike>;
  getVideo: () => HTMLVideoElement | null;
  createInference: (signal: AbortSignal, onFatal: (message: string) => void) => Promise<InferenceHandle>;
  beginTracking: (handle: InferenceHandle) => void;
  endTracking: () => void;
  resetTracking: () => void;
  resetGesture: () => void;
  onUpdate: (snapshot: TrackerSnapshot) => void;
  delay?: (milliseconds: number) => Promise<void>;
  logger?: { warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void };
};

export const CAMERA_CONSTRAINTS: MediaStreamConstraints = {
  video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } },
  audio: false,
};

export const RELAXED_CAMERA_CONSTRAINTS: MediaStreamConstraints = {
  video: { facingMode: 'user' },
  audio: false,
};

/** Manual starts retry once on transient camera errors; automatic recovery backs off three times. */
export const MANUAL_RETRY_DELAYS = [600] as const;
export const RECOVERY_RETRY_DELAYS = [500, 1500, 3000] as const;
export const ACQUIRE_TIMEOUT_MS = 45000;
export const RECOVERY_ACQUIRE_TIMEOUT_MS = 8000;

export const TRACKER_MESSAGES = {
  permission: '摄像头权限被拒绝，请在浏览器地址栏允许摄像头后重试',
  notFound: '没有检测到可用摄像头',
  busy: '摄像头被其他应用或页面占用，请关闭后重试',
  insecure: '当前环境不支持摄像头，请用 HTTPS 或 localhost 打开',
  constraints: '摄像头不支持所需分辨率，请重试',
  preview: '视频预览启动失败，请点击页面后重试',
  unknown: '无法启动摄像头，请检查设备是否被其他应用占用',
  modelLoad: '手势模型加载失败，摄像头仍保持开启',
  cameraLost: '摄像头已停止，请点击重试',
} as const;

type AcquireFailure = 'permission' | 'notFound' | 'busy' | 'insecure' | 'constraints' | 'unknown';

type RunOptions = {
  recovering: boolean;
  retryDelays: readonly number[];
  acquireTimeoutMs: number;
};

const MANUAL_RUN: RunOptions = {
  recovering: false,
  retryDelays: MANUAL_RETRY_DELAYS,
  acquireTimeoutMs: ACQUIRE_TIMEOUT_MS,
};

const RECOVERY_RUN: RunOptions = {
  recovering: true,
  retryDelays: RECOVERY_RETRY_DELAYS,
  acquireTimeoutMs: RECOVERY_ACQUIRE_TIMEOUT_MS,
};

export function isBusyStatus(status: TrackerStatus): boolean {
  return status === 'requesting' || status === 'loadingModel' || status === 'recovering';
}

function errorName(error: unknown): string {
  return error instanceof Error || error instanceof DOMException ? error.name : '';
}

function classifyAcquireFailure(error: unknown): AcquireFailure {
  switch (errorName(error)) {
    case 'NotAllowedError':
      return 'permission';
    case 'SecurityError':
      return 'insecure';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'notFound';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'busy';
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return 'constraints';
    default:
      return 'unknown';
  }
}

function isRetryableAcquireFailure(error: unknown): boolean {
  const name = errorName(error);
  return name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError';
}

function stopStream(stream: StreamLike): void {
  try {
    stream.getTracks().forEach((track) => track.stop());
  } catch (error) {
    console.warn('Unable to release camera tracks', error);
  }
}

function createAbortPromise(signal: AbortSignal): Promise<never> {
  const promise = new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Camera acquisition aborted', 'AbortError'));
      return;
    }
    signal.addEventListener('abort', () => reject(new DOMException('Camera acquisition aborted', 'AbortError')), { once: true });
  });
  // The race may settle first; keep the pending rejection from surfacing globally.
  void promise.catch(() => {});
  return promise;
}

export class TrackerSession {
  private readonly deps: TrackerDeps;
  private readonly delay: (milliseconds: number) => Promise<void>;
  private readonly logger: { warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void };
  private status: TrackerStatus = 'idle';
  private message = '';
  private generation = 0;
  private controller: AbortController | null = null;
  private stream: StreamLike | null = null;
  private handle: InferenceHandle | null = null;
  private detachTracks: (() => void) | null = null;
  private suspended = false;
  private recovering: Promise<void> | null = null;

  constructor(deps: TrackerDeps) {
    this.deps = deps;
    this.delay = deps.delay ?? ((milliseconds) => new Promise((resolve) => { setTimeout(resolve, milliseconds); }));
    this.logger = deps.logger ?? console;
  }

  get snapshot(): TrackerSnapshot {
    return { status: this.status, message: this.message };
  }

  get isBusy(): boolean {
    return isBusyStatus(this.status);
  }

  /** Starts the camera. Called straight from a click handler so the user-gesture context survives. */
  start(): Promise<void> {
    if (this.isBusy || this.status === 'active') return Promise.resolve();
    return this.run(MANUAL_RUN);
  }

  retry(): Promise<void> {
    if (this.isBusy || this.status === 'active') return Promise.resolve();
    if (this.status === 'modelError' && this.hasLiveStream()) return this.rebuildInference();
    return this.run(MANUAL_RUN);
  }

  stop(): void {
    this.suspended = false;
    this.teardown();
    this.set('idle', '');
  }

  dismissError(): void {
    if (this.isBusy || this.message === '') return;
    // Dismissing also resets the camera: the status text would otherwise claim
    // "not enabled" while the device is still held (e.g. after a model error).
    this.stop();
  }

  async handleVisibility(visible: boolean): Promise<void> {
    if (!visible) {
      if (this.canSuspend()) this.suspended = true;
      return;
    }
    if (!this.suspended) return;
    this.suspended = false;
    await this.recover();
  }

  async handlePageHide(persisted: boolean): Promise<void> {
    if (!this.canSuspend()) return;
    this.suspended = true;
    if (persisted) return;
    // Real unload (reload/close/navigation): give the camera back right away so the
    // next page load never fights the previous session for the device.
    this.teardown();
    this.set('idle', '');
  }

  async handlePageShow(): Promise<void> {
    if (!this.suspended) return;
    this.suspended = false;
    await this.recover();
  }

  /**
   * Safety net: some browsers end a track without firing `ended` (script `stop()`,
   * or the OS revoking the camera while the page is hidden). Called by the frame loop.
   */
  checkStreamHealth(): void {
    if (this.status !== 'active') return;
    const track = this.stream?.getVideoTracks()[0];
    if (!this.stream || !track) return;
    if (track.readyState === 'ended') void this.recover();
  }

  private async run(options: RunOptions): Promise<void> {
    this.teardown();
    const generation = this.generation;
    const controller = new AbortController();
    this.controller = controller;
    const abortPromise = createAbortPromise(controller.signal);
    this.deps.resetGesture();
    this.set(options.recovering ? 'recovering' : 'requesting');

    if (!this.deps.mediaDevicesAvailable()) {
      this.set('unsupported', TRACKER_MESSAGES.insecure);
      return;
    }

    let stream: StreamLike;
    try {
      stream = await this.acquireStream(controller.signal, abortPromise, options);
    } catch (error) {
      if (this.isStale(generation, controller)) return;
      this.logger.warn('Camera initialization failed', error);
      if (options.recovering) {
        this.set('cameraError', TRACKER_MESSAGES.cameraLost);
        return;
      }
      const failure = classifyAcquireFailure(error);
      this.set(failure === 'insecure' ? 'unsupported' : 'cameraError', TRACKER_MESSAGES[failure]);
      return;
    }

    if (this.isStale(generation, controller)) {
      stopStream(stream);
      return;
    }
    this.setStream(stream, generation);

    const video = this.deps.getVideo();
    try {
      if (!video) throw new Error('Camera preview element is unavailable');
      await this.playVideo(video, stream);
    } catch (error) {
      if (this.isStale(generation, controller)) {
        this.releaseStream();
        return;
      }
      this.logger.warn('Camera preview failed', error);
      this.releaseStream();
      this.set('cameraError', options.recovering ? TRACKER_MESSAGES.cameraLost : TRACKER_MESSAGES.preview);
      return;
    }

    if (this.isStale(generation, controller)) {
      this.releaseStream();
      return;
    }
    this.set('loadingModel');
    await this.loadInference(generation, controller);
  }

  private async rebuildInference(): Promise<void> {
    this.deps.endTracking();
    this.handle = null;
    const controller = this.controller ?? new AbortController();
    this.controller = controller;
    this.set('loadingModel');
    await this.loadInference(this.generation, controller);
  }

  private async loadInference(generation: number, controller: AbortController): Promise<void> {
    try {
      const handle = await this.deps.createInference(
        controller.signal,
        (message) => this.handleInferenceFatal(generation, message),
      );
      if (this.isStale(generation, controller)) {
        handle.stop();
        return;
      }
      this.handle = handle;
      this.deps.beginTracking(handle);
      this.set('active');
    } catch (error) {
      if (this.isStale(generation, controller)) return;
      this.logger.error('Hand tracking model failed to load', error);
      this.set('modelError', TRACKER_MESSAGES.modelLoad);
    }
  }

  private handleInferenceFatal(generation: number, message: string): void {
    if (generation !== this.generation) return;
    this.deps.endTracking();
    this.handle = null;
    this.set('modelError', message);
  }

  private async acquireStream(
    signal: AbortSignal,
    abortPromise: Promise<never>,
    options: RunOptions,
  ): Promise<StreamLike> {
    let retries = 0;
    let relaxed = false;
    for (;;) {
      const constraints = relaxed ? RELAXED_CAMERA_CONSTRAINTS : CAMERA_CONSTRAINTS;
      try {
        return await this.acquireWithTimeout(constraints, abortPromise, options.acquireTimeoutMs);
      } catch (error) {
        if (signal.aborted) throw error;
        if (classifyAcquireFailure(error) === 'constraints' && !relaxed) {
          relaxed = true;
          continue;
        }
        if (isRetryableAcquireFailure(error) && retries < options.retryDelays.length) {
          const wait = options.retryDelays[retries];
          retries += 1;
          if (wait > 0) await this.delay(wait);
          continue;
        }
        throw error;
      }
    }
  }

  private async acquireWithTimeout(
    constraints: MediaStreamConstraints,
    abortPromise: Promise<never>,
    timeoutMs: number,
  ): Promise<StreamLike> {
    const pending = this.deps.getUserMedia(constraints);
    let consumed = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(() => reject(new Error('Camera acquisition timed out')), timeoutMs);
    });
    try {
      const stream = await Promise.race([pending, timeout, abortPromise]);
      consumed = true;
      return stream;
    } finally {
      if (timeoutId !== null) clearTimeout(timeoutId);
      if (!consumed) {
        // The race already lost (cancelled or timed out) but the browser may still hand
        // the stream over later; release it right away so the camera is not held hostage.
        void pending.then((stream) => stopStream(stream)).catch(() => {});
      }
    }
  }

  private async recover(): Promise<void> {
    if (this.recovering) return this.recovering;
    const task = (async () => {
      try {
        await this.performRecovery();
      } finally {
        this.recovering = null;
      }
    })();
    this.recovering = task;
    return task;
  }

  private async performRecovery(): Promise<void> {
    const previous = this.status;
    if (previous === 'idle' && !this.stream) {
      // The page unload released the camera; run the whole start pipeline again.
      await this.run(RECOVERY_RUN);
      return;
    }
    if (previous === 'idle' || previous === 'cameraError' || previous === 'modelError' || previous === 'unsupported') return;

    const track = this.stream?.getVideoTracks()[0];
    const trackAlive = Boolean(this.stream && track && track.readyState !== 'ended');
    const video = this.deps.getVideo();
    if (this.stream && trackAlive && video) {
      const stillLoading = previous === 'loadingModel';
      if (!stillLoading) this.set('recovering');
      try {
        await this.playVideo(video, this.stream);
        this.deps.resetTracking();
        if (!stillLoading) this.set('active');
        return;
      } catch (error) {
        this.logger.warn('Camera preview could not resume; re-acquiring the stream', error);
        if (stillLoading) return;
      }
    }
    await this.run(RECOVERY_RUN);
  }

  private async playVideo(video: HTMLVideoElement, stream: StreamLike): Promise<void> {
    const media = stream as unknown as MediaStream;
    video.muted = true;
    if (video.srcObject !== media) video.srcObject = media;
    await video.play();
  }

  private setStream(stream: StreamLike, generation: number): void {
    this.releaseStream();
    this.stream = stream;
    const track = stream.getVideoTracks()[0];
    if (!track) return;
    const onEnded = () => {
      if (generation !== this.generation) return;
      if (this.status !== 'active' && this.status !== 'recovering') return;
      void this.recover();
    };
    const onMute = () => {
      if (generation !== this.generation) return;
      if (this.status !== 'active') return;
      this.suspended = true;
    };
    const onUnmute = () => {
      if (generation !== this.generation) return;
      void this.recover();
    };
    track.addEventListener('ended', onEnded);
    track.addEventListener('mute', onMute);
    track.addEventListener('unmute', onUnmute);
    this.detachTracks = () => {
      track.removeEventListener?.('ended', onEnded);
      track.removeEventListener?.('mute', onMute);
      track.removeEventListener?.('unmute', onUnmute);
    };
  }

  private releaseStream(): void {
    this.detachTracks?.();
    this.detachTracks = null;
    const stream = this.stream;
    this.stream = null;
    if (stream) stopStream(stream);
    const video = this.deps.getVideo();
    if (video && video.srcObject) video.srcObject = null;
  }

  private teardown(): void {
    this.generation += 1;
    this.controller?.abort();
    this.controller = null;
    this.deps.endTracking();
    this.handle = null;
    this.releaseStream();
  }

  private hasLiveStream(): boolean {
    const track = this.stream?.getVideoTracks()[0];
    return Boolean(this.stream && track && track.readyState !== 'ended');
  }

  private canSuspend(): boolean {
    return this.status === 'active' || this.status === 'loadingModel' || this.status === 'recovering';
  }

  private isStale(generation: number, controller: AbortController): boolean {
    return generation !== this.generation || controller.signal.aborted;
  }

  private set(status: TrackerStatus, message = ''): void {
    if (this.status === status && this.message === message) return;
    this.status = status;
    this.message = message;
    this.deps.onUpdate({ status, message });
  }
}
