const test = require('node:test');
const assert = require('node:assert/strict');

const { createWorkerScheduler } = require('../scripts/worker-scheduler');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('worker scheduler invokes recurring jobs and prevents overlap', async () => {
  const events = [];
  const scheduler = createWorkerScheduler({
    logger: (event) => events.push(event),
  });
  let running = false;
  let overlaps = 0;
  let invokes = 0;

  const stop = scheduler.scheduleEvery('mock-job', 20, async () => {
    invokes += 1;
    if (running) overlaps += 1;
    running = true;
    await sleep(35);
    running = false;
  }, { initialDelayMs: 0 });

  await sleep(95);
  stop();

  assert.equal(overlaps, 0);
  assert.ok(invokes >= 2);
  assert.ok(events.some((event) => event.type === 'worker_scheduler_job_done'));
});
