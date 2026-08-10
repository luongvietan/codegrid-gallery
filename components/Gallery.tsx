'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { IndexData, Project } from '@/lib/types';
import { initSW } from '@/lib/sw-client';
import Filters, { type Filter, type SortKey } from './Filters';
import Card from './Card';
import ProjectModal from './ProjectModal';

import { BUCKET_LABEL, BUCKET_ORDER, runtimeBucket, runtimeBucketCounts, type RuntimeBucket } from '@/lib/runtime';

const STAT_BUCKETS: RuntimeBucket[] = ['html', 'vite', 'react', 'nextjs', 'other'];

export default function Gallery({ data }: { data: IndexData }) {
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<SortKey>('date-desc');
  const [search, setSearch] = useState('');
  const [current, setCurrent] = useState<Project | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const showToast = useCallback((m: string) => {
    setToast(m);
    setTimeout(() => setToast(null), 6000);
  }, []);
  const closeModal = useCallback(() => setCurrent(null), []);
  useEffect(() => { initSW(showToast); }, [showToast]);

  const counts = useMemo(() => runtimeBucketCounts(data.projects), [data.projects]);
  const videoCount = data.projects.filter((p) => p.video || p.media?.videos?.length).length;

  const items = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = data.projects.filter((p) => {
      const bucket = runtimeBucket(p);
      if (filter !== 'all' && bucket !== filter) return false;
      if (!q) return true;
      const hay = [p.title, p.folder, p.date, p.author, p.msgId, p.runtime, BUCKET_LABEL[bucket]]
        .filter(Boolean).join(' ').toLowerCase();
      return hay.includes(q);
    });
    list = [...list].sort((a, b) => {
      if (sort === 'title') return (a.title || '').localeCompare(b.title || '');
      if (sort === 'type-asc' || sort === 'type-desc') {
        const cmp = BUCKET_ORDER[runtimeBucket(a)] - BUCKET_ORDER[runtimeBucket(b)]
          || (a.title || '').localeCompare(b.title || '');
        return sort === 'type-desc' ? -cmp : cmp;
      }
      const da = a.date || '', db = b.date || '';
      return sort === 'date-asc' ? da.localeCompare(db) : db.localeCompare(da);
    });
    return list;
  }, [data.projects, filter, sort, search]);

  return (
    <>
      <Filters
        filter={filter} setFilter={setFilter}
        sort={sort} setSort={setSort}
        search={search} setSearch={setSearch}
        meta={`${items.length} / ${data.projects.length} project`}
        counts={counts}
      />
      <div className="stats">
        <div className="stat"><span className="stat-label">Project</span><span className="stat-val">{data.projects.length}</span></div>
        {STAT_BUCKETS.filter((bucket) => counts[bucket] > 0).map((bucket) => (
          <div className="stat" key={bucket}>
            <span className="stat-label">{BUCKET_LABEL[bucket]}</span>
            <span className="stat-val">{counts[bucket]}</span>
          </div>
        ))}
        <div className="stat"><span className="stat-label">Video</span><span className="stat-val">{videoCount}</span></div>
      </div>
      <main className="grid" aria-live="polite">
        {items.length ? items.map((p) => <Card key={p.id} p={p} onOpen={setCurrent} />)
          : <div className="spinner no-spin">Không có project nào khớp.</div>}
      </main>
      {current && <ProjectModal p={current} onClose={closeModal} onToast={showToast} />}
      {toast && <div className="toast">{toast}</div>}
    </>
  );
}
