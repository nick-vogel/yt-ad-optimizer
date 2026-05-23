(function () {
  // Expose video duration as a DOM attribute for the content script
  (function pollDuration() {
    var fi = document.querySelector('ytve-framestamp-input');
    if (fi && (fi.durationMs || fi.maxMs)) {
      fi.setAttribute('data-duration-ms', fi.durationMs || fi.maxMs);
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
