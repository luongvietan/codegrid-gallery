'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { BUCKET_LABEL, type RuntimeBucket } from '@/lib/runtime';

export type Filter = 'all' | RuntimeBucket;
export type SortKey = 'date-desc' | 'date-asc' | 'title' | 'type-asc' | 'type-desc';

const BUCKET_CHIPS: RuntimeBucket[] = ['html', 'vite', 'react', 'nextjs', 'other'];

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: 'date-desc', label: 'Mới nhất' },
  { value: 'date-asc', label: 'Cũ nhất' },
  { value: 'title', label: 'Tên A→Z' },
  { value: 'type-asc', label: 'Runtime ↑' },
  { value: 'type-desc', label: 'Runtime ↓' },
];

function SortMenu({
  value,
  onChange,
}: {
  value: SortKey;
  onChange: (value: SortKey) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const current = SORT_OPTIONS.find((o) => o.value === value) ?? SORT_OPTIONS[0];

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className={`sort-menu${open ? ' is-open' : ''}`} ref={rootRef}>
      <button
        type="button"
        className="sort-trigger"
        aria-label="Sắp xếp"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((v) => !v)}
      >
        <span>{current.label}</span>
      </button>
      {open ? (
        <ul
          id={listId}
          className="sort-list"
          role="listbox"
          aria-label="Sắp xếp"
        >
          {SORT_OPTIONS.map((option) => {
            const active = option.value === value;
            return (
              <li key={option.value} role="presentation">
                <button
                  type="button"
                  role="option"
                  aria-selected={active}
                  className={`sort-option${active ? ' active' : ''}`}
                  onClick={() => {
                    onChange(option.value);
                    setOpen(false);
                  }}
                >
                  {option.label}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

export default function Filters({
  filter, setFilter, sort, setSort, search, setSearch, meta, counts, total,
}: {
  filter: Filter; setFilter: (f: Filter) => void;
  sort: SortKey; setSort: (s: SortKey) => void;
  search: string; setSearch: (s: string) => void;
  meta: string;
  counts: Record<RuntimeBucket, number>;
  total: number;
}) {
  const searchRef = useRef<HTMLInputElement>(null);

  const pills: { type: Filter; label: string; count: number }[] = [
    { type: 'all', label: 'Project', count: total },
    ...BUCKET_CHIPS
      .filter((bucket) => counts[bucket] > 0)
      .map((bucket) => ({
        type: bucket as Filter,
        label: BUCKET_LABEL[bucket],
        count: counts[bucket],
      })),
  ];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) return;
      e.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  return (
    <>
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
            <p className="tagline">Tìm project, xem preview, đọc source</p>
          </div>
        </div>
        <div className="controls">
          <div className="search-wrap">
            <svg className="search-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
              <path d="m20 20-3.5-3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            <input
              ref={searchRef}
              id="gallery-search"
              type="search"
              placeholder="Tìm tên, ngày, tác giả… (/)"
              autoComplete="off"
              spellCheck={false}
              aria-label="Tìm project"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {search ? (
              <button
                type="button"
                className="search-clear"
                aria-label="Xóa tìm kiếm"
                onClick={() => {
                  setSearch('');
                  searchRef.current?.focus();
                }}
              >
                ✕
              </button>
            ) : null}
          </div>
          <SortMenu value={sort} onChange={setSort} />
        </div>
        <div className="meta" aria-live="polite">{meta}</div>
      </header>
      <nav className="filter-dock" aria-label="Lọc nhanh theo loại">
        <div className="filters">
          {pills.map((pill) => {
            const active = filter === pill.type;
            return (
              <button
                key={pill.type}
                type="button"
                className={`chip${active ? ' active' : ''}`}
                aria-pressed={active}
                onClick={() => setFilter(pill.type)}
              >
                <span>{pill.label}</span>
                <span className="chip-count">{pill.count}</span>
              </button>
            );
          })}
        </div>
      </nav>
    </>
  );
}
