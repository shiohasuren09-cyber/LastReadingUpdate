// ── Asset registry — you own and maintain this file ──
//
// Generate or add assets under src/assets/, then register them here, e.g.
// `import hero from './assets/hero.png'` then `ASSETS.hero = hero`. The
// import is what makes Vite bundle the file into the build — assets are
// served from the built dist/ under a relative path, so import-based
// references are the only ones that resolve correctly (never reference
// public/ or an absolute path for your own assets).

export const ASSETS: Record<string, string> = {}
