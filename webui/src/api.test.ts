import { test } from 'node:test';
import assert from 'node:assert/strict';

Object.defineProperty(globalThis, 'location', {
  value: new URL('http://localhost/?token=test-token'),
  configurable: true,
});

test('postLiveProvider scopes the runtime switch to the active session', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response('{"ok":true}', { status: 200 });
  }) as typeof fetch;

  try {
    const { postLiveProvider } = await import('./api.ts');

    await postLiveProvider('provider-b', 'session-1');

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, '/live/provider');
    assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
      provider: 'provider-b',
      session_id: 'session-1',
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('live mode still rejects protocol-level failures', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(
    JSON.stringify({ ok: false, error: 'runtime is busy' }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )) as typeof fetch;

  try {
    const { postLiveMode } = await import('./api.ts');
    await assert.rejects(
      () => postLiveMode('plan'),
      /rejected the mode switch/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('postLiveMode forwards the global switch and reports the confirmed state', async () => {
  const originalFetch = globalThis.fetch;
  let sentBody: any = null;
  globalThis.fetch = (async (_url: any, init: any) => {
    sentBody = JSON.parse(init.body);
    return new Response(
      JSON.stringify({ ok: true, mode: 'plan', global: true }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as typeof fetch;

  try {
    const { postLiveMode } = await import('./api.ts');
    const mode = await postLiveMode('plan', 'sess-1', true);
    assert.equal(mode, 'plan');
    assert.equal(sentBody.global, true);
    assert.equal(sentBody.session_id, 'sess-1');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('postLiveMode omits the global field when the switch is not being toggled', async () => {
  const originalFetch = globalThis.fetch;
  let sentBody: any = null;
  globalThis.fetch = (async (_url: any, init: any) => {
    sentBody = JSON.parse(init.body);
    return new Response(
      JSON.stringify({ ok: true, mode: 'build', global: false }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as typeof fetch;

  try {
    const { postLiveMode } = await import('./api.ts');
    await postLiveMode('build', 'sess-1');
    assert.equal('global' in sentBody, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('postLiveUserInput rejects an answer the runtime did not accept', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(
    JSON.stringify({ accepted: false }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )) as typeof fetch;

  try {
    const { postLiveUserInput } = await import('./api.ts');
    await assert.rejects(
      () => postLiveUserInput({
        request_id: 42,
        declined: false,
        selected: ['继续'],
        text: null,
      }),
      /did not accept/i,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('postChatUserInput correlates the answer by session and native request id', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response('{"accepted":true}', { status: 200 });
  }) as typeof fetch;

  try {
    const { postChatUserInput } = await import('./api.ts');
    await postChatUserInput('session-1', {
      request_id: 42,
      declined: false,
      selected: ['继续'],
      text: null,
    });

    assert.equal(calls[0].url, '/chat/user-input');
    assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
      session_id: 'session-1',
      request_id: 42,
      declined: false,
      selected: ['继续'],
      text: null,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a one-question questions payload still uses the batch response protocol', async () => {
  const { isUserInputBatch } = await import('./api.ts');
  assert.equal(isUserInputBatch({
    type: 'user_input_request',
    request_id: 42,
    header: '',
    question: '',
    mode: 'single',
    options: [],
    questions: [{
      header: 'Pick',
      question: 'Red or blue?',
      mode: 'single',
      options: [{ label: 'Red' }, { label: 'Blue' }],
    }],
  }), true);
});

test('collection APIs reject server error payloads instead of returning non-arrays', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(
    JSON.stringify('session metadata is missing'),
    { status: 500, headers: { 'Content-Type': 'application/json' } },
  )) as typeof fetch;

  try {
    const { getModels, getProjects } = await import('./api.ts');
    await assert.rejects(() => getModels(), /list models failed: 500/);
    await assert.rejects(() => getProjects(), /list projects failed: 500/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('deleteSession surfaces the daemon conflict reason', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(
    JSON.stringify({
      success: false,
      error: 'This session is active. Switch to or create another session, then try again.',
      code: 'SESSION_IN_USE',
      retryable: false,
    }),
    { status: 409, headers: { 'Content-Type': 'application/json' } },
  )) as typeof fetch;

  try {
    const { deleteSession, DeleteSessionError } = await import('./api.ts');
    const error = await deleteSession('0123456789abcdef', 's1').catch((cause) => cause);
    assert.ok(error instanceof DeleteSessionError);
    assert.equal(error.code, 'SESSION_IN_USE');
    assert.match(error.message, /session is active/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('streamChat rejects a clean EOF without an authoritative terminal', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(
    'data: {"type":"text","content":"partial"}\n\n',
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  )) as typeof fetch;

  try {
    const { streamChat } = await import('./api.ts');
    const events: unknown[] = [];
    await assert.rejects(
      () => streamChat({ message: 'hello' }, (event) => events.push(event)),
      /ended before an authoritative terminal/i,
    );
    assert.deepEqual(events, [{ type: 'text', content: 'partial' }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('streamChat accepts done, stopped, and error as authoritative terminals', async () => {
  const originalFetch = globalThis.fetch;
  const { streamChat } = await import('./api.ts');

  try {
    for (const terminal of [
      { type: 'done', tokens: null, tool_calls: null, session_id: 'session-1' },
      { type: 'stopped' },
      { type: 'error', message: 'provider failed' },
    ]) {
      globalThis.fetch = (async () => new Response(
        `data: ${JSON.stringify(terminal)}\n\n`,
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      )) as typeof fetch;
      await streamChat({ message: 'hello' }, () => {});
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('cancelDetachedChat aborts the local stream and uses the existing stop protocol', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(null, { status: 200 });
  }) as typeof fetch;

  try {
    const { cancelDetachedChat } = await import('./api.ts');
    const controller = new AbortController();
    await cancelDetachedChat('request-1', controller);

    assert.equal(controller.signal.aborted, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, '/chat/stop');
    assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
      session_id: 'request-1',
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('watchChatSession standby-only watch skips live replay', async () => {
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    calls.push(String(url));
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  try {
    const { watchChatSession } = await import('./api.ts');
    const controller = new AbortController();
    await watchChatSession('sess-idle', () => {}, controller.signal, {
      standbyOnly: true,
    }).catch(() => {});
    assert.equal(calls.length, 1);
    assert.ok(calls[0].includes('/chat/watch?'));
    assert.ok(calls[0].includes('session_id=sess-idle'));
    assert.ok(calls[0].includes('standby=true'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('postChatPrompt submits prompt via RPC and returns 202 prompt ack', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(
      JSON.stringify({
        status: 'admitted',
        operation_id: 'op-rpc-1',
        session_id: 'sess-rpc-1',
      }),
      {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }) as typeof fetch;

  try {
    const { postChatPrompt } = await import('./api.ts');
    const ack = await postChatPrompt({
      message: 'hello single event bus',
      session_id: 'sess-rpc-1',
    });
    assert.equal(ack.status, 'admitted');
    assert.equal(ack.operation_id, 'op-rpc-1');
    assert.equal(ack.session_id, 'sess-rpc-1');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, '/chat');
    const headers = calls[0].init?.headers;
    const acceptHeader =
      headers instanceof Headers
        ? headers.get('Accept')
        : (headers as Record<string, string> | undefined)?.['Accept'];
    assert.equal(acceptHeader, 'application/json');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('getActiveChatSessions reads the authoritative detached chat registry', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    assert.equal(String(url), '/chat/active');
    return new Response(JSON.stringify(['session-1', 'session-2']), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const { getActiveChatSessions } = await import('./api.ts');
    assert.deepEqual(await getActiveChatSessions(), ['session-1', 'session-2']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('getHealth reads the running binary version from GET /health', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    assert.equal(String(url), '/health');
    return new Response(
      JSON.stringify({ status: 'ok', version: '7.0.13', service: 'jeikcode-daemon' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as typeof fetch;

  try {
    const { getHealth } = await import('./api.ts');
    const health = await getHealth();
    assert.equal(health.version, '7.0.13');
    assert.equal(health.service, 'jeikcode-daemon');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('checkUpdate requests /api/update/check and parses response', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    assert.equal(String(url), '/api/update/check');
    return new Response(
      JSON.stringify({
        current_version: 'v7.1.7',
        latest_version: 'v7.1.30',
        has_update: true,
        is_desktop: true,
        channel: 'stable',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as typeof fetch;

  try {
    const { checkUpdate } = await import('./api.ts');
    const res = await checkUpdate();
    assert.equal(res.has_update, true);
    assert.equal(res.latest_version, 'v7.1.30');
    assert.equal(res.is_desktop, true);
    assert.equal(res.channel, 'stable');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('checkUpdate passes channel query parameter', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    assert.equal(String(url), '/api/update/check?channel=beta');
    return new Response(
      JSON.stringify({
        current_version: 'v7.1.49',
        latest_version: 'v7.1.50-beta.1',
        has_update: true,
        is_desktop: false,
        channel: 'beta',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as typeof fetch;

  try {
    const { checkUpdate } = await import('./api.ts');
    const res = await checkUpdate('beta');
    assert.equal(res.has_update, true);
    assert.equal(res.latest_version, 'v7.1.50-beta.1');
    assert.equal(res.channel, 'beta');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchUpgradeDiffs passes first_launch and force query parameters', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    assert.equal(String(url), '/api/config/upgrade-diffs?first_launch=true');
    return new Response(
      JSON.stringify({
        should_prompt: true,
        current_version: 'v7.1.30',
        diffs: [
          {
            relative_path: 'prompts/init.yaml',
            description: '提示词',
            target_path: '/home/.jeikcode/prompts/init.yaml',
            kind: 'modified',
            selected: true,
          },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as typeof fetch;

  try {
    const { fetchUpgradeDiffs } = await import('./api.ts');
    const res = await fetchUpgradeDiffs(true, false);
    assert.equal(res.should_prompt, true);
    assert.equal(res.diffs.length, 1);
    assert.equal(res.diffs[0].relative_path, 'prompts/init.yaml');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('applyUpgradeDiffs posts selected_paths and returns applied_count', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(url), '/api/config/apply-diffs');
    assert.equal(init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(init?.body)), {
      selected_paths: ['prompts/init.yaml'],
    });
    return new Response(
      JSON.stringify({ success: true, applied_count: 1 }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as typeof fetch;

  try {
    const { applyUpgradeDiffs } = await import('./api.ts');
    const res = await applyUpgradeDiffs(['prompts/init.yaml']);
    assert.equal(res.success, true);
    assert.equal(res.applied_count, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('getConfig surfaces a 401 empty body as Unauthorized instead of JSON.parse crash', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('', { status: 401 })) as typeof fetch;
  try {
    const { getConfig } = await import('./api.ts');
    await assert.rejects(
      () => getConfig(),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /Unauthorized/);
        assert.doesNotMatch(err.message, /Unexpected end of JSON input/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('getConfig uses the JSON error field from a 401 body', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ success: false, error: 'Unauthorized: missing or invalid access token' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } },
    )) as typeof fetch;
  try {
    const { getConfig } = await import('./api.ts');
    await assert.rejects(
      () => getConfig(),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal(err.message, 'Unauthorized: missing or invalid access token');
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('getConfig parses a successful config payload', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    assert.equal(String(url), '/config');
    return new Response(
      JSON.stringify({
        path: '/home/.jeikcode/config.toml',
        default_provider: 'claude-opus-4-6',
        providers: [],
        accounts: [],
        language: 'zh-CN',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as typeof fetch;
  try {
    const { getConfig } = await import('./api.ts');
    const cfg = await getConfig();
    assert.equal(cfg.default_provider, 'claude-opus-4-6');
    assert.equal(cfg.language, 'zh-CN');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('401 drops the rejected bearer and retries with the HttpOnly cookie', async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; authorization: string | null }> = [];
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({ url: String(url), authorization: headers.get('Authorization') });
    if (calls.length === 1) {
      return new Response('', { status: 401 });
    }
    assert.equal(headers.get('Authorization'), null, 'cookie-only retry must not replay the stale bearer');
    return new Response(
      JSON.stringify({ default_provider: 'claude-opus-4-6', language: 'zh-CN' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as typeof fetch;

  try {
    const { getConfig, invalidateConfigCache, isAuthExpired, resetAuthExpired } = await import('./api.ts');
    resetAuthExpired();
    invalidateConfigCache();
    const cfg = await getConfig();
    assert.equal(cfg.default_provider, 'claude-opus-4-6');
    assert.equal(calls.length, 2);
    assert.match(String(calls[0].authorization), /test-token/);
    assert.equal(isAuthExpired(), false);
  } finally {
    globalThis.fetch = originalFetch;
    const { invalidateConfigCache } = await import('./api.ts');
    invalidateConfigCache();
  }
});

test('permanently rejected credentials latch the auth gate without reloading', async () => {
  const originalFetch = globalThis.fetch;
  const previousWindow = (globalThis as any).window;
  let calls = 0;
  let reloads = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response('', { status: 401 });
  }) as typeof fetch;
  // The regression: 401 used to call location.reload(), which replayed the same
  // stale token forever. Prove the gate latches and never reloads.
  (globalThis as any).window = {
    location: { reload: () => { reloads += 1; } },
    addEventListener: () => {},
  };

  try {
    const { getConfig, invalidateConfigCache, isAuthExpired, resetAuthExpired } = await import('./api.ts');
    resetAuthExpired();
    invalidateConfigCache();
    await assert.rejects(() => getConfig());
    assert.equal(isAuthExpired(), true);
    assert.equal(calls, 2, 'one original request + one cookie-only retry');
    assert.equal(reloads, 0);

    // Latched: later 401s must not keep retrying or reloading.
    await assert.rejects(() => getConfig());
    assert.equal(calls, 3);
    assert.equal(reloads, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousWindow === undefined) delete (globalThis as any).window;
    else (globalThis as any).window = previousWindow;
    const { invalidateConfigCache, resetAuthExpired } = await import('./api.ts');
    resetAuthExpired();
    invalidateConfigCache();
  }
});

test('applyWebuiToken validates a pasted access URL before persisting it', async () => {
  const originalFetch = globalThis.fetch;
  const store = new Map<string, string>();
  const mockStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, val: string) => { store.set(key, val); },
    removeItem: (key: string) => { store.delete(key); },
  };
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(url), '/config');
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer new-token');
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  (globalThis as any).sessionStorage = mockStorage;
  (globalThis as any).localStorage = mockStorage;

  try {
    const { applyWebuiToken, isAuthExpired, resetAuthExpired, WEBUI_TOKEN_STORAGE_KEY } = await import('./api.ts');
    resetAuthExpired();
    await applyWebuiToken('http://192.168.1.20:13457/?token=new-token&session=abcd1234');
    assert.equal(store.get(WEBUI_TOKEN_STORAGE_KEY), 'new-token');
    assert.equal(isAuthExpired(), false);
  } finally {
    globalThis.fetch = originalFetch;
    delete (globalThis as any).sessionStorage;
    delete (globalThis as any).localStorage;
  }
});

test('streamGlobalEvents parses events and handles keepalive comments cleanly', async () => {
  const originalFetch = globalThis.fetch;
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"type":"sync"}\n\n'));
      controller.enqueue(encoder.encode(':keepalive ping\n\n'));
      controller.enqueue(encoder.encode('data: {"type":"review_resolved","session_id":"s1","approval_id":"a1"}\n\n'));
      controller.close();
    },
  });

  globalThis.fetch = (async (url: RequestInfo | URL) => {
    assert.equal(String(url), '/events');
    return new Response(stream, { status: 200 });
  }) as typeof fetch;

  try {
    const { streamGlobalEvents } = await import('./api.ts');
    const seen: any[] = [];
    await streamGlobalEvents((ev) => {
      seen.push(ev);
    });

    assert.equal(seen.length, 2);
    assert.equal(seen[0].type, 'sync');
    assert.equal(seen[1].type, 'review_resolved');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('streamGlobalEvents exits cleanly when signal is aborted', async () => {
  const originalFetch = globalThis.fetch;
  const abort = new AbortController();
  const encoder = new TextEncoder();
  let timer: NodeJS.Timeout | null = null;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"type":"sync"}\n\n'));
      timer = setTimeout(() => {
        try {
          controller.enqueue(encoder.encode('data: {"type":"review_asked","session_id":"s1","approval_id":"a1","tool_name":"bash"}\n\n'));
        } catch {}
      }, 50);
    },
    cancel() {
      if (timer) clearTimeout(timer);
    },
  });

  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(url), '/events');
    if (init?.signal) {
      init.signal.addEventListener('abort', () => {
        if (timer) clearTimeout(timer);
      });
    }
    return new Response(stream, { status: 200 });
  }) as typeof fetch;

  try {
    const { streamGlobalEvents } = await import('./api.ts');
    const seen: any[] = [];
    const promise = streamGlobalEvents((ev) => {
      seen.push(ev);
      abort.abort();
    }, abort.signal);

    await assert.rejects(promise, /aborted/i);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].type, 'sync');
  } finally {
    if (timer) clearTimeout(timer);
    globalThis.fetch = originalFetch;
  }
});

test('listSessions throws on non-ok status instead of silently passing error body as list', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })) as typeof fetch;
  try {
    const { listSessions } = await import('./api.ts');
    await assert.rejects(() => listSessions(), /list sessions failed: 401/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('concurrent identical GET requests deduplicate in-flight fetch calls and clone Response safely', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  let release!: (resp: Response) => void;
  const gate = new Promise<Response>((resolve) => {
    release = resolve;
  });
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return gate;
  }) as typeof fetch;

  try {
    const { listSessions } = await import('./api.ts');
    const p1 = listSessions();
    const p2 = listSessions();
    release(
      new Response(JSON.stringify([{ id: 's1', name: 'One', working_dir: '/w', project_hash: 'h', created_at: 1, updated_at: 2 }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(fetchCalls, 1, 'concurrent identical GETs must share one in-flight fetch');
    assert.equal(r1[0].id, 's1');
    assert.equal(r2[0].id, 's1');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('checkUpdate passes summary=1 when requested for lightweight badge polling', async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = '';
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    requestedUrl = String(url);
    return new Response(
      JSON.stringify({
        current_version: 'v7.2.0',
        latest_version: 'v7.2.1',
        has_update: true,
        is_desktop: false,
        channel: 'stable',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as typeof fetch;

  try {
    const { checkUpdate } = await import('./api.ts');
    await checkUpdate('beta', { summary: true });
    assert.equal(requestedUrl, '/api/update/check?channel=beta&summary=1');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('getModels extracts Bearer token even when pasted into /token=... pathname', async () => {
  const originalFetch = globalThis.fetch;
  const previousLocation = globalThis.location;
  let sentAuth: string | null = null;
  Object.defineProperty(globalThis, 'location', {
    value: new URL('http://localhost/token=path-tok-99'),
    configurable: true,
  });
  globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    sentAuth = new Headers(init?.headers).get('Authorization');
    return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;

  try {
    const { getModels } = await import('./api.ts');
    await getModels();
    assert.equal(sentAuth, 'Bearer path-tok-99');
  } finally {
    Object.defineProperty(globalThis, 'location', {
      value: previousLocation,
      configurable: true,
    });
    globalThis.fetch = originalFetch;
  }
});



test('getChatRuntime bypasses TTL cache on sequential calls while deduping concurrent calls', async () => {
  const originalFetch = globalThis.fetch;
  let callCount = 0;
  let releaseConcurrent!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseConcurrent = resolve;
  });

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('/chat/runtime')) {
      callCount += 1;
      if (callCount === 1) {
        await gate;
        return new Response(
          JSON.stringify({ running: true, source: 'chat', turn_id: 'op-1' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({ running: false, source: 'idle' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return new Response('null', { status: 200 });
  }) as typeof fetch;

  try {
    const { getChatRuntime } = await import('./api.ts');
    const p1 = getChatRuntime('session-runtime-cache');
    const p2 = getChatRuntime('session-runtime-cache');
    releaseConcurrent();
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(callCount, 1);
    assert.equal(r1.running, true);
    assert.equal(r2.running, true);

    const r3 = await getChatRuntime('session-runtime-cache');
    assert.equal(callCount, 2);
    assert.equal(r3.running, false);
    assert.equal(r3.source, 'idle');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('getActiveChatSessions bypasses TTL cache on sequential calls', async () => {
  const originalFetch = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = (async () => {
    callCount += 1;
    const payload = callCount === 1 ? ['s-active'] : [];
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const { getActiveChatSessions } = await import('./api.ts');
    const first = await getActiveChatSessions();
    const second = await getActiveChatSessions();
    assert.equal(callCount, 2);
    assert.deepEqual(first, ['s-active']);
    assert.deepEqual(second, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('pickNativeDirectory does not attach an auto-timeout abort signal', async () => {
  const originalFetch = globalThis.fetch;
  let capturedSignal: AbortSignal | null | undefined;
  globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    capturedSignal = init?.signal;
    return new Response(JSON.stringify({ path: 'E:\\projects\\demo', canceled: false }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const { pickNativeDirectory, resolveAutoTimeoutMs } = await import('./api.ts');
    assert.equal(resolveAutoTimeoutMs('/fs/pick_dir'), 0);
    assert.equal(resolveAutoTimeoutMs('/projects'), 15_000);
    const res = await pickNativeDirectory();
    assert.equal(capturedSignal, undefined);
    assert.deepEqual(res, { path: 'E:\\projects\\demo', canceled: false });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('pickDirectoryWithFallback prevents re-entrant opens and only falls back on error or remote host', async () => {
  const { pickDirectoryWithFallback } = await import('./api.ts');

  // 1. 远端主机直接回退到网页版目录浏览器
  let fallbackCalls = 0;
  const remoteRef = { current: false };
  await pickDirectoryWithFallback({
    isLoopback: false,
    inFlightRef: remoteRef,
    onPicked: () => {},
    onFallback: () => { fallbackCalls += 1; },
    pickNative: async () => { throw new Error('must not call native on remote'); },
  });
  assert.equal(fallbackCalls, 1);

  // 2. 进行中的原生选框拦截重复触发，且用户取消时不弹网页版目录浏览器
  const inFlightRef = { current: false };
  let releaseNative!: (res: { path: string | null; canceled: boolean }) => void;
  let nativeCalls = 0;
  let pickedPath: string | null = null;
  let errorFallback = 0;
  const firstPick = pickDirectoryWithFallback({
    isLoopback: true,
    inFlightRef,
    onPicked: (p) => { pickedPath = p; },
    onFallback: () => { errorFallback += 1; },
    pickNative: () => {
      nativeCalls += 1;
      return new Promise((resolve) => { releaseNative = resolve; });
    },
  });
  // 重入点击直接忽略
  await pickDirectoryWithFallback({
    isLoopback: true,
    inFlightRef,
    onPicked: () => {},
    onFallback: () => { errorFallback += 1; },
    pickNative: async () => {
      nativeCalls += 1;
      return { path: null, canceled: true };
    },
  });
  assert.equal(nativeCalls, 1);
  releaseNative({ path: null, canceled: true });
  await firstPick;
  assert.equal(pickedPath, null);
  assert.equal(errorFallback, 0);
  assert.equal(inFlightRef.current, false);

  // 3. 原生接口抛错时回退到网页版浏览器
  await pickDirectoryWithFallback({
    isLoopback: true,
    inFlightRef,
    onPicked: () => {},
    onFallback: () => { errorFallback += 1; },
    pickNative: async () => { throw new Error('HTTP 500'); },
  });
  assert.equal(errorFallback, 1);
  assert.equal(inFlightRef.current, false);
});
