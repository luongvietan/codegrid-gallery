'use client';
import { useEffect, useRef, useState } from 'react';
import type { Project } from '@/lib/types';
import type { ExtractedZip } from '@/lib/zip';
import { swSend } from '@/lib/sw-client';

function encodePath(s: string) { return s.split('/').map(encodeURIComponent).join('/'); }

export default function PreviewTab({ p, zip, onToast }: {
  p: Project; zip: ExtractedZip | null; onToast: (m: string) => void;
}) {
  const iframe = useRef<HTMLIFrameElement>(null);
  const [status, setStatus] = useState('Đang tải zip…');
  const [entry, setEntry] = useState<string | null>(null);

  useEffect(() => {
    if (!zip) return;
    let cancelled = false;
    (async () => {
      let e = p.entryHtml;
      if (!e || !zip.files.has(e)) {
        e = zip.names.find((n) => /index\.html$/i.test(n)) || zip.names.find((n) => /\.html$/i.test(n)) || null;
      }
      if (!e) { setStatus('Không tìm thấy file HTML → xem Code.'); return; }
      const payload: Record<string, ArrayBuffer> = {};
      const transfer: Transferable[] = [];
      for (const [k, ab] of zip.files) { const c = ab.slice(0); payload[k] = c; transfer.push(c); }
      try {
        await swSend({ type: 'load', files: payload }, transfer);
      } catch (err) {
        setStatus('SW lỗi: ' + (err as Error).message);
        onToast('Service Worker lỗi: ' + (err as Error).message);
        return;
      }
      if (cancelled) return;
      setEntry(e);
      setStatus(e);
      if (iframe.current) iframe.current.src = `/__preview__/${encodePath(e)}`;
    })();
    return () => { cancelled = true; swSend({ type: 'clear' }).catch(() => {}); };
  }, [zip, p, onToast]);

  return (
    <section className="pane pane-preview active">
      <div className="preview-toolbar">
        <span className="status">{status}</span>
        <button className="ghost" onClick={() => entry && window.open(`/__preview__/${encodePath(entry)}`, '_blank')}>↗ Tab mới</button>
        <button className="ghost" onClick={() => { if (entry && iframe.current) iframe.current.src = `/__preview__/${encodePath(entry)}`; }}>⟳</button>
      </div>
      <div className="iframe-wrap">
        <iframe id="preview" ref={iframe} title="Preview" sandbox="allow-scripts allow-same-origin allow-pointer-lock allow-forms allow-popups" />
      </div>
    </section>
  );
}
