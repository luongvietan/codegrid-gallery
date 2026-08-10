# Design System

## Theme

Dark, restrained product interface built from the tokens in `variables.css`. Surfaces stay quiet so project thumbnails carry visual interest.

## Color

- Canvas: `--surface-void`
- Lifted surface / cards: `--surface-surface-lift`
- Chrome / toolbars: mix of `--surface-graphite` over void (see `--surface-2` in `app/globals.css`)
- Hairline: `--color-graphite-hairline`
- Primary text: `--color-bone-white`
- Secondary text: `--color-smoke-gray`
- Muted text: `--color-ash-gray`
- Accent (actions, selection, focus): `--color-bone-white`
- Accent hover: `--color-white`
- On-accent text: `--color-void-black`
- Semantic runtime accents: amber (HTML), pulse green (Vite), sky blue (React)

Accent ≤ ~10% of the UI. Prefer solid fills over decorative gradients. Do not use neon glows or multi-layer glass.

## Typography

- UI: `--font-inter` only (loaded via `next/font`)
- Code: system `ui-monospace` stack (second face, code surfaces only)
- Body / controls: `--text-body-sm` (14px) minimum for readable chrome
- Scale and weights come from `variables.css`

## Shape

- Cards: `--radius-cards` (16px)
- Inputs / buttons / badges: `--radius-inputs` / `--radius-buttons` / `--radius-badges` (6px)
- Large panels: `--radius-large-panels` (24px)
- Prefer a single border or a compact rim shadow (`--shadow-subtle`), not both as decoration

## Layout

- Content max width: `--page-max-width` (1200px)
- Sticky topbar: search + sort
- Fixed bottom dock: pill stats/filters
- Responsive auto-fit gallery grid
- Full-viewport modal on small screens

## Motion

- 160–200ms state transitions with ease-out
- Motion for hover, focus, modal open, toast only
- Respect `prefers-reduced-motion`
- No decorative entrance choreography

## Z-index

- Sticky: 20
- Modal backdrop: 40
- Modal: 50
- Toast: 80
