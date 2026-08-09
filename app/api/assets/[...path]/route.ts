import { assetUrl } from '@/lib/assets';

const FORWARDED_HEADERS = [
  'accept-ranges',
  'content-length',
  'content-range',
  'content-type',
  'etag',
  'last-modified',
] as const;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path } = await params;
  if (path.length < 2 || path.some((segment) => !segment || segment === '.' || segment === '..')) {
    return new Response('Invalid asset path', { status: 400 });
  }

  const filename = path.at(-1)!;
  const folder = path.slice(0, -1).join('/');
  const range = request.headers.get('range');

  try {
    const upstream = await fetch(assetUrl(folder, filename), {
      headers: range ? { range } : undefined,
    });
    const headers = new Headers();
    for (const name of FORWARDED_HEADERS) {
      const value = upstream.headers.get(name);
      if (value) headers.set(name, value);
    }
    headers.set('cache-control', 'public, max-age=86400, stale-while-revalidate=604800');

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  } catch {
    return new Response('Upstream asset request failed', { status: 502 });
  }
}
