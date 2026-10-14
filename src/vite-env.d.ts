/// <reference types="vite/client" />

// Game asset types beyond Vite's built-ins: importing yields the bundled URL string
declare module '*.glb' {
  const url: string
  export default url
}
declare module '*.gltf' {
  const url: string
  export default url
}
declare module '*.hdr' {
  const url: string
  export default url
}
