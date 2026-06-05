// SILENCE-DETECTION FEASIBILITY PROBE (throwaway — not shipped in the extension)
//
// Run in DevTools > Sources > Snippets on the Studio monetization page, with a
// video loaded so its audio waveform is visible in the timeline.
//
// Goal: find a per-time audio-amplitude source and print silent segments, so we
// know which of approach C/B/A is viable before building the "Silence" mode.
//   C — Studio's own waveform/peaks data (best: clean numbers, no playback/CORS)
//   B — read the rendered waveform <canvas> pixels (fallback)
//   A — Web Audio API on <video> (expected dead end: cross-origin zeros + needs 1x playback)
//
// Output: SILENCE_PROBE.run() logs the chosen source and a list of
// [{ startSec, endSec, durSec }] silent segments. Tune the two thresholds below.

var SILENCE_PROBE = (function () {
  // ─── Thresholds (the two knobs the competitor exposes) ──────────────────────
  var TOLERANCE_PCT = 25;    // envelope at/below this % of peak counts as "quiet"
  var MIN_SILENCE_MS = 500;  // a quiet run shorter than this is ignored
  var WINDOW_MS = 100;       // envelope window: RMS over this span smooths the raw signal

  var htmlProto = Object.getOwnPropertyNames(HTMLElement.prototype);

  function getCustomProps(el) {
    var props = [];
    var obj = el;
    while (obj && obj !== HTMLElement.prototype) {
      props = props.concat(Object.getOwnPropertyNames(obj));
      obj = Object.getPrototypeOf(obj);
    }
    return [...new Set(props)].filter(function (p) { return htmlProto.indexOf(p) === -1; });
  }

  function isNumberArray(v) {
    if (!v) return false;
    if (Array.isArray(v) && v.length > 8 && typeof v[0] === 'number') return true;
    // typed arrays (Float32Array etc.) — what waveform peaks usually are
    if (v.buffer && typeof v.length === 'number' && v.length > 8 && typeof v[0] === 'number') return true;
    return false;
  }

  function getDurationSec() {
    var attr = document.documentElement.getAttribute('data-ytadopt-duration-ms');
    if (attr) return parseInt(attr, 10) / 1000;
    var fi = document.querySelector('ytve-framestamp-input');
    if (fi && (fi.durationMs || fi.maxMs)) return (fi.durationMs || fi.maxMs) / 1000;
    var m = document.querySelector('ytve-timeline-markers');
    if (m && (m.durationMs || m.maxMs || m.endMs)) return (m.durationMs || m.maxMs || m.endMs) / 1000;
    var v = document.querySelector('video');
    if (v && isFinite(v.duration) && v.duration > 0) return v.duration;
    return 0;
  }

  // Turn a per-column amplitude profile (any scale) into silent segments.
  function profileToSilence(profile, durationSec) {
    if (!profile || !profile.length || durationSec <= 0) return [];
    var peak = 0, i;
    for (i = 0; i < profile.length; i++) if (profile[i] > peak) peak = profile[i];
    if (peak <= 0) return [];
    var threshold = peak * (TOLERANCE_PCT / 100);
    var secPerCol = durationSec / profile.length;
    var minCols = Math.ceil((MIN_SILENCE_MS / 1000) / secPerCol);

    var segs = [], runStart = -1;
    for (i = 0; i < profile.length; i++) {
      var quiet = profile[i] <= threshold;
      if (quiet && runStart === -1) runStart = i;
      if ((!quiet || i === profile.length - 1) && runStart !== -1) {
        var runEnd = quiet ? i + 1 : i;
        if (runEnd - runStart >= minCols) {
          segs.push({
            startSec: +(runStart * secPerCol).toFixed(2),
            endSec: +(runEnd * secPerCol).toFixed(2),
            durSec: +((runEnd - runStart) * secPerCol).toFixed(2),
          });
        }
        runStart = -1;
      }
    }
    return segs;
  }

  // Studio's audioWaveformData is raw SIGNED PCM-ish samples (~64/sec), so it
  // crosses zero constantly even in loud audio. Reduce it to an amplitude
  // envelope first: RMS over WINDOW_MS windows. profileToSilence then thresholds
  // that smooth envelope instead of the noisy raw signal.
  function envelopeFromSamples(data, durationSec) {
    if (!data || !data.length || durationSec <= 0) return [];
    var sampleRate = data.length / durationSec;
    var win = Math.max(1, Math.round((WINDOW_MS / 1000) * sampleRate));
    var env = [];
    for (var i = 0; i < data.length; i += win) {
      var sumSq = 0, n = 0;
      for (var j = i; j < i + win && j < data.length; j++) { sumSq += data[j] * data[j]; n++; }
      env.push(n ? Math.sqrt(sumSq / n) : 0);
    }
    return env;
  }

  // ─── Source C: Studio's own peaks/waveform data ─────────────────────────────
  // Walk likely custom elements for a numeric array property or a waveform URL.
  function probeSourceC() {
    var candidates = document.querySelectorAll(
      'ytve-timeline, ytve-timeline-markers, ytve-audio-track, ytve-audio-waveform, ' +
      'ytve-waveform, [class*="audio"], [class*="waveform"], ytve-video-editor'
    );
    var hits = [];
    candidates.forEach(function (el) {
      getCustomProps(el).forEach(function (p) {
        var v;
        try { v = el[p]; } catch (_) { return; }
        if (isNumberArray(v)) {
          hits.push({ tag: el.tagName.toLowerCase(), prop: p, len: v.length, sample: Array.prototype.slice.call(v, 0, 5) });
        } else if (typeof v === 'string' && /wave|peak|audio/i.test(p) && /https?:|blob:|data:/.test(v)) {
          hits.push({ tag: el.tagName.toLowerCase(), prop: p, url: v.slice(0, 120) });
        }
      });
    });
    return hits;
  }

  // ─── Source B: read the rendered waveform <canvas> pixels ────────────────────
  // Find canvases inside the timeline; build a per-column "ink height" profile
  // (how many non-background pixels per column ≈ amplitude).
  function probeSourceB() {
    var canvases = document.querySelectorAll('canvas');
    var best = null;
    canvases.forEach(function (c) {
      if (c.width < 200 || c.height < 8) return; // skip tiny/icon canvases
      var ctx;
      try { ctx = c.getContext('2d'); } catch (_) { return; }
      if (!ctx) return;
      var img;
      try { img = ctx.getImageData(0, 0, c.width, c.height); } catch (_) { return; } // tainted
      var data = img.data, w = c.width, h = c.height;
      var profile = new Array(w).fill(0);
      for (var x = 0; x < w; x++) {
        var count = 0;
        for (var y = 0; y < h; y++) {
          var idx = (y * w + x) * 4;
          // non-transparent, non-near-black pixel = waveform ink
          if (data[idx + 3] > 16 && (data[idx] + data[idx + 1] + data[idx + 2]) > 30) count++;
        }
        profile[x] = count;
      }
      var sum = profile.reduce(function (a, b) { return a + b; }, 0);
      if (!best || sum > best.sum) best = { canvas: c, profile: profile, sum: sum, w: w };
    });
    return best;
  }

  // ─── Source A: Web Audio on <video> (sanity check only) ──────────────────────
  function probeSourceA() {
    var v = document.querySelector('video');
    if (!v) return { ok: false, reason: 'no <video> element' };
    return {
      ok: false,
      reason: 'Web Audio on cross-origin media (googlevideo.com) yields zeroed samples ' +
        'and requires real-time 1x playback. video.crossOrigin=' + (v.crossOrigin || 'null') +
        ', src host=' + (function () { try { return new URL(v.currentSrc || v.src).host; } catch (_) { return '?'; } })(),
    };
  }

  function run() {
    var durationSec = getDurationSec();
    console.log('=== Silence probe === duration=' + durationSec.toFixed(1) + 's, ' +
      'tolerance=' + TOLERANCE_PCT + '%, minSilence=' + MIN_SILENCE_MS + 'ms');

    var c = probeSourceC();
    console.log('Source C (Studio peaks data) candidates:', c);
    if (c.length) {
      var arr = c.find(function (h) { return h.len; });
      if (arr) {
        var el = document.querySelector(arr.tag);
        var raw = Array.prototype.slice.call(el[arr.prop]);
        // Raw samples are signed (~64/sec) — reduce to an RMS envelope first.
        var envelope = envelopeFromSamples(raw, durationSec);
        var segs = profileToSilence(envelope, durationSec);
        var totalQuiet = segs.reduce(function (s, x) { return s + x.durSec; }, 0);
        console.log('✅ Source C usable via ' + arr.tag + '.' + arr.prop +
          ' (' + raw.length + ' samples → ' + envelope.length + ' windows). ' +
          segs.length + ' silent segments, ' + totalQuiet.toFixed(1) + 's total quiet:', segs);
        console.log('   (verify these line up with quiet stretches in the on-screen waveform)');
        return { source: 'C', segments: segs };
      }
    }

    var b = probeSourceB();
    console.log('Source B (canvas pixels):', b ? { w: b.w, ink: b.sum } : 'no readable canvas');
    if (b && b.sum > 0) {
      var segsB = profileToSilence(b.profile, durationSec);
      console.log('✅ Source B usable via canvas pixels → silent segments:', segsB);
      console.log('   (verify these line up with quiet stretches in the on-screen waveform)');
      return { source: 'B', segments: segsB };
    }

    var a = probeSourceA();
    console.log('Source A (Web Audio):', a.reason);
    console.warn('❌ No usable silence source found. Inspect the Source C candidate dump above ' +
      'for array-like props, or check whether the waveform is a canvas vs SVG.');
    return { source: null, segments: [] };
  }

  return {
    run: run,
    profileToSilence: profileToSilence,
    envelopeFromSamples: envelopeFromSamples,
    getDurationSec: getDurationSec,
    set tolerance(v) { TOLERANCE_PCT = v; },
    set minSilenceMs(v) { MIN_SILENCE_MS = v; },
    set windowMs(v) { WINDOW_MS = v; },
  };
})();

console.log('Loaded. Run:  SILENCE_PROBE.run()  (tune: SILENCE_PROBE.tolerance = 15)');
