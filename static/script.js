// 1. ALL IMPORTS MUST BE AT THE ABSOLUTE TOP OF THE FILE
import StrShuffler from './lib/StrShuffler.js';
import Api from './lib/api.js';

function reportConsoleEvent(level, message) {
    var list = document.getElementById('console-events');
    var empty = document.getElementById('console-empty');
    if (!list || !empty) return;

    var item = document.createElement('li');
    var time = document.createElement('time');
    time.className = 'console-event-time';
    time.textContent = new Date().toLocaleTimeString();
    item.dataset.level = level;
    item.appendChild(time);
    item.appendChild(document.createTextNode(String(message).slice(0, 500)));
    list.prepend(item);

    while (list.children.length > 20) list.lastElementChild.remove();
    empty.hidden = list.children.length > 0;
}

// 2. POLYFILL RUNS DIRECTLY AFTER IMPORTS
// 
(function() {
  const patchObject = (obj) => {
    if (!obj) return;
    try {
      if (!obj.hasOwnProperty('addChangeEventListener') && !obj.addChangeEventListener) {
        Object.defineProperty(obj, 'addChangeEventListener', {
          value: function(f) { 
            if (!this._evs) this._evs = [];
            if (!this._evs.includes(f)) this._evs.push(f); 
          },
          writable: true, enumerable: false, configurable: true
        });
      }
      if (!obj.hasOwnProperty('removeChangeEventListener') && !obj.removeChangeEventListener) {
        Object.defineProperty(obj, 'removeChangeEventListener', {
          value: function(f) { 
            if (this._evs) this._evs = this._evs.filter(x => x !== f); 
          },
          writable: true, enumerable: false, configurable: true
        });
      }
    } catch(e) {}
  };

  patchObject(Object.prototype);
  patchObject(EventTarget.prototype);
  if (typeof Node !== 'undefined') patchObject(Node.prototype);
  if (typeof Element !== 'undefined') patchObject(Element.prototype);
  patchObject(window);
})();

function setError(err) {
    var element = document.getElementById('error-text');
    if (err) {
        element.style.display = 'block';
        var message = err.message || String(err);
        element.textContent = 'An error occurred: ' + message;
        reportConsoleEvent('error', message);
    } else {
        element.style.display = 'none';
        element.textContent = '';
    }
}

window.addEventListener('error', function (event) {
    var target = event.target;
    var message = event.message || (target && (target.src || target.href)
        ? 'Failed to load ' + (target.src || target.href)
        : 'An uncaught browser error occurred');
    reportConsoleEvent('error', message);
}, true);

window.addEventListener('unhandledrejection', function (event) {
    var reason = event.reason;
    reportConsoleEvent('error', reason && reason.message ? reason.message : String(reason));
});

(function () {
    const api = new Api();
    var localStorageKey = 'rammerhead_sessionids';
    var localStorageKeyDefault = 'rammerhead_default_sessionid';
    var sessionConsoleChannel = null;

    function updateConsoleSnapshot() {
        var sessionId = document.getElementById('session-id').value.trim();
        document.getElementById('console-session-status').textContent = sessionId || 'No session selected';
        document.getElementById('console-tab-status').textContent = document.title + ' — ' + location.pathname;
        document.getElementById('console-network-status').textContent = navigator.onLine ? 'Online' : 'Offline';
    }

    function watchSessionDiagnostics(sessionId) {
        if (sessionConsoleChannel) {
            sessionConsoleChannel.close();
            sessionConsoleChannel = null;
        }
        if (!sessionId || !('BroadcastChannel' in window)) return;

        sessionConsoleChannel = new BroadcastChannel('rammerhead-console:' + sessionId);
        sessionConsoleChannel.addEventListener('message', function (event) {
            var data = event.data;
            if (!data || typeof data.message !== 'string') return;
            var source = data.title || data.url || 'Proxy tab';
            if (data.tabId) source += ' [' + data.tabId + ']';
            reportConsoleEvent(data.type === 'error' ? 'error' : 'info', source + ': ' + data.message);
        });
    }

    async function refreshConsoleStatus() {
        updateConsoleSnapshot();
        document.getElementById('console-server-status').textContent = 'Checking...';
        document.getElementById('console-toggle').dataset.state = 'checking';
        try {
            await api.needpassword();
            document.getElementById('console-server-status').textContent = 'Connected';
            document.getElementById('console-toggle').dataset.state = 'online';
        } catch (err) {
            document.getElementById('console-server-status').textContent = 'Unavailable';
            document.getElementById('console-toggle').dataset.state = 'offline';
            reportConsoleEvent('error', 'Could not reach the proxy server: ' + (err.message || err));
        }
    }

    window.addEventListener('online', function () {
        document.getElementById('console-network-status').textContent = 'Online';
        reportConsoleEvent('info', 'Browser network is online');
    });

    window.addEventListener('offline', function () {
        document.getElementById('console-network-status').textContent = 'Offline';
        reportConsoleEvent('error', 'Browser network is offline');
    });

    var consoleToggle = document.getElementById('console-toggle');
    var consolePanel = document.getElementById('console-panel');

    function closeConsolePanel() {
        if (consolePanel.open) consolePanel.close();
        consoleToggle.setAttribute('aria-expanded', 'false');
    }

    consoleToggle.addEventListener('click', function () {
        if (consolePanel.open) {
            closeConsolePanel();
            return;
        }
        consolePanel.showModal();
        this.setAttribute('aria-expanded', 'true');
        refreshConsoleStatus();
    });

    consolePanel.addEventListener('close', function () {
        consoleToggle.setAttribute('aria-expanded', String(consolePanel.open));
    });

    consolePanel.addEventListener('cancel', function () {
        consoleToggle.setAttribute('aria-expanded', 'false');
    });

    consolePanel.addEventListener('click', function (event) {
        if (event.target === consolePanel) closeConsolePanel();
    });

    document.getElementById('console-minimize').addEventListener('click', function () {
        closeConsolePanel();
    });

    document.getElementById('console-refresh').addEventListener('click', refreshConsoleStatus);
    document.getElementById('console-clear').addEventListener('click', function () {
        document.getElementById('console-events').replaceChildren();
        document.getElementById('console-empty').hidden = false;
    });

    var sessionIdsStore = {
        get() {
            var rawData = localStorage.getItem(localStorageKey);
            if (!rawData) return [];
            try {
                var data = JSON.parse(rawData);
                if (!Array.isArray(data)) throw new Error('Invalid data');
                return data;
            } catch (e) {
                return [];
            }
        },
        set(data) {
            if (!data || !Array.isArray(data)) throw new TypeError('Must be array');
            localStorage.setItem(localStorageKey, JSON.stringify(data));
        },
        getDefault() {
            var sessionId = localStorage.getItem(localStorageKeyDefault);
            if (sessionId) {
                var data = sessionIdsStore.get();
                var filteredData = data.filter(function (e) {
                    return e.id === sessionId;
                });
                if (filteredData.length) return filteredData[0];
            }
            return null;
        },
        setDefault(id) {
            localStorage.setItem(localStorageKeyDefault, id);
        }
    };

    function renderSessionTable(data) {
        var tbody = document.querySelector('tbody');
        while (tbody.firstChild && tbody.firstChild.remove()) {}

        for (var i = 0; i < data.length; i++) {
            var tr = document.createElement('tr');
            appendIntoTr(data[i].id, tr);
            appendIntoTr(data[i].createdOn, tr);

            var fillInBtn = document.createElement('button');
            fillInBtn.textContent = 'Fill in existing session ID';
            fillInBtn.className = 'btn btn-outline-primary';
            fillInBtn.onclick = index(i, function (idx) {
                setError();
                if (data && data[idx]) {
                    sessionIdsStore.setDefault(data[idx].id);
                    loadSettings(data[idx]);
                }
            });
            appendIntoTr(fillInBtn, tr);

            var deleteBtn = document.createElement('button');
            deleteBtn.textContent = 'Delete';
            deleteBtn.className = 'btn btn-outline-danger';
            deleteBtn.onclick = index(i, function (idx) {
                setError();
                if (data && data[idx]) {
                    api.deletesession(data[idx].id).then(() => {
                        data.splice(idx, 1);
                        sessionIdsStore.set(data);
                        renderSessionTable(data);
                    });
                }
            });
            appendIntoTr(deleteBtn, tr);

            tbody.appendChild(tr);
        }

        function appendIntoTr(stuff, row) {
            var td = document.createElement('td');
            if (typeof stuff === 'object') {
                td.appendChild(stuff);
            } else {
                td.textContent = stuff;
            }
            row.appendChild(td);
        }

        function index(i, func) {
            return func.bind(null, i);
        }
    }

    function loadSettings(session) {
        document.getElementById('session-id').value = session.id || '';
        document.getElementById('session-httpproxy').value = session.httpproxy || '';
        document.getElementById('session-shuffling').checked = typeof session.enableShuffling === 'boolean' ? session.enableShuffling : true;
        watchSessionDiagnostics(session.id);
        updateConsoleSnapshot();
    }

    function loadSessions() {
        var sessions = sessionIdsStore.get();
        var defaultSession = sessionIdsStore.getDefault();
        if (defaultSession) loadSettings(defaultSession);
        renderSessionTable(sessions);
    }

    function addSession(id) {
        var data = sessionIdsStore.get();
        data.unshift({ id: id, createdOn: new Date().toLocaleString() });
        sessionIdsStore.set(data);
        renderSessionTable(data);
    }

    function editSession(id, httpproxy, enableShuffling) {
        var data = sessionIdsStore.get();
        for (var i = 0; i < data.length; i++) {
            if (data[i].id === id) {
                data[i].httpproxy = httpproxy;
                data[i].enableShuffling = enableShuffling;
                sessionIdsStore.set(data);
                return;
            }
        }
        throw new TypeError('Cannot find ' + id);
    }

    api.get('/mainport').then((data) => {
        // Adaptive port logic:
        // - On reverse-proxy hosts (Render, ngrok, Railway, etc.) the browser
        //   always hits port 443/80 via the proxy, so window.location.port is
        //   empty. Switching it would break the app — skip redirect.
        // - On direct/local hosts (localhost, LAN) window.location.port will
        //   be set (e.g. "8080"), so redirect to the correct port if needed.
        var isReverseProxy = (
            !window.location.port ||                                  // default port = proxy host
            window.location.hostname.includes('ngrok') ||            // any ngrok domain
            window.location.hostname.includes('onrender.com') ||     // Render
            window.location.hostname.includes('railway.app') ||      // Railway
            window.location.hostname.includes('up.railway.app') ||   // Railway alt
            window.location.hostname.includes('herokuapp.com') ||    // Heroku
            window.location.hostname.includes('vercel.app') ||       // Vercel
            window.location.hostname.includes('fly.dev')             // Fly.io
        );

        if (isReverseProxy) {
            console.log('[RH] Reverse-proxy host detected — port switching bypassed.');
            return;
        }

        // Direct host: redirect to the correct port if it differs
        var defaultPort = window.location.protocol === 'https:' ? 443 : 80;
        var currentPort = parseInt(window.location.port) || defaultPort;
        var mainPort = parseInt(data) || defaultPort;
        if (currentPort !== mainPort) {
            console.log('[RH] Redirecting to port ' + mainPort);
            window.location.port = mainPort;
        }
    });

    api.needpassword().then(doNeed => {
        if (doNeed) {
            document.getElementById('password-wrapper').style.display = 'block';
        }
    });

    window.addEventListener('load', function () {
        loadSessions();
        refreshConsoleStatus();
        var showingAdvancedOptions = false;

        document.getElementById('session-advanced-toggle').onclick = function () {
            document.getElementById('session-advanced-container').style.display = (showingAdvancedOptions = !showingAdvancedOptions) ? 'block' : 'none';
        };

        document.getElementById('session-create-btn').addEventListener('click', () => {
            setError();
            api.newsession().then((id) => {
                addSession(id);
                document.getElementById('session-id').value = id;
                document.getElementById('session-httpproxy').value = '';
                watchSessionDiagnostics(id);
                updateConsoleSnapshot();
            });
        });

        async function go() {
            setError();
            const id = document.getElementById('session-id').value;
            const httpproxy = document.getElementById('session-httpproxy').value;
            
            const enableShuffling = document.getElementById('session-shuffling').checked;
            let url = document.getElementById('session-url').value;

            if (!id) return setError('Must select or create a session first');
            if (!url) return setError('Must provide a URL to go to');

            if (!url.startsWith('http://') && !url.startsWith('https://')) {
                url = 'http://' + url;
            }

            const openInNewTab = document.getElementById('session-open-new-tab').checked;
            const launchTab = openInNewTab ? window.open('about:blank', '_blank') : null;
            if (openInNewTab && !launchTab) {
                return setError('Your browser blocked the new tab. Allow pop-ups for this site and try again.');
            }
            if (launchTab) launchTab.opener = null;

            try {
                // Ensure the ID is clean and stripped of accidental whitespace
                const cleanId = id.trim();

                await api.editsession(cleanId, httpproxy, enableShuffling);
                editSession(cleanId, httpproxy, enableShuffling);

                if (enableShuffling) {
                    const shuffleDictStr = await api.get('/api/shuffleDict?id=' + cleanId);
                    const shuffleDict = JSON.parse(shuffleDictStr);
                    const shuffler = new StrShuffler(shuffleDict);
                    
                    const shuffledUrl = shuffler.shuffle(url);
                    (launchTab || window).location.href = '/' + cleanId + '/' + shuffledUrl;
                } else {
                    (launchTab || window).location.href = '/' + cleanId + '/' + url;
                }
            } catch (err) {
                if (launchTab) launchTab.close();
                setError(err.message || err);
            }
        }

        document.getElementById('session-go').onclick = go;
        document.getElementById('session-url').onkeydown = function (e) {
            if (e.key === 'Enter') go();
        };
    });
})();