'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { hasPreviewTab, needsSourceZip, previewKind, type PreviewTab as Tab } from '@/lib/preview';
import type { Project } from '@/lib/types';
import { fetchAndExtractZip, type ExtractedZip } from '@/lib/zip';
import CodeTab from './tabs/CodeTab';
import MediaTab from './tabs/MediaTab';
import PreviewTab from './tabs/PreviewTab';
import RuntimePreviewTab from './tabs/RuntimePreviewTab';
import StaticPreviewTab from './tabs/StaticPreviewTab';
import { runtimeBucket, runtimeLabel } from '@/lib/runtime';

interface SourceState {
  projectKey: string;
  zip: ExtractedZip | null;
  err: string | null;
}

export default function ProjectModal({ p, onClose, onToast }: {
  p: Project; onClose: () => void; onToast: (m: string) => void;
}) {
  const kind = previewKind(p);
  const hasPreview = hasPreviewTab(p);
  const projectKey = `${p.folder}\0${p.zip}`;
  const defaultTab: Tab = hasPreview ? 'preview' : (p.type === 'html' ? 'media' : 'code');
  const [tabState, setTabState] = useState({ projectKey, tab: defaultTab });
  const [sourceState, setSourceState] = useState<SourceState>({ projectKey, zip: null, err: null });
  const [loadingState, setLoadingState] = useState({ projectKey, loading: false });
  const loadingRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const loadRunRef = useRef(0);
  const currentProjectKeyRef = useRef(projectKey);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = 'project-modal-title';

  const tab = tabState.projectKey === projectKey ? tabState.tab : defaultTab;
  const zip = sourceState.projectKey === projectKey ? sourceState.zip : null;
  const err = sourceState.projectKey === projectKey ? sourceState.err : null;
  const loading = loadingState.projectKey === projectKey && loadingState.loading;
  const selectTab = (nextTab: Tab) => setTabState({ projectKey, tab: nextTab });

  useLayoutEffect(() => {
    currentProjectKeyRef.current = projectKey;
    loadRunRef.current += 1;
    loadingRef.current = null;
  }, [projectKey]);

  useEffect(() => {
    mountedRef.current = true;
    document.body.classList.add('modal-open');
    const previouslyFocused = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== 'Tab' || !panelRef.current) return;
      const focusable = panelRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      mountedRef.current = false;
      loadRunRef.current += 1;
      document.body.classList.remove('modal-open');
      document.removeEventListener('keydown', onKey);
      previouslyFocused?.focus?.();
    };
  }, [onClose]);

  useEffect(() => {
    if (!needsSourceZip(tab, kind) || zip || loading || loadingRef.current === projectKey || err) return;

    loadingRef.current = projectKey;
    setLoadingState({ projectKey, loading: true });
    const loadRun = ++loadRunRef.current;
    (async () => {
      try {
        const loadedZip = await fetchAndExtractZip(p.folder, p.zip);
        if (
          mountedRef.current
          && currentProjectKeyRef.current === projectKey
          && loadRunRef.current === loadRun
        ) {
          setSourceState({ projectKey, zip: loadedZip, err: null });
        }
      } catch (error) {
        if (
          mountedRef.current
          && currentProjectKeyRef.current === projectKey
          && loadRunRef.current === loadRun
        ) {
          const message = (error as Error).message;
          setSourceState({ projectKey, zip: null, err: message });
          onToast('Lỗi đọc zip: ' + message);
        }
      } finally {
        if (loadRunRef.current === loadRun) {
          if (loadingRef.current === projectKey) loadingRef.current = null;
          if (mountedRef.current && currentProjectKeyRef.current === projectKey) {
            setLoadingState({ projectKey, loading: false });
          }
        }
      }
    })();
  }, [err, kind, loading, onToast, p.folder, p.zip, projectKey, tab, zip]);

  const sub = [p.date, p.author, p.folder].filter(Boolean).join(' · ');

  return (
    <div className="modal" role="presentation">
      <div className="modal-backdrop" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        className="modal-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="modal-head">
          <div className="modal-title">
            <span className={`badge ${runtimeBucket(p)}`}>{runtimeLabel(p)}</span>
            <div className="modal-title-text">
              <h2 id={titleId}>{p.title}</h2>
              <div className="modal-sub">{sub}</div>
            </div>
          </div>
          <div className="modal-tabs" role="tablist" aria-label="Nội dung project">
            {hasPreview && (
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'preview'}
                className={`tab ${tab === 'preview' ? 'active' : ''}`}
                onClick={() => selectTab('preview')}
              >
                Preview
              </button>
            )}
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'code'}
              className={`tab ${tab === 'code' ? 'active' : ''}`}
              onClick={() => selectTab('code')}
            >
              Code
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'media'}
              className={`tab ${tab === 'media' ? 'active' : ''}`}
              onClick={() => selectTab('media')}
            >
              Media
            </button>
          </div>
          <button ref={closeRef} type="button" className="close" onClick={onClose} aria-label="Đóng">✕</button>
        </div>
        <div className="modal-body">
          {tab === 'preview' && kind === 'static' && p.preview && <StaticPreviewTab preview={p.preview} />}
          {tab === 'preview' && kind === 'runtime-required' && err && <div className="spinner no-spin">Lỗi: {err}</div>}
          {tab === 'preview' && kind === 'runtime-required' && !err && !zip && <div className="spinner">Đang tải &amp; giải nén zip…</div>}
          {tab === 'preview' && kind === 'runtime-required' && !err && zip && p.type !== 'html' && <RuntimePreviewTab key={projectKey} type={p.type} zip={zip} />}
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
