'use client';
import { useRef } from 'react';
import type { Project } from '@/lib/types';
import { assetUrl } from '@/lib/assets';

const TYPE_LABEL: Record<string, string> = { html: 'HTML', nextjs: 'Next.js', react: 'React' };

export default function Card({ p, onOpen }: { p: Project; onOpen: (p: Project) => void }) {
  const vidRef = useRef<HTMLVideoElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const playing = useRef(false);

  const thumbSrc = p.thumbnail ? assetUrl(p.folder, p.thumbnail) : '';
  const vidSrc = p.video ? assetUrl(p.folder, p.video) : '';
  const meta = [p.date, p.author].filter(Boolean).join(' · ');

  function enter() {
    if (!p.video) return;
    playing.current = true;
    timer.current = setTimeout(() => {
      const v = vidRef.current;
      if (!v) return;
      if (!v.src) v.src = vidSrc;
      v.play().catch(() => {});
    }, 120);
  }
  function leave() {
    playing.current = false;
    clearTimeout(timer.current);
    const v = vidRef.current;
    if (v) { (v.closest('.card') as HTMLElement)?.classList.remove('playing'); v.pause(); try { v.currentTime = 0; } catch {} }
  }

  return (
    <div className="card" onClick={() => onOpen(p)} onMouseEnter={enter} onMouseLeave={leave}>
      <div
        className={`thumb ${p.thumbnail ? '' : 'placeholder'}`}
        style={p.thumbnail ? { backgroundImage: `url('${thumbSrc}')` } : undefined}
      >
        {p.thumbnail ? '' : 'No preview'}
        {p.video && (
          <>
            <video
              ref={vidRef}
              className="thumb-vid"
              muted loop playsInline preload="none"
              onPlaying={(e) => { if (playing.current) (e.currentTarget.closest('.card') as HTMLElement)?.classList.add('playing'); }}
            />
            <span className="vid-badge">▶</span>
          </>
        )}
      </div>
      <div className="card-body">
        <span className={`badge ${p.type}`}>{TYPE_LABEL[p.type]}</span>
        {meta && <div className="card-meta">{meta}</div>}
        <div className="card-title">{p.title}</div>
      </div>
    </div>
  );
}
