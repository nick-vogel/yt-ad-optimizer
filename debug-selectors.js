// Run in DevTools > Sources > Snippets on the monetization page
// Explore the timeline and playhead elements for seek/position methods

var result = {};
var htmlProto = Object.getOwnPropertyNames(HTMLElement.prototype);

function getCustomProps(el) {
  var allProps = [];
  var obj = el;
  while (obj && obj !== HTMLElement.prototype) {
    allProps = allProps.concat(Object.getOwnPropertyNames(obj));
    obj = Object.getPrototypeOf(obj);
  }
  return [...new Set(allProps)].filter(function(p) {
    return htmlProto.indexOf(p) === -1;
  });
}

// Check ytve-timeline-markers
var markers = document.querySelector('ytve-timeline-markers');
if (markers) {
  var mProps = getCustomProps(markers);
  result.markersNumeric = {};
  result.markersFunctions = [];
  for (var i = 0; i < mProps.length; i++) {
    try {
      var v = markers[mProps[i]];
      if (typeof v === 'number') result.markersNumeric[mProps[i]] = v;
      else if (typeof v === 'function') result.markersFunctions.push(mProps[i]);
    } catch(_) {}
  }
}

// Check ytve-timeline (parent)
var timeline = document.querySelector('ytve-timeline');
if (timeline) {
  var tProps = getCustomProps(timeline);
  result.timelineNumeric = {};
  result.timelineFunctions = [];
  for (var j = 0; j < tProps.length; j++) {
    try {
      var tv = timeline[tProps[j]];
      if (typeof tv === 'number') result.timelineNumeric[tProps[j]] = tv;
      else if (typeof tv === 'function') result.timelineFunctions.push(tProps[j]);
    } catch(_) {}
  }
}

// Check the playhead element
var playhead = document.querySelector('ytve-playhead#playhead');
if (playhead) {
  var pProps = getCustomProps(playhead);
  result.playheadNumeric = {};
  result.playheadFunctions = [];
  for (var k = 0; k < pProps.length; k++) {
    try {
      var pv = playhead[pProps[k]];
      if (typeof pv === 'number') result.playheadNumeric[pProps[k]] = pv;
      else if (typeof pv === 'function') result.playheadFunctions.push(pProps[k]);
    } catch(_) {}
  }
}

// Check for any global editor/player object
var editorEl = document.querySelector('ytve-video-editor');
if (editorEl) {
  var eProps = getCustomProps(editorEl);
  result.editorFunctions = eProps.filter(function(p) {
    try { return typeof editorEl[p] === 'function'; } catch(_) { return false; }
  });
  result.editorNumeric = {};
  for (var e = 0; e < eProps.length; e++) {
    try {
      var ev = editorEl[eProps[e]];
      if (typeof ev === 'number') result.editorNumeric[eProps[e]] = ev;
    } catch(_) {}
  }
}

console.log(JSON.stringify(result, null, 2));
