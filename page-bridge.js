(function () {
  // Expose video duration as a DOM attribute for the content script.
  // Sources, in priority order: framestamp input (monetization page),
  // timeline markers (upload dialog), HTMLVideoElement.duration (fallback).
  (function pollDuration() {
    var ms = 0;
    var fi = document.querySelector('ytve-framestamp-input');
    if (fi && (fi.durationMs || fi.maxMs)) {
      ms = fi.durationMs || fi.maxMs;
      fi.setAttribute('data-duration-ms', ms);
    }
    if (!ms) {
      var markers = document.querySelector('ytve-timeline-markers');
      if (markers) {
        ms = markers.durationMs || markers.maxMs || markers.endMs || 0;
      }
    }
    if (!ms) {
      var video = document.querySelector('video');
      if (video && isFinite(video.duration) && video.duration > 0) {
        ms = Math.round(video.duration * 1000);
      }
    }
    if (ms > 0) {
      document.documentElement.setAttribute('data-ytadopt-duration-ms', ms);
    }
    setTimeout(pollDuration, 2000);
  })();

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
