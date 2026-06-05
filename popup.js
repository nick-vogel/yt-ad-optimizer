(function () {
  'use strict';

  var runBtn = document.getElementById('run-btn');
  var insertBtn = document.getElementById('insert-btn');
  var intervalInput = document.getElementById('interval');
  var dryRunCb = document.getElementById('dry-run');
  var insertIntervalInput = document.getElementById('insert-interval');
  var insertStartInput = document.getElementById('insert-start');
  var insertDryRunCb = document.getElementById('insert-dry-run');
  var insertSpeedInput = document.getElementById('insert-speed');
  var silenceBtn = document.getElementById('silence-btn');
  var silenceIntervalInput = document.getElementById('silence-interval');
  var silenceToleranceInput = document.getElementById('silence-tolerance');
  var silenceMinDurationInput = document.getElementById('silence-min-duration');
  var silenceSpeedInput = document.getElementById('silence-speed');
  var cleanupSpeedInput = document.getElementById('cleanup-speed');
  var cleanupBadOnlyCb = document.getElementById('cleanup-bad-only');
  var statusDot = document.getElementById('status-dot');
  var statusText = document.getElementById('status-text');
  var summaryEl = document.getElementById('summary');
  var logArea = document.getElementById('log-area');

  var isReady = false;
  var activeTabId = null;

  // ─── Tabs ────────────────────────────────────────────────────

  var tabs = document.querySelectorAll('.tab');
  tabs.forEach(function (tab) {
    tab.addEventListener('click', function () {
      tabs.forEach(function (t) { t.classList.remove('active'); });
      tab.classList.add('active');
      document.querySelectorAll('.tab-content').forEach(function (c) {
        c.classList.remove('active');
      });
      document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
    });
  });

  // ─── Status & Logging ───────────────────────────────────────

  function setStatus(ready, text) {
    isReady = ready;
    statusDot.className = ready ? 'ready' : 'not-ready';
    statusText.textContent = text || (ready ? 'Ready' : 'Not ready');
    runBtn.disabled = !ready;
    insertBtn.disabled = !ready;
    silenceBtn.disabled = !ready;
  }

  function appendLog(text, level) {
    var entry = document.createElement('div');
    entry.className = 'log-entry ' + (level || 'info');
    entry.textContent = text;
    logArea.appendChild(entry);
    logArea.scrollTop = logArea.scrollHeight;
  }

  function clearLog() {
    logArea.innerHTML = '';
    summaryEl.style.display = 'none';
    summaryEl.textContent = '';
  }

  function showSummary(found, keeping, deleting) {
    summaryEl.textContent = 'Found ' + found + ' | Keeping ' + keeping + ' | Deleting ' + deleting;
    summaryEl.style.display = 'block';
  }

  function setButtonsRunning(running) {
    if (running) {
      runBtn.disabled = true;
      insertBtn.disabled = true;
      silenceBtn.disabled = true;
      runBtn.textContent = 'Running...';
      insertBtn.textContent = 'Running...';
      silenceBtn.textContent = 'Running...';
    } else {
      runBtn.disabled = !isReady;
      insertBtn.disabled = !isReady;
      silenceBtn.disabled = !isReady;
      runBtn.textContent = 'Run Cleanup';
      insertBtn.textContent = 'Insert Ad Slots';
      silenceBtn.textContent = 'Insert Into Silence';
    }
  }

  // ─── Communication ──────────────────────────────────────────

  function queryActiveTab(callback) {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      if (tabs && tabs[0]) {
        activeTabId = tabs[0].id;
        callback(tabs[0]);
      } else {
        setStatus(false, 'No active tab');
      }
    });
  }

  var PING_ATTEMPTS = 3;          // ping tries, ~300ms apart
  var PING_GAP_MS = 300;
  var POST_INJECT_WAIT_MS = 400;  // let injected content script register its listener
  var NOT_READY_MSG = 'Open a video\'s monetization editor to use this extension.';
  var injectedOnce = false;       // re-inject at most once per popup open

  function pingOnce(tabId, cb) {
    chrome.tabs.sendMessage(tabId, { type: 'ping' }, function (response) {
      cb(!chrome.runtime.lastError && response && response.alive);
    });
  }

  // Ping with a few retries; absorbs the brief unresponsiveness right after the
  // editor loads (e.g. an ad at 0:00 makes the preview autoplay an ad on open).
  function pingWithRetries(tabId, attemptsLeft, cb) {
    pingOnce(tabId, function (ok) {
      if (ok) return cb(true);
      if (attemptsLeft <= 1) return cb(false);
      setTimeout(function () { pingWithRetries(tabId, attemptsLeft - 1, cb); }, PING_GAP_MS);
    });
  }

  function onPingSucceeded(tabId) {
    chrome.tabs.sendMessage(tabId, { type: 'checkReady' }, function (res) {
      if (chrome.runtime.lastError) {
        setStatus(false, 'Communication error');
        return;
      }
      setStatus(res && res.ready, res ? res.reason : 'Unknown state');
    });
  }

  // When the content script is unreachable (never injected, or orphaned after an
  // extension reload), programmatically (re)inject it once, then ping again.
  function tryReinjectThenPing(tab) {
    var isStudio = tab.url && tab.url.indexOf('https://studio.youtube.com/') === 0;
    if (injectedOnce || !isStudio || !chrome.scripting || !chrome.scripting.executeScript) {
      setStatus(false, NOT_READY_MSG);
      return;
    }
    injectedOnce = true;

    var isolated = chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['selectors.js', 'content.js'],
    });
    // The MAIN-world bridge survives orphaning, so its re-injection is best-effort.
    var main = chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['page-bridge.js'],
      world: 'MAIN',
    }).catch(function () { /* bridge likely still alive; non-fatal */ });

    isolated.then(function () {
      return main;
    }).then(function () {
      setTimeout(function () {
        pingWithRetries(tab.id, PING_ATTEMPTS, function (ok) {
          if (ok) onPingSucceeded(tab.id);
          else setStatus(false, NOT_READY_MSG);
        });
      }, POST_INJECT_WAIT_MS);
    }).catch(function () {
      // executeScript throws on restricted/non-matching tabs or missing host access.
      setStatus(false, NOT_READY_MSG);
    });
  }

  function pingContentScript() {
    queryActiveTab(function (tab) {
      pingWithRetries(tab.id, PING_ATTEMPTS, function (ok) {
        if (ok) onPingSucceeded(tab.id);
        else tryReinjectThenPing(tab);
      });
    });
  }

  chrome.runtime.onMessage.addListener(function (msg) {
    if (msg.type === 'status') {
      setStatus(msg.ready, msg.info);
    }
    if (msg.type === 'log') {
      appendLog(msg.text, msg.level);
      if (msg.text === '=== Complete ===') {
        setButtonsRunning(false);
      }
    }
    if (msg.type === 'summary') {
      showSummary(msg.found, msg.keeping, msg.deleting);
    }
  });

  // ─── Cleanup Button ─────────────────────────────────────────

  runBtn.addEventListener('click', function () {
    if (!isReady || !activeTabId) return;
    setButtonsRunning(true);
    clearLog();

    var config = {
      intervalSec: parseInt(intervalInput.value, 10) || 60,
      badOnly: cleanupBadOnlyCb ? cleanupBadOnlyCb.checked : false,
      dryRun: dryRunCb ? dryRunCb.checked : false,
      speedMs: parseInt(cleanupSpeedInput.value, 10) || 150,
    };

    chrome.tabs.sendMessage(activeTabId, { type: 'run', config: config }, function (response) {
      if (chrome.runtime.lastError || !response || !response.started) {
        var errMsg = response ? response.reason : (chrome.runtime.lastError ? chrome.runtime.lastError.message : 'no response');
        appendLog('Failed to start: ' + errMsg, 'error');
        setButtonsRunning(false);
      }
    });
  });

  // ─── Insert Button ──────────────────────────────────────────

  insertBtn.addEventListener('click', function () {
    if (!isReady || !activeTabId) return;

    setButtonsRunning(true);
    clearLog();

    var config = {
      durationSec: 0,
      intervalSec: Math.max(parseInt(insertIntervalInput.value, 10) || 60, 1),
      startSec: (function () {
        var n = parseInt(insertStartInput.value, 10);
        return isNaN(n) ? 60 : Math.max(n, 0);
      })(),
      dryRun: insertDryRunCb ? insertDryRunCb.checked : false,
      speedMs: parseInt(insertSpeedInput.value, 10) || 50,
    };

    chrome.tabs.sendMessage(activeTabId, { type: 'insert', config: config }, function (response) {
      if (chrome.runtime.lastError || !response || !response.started) {
        var errMsg = response ? response.reason : (chrome.runtime.lastError ? chrome.runtime.lastError.message : 'no response');
        appendLog('Failed to start: ' + errMsg, 'error');
        setButtonsRunning(false);
      }
    });
  });

  // ─── Silence Button ─────────────────────────────────────────

  silenceBtn.addEventListener('click', function () {
    if (!isReady || !activeTabId) return;

    setButtonsRunning(true);
    clearLog();

    var config = {
      mode: 'silence',
      intervalSec: Math.max(parseInt(silenceIntervalInput.value, 10) || 120, 1),
      tolerancePct: Math.min(Math.max(parseInt(silenceToleranceInput.value, 10) || 25, 1), 100),
      minSilenceMs: Math.max(parseInt(silenceMinDurationInput.value, 10) || 500, 100),
      dryRun: false,
      speedMs: parseInt(silenceSpeedInput.value, 10) || 50,
    };

    chrome.tabs.sendMessage(activeTabId, { type: 'insert', config: config }, function (response) {
      if (chrome.runtime.lastError || !response || !response.started) {
        var errMsg = response ? response.reason : (chrome.runtime.lastError ? chrome.runtime.lastError.message : 'no response');
        appendLog('Failed to start: ' + errMsg, 'error');
        setButtonsRunning(false);
      }
    });
  });

  document.getElementById('done-btn').addEventListener('click', function () {
    window.close();
  });

  pingContentScript();
})();
