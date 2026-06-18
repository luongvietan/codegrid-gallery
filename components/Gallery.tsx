'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { IndexData, Project } from '@/lib/types';
import { initSW } from '@/lib/sw-client';
import Filters, { type Filter, type SortKey } from './Filters';
import Card from './Card';
import ProjectModal from './ProjectModal';

const TYPE_ORDER: Record<string, number> = { html: 1, react: 2, nextjs: 3 };

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

  const counts = data.counts || {};
  const videoCount = data.projects.filter((p) => p.video || p.media?.videos?.length).length;

  const items = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = data.projects.filter((p) => {
      if (filter !== 'all' && p.type !== filter) return false;
      if (!q) return true;
      const hay = [p.title, p.folder, p.date, p.author, p.msgId, p.type].filter(Boolean).join(' ').toLowerCase();
      return hay.includes(q);
    });
    list = [...list].sort((a, b) => {
      if (sort === 'title') return (a.title || '').localeCompare(b.title || '');
      if (sort === 'type-asc' || sort === 'type-desc') {
        const cmp = (TYPE_ORDER[a.type] || 9) - (TYPE_ORDER[b.type] || 9) || (a.title || '').localeCompare(b.title || '');
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
      />
      <div className="stats">
        <div className="stat"><span className="stat-label">Project</span><span className="stat-val">{data.projects.length}</span></div>
        <div className="stat"><span className="stat-label">HTML</span><span className="stat-val">{counts.html || 0}</span></div>
        <div className="stat"><span className="stat-label">React</span><span className="stat-val">{counts.react || 0}</span></div>
        <div className="stat"><span className="stat-label">Next.js</span><span className="stat-val">{counts.nextjs || 0}</span></div>
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
