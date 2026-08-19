/* Shared audio primitives for the My Ear Trainer suite.
   Only the parts that are identical across trainers live here. Each page keeps
   its own playback policy: the ear trainer applies one gain per pair so the
   higher tone never sounds louder, while the fretboard trainer compensates each
   note on its own. Mixing those up would hand the ear trainer a loudness cue. */
(function (root) {
  "use strict";

  var SR = 44100;
  var ctx = null;

  var settings = { vol: 0.50, route: 'webaudio', fx: true };

  function log(msg) { if (window.console && console.warn) console.warn('[audio] ' + msg); }

  function ensureCtx() {
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { log('no AudioContext in this browser'); return null; }
    if (!ctx) {
      try { ctx = new AC(); }
      catch (e) { log('could not create context: ' + e.message); return null; }
      try {                                  // silent buffer unlocks some browsers
        var b = ctx.createBuffer(1, 1, 22050), s = ctx.createBufferSource();
        s.buffer = b; s.connect(ctx.destination); s.start(0);
      } catch (e) {}
    }
    if (ctx.state !== 'running') {
      var p = ctx.resume();
      if (p && p.then) p.then(null, function (e) { log('resume rejected: ' + e.message); });
    }
    return ctx;
  }

  // Has a context and it is awake. Callers use this to climb back out of the
  // audio-element fallback: without it one slow resume routes the rest of the
  // session through <audio> and only a reload undoes it.
  function isRunning() { return !!ctx && ctx.state === 'running'; }

  // Browsers suspend the context on a backgrounded tab and refuse to resume it
  // outside a gesture, so the first note after coming back would otherwise be
  // the one that trips the fallback. Waking it on any interaction means playback
  // almost never meets a sleeping context in the first place.
  function installUnlock(doc) {
    if (!doc || !doc.addEventListener) return;
    var wake = function () { if (!ctx || ctx.state !== 'running') ensureCtx(); };
    ['pointerdown', 'touchstart', 'keydown'].forEach(function (ev) {
      doc.addEventListener(ev, wake, { capture: true, passive: true });
    });
    doc.addEventListener('visibilitychange', function () {
      if (!doc.hidden && ctx && ctx.state === 'suspended') {
        var p = ctx.resume();
        if (p && p.then) p.then(null, function () {});
      }
    });
  }
  installUnlock(root.document);

  // [harmonic, amplitude, decay in nepers/sec]. A plucked string's upper
  // partials die away far faster than its fundamental, and that fading
  // brightness is most of what makes it sound like a string and not an organ.
  var AMPS = [1, .62, .42, .28, .19, .13, .09, .06];
  function decayOf(k) { return 1.7 * Math.pow(k, 0.82); }
  function partials() {
    var out = [];
    for (var i = 0; i < AMPS.length; i++) out.push([i + 1, AMPS[i], decayOf(i + 1)]);
    return out;
  }
  var NORM = (function () {
    var t = 0;
    for (var i = 0; i < AMPS.length; i++) t += AMPS[i];
    return Math.max(1, t * 0.72);
  })();

  // Ears are much less sensitive down low: E1 at a given amplitude sounds far
  // quieter than A4. Rough inverse of the equal-loudness contour, 1.0 at 440 Hz.
  // The 30 Hz point matters — the trainer reaches A0 at 27.5 Hz, and without it
  // everything below 50 Hz gets clamped to the same boost and comes out thin.
  function loudnessGain(f) {
    var pts = [[30, 26], [50, 22], [100, 15], [200, 9], [440, 5], [800, 1.5], [1600, 0], [3000, -1]], db;
    if (f <= pts[0][0]) db = pts[0][1];
    else if (f >= pts[pts.length - 1][0]) db = pts[pts.length - 1][1];
    else for (var i = 1; i < pts.length; i++) {
      if (f <= pts[i][0]) {
        var r = (Math.log(f) - Math.log(pts[i - 1][0])) / (Math.log(pts[i][0]) - Math.log(pts[i - 1][0]));
        db = pts[i - 1][1] + r * (pts[i][1] - pts[i - 1][1]);
        break;
      }
    }
    return Math.pow(10, (db - 5) / 20);
  }

  // Caller supplies the gain, because the right policy differs per trainer.
  function scheduleTone(c, freq, start, dur, gain, atk, rel) {
    var g = c.createGain(), peak = Math.min(0.98, 0.92 * settings.vol * (gain == null ? 1 : gain));
    atk = Math.min(atk == null ? 0.006 : atk, dur * 0.4);
    rel = Math.min(rel == null ? 0.05 : rel, dur * 0.3);
    g.gain.setValueAtTime(0.0001, start);
    g.gain.linearRampToValueAtTime(peak, start + atk);
    g.gain.setValueAtTime(peak, start + dur - rel);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    g.connect(c.destination);
    partials().forEach(function (p) {
      var pf = freq * p[0];
      if (pf > 18000) return;                // past hearing, skip it
      var o = c.createOscillator();
      o.type = 'sine'; o.frequency.setValueAtTime(pf, start);
      var pg = c.createGain(), a = p[1] / NORM;
      pg.gain.setValueAtTime(a, start);
      pg.gain.exponentialRampToValueAtTime(Math.max(0.00005, a * Math.exp(-p[2] * dur)), start + dur);
      o.connect(pg); pg.connect(g);
      o.start(start); o.stop(start + dur + 0.05);
    });
  }

  // 44-byte canonical WAV header, mono 16-bit.
  function wavHeader(dv, samples) {
    function str(o, s) { for (var k = 0; k < s.length; k++) dv.setUint8(o + k, s.charCodeAt(k)); }
    str(0, 'RIFF'); dv.setUint32(4, 36 + samples * 2, true); str(8, 'WAVE');
    str(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
    dv.setUint16(22, 1, true); dv.setUint32(24, SR, true); dv.setUint32(28, SR * 2, true);
    dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
    str(36, 'data'); dv.setUint32(40, samples * 2, true);
  }

  // blob: URLs are blocked inside the published-artifact sandbox, so the WAV
  // goes in as a data: URI instead.
  function toDataUri(buffer) {
    var bytes = new Uint8Array(buffer), bin = '', chunk = 0x8000;
    for (var i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return 'data:audio/wav;base64,' + btoa(bin);
  }

  root.TrainerAudio = {
    SR: SR,
    settings: settings,
    log: log,
    ensureCtx: ensureCtx,
    isRunning: isRunning,
    AMPS: AMPS,
    decayOf: decayOf,
    partials: partials,
    NORM: NORM,
    loudnessGain: loudnessGain,
    scheduleTone: scheduleTone,
    wavHeader: wavHeader,
    toDataUri: toDataUri
  };
})(window);
