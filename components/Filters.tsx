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
        <span className="logo">▦</span>
        <div>
          <h1>CodeGrid <span className="muted">Preview Gallery</span></h1>
          <p className="tagline">Browse downloads · preview HTML via Service Worker</p>
        </div>
      </div>
      <div className="controls">
        <input
          type="search" placeholder="Tìm theo tên, ngày, tác giả…" autoComplete="off"
          value={search} onChange={(e) => setSearch(e.target.value)}
        />
        <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="Sắp xếp">
          <option value="date-desc">Mới nhất trước</option>
          <option value="date-asc">Cũ nhất trước</option>
          <option value="title">Title A→Z</option>
          <option value="type-asc">Loại: HTML → React → Next.js</option>
          <option value="type-desc">Loại: Next.js → React → HTML</option>
        </select>
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
