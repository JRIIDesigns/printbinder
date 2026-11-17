'use strict';
// ChatGPT (OpenAI) — one of the AI providers PrintBinder can talk to. Same functions as providers/anthropic.js, which
// describes them. It is sent the same prompts, pictures and tools as Claude, through OpenAI's Responses API.
// Nothing is kept on OpenAI's side between requests (store: false): the whole conversation is sent each time, as with Claude.
//
// The requests are plain HTTPS (providers/http.js), written to be what OpenAI's SDK 7.57.0 sent: the same addresses, the same
// JSON, the key in the same header, the same waiting and trying again.
const { ApiError, isApi, send, events, wording } = require('./http.js');
const ID = 'openai';

module.exports = function init({ key }) {
  // OPENAI_BASE_URL points it at a stand-in server for tests
  const url = path => { const base = (process.env.OPENAI_BASE_URL || '').trim() || 'https://api.openai.com/v1'; return base + (base.endsWith('/') ? path.slice(1) : path); };
  // the key travels in the Authorization header only: never in the address, the body or the log.
  // An organisation or project named in the environment is passed on, as the SDK passed it on.
  const headers = more => {
    const org = (process.env.OPENAI_ORG_ID || '').trim(), project = (process.env.OPENAI_PROJECT_ID || '').trim();
    return { accept: 'application/json', authorization: 'Bearer ' + key(), ...(org ? { 'openai-organization': org } : {}), ...(project ? { 'openai-project': project } : {}), ...more };
  };
  const usage = u => { if (!u) return null; const d = u.input_tokens_details || {}, cr = d.cached_tokens || 0; return { in: Math.max(0, (u.input_tokens || 0) - cr), out: u.output_tokens || 0, cr, cw: d.cache_write_tokens || 0 }; };
  const messages = r => (r.output || []).filter(o => o.type === 'message').flatMap(o => o.content || []);
  const textOf = r => messages(r).filter(c => c.type === 'output_text').map(c => c.text).join('');
  function stopOf(r) {
    const why = r.status === 'incomplete' && r.incomplete_details && r.incomplete_details.reason;
    if (why === 'max_output_tokens') return 'max';
    if (why === 'content_filter' || messages(r).some(c => c.type === 'refusal')) return 'refusal';
    return 'end';
  }

  // An error answer: OpenAI says what kind in the error's own code and type.
  const failure = (kind, status, error, text) => new ApiError(ID, kind, wording(status, error, text), { status, code: error ? error.code : undefined, type: error ? error.type : undefined });
  const request = (path, o = {}) => send({ provider: ID, url: url(path), retries: 4, honour: ms => Number.isFinite(ms) && ms >= 0 && ms <= 60000,
    errorOf: (s, j, t) => failure('status', s, j && j.error, t), ...o, headers: headers(o.headers) });
  const create = async (body, stream) => {
    const res = await request('/responses', { headers: { 'content-type': 'application/json' }, body: JSON.stringify(stream ? { ...body, stream: true } : body) });
    return stream ? streamed(res) : res.json();
  };

  // A streamed answer, put together from its events. The last "response.completed" (or .incomplete, .failed) event carries the
  // whole answer; until one arrives the answer is built from the pieces, so a stream that ends early still gives what came.
  async function streamed(res) {
    let r = null;
    const item = ev => r && r.output && r.output[ev.output_index], part = ev => { const it = item(ev); return it && it.content && it.content[ev.content_index]; };
    try {
      for await (const sse of events(res, { flush: true })) {
        if (sse.data === '[DONE]') break;
        let ev;
        try { ev = JSON.parse(sse.data); } catch { throw new SyntaxError('Error reading response: malformed server-sent event JSON.'); }
        if (sse.event === 'error') throw failure('stream', undefined, (ev && ev.error) ?? ev);
        if (ev && ev.error) throw failure('stream', undefined, ev.error);
        if (ev && ev.type === 'error') throw failure('stream', undefined, ev, ev.message);
        if (!ev || typeof ev.type !== 'string') continue;
        if (/^response\.(created|queued|in_progress|completed|incomplete|failed)$/.test(ev.type)) { if (ev.response) r = ev.response; }
        else if (ev.type === 'response.output_item.added' || ev.type === 'response.output_item.done') { if (r && ev.item) (r.output || (r.output = []))[ev.output_index] = ev.item; }
        else if (ev.type === 'response.content_part.added' || ev.type === 'response.content_part.done') { const it = item(ev); if (it && ev.part) (it.content || (it.content = []))[ev.content_index] = ev.part; }
        else if (ev.type === 'response.output_text.delta') { const p = part(ev); if (p && p.type === 'output_text') p.text = (p.text || '') + ev.delta; }
        else if (ev.type === 'response.output_text.done') { const p = part(ev); if (p && p.type === 'output_text') p.text = ev.text; }
        else if (ev.type === 'response.refusal.delta') { const p = part(ev); if (p && p.type === 'refusal') p.refusal = (p.refusal || '') + ev.delta; }
        else if (ev.type === 'response.refusal.done') { const p = part(ev); if (p && p.type === 'refusal') p.refusal = ev.refusal; }
      }
    } catch (e) {
      if (e instanceof ApiError) throw e;
      if (!(e && e.name === 'AbortError')) throw new Error(e instanceof Error ? e.message : String(e), { cause: e });   // the connection dropped part-way, or an event was not JSON
    }
    if (!r) throw new Error('request ended without sending any events');
    // a finished answer has to be the JSON that was asked for (the SDK checked this too, with these words)
    if (!r.status || r.status === 'completed') for (const o of r.output || []) if (o.type === 'message' && (o.phase == null || o.phase === 'final_answer'))
      for (const c of o.content || []) if (c.type === 'output_text') { try { JSON.parse(c.text); } catch { throw new Error('Error reading response: invalid structured output JSON.'); } }
    return r;
  }

  async function ask({ model, system, user, schema, name, stream }) {
    const content = typeof user === 'string' ? user : user.map(p => p.image
      ? { type: 'input_image', detail: 'auto', image_url: 'data:' + p.image.mime + ';base64,' + p.image.data }
      : { type: 'input_text', text: p.text });
    const r = await create({ model, instructions: system, input: [{ role: 'user', content }], store: false,
      text: { format: { type: 'json_schema', name, schema, strict: true } } }, stream);   // long answers are streamed so the connection is not cut
    return { text: textOf(r), stop: stopOf(r), usage: usage(r.usage) };
  }

  const say = (history, text) => { history.push({ role: 'user', content: text }); };
  async function chat({ model, system, tools, history }) {
    const r = await create({
      model, instructions: system, input: history, store: false, include: ['reasoning.encrypted_content'],
      // not "strict": the tools have optional settings, which strict mode does not allow
      tools: tools.map(t => ({ type: 'function', name: t.name, description: t.description, parameters: t.input_schema, strict: false })),
    });
    history.push(...(r.output || []));   // unchanged, so its reasoning stays attached to its tool requests
    const calls = (r.output || []).filter(o => o.type === 'function_call').map(o => {
      let input = {};
      try { input = JSON.parse(o.arguments || '{}'); } catch {}
      return { id: o.call_id, name: o.name, input };
    });
    return { text: textOf(r), stop: stopOf(r), usage: usage(r.usage), calls };
  }
  const results = (history, list) => { for (const r of list) history.push({ type: 'function_call_output', call_id: r.id, output: JSON.stringify(r.out) }); };

  // Both "no credit" and "too many requests" arrive as HTTP 429; OpenAI says which in the error's own code and type:
  // insufficient_quota (or billing_not_active) against rate_limit_exceeded.
  const ours = e => isApi(e, ID), is = (e, status) => ours(e) && e.status === status;
  const offline = e => ours(e) && (e.kind === 'connection' || e.kind === 'timeout');
  const noCredit = e => ours(e) && ['insufficient_quota', 'billing_not_active'].some(c => e.code === c || e.type === c);
  const tooFast = e => is(e, 429) && !noCredit(e);
  // for the log: the status and the provider's own code, never its message
  const tag = e => offline(e) ? { status: 0, code: 'connection' } : ours(e) ? { status: e.status || 0, code: e.code || e.type || '' } : null;
  function explain(e) {
    if (noCredit(e)) return 'This OpenAI account has no API credit. A ChatGPT subscription does not include it — add credit under Billing on the OpenAI developer site.';
    if (tooFast(e)) return 'Too many requests just now — wait a minute and try again.';
    if (is(e, 401)) return 'OpenAI did not accept the API key. Check the ChatGPT key in settings.';
    if (is(e, 403)) return 'This OpenAI API key is not allowed to use that model. Pick another model in settings.';
    if (is(e, 404)) return 'OpenAI does not know that model. Pick another one in settings.';
    if (is(e, 400)) return 'OpenAI rejected the request: ' + e.message;
    if (offline(e)) return 'Could not reach OpenAI — check the internet connection.';
    if (ours(e)) return 'OpenAI returned an error (' + (e.status || 'unknown') + '). Try again in a moment.';
    return null;
  }
  const fatal = e => is(e, 401) || is(e, 403) || is(e, 404) || is(e, 429) || offline(e) || noCredit(e);

  return {
    id: ID, label: 'ChatGPT', company: 'OpenAI',
    models: {
      'gpt-6-luna': { label: 'GPT-6 Luna — fastest' },
      'gpt-6.1-terra': { label: 'GPT-6.1 Terra — balanced' },
      'gpt-6.1-sol': { label: 'GPT-6.1 Sol — thorough' },
      'gpt-6-astra': { label: 'GPT-6 Astra — most capable' },
    },
    noKey: 'Add your OpenAI API key in settings first — the model chosen for this job is a ChatGPT one.',
    keyLooksWrong: k => k.length < 20 || /\s/.test(k) || /^sk-ant-|^AIza/.test(k),
    reset: () => {},
    ask, say, chat, results, explain, fatal, tag,
    check: async () => { await (await request('/models', { method: 'GET' })).json(); },
    rejected: e => is(e, 401) || is(e, 403),
  };
};
