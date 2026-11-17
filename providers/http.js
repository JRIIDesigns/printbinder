'use strict';
// What the three provider files share. Each talks to its service with plain HTTPS requests (Node's own fetch) and no SDK;
// this file holds the parts that are the same for all three: one kind of error, one request with the retry rules the
// Anthropic and OpenAI SDKs applied, and a reader for answers that arrive as a stream of events.
// A key is only ever put into a request header by the provider file. Nothing here logs it, keeps it or puts it in an address.

// An answer that was an error, or no answer at all.
//   provider   'anthropic' | 'openai' | 'google'
//   kind       'status'      the service answered with an HTTP error (status is set)
//              'stream'      the error arrived inside a streamed answer
//              'connection'  no answer: the service could not be reached          'timeout'  no answer in time
//   status     the HTTP status; undefined when there was no answer
//   type/code  the service's own words for the error, where it gives them (each provider file says which fields these are)
class ApiError extends Error {
  constructor(provider, kind, message, more) {
    super(message);
    this.name = 'ApiError';
    this.provider = provider;
    this.kind = kind;
    this.status = undefined;
    Object.assign(this, more);
  }
}
const isApi = (e, provider) => e instanceof ApiError && e.provider === provider;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// The wording both SDKs gave an error answer: the status, then the service's message (or the whole answer when it has none).
function wording(status, error, text) {
  const msg = error && error.message ? (typeof error.message === 'string' ? error.message : JSON.stringify(error.message)) : error ? JSON.stringify(error) : text;
  if (status && msg) return status + ' ' + msg;
  if (status) return status + ' status code (no body)';
  return msg || '(no status code or body)';
}

// One request, tried again the way the Anthropic and OpenAI SDKs tried again (both are made by the same generator):
//   * no answer (no connection, or none within "timeout")  -> again, until "retries" further tries are used up
//   * 408, 409, 429 and 5xx                                 -> again, unless the answer's x-should-retry header says otherwise
//   * the wait is what the answer asks for (retry-after-ms, retry-after) when "honour" accepts it, otherwise half a second
//     doubling to eight seconds, less up to a quarter at random
// "timeout" covers the time until the answer begins, as it did in the SDKs.
//   errorOf(status, json, text)  makes the error for an error answer: json is the parsed answer, or text when it was not JSON
// Returns the fetch Response of a successful answer.
async function send({ provider, url, method = 'POST', headers, body, timeout = 600000, retries = 0, honour, errorOf }) {
  for (let tried = 0; ; tried++) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), timeout);
    let res = null, down = null;
    try { res = await fetch(url, { method, headers, body, signal: ctl.signal }); } catch (e) { down = e || new Error('fetch failed'); } finally { clearTimeout(timer); }
    if (down) {
      if (tried < retries) { await sleep(backoff(tried)); continue; }
      const timedOut = down.name === 'AbortError' || /timed? ?out/i.test(String(down) + (typeof down === 'object' && 'cause' in down ? String(down.cause) : ''));
      throw new ApiError(provider, timedOut ? 'timeout' : 'connection', timedOut ? 'Request timed out.' : 'Connection error.', { cause: down });
    }
    if (res.ok) return res;
    const hint = res.headers.get('x-should-retry');
    const again = hint === 'true' ? true : hint === 'false' ? false : res.status === 408 || res.status === 409 || res.status === 429 || res.status >= 500;
    if (again && tried < retries) {
      try { if (res.body) await res.body.cancel(); } catch {}
      await sleep(asked(res.headers, honour) ?? backoff(tried));
      continue;
    }
    const text = await res.text().catch(e => String((e && e.message) || e));
    let json; try { json = JSON.parse(text); } catch {}
    throw errorOf(res.status, json || undefined, json ? undefined : text);
  }
}
const backoff = tried => Math.min(0.5 * Math.pow(2, tried), 8) * (1 - Math.random() * 0.25) * 1000;
// how long the answer asks to wait, in milliseconds; undefined when it does not say, or says something "honour" turns down
function asked(headers, honour) {
  let ms;
  const a = headers.get('retry-after-ms');
  if (a) { const n = parseFloat(a); if (!Number.isNaN(n)) ms = n; }
  const b = headers.get('retry-after');
  if (b && !ms) { const s = parseFloat(b); ms = Number.isNaN(s) ? Date.parse(b) - Date.now() : s * 1000; }
  return ms !== undefined && honour(ms) ? ms : undefined;
}

// The events of a streamed answer (server-sent events), one { event, data } at a time. data is the text after "data:"; when
// an event has several such lines they are joined with a new line. Lines may end in \n, \r\n or \r.
//   flush   also give an event the stream ended in the middle of (no blank line after it)
async function* events(res, { flush = false } = {}) {
  if (!res.body) throw new Error('Attempted to iterate over a response with no body');
  const dec = new TextDecoder('utf-8', { ignoreBOM: true });
  let text = '', event = null, data = [];
  const take = line => {
    if (line.charCodeAt(0) === 0xfeff) line = line.slice(1);
    if (!line) {   // a blank line ends the event
      if (!event && !data.length) return null;
      const sse = { event, data: data.join('\n') };
      event = null; data = [];
      return sse;
    }
    const colon = line.indexOf(':');
    if (colon === 0) return null;   // a comment
    const field = colon === -1 ? line : line.slice(0, colon);
    if (field !== 'event' && field !== 'data') return null;
    const value = colon === -1 ? '' : line.slice(line.charCodeAt(colon + 1) === 0x20 ? colon + 2 : colon + 1);
    if (field === 'event') event = value; else data.push(value);
    return null;
  };
  for await (const chunk of res.body) {
    text += dec.decode(chunk, { stream: true });
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c !== '\n' && c !== '\r') continue;
      if (c === '\r' && i + 1 === text.length) break;   // the \n of a \r\n may be in the next piece
      const sse = take(text.slice(start, i));
      if (c === '\r' && text[i + 1] === '\n') i++;
      start = i + 1;
      if (sse) yield sse;
    }
    text = text.slice(start);
  }
  text += dec.decode();
  if (text) for (const line of text.replace(/\r$/, '').split(/\r\n|[\n\r]/)) { const sse = take(line); if (sse) yield sse; }
  if (flush) { const sse = take(''); if (sse) yield sse; }
}

module.exports = { ApiError, isApi, send, events, wording, sleep };
