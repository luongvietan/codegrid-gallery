'use client';

import { useRef } from 'react';
import { staticPreviewUrl } from '@/lib/preview';
import type { PreviewManifest } from '@/lib/types';

const PREVIEW_SANDBOX = 'allow-scripts allow-same-origin allow-pointer-lock allow-forms allow-popups';

export default function StaticPreviewTab({ preview }: { preview: PreviewManifest }) {
  const iframe = useRef<HTMLIFrameElement>(null);
  const url = staticPreviewUrl(preview);

  return (
    <section className="pane pane-preview active">
      <div className="preview-toolbar">
        <span className="status">{preview.entry}</span>
        <button
          type="button"
          className="ghost"
          onClick={() => window.open(url, '_blank', 'noopener,noreferrer')}
        >
          ↗ Tab mới
        </button>
        <button
          type="button"
          className="ghost icon"
          aria-label="Tải lại preview"
          onClick={() => {
            if (iframe.current) iframe.current.src = url;
          }}
        >
          ⟳
        </button>
      </div>
      <div className="iframe-wrap">
        <iframe
          id="preview"
          ref={iframe}
          src={url}
          title="Preview"
          sandbox={PREVIEW_SANDBOX}
        />
      </div>
    </section>
  );
}
