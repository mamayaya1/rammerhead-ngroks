import exitHook from "async-exit-hook";
import dotenv from "dotenv";
import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import serveStatic from "serve-static";
import ngrok from "@ngrok/ngrok";
import RammerheadProxy from "rammerhead/src/classes/RammerheadProxy.js";
import RammerheadLogging from "rammerhead/src/classes/RammerheadLogging.js";
import RammerheadSessionFileCache from "rammerhead/src/classes/RammerheadSessionFileCache.js";
import generateId from "rammerhead/src/util/generateId.js";
import StrShuffler from "rammerhead/src/util/StrShuffler.js";
import getSessionId from "rammerhead/src/util/getSessionId.js";

dotenv.config({ path: fileURLToPath(new URL("../.env", import.meta.url)) });

process.env.PORT ||= "8080";
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const serveStaticFiles = serveStatic(fileURLToPath(new URL("../static/", import.meta.url)));

function resolveHostDetails(req) {
  const hostHeader = req.headers["x-forwarded-host"] || req.headers["host"] || "localhost";
  const firstHost = hostHeader.split(",")[0].trim();
  const [cleanHost = "localhost", explicitPort] = firstHost.split(":");
  const isLocal = ["localhost", "127.0.0.1", "::1"].includes(cleanHost);

  return {
    protocol: isLocal ? "http:" : "https:",
    hostname: cleanHost,
    port: isLocal ? Number(explicitPort) || Number(process.env.PORT) || 8080 : 443,
    isLocal
  };
}

const logger = new RammerheadLogging({ logLevel: "error" });
const rh = new RammerheadProxy({
  port: Number(process.env.PORT),
  crossDomainPort: null,
  dontListen: true,
  logger,
  getServerInfo: (req) => {
    const info = resolveHostDetails(req);
    return {
      hostname: info.hostname,
      port: info.port,
      crossDomainPort: null,
      crossProtoRedirect: !info.isLocal,
      protocol: info.protocol
    };
  }
});
const sessionDirectory = fileURLToPath(new URL("../sessions/", import.meta.url));
mkdirSync(sessionDirectory, { recursive: true });
const sessionStore = new RammerheadSessionFileCache({ logger, saveDirectory: sessionDirectory });
sessionStore.attachToProxy(rh);
exitHook(() => {
  sessionStore.close();
  rh.close();
});

function registerSessionRoute(paths, handler) {
  for (const path of paths) rh.GET(path, handler);
}

function getSessionParams(req) {
  return new URL(req.url, "http://localhost").searchParams;
}

function authorizeSessionRequest(req, res) {
  const password = process.env.RAMMERHEAD_PASSWORD;
  if (!password || getSessionParams(req).get("pwd") === password) return true;
  res.statusCode = 403;
  res.end("Forbidden");
  return false;
}

function getClientAddress(req) {
  return req.socket && req.socket.remoteAddress || "";
}

registerSessionRoute(["/needpassword", "/api/needpassword"], (_req, res) => {
  res.end(process.env.RAMMERHEAD_PASSWORD ? "true" : "false");
});

registerSessionRoute(["/newsession", "/api/newsession"], (req, res) => {
  if (!authorizeSessionRequest(req, res)) return;
  const id = generateId();
  const session = sessionStore.add(id);
  session.data.restrictIP = getClientAddress(req);
  sessionStore.addSerializedSession(id, session.serializeSession());
  res.end(id);
});

registerSessionRoute(["/sessionexists", "/api/sessionexists"], (req, res) => {
  const id = getSessionParams(req).get("id");
  if (!id) {
    res.statusCode = 400;
    return res.end("Must specify id parameter");
  }
  res.end(sessionStore.has(id) ? "exists" : "not found");
});

registerSessionRoute(["/deletesession", "/api/deletesession"], (req, res) => {
  if (!authorizeSessionRequest(req, res)) return;
  const id = getSessionParams(req).get("id");
  if (!id || !sessionStore.has(id)) return res.end("not found");
  sessionStore.delete(id);
  res.end("Success");
});

registerSessionRoute(["/editsession", "/api/editsession"], (req, res) => {
  if (!authorizeSessionRequest(req, res)) return;
  const params = getSessionParams(req);
  const id = params.get("id");
  if (!id || !sessionStore.has(id)) {
    res.statusCode = 400;
    return res.end("not found");
  }

  const session = sessionStore.get(id);
  let httpProxy = params.get("httpProxy");
  if (httpProxy && httpProxy.startsWith("http://")) httpProxy = httpProxy.slice(7);
  session.externalProxySettings = httpProxy || null;

  const enableShuffling = params.get("enableShuffling");
  if (enableShuffling === "1" && !session.shuffleDict) {
    session.shuffleDict = StrShuffler.generateDictionary();
  } else if (enableShuffling === "0") {
    session.shuffleDict = null;
  }
  res.end("Success");
});

registerSessionRoute(["/api/shuffleDict"], (req, res) => {
  const id = getSessionParams(req).get("id");
  const session = id && sessionStore.get(id);
  if (!session) {
    res.statusCode = 400;
    return res.end("Invalid session id");
  }
  res.end(JSON.stringify(session.shuffleDict) || "");
});

rh.addToOnRequestPipeline((req, res, _serverInfo, isRoute, isWebsocket) => {
  if (isRoute) return;
  const sessionId = getSessionId(req.url) || getSessionId(req.headers.referer);
  const session = sessionId && sessionStore.get(sessionId);
  if (session && session.data.restrictIP && session.data.restrictIP !== getClientAddress(req)) {
    if (!isWebsocket) res.writeHead(403);
    res.end("Sessions must come from the same IP");
    return true;
  }
});

const rammerheadScopes = [
  "/rammerhead.js",
  "/hammerhead.js",
  "/transport-worker.js",
  "/task.js",
  "/iframe-task.js",
  "/worker-hammerhead.js",
  "/messaging",
  "/sessionexists",
  "/deletesession",
  "/newsession",
  "/editsession",
  "/needpassword",
  "/syncLocalStorage",
  "/api/dictionary",
  "/api/shuffleDict",
  "/api/sessionexists",
  "/api/deletesession",
  "/api/newsession",
  "/api/editsession",
  "/api/needpassword"
];

function shouldRouteRh(req) {
  const url = new URL(req.url, `http://${req.headers["host"] || "localhost"}`);
  if (url.pathname.startsWith("/.well-known")) return false;
  if (rammerheadScopes.includes(url.pathname)) return true;

  const firstSegment = url.pathname.split("/")[1] || "";
  const sessionId = firstSegment.split("!")[0];
  return /^[a-z0-9]{32}$/i.test(sessionId);
}

const EARLY_PATCH_SCRIPT = `
(function() {
  'use strict';

  function attachCEL(obj) {
    if (!obj || typeof obj.addChangeEventListener === 'function') return;
    try {
      Object.defineProperty(obj, 'addChangeEventListener', {
        value: function(fn) {
          if (!this.__rhEvs) Object.defineProperty(this, '__rhEvs', {
            value: [], writable: true, configurable: true, enumerable: false
          });
          this.__rhEvs.push(fn);
        },
        enumerable: false, configurable: true, writable: true
      });
      Object.defineProperty(obj, 'removeChangeEventListener', {
        value: function(fn) {
          if (this.__rhEvs) this.__rhEvs = this.__rhEvs.filter(function(f) { return f !== fn; });
        },
        enumerable: false, configurable: true, writable: true
      });
    } catch (e) {}
  }

  attachCEL(Object.prototype);
  if (typeof Storage !== 'undefined') attachCEL(Storage.prototype);

  try {
    var _NP = window.Proxy;
    window.Proxy = new _NP(_NP, {
      construct: function(target, args) {
        var handler = args[1];
        if (handler) {
          var _og = handler.get;
          handler.get = function(t, prop, recv) {
            if (prop === 'addChangeEventListener') return function(fn) { (t.__rhEvs = t.__rhEvs || []).push(fn); };
            if (prop === 'removeChangeEventListener') return function(fn) { if (t.__rhEvs) t.__rhEvs = t.__rhEvs.filter(function(f) { return f !== fn; }); };
            return _og ? _og.apply(this, arguments) : Reflect.get(t, prop, recv);
          };
        }
        var p = Reflect.construct(target, args);
        attachCEL(p);
        return p;
      }
    });
  } catch (e) { console.warn('[RH-PATCH] Proxy intercept failed:', e); }

  try { Object.defineProperty(navigator, 'onLine', { value: true, configurable: true }); } catch (e) {}

  var _origPM = window.postMessage;
  window.postMessage = function(msg, targetOrigin, transfer) {
    try {
      if (transfer && transfer.length) return _origPM.call(window, msg, targetOrigin || '*', transfer);
      return _origPM.call(window, msg, targetOrigin || '*');
    } catch (e) {
      try { _origPM.call(window, msg, targetOrigin || '*'); } catch (e2) {}
    }
  };

  var _origMatch = String.prototype.match;
  String.prototype.match = function(pattern) { return _origMatch.call(this == null ? '' : this, pattern); };
  var _origExec = RegExp.prototype.exec;
  RegExp.prototype.exec = function(str) { return _origExec.call(this, str == null ? '' : str); };
  var _origTest = RegExp.prototype.test;
  RegExp.prototype.test = function(str) { return _origTest.call(this, str == null ? '' : str); };

  try {
    var _origEval = window.eval;
    window.eval = function(code) {
      try { return _origEval.call(window, code); }
      catch (e) { console.warn('[RH-PATCH] eval blocked:', e.message); return undefined; }
    };
  } catch (e) {}

  if (typeof performance === 'undefined' || typeof performance.now !== 'function') {
    window.performance = { now: function() { return Date.now(); } };
  }

  if (typeof BroadcastChannel === 'undefined') {
    window.BroadcastChannel = function(name) {
      this.name = name; this.onmessage = null;
      this.postMessage = function() {}; this.close = function() {};
    };
  }

  console.log('[RH-EARLY-PATCH] All patches applied.');
})();
`;

const HAMMERHEAD_POLYFILL = `
(function() {
  var sessionMatch = location.pathname.match(/^\\/([a-z0-9]{32})(?:\\/|$)/i);
  if (sessionMatch && typeof BroadcastChannel !== 'undefined') {
    var diagnosticChannel = new BroadcastChannel('rammerhead-console:' + sessionMatch[1]);
    var diagnosticTabId = Math.random().toString(36).slice(2, 8);
    var reportDiagnostic = function(type, message) {
      diagnosticChannel.postMessage({
        type: type,
        message: String(message).slice(0, 500),
        tabId: diagnosticTabId,
        title: document.title || 'Proxy tab',
        url: location.href
      });
    };
    reportDiagnostic('info', 'Proxy tab connected');
    window.addEventListener('load', function() {
      reportDiagnostic('info', 'Page loaded');
    });
    window.addEventListener('error', function(event) {
      var target = event.target;
      var message = event.message || (target && (target.src || target.href)
        ? 'Failed to load ' + (target.src || target.href)
        : 'An uncaught page error occurred');
      reportDiagnostic('error', message);
    }, true);
    window.addEventListener('unhandledrejection', function(event) {
      var reason = event.reason;
      reportDiagnostic('error', reason && reason.message ? reason.message : String(reason));
    });
  }

  var _oF = window.fetch;
  if (_oF) {
    window.fetch = function(url, opts) {
      var s = typeof url === 'string' ? url : (url && url.href) || '';
      if (s.includes('doubleclick.net') || s.includes('googleadservices.com') || s.includes('googlesyndication.com')) {
        return Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return _oF.apply(this, arguments);
    };
  }

  var _oX = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    if (typeof url === 'string' && (url.includes('doubleclick.net') || url.includes('googleadservices.com'))) {
      this.send = function() {
        Object.defineProperty(this, 'readyState', { value: 4 });
        Object.defineProperty(this, 'status', { value: 200 });
        Object.defineProperty(this, 'responseText', { value: '{}' });
        this.dispatchEvent(new Event('load'));
      };
      return;
    }
    return _oX.apply(this, arguments);
  };

  var isMobileSafari = /iPhone|iPad|iPod/i.test(navigator.userAgent);
  if (isMobileSafari) {
    if (typeof window.onwheel === 'undefined') window.onwheel = null;
    var _origAEL = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function(type, fn, opts) {
      if (type === 'touchstart' || type === 'touchmove' || type === 'wheel') {
        if (opts === undefined || opts === false) opts = { passive: true };
        else if (typeof opts === 'object' && opts.passive === undefined) opts.passive = true;
      }
      return _origAEL.call(this, type, fn, opts);
    };
  }

  var _oPM = window.postMessage;
  window.postMessage = function(msg, origin, transfer) {
    try {
      if (transfer && transfer.length) return _oPM.call(window, msg, origin || '*', transfer);
      return _oPM.call(window, msg, origin || '*');
    } catch (e) { try { _oPM.call(window, msg, '*'); } catch (e2) {} }
  };
})();
`;

const IFRAME_TASK_POLYFILL = `
(function() {
  'use strict';

  function attachCEL(obj) {
    if (!obj || typeof obj.addChangeEventListener === 'function') return;
    try {
      Object.defineProperty(obj, 'addChangeEventListener', {
        value: function(fn) {
          if (!this.__rhEvs) Object.defineProperty(this, '__rhEvs', {
            value: [], writable: true, configurable: true, enumerable: false
          });
          this.__rhEvs.push(fn);
        },
        enumerable: false, configurable: true, writable: true
      });
      Object.defineProperty(obj, 'removeChangeEventListener', {
        value: function(fn) {
          if (this.__rhEvs) this.__rhEvs = this.__rhEvs.filter(function(f) { return f !== fn; });
        },
        enumerable: false, configurable: true, writable: true
      });
    } catch (e) {}
  }

  attachCEL(Object.prototype);
  if (typeof Storage !== 'undefined') attachCEL(Storage.prototype);

  if (typeof window !== 'undefined' && window.postMessage) {
    var _pm = window.postMessage;
    window.postMessage = function(msg, origin, transfer) {
      try {
        return transfer && transfer.length
          ? _pm.call(window, msg, origin || '*', transfer)
          : _pm.call(window, msg, origin || '*');
      } catch (e) { try { _pm.call(window, msg, origin || '*'); } catch (e2) {} }
    };
  }

  var _om = String.prototype.match;
  String.prototype.match = function(p) { return _om.call(this == null ? '' : this, p); };
  var _oe = RegExp.prototype.exec;
  RegExp.prototype.exec = function(s) { return _oe.call(this, s == null ? '' : s); };
  var _ot = RegExp.prototype.test;
  RegExp.prototype.test = function(s) { return _ot.call(this, s == null ? '' : s); };
})();
`;

function injectBeforeScript(res, injection) {
  const _write = res.write.bind(res);
  const _end = res.end.bind(res);
  let done = false;

  const _origSet = res.setHeader.bind(res);
  res.setHeader = function(name, value) {
    const n = name.toLowerCase();
    if (n === "content-length") return;
    if (n === "content-encoding") return _origSet(name, "identity");
    return _origSet(name, value);
  };

  res.writeHead = function(code, headers) {
    if (headers) {
      delete headers["content-length"];
      delete headers["Content-Length"];
      headers["content-encoding"] = "identity";
    }
    return Object.getPrototypeOf(res).writeHead.apply(res, arguments);
  };

  const prepend = (chunk) => {
    const prefix = Buffer.from(injection, "utf-8");
    if (!chunk) return prefix;
    const body = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf-8");
    return Buffer.concat([prefix, body]);
  };

  res.write = function(chunk, enc, cb) {
    if (!done) {
      done = true;
      return _write(prepend(chunk), enc, cb);
    }
    return _write(chunk, enc, cb);
  };

  res.end = function(chunk, enc, cb) {
    if (!done) {
      done = true;
      if (typeof chunk === "function") {
        cb = chunk;
        chunk = null;
        enc = null;
      } else if (typeof enc === "function") {
        cb = enc;
        enc = null;
      }
      return _end(prepend(chunk), enc || "utf-8", cb);
    }
    return _end(chunk, enc, cb);
  };
}

const server = createServer((req, res) => {
  if (req.url === "/mainport") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    return res.end(String(process.env.PORT || 8080));
  }

  if (req.url === "/debug") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({
      nodeVersion: process.version,
      socketEncrypted: !!(req.socket && req.socket.encrypted),
      xForwardedProto: req.headers["x-forwarded-proto"],
      xForwardedHost: req.headers["x-forwarded-host"],
      host: req.headers["host"],
      userAgent: req.headers["user-agent"],
      remoteAddress: req.socket && req.socket.remoteAddress
    }, null, 2));
  }

  if (req.url === "/rh-early-patch.js") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/javascript");
    res.setHeader("Cache-Control", "no-store");
    return res.end(EARLY_PATCH_SCRIPT);
  }

  if (shouldRouteRh(req)) {
    const info = resolveHostDetails(req);
    const _rhOrigSetHeader = res.setHeader.bind(res);
    const _blockedHeaders = new Set([
      "content-security-policy",
      "content-security-policy-report-only",
      "x-frame-options",
      "x-xss-protection",
      "cross-origin-opener-policy",
      "cross-origin-embedder-policy",
      "cross-origin-resource-policy",
      "permissions-policy"
    ]);

    res.setHeader = function(name, value) {
      if (_blockedHeaders.has(name.toLowerCase())) return;
      return _rhOrigSetHeader(name, value);
    };

    const _rhOrigWriteHead = res.writeHead.bind(res);
    res.writeHead = function(code, headers) {
      if (headers) {
        for (const key of Object.keys(headers)) {
          if (_blockedHeaders.has(key.toLowerCase())) delete headers[key];
        }
      }
      return _rhOrigWriteHead(code, headers);
    };

    _rhOrigSetHeader("Access-Control-Allow-Origin", "*");
    _rhOrigSetHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS, HEAD");
    _rhOrigSetHeader("Access-Control-Allow-Headers", "*");
    _rhOrigSetHeader("Access-Control-Allow-Credentials", "true");

    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      return res.end();
    }

    if (!info.isLocal) {
      req.headers["x-forwarded-proto"] = "https";
      const forceEncrypted = (obj) => {
        if (!obj) return;
        try { Object.defineProperty(obj, "encrypted", { get: () => true, configurable: true }); } catch (e) {}
      };
      forceEncrypted(req.socket);
      forceEncrypted(req.connection);
      if (req.socket && req.socket.socket) forceEncrypted(req.socket.socket);
    }

    const forwardedHost = req.headers["x-forwarded-host"];
    if (forwardedHost) req.headers["host"] = forwardedHost.split(",")[0].trim();

    const p = req.url;
    if (/\/hammerhead\.js(\?|$)/.test(p)) {
      injectBeforeScript(res, HAMMERHEAD_POLYFILL);
    } else if (/\/iframe-task\.js(\?|$)/.test(p)) {
      injectBeforeScript(res, IFRAME_TASK_POLYFILL);
    }

    rh._onRequest(req, res, rh.server1Info).catch((err) => {
      console.error("Rammerhead request failed:", err);
      if (res.headersSent) res.destroy(err);
      else {
        res.statusCode = 500;
        res.end("Internal Server Error");
      }
    });
    return;
  }

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cross-Origin-Opener-Policy", "unsafe-none");
  res.setHeader("Cross-Origin-Embedder-Policy", "unsafe-none");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");

  serveStaticFiles(req, res, () => {
    res.statusCode = 404;
    res.end("Not Found");
  });
});


server.on("upgrade", (req, socket, head) => {
  const info = resolveHostDetails(req);
  if (!info.isLocal) {
    req.headers["x-forwarded-proto"] = "https";
    const forceEncrypted = (obj) => {
      if (!obj) return;
      try { Object.defineProperty(obj, "encrypted", { get: () => true, configurable: true }); } catch (e) {}
    };
    forceEncrypted(socket);
    forceEncrypted(req.socket);
    forceEncrypted(req.connection);
  }

  const forwardedHost = req.headers["x-forwarded-host"];
  if (forwardedHost) req.headers["host"] = forwardedHost.split(",")[0].trim();

  if (shouldRouteRh(req)) {
    rh._onUpgradeRequest(req, socket, head, rh.server1Info).catch((err) => {
      console.error("Rammerhead WebSocket upgrade failed:", err);
      socket.destroy();
    });
  } else {
    socket.end();
  }
});

server.on("listening", async () => {
  const addr = server.address();
  if (!addr || typeof addr.port !== "number") return;

  console.log(`Server running on port ${addr.port}`);
  console.log(`Local: http://localhost:${addr.port}`);

  if (!process.env.NGROK_AUTHTOKEN) {
    console.log("NGROK_AUTHTOKEN not set; add it to the project .env file or environment to enable the public tunnel.");
    return;
  }

  try {
    const listener = await ngrok.connect({
      proto: "http",
      addr: addr.port,
      authtoken: process.env.NGROK_AUTHTOKEN
    });
    console.log("\n=============================================");
    console.log(`Public Internet URL: ${listener.url()}`);
    console.log("=============================================\n");
  } catch (err) {
    console.error("ngrok tunnel failed:", err.message || err);
    console.log("Make sure NGROK_AUTHTOKEN is valid in your .env file or system environment.");
  }
});

server.listen({ port: Number(process.env.PORT), host: "::", ipv6Only: false });
