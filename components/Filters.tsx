'use client';
import type { ProjectType } from '@/lib/types';

export type Filter = 'all' | ProjectType;
export type SortKey = 'date-desc' | 'date-asc' | 'title' | 'type-asc' | 'type-desc';

const CHIPS: { type: Filter; label: string }[] = [
  { type: 'all', label: 'Tất cả' },
  { type: 'html', label: 'HTML' },
  { type: 'nextjs', label: 'Next.js' },
  { type: 'react', label: 'React' },
];

export default function Filters({
  filter, setFilter, sort, setSort, search, setSearch, meta,
}: {
  filter: Filter; setFilter: (f: Filter) => void;
  sort: SortKey; setSort: (s: SortKey) => void;
  search: string; setSearch: (s: string) => void;
  meta: string;
}) {
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
            <option value="type-asc">Loại: HTML → React → Next.js</option>
            <option value="type-desc">Loại: Next.js → React → HTML</option>
          </select>
        </div>
        <div className="filters">
          {CHIPS.map((c) => (
            <button
              key={c.type}
              className={`chip ${filter === c.type ? 'active' : ''}`}
              onClick={() => setFilter(c.type)}
            >{c.label}</button>
          ))}
        </div>
      </div>
      <div className="meta">{meta}</div>
    </header>
  );
}
