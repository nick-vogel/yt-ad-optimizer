(function () {
  // Idempotency guard: the popup may re-inject this into the MAIN world. A plain
  // boolean is safe here — MAIN world has no chrome.* context to invalidate, so an
  // existing copy is never orphaned/broken; we just avoid stacking duplicate
  // poll loops and seek listeners.
  if (window.__ytAdoptBridgeLoaded) return;
  window.__ytAdoptBridgeLoaded = true;

  // Video duration in ms. Sources, in priority order: framestamp input
  // (monetization page), timeline markers (upload dialog), HTMLVideoElement
  // (fallback). Used both for the polled DOM attributes and silence analysis.
  function getDurationMs() {
    var fi = document.querySelector('ytve-framestamp-input');
    if (fi && (fi.durationMs || fi.maxMs)) return fi.durationMs || fi.maxMs;
    var markers = document.querySelector('ytve-timeline-markers');
    if (markers) {
      var m = markers.durationMs || markers.maxMs || markers.endMs || 0;
      if (m) return m;
    }
    var video = document.querySelector('video');
    if (video && isFinite(video.duration) && video.duration > 0) {
      return Math.round(video.duration * 1000);
    }
    return 0;
  }

  // Expose video duration as a DOM attribute for the content script.
  (function pollDuration() {
    var ms = getDurationMs();
    if (ms > 0) {
      var fi = document.querySelector('ytve-framestamp-input');
      if (fi) fi.setAttribute('data-duration-ms', ms);
      document.documentElement.setAttribute('data-ytadopt-duration-ms', ms);
    }
    setTimeout(pollDuration, 2000);
  })();

  // ─── Audio silence analysis ─────────────────────────────────────────────────
  // Studio exposes the rendered audio track's raw samples on
  // ytve-audio-waveform.audioWaveformData (~64 signed samples/sec). These cross
  // zero constantly, so reduce to an RMS envelope per WINDOW_MS window, then
  // threshold the envelope at TOLERANCE% of its peak to find quiet runs. (This is
  // the approach validated by the throwaway silence-probe.js spike.)
  function envelopeFromSamples(data, durationSec, windowMs) {
    if (!data || !data.length || durationSec <= 0) return [];
    var sampleRate = data.length / durationSec;
    var win = Math.max(1, Math.round((windowMs / 1000) * sampleRate));
    var env = [];
    for (var i = 0; i < data.length; i += win) {
      var sumSq = 0, n = 0;
      for (var j = i; j < i + win && j < data.length; j++) { sumSq += data[j] * data[j]; n++; }
      env.push(n ? Math.sqrt(sumSq / n) : 0);
    }
    return env;
  }

  function envelopeToSilence(env, durationSec, tolerancePct, minSilenceMs) {
    if (!env.length || durationSec <= 0) return [];
    var peak = 0, i;
    for (i = 0; i < env.length; i++) if (env[i] > peak) peak = env[i];
    if (peak <= 0) return [];
    var threshold = peak * (tolerancePct / 100);
    var secPerCol = durationSec / env.length;
    var minCols = Math.ceil((minSilenceMs / 1000) / secPerCol);

    var segs = [], runStart = -1;
    for (i = 0; i < env.length; i++) {
      var quiet = env[i] <= threshold;
      if (quiet && runStart === -1) runStart = i;
      if ((!quiet || i === env.length - 1) && runStart !== -1) {
        var runEnd = quiet ? i + 1 : i;
        if (runEnd - runStart >= minCols) {
          segs.push({
            startSec: +(runStart * secPerCol).toFixed(2),
            endSec: +(runEnd * secPerCol).toFixed(2),
          });
        }
        runStart = -1;
      }
    }
    return segs;
  }

  document.addEventListener('ytadopt-analyzeAudio', function (e) {
    var responded = false;
    function safeRespond(success, info, value) {
      if (responded) return;
      responded = true;
      try { respond('analyzeAudio', success, info, value); } catch (_) {}
    }

    var opts = e.detail || {};
    var tolerancePct = opts.tolerancePct > 0 ? opts.tolerancePct : 25;
    var minSilenceMs = opts.minSilenceMs > 0 ? opts.minSilenceMs : 500;
    var windowMs = opts.windowMs > 0 ? opts.windowMs : 100;

    // audioWaveformData is populated asynchronously after the editor opens (and
    // can lag on freshly-processed unlisted/draft videos). Poll briefly rather
    // than failing on the first miss. Stays under the content script's timeout.
    var attempts = 0;
    var MAX_ATTEMPTS = 8;   // ~4s at 500ms
    var RETRY_MS = 500;

    function attempt() {
      try {
        var wf = document.querySelector('ytve-audio-waveform');
        var data = wf && wf.audioWaveformData;
        var durationSec = getDurationMs() / 1000;

        if (!data || !data.length || !(durationSec > 0)) {
          if (++attempts < MAX_ATTEMPTS) { setTimeout(attempt, RETRY_MS); return; }
          if (!(durationSec > 0)) {
            safeRespond(false, 'could not determine video duration');
          } else {
            safeRespond(false, 'audio waveform still loading — wait a few seconds after the editor opens, then try again');
          }
          return;
        }

        var env = envelopeFromSamples(data, durationSec, windowMs);
        var segments = envelopeToSilence(env, durationSec, tolerancePct, minSilenceMs);
        safeRespond(true, segments.length + ' silent segments', segments);
      } catch (err) {
        safeRespond(false, (err && err.message) || 'unknown error');
      }
    }
    attempt();
  });

  // Listen for playhead seek requests from the content script.
  // Always respond exactly once, even on unexpected errors, so the content
  // script never has to fall back to its timeout.
  document.addEventListener('ytadopt-seek', function (e) {
    var responded = false;
    function safeRespond(success, info, value) {
      if (responded) return;
      responded = true;
      try {
        respond('seek', success, info, value);
      } catch (_) {}
    }
    try {
      var ms = e.detail && e.detail.ms;
      var markers = document.querySelector('ytve-timeline-markers');
      if (!markers || typeof markers.setPlayheadMs !== 'function') {
        safeRespond(false, 'setPlayheadMs not found');
        return;
      }
      markers.setPlayheadMs(ms);
      var pos;
      try { pos = markers.playheadPositionMs; } catch (_) { pos = null; }
      safeRespond(true, 'setPlayheadMs', pos);
    } catch (err) {
      safeRespond(false, (err && err.message) || 'unknown error');
    }
  });

  function respond(type, success, info, value) {
    document.dispatchEvent(new CustomEvent('ytadopt-result', {
      detail: { type: type, success: success, info: info || '', value: value }
    }));
  }
})();
