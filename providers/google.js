'use strict';
// Gemini (Google) — one of the AI providers PrintBinder can talk to. Same functions as providers/anthropic.js, which
// describes them. It is sent the same prompts, pictures and tools as Claude.
//
// The requests are plain HTTPS, written to be what Google's Gen AI SDK 3.3.0 sent: the same addresses, the same JSON, the key
// in the same header (x-goog-api-key, never in the address), the same time limit and trying again, and the same carrying on
// when Google hands back a long answer in several parts.
const { ApiError, isApi, sleep } = require('./http.js');
const ID = 'google';
const TIMEOUT = 600000;                                // for one try, start to finish
const ATTEMPTS = 5, AGAIN = [408, 429, 500, 502, 503, 504];
// the only wordings of a failed connection that were tried again (Node's own, "fetch failed", is not among them)
const NETWORK = ['Failed to fetch', 'NetworkError when attempting to fetch resource.', 'The Internet connection appears to be offline.', 'Network request failed'];
const RECONNECTS = 3;                                  // tries at picking a dropped stream up again without getting any further

module.exports = function init({ key }) {
  // GEMINI_BASE_URL points it at a stand-in server for tests (GOOGLE_GEMINI_BASE_URL, the name Google's SDK used, works too)
  const url = path => (process.env.GEMINI_BASE_URL || process.env.GOOGLE_GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/').replace(/\/$/, '') + '/v1/' + path;
  const usage = u => { if (!u) return null; const cr = u.cachedContentTokenCount || 0; return { in: Math.max(0, (u.promptTokenCount || 0) - cr), out: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0), cr, cw: 0 }; };
  const partsOf = r => { const c = r.candidates && r.candidates[0]; return (c && c.content && c.content.parts) || []; };
  const textOf = r => partsOf(r).filter(p => typeof p.text === 'string' && !p.thought).map(p => p.text).join('');
  const BLOCKED = ['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'LANGUAGE'];
  function stopOf(r) {
    const c = r.candidates && r.candidates[0];
    if ((r.promptFeedback && r.promptFeedback.blockReason) || (c && BLOCKED.includes(c.finishReason))) return 'refusal';
    if (c && c.finishReason === 'MAX_TOKENS') return 'max';
    return 'end';
  }

  // ---------- one request ----------
  // An error answer keeps Google's whole answer as its message (JSON), which is what the wording further down reads.
  async function failure(res) {
    const body = (res.headers.get('content-type') || '').includes('application/json') ? await res.json() : { error: { message: await res.text(), code: res.status, status: res.statusText } };
    return new ApiError(ID, 'status', JSON.stringify(body), { status: res.status });
  }
  // The answer to one request, once it has begun. 408, 429 and 5xx answers are tried again (five tries in all, waiting one to
  // two seconds, then twice that each time, a minute at most), and so is a try that ran out of time. When every try failed,
  // the error that came most often is the one reported.
  // release() must be called when the answer has been read: until then the time limit is still running.
  async function open(path, body) {
    const errors = [];
    for (let n = 0; ; n++) {
      const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), TIMEOUT);
      if (timer.unref) timer.unref();
      let err, final = false;
      try {
        // the key travels in the x-goog-api-key header only: never in the address, the body or the log
        const res = await fetch(url(path), { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', 'x-server-timeout': String(Math.ceil(TIMEOUT / 1000)), 'x-goog-api-key': key() },
          body: body === undefined ? undefined : JSON.stringify(body), signal: ctl.signal });
        if (res.ok) return { res, release: () => clearTimeout(timer) };
        final = !AGAIN.includes(res.status);   // any other error answer is not tried again
        err = await failure(res);
      } catch (e) { err = e; }
      clearTimeout(timer);
      if (final || (err instanceof TypeError && !NETWORK.includes(err.message))) throw err;
      errors.push(err);
      if (n >= ATTEMPTS - 1) {
        const count = {}; let main = null, most = 0;
        for (const e of errors) { const m = e && e.message, c = count[m] = (count[m] || 0) + 1; if (c >= most) { main = e; most = c; } }
        throw main;
      }
      await sleep(Math.min(Math.round((Math.random() + 1) * 1000 * Math.pow(2, n)), 60000));
    }
  }
  const json = async (path, body) => { const { res, release } = await open(path, body); try { return await res.json(); } finally { release(); } };
  // an error sent inside an answer that began well
  function errorInside(text) {
    let j; try { j = JSON.parse(text); } catch { return; }
    if (j !== null && typeof j === 'object' && j.error !== null && typeof j.error === 'object' && typeof j.error.code === 'number' && j.error.code >= 400 && j.error.code < 600)
      throw new ApiError(ID, 'stream', 'got status: ' + j.error.status + '. ' + JSON.stringify(j), { status: j.error.code });
  }
  // the pieces of a streamed answer, as they arrive
  async function* pieces(path, body) {
    const { res, release } = await open(path, body);
    try {
      if (!res.body) throw new Error('Response body is empty');
      const dec = new TextDecoder('utf-8');
      let buf = '';
      for await (const chunk of res.body) {
        const text = dec.decode(chunk, { stream: true });
        errorInside(text);
        buf += text;
        for (;;) {
          let at = -1, len = 0;
          for (const d of ['\n\n', '\r\r', '\r\n\r\n']) { const i = buf.indexOf(d); if (i !== -1 && (at === -1 || i < at)) { at = i; len = d.length; } }
          if (at === -1) break;
          const event = buf.slice(0, at).trim();
          buf = buf.slice(at + len);
          if (!event.startsWith('data:')) continue;
          const data = event.slice(5).trim();
          errorInside(data);
          yield JSON.parse(data);
        }
      }
      if (buf.trim().length > 0) throw new Error('Incomplete JSON segment at the end');
    } finally { release(); }
  }

  // ---------- an answer that comes in several parts ----------
  // Google can stop part-way through a long answer and hand back a "continuationToken"; the same request sent again with that
  // token carries on from there. The parts are then joined: lists (the text) one after the other, counts added up, and for
  // everything else the later part's value. (Only what this file reads from an answer is certain to be joined as Google's SDK
  // joined it: the candidate's content and finish reason, the prompt feedback and the token counts.)
  const unfinished = why => why == null || why === 'CONTINUATION';
  const plain = v => typeof v === 'object' && v !== null && !Array.isArray(v);
  const joinUsage = (a, b) => !b ? a : !a ? b : join(a, b, 'usage');
  function join(a, b, what) {
    const out = {};
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const x = a[k], y = b[k];
      if (what === 'candidate' && (k === 'continuationToken' || k === 'finishReason' || k === 'finishMessage')) { if (y !== undefined) out[k] = y; }
      else if (!what && k === 'candidates' && Array.isArray(x)) {
        const ys = Array.isArray(y) ? y : [], n = ys.length ? Math.min(x.length, ys.length) : x.length;
        out[k] = [...x.slice(0, n).map((c, i) => join(c, ys[i] || {}, 'candidate')), ...x.slice(n), ...ys.slice(n)];
      }
      else if (k === 'usageMetadata') { const u = joinUsage(x, y); if (u !== undefined) out[k] = u; }
      else if (y == null) { if (x !== undefined) out[k] = x; }
      else if (x == null) out[k] = y;
      else if (typeof x === 'number' && typeof y === 'number' && (what === 'usage' || k === 'tokenCount' || k.endsWith('Count') || k.endsWith('Sum'))) out[k] = x + y;
      else if (Array.isArray(x) && Array.isArray(y)) out[k] = [...x, ...y];
      else if (plain(x) && plain(y)) out[k] = join(x, y, what === 'usage' ? 'usage' : undefined);
      else out[k] = y;
    }
    return out;
  }
  const withToken = (body, token) => token ? { ...body, continuationToken: token } : body;

  // an answer in one piece
  async function generate(model, body) {
    const all = [];
    for (let token; ;) {
      const r = await json('models/' + model + ':generateContent', withToken(body, token));
      all.push(r);
      const c = r.candidates && r.candidates[0];
      token = c && c.continuationToken && unfinished(c.finishReason) ? c.continuationToken : undefined;
      if (!token) break;
    }
    return all.reduce((a, b) => join(a, b));
  }
  // A streamed answer, piece by piece. When the stream ends with a token, or drops before saying it has finished, the request
  // is sent again from the latest token (a stream that dropped before giving anything is started again from where it began, at
  // most three times running). Token counts are per request, so each piece's count has the earlier requests' counts added.
  async function* stream(model, body) {
    let resume, reconnects = 0, usedBefore, lastError;
    for (;;) {
      const hop = { start: resume, token: undefined, finish: undefined, feedback: false, content: false, any: false, usage: undefined };
      let failed = null;
      try {
        for await (let piece of pieces('models/' + model + ':streamGenerateContent?alt=sse', withToken(body, resume))) {
          hop.any = true;
          if (piece.promptFeedback != null) hop.feedback = true;
          if (piece.usageMetadata) { if (usedBefore) piece = { ...piece, usageMetadata: joinUsage(usedBefore, piece.usageMetadata) }; hop.usage = piece.usageMetadata; }
          const c = piece.candidates && piece.candidates[0];
          if (c) {
            if (c.content && c.content.parts && c.content.parts.length > 0) hop.content = true;
            if (c.finishReason != null) hop.finish = c.finishReason;
            if (c.continuationToken) hop.token = c.continuationToken;
            else if (c.finishReason != null && !unfinished(c.finishReason)) hop.token = undefined;
            if (c.finishReason != null && hop.token && unfinished(c.finishReason)) delete c.finishReason;   // not the end: more follows
          }
          yield piece;
        }
      } catch (e) { failed = { error: e }; }
      if (hop.usage) usedBefore = hop.usage;
      // the time ran out, or the request itself was turned down: nothing to pick up
      if (failed && ((failed.error instanceof Error && failed.error.name === 'AbortError') || (isApi(failed.error, ID) && !hop.any))) throw failed.error;
      const further = hop.content || (!!hop.token && hop.token !== hop.start);
      if (failed) lastError = failed; else if (further) lastError = undefined;
      if (hop.finish !== undefined || hop.feedback) { resume = hop.finish === 'CONTINUATION' && !hop.feedback && hop.token && hop.token !== hop.start ? hop.token : undefined; reconnects = 0; }
      else if (hop.token && hop.token !== hop.start) { resume = hop.token; reconnects = 0; }
      else if (hop.content || reconnects >= RECONNECTS) resume = undefined;
      else { resume = hop.start; reconnects++; }
      if (resume && !hop.feedback && unfinished(hop.finish)) continue;
      if (failed) throw failed.error;
      if (hop.finish === undefined && !hop.feedback && lastError) throw lastError.error;
      return;
    }
  }

  // ---------- what the app asks for ----------
  const instruction = system => ({ parts: [{ text: system }], role: 'user' });
  async function ask({ model, system, user, schema, stream: streaming }) {
    const parts = typeof user === 'string' ? [{ text: user }] : user.map(p => p.image ? { inlineData: { mimeType: p.image.mime, data: p.image.data } } : { text: p.text });
    const req = { contents: [{ parts, role: 'user' }], systemInstruction: instruction(system), generationConfig: { responseMimeType: 'application/json', responseJsonSchema: schema } };
    if (!streaming) { const r = await generate(model, req); return { text: textOf(r), stop: stopOf(r), usage: usage(r.usageMetadata) }; }
    // long answers are streamed so the connection is not cut: the pieces are joined, and the last one says how it ended
    let text = '', stop = 'end', u = null;
    for await (const piece of stream(model, req)) {
      text += textOf(piece);
      const s = stopOf(piece);
      if (s !== 'end') stop = s;
      if (piece.usageMetadata) u = piece.usageMetadata;
    }
    return { text, stop, usage: usage(u) };
  }

  const say = (history, text) => { history.push({ role: 'user', parts: [{ text }] }); };
  async function chat({ model, system, tools, history }) {
    const r = await generate(model, { contents: history.map(c => ({ parts: c.parts, role: c.role })), systemInstruction: instruction(system),
      tools: [{ functionDeclarations: tools.map(t => ({ name: t.name, description: t.description, parametersJsonSchema: t.input_schema })) }], generationConfig: {} });
    const c = r.candidates && r.candidates[0];
    if (c && c.finishReason === 'MALFORMED_FUNCTION_CALL') throw new Error('Gemini tried to use one of the gallery’s tools but wrote the request wrongly. Send the message again.');
    if (c && c.content && c.content.parts && c.content.parts.length) history.push(c.content);   // unchanged, so its thought signatures stay valid
    else history.push({ role: 'model', parts: [{ text: '' }] });                                 // keeps the turns alternating when nothing came back
    const calls = partsOf(r).filter(p => p.functionCall).map(p => ({ id: p.functionCall.id, name: p.functionCall.name, input: p.functionCall.args || {} }));
    return { text: textOf(r), stop: stopOf(r), usage: usage(r.usageMetadata), calls };
  }
  const results = (history, list) => { history.push({ role: 'user', parts: list.map(r =>
    ({ functionResponse: { ...(r.id ? { id: r.id } : {}), name: r.name, response: r.out } })) }); };

  // Google's error text is a block of JSON; the sentence inside it is the useful part
  const ours = e => isApi(e, ID);
  const said = e => { try { const j = JSON.parse(e.message); return (j.error && j.error.message) || e.message; } catch { return e.message; } };
  const badKey = e => ours(e) && (e.status === 401 || (e.status === 400 && /api[ _]key/i.test(e.message)));
  // a failure with no answer at all (no connection, or it timed out) is not an error answer; ai.js marks whose request it was
  const offline = e => !(e instanceof ApiError) && e && e.aiProvider === 'google' && (e.name === 'TypeError' || e.name === 'AbortError' || /fetch failed|timed? ?out|network|ECONN|ENOTFOUND/i.test(e.message || ''));
  // Google answers 429 with status RESOURCE_EXHAUSTED both when requests come too fast and when the allowance is used up. Which
  // one is in the answer's details: a google.rpc.QuotaFailure lists the quota that was hit by its quotaId, and a per-day quota
  // (…PerDay…) means the day's allowance is gone, where a per-minute one means "slow down". The error carries only the status
  // and the answer's text, so the details are read from that text (JSON, sometimes after "got status: 429. ").
  const bodyOf = e => { const m = String((e && e.message) || ''), i = m.indexOf('{'); if (i < 0) return null; try { const j = JSON.parse(m.slice(i)); return (j && j.error) || null; } catch { return null; } };
  const quotas = e => { const b = bodyOf(e), out = []; for (const d of (b && Array.isArray(b.details) ? b.details : [])) if (d && /QuotaFailure$/.test(d['@type'] || '')) for (const v of Array.isArray(d.violations) ? d.violations : []) if (v && v.quotaId) out.push(String(v.quotaId)); return out; };
  const noCredit = e => ours(e) && e.status === 429 && quotas(e).some(q => /PerDay/i.test(q));
  const tooFast = e => ours(e) && e.status === 429 && !noCredit(e);
  // for the log: the status and Google's own code, never its message
  const tag = e => offline(e) ? { status: 0, code: 'connection' } : ours(e) ? { status: e.status || 0, code: [(bodyOf(e) || {}).status || '', ...quotas(e)].filter(Boolean).join('/') } : null;
  function explain(e) {
    if (noCredit(e)) return 'This Google account has used up its Gemini API allowance for today. A Gemini subscription does not add to it — set up billing in Google AI Studio, or try again tomorrow.';
    if (tooFast(e)) return 'Too many requests just now — wait a minute and try again.';
    if (offline(e)) return 'Could not reach Google — check the internet connection.';
    if (!ours(e)) return null;
    if (badKey(e)) return 'Google did not accept the API key. Check the Gemini key in settings.';
    if (e.status === 403) return 'This Google API key is not allowed to use that model. Pick another model in settings.';
    if (e.status === 404) return 'Google does not know that model. Pick another one in settings.';
    if (e.status === 400) return 'Google rejected the request: ' + said(e);
    return 'Google returned an error (' + (e.status || 'unknown') + '). Try again in a moment.';
  }
  const fatal = e => offline(e) || (ours(e) && (badKey(e) || [403, 404, 429].includes(e.status)));

  return {
    id: ID, label: 'Gemini', company: 'Google',
    models: {
      'gemini-3.8-flash': { label: 'Gemini 3.8 Flash — fastest' },
      'gemini-4-argon': { label: 'Gemini 4 Argon — balanced' },
      'gemini-4-carbon': { label: 'Gemini 4 Carbon — thorough' },
    },
    noKey: 'Add your Google API key in settings first — the model chosen for this job is a Gemini one.',
    keyLooksWrong: k => k.length < 20 || /\s/.test(k) || /^sk-/.test(k),
    reset: () => {},
    ask, say, chat, results, explain, fatal, tag,
    check: async () => { await json('models?pageSize=1'); },
    rejected: e => badKey(e) || (ours(e) && e.status === 403),
  };
};
