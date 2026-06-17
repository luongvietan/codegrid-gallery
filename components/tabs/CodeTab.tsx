'use client';
import { useEffect, useMemo, useState } from 'react';
import type { ExtractedZip } from '@/lib/zip';
import { ext } from '@/lib/format';

const TEXT_EXT = new Set(['html','htm','css','js','mjs','cjs','jsx','ts','tsx','json','md','txt','svg','xml','yml','yaml','gitignore','env','config','map','rscinfo','sample','old']);
const IMG_EXT = new Set(['png','jpg','jpeg','gif','webp','avif','ico','bmp']);

type View =
  | { kind: 'text'; text: string }
  | { kind: 'img'; url: string }
  | { kind: 'binary'; e: string; kb: string }
  | null;

export default function CodeTab({ zip, onToast }: { zip: ExtractedZip | null; onToast?: (m: string) => void }) {
  const [active, setActive] = useState<string | null>(null);

  const groups = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const n of zip?.names ?? []) {
      const top = n.includes('/') ? n.split('/')[0] + '/' : '(root)';
      if (!m.has(top)) m.set(top, []);
      m.get(top)!.push(n);
    }
    return m;
  }, [zip]);

  useEffect(() => {
    if (!zip) return;
    const pref = zip.names.find((n) => /index\.html$/i.test(n))
      || zip.names.find((n) => /src\/app\/page\.(jsx?|tsx?)$/i.test(n))
      || zip.names.find((n) => /(^|\/)(page|app|index|main)\.(jsx?|tsx?)$/i.test(n))
      || zip.names.find((n) => /\.(jsx?|tsx?|css)$/i.test(n))
      || zip.names.find((n) => /package\.json$/i.test(n))
      || zip.names[0] || null;
    setActive(pref);
  }, [zip]);

  const view: View = useMemo(() => {
    if (!active || !zip) return null;
    const ab = zip.files.get(active);
    if (!ab) return null;
    const e = ext(active);
    if (IMG_EXT.has(e) || e === 'svg') {
      const url = URL.createObjectURL(new Blob([ab], { type: e === 'svg' ? 'image/svg+xml' : 'image/' + e }));
      return { kind: 'img', url };
    }
    if (!TEXT_EXT.has(e)) {
      return { kind: 'binary', e, kb: (ab.byteLength / 1024).toFixed(1) };
    }
    let text = new TextDecoder('utf-8').decode(ab);
    if (text.length > 400000) text = text.slice(0, 400000) + '\n\n… (đã cắt bớt)';
    return { kind: 'text', text };
  }, [active, zip]);

  // Revoke object URLs created for image previews when the file changes/unmounts.
  useEffect(() => {
    if (view?.kind !== 'img') return;
    const url = view.url;
    return () => URL.revokeObjectURL(url);
  }, [view]);

  async function copyCode() {
    if (view?.kind !== 'text') return;
    try {
      await navigator.clipboard.writeText(view.text);
      onToast?.('Đã copy code.');
    } catch {
      onToast?.('Không copy được (clipboard bị chặn).');
    }
  }

  return (
    <section className="pane pane-code active">
      <aside className="filetree">
        {[...groups].map(([dir, files]) => (
          <div key={dir}>
            <div className="dir">{dir}</div>
            {files.map((n) => (
              <div
                key={n}
                className={`f ${active === n ? 'active' : ''}`}
                title={n}
                onClick={() => setActive(n)}
              >{n.includes('/') ? n.split('/').slice(1).join('/') : n}</div>
            ))}
          </div>
        ))}
      </aside>
      <div className="codeview">
        <div className="code-head">
          <span className="status">{active ?? ''}</span>
          {view?.kind === 'text' && (
            <button className="ghost" onClick={copyCode} title="Copy toàn bộ file">Copy</button>
          )}
        </div>
        <pre id="code">
          {view?.kind === 'img' && (
            <div style={{ padding: 18, textAlign: 'center' }}>
              <img src={view.url} style={{ maxWidth: '100%', maxHeight: '70vh', borderRadius: 8 }} alt={active ?? ''} />
            </div>
          )}
          {view?.kind === 'binary' && (
            <div className="binary-note">File nhị phân (.{view.e}) — {view.kb} KB.</div>
          )}
          {view?.kind === 'text' && <code style={{ whiteSpace: 'pre' }}>{view.text}</code>}
        </pre>
      </div>
    </section>
  );
}
