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

/* ======================================================================
   FIRE — flame billboards for burning wrecks.

   Previously "burning" wrecks only had a point light and grey smoke
   sprites (see spawnFireEffect in characters.js) — no actual flame was
   ever drawn. This is a small animated flame plane: fbm noise scrolled
   upward (so it reads as licking flame tongues rather than static
   static), tapered to a point at the top and clamped to a narrow column
   at the base, colour-graded from white-hot core through orange to a
   fading red tip. uTime is the SAME shared object on every material
   instance this factory returns (see createFireMaterial below), so one
   `fireUniforms.uTime.value += dt` in Scene.js's updateWeatherFX drives
   every burning wreck in the level at once, the same sharing trick
   fogUniforms/rainUniforms already use above.
====================================================================== */
export const fireUniforms = {
  uTime: { value: 0 },
};

export const fireVertexShader = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

export const fireFragmentShader = `
  uniform float uTime;
  varying vec2 vUv;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(23.1, 71.7))) * 43758.5453123); }
  float noise(vec2 x) {
    vec2 i = floor(x), f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
               mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
  }
  float fbm(vec2 x) {
    float r = 0.0, a = 0.55;
    for (int i = 0; i < 4; i++) { r += a * noise(x); x *= 2.1; a *= 0.5; }
    return r;
  }

  void main() {
    vec2 uv = vUv;
    // Scroll the sample UP the texture as time advances so the noise field
    // itself appears to rise, like flame licking upward off the wreck.
    vec2 q = vec2(uv.x * 3.0, uv.y * 1.6 - uTime * 1.8);
    float n = fbm(q + fbm(q * 1.7));
    float taper = smoothstep(1.0, 0.15, uv.y);       // pinch to a point at the top
    float edge = smoothstep(0.5, 0.36, abs(uv.x - 0.5)); // narrow column, soft sides
    float body = smoothstep(0.32, 0.85, n) * taper * edge;

    vec3 col = mix(vec3(1.0, 0.22, 0.02), vec3(1.0, 0.82, 0.28), clamp(body * 1.4, 0.0, 1.0));
    col = mix(col, vec3(1.0, 1.0, 0.92), smoothstep(0.82, 1.0, body) * (1.0 - uv.y) * 0.8);
    gl_FragColor = vec4(col, body);
  }
`;

export function createFireMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: fireUniforms,
    transparent: true,
    depthWrite: false,
    fog: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    vertexShader: fireVertexShader,
    fragmentShader: fireFragmentShader,
  });
}

/* ======================================================================
   PUDDLES — Day-mode rain puddles.

   Was a completely flat MeshStandardMaterial (see the old puddleMaterial
   in Scene.js) — a dark disc with a fixed low-roughness sheen. This
   keeps the same fresnel-driven "wet surface" read but adds two
   slow-drifting noise-driven ripple layers so the surface isn't static,
   plus small bright glints where those ripples peak (a cheap stand-in
   for light catching a wavelet — there's no environment map in this
   scene for a real reflection). uTime is shared the same way
   fogUniforms/fireUniforms are.
====================================================================== */
export const puddleUniforms = {
  uTime: { value: 0 },
  uColor: { value: new THREE.Color(0x0d141a) },
  uSkyColor: { value: new THREE.Color(0x9fb2c2) },
};

export const puddleVertexShader = `
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vViewDir;
  void main() {
    vUv = uv;
    vNormal = normalize(normalMatrix * normal);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vViewDir = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;

export const puddleFragmentShader = `
  uniform float uTime;
  uniform vec3 uColor;
  uniform vec3 uSkyColor;
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vViewDir;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453123); }
  float noise(vec2 x) {
    vec2 i = floor(x), f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
               mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
  }

  void main() {
    vec2 p = vUv * 6.0;
    float r1 = sin((noise(p + uTime * 0.15) - 0.5) * 12.0 + uTime * 1.4);
    float r2 = sin((noise(p * 1.7 - uTime * 0.1) - 0.5) * 16.0 - uTime * 1.1);
    float ripple = (r1 + r2) * 0.5;

    float fresnel = pow(1.0 - max(dot(normalize(vNormal), normalize(vViewDir)), 0.0), 3.0);
    vec3 col = mix(uColor, uSkyColor, clamp(fresnel * 0.6 + ripple * 0.05, 0.0, 1.0));
    float glint = smoothstep(0.85, 1.0, ripple) * fresnel;
    col += glint * 0.5;
    gl_FragColor = vec4(col, 0.88);
  }
`;

export function createPuddleMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: puddleUniforms,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    vertexShader: puddleVertexShader,
    fragmentShader: puddleFragmentShader,
  });
}

/* ======================================================================
   TOXIC GLOW — pulsing wound/infection glow.

   Zombies' bullet-wound patch (see woundMat in characters.js) used to be
   a flat dark-red MeshStandardMaterial. This gives it the same
   fresnel-rim treatment as the shield bubble above, but small, sickly
   green, and pulsing — reads as an infected, faintly glowing wound
   rather than a plain paint blob. uTime is shared via toxicUniforms so
   one global tick drives every zombie's wound; uColor and uSeed are
   created fresh per call (see createToxicMaterial) so each zombie can
   have its own tint and its pulse doesn't sync up with every other
   zombie on screen.
====================================================================== */
export const toxicUniforms = {
  uTime: { value: 0 },
};

export const toxicVertexShader = `
  varying vec3 vNormal;
  varying vec3 vViewDir;
  void main() {
    vNormal = normalize(normalMatrix * normal);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vViewDir = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;

export const toxicFragmentShader = `
  uniform float uTime;
  uniform vec3 uColor;
  uniform float uSeed;
  varying vec3 vNormal;
  varying vec3 vViewDir;
  void main() {
    float fresnel = pow(1.0 - max(dot(normalize(vNormal), normalize(vViewDir)), 0.0), 1.6);
    float pulse = 0.55 + 0.45 * sin(uTime * 3.0 + uSeed * 6.2831853);
    float glow = (0.35 + 0.65 * fresnel) * pulse;
    vec3 col = uColor * (0.5 + glow);
    gl_FragColor = vec4(col, 0.55 + glow * 0.4);
  }
`;

export function createToxicMaterial(colorHex = 0x7cff3a) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: toxicUniforms.uTime, // shared reference — see header comment
      uColor: { value: new THREE.Color(colorHex) },
      uSeed: { value: Math.random() },
    },
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    vertexShader: toxicVertexShader,
    fragmentShader: toxicFragmentShader,
  });
}