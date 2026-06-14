# Meta-Observer Development Workflow

This workflow describes how to use recorded web interaction sessions to improve the server app and future worker types.

The observer is not a production worker. It is a development process for understanding external web pages from the perspective of browser fundamentals: URL state, DOM, accessibility tree, visible text, network behavior, console errors, screenshots, and user actions.

## Goal

Use a real observed session to turn uncertain browser behavior into implementation evidence.

The loop is:

```text
record session -> extract model -> update app/worker -> verify -> preserve findings
```

This helps avoid brittle automation based only on guessed selectors or screenshots.

## When To Use

Use this workflow when:

- an external page has changed layout or interaction behavior;
- a worker needs a new flow;
- a UI control appears to map to URL/API state;
- the app needs new worker setup parameters;
- a human can demonstrate the intended behavior faster than reading minified DOM;
- an LLM agent needs evidence before implementing worker logic.

Do not use this as a blind replay mechanism. Recorded actions are evidence, not production automation.

## Step 1: Record

Start a headed observer session:

```bash
npm run web:observe -- \
  --url "https://www.facebook.com/marketplace/" \
  --session-name "fb-marketplace-search-study" \
  --user-data-dir profiles/facebook-marketplace-observer \
  --screenshot-format jpeg \
  --screenshot-quality 70
```

Interact with the page naturally. Keep the session focused:

- one goal per recording;
- avoid unrelated account/settings flows;
- stop as soon as the target behavior is demonstrated;
- prefer short recordings over broad recordings.

Stop the session by pressing Enter in the terminal.

## Step 2: Label

Add a human-readable label to `summary.md` and `trace.json`.

The label should name the task and why it matters:

```text
Reading camera listings, setting query parameters, and discovering the rental market with parameters set
```

Good labels make artifacts searchable and help future agents decide whether a trace is relevant.

## Step 3: Sanitize

Review artifacts before using them broadly.

Check for:

- login/recovery/checkpoint URLs;
- email/phone/code/password values;
- screenshots that include authentication UI;
- account-specific notification/profile content;
- URL params that should be redacted.

The observer has conservative redaction, but screenshots are still visual evidence and may contain sensitive UI. Treat recorded artifacts as trusted-local unless explicitly reviewed.

## Step 4: Extract The Model

Look for durable state transitions, not every low-level click.

Useful commands:

```bash
node - <<'NODE'
const fs = require('fs');
const path = 'artifacts/web-observations/<session-id>/observations.jsonl';
const seen = new Set();
for (const line of fs.readFileSync(path, 'utf8').trim().split('\n')) {
  const row = JSON.parse(line);
  if (!row.url || seen.has(row.url)) continue;
  seen.add(row.url);
  console.log(`${row.sequence}\t${row.kind}\t${row.url}`);
}
NODE
```

Correlate navigations with preceding actions:

```bash
node - <<'NODE'
const fs = require('fs');
const rows = fs.readFileSync('artifacts/web-observations/<session-id>/actions.jsonl', 'utf8')
  .trim()
  .split('\n')
  .map(JSON.parse);
for (let i = 0; i < rows.length; i += 1) {
  const row = rows[i];
  if (row.eventType !== 'navigation') continue;
  const prev = rows.slice(Math.max(0, i - 4), i)
    .filter((item) => ['click', 'change', 'input', 'keydown'].includes(item.eventType))
    .slice(-2);
  console.log('\nNAV', row.sequence, row.url);
  for (const item of prev) {
    console.log('  prev', item.sequence, item.eventType, item.key || '', item.target?.text || item.target?.ariaLabel || item.target?.placeholder || '');
  }
}
NODE
```

Extract:

- URL path patterns;
- query parameters;
- category path conventions;
- stable accessible names;
- required waits/states after actions;
- error/login/checkpoint states;
- network requests that represent durable app state.

## Step 5: Convert Findings To Design

Write a findings document before coding. The doc should include:

- artifact folder;
- session label;
- observed URL/API/DOM patterns;
- worker implications;
- risks and caveats;
- proposed implementation surface;
- verification plan.

For the Marketplace URL-param study, see:

```text
docs/facebook-marketplace-url-param-findings.md
```

## Step 6: Implement Conservatively

Prefer durable mechanisms found in the trace.

Examples:

- If filters map cleanly to URL params, implement a URL builder instead of replaying every filter click.
- If a DOM selector is unstable but accessible role/name is stable, use role/name where possible.
- If a page shows multiple transient URLs, wait for the final stable state before collecting.
- If a flow can hit auth/checkpoint pages, emit explicit worker events for those states.

Workers should still verify after direct navigation:

- expected URL path;
- expected query/category/filter state;
- result list visibility;
- login/checkpoint detection;
- no obvious error page;
- final URL and page title captured in events.

## Step 7: Test

Add focused tests around the extracted model.

Examples:

- URL builder input/output tests;
- parser tests for observed params;
- route inference tests for area/category paths;
- worker argument validation tests;
- redaction tests for observer artifacts.

Avoid tests that depend on live external page availability unless intentionally marked as manual/integration.

## Step 8: Verify With A Short Replay Observation

After implementation, run another short observer or worker dry run:

```bash
npm run web:observe -- \
  --url "<constructed-url>" \
  --session-name "verify-url-builder-output" \
  --user-data-dir profiles/facebook-marketplace-observer \
  --max-runtime-seconds 45
```

Confirm the generated URL leads to the same page state the user demonstrated.

## Output Contract For LLM Agents

When asking an LLM agent to implement from a recording, provide:

```text
summary.md
actions.jsonl
selected observations.jsonl entries
selected screenshots
findings doc
target module/files
test command
deployment rule
```

The agent should cite the observed evidence in the design summary and avoid inventing unsupported behavior.

## Quality Bar

A successful meta-observer cycle should produce:

- a small, labeled artifact folder;
- a findings document;
- a narrow code change;
- focused tests;
- clear caveats;
- no production worker disruption unless deployment requires an app restart.
