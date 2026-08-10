'use client';
import { BUCKET_LABEL, type RuntimeBucket } from '@/lib/runtime';

export type Filter = 'all' | RuntimeBucket;
export type SortKey = 'date-desc' | 'date-asc' | 'title' | 'type-asc' | 'type-desc';

const BUCKET_CHIPS: RuntimeBucket[] = ['html', 'vite', 'react', 'nextjs', 'other'];

export default function Filters({
  filter, setFilter, sort, setSort, search, setSearch, meta, counts,
}: {
  filter: Filter; setFilter: (f: Filter) => void;
  sort: SortKey; setSort: (s: SortKey) => void;
  search: string; setSearch: (s: string) => void;
  meta: string;
  counts: Record<RuntimeBucket, number>;
}) {
  // An empty bucket would only be a dead end, so it stays out of the row.
  const chips: { type: Filter; label: string }[] = [
    { type: 'all', label: 'Tất cả' },
    ...BUCKET_CHIPS
      .filter((bucket) => counts[bucket] > 0)
      .map((bucket) => ({ type: bucket as Filter, label: BUCKET_LABEL[bucket] })),
  ];
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none">
            <rect x="3" y="3" width="7.5" height="7.5" rx="1.6" fill="currentColor" />
            <rect x="13.5" y="3" width="7.5" height="7.5" rx="1.6" fill="currentColor" opacity="0.55" />
            <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.6" fill="currentColor" opacity="0.55" />
            <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.6" fill="currentColor" />
          </svg>
        </span>
        <div>
          <h1>CodeGrid <span className="muted">Preview Gallery</span></h1>
          <p className="tagline">Browse downloads · preview HTML via Service Worker</p>
        </div>
      </div>
      <div className="controls">
        <div className="search-wrap">
          <svg className="search-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
            <path d="m20 20-3.5-3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          <input
            type="search" placeholder="Tìm theo tên, ngày, tác giả…" autoComplete="off"
            value={search} onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="select-wrap">
          <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="Sắp xếp">
            <option value="date-desc">Mới nhất trước</option>
            <option value="date-asc">Cũ nhất trước</option>
            <option value="title">Title A→Z</option>
            <option value="type-asc">Runtime: HTML → Vite → React → Next.js</option>
            <option value="type-desc">Runtime: Next.js → React → Vite → HTML</option>
          </select>
        </div>
        <div className="filters" role="group" aria-label="Lọc theo runtime">
          {chips.map((c) => (
            <button
              key={c.type}
              className={`chip ${filter === c.type ? 'active' : ''}`}
              aria-pressed={filter === c.type}
              onClick={() => setFilter(c.type)}
            >{c.label}</button>
          ))}
        </div>
      </div>
      <div className="meta">{meta}</div>
    </header>
  );
}
