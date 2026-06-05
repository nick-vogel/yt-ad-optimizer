(function () {
  'use strict';

  // ─── Idempotency / orphan-aware guard ────────────────────────
  // This content script can be (re)injected programmatically by the popup when
  // the statically-injected instance is missing or orphaned (e.g. after the
  // extension is reloaded, which invalidates its chrome.runtime). A plain boolean
  // flag would let a dead instance permanently block a fresh one, so instead a
  // live instance exposes a heartbeat that only returns true while its runtime is
  // valid. A newcomer defers to a genuinely live incumbent, but takes over a dead one.
  function selfRuntimeValid() {
    try { return !!(chrome.runtime && chrome.runtime.id); } catch (_) { return false; }
  }
  if (typeof window.__midRollAlive === 'function') {
    var incumbentAlive = false;
    try { incumbentAlive = window.__midRollAlive(); } catch (_) { incumbentAlive = false; }
    if (incumbentAlive) return; // a genuinely live instance already owns this page
    // else: incumbent is orphaned/dead — fall through and take over
  }
  window.__midRollAlive = function () { return selfRuntimeValid(); };

  var PREFIX = '[MidRollMgr]';
  var VERSION = (function () {
    try { return chrome.runtime.getManifest().version; } catch (_) { return '?'; }
  })();

  // Run state lives on window so a stray second instance (during a re-injection
  // race) can never start a concurrent run/insert.
  function isRunning() { return !!window.__midRollRunning; }
  function setRunning(v) { window.__midRollRunning = !!v; }

  // Cooperative cancellation: a 'stop' message flips this, and the insert/delete
  // loops check it between iterations to bail out cleanly.
  function isCancelled() { return !!window.__midRollCancel; }
  function setCancel(v) { window.__midRollCancel = !!v; }

  // ─── Utilities ───────────────────────────────────────────────

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function parseFramestamp(str) {
    if (!str) return NaN;
    var parts = str.trim().split(':').map(Number);
    if (parts.some(isNaN)) return NaN;
    // YouTube emits H:MM:SS:FF once a video passes one hour (hours unbounded,
    // so this covers 12h+ videos), MM:SS:FF otherwise.
    if (parts.length === 4) return parts[0] * 3600 + parts[1] * 60 + parts[2] + parts[3] / 30;
    if (parts.length === 3) return parts[0] * 60 + parts[1] + parts[2] / 30;
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return NaN;
  }

  function pad2(n) {
    return n < 10 ? '0' + n : '' + n;
  }

  function formatTime(sec) {
    if (sec == null || isNaN(sec)) return '??:??';
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = Math.floor(sec % 60);
    if (h > 0) return h + ':' + pad2(m) + ':' + pad2(s);
    return m + ':' + pad2(s);
  }

  function secsToFramestamp(sec) {
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = Math.floor(sec % 60);
    if (h > 0) return h + ':' + pad2(m) + ':' + pad2(s) + ':00';
    return pad2(m) + ':' + pad2(s) + ':00';
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
    // Panel is open → the extension is usable. Duration is advisory only:
    // cleanup never reads it, and insert aborts gracefully on its own if it's
    // still 0, so gating readiness on it only produces false "not ready" states.
    var rows = panel.querySelectorAll(SEL.row);
    var dur = getVideoDurationSec();
    var contextStr = onMonetization ? '' : ' — upload dialog';
    var durNote = dur > 0 ? (', ' + formatTime(dur) + ' long') : ' (duration loading…)';
    return {
      ready: true,
      reason: 'Ready (' + rows.length + ' ad slots' + durNote + ')' + contextStr,
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

  // Disconnect/clear anything left behind by a prior (possibly orphaned) instance
  // before installing fresh watchers, so they don't stack up.
  if (window.__midRollObserver) { try { window.__midRollObserver.disconnect(); } catch (_) {} }
  if (window.__midRollUrlTimer) { try { clearInterval(window.__midRollUrlTimer); } catch (_) {} }

  var observer = new MutationObserver(onDomChange);
  observer.observe(document.body, { childList: true, subtree: true });
  window.__midRollObserver = observer;

  var lastHref = location.href;
  window.__midRollUrlTimer = setInterval(function () {
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
    if (msg.type === 'preview') {
      computePreview(msg.config)
        .then(function (res) { sendResponse(res || { ok: false }); })
        .catch(function () { sendResponse({ ok: false }); });
      return true; // async response
    }
    if (msg.type === 'stop') {
      setCancel(true);
      sendResponse({ stopped: true });
      return;
    }
    if (msg.type === 'run') {
      if (isRunning()) {
        sendResponse({ started: false, reason: 'Already running' });
        return;
      }
      setRunning(true);
      setCancel(false);
      sendResponse({ started: true });
      runOptimizer(msg.config).finally(function () {
        setRunning(false);
        safeSendMessage({ type: 'done' });
      });
      return true;
    }
    if (msg.type === 'insert') {
      if (isRunning()) {
        sendResponse({ started: false, reason: 'Already running' });
        return;
      }
      setRunning(true);
      setCancel(false);
      sendResponse({ started: true });
      runInsert(msg.config).finally(function () {
        setRunning(false);
        safeSendMessage({ type: 'done' });
      });
      return true;
    }
  });

  // ─── Phase A: Read All Rows ──────────────────────────────────

  function phaseA(quiet) {
    function plog(t, l) { if (!quiet) log(t, l); }
    plog('Phase A: Reading ad break rows...');
    var panel = document.querySelector(SEL.panel);
    if (!panel) { plog('Panel not found', 'error'); return []; }

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

    plog('Phase A: Found ' + result.length + ' ad slots (' +
      result.filter(function (r) { return r.type === 'manual'; }).length + ' manual, ' +
      result.filter(function (r) { return r.type === 'automatic'; }).length + ' automatic, ' +
      result.filter(function (r) { return r.isWarning; }).length + ' warnings)');

    return result;
  }

  // ─── Phase B: Filter ─────────────────────────────────────────

  function phaseB(slots, intervalSec, badOnly, quiet) {
    function plog(t, l) { if (!quiet) log(t, l); }
    function psummary(m) { if (!quiet) safeSendMessage(m); }
    slots.sort(function (a, b) { return a.timeSec - b.timeSec; });

    // Bad-only: remove just the slots flagged "unlikely to show ads" (and never
    // automatics), leaving every other manual placement untouched. Used after a
    // silence pass to prune only the slots YouTube flagged.
    if (badOnly) {
      plog('Phase B: Filtering (flagged/bad slots only)...');
      var keepB = [];
      var removeB = [];
      for (var bi = 0; bi < slots.length; bi++) {
        var sb = slots[bi];
        if (sb.isWarning && sb.type !== 'automatic') {
          removeB.push(sb);
          plog('  ' + sb.tsDisplay + ' — REMOVE (flagged)');
        } else {
          keepB.push(sb);
        }
      }
      plog('Phase B: Keeping ' + keepB.length + ', removing ' + removeB.length);
      psummary({ type: 'summary', found: slots.length, keeping: keepB.length, deleting: removeB.length });
      return { keep: keepB, remove: removeB };
    }

    plog('Phase B: Filtering (interval=' + intervalSec + 's)...');

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
        plog('  ' + s.tsDisplay + ' — KEEP (automatic)');
        continue;
      }

      if (s.isWarning) {
        remove.push(s);
        plog('  ' + s.tsDisplay + ' — REMOVE (warning)');
        continue;
      }

      if (s.type === 'manual') {
        var nearAuto = tooCloseToAuto(t);
        if (nearAuto !== null) {
          remove.push(s);
          plog('  ' + s.tsDisplay + ' — REMOVE (too close to automatic at ' + formatTime(nearAuto) + ')');
          continue;
        }

        var delta = t - lastKeptManualTime;
        if (Math.round(delta) < intervalSec) {
          remove.push(s);
          plog('  ' + s.tsDisplay + ' — REMOVE (too close: ' + Math.round(delta) + 's < ' + intervalSec + 's)');
        } else {
          keep.push(s);
          lastKeptManualTime = t;
          plog('  ' + s.tsDisplay + ' — KEEP (manual, gap=' + Math.round(delta) + 's)');
        }
        continue;
      }

      keep.push(s);
      plog('  ' + s.tsDisplay + ' — KEEP (unknown type)');
    }

    plog('Phase B: Keeping ' + keep.length + ', removing ' + remove.length);
    psummary({
      type: 'summary',
      found: slots.length,
      keeping: keep.length,
      deleting: remove.length,
    });

    return { keep: keep, remove: remove };
  }

  // ─── Phase C: Delete ─────────────────────────────────────────

  // Find the live row matching a timestamp string. The list re-renders/virtualizes
  // as rows are deleted, so captured button references go stale — always re-query.
  function findLiveRowByTimestamp(tsDisplay) {
    var panel = document.querySelector(SEL.panel);
    if (!panel) return null;
    var rows = panel.querySelectorAll(SEL.row);
    for (var i = 0; i < rows.length; i++) {
      if (!rows[i].isConnected) continue;
      var input = rows[i].querySelector(SEL.rowTimestampInput);
      if (input && input.value === tsDisplay) return rows[i];
    }
    return null;
  }

  async function phaseC(toRemove, config) {
    if (config.dryRun) {
      log('Phase C: DRY RUN — skipping deletion of ' + toRemove.length + ' slots');
      return 0;
    }

    log('Phase C: Deleting ' + toRemove.length + ' slots...');

    // Delete newest-first so removals don't shift the rows we haven't reached yet.
    toRemove.sort(function (a, b) { return b.timeSec - a.timeSec; });

    var speed = config.speedMs || 150;
    var deleted = 0;

    for (var i = 0; i < toRemove.length; i++) {
      if (isCancelled()) {
        log('Stopped by user — deleted ' + deleted + ' of ' + toRemove.length, 'warn');
        break;
      }
      var s = toRemove[i];

      try {
        var row = findLiveRowByTimestamp(s.tsDisplay);
        if (!row) {
          log('  ' + s.tsDisplay + ' — row not found, skipping', 'warn');
          continue;
        }

        var btn = row.querySelector(SEL.rowDeleteBtn);
        if (!btn) {
          log('  ' + s.tsDisplay + ' — no delete button found, skipping', 'warn');
          continue;
        }

        // Bring virtualized rows into the rendered viewport before clicking.
        btn.scrollIntoView({ block: 'center' });
        await sleep(Math.max(Math.floor(speed / 2), 30));

        btn.click();
        await sleep(speed);

        // Confirm the row actually went away before counting it.
        if (findLiveRowByTimestamp(s.tsDisplay)) {
          log('  ' + s.tsDisplay + ' — still present after delete, skipping', 'warn');
          continue;
        }

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

    var filtered = phaseB(slots, config.intervalSec || 60, config.badOnly);
    if (filtered.remove.length === 0) {
      log('Nothing to remove — all slots pass filter');
      return;
    }

    await phaseC(filtered.remove, config);
  }

  async function runOptimizer(config) {
    log('=== Starting optimizer (v' + VERSION + ') ===');
    if (config.badOnly) {
      log('Config: remove flagged/bad slots only, dryRun=' + config.dryRun + ', speed=' + config.speedMs + 'ms');
    } else {
      log('Config: interval=' + config.intervalSec + 's, dryRun=' + config.dryRun + ', speed=' + config.speedMs + 'ms');
    }

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

  // Ask the page bridge to reduce Studio's audio waveform to silent segments.
  // Resolves to { success, segments:[{startSec,endSec}], info }.
  function analyzeAudio(opts) {
    return new Promise(function (resolve) {
      function onResult(e) {
        if (e.detail.type !== 'analyzeAudio') return;
        document.removeEventListener('ytadopt-result', onResult);
        resolve({
          success: e.detail.success,
          segments: e.detail.value || [],
          info: e.detail.info,
        });
      }
      document.addEventListener('ytadopt-result', onResult);

      document.dispatchEvent(new CustomEvent('ytadopt-analyzeAudio', {
        detail: {
          tolerancePct: opts.tolerancePct,
          minSilenceMs: opts.minSilenceMs,
        }
      }));

      setTimeout(function () {
        document.removeEventListener('ytadopt-result', onResult);
        resolve({ success: false, segments: [], info: 'audio analysis timed out' });
      }, 5000);
    });
  }

  // Greedily place one ad at the midpoint of a silent segment, then require at
  // least minGapSec before the next, walking segments in time order. This caps
  // the count predictably and lands every ad inside a detected silence.
  function pickSilencesWithSpacing(segments, minGapSec) {
    var mids = segments
      .map(function (s) { return (s.startSec + s.endSec) / 2; })
      .sort(function (a, b) { return a - b; });
    var picked = [];
    var last = -Infinity;
    for (var i = 0; i < mids.length; i++) {
      if (mids[i] - last >= minGapSec) {
        picked.push(Math.round(mids[i]));
        last = mids[i];
      }
    }
    return picked;
  }

  // Non-destructive count of what an action would do with the given settings,
  // for the popup's live estimate. Reuses the real placement/filter logic
  // (phaseA/phaseB, analyzeAudio, pickSilencesWithSpacing) in quiet mode so the
  // preview can never drift from what running actually does.
  async function computePreview(config) {
    if (!document.querySelector(SEL.panel)) return { ok: false };

    if (config.kind === 'cleanup') {
      var slots = phaseA(true);
      if (!slots.length) return { ok: true, action: 'remove', count: 0 };
      var filtered = phaseB(slots, config.intervalSec || 60, config.badOnly, true);
      return { ok: true, action: 'remove', count: filtered.remove.length };
    }

    var endSec = getVideoDurationSec();
    if (endSec <= 0) return { ok: false };
    var existing = getExistingTimesSet();

    if (config.kind === 'silence') {
      var analysis = await analyzeAudio({
        tolerancePct: config.tolerancePct,
        minSilenceMs: config.minSilenceMs,
      });
      if (!analysis.success) return { ok: false, info: analysis.info };
      var picked = pickSilencesWithSpacing(analysis.segments, config.minGapSec);
      var sc = 0;
      for (var i = 0; i < picked.length; i++) {
        if (picked[i] < endSec && !existing.has(picked[i])) sc++;
      }
      return { ok: true, action: 'place', count: sc };
    }

    // insert
    if (!(config.intervalSec > 0)) return { ok: false };
    var startSec = config.startSec >= 0 ? config.startSec : 0;
    var ic = 0;
    for (var t = startSec; t < endSec; t += config.intervalSec) {
      if (!existing.has(Math.round(t))) ic++;
    }
    return { ok: true, action: 'place', count: ic };
  }

  async function runInsert(config) {
    var silenceMode = config.mode === 'silence';
    log('=== Starting ' + (silenceMode ? 'silence insert' : 'insert') + ' (v' + VERSION + ') ===');
    if (silenceMode) {
      log('Config: place in silence, min gap=' + config.minGapSec + 's, sensitivity=' +
        config.tolerancePct + '%, minSilence=' + config.minSilenceMs + 'ms');
    } else {
      log('Config: every ' + config.intervalSec + 's, starting at ' + config.startSec + 's, dryRun=' + config.dryRun);
    }

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
      if (silenceMode) {
        var analysis = await analyzeAudio({
          tolerancePct: config.tolerancePct,
          minSilenceMs: config.minSilenceMs,
        });
        if (!analysis.success) {
          log('Audio analysis failed: ' + (analysis.info || 'unknown'), 'error');
          log('=== Complete ===');
          return;
        }
        log('Found ' + analysis.segments.length + ' silent segments');
        var picked = pickSilencesWithSpacing(analysis.segments, config.minGapSec);
        for (var si = 0; si < picked.length; si++) {
          if (picked[si] < endSec && !existingTimes.has(picked[si])) timesToInsert.push(picked[si]);
        }
      } else {
        for (var t = config.startSec; t < endSec; t += config.intervalSec) {
          var rounded = Math.round(t);
          if (!existingTimes.has(rounded)) {
            timesToInsert.push(rounded);
          }
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
        if (isCancelled()) {
          log('Stopped by user — inserted ' + inserted + ' of ' + timesToInsert.length, 'warn');
          break;
        }
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
