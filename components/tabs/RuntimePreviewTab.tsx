'use client';

import { useEffect, useRef, useState } from 'react';
import {
  runtimeRecoveryPolicy,
  runRuntimePreview,
  type RuntimePreviewSnapshot,
} from '@/lib/webcontainer-preview';
import type { ProjectType } from '@/lib/types';
import type { ExtractedZip } from '@/lib/zip';

const PREVIEW_SANDBOX = 'allow-scripts allow-same-origin allow-pointer-lock allow-forms allow-popups';
const INITIAL_SNAPSHOT: RuntimePreviewSnapshot = {
  phase: 'preparing',
  message: 'Đang chuẩn bị project…',
  notice: null,
  logs: [],
  url: null,
  error: null,
  recovery: null,
};

export default function RuntimePreviewTab({
  type,
  zip,
}: {
  type: Exclude<ProjectType, 'html'>;
  zip: ExtractedZip;
}) {
  const iframe = useRef<HTMLIFrameElement>(null);
  const activeRun = useRef(0);
  const [attempt, setAttempt] = useState(0);
  const [snapshot, setSnapshot] = useState(INITIAL_SNAPSHOT);

  useEffect(() => {
    const abort = new AbortController();
    const runId = ++activeRun.current;

    void Promise.resolve().then(() => runRuntimePreview({
      zip,
      signal: abort.signal,
      boot: async (options) => {
        const { WebContainer } = await import('@webcontainer/api');
        return WebContainer.boot(options);
      },
      onUpdate(nextSnapshot) {
        if (activeRun.current === runId) setSnapshot(nextSnapshot);
      },
    }));

    return () => {
      if (activeRun.current === runId) activeRun.current += 1;
      abort.abort();
    };
  }, [attempt, zip]);

  const readyUrl = snapshot.phase === 'ready' ? snapshot.url : null;
  const recovery = runtimeRecoveryPolicy(snapshot.recovery);

  return (
    <section className="pane pane-preview active">
      <div className="preview-toolbar">
        <span className="status">{snapshot.message}</span>
        {snapshot.notice && <span className="status notice">{snapshot.notice}</span>}
        {readyUrl && (
          <>
            <button
              className="ghost"
              onClick={() => window.open(readyUrl, '_blank', 'noopener,noreferrer')}
            >
              ↗ Tab mới
            </button>
            <button
              className="ghost"
              aria-label="Tải lại preview"
              onClick={() => {
                if (iframe.current) iframe.current.src = readyUrl;
              }}
            >
              ⟳
            </button>
          </>
        )}
      </div>
      {readyUrl ? (
        <div className="iframe-wrap">
          <iframe
            id="preview"
            ref={iframe}
            src={readyUrl}
            title={`${type === 'nextjs' ? 'Next.js' : 'React'} runtime preview`}
            sandbox={PREVIEW_SANDBOX}
          />
        </div>
      ) : (
        <div className={`spinner ${snapshot.phase === 'failure' ? 'no-spin' : ''}`}>
          <span>{snapshot.message}</span>
          {snapshot.logs.length > 0 && (
            <pre className="runtime-output">{snapshot.logs.join('\n')}</pre>
          )}
          {snapshot.phase === 'failure' && recovery && (
            <button
              className="ghost"
              onClick={() => {
                if (recovery.action === 'reload') {
                  window.location.reload();
                  return;
                }
                setSnapshot(INITIAL_SNAPSHOT);
                setAttempt((value) => value + 1);
              }}
            >
              {recovery.label}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
