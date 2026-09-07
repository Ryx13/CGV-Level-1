import * as THREE from 'three';

/* ======================================================================
   shaders.js — ALL SHADER-RELATED CODE

   Currently just one: the shield bubble's glow shader. Adapted from a
   supplied Shadertoy bloom/glow pass (the original was a full-screen
   post-process keyed off iChannel0/iResolution, which only makes sense as
   a screen-space effect — it can't literally wrap around a moving 3D
   character). This keeps the same soft, gaussian-glow feel but as a
   proper mesh ShaderMaterial: a Fresnel rim brightens the silhouette
   edge (the "bloom halo" look) plus a soft pulsing scan line,
   additive-blended so it always reads as light rather than a solid
   surface.
====================================================================== */

export const shieldUniforms = {
  uTime: { value: 0 },
  uColor: { value: new THREE.Color(0x37c8ff) },
};

export const shieldVertexShader = `
  varying vec3 vNormal;
  varying vec3 vViewDir;
  void main() {
    vNormal = normalize(normalMatrix * normal);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vViewDir = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;

export const shieldFragmentShader = `
  uniform float uTime;
  uniform vec3 uColor;
  varying vec3 vNormal;
  varying vec3 vViewDir;
  void main() {
    // Fresnel term — bright rim at grazing angles, dim facing the
    // camera. This is the "glow around the silhouette" analogue of the
    // supplied bloom pass, done per-pixel on the shield mesh instead of
    // as a screen-space blur.
    float fresnel = pow(1.0 - max(dot(normalize(vNormal), normalize(vViewDir)), 0.0), 2.2);
    // Slow vertical scan pulse for a "energy bubble" feel.
    float scan = 0.5 + 0.5 * sin(uTime * 2.2 + vNormal.y * 6.0);
    float glow = fresnel * (0.65 + 0.35 * scan);
    vec3 col = uColor * (0.6 + glow);
    // Soft "tone-map" squash, echoing the bloom pass's col*col*(3-2*col)
    // smoothstep — keeps the additive glow from blowing out to pure white.
    col = col * col * (3.0 - 2.0 * col);
    gl_FragColor = vec4(col, glow * 0.9);
  }
`;

export function createShieldMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: shieldUniforms,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    vertexShader: shieldVertexShader,
    fragmentShader: shieldFragmentShader,
  });
}

/* ======================================================================
   FOG — patchy ground fog for both Day and Night mode.

   Sits low to the ground (see FOG_HEIGHT in Scene.js) rather than
   filling the air, and rather than an even layer everywhere, a
   low-frequency world-space mask decides WHERE fog banks actually sit —
   uCoverage controls roughly what fraction of the ground has fog at
   all, so the player walks between clear patches and denser banks
   instead of a uniform haze. A finer-frequency fbm then adds texture
   inside each bank so it doesn't read as a flat cutout. The mesh
   re-centers on the camera's x/z every frame (see updateWeatherFX in
   Scene.js) so it always covers the area around the player, but density
   is sampled from real WORLD position (via modelMatrix below), so the
   patches themselves are anchored to fixed spots in the world and don't
   slide around as the camera moves.
====================================================================== */
export const fogUniforms = {
  uTime: { value: 0 },
  uColor: { value: new THREE.Color(0xb9c4cf) },
  uOpacity: { value: 0.55 },
  uCoverage: { value: 0.45 }, // 0-1: roughly what fraction of the ground has fog on it
};

export const fogVertexShader = `
  varying vec2 vWorldXZ;
  void main() {
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldXZ = worldPos.xz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

export const fogFragmentShader = `
  uniform float uTime;
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uCoverage;
  varying vec2 vWorldXZ;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
  float noise(vec2 x) {
    vec2 i = floor(x), f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
               mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
  }
  float fbm(vec2 x) {
    float r = 0.0, a = 0.5;
    for (int i = 0; i < 4; i++) { r += a * noise(x); x *= 2.02; a *= 0.5; }
    return r;
  }

  void main() {
    vec2 drift = vec2(uTime * 0.03, uTime * 0.018);

    // Low-frequency mask picks WHICH areas of the ground get a fog bank
    // at all. Threshold width (0.22) is the soft edge each bank fades
    // out over, so patches don't have a hard cutout look.
    float mask = fbm(vWorldXZ * 0.012 + drift * 0.4);
    float patch = smoothstep(1.0 - uCoverage, 1.0 - uCoverage + 0.22, mask);

    // Finer detail noise for texture inside a bank.
    float detail = fbm(vWorldXZ * 0.08 + drift);

    float density = patch * mix(0.55, 1.0, detail);
    gl_FragColor = vec4(uColor, density * uOpacity);
  }
`;

export function createFogMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: fogUniforms,
    transparent: true,
    depthWrite: false,
    fog: false,
    side: THREE.DoubleSide,
    vertexShader: fogVertexShader,
    fragmentShader: fogFragmentShader,
  });
}

/* ======================================================================
   RAIN — light drizzle, Day mode only.

   Adapted from the supplied rain-sheet Shadertoy: that pass built
   streaks by sampling a scrolling noise texture (iChannel3) and
   crushing it through a steep pow() curve. Here the same "scrolling +
   thresholded" idea is done with a tiled hash grid instead of a texture
   lookup (again, no texture channel available), which also makes it
   trivial to dial down to a sparse drizzle rather than a downpour: each
   grid cell only draws a streak if its random value clears uDensity,
   and uDensity is kept low. Two layers at different scale/speed give a
   little parallax so it doesn't read as a single flat pattern.
   Rendered on one plane parented to the camera (see Scene.js) so it
   always fills the view regardless of look direction.
====================================================================== */
export const rainUniforms = {
  uTime: { value: 0 },
  uDensity: { value: 0.06 },
  uOpacity: { value: 0.35 },
};

export const rainVertexShader = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

export const rainFragmentShader = `
  uniform float uTime;
  uniform float uDensity;
  uniform float uOpacity;
  varying vec2 vUv;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453123); }

  float streaks(vec2 uv, float scale, float speed, float slant) {
    uv.x += uv.y * slant;
    uv.y += uTime * speed; // + moves the sampled pattern DOWN the screen as uTime grows
    uv *= scale;
    vec2 id = floor(uv);
    vec2 gv = fract(uv) - 0.5;
    float n = hash(id);
    if (n > uDensity) return 0.0;
    float jitter = (n - 0.5) * 0.6;
    float line = smoothstep(0.045, 0.0, abs(gv.x - jitter));
    float length_ = smoothstep(0.5, 0.0, abs(gv.y)) ;
    return line * length_;
  }

  void main() {
    float f = streaks(vUv, 26.0, 1.6, 0.06) * 0.6;
    f += streaks(vUv + 17.3, 40.0, 2.3, 0.08) * 0.4;
    gl_FragColor = vec4(0.75, 0.8, 0.85, f * uOpacity);
  }
`;

export function createRainMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: rainUniforms,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    fog: false,
    side: THREE.DoubleSide,
    vertexShader: rainVertexShader,
    fragmentShader: rainFragmentShader,
  });
}