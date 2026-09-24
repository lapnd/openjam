// Firefox capture lane. Firefox has no chrome.debugger, so this is the inject
// lane (MAIN-world page probe: console, errors, fetch/XHR with bodies; viewport
// screenshots via tabs.captureVisibleTab; device info from the relay) plus the
// one thing Firefox offers that Chrome's inject fallback does not: the
// webRequest API, which lists every other load the tab makes — documents,
// scripts, stylesheets, images, fonts, sub-frames — with status, headers and
// timing. fetch/XHR stay with the probe (it also has their bodies); webRequest
// reports them as type "xmlhttprequest", which is skipped here so nothing is
// listed twice. Bodies of the other loads would need a blocking
// webRequest.filterResponseData listener; OpenJam does not ask for that.
import { KIND } from "../../event-kinds.js";
import { createInjectLane } from "../../src/lanes/inject.js";

const HANDLED_BY_PROBE = "xmlhttprequest";

// webRequest headers are [{name, value}]; the timeline stores {name: value}.
export function headersToObject(list) {
  const out = {};
  for (const h of list || []) {
    if (h.value === undefined) continue; // binaryValue-only headers carry no text
    const k = h.name.toLowerCase();
    out[k] = k in out ? out[k] + ", " + h.value : h.value;
  }
  return out;
}

// "HTTP/1.1 404 Not Found" -> "Not Found"
function statusTextOf(statusLine) {
  return String(statusLine || "").replace(/^HTTP\/\S+\s+\d+\s*/, "");
}

// Events for the tab's webRequest traffic. `api` is chrome.webRequest.
export function createWebRequestNetwork({ api, pushEvent }) {
  const open = new Map(); // webRequest requestId -> timeline event (ids repeat across redirects)
  let listeners = [];

  function finish(event, d) {
    const detail = event.detail;
    if (detail.status == null && d.statusCode) {
      detail.status = d.statusCode;
      detail.statusText = statusTextOf(d.statusLine);
    }
    detail.durationMs = Math.max(0, Math.round(d.timeStamp - event.t));
    const length = detail.responseHeaders && Number(detail.responseHeaders["content-length"]);
    detail.encodedBytes = Number.isFinite(length) ? length : null;
  }

  const handlers = {
    onBeforeRequest(d) {
      if (d.type === HANDLED_BY_PROBE) return;
      open.set(
        d.requestId,
        pushEvent({
          t: d.timeStamp,
          kind: KIND.NETWORK,
          title: d.method + " " + d.url,
          detail: {
            requestId: "wr-" + d.requestId,
            method: d.method,
            url: d.url,
            resourceType: d.type,
            requestHeaders: {},
            requestBody: null,
            status: null,
            statusText: null,
            mimeType: null,
            responseHeaders: null,
            durationMs: null,
            encodedBytes: null,
            failed: false,
          },
        }),
      );
    },
    onSendHeaders(d) {
      const event = open.get(d.requestId);
      if (event) event.detail.requestHeaders = headersToObject(d.requestHeaders);
    },
    onHeadersReceived(d) {
      const event = open.get(d.requestId);
      if (!event) return;
      const headers = headersToObject(d.responseHeaders);
      Object.assign(event.detail, {
        status: d.statusCode,
        statusText: statusTextOf(d.statusLine),
        responseHeaders: headers,
        mimeType: headers["content-type"] ? headers["content-type"].split(";")[0].trim() : null,
        remoteAddress: d.ip || null,
        fromCache: !!d.fromCache,
      });
    },
    onBeforeRedirect(d) {
      const event = open.get(d.requestId);
      if (!event) return;
      event.detail.redirectUrl = d.redirectUrl;
      finish(event, d);
      open.delete(d.requestId); // the redirect target reuses this requestId
    },
    onCompleted(d) {
      const event = open.get(d.requestId);
      if (!event) return;
      finish(event, d);
      open.delete(d.requestId);
    },
    onErrorOccurred(d) {
      const event = open.get(d.requestId);
      if (!event) return;
      Object.assign(event.detail, { failed: true, errorText: d.error, canceled: /ABORT/i.test(d.error || "") });
      event.title = "FAILED " + event.detail.url;
      finish(event, d);
      open.delete(d.requestId);
    },
  };
  // Only the events that carry headers need to opt into them.
  const EXTRA = { onSendHeaders: ["requestHeaders"], onHeadersReceived: ["responseHeaders"] };

  return {
    start(tabId) {
      this.stop();
      const filter = { urls: ["<all_urls>"], tabId };
      for (const [name, fn] of Object.entries(handlers)) {
        // Firefox rejects an explicit `undefined` extraInfoSpec, so only pass it when set.
        api[name].addListener(...[fn, filter, EXTRA[name]].filter((a) => a !== undefined));
        listeners.push([name, fn]);
      }
    },
    stop() {
      for (const [name, fn] of listeners) api[name].removeListener(fn);
      listeners = [];
      open.clear();
    },
  };
}

export function createFirefoxLane(deps) {
  const inject = createInjectLane(deps);
  const network = createWebRequestNetwork({ api: chrome.webRequest, pushEvent: deps.pushEvent });
  return {
    ...inject,
    name: "firefox",
    async start(tabId) {
      try {
        network.start(tabId);
      } catch (err) {
        // A lane that throws here would leave the session half-started; record
        // what the probe can see and say what is missing instead.
        network.stop();
        deps.pushEvent({ t: Date.now(), kind: KIND.LOG, level: "warning", title: "Network capture of non-fetch/XHR loads unavailable", detail: { message: String(err) } });
      }
      await inject.start(tabId);
    },
    async stop(tabId) {
      network.stop();
      await inject.stop(tabId);
    },
  };
}
