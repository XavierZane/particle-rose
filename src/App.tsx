import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Camera, Flower2, ImagePlus, LoaderCircle, Sparkles, Upload, VideoOff, X } from 'lucide-react';
import { ParticleStage } from './particle/ParticleStage';
import { createRoseTarget } from './rose/roseTarget';
import { fileToParticleTarget, getParticleCount, MAX_IMAGES, MAX_FILE_SIZE } from './image/imageSampler';
import { useHandTracker } from './gesture/useHandTracker';
import type { ImageParticle, ManualGesture } from './types';

const initialManual: ManualGesture = { yaw: 0.24, pitch: -0.08, scale: 1, active: false };

function uid() {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function App() {
  const particleCount = useMemo(() => getParticleCount(), []);
  const roseTarget = useMemo(() => createRoseTarget(particleCount), [particleCount]);
  const [images, setImages] = useState<ImageParticle[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [mode, setMode] = useState<'image' | 'rose'>('rose');
  const [manual, setManual] = useState(initialManual);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const imagesRef = useRef(images);
  const activeRef = useRef(activeId);
  const inputRef = useRef<HTMLInputElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchDistanceRef = useRef<number | null>(null);

  useEffect(() => { imagesRef.current = images; }, [images]);
  useEffect(() => { activeRef.current = activeId; }, [activeId]);

  const handleSwipe = useCallback((swipe: 'left' | 'right') => {
    if (imagesRef.current.length === 0) return;
    const currentIndex = Math.max(0, imagesRef.current.findIndex((image) => image.id === activeRef.current));
    const delta = swipe === 'right' ? 1 : -1;
    const nextIndex = (currentIndex + delta + imagesRef.current.length) % imagesRef.current.length;
    const next = imagesRef.current[nextIndex];
    setActiveId(next.id);
    setMode('image');
  }, []);
  const tracker = useHandTracker(handleSwipe);

  const activeImage = images.find((image) => image.id === activeId) ?? null;
  const target = mode === 'rose' ? roseTarget : activeImage?.target ?? null;

  const addFiles = useCallback(async (fileList: FileList | File[]) => {
    const files = Array.from(fileList).filter((file) => file.type.match(/^image\/(jpeg|png|webp)$/));
    if (files.length === 0) {
      setError('请选择 JPG、PNG 或 WebP 图片');
      return;
    }
    const remaining = Math.max(0, MAX_IMAGES - imagesRef.current.length);
    if (remaining === 0) {
      setError(`最多添加 ${MAX_IMAGES} 张图片`);
      return;
    }
    setBusy(true);
    setError('');
    const nextImages: ImageParticle[] = [];
    for (const file of files.slice(0, remaining)) {
      try {
        const particleTarget = await fileToParticleTarget(file, particleCount);
        nextImages.push({ id: `${particleTarget.id}-${uid()}`, name: file.name, url: URL.createObjectURL(file), target: particleTarget });
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : '图片处理失败');
      }
    }
    if (nextImages.length > 0) {
      setImages((current) => [...current, ...nextImages]);
      if (!activeRef.current) {
        setActiveId(nextImages[0].id);
        setMode('image');
      }
    }
    setBusy(false);
  }, [particleCount]);

  const removeImage = (id: string) => {
    const removed = imagesRef.current.find((image) => image.id === id);
    if (removed) URL.revokeObjectURL(removed.url);
    const remaining = imagesRef.current.filter((image) => image.id !== id);
    setImages(remaining);
    if (activeRef.current === id) {
      const replacement = remaining[0] ?? null;
      setActiveId(replacement?.id ?? null);
      setMode(replacement ? 'image' : 'rose');
    }
  };

  useEffect(() => () => {
    imagesRef.current.forEach((image) => URL.revokeObjectURL(image.url));
  }, []);

  const chooseImage = (id: string) => {
    setActiveId(id);
    setMode('image');
  };

  const pointerDistance = () => {
    const values = Array.from(pointersRef.current.values());
    return values.length < 2 ? null : Math.hypot(values[0].x - values[1].x, values[0].y - values[1].y);
  };

  const startPointer = (event: React.PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    pinchDistanceRef.current = pointerDistance();
    setManual((current) => ({ ...current, active: true }));
  };

  const updatePointer = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!pointersRef.current.has(event.pointerId)) return;
    const previous = pointersRef.current.get(event.pointerId)!;
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointersRef.current.size >= 2) {
      const distance = pointerDistance();
      const previousDistance = pinchDistanceRef.current;
      if (distance && previousDistance) {
        setManual((current) => ({ ...current, scale: Math.max(0.75, Math.min(1.55, current.scale * distance / previousDistance)) }));
      }
      pinchDistanceRef.current = distance;
      return;
    }
    const deltaX = event.clientX - previous.x;
    const deltaY = event.clientY - previous.y;
    setManual((current) => ({
      ...current,
      yaw: current.yaw + deltaX * 0.006,
      pitch: Math.max(-0.8, Math.min(0.8, current.pitch + deltaY * 0.006)),
    }));
  };

  const endPointer = (event: React.PointerEvent<HTMLDivElement>) => {
    pointersRef.current.delete(event.pointerId);
    const remaining = Array.from(pointersRef.current.values());
    pinchDistanceRef.current = pointerDistance();
    if (remaining.length === 0) setManual((current) => ({ ...current, active: false }));
  };

  const updateWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    setManual((current) => ({ ...current, scale: Math.max(0.72, Math.min(1.65, current.scale - event.deltaY * 0.001)) }));
  };

  const cameraLabel = tracker.status === 'active'
    ? '手势控制已启用'
    : tracker.status === 'requesting'
      ? '等待摄像头授权'
      : tracker.status === 'loadingModel'
        ? '正在加载手势模型'
        : tracker.status === 'recovering'
          ? '正在恢复摄像头'
          : tracker.status === 'modelError'
            ? '手势识别不可用'
            : tracker.status === 'cameraError'
              ? '摄像头启动失败'
              : tracker.status === 'unsupported'
                ? '设备不支持'
                : '启用摄像头';
  const cameraStateClass = tracker.status === 'active'
    ? 'is-active'
    : tracker.isBusy
      ? 'is-busy'
      : tracker.errorMessage
        ? 'is-error'
        : '';
  const canRetryTracker = tracker.status === 'cameraError' || tracker.status === 'modelError';
  const stageHint = busy ? '正在生成粒子' : images.length === 0 ? '等待第一张图片' : mode === 'rose' ? '玫瑰形态' : activeImage?.name ?? '图片形态';

  return (
    <main className="app-shell">
      <div
        ref={stageRef}
        className="stage-interaction"
        onPointerDown={startPointer}
        onPointerMove={updatePointer}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        onWheel={updateWheel}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => { event.preventDefault(); void addFiles(event.dataTransfer.files); }}
      >
        <ParticleStage target={target} gestureRef={tracker.gestureRef} manual={manual} />
      </div>

      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark"><Sparkles size={16} strokeWidth={1.8} /></div>
          <div>
            <h1>粒子玫瑰</h1>
            <p>IMAGE TO PARTICLE</p>
          </div>
        </div>
        <div className="topbar-status">
          <div className="live-status" aria-live="polite">
            <span className={`status-dot ${tracker.handPresent ? 'is-live' : ''}`} />
            <span>{stageHint}</span>
          </div>
          <div className={`camera-status ${cameraStateClass}`} aria-live="polite">
            <span className="camera-state-dot" />
            <span>{cameraLabel}</span>
          </div>
        </div>
      </header>

      <section className="action-dock" aria-label="场景控制">
        <input
          ref={inputRef}
          className="visually-hidden"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          multiple
          onChange={(event) => { if (event.target.files) void addFiles(event.target.files); event.target.value = ''; }}
        />
        <button type="button" className="action-button action-button-primary" title="上传图片" onClick={() => inputRef.current?.click()} disabled={busy}>
          {busy ? <LoaderCircle className="spin" size={17} /> : <Upload size={17} />}
          <span>上传图片</span>
        </button>
        <button type="button" className={`action-button ${mode === 'rose' ? 'is-selected' : ''}`} title="切换到玫瑰" onClick={() => setMode('rose')}>
          <Flower2 size={17} />
          <span>玫瑰</span>
        </button>
        <button
          type="button"
          className={`action-button ${tracker.enabled ? 'is-selected' : ''}`}
          title={tracker.errorMessage || cameraLabel}
          aria-label={cameraLabel}
          aria-busy={tracker.isBusy}
          disabled={tracker.isBusy}
          onClick={() => { if (tracker.status === 'active') tracker.stop(); else void tracker.start(); }}
        >
          {tracker.isBusy ? <LoaderCircle className="spin" size={17} /> : tracker.enabled ? <VideoOff size={17} /> : <Camera size={17} />}
          <span>{cameraLabel}</span>
        </button>
      </section>

      {images.length > 0 && (
        <section className="thumbnail-dock" aria-label="图片队列">
          <div className="dock-label"><ImagePlus size={14} /> <span>{images.length.toString().padStart(2, '0')}</span></div>
          <div className="thumbnail-list">
            {images.map((image) => (
              <div key={image.id} className={`thumbnail-item ${activeId === image.id && mode === 'image' ? 'is-active' : ''}`}>
                <button type="button" className="thumbnail-button" onClick={() => chooseImage(image.id)} aria-label={`查看 ${image.name}`}>
                  <img src={image.url} alt="" />
                </button>
                <button type="button" className="thumbnail-remove" onClick={() => removeImage(image.id)} aria-label={`移除 ${image.name}`}><X size={12} /></button>
              </div>
            ))}
          </div>
        </section>
      )}

      <div className="corner-note">
        <span className="note-line" />
        <span>LOCAL / REALTIME</span>
      </div>

      {(tracker.errorMessage || error) && (
        <div className="toast-stack">
          {tracker.errorMessage && (
            <div className="toast" role="alert">
              <span className="toast-message">{tracker.errorMessage}</span>
              <span className="toast-actions">
                {canRetryTracker && (
                  <button type="button" className="toast-action" onClick={() => void tracker.retry()}>重试</button>
                )}
                <button type="button" className="toast-close" onClick={tracker.dismissError} aria-label="关闭提示"><X size={15} /></button>
              </span>
            </div>
          )}
          {error && (
            <div className="toast" role="alert">
              <span className="toast-message">{error}</span>
              <span className="toast-actions">
                <button type="button" className="toast-close" onClick={() => setError('')} aria-label="关闭提示"><X size={15} /></button>
              </span>
            </div>
          )}
        </div>
      )}

      <video ref={tracker.videoRef} className="camera-feed" muted playsInline aria-hidden="true" />
    </main>
  );
}

export default App;
