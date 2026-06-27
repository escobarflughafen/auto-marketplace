class RemoteWorkerApiError extends Error {
  constructor(message, response) {
    super(message);
    this.name = 'RemoteWorkerApiError';
    this.status = response.status;
    this.body = response.body;
  }
}

function normalizeHostUrl(hostUrl) {
  const text = String(hostUrl || '').trim().replace(/\/+$/, '');
  if (!text) {
    throw new Error('remote worker hostUrl is required');
  }
  return text;
}

class RemoteWorkerApiClient {
  constructor(options = {}) {
    this.hostUrl = normalizeHostUrl(options.hostUrl);
    this.workerToken = String(options.workerToken || '').trim();
    this.timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 10000;
    if (!this.workerToken) {
      throw new Error('remote worker token is required');
    }
  }

  async request(method, pathname, body) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.hostUrl}${pathname}`, {
        method,
        headers: {
          authorization: `Bearer ${this.workerToken}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const text = await response.text();
      const parsed = text ? JSON.parse(text) : null;
      const result = {
        status: response.status,
        body: parsed,
      };
      if (!response.ok) {
        const message = parsed?.error?.message || parsed?.error || `Remote worker API returned ${response.status}`;
        throw new RemoteWorkerApiError(message, result);
      }
      return parsed;
    } finally {
      clearTimeout(timeout);
    }
  }

  registerSession(body) {
    return this.request('POST', '/api/v2/remote-workers/sessions', body);
  }

  heartbeat(sessionId, body) {
    return this.request('POST', `/api/v2/remote-workers/sessions/${encodeURIComponent(sessionId)}/heartbeat`, body);
  }

  claim(sessionId, body) {
    return this.request('POST', `/api/v2/remote-workers/sessions/${encodeURIComponent(sessionId)}/claims`, body);
  }

  uploadEvents(sessionId, body) {
    return this.request('POST', `/api/v2/remote-workers/sessions/${encodeURIComponent(sessionId)}/events`, body);
  }

  uploadArtifacts(sessionId, body) {
    return this.request('POST', `/api/v2/remote-workers/sessions/${encodeURIComponent(sessionId)}/artifacts`, body);
  }

  pollCommands(sessionId, options = {}) {
    const limit = Number.isFinite(options.limit) ? `?limit=${encodeURIComponent(String(options.limit))}` : '';
    return this.request('GET', `/api/v2/remote-workers/sessions/${encodeURIComponent(sessionId)}/commands${limit}`);
  }

  ackCommand(sessionId, commandId, body) {
    return this.request('POST', `/api/v2/remote-workers/sessions/${encodeURIComponent(sessionId)}/commands/${encodeURIComponent(commandId)}/ack`, body);
  }

  completeLease(sessionId, leaseId, body) {
    return this.request('POST', `/api/v2/remote-workers/sessions/${encodeURIComponent(sessionId)}/leases/${encodeURIComponent(leaseId)}/complete`, body);
  }

  renewLease(sessionId, leaseId, body) {
    return this.request('POST', `/api/v2/remote-workers/sessions/${encodeURIComponent(sessionId)}/leases/${encodeURIComponent(leaseId)}/renew`, body);
  }
}

module.exports = {
  RemoteWorkerApiClient,
  RemoteWorkerApiError,
};
