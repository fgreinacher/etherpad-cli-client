/**
 * Live wire round-trip smoke test.
 *
 * Phase 2 of ether/etherpad#7923. Against a real Etherpad server this:
 *   1. creates a pad via the HTTP API,
 *   2. connects with the repo's own socket.io client (connect()),
 *   3. appends text via the client's USER_CHANGES write path (pad.append),
 *   4. reads the pad back via the HTTP API getText and asserts round-trip.
 *
 * Env contract:
 *   ETHERPAD_SMOKE_URL     base server URL    (default http://localhost:9003)
 *   ETHERPAD_SMOKE_APIKEY  HTTP API key       (required to actually run)
 *
 * If the server is unreachable (or no API key is provided) the test SKIPS
 * cleanly rather than failing, so it is safe to run in server-free CI.
 */

import {test} from 'node:test';
import assert from 'node:assert/strict';
import superagent from 'superagent';

import {connect, type PadState} from '../src/index.js';

const BASE_URL = (process.env.ETHERPAD_SMOKE_URL || 'http://localhost:9003').replace(/\/+$/, '');
const API_KEY = process.env.ETHERPAD_SMOKE_APIKEY || '';
const API = `${BASE_URL}/api/1`;

// Quick reachability probe: hit /api/ with a short timeout. Any successful
// HTTP response means the server is up; a network error means skip.
const isReachable = async (): Promise<boolean> => {
  try {
    await superagent.get(`${BASE_URL}/api/`).timeout({deadline: 1500, response: 1500});
    return true;
  } catch (err) {
    // A 4xx/5xx still proves the server is answering; only treat transport
    // errors (no response) as "unreachable".
    return Boolean((err as {response?: unknown}).response);
  }
};

const apiCall = async (
  method: string,
  params: Record<string, string>,
): Promise<{code: number; message: string; data: unknown}> => {
  const res = await superagent
      .get(`${API}/${method}`)
      .query({apikey: API_KEY, ...params})
      .timeout({deadline: 5000, response: 5000});
  return res.body as {code: number; message: string; data: unknown};
};

const withTimeout = async <T>(p: Promise<T>, ms: number, label: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout: ${label}`)), ms);
      }),
    ]);
  } finally {
    // Clear the pending timer so a fast-resolving promise doesn't leave a
    // dangling timeout keeping the test process alive until it fires.
    if (timer) clearTimeout(timer);
  }
};

test('live wire round-trip via USER_CHANGES', async (t) => {
  if (!API_KEY) {
    t.skip('ETHERPAD_SMOKE_APIKEY not set — skipping live smoke test');
    return;
  }
  if (!(await isReachable())) {
    t.skip(`Etherpad not reachable at ${BASE_URL} — skipping live smoke test`);
    return;
  }

  const padId = `phase2-smoke-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const payload = `hello-wire-${Date.now()}`;

  // 1. Create the pad via the HTTP API.
  const created = await apiCall('createPad', {padID: padId});
  assert.equal(created.code, 0, `createPad failed: ${created.message}`);

  let client: ReturnType<typeof connect> | undefined;
  try {
    // 2. Connect with the repo's own socket.io client.
    client = connect(`${BASE_URL}/p/${padId}`);

    await withTimeout(
        new Promise<void>((resolve, reject) => {
          client!.on('connected', (_state: PadState) => resolve());
          client!.on('connect_error', (e: unknown) => reject(new Error(`connect_error: ${String(e)}`)));
          client!.on('disconnect', (e: unknown) => reject(new Error(`disconnect: ${String(e)}`)));
        }),
        10000,
        'socket connect',
    );

    // 3. Append text via the client's USER_CHANGES write path.
    client.append(payload);

    // 4. Poll the HTTP API until the text round-trips (bounded).
    const deadline = Date.now() + 10000;
    let roundTripped = false;
    let lastText = '';
    while (Date.now() < deadline) {
      const got = await apiCall('getText', {padID: padId});
      assert.equal(got.code, 0, `getText failed: ${got.message}`);
      lastText = ((got.data as {text?: string}).text) || '';
      if (lastText.includes(payload)) {
        roundTripped = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 250));
    }

    assert.ok(roundTripped, `appended text did not round-trip; pad contained: ${JSON.stringify(lastText)}`);
  } finally {
    // connect() assigns close() only after its async bootstrap resolves, so
    // the method may still be undefined here — guard the call itself, not just
    // the (always-defined) client reference.
    client?.close?.();
    // Best-effort cleanup.
    try {
      await apiCall('deletePad', {padID: padId});
    } catch {
      // ignore cleanup failures
    }
  }
});
