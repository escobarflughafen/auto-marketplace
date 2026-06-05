function createWorkerScheduler(options = {}) {
  const logger = typeof options.logger === 'function' ? options.logger : () => {};
  const jobs = new Map();

  const stop = (jobId) => {
    const existing = jobs.get(jobId);
    if (!existing) {
      return false;
    }
    existing.stopped = true;
    if (existing.timer) {
      clearTimeout(existing.timer);
    }
    jobs.delete(jobId);
    return true;
  };

  const schedule = (job) => {
    if (job.stopped) {
      return;
    }
    job.timer = setTimeout(() => run(job), job.nextDelayMs);
    if (typeof job.timer.unref === 'function') {
      job.timer.unref();
    }
  };

  const run = async (job) => {
    if (job.stopped) {
      return;
    }
    if (job.running) {
      job.nextDelayMs = job.intervalMs;
      schedule(job);
      return;
    }
    job.running = true;
    const startedAt = Date.now();
    try {
      await job.invoke({
        jobId: job.id,
        scheduledAt: new Date(startedAt).toISOString(),
      });
      logger({
        type: 'worker_scheduler_job_done',
        jobId: job.id,
        elapsedMs: Date.now() - startedAt,
      });
    } catch (error) {
      logger({
        type: 'worker_scheduler_job_error',
        jobId: job.id,
        elapsedMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      job.running = false;
      job.nextDelayMs = job.intervalMs;
      schedule(job);
    }
  };

  const scheduleEvery = (jobId, intervalMs, invoke, optionsForJob = {}) => {
    const id = String(jobId || '').trim();
    if (!id) {
      throw new Error('scheduleEvery requires jobId');
    }
    if (typeof invoke !== 'function') {
      throw new Error('scheduleEvery requires invoke function');
    }
    stop(id);
    const job = {
      id,
      intervalMs: Math.max(1, Number(intervalMs) || 1_000),
      nextDelayMs: Number.isFinite(optionsForJob.initialDelayMs)
        ? Math.max(0, optionsForJob.initialDelayMs)
        : Math.max(1, Number(intervalMs) || 1_000),
      invoke,
      running: false,
      stopped: false,
      timer: null,
    };
    jobs.set(id, job);
    schedule(job);
    return () => stop(id);
  };

  const stopAll = () => {
    for (const jobId of [...jobs.keys()]) {
      stop(jobId);
    }
  };

  return {
    scheduleEvery,
    stop,
    stopAll,
    jobs,
  };
}

module.exports = {
  createWorkerScheduler,
};
