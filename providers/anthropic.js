'use strict';
// Claude (Anthropic) — one of the AI providers PrintBinder can talk to. See ai.js for the rules every provider works under.
// Every provider file offers the same small set of functions:
//   ask({ model, system, user, schema, name, max, effort, stream })  one question, answered as JSON that fits the schema
//       user is plain text, or a list of { text } and { image: { mime, data } } parts (data is base64)
//       -> { text, stop: 'end' | 'refusal' | 'max', usage }
//   say(history, text)                                                  add the owner's message to a conversation
//   chat({ model, system, tools, history, max })                        one step of a conversation; adds the reply to history
//       -> { text, calls: [{ id, name, input }], stop: 'end' | 'refusal' | 'max' | 'pause', usage }
//   results(history, [{ id, name, out }])                               add what the tools answered
//   check()            a harmless request that proves the key works     rejected(e)   true when the key itself was turned down
//   explain(e)         plain-English wording for an error (null if not ours)          fatal(e)   true when retrying is pointless
// The conversation history is kept in the provider's own format, which is why a conversation cannot change provider half-way.
//
// The requests are plain HTTPS (providers/http.js), written to be what Anthropic's SDK 1.8.0 sent: the same addresses, the same
// JSON, the same API version, the key in the same header, the same waiting and trying again.
const { ApiError, isApi, send, events, wording } = require('./http.js');
const ID = 'anthropic';
const API_VERSION = '2026-10-21';
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

module.exports = function init({ key, log }) {
  // ANTHROPIC_BASE_URL points it at a stand-in server for tests
  const url = path => { const base = (process.env.ANTHROPIC_BASE_URL || '').trim() || 'https://api.anthropic.com'; return base + (base.endsWith('/') ? path.slice(1) : path); };
  // the key travels in the Authorization header only: never in the address, the body or the log
  const headers = more => ({ accept: 'application/json', 'anthropic-version': API_VERSION, authorization: 'Bearer ' + key(), ...more });
  const usage = u => u ? { in: u.input_tokens || 0, out: u.output_tokens || 0, cr: u.cache_read_input_tokens || 0, cw: u.cache_creation_input_tokens || 0 } : null;

  // An error answer: Anthropic says what kind in error.type, and for some a finer code in error.details.error_code.
  const failure = (kind, status, body, text) => {
    const err = body && body.error, code = err && err.details && err.details.error_code;
    return new ApiError(ID, kind, wording(status, body, text), { status, type: (err && err.type) ?? null, errorCode: typeof code === 'string' ? code : null });
  };
  const request = (path, o = {}) => send({ provider: ID, url: url(path), retries: 4, honour: ms => ms > 0 && ms <= 2 ** 31 - 1, errorOf: (s, j, t) => failure('status', s, j, t), ...o, headers: headers(o.headers) });
  // not an answer from Anthropic, but something this file could not make sense of (worded as the SDK worded it)
  const oddity = (message, cause) => Object.assign(new Error(message, cause ? { cause } : undefined), { name: 'AnthropicError' });

  // A streamed answer, put together from its events: the text as it arrives, and at the end why it stopped and what it used.
  // Only what ask() reads is put together (text, stop_reason, usage); other kinds of block stay as they were announced.
  async function streamed(res) {
    let msg = null, done = null;
    try {
      for await (const sse of events(res)) {
        if (sse.event === 'ping' || sse.event === null) continue;
        if (sse.event === 'error') { let body = sse.data; try { body = JSON.parse(sse.data) ?? sse.data; } catch {} throw failure('stream', undefined, body); }
        if (!sse.data) continue;
        const ev = JSON.parse(sse.data);
        if (ev.type === 'message_start') { if (msg) throw oddity('Unexpected event order, got message_start before receiving "message_stop"'); msg = ev.message; continue; }
        if (!msg) continue;
        if (ev.type === 'message_stop') done = msg;
        else if (ev.type === 'content_block_start') msg.content.push(ev.content_block);
        else if (ev.type === 'content_block_delta') { const b = msg.content[ev.index]; if (ev.delta.type === 'text_delta' && b && b.type === 'text') b.text = (b.text || '') + ev.delta.text; }
        else if (ev.type === 'message_delta') {
          msg.stop_reason = ev.delta.stop_reason;
          msg.usage.output_tokens = ev.usage.output_tokens;
          for (const k of ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']) if (ev.usage[k] != null) msg.usage[k] = ev.usage[k];
        }
      }
    } catch (e) {
      if (e instanceof ApiError || (e && e.name === 'AnthropicError')) throw e;
      throw oddity(e instanceof Error ? e.message : String(e), e);   // the connection dropped part-way, or an event was not JSON
    }
    if (!msg) throw oddity('request ended without sending any chunks');
    if (!done) throw oddity('stream ended without producing a Message with role=assistant');
    return done;
  }

  // One request to Claude. Models that support it get Anthropic's server-side fallback, so a request that the first
  // model declines is retried on another one inside the same call.
  let fallbackOK = true;
  async function call(model, params, stream) {
    const run = async fb => {
      const res = await request('/v1/messages', {
        headers: { 'content-type': 'application/json', ...(fb ? { 'anthropic-beta': FALLBACK_BETA } : {}) },
        body: JSON.stringify({ ...params, model, ...(fb ? { fallbacks: 'default' } : {}), ...(stream ? { stream: true } : {}) }),
      });
      return stream ? streamed(res) : res.json();
    };
    const fb = fallbackOK && model !== 'claude-haiku-5-5';
    try { return await run(fb); }
    catch (e) {
      if (!fb || !(isApi(e, ID) && e.status === 400)) throw e;
      log('ai: fallback option rejected, continuing without it (status ' + e.status + ', ' + (e.errorCode || e.type || 'no code') + ')');
      fallbackOK = false;
      return run(false);
    }
  }
  const textOf = msg => msg.content.filter(b => b.type === 'text').map(b => b.text).join('');
  const stopOf = msg => ({ refusal: 'refusal', max_tokens: 'max', pause_turn: 'pause' })[msg.stop_reason] || 'end';

  async function ask({ model, system, user, schema, max, effort, stream }) {
    const content = typeof user === 'string' ? user : user.map(p => p.image
      ? { type: 'image', source: { type: 'base64', media_type: p.image.mime, data: p.image.data } }
      : { type: 'text', text: p.text });
    const msg = await call(model, {
      max_tokens: max, system, messages: [{ role: 'user', content }],
      output_config: { ...(effort ? { effort } : {}), format: { type: 'json_schema', schema } },
    }, stream);
    return { text: textOf(msg), stop: stopOf(msg), usage: usage(msg.usage) };
  }

  const say = (history, text) => { history.push({ role: 'user', content: text }); };
  async function chat({ model, system, tools, history, max }) {
    const msg = await call(model, { max_tokens: max, system, tools, cache_control: { type: 'ephemeral' }, messages: history });
    history.push({ role: 'assistant', content: msg.content });   // unchanged, so thinking blocks stay valid
    return { text: textOf(msg), stop: stopOf(msg), usage: usage(msg.usage),
      calls: msg.content.filter(b => b.type === 'tool_use').map(u => ({ id: u.id, name: u.name, input: u.input })) };
  }
  const results = (history, list) => { history.push({ role: 'user', content: list.map(r =>
    ({ type: 'tool_result', tool_use_id: r.id, content: JSON.stringify(r.out), ...(r.out && r.out.error ? { is_error: true } : {}) })) }); };

  // Anthropic says which refusal it is in the error's own type and code (error.type and error.details.error_code in the
  // answer) — never read from its wording, which can change.
  const ours = e => isApi(e, ID), is = (e, status) => ours(e) && e.status === status;
  const offline = e => ours(e) && (e.kind === 'connection' || e.kind === 'timeout');
  const noCredit = e => ours(e) && e.type === 'billing_error';
  const capped = e => ours(e) && e.errorCode === 'enforced_spend_limit_reached';
  const tooFast = e => is(e, 429) && !noCredit(e) && !capped(e);
  // for the log: the status and the provider's own code, never its message
  const tag = e => offline(e) ? { status: 0, code: 'connection' } : ours(e) ? { status: e.status || 0, code: e.errorCode || e.type || '' } : null;
  function explain(e) {
    if (noCredit(e)) return 'This Anthropic account has no API credit. A Claude subscription does not include it — add credit under Billing in the Anthropic Console.';
    if (capped(e)) return 'This Anthropic account has reached its monthly spending limit. Raise it under Limits in the Anthropic Console, or wait until next month.';
    if (tooFast(e)) return 'Too many requests just now — wait a minute and try again.';
    if (is(e, 401)) return 'Anthropic did not accept the API key. Check it in Claude settings.';
    if (is(e, 403)) return 'This API key is not allowed to use that model. Pick another model in Claude settings.';
    if (is(e, 404)) return 'Anthropic does not know that model. Pick another one in Claude settings.';
    if (is(e, 400)) return 'Anthropic rejected the request: ' + e.message;
    if (offline(e)) return 'Could not reach Anthropic — check the internet connection.';
    if (ours(e)) return 'Anthropic returned an error (' + (e.status || 'unknown') + '). Try again in a moment.';
    return null;
  }
  const fatal = e => is(e, 401) || is(e, 403) || is(e, 404) || is(e, 429) || offline(e) || noCredit(e) || capped(e);

  return {
    id: ID, label: 'Claude', company: 'Anthropic',
    models: {
      'claude-haiku-5-5': { label: 'Claude Haiku 5.5 — fastest' },
      'claude-sonnet-5-5': { label: 'Claude Sonnet 5.5 — balanced' },
      'claude-opus-5-5': { label: 'Claude Opus 5.5 — thorough' },
      'claude-fable-5-2': { label: 'Claude Fable 5.2 — most capable' },
    },
    noKey: 'Add your Anthropic API key in Claude settings first.',
    keyLooksWrong: k => k.length < 20 || /\s/.test(k),
    reset: () => {},
    ask, say, chat, results, explain, fatal, tag,
    check: async () => { await (await request('/v1/models?limit=1', { method: 'GET' })).json(); },
    rejected: e => is(e, 401) || is(e, 403),
  };
};
