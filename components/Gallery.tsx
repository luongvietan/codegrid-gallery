'use client';
import { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react';
import type { IndexData, Project } from '@/lib/types';
import { initSW } from '@/lib/sw-client';
import Filters, { type Filter, type SortKey } from './Filters';
import Card from './Card';
import ProjectModal from './ProjectModal';

import { BUCKET_LABEL, BUCKET_ORDER, runtimeBucket, runtimeBucketCounts } from '@/lib/runtime';

export default function Gallery({ data }: { data: IndexData }) {
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<SortKey>('date-desc');
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search);
  const [current, setCurrent] = useState<Project | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const showToast = useCallback((m: string) => {
    setToast(m);
    window.setTimeout(() => setToast(null), 6000);
  }, []);
  const closeModal = useCallback(() => setCurrent(null), []);
  useEffect(() => { initSW(showToast); }, [showToast]);

  const counts = useMemo(() => runtimeBucketCounts(data.projects), [data.projects]);
  const filtering = search !== deferredSearch;

  const items = useMemo(() => {
    const q = deferredSearch.trim().toLowerCase();
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
  }, [data.projects, filter, sort, deferredSearch]);

  const clearFilters = useCallback(() => {
    setFilter('all');
    setSearch('');
  }, []);

  const hasActiveFilters = filter !== 'all' || search.trim().length > 0;

  return (
    <>
      <Filters
        filter={filter} setFilter={setFilter}
        sort={sort} setSort={setSort}
        search={search} setSearch={setSearch}
        meta={`${items.length} / ${data.projects.length} project`}
        counts={counts}
        total={data.projects.length}
      />
      <main className={`grid${filtering ? ' is-filtering' : ''}`} aria-live="polite" aria-busy={filtering}>
        {items.length ? items.map((p) => <Card key={p.id} p={p} onOpen={setCurrent} />) : (
          <div className="empty-state">
            <p className="empty-title">Không có project nào khớp</p>
            <p className="empty-copy">
              {hasActiveFilters
                ? 'Thử xóa bộ lọc hoặc đổi từ khóa tìm kiếm.'
                : 'Catalog hiện đang trống.'}
            </p>
            {hasActiveFilters ? (
              <button type="button" className="ghost empty-action" onClick={clearFilters}>
                Xóa bộ lọc
              </button>
            ) : null}
          </div>
        )}
      </main>
      {current && <ProjectModal p={current} onClose={closeModal} onToast={showToast} />}
      {toast ? <div className="toast" role="status" aria-live="polite">{toast}</div> : null}
    </>
  );
}
