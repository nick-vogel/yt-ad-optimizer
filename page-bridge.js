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

  // Listen for playhead seek requests from the content script
  document.addEventListener('ytadopt-seek', function (e) {
    var ms = e.detail.ms;
    var markers = document.querySelector('ytve-timeline-markers');
    if (!markers || !markers.setPlayheadMs) {
      respond('seek', false, 'setPlayheadMs not found');
      return;
    }
    try {
      markers.setPlayheadMs(ms);
      respond('seek', true, 'setPlayheadMs', markers.playheadPositionMs);
    } catch (err) {
      respond('seek', false, err.message);
    }
  });

  function respond(type, success, info, value) {
    document.dispatchEvent(new CustomEvent('ytadopt-result', {
      detail: { type: type, success: success, info: info || '', value: value }
    }));
  }
})();
