// Fullscreen post pass: Bayer dither + 40-colour palette quantize + vignette +
// grain + brightness gain + gameplay rim / demo focus mask, then subtitles on top.
import * as THREE from 'three'
import { PALETTE, POST } from './config'

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16)

const VERT = `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`

const FRAG = `
precision highp float;
uniform sampler2D tScene;
uniform sampler2D tMask;
uniform sampler2D tSub;
uniform vec2 uRes;
uniform vec3 uPal[40];
uniform float uBayer[16];
uniform float uTime;
uniform float uGain;
uniform float uFocus;
uniform float uFocusDim;
uniform float uVig;
uniform float uGrain;
uniform float uSpread;
uniform float uMaskOn;
varying vec2 vUv;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
vec3 toSrgb(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

void main() {
  vec2 px = floor(vUv * uRes);
  vec2 texel = 1.0 / uRes;
  vec3 c = toSrgb(texture2D(tScene, vUv).rgb);
  c *= uGain;

  // gameplay rim (R), demo focus (G), hover (B): 1px outline outside each mask
  if (uMaskOn > 0.5) {
    vec3 m = texture2D(tMask, vUv).rgb;
    vec3 n = max(max(texture2D(tMask, vUv + vec2(texel.x, 0.0)).rgb, texture2D(tMask, vUv - vec2(texel.x, 0.0)).rgb),
                 max(texture2D(tMask, vUv + vec2(0.0, texel.y)).rgb, texture2D(tMask, vUv - vec2(0.0, texel.y)).rgb));
    vec3 rim = step(0.5, n) * (1.0 - step(0.5, m));
    float lit = max(m.g, rim.g);
    c *= mix(1.0, mix(uFocusDim, 1.0, lit), uFocus);
    c = mix(c, vec3(0.93, 0.86, 0.70), rim.r * 0.55);
    c = mix(c, vec3(1.0, 0.86, 0.52), rim.g * uFocus);
    c = mix(c, vec3(1.0, 0.92, 0.66), rim.b);
  }

  vec2 q = vUv - 0.5;
  float d = length(q) * 1.4142;
  c *= 1.0 - uVig * smoothstep(0.3, 1.0, d);

  c += (hash(px + floor(uTime * 18.0) * 17.0) - 0.5) * 2.0 * uGrain;
  int bi = int(mod(px.x, 4.0)) + int(mod(px.y, 4.0)) * 4;
  c += (uBayer[bi] - 0.5) * uSpread;

  // nothing outside the extreme 8% corners may fall to ink (<10% luminance)
  bool corner = abs(q.x) > 0.42 && abs(q.y) > 0.42;
  vec3 best = uPal[1];
  float bd = 1e9;
  for (int i = 0; i < 40; i++) {
    if (i == 0 && !corner) continue;
    vec3 e = c - uPal[i];
    float dd = dot(e * e, vec3(0.30, 0.55, 0.15));
    if (dd < bd) { bd = dd; best = uPal[i]; }
  }

  vec4 s = texture2D(tSub, vUv);
  gl_FragColor = vec4(mix(best, s.rgb, s.a), 1.0);
}`

export interface Post {
  scene: THREE.Scene
  camera: THREE.OrthographicCamera
  material: THREE.ShaderMaterial
  setTargets(sceneTex: THREE.Texture, maskTex: THREE.Texture, w: number, h: number): void
}

export function createPost(subTex: THREE.Texture): Post {
  const pal = PALETTE.map((h) => {
    const c = new THREE.Color()
    c.setStyle(h, THREE.SRGBColorSpace)
    // keep the palette in sRGB space: the shader quantizes after its own encode
    c.convertLinearToSRGB()
    return new THREE.Vector3(c.r, c.g, c.b)
  })
  const material = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    depthTest: false,
    depthWrite: false,
    uniforms: {
      tScene: { value: null },
      tMask: { value: null },
      tSub: { value: subTex },
      uRes: { value: new THREE.Vector2(480, 270) },
      uPal: { value: pal },
      uBayer: { value: BAYER },
      uTime: { value: 0 },
      uGain: { value: POST.gainDefault },
      uFocus: { value: 0 },
      uFocusDim: { value: POST.focusDim },
      uVig: { value: POST.vignette },
      uGrain: { value: POST.grain },
      uSpread: { value: POST.ditherSpread },
      uMaskOn: { value: 1 },
    },
  })
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3))
  const tri = new THREE.Mesh(geo, material)
  tri.frustumCulled = false
  const scene = new THREE.Scene()
  scene.add(tri)
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  return {
    scene, camera, material,
    setTargets(sceneTex, maskTex, w, h) {
      material.uniforms.tScene.value = sceneTex
      material.uniforms.tMask.value = maskTex
      material.uniforms.uRes.value.set(w, h)
    },
  }
}
