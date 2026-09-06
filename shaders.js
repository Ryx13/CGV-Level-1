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
