import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import type { GestureSnapshot, ManualGesture, ParticleTarget } from '../types';

type GestureControlRef = { current: GestureSnapshot };

type ParticleStageProps = {
  target: ParticleTarget | null;
  gestureRef: GestureControlRef;
  manual: ManualGesture;
};

const vertexShader = `
  attribute vec3 aFromPosition;
  attribute vec3 aToPosition;
  attribute vec3 aFromNormal;
  attribute vec3 aToNormal;
  attribute vec3 aFromColor;
  attribute vec3 aToColor;
  attribute vec3 aFromScatter;
  attribute vec3 aToScatter;
  attribute float aFromSize;
  attribute float aToSize;
  attribute float aFromAlpha;
  attribute float aToAlpha;
  uniform float uProgress;
  uniform float uScatter;
  uniform float uTime;
  uniform float uPixelRatio;
  uniform float uGlow;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vLight;

  void main() {
    float eased = smoothstep(0.0, 1.0, uProgress);
    vec3 position = mix(aFromPosition, aToPosition, eased);
    vec3 normal = normalize(mix(aFromNormal, aToNormal, eased));
    vec3 scatter = mix(aFromScatter, aToScatter, eased);
    float size = mix(aFromSize, aToSize, eased);
    vColor = mix(aFromColor, aToColor, eased);
    vAlpha = mix(aFromAlpha, aToAlpha, eased);
    position += scatter * uScatter;
    position += normal * sin(uTime * 0.72 + position.x * 2.8 + position.y * 2.15) * 0.012;
    vec4 modelPosition = modelViewMatrix * vec4(position, 1.0);
    vec3 viewNormal = normalize(normalMatrix * normal);
    vec3 viewDirection = normalize(-modelPosition.xyz);
    vec3 lightDirection = normalize(vec3(-0.45, 0.62, 0.72));
    float diffuse = max(dot(viewNormal, lightDirection), 0.0);
    float rim = pow(1.0 - max(dot(viewNormal, viewDirection), 0.0), 2.2);
    // Keep the unlit side readable while retaining enough contrast to show
    // each curved petal layer and the leaf veins from a 45° view.
    vLight = 0.5 + diffuse * 0.78 + rim * 0.38;
    gl_Position = projectionMatrix * modelPosition;
    float perspective = 5.2 / max(1.0, -modelPosition.z);
    gl_PointSize = (1.15 + size * 1.5) * uPixelRatio * perspective * mix(1.0, 2.35, uGlow);
  }
`;

const fragmentShader = `
  uniform float uGlow;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vLight;
  void main() {
    vec2 centered = gl_PointCoord - vec2(0.5);
    float distanceFromCenter = length(centered);
    float softness = 1.0 - smoothstep(mix(0.32, 0.05, uGlow), 0.5, distanceFromCenter);
    if (softness < 0.025) discard;
    vec3 litColor = min(vec3(1.0), pow(vColor * vLight, vec3(0.92)));
    float alpha = softness * vAlpha * mix(0.92, 0.12, uGlow);
    gl_FragColor = vec4(litColor, alpha);
  }
`;

function createMaterial(glow: boolean, pixelRatio: number) {
  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    transparent: true,
    depthTest: true,
    depthWrite: !glow,
    blending: glow ? THREE.AdditiveBlending : THREE.NormalBlending,
    uniforms: {
      uProgress: { value: 1 },
      uScatter: { value: 0 },
      uTime: { value: 0 },
      uPixelRatio: { value: pixelRatio },
      uGlow: { value: glow ? 1 : 0 },
    },
  });
}

function interpolateArray(from: Float32Array | undefined, to: Float32Array, progress: number) {
  const output = new Float32Array(to.length);
  if (!from || from.length !== to.length) {
    output.set(to);
    return output;
  }
  for (let index = 0; index < to.length; index += 1) output[index] = from[index] + (to[index] - from[index]) * progress;
  return output;
}

export function ParticleStage({ target, gestureRef, manual }: ParticleStageProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const targetRef = useRef<ParticleTarget | null>(target);
  const manualRef = useRef(manual);
  const progressRef = useRef(1);
  const activeFromRef = useRef<ParticleTarget | null>(null);
  const activeToRef = useRef<ParticleTarget | null>(null);

  useEffect(() => { targetRef.current = target; }, [target]);
  useEffect(() => { manualRef.current = manual; }, [manual]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.7);
    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: false, powerPreference: 'high-performance' });
    renderer.setPixelRatio(pixelRatio);
    renderer.setClearColor(0x000000, 0);
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
    camera.position.z = 5.2;
    const geometry = new THREE.BufferGeometry();
    const coreMaterial = createMaterial(false, pixelRatio);
    const glowMaterial = createMaterial(true, pixelRatio);
    const group = new THREE.Group();
    const glow = new THREE.Points(geometry, glowMaterial);
    const core = new THREE.Points(geometry, coreMaterial);
    glow.frustumCulled = false;
    core.frustumCulled = false;
    group.add(glow, core);
    scene.add(group);

    let frame = 0;
    let lastTime = performance.now();
    const animationStartTime = lastTime;
    let visible = true;
    let currentYaw = 0.24;
    let currentPitch = -0.2;
    let currentScale = 1;
    let currentScatter = 0;
    let fitScale = 1;
    const rotation = new THREE.Euler(0, 0, 0, 'YXZ');

    const makeAttribute = (name: string, array: Float32Array, itemSize: number) => {
      geometry.setAttribute(name, new THREE.BufferAttribute(array, itemSize));
    };

    const initializeTarget = (next: ParticleTarget) => {
      const previousFrom = activeFromRef.current;
      const previousTo = activeToRef.current;
      const rawProgress = THREE.MathUtils.clamp(progressRef.current, 0, 1);
      const eased = rawProgress * rawProgress * (3 - 2 * rawProgress);
      const visibleTarget: ParticleTarget = {
        kind: previousTo?.kind ?? next.kind,
        id: `${next.id}-visible`,
        count: next.count,
        positions: interpolateArray(previousFrom?.positions, previousTo?.positions ?? next.positions, eased),
        normals: interpolateArray(previousFrom?.normals, previousTo?.normals ?? next.normals, eased),
        colors: interpolateArray(previousFrom?.colors, previousTo?.colors ?? next.colors, eased),
        sizes: interpolateArray(previousFrom?.sizes, previousTo?.sizes ?? next.sizes, eased),
        alphas: interpolateArray(previousFrom?.alphas, previousTo?.alphas ?? next.alphas, eased),
        scatter: interpolateArray(previousFrom?.scatter, previousTo?.scatter ?? next.scatter, eased),
        bounds: previousTo?.bounds ?? next.bounds,
      };
      makeAttribute('position', visibleTarget.positions, 3);
      makeAttribute('aFromPosition', visibleTarget.positions, 3);
      makeAttribute('aToPosition', next.positions, 3);
      makeAttribute('aFromNormal', visibleTarget.normals, 3);
      makeAttribute('aToNormal', next.normals, 3);
      makeAttribute('aFromColor', visibleTarget.colors, 3);
      makeAttribute('aToColor', next.colors, 3);
      makeAttribute('aFromScatter', visibleTarget.scatter, 3);
      makeAttribute('aToScatter', next.scatter, 3);
      makeAttribute('aFromSize', visibleTarget.sizes, 1);
      makeAttribute('aToSize', next.sizes, 1);
      makeAttribute('aFromAlpha', visibleTarget.alphas, 1);
      makeAttribute('aToAlpha', next.alphas, 1);
      activeFromRef.current = visibleTarget;
      activeToRef.current = next;
      fitScale = THREE.MathUtils.clamp(1.58 / next.bounds.radius, 0.72, 1.08);
      progressRef.current = previousTo ? 0 : 1;
    };

    const resize = () => {
      const width = Math.max(1, host.clientWidth);
      const height = Math.max(1, host.clientHeight);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(host);
    resize();

    const visibilityHandler = () => { visible = document.visibilityState === 'visible'; };
    document.addEventListener('visibilitychange', visibilityHandler);

    const render = (now: number) => {
      frame = requestAnimationFrame(render);
      if (!visible) {
        lastTime = now;
        return;
      }
      const delta = Math.min(0.05, (now - lastTime) / 1000);
      lastTime = now;
      const activeTarget = targetRef.current;
      if (activeTarget && activeToRef.current?.id !== activeTarget.id) initializeTarget(activeTarget);
      progressRef.current = Math.min(1, progressRef.current + delta / 1.05);

      const gesture = gestureRef.current;
      const pointer = manualRef.current;
      let targetYaw: number;
      let targetPitch: number;
      let targetScale = pointer.scale;
      let targetScatter = 0;
      if (gesture.handPresent) {
        targetYaw = (gesture.palmX - 0.5) * THREE.MathUtils.degToRad(110);
        targetPitch = (gesture.palmY - 0.5) * THREE.MathUtils.degToRad(60);
        targetScale = 0.75 + gesture.pinch * 0.8;
      targetScatter = gesture.openness < 0.045 ? 0 : Math.pow(gesture.openness, 1.18) * 0.65;
      } else if (pointer.active) {
        targetYaw = pointer.yaw;
        targetPitch = pointer.pitch;
      } else if (activeTarget?.kind === 'image') {
        targetYaw = Math.sin(now * 0.00036) * THREE.MathUtils.degToRad(22);
        targetPitch = -0.055 + Math.cos(now * 0.00025) * 0.035;
      } else {
        targetYaw = 0.12 + Math.sin((now - animationStartTime) * 0.00022) * THREE.MathUtils.degToRad(24);
        targetPitch = -0.22 + Math.sin(now * 0.00022) * 0.035;
      }

      currentYaw = THREE.MathUtils.damp(currentYaw, targetYaw, 8.5, delta);
      currentPitch = THREE.MathUtils.damp(currentPitch, targetPitch, 8.5, delta);
      currentScale = THREE.MathUtils.damp(currentScale, targetScale, 9.5, delta);
      currentScatter = targetScatter === 0 && currentScatter < 0.035
        ? 0
        : THREE.MathUtils.damp(currentScatter, targetScatter, 10, delta);
      rotation.set(currentPitch, currentYaw, 0);
      group.quaternion.setFromEuler(rotation);
      const renderedScale = fitScale * currentScale;
      group.scale.setScalar(renderedScale);

      for (const material of [coreMaterial, glowMaterial]) {
        material.uniforms.uProgress.value = progressRef.current;
        material.uniforms.uScatter.value = currentScatter;
        material.uniforms.uTime.value = now / 1000;
      }
      renderer.render(scene, camera);
    };
    frame = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      document.removeEventListener('visibilitychange', visibilityHandler);
      geometry.dispose();
      coreMaterial.dispose();
      glowMaterial.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [gestureRef]);

  return <div ref={hostRef} className="particle-stage" aria-label="3D 粒子画布" role="img" />;
}
