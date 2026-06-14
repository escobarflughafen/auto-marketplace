const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { chromium } = require('playwright');
const {
  buildChromiumLaunchOptions,
  ensureDir,
  slugify,
} = require('./marketplace-utils');

const DEFAULT_OUTPUT_ROOT = path.join(process.cwd(), 'artifacts', 'web-observations');
const DEFAULT_VIEWPORT = { width: 1440, height: 1100 };
const SENSITIVE_PARAM_PATTERN = /^(?:token|api[_-]?token|password|pass|secret|credential|session|cookie|auth|key|email|em(?:\[\d+\])?|cuid|hash|code|u|n|a|next|lsrc|spc|sih|ssb|msgr|rm)$/i;
const SENSITIVE_FIELD_PATTERN = /(?:password|pass|secret|token|credential|email|phone|2fa|otp|code)/i;
const SENSITIVE_URL_PATTERN = /\/(?:login|recover|password|checkpoint)\b/i;

function usage() {
  return `Usage:
  node scripts/observe-web-interaction.js --url <url> [options]

Options:
  --session-name <name>          Human readable session name.
  --output-root <path>           Artifact root. Default: artifacts/web-observations
  --user-data-dir <path>         Use a persistent Chromium profile.
  --headed                      Run headed. Default.
  --headless                    Run headless.
  --max-runtime-seconds <n>      Stop automatically after n seconds.
  --poll-ms <n>                 DOM event polling interval. Default: 500.
  --screenshot-format <png|jpeg> Default: png.
  --screenshot-quality <1-100>   JPEG quality. Default: 80.
  --redact <conservative|off>    Redaction mode. Default: conservative.
  --no-screenshots              Disable per-observation screenshots.
  --help                        Show this help.

Interactive headed sessions stop when Enter is pressed in the terminal.`;
}

function readFlagValue(argv, index, flagName) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for ${flagName}`);
  }
  return value;
}

function parseIntegerFlag(value, flagName, minimum = 0) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < minimum) {
    throw new Error(`Expected ${flagName} to be an integer >= ${minimum}`);
  }
  return parsed;
}

function parseArgs(argv) {
  const options = {
    url: '',
    sessionName: '',
    outputRoot: DEFAULT_OUTPUT_ROOT,
    userDataDir: '',
    headless: false,
    maxRuntimeSeconds: 0,
    pollMs: 500,
    screenshotFormat: 'png',
    screenshotQuality: 80,
    redact: 'conservative',
    screenshots: true,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--url':
        options.url = readFlagValue(argv, index, arg);
        index += 1;
        break;
      case '--session-name':
        options.sessionName = readFlagValue(argv, index, arg);
        index += 1;
        break;
      case '--output-root':
        options.outputRoot = readFlagValue(argv, index, arg);
        index += 1;
        break;
      case '--user-data-dir':
        options.userDataDir = readFlagValue(argv, index, arg);
        index += 1;
        break;
      case '--headed':
        options.headless = false;
        break;
      case '--headless':
        options.headless = true;
        break;
      case '--max-runtime-seconds':
        options.maxRuntimeSeconds = parseIntegerFlag(readFlagValue(argv, index, arg), arg, 1);
        index += 1;
        break;
      case '--poll-ms':
        options.pollMs = parseIntegerFlag(readFlagValue(argv, index, arg), arg, 100);
        index += 1;
        break;
      case '--screenshot-format':
        options.screenshotFormat = readFlagValue(argv, index, arg).toLowerCase();
        index += 1;
        break;
      case '--screenshot-quality':
        options.screenshotQuality = parseIntegerFlag(readFlagValue(argv, index, arg), arg, 1);
        index += 1;
        break;
      case '--redact':
        options.redact = readFlagValue(argv, index, arg).toLowerCase();
        index += 1;
        break;
      case '--no-screenshots':
        options.screenshots = false;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (options.help) return options;
  if (!options.url) throw new Error('Missing required --url');
  if (!['png', 'jpeg'].includes(options.screenshotFormat)) {
    throw new Error('--screenshot-format must be png or jpeg');
  }
  if (!['conservative', 'off'].includes(options.redact)) {
    throw new Error('--redact must be conservative or off');
  }
  options.screenshotQuality = Math.min(100, Math.max(1, options.screenshotQuality));
  return options;
}

function resolvePath(value) {
  return path.isAbsolute(value) ? value : path.join(process.cwd(), value);
}

function isoNow() {
  return new Date().toISOString();
}

function clipText(value, maxLength = 5000) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function redactUrl(value, mode = 'conservative') {
  const text = String(value || '');
  if (mode === 'off') return text;
  try {
    const url = new URL(text);
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_URL_PATTERN.test(url.pathname) || SENSITIVE_PARAM_PATTERN.test(key)) {
        url.searchParams.set(key, '[REDACTED]');
      }
    }
    return url.toString();
  } catch (_error) {
    return text.replace(/([?&][^=]*(?:token|password|secret|credential|session|auth|key)[^=]*=)[^&\s]+/gi, '$1[REDACTED]');
  }
}

function redactPayload(value, mode = 'conservative') {
  if (mode === 'off') return value;
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((item) => redactPayload(item, mode));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      SENSITIVE_FIELD_PATTERN.test(key) ? '[REDACTED]' : redactPayload(item, mode),
    ]));
  }
  if (typeof value === 'string' && value.length > 200) return `${value.slice(0, 200)}...`;
  return value;
}

function isSensitivePageUrl(value) {
  try {
    return SENSITIVE_URL_PATTERN.test(new URL(String(value || '')).pathname);
  } catch (_error) {
    return SENSITIVE_URL_PATTERN.test(String(value || ''));
  }
}

function createJsonlWriter(filePath) {
  const stream = fs.createWriteStream(filePath, { flags: 'a' });
  return {
    path: filePath,
    write(record) {
      stream.write(`${JSON.stringify(record)}\n`);
    },
    close() {
      return new Promise((resolve, reject) => {
        stream.end((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function waitForEnterOrTimeout(options) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (reason) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (rl) rl.close();
      resolve(reason);
    };
    const timer = options.maxRuntimeSeconds > 0
      ? setTimeout(() => finish('max_runtime'), options.maxRuntimeSeconds * 1000)
      : null;
    let rl = null;
    if (process.stdin.isTTY && !options.headless) {
      rl = readline.createInterface({ input: process.stdin, output: process.stderr });
      rl.question('Observer is recording. Press Enter to stop.\n', () => finish('user_enter'));
    } else if (!timer) {
      process.stderr.write('Observer is recording. Press Ctrl+C to stop.\n');
    }
    process.once('SIGINT', () => finish('sigint'));
    process.once('SIGTERM', () => finish('sigterm'));
  });
}

async function safeAriaSnapshot(page) {
  try {
    const body = page.locator('body');
    if (typeof body.ariaSnapshot === 'function') {
      return await body.ariaSnapshot({ timeout: 1500 });
    }
  } catch (error) {
    return { error: error.message || String(error) };
  }
  return null;
}

async function collectDomSummary(page) {
  return await page.evaluate(() => {
    const clean = (value, max = 140) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
    const visibleText = clean(document.body?.innerText || '', 5000);
    const summarizeElement = (element) => ({
      tag: element.tagName.toLowerCase(),
      text: clean(element.innerText || element.textContent || ''),
      type: clean(element.getAttribute('type') || ''),
      role: clean(element.getAttribute('role') || ''),
      name: clean(element.getAttribute('name') || ''),
      id: clean(element.id || ''),
      ariaLabel: clean(element.getAttribute('aria-label') || ''),
      placeholder: clean(element.getAttribute('placeholder') || ''),
      href: clean(element.getAttribute('href') || '', 220),
    });
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const pick = (selector, limit = 40) => [...document.querySelectorAll(selector)]
      .filter(visible)
      .slice(0, limit)
      .map(summarizeElement);
    return {
      visibleText,
      counts: {
        forms: document.forms.length,
        buttons: document.querySelectorAll('button,[role="button"]').length,
        inputs: document.querySelectorAll('input,textarea,select').length,
        links: document.links.length,
        dialogs: document.querySelectorAll('dialog,[role="dialog"]').length,
      },
      headings: pick('h1,h2,h3,[role="heading"]', 30),
      buttons: pick('button,[role="button"]', 40),
      inputs: pick('input,textarea,select', 40),
      links: pick('a[href]', 30),
    };
  });
}

async function writeScreenshot(page, sessionDir, sequence, format, quality) {
  const screenshotsDir = path.join(sessionDir, 'screenshots');
  await ensureDir(screenshotsDir);
  const extension = format === 'jpeg' ? 'jpg' : 'png';
  const filename = `step-${String(sequence).padStart(4, '0')}.${extension}`;
  const screenshotPath = path.join(screenshotsDir, filename);
  const options = { path: screenshotPath, fullPage: true, type: format };
  if (format === 'jpeg') options.quality = quality;
  await page.screenshot(options);
  return path.relative(sessionDir, screenshotPath);
}

async function collectObservation(page, options, context) {
  const record = {
    sequence: context.observationSequence,
    actionSequence: context.actionSequence || null,
    kind: context.kind,
    capturedAt: isoNow(),
    url: redactUrl(page.url(), options.redact),
    title: await page.title().catch(() => ''),
    viewport: page.viewportSize(),
    dom: await collectDomSummary(page).catch((error) => ({ error: error.message || String(error) })),
    accessibility: await safeAriaSnapshot(page),
  };
  if (options.screenshots) {
    record.screenshot = await writeScreenshot(
      page,
      context.sessionDir,
      context.observationSequence,
      options.screenshotFormat,
      options.screenshotQuality,
    ).catch((error) => ({ error: error.message || String(error) }));
  }
  return record;
}

function observerInitScript() {
  if (window.__webInteractionObserverInstalled) return;
  window.__webInteractionObserverInstalled = true;
  window.__webInteractionObserverEvents = [];

  const clean = (value, max = 180) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
  const cssPath = (element) => {
    if (!element || !element.tagName) return '';
    const parts = [];
    let node = element;
    while (node && node.nodeType === Node.ELEMENT_NODE && parts.length < 6) {
      const tag = node.tagName.toLowerCase();
      if (node.id) {
        parts.unshift(`${tag}#${CSS.escape(node.id)}`);
        break;
      }
      const className = [...node.classList].slice(0, 2).map((item) => `.${CSS.escape(item)}`).join('');
      const parent = node.parentElement;
      const siblings = parent ? [...parent.children].filter((item) => item.tagName === node.tagName) : [];
      const nth = siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(node) + 1})` : '';
      parts.unshift(`${tag}${className}${nth}`);
      node = parent;
    }
    return parts.join(' > ');
  };
  const targetInfo = (target) => {
    const element = target?.closest?.('button,a,input,textarea,select,[role],label,[contenteditable="true"]') || target;
    if (!element || !element.tagName) return {};
    const fieldValue = 'value' in element ? element.value : '';
    const isSensitivePage = /\/(?:login|recover|password|checkpoint)\b/i.test(location.pathname);
    const isSensitive = isSensitivePage || /password|pass|secret|token|credential|email|phone|2fa|otp|code/i.test([
      element.getAttribute('type') || '',
      element.getAttribute('name') || '',
      element.id || '',
      element.getAttribute('autocomplete') || '',
      element.getAttribute('aria-label') || '',
      element.getAttribute('placeholder') || '',
    ].join(' '));
    return {
      tag: element.tagName.toLowerCase(),
      selector: cssPath(element),
      id: clean(element.id || ''),
      role: clean(element.getAttribute('role') || ''),
      type: clean(element.getAttribute('type') || ''),
      name: clean(element.getAttribute('name') || ''),
      ariaLabel: clean(element.getAttribute('aria-label') || ''),
      placeholder: clean(element.getAttribute('placeholder') || ''),
      text: clean(element.innerText || element.textContent || ''),
      href: clean(element.getAttribute('href') || '', 260),
      value: fieldValue ? (isSensitive ? '[REDACTED]' : clean(fieldValue, 260)) : '',
      valueLength: fieldValue ? String(fieldValue).length : 0,
      sensitiveValue: Boolean(fieldValue && isSensitive),
    };
  };
  const push = (event, extra = {}) => {
    window.__webInteractionObserverEvents.push({
      observedAt: new Date().toISOString(),
      eventType: event.type,
      url: location.href,
      target: targetInfo(event.target),
      pointer: 'clientX' in event ? { x: event.clientX, y: event.clientY } : null,
      key: event.type === 'keydown' ? event.key : '',
      modifier: event.type === 'keydown' ? {
        alt: event.altKey,
        ctrl: event.ctrlKey,
        meta: event.metaKey,
        shift: event.shiftKey,
      } : null,
      ...extra,
    });
  };
  document.addEventListener('click', (event) => push(event), true);
  document.addEventListener('change', (event) => push(event), true);
  document.addEventListener('submit', (event) => push(event), true);
  document.addEventListener('input', (event) => {
    const target = event.target;
    const value = 'value' in target ? String(target.value || '') : '';
    push(event, { inputLength: value.length });
  }, true);
  document.addEventListener('keydown', (event) => {
    if (
      event.key.length > 1
      || event.metaKey
      || event.ctrlKey
      || event.altKey
      || ['Enter', 'Tab', 'Escape'].includes(event.key)
    ) {
      push(event);
    }
  }, true);
  window.__webInteractionObserverTakeEvents = () => {
    const events = window.__webInteractionObserverEvents.slice();
    window.__webInteractionObserverEvents.length = 0;
    return events;
  };
}

async function drainPageEvents(page) {
  return await page.evaluate(() => {
    if (typeof window.__webInteractionObserverTakeEvents !== 'function') return [];
    return window.__webInteractionObserverTakeEvents();
  }).catch(() => []);
}

function buildSummaryMarkdown(summary, files) {
  const lines = [
    `# Web Interaction Observation: ${summary.sessionName}`,
    '',
    `- Session ID: \`${summary.sessionId}\``,
    `- Started: ${summary.startedAt}`,
    `- Finished: ${summary.finishedAt}`,
    `- Stop reason: ${summary.stopReason}`,
    `- Start URL: ${summary.startUrl}`,
    `- Final URL: ${summary.finalUrl}`,
    `- Actions captured: ${summary.actionCount}`,
    `- Observations captured: ${summary.observationCount}`,
    `- Console records: ${summary.consoleCount}`,
    `- Network records: ${summary.networkCount}`,
    '',
    '## Artifact Files',
    '',
    `- Actions: \`${files.actions}\``,
    `- Observations: \`${files.observations}\``,
    `- Console: \`${files.console}\``,
    `- Network: \`${files.network}\``,
    `- Trace index: \`${files.trace}\``,
    '',
    '## How To Use',
    '',
    'Give `summary.md`, `actions.jsonl`, and the relevant `observations.jsonl` entries to an LLM agent when designing or updating a worker. Treat the trace as evidence about webpage structure and interaction flow, not as a production replay script.',
    '',
    'Review redaction before sharing artifacts outside the trusted development environment.',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

async function runObserver(options) {
  const startedAt = isoNow();
  const sessionBase = options.sessionName || new URL(options.url).hostname || 'web-session';
  const sessionId = `${slugify(sessionBase) || 'web-session'}-${startedAt.replace(/[:.]/g, '-')}`;
  const sessionDir = path.join(resolvePath(options.outputRoot), sessionId);
  await ensureDir(sessionDir);
  await ensureDir(path.join(sessionDir, 'screenshots'));

  const actionsWriter = createJsonlWriter(path.join(sessionDir, 'actions.jsonl'));
  const observationsWriter = createJsonlWriter(path.join(sessionDir, 'observations.jsonl'));
  const consoleWriter = createJsonlWriter(path.join(sessionDir, 'console.jsonl'));
  const networkWriter = createJsonlWriter(path.join(sessionDir, 'network.jsonl'));

  const launchOptions = buildChromiumLaunchOptions({
    headless: options.headless,
  });
  let browser = null;
  let context;
  if (options.userDataDir) {
    await ensureDir(resolvePath(options.userDataDir));
    context = await chromium.launchPersistentContext(resolvePath(options.userDataDir), {
      ...launchOptions,
      viewport: DEFAULT_VIEWPORT,
    });
  } else {
    browser = await chromium.launch(launchOptions);
    context = await browser.newContext({ viewport: DEFAULT_VIEWPORT });
  }

  const stats = {
    actionCount: 0,
    observationCount: 0,
    consoleCount: 0,
    networkCount: 0,
  };
  let page = context.pages()[0] || await context.newPage();
  let observationSequence = 0;
  let actionSequence = 0;
  let stopPolling = false;

  const bindPage = async (nextPage) => {
    page = nextPage;
    await page.addInitScript(observerInitScript).catch(() => {});
    page.on('console', (message) => {
      stats.consoleCount += 1;
      consoleWriter.write({
        observedAt: isoNow(),
        type: message.type(),
        text: clipText(message.text(), 1200),
        location: message.location(),
        url: redactUrl(page.url(), options.redact),
      });
    });
    page.on('pageerror', (error) => {
      stats.consoleCount += 1;
      consoleWriter.write({
        observedAt: isoNow(),
        type: 'pageerror',
        text: error.message || String(error),
        stack: error.stack || '',
        url: redactUrl(page.url(), options.redact),
      });
    });
    page.on('response', (response) => {
      const request = response.request();
      const status = response.status();
      if (status < 400 && !['xhr', 'fetch', 'document'].includes(request.resourceType())) return;
      stats.networkCount += 1;
      networkWriter.write({
        observedAt: isoNow(),
        eventType: 'response',
        status,
        method: request.method(),
        resourceType: request.resourceType(),
        url: redactUrl(response.url(), options.redact),
      });
    });
    page.on('requestfailed', (request) => {
      stats.networkCount += 1;
      networkWriter.write({
        observedAt: isoNow(),
        eventType: 'requestfailed',
        method: request.method(),
        resourceType: request.resourceType(),
        url: redactUrl(request.url(), options.redact),
        failure: request.failure()?.errorText || '',
      });
    });
    page.on('framenavigated', async (frame) => {
      if (frame !== page.mainFrame()) return;
      actionSequence += 1;
      const action = {
        sequence: actionSequence,
        observedAt: isoNow(),
        eventType: 'navigation',
        url: redactUrl(frame.url(), options.redact),
      };
      stats.actionCount += 1;
      actionsWriter.write(action);
      observationSequence += 1;
      const observation = await collectObservation(page, options, {
        sessionDir,
        kind: 'after_navigation',
        actionSequence,
        observationSequence,
      });
      stats.observationCount += 1;
      observationsWriter.write(observation);
    });
  };

  await bindPage(page);
  context.on('page', (nextPage) => {
    bindPage(nextPage).catch((error) => {
      consoleWriter.write({ observedAt: isoNow(), type: 'observer_error', text: error.message || String(error) });
    });
  });

  await page.goto(options.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  observationSequence += 1;
  const initialObservation = await collectObservation(page, options, {
    sessionDir,
    kind: 'initial',
    actionSequence: null,
    observationSequence,
  });
  stats.observationCount += 1;
  observationsWriter.write(initialObservation);

  const poller = (async () => {
    while (!stopPolling) {
      await new Promise((resolve) => setTimeout(resolve, options.pollMs));
      const events = await drainPageEvents(page);
      for (const rawEvent of events) {
        actionSequence += 1;
        const action = {
          sequence: actionSequence,
          observedAt: isoNow(),
          ...redactPayload(rawEvent, options.redact),
          url: redactUrl(rawEvent.url, options.redact),
        };
        stats.actionCount += 1;
        actionsWriter.write(action);
        observationSequence += 1;
        const observation = await collectObservation(page, options, {
          sessionDir,
          kind: 'after_action',
          actionSequence,
          observationSequence,
        });
        stats.observationCount += 1;
        observationsWriter.write(observation);
      }
    }
  })();

  const stopReason = await waitForEnterOrTimeout(options);
  stopPolling = true;
  await poller.catch(() => {});

  observationSequence += 1;
  const finalObservation = await collectObservation(page, options, {
    sessionDir,
    kind: 'final',
    actionSequence: null,
    observationSequence,
  });
  stats.observationCount += 1;
  observationsWriter.write(finalObservation);

  const finishedAt = isoNow();
  const summary = {
    sessionId,
    sessionName: options.sessionName || sessionBase,
    startedAt,
    finishedAt,
    stopReason,
    startUrl: redactUrl(options.url, options.redact),
    finalUrl: redactUrl(page.url(), options.redact),
    outputDir: sessionDir,
    ...stats,
  };
  const tracePath = path.join(sessionDir, 'trace.json');
  await fs.promises.writeFile(tracePath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  await fs.promises.writeFile(path.join(sessionDir, 'summary.md'), buildSummaryMarkdown(summary, {
    actions: 'actions.jsonl',
    observations: 'observations.jsonl',
    console: 'console.jsonl',
    network: 'network.jsonl',
    trace: 'trace.json',
  }), 'utf8');

  await Promise.all([
    actionsWriter.close(),
    observationsWriter.close(),
    consoleWriter.close(),
    networkWriter.close(),
  ]);
  await context.close().catch(() => {});
  await browser?.close().catch(() => {});
  return summary;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const summary = await runObserver(options);
  process.stdout.write(`Observation saved to ${summary.outputDir}\n`);
  process.stdout.write(`Actions: ${summary.actionCount}; observations: ${summary.observationCount}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`web_interaction_observer_error ${error.stack || error.message || String(error)}\n`);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  runObserver,
};
