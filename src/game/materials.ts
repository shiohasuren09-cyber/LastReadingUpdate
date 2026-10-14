// Atlas-aware materials: geometry carries a per-vertex `tileRect` (u0, v0, du, dv)
// and uv in "repeat units", so one atlas texture can tile across big surfaces.
import * as THREE from 'three'

const VERT_HEAD = '#include <common>\nattribute vec4 tileRect;\nvarying vec4 vTileRect;'
const FRAG_HEAD = '#include <common>\nvarying vec4 vTileRect;'
const MAP_FRAG = `
#ifdef USE_MAP
  vec2 atlasUv = vTileRect.xy + vec2(fract(vMapUv.x * 0.9998 + 0.0001), 1.0 - fract(vMapUv.y * 0.9998 + 0.0001)) * vTileRect.zw;
  vec4 atlasTexel = texture2D(map, atlasUv);
  diffuseColor *= atlasTexel;
#endif`
// Emissive lift follows the surface colour (texel × instance colour) so lifted
// objects brighten without washing out.
const EMISSIVE_FRAG = `
  totalEmissiveRadiance *= diffuseColor.rgb;`

function patch(mat: THREE.Material, key: string) {
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', VERT_HEAD)
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvTileRect = tileRect;')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', FRAG_HEAD)
      .replace('#include <map_fragment>', MAP_FRAG)
      .replace('#include <emissivemap_fragment>', EMISSIVE_FRAG)
  }
  mat.customProgramCacheKey = () => key
}

export function atlasLambert(map: THREE.Texture, lift = 0, key = 'atlas') {
  const m = new THREE.MeshLambertMaterial({ map })
  if (lift > 0) {
    m.emissive.setRGB(1, 1, 1)
    m.emissiveIntensity = lift
  }
  patch(m, key + (lift > 0 ? '-lift' : ''))
  return m
}

export function atlasBasic(map: THREE.Texture, key = 'atlas-basic') {
  const m = new THREE.MeshBasicMaterial({ map })
  patch(m, key)
  return m
}

/** Stamps a tile rect onto every vertex (or onto vertices passing `filter`). */
export function setTile(
  geo: THREE.BufferGeometry, rect: [number, number, number, number],
  filter?: (nx: number, ny: number, nz: number) => boolean,
) {
  const n = geo.attributes.position.count
  let attr = geo.getAttribute('tileRect') as THREE.BufferAttribute | undefined
  if (!attr) {
    attr = new THREE.BufferAttribute(new Float32Array(n * 4), 4)
    geo.setAttribute('tileRect', attr)
  }
  const nor = geo.attributes.normal
  for (let i = 0; i < n; i++) {
    if (filter && !filter(nor.getX(i), nor.getY(i), nor.getZ(i))) continue
    attr.setXYZW(i, rect[0], rect[1], rect[2] - rect[0], rect[3] - rect[1])
  }
  return geo
}

export function scaleUv(geo: THREE.BufferGeometry, su: number, sv: number) {
  const uv = geo.attributes.uv
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv)
  return geo
}

/** Collapses uvs of vertices passing `filter` to a single point (solid colour sample). */
export function pinUv(geo: THREE.BufferGeometry, u: number, v: number, filter: (nx: number, ny: number, nz: number) => boolean) {
  const uv = geo.attributes.uv, nor = geo.attributes.normal
  for (let i = 0; i < uv.count; i++) if (filter(nor.getX(i), nor.getY(i), nor.getZ(i))) uv.setXY(i, u, v)
  return geo
}
