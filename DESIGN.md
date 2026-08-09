# Design System

## Theme

Light, editorial product interface built from the tokens in `variables.css`.

## Color

- Canvas: `--color-paper-white`
- Secondary surface: `--color-fog-white`
- Card surface: `--color-mist-gray`
- Primary text: `--color-ink-black`
- Muted text: `--color-slate-gray`
- Accent surface: `--color-blush-peach`
- Accent ink: `--color-sienna-brown`

## Typography

Use `--font-sohne` for interface text and `--font-signifier` for the product title and project titles. System fallbacks remain mandatory because the proprietary faces may not be installed.

## Shape

Use 12–16px radii for cards and panels, pill radii for filters, and square-edged code surfaces. Prefer borders or compact shadows, not both as decoration.

## Layout

Constrain primary content to `--page-max-width`. Use a responsive auto-fit gallery, a sticky toolbar, and a full-screen modal on small screens.

## Motion

Use 150–220ms state transitions. Respect `prefers-reduced-motion` and avoid decorative entrance sequences.
