'use client';

import { useEffect, useRef, useState } from 'react';
import { hasPreviewTab, needsSourceZip, previewKind, type PreviewTab as Tab } from '@/lib/preview';
import type { Project } from '@/lib/types';
import { fetchAndExtractZip, type ExtractedZip } from '@/lib/zip';
import CodeTab from './tabs/CodeTab';
import MediaTab from './tabs/MediaTab';
import PreviewTab from './tabs/PreviewTab';
import RuntimePreviewTab from './tabs/RuntimePreviewTab';
import StaticPreviewTab from './tabs/StaticPreviewTab';

const TYPE_LABEL: Record<string, string> = { html: 'HTML', nextjs: 'Next.js', react: 'React' };

export default function ProjectModal({ p, onClose, onToast }: {
  p: Project; onClose: () => void; onToast: (m: string) => void;
}) {
  const kind = previewKind(p);
  const hasPreview = hasPreviewTab(p);
  const [tab, setTab] = useState<Tab>(hasPreview ? 'preview' : (p.type === 'html' ? 'media' : 'code'));
  const [zip, setZip] = useState<ExtractedZip | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const loadingRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    document.body.classList.add('modal-open');
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => {
      mountedRef.current = false;
      document.body.classList.remove('modal-open');
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  useEffect(() => {
    if (!needsSourceZip(tab, kind) || zip || loading || loadingRef.current || err) return;

    loadingRef.current = true;
    setLoading(true);
    (async () => {
      try {
        const loadedZip = await fetchAndExtractZip(p.folder, p.zip);
        if (mountedRef.current) setZip(loadedZip);
      } catch (error) {
        if (mountedRef.current) {
          const message = (error as Error).message;
          setErr(message);
          onToast('Lỗi đọc zip: ' + message);
        }
      } finally {
        loadingRef.current = false;
        if (mountedRef.current) setLoading(false);
      }
    })();
  }, [err, kind, loading, onToast, p.folder, p.zip, tab, zip]);

  const sub = [p.date, p.author, p.folder].filter(Boolean).join(' · ');

  return (
    <div className="modal">
      <div className="modal-backdrop" onClick={onClose} />
      <div className="modal-panel">
        <div className="modal-head">
          <div className="modal-title">
            <span className={`badge ${p.type}`}>{TYPE_LABEL[p.type]}</span>
            <div className="modal-title-text">
              <h2>{p.title}</h2>
              <div className="modal-sub">{sub}</div>
            </div>
          </div>
          <div className="modal-tabs">
            {hasPreview && <button className={`tab ${tab === 'preview' ? 'active' : ''}`} onClick={() => setTab('preview')}>Preview</button>}
            <button className={`tab ${tab === 'code' ? 'active' : ''}`} onClick={() => setTab('code')}>Code</button>
            <button className={`tab ${tab === 'media' ? 'active' : ''}`} onClick={() => setTab('media')}>Media</button>
          </div>
          <button className="close" onClick={onClose} aria-label="Đóng">✕</button>
        </div>
        <div className="modal-body">
          {tab === 'preview' && kind === 'static' && p.preview && <StaticPreviewTab preview={p.preview} />}
          {tab === 'preview' && kind === 'runtime-required' && p.type !== 'html' && <RuntimePreviewTab type={p.type} />}
          {tab === 'preview' && kind === 'legacy-html' && err && <div className="spinner no-spin">Lỗi: {err}</div>}
          {tab === 'preview' && kind === 'legacy-html' && !err && !zip && <div className="spinner">Đang tải &amp; giải nén zip…</div>}
          {tab === 'preview' && kind === 'legacy-html' && !err && zip && <PreviewTab p={p} zip={zip} onToast={onToast} />}
          {tab === 'code' && err && <div className="spinner no-spin">Lỗi: {err}</div>}
          {tab === 'code' && !err && !zip && <div className="spinner">Đang tải &amp; giải nén zip…</div>}
          {tab === 'code' && !err && zip && <CodeTab zip={zip} onToast={onToast} />}
          {tab === 'media' && <MediaTab p={p} />}
        </div>
      </div>
    </div>
  );
}
