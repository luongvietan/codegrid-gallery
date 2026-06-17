'use client';
import type { Project } from '@/lib/types';
import { assetUrl } from '@/lib/assets';
import { formatSize } from '@/lib/format';

interface Row { label: string; name: string | null; size?: number; href: string; local: boolean; }

function mediaSources(p: Project): Row[] {
  const rows: Row[] = [];
  const push = (label: string, files: Project['media'] extends infer M ? any[] : never, localName: string | null) => {
    (files || []).forEach((f: any) => {
      const name = f.filename || localName;
      const local = name ? assetUrl(p.folder, name) : null;
      rows.push({ label, name, size: f.size, href: local || f.url, local: !!name });
    });
  };
  push('ZIP', p.media?.zips as any, p.zip);
  push('IMG', p.media?.images as any, p.thumbnail);
  push('VID', p.media?.videos as any, p.video);
  if (!rows.length) {
    if (p.zip) rows.push({ label: 'ZIP', name: p.zip, href: assetUrl(p.folder, p.zip), local: true });
    if (p.thumbnail) rows.push({ label: 'IMG', name: p.thumbnail, href: assetUrl(p.folder, p.thumbnail), local: true });
    if (p.video) rows.push({ label: 'VID', name: p.video, href: assetUrl(p.folder, p.video), local: true });
  }
  return rows;
}

export default function MediaTab({ p }: { p: Project }) {
  const vidName = p.video || p.media?.videos?.[0]?.filename;
  const imgName = p.thumbnail || p.media?.images?.[0]?.filename;
  const vidSrc = vidName ? assetUrl(p.folder, vidName) : p.media?.videos?.[0]?.url;
  const imgSrc = imgName ? assetUrl(p.folder, imgName) : p.media?.images?.[0]?.url;
  const rows = mediaSources(p);

  return (
    <section className="pane pane-media active">
      <div className="media-wrap">
        {vidSrc ? (
          <video controls playsInline src={vidSrc} poster={imgSrc || undefined} />
        ) : imgSrc ? (
          <img src={imgSrc} alt={p.title} />
        ) : (
          <div className="media-empty">Không có video/ảnh preview.</div>
        )}
      </div>
      <div className="file-list">
        {rows.length ? rows.map((r, i) => (
          <div className="file-row" key={i}>
            <div><span className="mono">{r.label}</span> · {r.name || '—'}</div>
            <div className="mono">{formatSize(r.size)}</div>
            <a href={r.href} target="_blank" rel="noopener">{r.local ? 'Mở file' : 'Mở URL'}</a>
          </div>
        )) : <div className="media-empty">Không có file đính kèm.</div>}
      </div>
    </section>
  );
}
