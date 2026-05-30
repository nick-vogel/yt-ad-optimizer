(function () {
  'use strict';

  var PREFIX = '[MidRollMgr]';
  var running = false;

  // ─── Utilities ───────────────────────────────────────────────

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function parseFramestamp(str) {
    if (!str) return NaN;
    var parts = str.trim().split(':').map(Number);
    if (parts.some(isNaN)) return NaN;
    if (parts.length === 3) return parts[0] * 60 + parts[1] + parts[2] / 30;
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return NaN;
  }

  function formatTime(sec) {
    if (sec == null || isNaN(sec)) return '??:??';
    var m = Math.floor(sec / 60);
    var s = Math.floor(sec % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function secsToFramestamp(sec) {
    var m = Math.floor(sec / 60);
    var s = Math.floor(sec % 60);
    var mm = m < 10 ? '0' + m : '' + m;
    var ss = s < 10 ? '0' + s : '' + s;
    return mm + ':' + ss + ':00';
  }

  function getVideoDurationSec() {
    var fi = document.querySelector('ytve-framestamp-input');
    var ms = fi ? parseInt(fi.getAttribute('data-duration-ms'), 10) : 0;
    if (!ms) {
      ms = parseInt(document.documentElement.getAttribute('data-ytadopt-duration-ms'), 10) || 0;
    }
    return (ms || 0) / 1000;
  }

  function safeSendMessage(msg) {
    try { chrome.runtime.sendMessage(msg); } catch (_) {}
  }

  function log(text, level) {
    level = level || 'info';
    console.log(PREFIX, text);
    safeSendMessage({ type: 'log', text: text, level: level });
  }

  function sendStatus(ready, info, durationSec) {
    safeSendMessage({ type: 'status', ready: ready, info: info || '', durationSec: durationSec || 0 });
  }

  // ─── Readiness Detection ─────────────────────────────────────

  function isOnMonetizationPage() {
    return /^https:\/\/studio\.youtube\.com\/video\/[^/]+\/monetization/.test(location.href);
  }

  function checkReadiness() {
    var panel = document.querySelector(SEL.panel);
    var onMonetization = isOnMonetizationPage();
    if (!panel) {
      return {
        ready: false,
        reason: onMonetization ? 'Options panel not found' : 'Open the mid-roll ad slots editor',
      };
    }
    var rows = panel.querySelectorAll(SEL.row);
    var dur = getVideoDurationSec();
    if (!(dur > 0)) {
      return { ready: false, reason: 'Video still processing', durationSec: 0 };
    }
    var contextStr = onMonetization ? '' : ' — upload dialog';
    return {
      ready: true,
      reason: 'Ready (' + rows.length + ' ad slots, ' + formatTime(dur) + ' long)' + contextStr,
      durationSec: dur,
    };
  }

  var readinessDebounce = null;
  function onDomChange() {
    clearTimeout(readinessDebounce);
    readinessDebounce = setTimeout(function () {
      var state = checkReadiness();
      sendStatus(state.ready, state.reason, state.durationSec);
    }, 500);
  }

  var observer = new MutationObserver(onDomChange);
  observer.observe(document.body, { childList: true, subtree: true });

  var lastHref = location.href;
  setInterval(function () {
    if (location.href !== lastHref) {
      lastHref = location.href;
      onDomChange();
    }
  }, 1000);

  onDomChange();

  // ─── Message Listener ────────────────────────────────────────

  chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
    if (msg.type === 'ping') {
      sendResponse({ alive: true });
      return;
    }
    if (msg.type === 'checkReady') {
      sendResponse(checkReadiness());
      return;
    }
    if (msg.type === 'run') {
      if (running) {
        sendResponse({ started: false, reason: 'Already running' });
        return;
      }
      running = true;
      sendResponse({ started: true });
      runOptimizer(msg.config).finally(function () { running = false; });
      return true;
    }
    if (msg.type === 'insert') {
      if (running) {
        sendResponse({ started: false, reason: 'Already running' });
        return;
      }
      running = true;
      sendResponse({ started: true });
      runInsert(msg.config).finally(function () { running = false; });
      return true;
    }
  });

  // ─── Phase A: Read All Rows ──────────────────────────────────

  function phaseA() {
    log('Phase A: Reading ad break rows...');
    var panel = document.querySelector(SEL.panel);
    if (!panel) { log('Panel not found', 'error'); return []; }

    var rows = panel.querySelectorAll(SEL.row);
    var result = [];

    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];

      var labelEl = row.querySelector(SEL.rowLabel);
      var labelText = labelEl ? labelEl.textContent.trim().toLowerCase() : '';
      var type = 'unknown';
      if (labelText.indexOf('manual') !== -1) type = 'manual';
      else if (labelText.indexOf('automatic') !== -1) type = 'automatic';

      var tsInput = row.querySelector(SEL.rowTimestampInput);
      var tsValue = tsInput ? tsInput.value : '';
      var timeSec = parseFramestamp(tsValue);

      var qualityContainer = row.querySelector(SEL.rowQualityContainer);
      var hasWarningContent = qualityContainer &&
        qualityContainer.textContent.trim().length > 0;

      var isWarning = hasWarningContent ||
        row.classList.contains('is-warning') ||
        row.hasAttribute('is-warning');

      result.push({
        index: i,
        rowEl: row,
        type: type,
        timeSec: timeSec,
        tsDisplay: tsValue,
        isWarning: isWarning,
        deleteBtn: row.querySelector(SEL.rowDeleteBtn),
      });
    }

    log('Phase A: Found ' + result.length + ' ad slots (' +
      result.filter(function (r) { return r.type === 'manual'; }).length + ' manual, ' +
      result.filter(function (r) { return r.type === 'automatic'; }).length + ' automatic, ' +
      result.filter(function (r) { return r.isWarning; }).length + ' warnings)');

    return result;
  }

  // ─── Phase B: Filter ─────────────────────────────────────────

  function phaseB(slots, intervalSec) {
    log('Phase B: Filtering (interval=' + intervalSec + 's)...');

    slots.sort(function (a, b) { return a.timeSec - b.timeSec; });

    var autoTimes = [];
    for (var a = 0; a < slots.length; a++) {
      if (slots[a].type === 'automatic') autoTimes.push(slots[a].timeSec);
    }

    function tooCloseToAuto(t) {
      for (var j = 0; j < autoTimes.length; j++) {
        if (Math.round(Math.abs(t - autoTimes[j])) < intervalSec) return autoTimes[j];
      }
      return null;
    }

    var keep = [];
    var remove = [];
    var lastKeptManualTime = -Infinity;

    for (var i = 0; i < slots.length; i++) {
      var s = slots[i];
      var t = s.timeSec;

      if (s.type === 'automatic') {
        keep.push(s);
        log('  ' + s.tsDisplay + ' — KEEP (automatic)');
        continue;
      }

      if (s.isWarning) {
        remove.push(s);
        log('  ' + s.tsDisplay + ' — REMOVE (warning)');
        continue;
      }

      if (s.type === 'manual') {
        var nearAuto = tooCloseToAuto(t);
        if (nearAuto !== null) {
          remove.push(s);
          log('  ' + s.tsDisplay + ' — REMOVE (too close to automatic at ' + formatTime(nearAuto) + ')');
          continue;
        }

        var delta = t - lastKeptManualTime;
        if (Math.round(delta) < intervalSec) {
          remove.push(s);
          log('  ' + s.tsDisplay + ' — REMOVE (too close: ' + Math.round(delta) + 's < ' + intervalSec + 's)');
        } else {
          keep.push(s);
          lastKeptManualTime = t;
          log('  ' + s.tsDisplay + ' — KEEP (manual, gap=' + Math.round(delta) + 's)');
        }
        continue;
      }

      keep.push(s);
      log('  ' + s.tsDisplay + ' — KEEP (unknown type)');
    }

    log('Phase B: Keeping ' + keep.length + ', removing ' + remove.length);
    safeSendMessage({
      type: 'summary',
      found: slots.length,
      keeping: keep.length,
      deleting: remove.length,
    });

    return { keep: keep, remove: remove };
  }

  // ─── Phase C: Delete ─────────────────────────────────────────

  async function phaseC(toRemove, config) {
    if (config.dryRun) {
      log('Phase C: DRY RUN — skipping deletion of ' + toRemove.length + ' slots');
      return 0;
    }

    log('Phase C: Deleting ' + toRemove.length + ' slots...');

    toRemove.sort(function (a, b) { return b.timeSec - a.timeSec; });

    var deleted = 0;

    for (var i = 0; i < toRemove.length; i++) {
      var s = toRemove[i];

      try {
        if (!s.deleteBtn) {
          log('  ' + s.tsDisplay + ' — no delete button found, skipping', 'warn');
          continue;
        }

        if (!s.deleteBtn.isConnected) {
          log('  ' + s.tsDisplay + ' — button no longer in DOM, skipping', 'warn');
          continue;
        }

        s.deleteBtn.click();
        await sleep(config.speedMs || 150);
        deleted++;
        log('  ' + s.tsDisplay + ' — deleted');
      } catch (err) {
        log('  ' + s.tsDisplay + ' — error: ' + err.message, 'error');
      }
    }

    log('Phase C: Deleted ' + deleted + '/' + toRemove.length);
    return deleted;
  }

  // ─── Orchestrator ────────────────────────────────────────────

  async function runOptimizerInternal(config) {
    var state = checkReadiness();
    if (!state.ready) {
      log('Aborted: ' + state.reason, 'error');
      return;
    }

    var slots = phaseA();
    if (slots.length === 0) { log('No slots to process'); return; }

    var filtered = phaseB(slots, config.intervalSec || 60);
    if (filtered.remove.length === 0) {
      log('Nothing to remove — all slots pass filter');
      return;
    }

    await phaseC(filtered.remove, config);
  }

  async function runOptimizer(config) {
    log('=== Starting optimizer ===');
    log('Config: interval=' + config.intervalSec + 's, dryRun=' + config.dryRun + ', speed=' + config.speedMs + 'ms');

    try {
      await runOptimizerInternal(config);
    } catch (err) {
      log('Unexpected error: ' + err.message, 'error');
    }

    log('=== Complete ===');
  }

  // ─── Insert Mode ─────────────────────────────────────────────

  function getExistingTimesSet() {
    var panel = document.querySelector(SEL.panel);
    if (!panel) return new Set();
    var inputs = panel.querySelectorAll(SEL.row + ' ' + SEL.rowTimestampInput);
    var times = new Set();
    for (var i = 0; i < inputs.length; i++) {
      var t = parseFramestamp(inputs[i].value);
      if (!isNaN(t)) times.add(Math.round(t));
    }
    return times;
  }

  function seekPlayheadOnce(sec) {
    return new Promise(function (resolve) {
      function onResult(e) {
        if (e.detail.type !== 'seek') return;
        document.removeEventListener('ytadopt-result', onResult);
        resolve(e.detail);
      }
      document.addEventListener('ytadopt-result', onResult);

      document.dispatchEvent(new CustomEvent('ytadopt-seek', {
        detail: { ms: Math.round(sec * 1000) }
      }));

      setTimeout(function () {
        document.removeEventListener('ytadopt-result', onResult);
        resolve({ success: false, info: 'timeout — consider slowing down by increasing the speed (ms) value' });
      }, 3000);
    });
  }

  async function seekPlayhead(sec) {
    var result = await seekPlayheadOnce(sec);
    if (result.success) return result;
    // One retry after a short backoff — the timeline element may have been
    // mid-rerender on the first attempt.
    await sleep(150);
    return await seekPlayheadOnce(sec);
  }

  async function runInsert(config) {
    log('=== Starting insert ===');
    log('Config: every ' + config.intervalSec + 's, starting at ' + config.startSec + 's, dryRun=' + config.dryRun);

    try {
      var existingTimes = getExistingTimesSet();
      log('Existing ad slots: ' + existingTimes.size);

      var panel = document.querySelector(SEL.panel);
      if (!panel) {
        log('Panel not found', 'error');
        log('=== Complete ===');
        return;
      }

      var insertBtnEl = panel.querySelector(SEL.insertBtn);
      if (!insertBtnEl) {
        insertBtnEl = panel.querySelector('[test-id="insert-ad-slot"] button');
      }
      if (!insertBtnEl) {
        var allBtns = panel.querySelectorAll('ytcp-button');
        for (var b = 0; b < allBtns.length; b++) {
          if (allBtns[b].textContent.indexOf('Insert') !== -1) {
            insertBtnEl = allBtns[b];
            break;
          }
        }
      }
      if (!insertBtnEl) {
        log('Insert button not found', 'error');
        log('=== Complete ===');
        return;
      }

      var endSec = config.durationSec || getVideoDurationSec();
      if (endSec <= 0) {
        log('Could not determine video duration', 'error');
        log('=== Complete ===');
        return;
      }
      log('Video duration: ' + formatTime(endSec));

      var timesToInsert = [];
      for (var t = config.startSec; t < endSec; t += config.intervalSec) {
        var rounded = Math.round(t);
        if (!existingTimes.has(rounded)) {
          timesToInsert.push(rounded);
        }
      }

      if (timesToInsert.length === 0) {
        log('No new slots to insert — all positions already have ad slots');
        log('=== Complete ===');
        return;
      }

      log('Will insert ' + timesToInsert.length + ' ad slots:');
      for (var j = 0; j < timesToInsert.length; j++) {
        log('  ' + secsToFramestamp(timesToInsert[j]) + ' (' + formatTime(timesToInsert[j]) + ')');
      }

      if (config.dryRun) {
        log('DRY RUN — skipping actual insertion');
        log('=== Complete ===');
        return;
      }

      var inserted = 0;
      for (var k = 0; k < timesToInsert.length; k++) {
        var sec = timesToInsert[k];
        var framestamp = secsToFramestamp(sec);

        try {
          var moveResult = await seekPlayhead(sec);
          if (!moveResult.success) {
            log('  ' + framestamp + ' — failed to seek: ' + (moveResult.info || 'unknown'), 'error');
            continue;
          }
          var halfSpeed = Math.floor((config.speedMs || 250) / 2);
          await sleep(halfSpeed);

          var rowsBefore = panel.querySelectorAll(SEL.row).length;

          var clickTarget = insertBtnEl.querySelector('button') || insertBtnEl;
          clickTarget.click();
          await sleep(halfSpeed);

          var rowsAfter = panel.querySelectorAll(SEL.row);
          if (rowsAfter.length <= rowsBefore) {
            log('  ' + framestamp + ' — insert button did not create a new row', 'warn');
            continue;
          }

          log('  ' + framestamp + ' — inserted');
          inserted++;
        } catch (err) {
          log('  ' + framestamp + ' — error: ' + err.message, 'error');
        }
      }

      log('Inserted ' + inserted + '/' + timesToInsert.length + ' ad slots');
    } catch (err) {
      log('Unexpected error: ' + err.message, 'error');
    }

    log('=== Complete ===');
  }
})();
