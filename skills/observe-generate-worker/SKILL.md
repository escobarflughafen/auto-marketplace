---
name: observe-generate-worker
description: Use when a user wants an agent to learn an external website or app workflow from recorded Playwright/web-observer evidence, extract stable DOM/URL/network behavior, and design or implement a remote worker adapter that reports typed events to the central host.
---

# Observe And Generate Worker

Use this skill to turn observed browser behavior into a worker design or worker
implementation. The trace is evidence, not a replay script.

## Inputs

Prefer these artifacts:

- `artifacts/web-observations/<session-id>/summary.md`
- `actions.jsonl`
- selected `observations.jsonl`
- selected screenshots
- `network.jsonl` when URL/API state matters
- existing worker/event docs

If the observation is missing, run a short focused session with:

```bash
npm run web:observe -- \
  --url "<target-url>" \
  --session-name "<short-task-name>" \
  --screenshot-format jpeg \
  --screenshot-quality 70
```

## Workflow

1. Label the session in `summary.md`.
2. Sanitize sensitive screenshots, URLs, and form values before broad sharing.
3. Extract the page model:
   - stable URL patterns and query parameters;
   - durable accessible roles/names;
   - DOM states before and after each action;
   - network requests that represent state changes;
   - login, challenge, error, empty-result, and rate-limit states.
4. Convert observations into a worker task model:
   - `workerType`;
   - `strategy`;
   - supported `taskType`;
   - `TaskEnvelope.payload` schema;
   - emitted `RemoteEventEnvelope.eventType` values;
   - artifact roles and transfer policy.
5. Keep the two-layer boundary:
   - shared runtime handles auth, session, heartbeat, local queue, outbox,
     artifact spool, ACK, backpressure, and health;
   - adapter handles only domain/browser behavior.
6. Do not let host input become raw SQL, shell, JavaScript, or arbitrary local
   DB writes. Host input must be typed task/config/command data.
7. Add tests before implementation:
   - URL builder/parser tests;
   - task envelope validation tests;
   - event payload validation tests;
   - artifact manifest tests;
   - adapter unit tests with mocked pages or recorded DOM samples.
8. Implement conservatively:
   - prefer URL/API state over replaying clicks;
   - prefer accessible role/name or durable attributes over brittle CSS paths;
   - emit explicit events for blocked/challenge/error states;
   - store multimedia as artifact manifests, not inline event payloads.
9. Verify with a short observation or dry-run worker execution.

## Required Architecture References

Read these only as needed:

- `docs/web-interaction-observer.md`
- `docs/meta-observer-development-workflow.md`
- `docs/remote-worker-general-prototype.md`
- `docs/remote-worker-host-api-v2-design.md`
- `docs/remote-worker-installable-runtime-design.md`
- `docs/remote-worker-implementation-design.md`

## Output Contract

For design-only work, produce:

- observed evidence summary;
- worker task contract;
- event contract;
- artifact policy;
- failure/health states;
- test plan;
- implementation files to touch.

For implementation work, produce:

- adapter code;
- typed contract validation;
- tests;
- short verification result;
- notes on unsupported observed behavior.

