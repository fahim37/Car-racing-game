import * as THREE from "three";
import { WATER_Y } from "../world/World";

/**
 * Calm lake surface: layered analytic ripples for the normal, Fresnel blend between the
 * lake's own colour and the sky (from the environment map), a restrained sun glint and a
 * soft shallow-water tint near the shore. Deliberately gentle so it never distracts.
 */
export class WaterView {
  readonly mesh: THREE.Mesh;
  readonly uniforms = {
    uTime: { value: 0 },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunColor: { value: new THREE.Color(1, 1, 1) },
    uDeep: { value: new THREE.Color(0x0b2530) },
    uShallow: { value: new THREE.Color(0x3b6158) },
    uRain: { value: 0 },
    uEnvIntensity: { value: 1 },
  };
  readonly material: THREE.MeshPhysicalMaterial;

  constructor(center: THREE.Vector3, size = 16000) {
    const geo = new THREE.PlaneGeometry(size, size, 1, 1);
    geo.rotateX(-Math.PI / 2);
    // A standard material gives us env reflections, fog and tone mapping; the shader adds waves.
    // Physical material so the grazing-angle reflection can be capped (specularIntensity): the
    // horizon sky is very bright and an uncapped mirror makes the lake read as snow.
    const mat = new THREE.MeshPhysicalMaterial({ color: 0x0b2530, roughness: 0.07, metalness: 0, specularIntensity: 0.5, envMapIntensity: 0.9, transparent: false });
    const u = this.uniforms;
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, u);
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", `#include <common>\nvarying vec3 vWWorld;`)
        .replace("#include <worldpos_vertex>", `#include <worldpos_vertex>\nvWWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;`);
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          `#include <common>
uniform float uTime; uniform vec3 uSunDir; uniform vec3 uSunColor; uniform vec3 uDeep; uniform vec3 uShallow; uniform float uRain;
varying vec3 vWWorld;
vec2 wave(vec2 p, vec2 dir, float freq, float speed, float amp) {
  float ph = dot(p, dir) * freq + uTime * speed;
  return dir * cos(ph) * amp * freq;
}
float whash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }`,
        )
        .replace(
          "#include <normal_fragment_begin>",
          `#include <normal_fragment_begin>
vec2 p = vWWorld.xz;
vec2 g = vec2(0.0);
g += wave(p, normalize(vec2(1.0, 0.3)), 0.21, 1.1, 0.030);
g += wave(p, normalize(vec2(-0.4, 1.0)), 0.37, 1.5, 0.018);
g += wave(p, normalize(vec2(0.8, -0.7)), 0.83, 2.3, 0.008);
g += wave(p, normalize(vec2(-0.9, -0.2)), 1.9, 3.7, 0.004);
g += wave(p, normalize(vec2(0.2, 0.95)), 3.7, 5.1, 0.0022);
// Raindrop rings in wet weather.
if (uRain > 0.0) {
  vec2 cell = floor(p * 0.9);
  vec2 f = fract(p * 0.9) - 0.5;
  float t = fract(uTime * 0.7 + whash(cell));
  float r = length(f - (vec2(whash(cell + 3.1), whash(cell + 7.7)) - 0.5) * 0.6);
  float ring = sin((r - t * 0.5) * 60.0) * (1.0 - t) * smoothstep(0.5 * t + 0.05, 0.5 * t, r);
  g += (f / max(r, 0.001)) * ring * 0.06 * uRain;
}
float dist = length(vWWorld - cameraPosition);
g *= 1.0 / (1.0 + dist * 0.004);
vec3 wn = normalize(vec3(-g.x, 1.0, -g.y));
normal = normalize((viewMatrix * vec4(wn, 0.0)).xyz);`,
        )
        .replace(
          "#include <map_fragment>",
          `#include <map_fragment>
diffuseColor.rgb = uDeep;`,
        )
        .replace(
          "#include <opaque_fragment>",
          `
vec3 V = normalize(cameraPosition - vWWorld);
vec3 N = normalize((inverse(viewMatrix) * vec4(normal, 0.0)).xyz);
vec3 H = normalize(V + uSunDir);
float glint = pow(max(dot(N, H), 0.0), 900.0) * 6.0 + pow(max(dot(N, H), 0.0), 120.0) * 0.25;
outgoingLight += uSunColor * glint * (1.0 - uRain * 0.8);
#include <opaque_fragment>`,
        );
    };
    mat.customProgramCacheKey = () => "lake-water";
    this.material = mat;
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.position.set(center.x, WATER_Y, center.z);
    this.mesh.receiveShadow = true;
    this.mesh.renderOrder = -1;
  }

  update(time: number, sunDir: THREE.Vector3, sunColor: THREE.Color, rain: number) {
    this.uniforms.uTime.value = time;
    this.uniforms.uSunDir.value.copy(sunDir);
    this.uniforms.uSunColor.value.copy(sunColor);
    this.uniforms.uRain.value = rain;
    this.material.roughness = rain > 0 ? 0.16 : 0.08;
  }
}
