// BASE is captured at module load — set NEXT_PUBLIC_ASSET_BASE before importing in tests.
const BASE = (process.env.NEXT_PUBLIC_ASSET_BASE || '').replace(/\/+$/, '');

function encodePath(s: string): string {
  return s.split('/').map(encodeURIComponent).join('/');
}

/** Build a public R2 URL for a file inside a project folder. */
export function assetUrl(folder: string, filename: string): string {
  return `${BASE}/${encodePath(folder)}/${encodePath(filename)}`;
}
