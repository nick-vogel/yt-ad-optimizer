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
  var cleanupSpeedInput = document.getElementById('cleanup-speed');
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
      runBtn.textContent = 'Running...';
      insertBtn.textContent = 'Running...';
    } else {
      runBtn.disabled = !isReady;
      insertBtn.disabled = !isReady;
      runBtn.textContent = 'Run Cleanup';
      insertBtn.textContent = 'Insert Ad Slots';
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

  function pingContentScript() {
    queryActiveTab(function (tab) {
      // The content script can be briefly unresponsive right after the editor
      // loads (e.g. an ad at 0:00 makes the preview autoplay an ad on open), so a
      // single ping gives false negatives. Retry a few times before giving up.
      var attempts = 0;
      var maxAttempts = 3;

      function attempt() {
        chrome.tabs.sendMessage(tab.id, { type: 'ping' }, function (response) {
          if (chrome.runtime.lastError || !response || !response.alive) {
            attempts++;
            if (attempts < maxAttempts) {
              setTimeout(attempt, 300);
              return;
            }
            setStatus(false, 'Open a video\'s monetization editor to use this extension.');
            return;
          }
          chrome.tabs.sendMessage(tab.id, { type: 'checkReady' }, function (res) {
            if (chrome.runtime.lastError) {
              setStatus(false, 'Communication error');
              return;
            }
            setStatus(res && res.ready, res ? res.reason : 'Unknown state');
          });
        });
      }

      attempt();
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
      startSec: parseInt(insertStartInput.value, 10) || 60,
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

  document.getElementById('done-btn').addEventListener('click', function () {
    window.close();
  });

  pingContentScript();
})();
