# Ticket: Normalize Button Padding And Action Spacing

## Summary

The Workers UI generally looks good, but several button/action areas use inconsistent padding and gap rules. This creates places where adjacent controls visually touch or feel cramped, especially inside tables and compact toolbars.

This should be fixed with a small shared layout layer for action containers instead of one-off margin and padding overrides.

## Scope

Focus on button and action-control spacing in the marketplace monitor UI.

Primary files:

- `frontend/marketplace-monitor/styles.css`
- `frontend/marketplace-monitor/app.js`

## Observed Issues

### 1. Worker profile controls have no vertical gap between action rows

On the Workers page, the saved-profile select/input row and the save/load/delete button row are adjacent with `0px` vertical separation.

Observed DOM shape:

- `app.js` renders two sibling `.worker-control-actions` containers at `frontend/marketplace-monitor/app.js:3534` and `frontend/marketplace-monitor/app.js:3538`.
- `.worker-control-actions` defines only internal wrapping gap at `frontend/marketplace-monitor/styles.css:2133`.

Current CSS:

```css
.worker-control-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
```

Problem: `gap` applies only between children inside each row. It does not create spacing between two sibling action containers.

### 2. Worker table row actions are too tight

The `View`, `Restart`, and conditional `End` buttons in worker table rows use a `2px` container gap.

Source:

- Markup is generated in `frontend/marketplace-monitor/app.js:3925`.
- CSS is in `frontend/marketplace-monitor/styles.css:2932`.

Current CSS:

```css
.row-actions {
  display: flex;
  gap: 2px;
  flex-wrap: nowrap;
  align-items: center;
}
```

Problem: the controls are readable, but the hit areas feel crowded and visually inconsistent with other action rows.

### 3. Worker process select buttons have no horizontal padding

Process label buttons in the worker table are styled as buttons but have `padding: 4px 0`.

Source:

- Markup is generated in `frontend/marketplace-monitor/app.js:3915`.
- CSS is in `frontend/marketplace-monitor/styles.css:2745`.

Current CSS:

```css
.worker-table .process-select-button {
  padding: 4px 0;
}
```

Problem: because these are interactive controls, zero horizontal padding makes the hit area and visual affordance inconsistent with neighboring buttons.

### 4. Some toolbar groups intentionally use `gap: 0`, but the pattern is not explicit

The query toolbar and summary rows use `gap: 0` and border separators.

Sources:

- `.query-toolbar` at `frontend/marketplace-monitor/styles.css:712`
- `.query-tool-group` at `frontend/marketplace-monitor/styles.css:724`
- `.summary` at `frontend/marketplace-monitor/styles.css:842`

This can be valid for segmented controls or dense table-like summary strips, but it should be intentional and separated from normal action-button spacing rules.

## Recommended Fix

Introduce small local layout primitives in `styles.css` and apply them consistently:

```css
:root {
  --space-1: 4px;
  --space-2: 6px;
  --space-3: 8px;
  --control-padding-y: 6px;
  --control-padding-x: 8px;
}

:where(.action-row) {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}

:where(.action-stack) {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

:where(.compact-action-row) {
  display: flex;
  align-items: center;
  gap: var(--space-1);
}

:where(.segmented-control) {
  display: inline-flex;
  gap: 0;
}
```

Then migrate the current ad hoc containers:

- Use `action-stack` around sibling rows such as the worker profile controls.
- Use `action-row` for normal button groups.
- Use `compact-action-row` only where table density is important.
- Use `segmented-control` only for intentionally connected controls.

Avoid fixing this by adding Bootstrap. The project currently has only Tabulator as an external UI dependency, and this issue is small enough to solve cleanly with local CSS. Bootstrap would add a larger design system, more override surface, and another source of spacing rules.

## Acceptance Criteria

- Worker profile select/input row and save/load/delete row have a visible vertical gap.
- Worker row actions have a minimum practical gap of `4px` or `6px`, not `2px`, unless explicitly classified as compact.
- Process select buttons keep a clear click target with horizontal padding.
- Segmented controls that intentionally use `gap: 0` are named or scoped as segmented controls.
- No broad CSS reset or global button rule changes are introduced.
- Layout still works at desktop and narrow widths without button text overlap.
- Existing custom visual style remains intact.

## Suggested Verification

1. Open the Workers page.
2. Check the profile controls in the Command section.
3. Check the worker process table action buttons.
4. Check long worker names and narrow viewport widths.
5. Confirm intentionally segmented toolbars still look connected.
