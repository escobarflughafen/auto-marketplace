# Dark Mode Investigation

Date: 2026-06-22

## Current State

The Marketplace Monitor frontend is a plain HTML/CSS/JavaScript app:

- `frontend/marketplace-monitor/index.html`
- `frontend/marketplace-monitor/styles.css`
- `frontend/marketplace-monitor/app.js`
- `frontend/marketplace-monitor/listings-viewer.js`
- `frontend/marketplace-monitor/listing-components.js`

The app already has a theme mechanism:

- `:root` is the default visual theme.
- `:root[data-theme="classic"]` overrides the default variables.
- `localStorage["marketplace-monitor-theme"]` stores the selected theme.
- Settings renders a `Style` dropdown with `Parasols` and `Classic`.

The app also already forces the iOS/mobile status bar area to black:

- `<meta name="theme-color" content="#000000">`
- `<meta name="color-scheme" content="light">`
- `<meta name="apple-mobile-web-app-status-bar-style" content="black">`
- `html`, `body`, and `body::before` use black for the safe-area/status-bar background.
- `body::after` overlays the normal content background below the status-bar area.

This means dark mode should not be implemented as another status-bar patch. It should be a real third theme.

## Recommended Theme Model

Add `dark` as a first-class theme:

- `parasols`: current default.
- `classic`: current GitHub-like light theme.
- `dark`: new dark operational theme.

Use the existing CSS variable model, but expand it slightly so hard-coded white surfaces can be replaced cleanly.

Recommended new variables:

- `--surface`: normal raised content surfaces, replacing many `#fff` usages.
- `--surface-muted`: quiet sections, replacing many `var(--fill)` or pale backgrounds.
- `--surface-overlay`: dialogs, autocomplete, and popovers.
- `--field-bg`: input/select/textarea background.
- `--code-bg`: code, query, and syslog blocks.
- `--shadow-floating`: dark mode can keep this subtle, not bright.
- `--scrollbar-thumb`: custom scrollbar thumb.
- `--backdrop-bg`: modal/inspector backdrop.
- `--selection-bg`: text selection and active row selection.

Keep the existing variables:

- `--bg`
- `--panel`
- `--ink`
- `--muted`
- `--line`
- `--line-soft`
- `--fill`
- `--fill-strong`
- `--accent`
- `--accent-soft`
- `--accent-strong`
- `--warm`
- `--bad`
- `--good`
- button variables
- banner variables

## Palette Direction

The app is dense and operational, so dark mode should be restrained rather than decorative.

Suggested values:

```css
:root[data-theme="dark"] {
  color-scheme: dark;
  --bg: #0b0d10;
  --panel: #101318;
  --surface: #12161c;
  --surface-muted: #171c23;
  --surface-overlay: #151a21;
  --field-bg: #0f1319;
  --code-bg: #0b0f14;
  --ink: #eef2f7;
  --muted: #a7b0bd;
  --line: #354050;
  --line-soft: rgba(190, 202, 218, 0.18);
  --fill: #171c23;
  --fill-strong: #202733;
  --accent: #7aa2ff;
  --accent-soft: rgba(252, 204, 10, 0.18);
  --accent-strong: #fccc0a;
  --warm: #e0a72e;
  --bad: #ff6b63;
  --good: #45c779;
  --banner-bg: #000000;
  --banner-ink: #ffffff;
  --brand-bg: #ff6319;
  --button-bg: #eef2f7;
  --button-ink: #0b0d10;
  --button-hover-bg: #0b0d10;
  --button-hover-ink: #eef2f7;
  --secondary-bg: #12161c;
  --secondary-ink: #eef2f7;
  --secondary-line: #354050;
  --secondary-hover-bg: #202733;
  --secondary-hover-ink: #ffffff;
  --danger-hover-bg: #c83d36;
  --shadow-floating: 0 20px 70px rgba(0, 0, 0, 0.5);
  --scrollbar-thumb: #667386;
  --backdrop-bg: rgba(0, 0, 0, 0.62);
  --selection-bg: rgba(122, 162, 255, 0.35);
}
```

## Required JavaScript Changes

`normalizeTheme` currently discards anything except `classic`, so `dark` will not persist until this is changed.

Required changes:

- allow `dark` in `normalizeTheme`;
- add `Dark` to the Settings `Style` dropdown;
- update `<meta name="color-scheme">` when theme changes;
- optionally update `<meta name="theme-color">` when theme changes;
- keep startup behavior backward compatible when older localStorage values are present.

Recommended behavior:

- `parasols` and `classic`: `color-scheme: light`, theme color `#000000` because the mobile status bar/header remain black.
- `dark`: `color-scheme: dark`, theme color `#000000`.

## CSS Risk Areas

The root token model is solid, but hard-coded white surfaces need cleanup.

High-priority areas:

- query editor and autocomplete;
- query result modal and plots;
- query toolbar buttons;
- summary cards;
- subtabs and sticky tab bars;
- Tabulator tables and footers;
- worker setup, worker overview, and worker detail inspector;
- history/recommendation dialogs;
- code/syslog/snapshot blocks;
- forms, selects, checkboxes, and textareas.

Examples of current hard-coded light surfaces:

- `.query-input-shell`, `.query-editor`, `.query-highlight`;
- `.query-autocomplete`, `.query-suggestion`;
- `input, button, select, textarea`;
- `.query-tool-group`, `.query-tool-button`, `.query-row-control`;
- `.summary .card`;
- `.tablewrap`, `.tabulator`, `.tabulator-footer` controls;
- `.worker-control`, `.settings-content`, `.worker-control-tablewrap`;
- `.worker-detail-tablewrap`, `.worker-detail-section-cell`, `.worker-panel`;
- `.snapshot-text`, `.snapshot-text pre`.

These should be changed to variables or overridden in one `:root[data-theme="dark"]` block.

## Tabulator Notes

Tabulator is the most important dark-mode risk because it injects its own structure and the app overrides it manually.

The current app styles:

- table background;
- header background;
- row even background;
- frozen cell background;
- hover background and bottom bar;
- footer paginator buttons and page-size select.

Dark mode should explicitly set:

- `.tabulator`
- `.tabulator-row`
- `.tabulator-row .tabulator-cell`
- `.tabulator-row.tabulator-row-even`
- `.tabulator .tabulator-header`
- `.tabulator .tabulator-header .tabulator-col`
- `.tabulator .tabulator-footer`
- `.tabulator .tabulator-footer .tabulator-page`
- `.tabulator .tabulator-footer .tabulator-page-size`
- selected and hovered row states.

## Modal Notes

Dialogs already use `var(--panel)`, `var(--ink)`, and `var(--line)` in the main modal shell, but modal body content often contains nested white tablewraps or code blocks. Dark mode needs nested content coverage, not only dialog background coverage.

Critical modal paths:

- listing detail modal;
- recommendation detail/action modal;
- audit log modal;
- query result detail modal;
- worker inspector overlay.

The modal z-index model is already good:

- `--modal-layer: 5000`
- `--modal-backdrop-layer: 4990`

No z-index redesign is needed for dark mode.

## Query Highlighting Notes

The query editor uses transparent textarea text over a highlighted `<pre>`. Dark mode must update token colors because some current token colors are tuned for a white background:

- keyword purple;
- source blue;
- field dark gray;
- string green;
- number brown;
- operator purple.

Add dark overrides for `.query-token-*`, otherwise syntax highlighting will be low contrast.

## Print Format

Do not make print format dark by default.

The trade history print view generates its own CSS string in `app.js`. It currently reads theme tokens, but print output should remain light unless a separate explicit "dark print" option is requested. Dark app mode should not consume toner or produce hard-to-read paper exports.

## Implementation Plan

1. Add `dark` to theme normalization and Settings.
2. Add the dark token block and metadata updates.
3. Replace obvious `#fff` surfaces with `--surface`, `--surface-overlay`, `--field-bg`, and `--code-bg`.
4. Add explicit dark overrides for Tabulator and query syntax tokens.
5. Test the main flows with screenshots:
   - Listings table and detail modal.
   - Query editor autocomplete and query result modal.
   - Trade & Match table, recommendation modal, and match mode.
   - Audit log table and syslog modal.
   - Worker overview and worker detail inspector with live screenshot.
   - Settings page.
   - Mobile Safari-sized viewport for safe-area/header behavior.

## Suggested MVP Scope

The smallest useful dark-mode MVP is:

- add `dark` as a selectable Settings theme;
- update global tokens and form controls;
- make query/editor/autocomplete usable;
- make Tabulator tables readable;
- make modals readable;
- keep print view light.

Do not change layout or component behavior as part of dark mode. This should be a visual layer only.
