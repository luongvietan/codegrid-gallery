'use client';
import { useEffect, useState } from 'react';
import type { Project } from '@/lib/types';
import { fetchAndExtractZip, type ExtractedZip } from '@/lib/zip';
import PreviewTab from './tabs/PreviewTab';
import CodeTab from './tabs/CodeTab';
import MediaTab from './tabs/MediaTab';

const TYPE_LABEL: Record<string, string> = { html: 'HTML', nextjs: 'Next.js', react: 'React' };
type Tab = 'preview' | 'code' | 'media';

export default function ProjectModal({ p, onClose, onToast }: {
  p: Project; onClose: () => void; onToast: (m: string) => void;
}) {
  const hasPreview = p.type === 'html' && !!p.entryHtml;
  const [tab, setTab] = useState<Tab>(hasPreview ? 'preview' : (p.type === 'html' ? 'media' : 'code'));
  const [zip, setZip] = useState<ExtractedZip | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    document.body.classList.add('modal-open');
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    let cancelled = false;
    (async () => {
      try {
        const z = await fetchAndExtractZip(p.folder, p.zip);
        if (!cancelled) setZip(z);
      } catch (e) {
        if (!cancelled) { setErr((e as Error).message); onToast('Lỗi đọc zip: ' + (e as Error).message); }
      }
    })();
    return () => {
      cancelled = true;
      document.body.classList.remove('modal-open');
      document.removeEventListener('keydown', onKey);
    };
  }, [p, onClose, onToast]);

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
          {err && <div className="spinner">Lỗi: {err}</div>}
          {!err && !zip && <div className="spinner">Đang tải & giải nén zip…</div>}
          {!err && zip && tab === 'preview' && hasPreview && <PreviewTab p={p} zip={zip} onToast={onToast} />}
          {!err && zip && tab === 'code' && <CodeTab zip={zip} onToast={onToast} />}
          {!err && zip && tab === 'media' && <MediaTab p={p} />}
        </div>
      </div>
    </div>
  );
}
