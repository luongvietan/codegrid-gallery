// BASE is captured at module load — set NEXT_PUBLIC_ASSET_BASE before importing in tests.
const DEFAULT_BASE = 'https://pub-2c8291ac249e456c8e906fe5f4aed9c9.r2.dev';
const BASE = (process.env.NEXT_PUBLIC_ASSET_BASE || DEFAULT_BASE).replace(/\/+$/, '');

function encodePath(s: string): string {
  return s.split('/').map(encodeURIComponent).join('/');
}

/** Build a public R2 URL for a file inside a project folder. */
export function assetUrl(folder: string, filename: string): string {
  return `${BASE}/${encodePath(folder)}/${encodePath(filename)}`;
}

/** Build a same-origin URL for assets that must be fetched by browser JavaScript. */
export function proxiedAssetUrl(folder: string, filename: string): string {
  return `/api/assets/${encodePath(folder)}/${encodePath(filename)}`;
}
