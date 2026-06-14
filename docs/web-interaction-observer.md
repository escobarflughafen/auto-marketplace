# Web Interaction Observer

The web interaction observer is a meta development tool. It studies a live web page from the perspective of DOM, accessibility, network, console, and user interaction fundamentals so an LLM/dev agent can update the server app or design a future worker type with evidence.

It is not a production marketplace worker and should not be counted against worker concurrency limits.

## Run

```bash
npm run web:observe -- \
  --url "http://127.0.0.1:21435/?token=..." \
  --session-name "worker-config-review"
```

Useful options:

```bash
--user-data-dir profiles/facebook-marketplace
--headless
--max-runtime-seconds 60
--screenshot-format jpeg
--screenshot-quality 70
--redact conservative
--no-screenshots
```

Headed sessions stop when Enter is pressed in the terminal. Headless/non-interactive sessions should usually use `--max-runtime-seconds`.

## Artifacts

Each session writes to:

```text
artifacts/web-observations/<session-id>/
  actions.jsonl
  observations.jsonl
  console.jsonl
  network.jsonl
  trace.json
  summary.md
  screenshots/
```

`actions.jsonl` records passive browser events such as clicks, inputs, changes, submits, key navigation, and page navigations.

`observations.jsonl` records the page after each action: URL, title, visible DOM summary, accessibility snapshot when available, and screenshot path.

`console.jsonl` records console messages and page errors.

`network.jsonl` records failed requests, HTTP errors, and document/fetch/XHR responses.

## Redaction

The default `--redact conservative` mode redacts obvious secret-bearing URL parameters and sensitive form values such as password, token, credential, email, phone, 2FA, OTP, and code fields.

Review artifacts before sharing them outside the trusted development environment.

## Intended Use

Use `summary.md`, `actions.jsonl`, and selected `observations.jsonl` entries as evidence for an LLM agent to:

- infer stable selectors and accessible roles;
- understand intended user flow;
- identify DOM states after each user action;
- capture app API/network side effects;
- propose worker event schemas;
- update server UI or worker setup logic.

Do not treat the trace as a production replay script without review. Convert the trace into a deliberate worker implementation with explicit waits, selectors, redaction, and failure handling.
