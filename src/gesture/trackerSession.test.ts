import { describe, expect, it, vi } from 'vitest';
import type { InferenceHandle } from './inference';
import {
  RELAXED_CAMERA_CONSTRAINTS,
  TRACKER_MESSAGES,
  TrackerSession,
  type StreamLike,
  type TrackerDeps,
  type TrackerSnapshot,
} from './trackerSession';

type TrackStub = {
  readyState: string;
  muted: boolean;
  stopCalls: number;
  stop(): void;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
  emit(type: string): void;
};

type StreamStub = {
  track: TrackStub;
  getTracks(): TrackStub[];
  getVideoTracks(): TrackStub[];
};

type VideoStub = {
  muted: boolean;
  srcObject: unknown;
  readyState: number;
  currentTime: number;
  paused: boolean;
  playCalls: number;
  playError: Error | null;
  play(): Promise<void>;
};

function createTrack(): TrackStub {
  const listeners = new Map<string, Array<() => void>>();
  const track: TrackStub = {
    readyState: 'live',
    muted: false,
    stopCalls: 0,
    stop() {
      track.stopCalls += 1;
      track.readyState = 'ended';
      track.emit('ended');
    },
    addEventListener(type, listener) {
      const entries = listeners.get(type) ?? [];
      entries.push(listener);
      listeners.set(type, entries);
    },
    removeEventListener(type, listener) {
      const entries = listeners.get(type) ?? [];
      listeners.set(type, entries.filter((entry) => entry !== listener));
    },
    emit(type) {
      (listeners.get(type) ?? []).forEach((listener) => listener());
    },
  };
  return track;
}

function createStream(): StreamStub {
  const track = createTrack();
  return {
    track,
    getTracks: () => [track],
    getVideoTracks: () => [track],
  };
}

function createVideo(): VideoStub {
  const video: VideoStub = {
    muted: false,
    srcObject: null,
    readyState: 4,
    currentTime: 0,
    paused: true,
    playCalls: 0,
    playError: null,
    async play() {
      video.playCalls += 1;
      if (video.playError) throw video.playError;
      video.paused = false;
    },
  };
  return video;
}

type HandleStub = InferenceHandle & { stopCalls: number; resetCalls: number };

function createHandle(): HandleStub {
  const handle: HandleStub = {
    mode: 'main',
    stopCalls: 0,
    resetCalls: 0,
    detect: () => true,
    reset() {
      handle.resetCalls += 1;
    },
    stop() {
      handle.stopCalls += 1;
    },
  };
  return handle;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createHarness() {
  const video = createVideo();
  const snapshots: TrackerSnapshot[] = [];
  const streams: StreamStub[] = [];
  const getUserMedia = vi.fn(async (_constraints: MediaStreamConstraints) => {
    const stream = createStream();
    streams.push(stream);
    return stream as unknown as StreamLike;
  });
  const createInference = vi.fn(async (_signal: AbortSignal, _onFatal: (message: string) => void) => createHandle());
  const mediaDevicesAvailable = vi.fn(() => true);
  const beginTracking = vi.fn((_handle: InferenceHandle) => {});
  const endTracking = vi.fn(() => {});
  const resetTracking = vi.fn(() => {});
  const resetGesture = vi.fn(() => {});
  const delay = vi.fn(async (_milliseconds: number) => {});

  const deps: TrackerDeps = {
    mediaDevicesAvailable,
    getUserMedia,
    getVideo: () => video as unknown as HTMLVideoElement,
    createInference,
    beginTracking,
    endTracking,
    resetTracking,
    resetGesture,
    onUpdate: (snapshot) => { snapshots.push(snapshot); },
    delay,
    logger: { warn: () => {}, error: () => {} },
  };

  const session = new TrackerSession(deps);
  return {
    session,
    deps,
    video,
    streams,
    snapshots,
    getUserMedia,
    createInference,
    mediaDevicesAvailable,
    beginTracking,
    endTracking,
    resetTracking,
    resetGesture,
    delay,
    statuses: () => snapshots.map((snapshot) => snapshot.status),
    last: () => snapshots[snapshots.length - 1],
  };
}

describe('TrackerSession 启动', () => {
  it('正常启动走 requesting → loadingModel → active 并挂上视频流', async () => {
    const h = createHarness();
    await h.session.start();
    expect(h.statuses()).toEqual(['requesting', 'loadingModel', 'active']);
    expect(h.getUserMedia).toHaveBeenCalledTimes(1);
    expect(h.video.playCalls).toBe(1);
    expect(h.video.srcObject).toBe(h.streams[0]);
    expect(h.beginTracking).toHaveBeenCalledTimes(1);
    expect(h.session.snapshot).toEqual({ status: 'active', message: '' });
    expect(h.session.isBusy).toBe(false);
  });

  it('start() 里同步调用 getUserMedia，保住手机上的用户手势上下文', async () => {
    const h = createHarness();
    const pending = deferred<StreamLike>();
    h.getUserMedia.mockImplementation(() => pending.promise);
    const started = h.session.start();
    expect(h.getUserMedia).toHaveBeenCalledTimes(1);
    h.session.stop();
    const stream = createStream();
    pending.resolve(stream as unknown as StreamLike);
    await started;
    await vi.waitFor(() => expect(stream.track.stopCalls).toBe(1));
    expect(h.last().status).toBe('idle');
  });

  it('启动过程中重复点击只取一次流，active 后 start() 也不重复取流', async () => {
    const h = createHarness();
    const pending = deferred<StreamLike>();
    h.getUserMedia.mockImplementation(() => pending.promise);
    const first = h.session.start();
    const second = h.session.start();
    expect(h.getUserMedia).toHaveBeenCalledTimes(1);
    pending.resolve(createStream() as unknown as StreamLike);
    await Promise.all([first, second]);
    expect(h.last().status).toBe('active');
    await h.session.start();
    expect(h.getUserMedia).toHaveBeenCalledTimes(1);
  });

  it('等待授权时 stop()：拿到流后立刻释放，且不再启动推理', async () => {
    const h = createHarness();
    const pending = deferred<StreamLike>();
    h.getUserMedia.mockImplementation(() => pending.promise);
    const started = h.session.start();
    h.session.stop();
    const stream = createStream();
    pending.resolve(stream as unknown as StreamLike);
    await started;
    await vi.waitFor(() => expect(stream.track.stopCalls).toBe(1));
    expect(h.createInference).not.toHaveBeenCalled();
    expect(h.statuses()).toEqual(['requesting', 'idle']);
  });

  it('模型加载中 stop()：取消推理信号，晚到的 landmarker 会被关闭', async () => {
    const h = createHarness();
    const pendingInference = deferred<HandleStub>();
    const signals: AbortSignal[] = [];
    h.createInference.mockImplementation((signal: AbortSignal) => {
      signals.push(signal);
      return pendingInference.promise;
    });
    const started = h.session.start();
    await vi.waitFor(() => expect(h.createInference).toHaveBeenCalledTimes(1));
    expect(signals[0].aborted).toBe(false);
    h.session.stop();
    expect(signals[0].aborted).toBe(true);
    const handle = createHandle();
    pendingInference.resolve(handle);
    await started;
    expect(handle.stopCalls).toBe(1);
    expect(h.beginTracking).not.toHaveBeenCalled();
    expect(h.last().status).toBe('idle');
    expect(h.streams[0].track.stopCalls).toBe(1);
  });
});

describe('TrackerSession 失败处理', () => {
  it('摄像头被占用时先退避重试一次，成功则继续启动', async () => {
    const h = createHarness();
    h.getUserMedia.mockRejectedValueOnce(new DOMException('busy', 'NotReadableError'));
    await h.session.start();
    expect(h.getUserMedia).toHaveBeenCalledTimes(2);
    expect(h.delay.mock.calls.map(([wait]) => wait)).toEqual([600]);
    expect(h.last().status).toBe('active');
  });

  it('摄像头持续被占用时提示"被其他应用或页面占用"', async () => {
    const h = createHarness();
    h.getUserMedia.mockRejectedValue(new DOMException('busy', 'NotReadableError'));
    await h.session.start();
    expect(h.getUserMedia).toHaveBeenCalledTimes(2);
    expect(h.delay.mock.calls.map(([wait]) => wait)).toEqual([600]);
    expect(h.last()).toEqual({ status: 'cameraError', message: TRACKER_MESSAGES.busy });
  });

  it('权限被拒绝时不重试，并给出权限提示', async () => {
    const h = createHarness();
    h.getUserMedia.mockRejectedValue(new DOMException('denied', 'NotAllowedError'));
    await h.session.start();
    expect(h.getUserMedia).toHaveBeenCalledTimes(1);
    expect(h.delay).not.toHaveBeenCalled();
    expect(h.last()).toEqual({ status: 'cameraError', message: TRACKER_MESSAGES.permission });
  });

  it('分辨率不支持时用宽松约束再试一次', async () => {
    const h = createHarness();
    h.getUserMedia.mockRejectedValueOnce(new DOMException('no match', 'OverconstrainedError'));
    await h.session.start();
    expect(h.getUserMedia).toHaveBeenCalledTimes(2);
    expect(h.getUserMedia.mock.calls[1][0]).toEqual(RELAXED_CAMERA_CONSTRAINTS);
    expect(h.last().status).toBe('active');
  });

  it('非安全来源直接进入 unsupported，不调用 getUserMedia', async () => {
    const h = createHarness();
    h.mediaDevicesAvailable.mockReturnValue(false);
    await h.session.start();
    expect(h.getUserMedia).not.toHaveBeenCalled();
    expect(h.last()).toEqual({ status: 'unsupported', message: TRACKER_MESSAGES.insecure });
  });

  it('视频预览播放失败时提示预览问题，而不是权限被拒', async () => {
    const h = createHarness();
    h.video.playError = new DOMException('blocked', 'NotAllowedError');
    await h.session.start();
    expect(h.last()).toEqual({ status: 'cameraError', message: TRACKER_MESSAGES.preview });
    expect(h.last().message).not.toContain('权限');
    expect(h.createInference).not.toHaveBeenCalled();
    expect(h.streams[0].track.stopCalls).toBe(1);
    expect(h.video.srcObject).toBeNull();
  });
});

describe('TrackerSession 掉线恢复', () => {
  it('媒体流还活着时只重新 play，不重新取流', async () => {
    const h = createHarness();
    await h.session.start();
    h.video.paused = true;
    await h.session.handleVisibility(false);
    await h.session.handleVisibility(true);
    expect(h.getUserMedia).toHaveBeenCalledTimes(1);
    expect(h.video.playCalls).toBe(2);
    expect(h.video.paused).toBe(false);
    expect(h.resetTracking).toHaveBeenCalledTimes(1);
    expect(h.statuses()).toEqual(['requesting', 'loadingModel', 'active', 'recovering', 'active']);
  });

  it('媒体流结束时自动重新取流，并重新开始跟踪', async () => {
    const h = createHarness();
    await h.session.start();
    h.streams[0].track.readyState = 'ended';
    h.streams[0].track.emit('ended');
    await vi.waitFor(() => expect(h.getUserMedia).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(h.last().status).toBe('active'));
    expect(h.beginTracking).toHaveBeenCalledTimes(2);
    expect(h.delay).not.toHaveBeenCalled();
  });

  it('媒体流悄悄结束（没有 ended 事件）时，健康检查也会重新取流', async () => {
    const h = createHarness();
    await h.session.start();
    h.streams[0].track.readyState = 'ended';
    h.session.checkStreamHealth();
    await vi.waitFor(() => expect(h.getUserMedia).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(h.last().status).toBe('active'));
    expect(h.beginTracking).toHaveBeenCalledTimes(2);
  });

  it('恢复过程中遇到占用错误会按 0.5/1.5 秒退避重试', async () => {
    const h = createHarness();
    await h.session.start();
    h.getUserMedia
      .mockRejectedValueOnce(new DOMException('busy', 'NotReadableError'))
      .mockRejectedValueOnce(new DOMException('busy', 'NotReadableError'));
    h.streams[0].track.readyState = 'ended';
    h.streams[0].track.emit('ended');
    await vi.waitFor(() => expect(h.last().status).toBe('active'));
    expect(h.delay.mock.calls.map(([wait]) => wait)).toEqual([500, 1500]);
    expect(h.getUserMedia).toHaveBeenCalledTimes(4);
  });

  it('恢复彻底失败时提示手动重试并释放摄像头与推理', async () => {
    const h = createHarness();
    await h.session.start();
    h.getUserMedia.mockRejectedValue(new DOMException('busy', 'NotReadableError'));
    h.streams[0].track.readyState = 'ended';
    h.streams[0].track.emit('ended');
    await vi.waitFor(() => expect(h.last().status).toBe('cameraError'));
    expect(h.last().message).toBe(TRACKER_MESSAGES.cameraLost);
    expect(h.delay.mock.calls.map(([wait]) => wait)).toEqual([500, 1500, 3000]);
    expect(h.endTracking).toHaveBeenCalled();
    expect(h.video.srcObject).toBeNull();
  });

  it('pagehide(persisted=false) 立即归还摄像头，pageshow 后自动重启', async () => {
    const h = createHarness();
    await h.session.start();
    await h.session.handlePageHide(false);
    expect(h.streams[0].track.stopCalls).toBe(1);
    expect(h.video.srcObject).toBeNull();
    expect(h.last().status).toBe('idle');
    await h.session.handlePageShow();
    expect(h.getUserMedia).toHaveBeenCalledTimes(2);
    expect(h.last().status).toBe('active');
  });

  it('pagehide(persisted=true) 保留流，pageshow 后重新 play', async () => {
    const h = createHarness();
    await h.session.start();
    await h.session.handlePageHide(true);
    expect(h.streams[0].track.stopCalls).toBe(0);
    expect(h.last().status).toBe('active');
    h.video.paused = true;
    await h.session.handlePageShow();
    expect(h.getUserMedia).toHaveBeenCalledTimes(1);
    expect(h.video.playCalls).toBe(2);
    expect(h.last().status).toBe('active');
  });

  it('自己 stop() 触发的 ended 事件不会引发恢复', async () => {
    const h = createHarness();
    await h.session.start();
    h.session.stop();
    await Promise.resolve();
    expect(h.getUserMedia).toHaveBeenCalledTimes(1);
    expect(h.statuses()).toEqual(['requesting', 'loadingModel', 'active', 'idle']);
  });
});

describe('TrackerSession 模型错误与状态', () => {
  it('模型加载失败时摄像头保持开启，retry() 只重建推理', async () => {
    const h = createHarness();
    h.createInference.mockRejectedValueOnce(new Error('model boom'));
    await h.session.start();
    expect(h.last()).toEqual({ status: 'modelError', message: TRACKER_MESSAGES.modelLoad });
    expect(h.video.srcObject).toBe(h.streams[0]);
    expect(h.streams[0].track.stopCalls).toBe(0);
    await h.session.retry();
    expect(h.getUserMedia).toHaveBeenCalledTimes(1);
    expect(h.createInference).toHaveBeenCalledTimes(2);
    expect(h.last().status).toBe('active');
  });

  it('运行时推理上报致命错误会切到 modelError 并停止跟踪', async () => {
    const h = createHarness();
    let fatal: ((message: string) => void) | null = null;
    h.createInference.mockImplementation(async (_signal: AbortSignal, onFatal: (message: string) => void) => {
      fatal = onFatal;
      return createHandle();
    });
    await h.session.start();
    fatal!('手势识别不可用，摄像头仍保持开启');
    expect(h.last()).toEqual({ status: 'modelError', message: '手势识别不可用，摄像头仍保持开启' });
    expect(h.endTracking).toHaveBeenCalled();
    expect(h.video.srcObject).toBe(h.streams[0]);
  });

  it('dismissError() 清空消息并回到可再次启动的状态', async () => {
    const h = createHarness();
    h.getUserMedia.mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError'));
    await h.session.start();
    expect(h.last().status).toBe('cameraError');
    h.session.dismissError();
    expect(h.last()).toEqual({ status: 'idle', message: '' });
    expect(h.session.isBusy).toBe(false);
    await h.session.start();
    expect(h.last().status).toBe('active');
  });

  it('dismissError() 会一并释放仍在开启的摄像头', async () => {
    const h = createHarness();
    h.createInference.mockRejectedValueOnce(new Error('model boom'));
    await h.session.start();
    expect(h.last().status).toBe('modelError');
    expect(h.video.srcObject).toBe(h.streams[0]);
    h.session.dismissError();
    expect(h.last()).toEqual({ status: 'idle', message: '' });
    expect(h.streams[0].track.stopCalls).toBe(1);
    expect(h.video.srcObject).toBeNull();
  });

  it('stop() 之后可以重新 start()', async () => {
    const h = createHarness();
    await h.session.start();
    h.session.stop();
    await h.session.start();
    expect(h.getUserMedia).toHaveBeenCalledTimes(2);
    expect(h.video.playCalls).toBe(2);
    expect(h.last().status).toBe('active');
  });
});
