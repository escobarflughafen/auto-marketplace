# Marketplace UX Performance Monitor

Use the synthetic UX monitor to measure the marketplace dashboard the way an
operator experiences it in a browser. It runs Chromium with Playwright, drives
the main UI flows, records user-visible readiness timings, and also captures API
latencies observed by the browser.

## Command

```bash
npm run marketplace:ux:monitor -- \
  --url "http://10.10.20.3:21435/?token=ADMIN_TOKEN" \
  --iterations 3 \
  --output output/perf/prod-ux-monitor.json
```

The URL may point to prod, staging, localhost, or another deployed monitor. If
the URL does not include `token`, pass `--token` or set
`MARKETPLACE_MONITOR_TOKEN`.

## Measured Flows

- app shell DOMContentLoaded;
- app shell ready for interaction;
- listings table ready;
- query submit to listings table update;
- Trade History tab ready;
- Workers panel ready;
- selected or first worker detail inspector ready.

The worker detail step is intentionally included because it is one of the main
operator pain points. Disable it for lightweight checks:

```bash
npm run marketplace:ux:monitor -- \
  --url "http://10.10.20.3:21435/?token=ADMIN_TOKEN" \
  --skip-worker-detail
```

## Useful Options

```bash
--listings-query "listings | take 25"
--history-query 'history | where status == "sold" | sort by profit desc'
--worker-id search-explore-...
--timeout-ms 60000
--viewport 390x844
--json
```

Use a mobile viewport when checking mobile Safari-like layout pressure:

```bash
npm run marketplace:ux:monitor -- \
  --url "http://10.10.20.3:21435/?token=ADMIN_TOKEN" \
  --viewport 390x844
```

## Reading The Output

The human report shows:

- p50/p95/max timing per user flow;
- slowest API calls observed by the browser;
- browser console warnings/errors;
- failed API requests;
- long tasks and cumulative layout shift when available.

The JSON output includes per-iteration detail and is suitable for saving as a
baseline or comparing staging vs production.

## Operational Use

Run this before and after changes that touch:

- query/listings rendering;
- worker monitor/detail loading;
- polling behavior;
- database queries or indexes;
- deployment/runtime sizing.

This monitor complements backend `request_timing` logs. Backend logs show which
API endpoint is slow; this monitor shows whether the UI felt slow to a user.
