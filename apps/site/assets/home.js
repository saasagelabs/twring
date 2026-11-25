/* twring.com home, variation 5: variation 2 ("Try the call") with the signal line from variation 1
   and the dot field and spotlit wordmark from variation 4.
   Parts: the phone-width menu, the film's sound switch, the signal lines, the dot fields, the two
   scripted samples, the giant wordmark, and small touches in two sections. Everything that moves asks one shared observer whether
   it is on screen, and one shared listener whether the tab is visible.
   Nothing here records, listens or talks to a server: the samples are a script read from the page. */
/* global document, window */
(function () {
  'use strict';
  var doc = document, root = doc.documentElement;
  var still = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  var raf = window.requestAnimationFrame ? window.requestAnimationFrame.bind(window) : function (f) { return window.setTimeout(function () { f(Date.now()); }, 16); };
  function byId(id) { return doc.getElementById(id); }
  function now() { return window.performance && window.performance.now ? window.performance.now() : Date.now(); }

  // One observer for the whole page. `fn(on)` is told when `el` is on screen by at least `min`.
  var watched = [], io = null;
  function watch(el, min, fn) {
    if (!('IntersectionObserver' in window)) { fn(true); return; }
    if (!io) {
      io = new window.IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          for (var i = 0; i < watched.length; i++) {
            if (watched[i].el === e.target) watched[i].fn(e.isIntersecting && e.intersectionRatio >= watched[i].min);
          }
        });
      }, { threshold: [0, 0.2, 0.35] });
    }
    watched.push({ el: el, min: min, fn: fn });
    io.observe(el);
  }
  // One visibility listener: every moving part is nudged when the tab comes back or goes away.
  var onShow = [];
  doc.addEventListener('visibilitychange', function () { onShow.forEach(function (f) { f(); }); });
  // Size changes, settled.
  function onResize(el, fn) {
    var t = 0, go = function () { window.clearTimeout(t); t = window.setTimeout(fn, 150); };
    window.addEventListener('resize', go);
    if (el && window.ResizeObserver) new window.ResizeObserver(go).observe(el);
  }

  // 1. The phone-width menu: the button opens it and moves to its first link; a link, Escape, or
  // moving on past the header closes it.
  (function () {
    var menu = byId('menuBtn'), links = byId('navLinks');
    if (!menu || !links) return;
    function setMenu(open) {
      links.classList.toggle('open', open);
      menu.setAttribute('aria-expanded', String(open));
      menu.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    }
    menu.addEventListener('click', function () {
      var open = !links.classList.contains('open');
      setMenu(open);
      // The links sit before the button in the page, so the keyboard would otherwise skip them.
      if (open) { var first = links.querySelector('a'); if (first) first.focus(); }
    });
    var header = menu.closest('header');
    if (header) header.addEventListener('focusout', function (e) {
      if (links.classList.contains('open') && e.relatedTarget && !header.contains(e.relatedTarget)) setMenu(false);
    });
    links.querySelectorAll('a').forEach(function (a) { a.addEventListener('click', function () { setMenu(false); }); });
    doc.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && links.classList.contains('open')) { setMenu(false); menu.focus(); }
    });
  })();

  // 2. The film plays muted while it is on screen. With reduced motion it waits for a tap on its
  // controls.
  (function () {
    var film = byId('film'), sound = byId('filmSound'), label = byId('filmSoundLabel'), waves = byId('filmWaves');
    if (!film || !sound) return;
    if (still) { film.controls = true; return; }
    sound.hidden = false;
    var play = function () { var p = film.play(); if (p && p.catch) p.catch(function () { film.controls = true; sound.hidden = true; }); };
    // Already on screen at load: start now rather than wait for the first observer report.
    var box = film.getBoundingClientRect();
    if (box.top < window.innerHeight && box.bottom > 0) play();
    watch(film, 0.35, function (on) { if (on) play(); else film.pause(); });
    sound.addEventListener('click', function () {
      film.muted = !film.muted;
      if (!film.muted && film.paused) play();
      label.textContent = film.muted ? 'Turn sound on' : 'Turn sound off';
      waves.setAttribute('opacity', film.muted ? '.35' : '1');
    });
  })();

  // 3. The signal lines (from variation 1): one under the hero, one above "You stay in control."
  // A demo, labelled as one: flat at rest, each answers the pointer and gives one short utterance
  // the first time it is seen. While the hero sample call plays, the first follows that call's level. It plays no sound
  // and listens to nothing. It draws only while there is energy in it.
  function makeSignal(box) {
    var cv = box.querySelector('canvas');
    if (!cv || !cv.getContext) return null;
    var ctx = cv.getContext('2d');
    if (!ctx) return null;
    var W = 0, H = 0, px = 0, sx = 0, e = 0, running = false, t0 = 0, auto = 0, greeted = false, seen = false;
    var source = null, tint = '25,214,242';
    var lite = window.innerWidth < 768;
    function clamp(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
    function size() {
      var r = box.getBoundingClientRect(), dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = r.width; H = r.height;
      cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      draw(0);
    }
    function trace(t) {
      var mid = Math.round(H / 2) + 0.5, sig = Math.max(70, W * 0.11), amp = H * 0.4 * e, step = lite ? 3 : 2;
      ctx.beginPath();
      ctx.moveTo(0, mid);
      if (amp > 0.3) {
        var from = Math.max(0, sx - sig * 3), to = Math.min(W, sx + sig * 3);
        ctx.lineTo(from, mid);
        for (var x = from; x <= to; x += step) {
          var dx = (x - sx) / sig, win = Math.exp(-dx * dx);
          // Three partials and a slow syllable swell: reads as speech, not as a sine.
          var v = Math.sin(x * 0.09 + t * 9) * 0.5 + Math.sin(x * 0.21 - t * 13) * 0.3 + Math.sin(x * 0.47 + t * 21) * 0.2;
          v *= 0.55 + 0.45 * Math.sin(t * 7 + x * 0.012);
          ctx.lineTo(x, mid + v * win * amp);
        }
        ctx.lineTo(to, mid);
      }
      ctx.lineTo(W, mid);
    }
    function draw(t) {
      ctx.clearRect(0, 0, W, H);
      ctx.lineWidth = 1; ctx.lineJoin = 'round';
      trace(t);
      ctx.strokeStyle = 'rgba(255,255,255,0.42)';
      ctx.stroke();
      if (e > 0.01 && W > 0) {
        var sig = Math.max(70, W * 0.11), a = clamp((sx - sig * 2.2) / W), b = clamp(sx / W), c = clamp((sx + sig * 2.2) / W);
        var g = ctx.createLinearGradient(0, 0, W, 0);
        g.addColorStop(a, 'rgba(' + tint + ',0)');
        g.addColorStop(Math.max(a, b), 'rgba(' + tint + ',' + Math.min(1, e * 1.6).toFixed(3) + ')');
        g.addColorStop(Math.max(b, c), 'rgba(' + tint + ',0)');
        ctx.strokeStyle = g;
        ctx.lineWidth = 1.25;
        ctx.stroke();
      }
    }
    function frame(ts) {
      if (!seen || doc.hidden) { running = false; return; }
      if (!t0) t0 = ts;
      var t = (ts - t0) / 1000, fed = source ? source() : null;
      if (fed && fed.level > 0) {
        // The sample call is speaking: same level as the phone's waveform. You on the left in
        // cyan, your agent on the right in white.
        auto = 0;
        px = W * (fed.who === 'you' ? 0.3 : 0.7);
        tint = fed.who === 'you' ? '25,214,242' : '232,234,238';
        if (e < 0.02) sx = px;
        e += (fed.level * 0.85 - e) * 0.3;
      } else if (auto) {
        // One utterance the first time the line is seen, so it is seen to answer. Never repeats.
        var k = (ts - auto) / 1700;
        if (k >= 1) { auto = 0; } else { px = W * (0.12 + 0.5 * k); e = Math.sin(Math.PI * k) * 0.75; }
      } else {
        e *= 0.93;
      }
      sx += (px - sx) * 0.22;
      if (e < 0.004 && !auto && !(fed && fed.level > 0)) { e = 0; running = false; draw(t); return; }
      draw(t);
      raf(frame);
    }
    function wake() { if (!running && seen && !doc.hidden) { running = true; raf(frame); } }
    function touch(ev) {
      var r = box.getBoundingClientRect();
      auto = 0;
      tint = '25,214,242';
      px = ev.clientX - r.left;
      if (e < 0.05) sx = px;
      e = Math.min(1, e + (ev.type === 'pointerdown' ? 0.6 : 0.16));
      wake();
    }
    box.addEventListener('pointermove', touch, { passive: true });
    box.addEventListener('pointerdown', touch, { passive: true });
    onShow.push(function () { if (doc.hidden) { e = 0; auto = 0; } else wake(); });
    onResize(null, size);
    root.classList.add('signal-on');
    size();
    watch(box, 0.35, function (on) {
      seen = on;
      if (on && !greeted) { greeted = true; sx = px = W * 0.12; auto = now(); }
      if (on) wake();
    });
    return { wake: wake, from: function (fn) { source = fn; } };
  }
  // One module, every line on the page. Only the first (the one with the label) follows the call.
  var signal = null;
  if (!still) Array.prototype.forEach.call(doc.querySelectorAll('.signal'), function (box) {
    var s = makeSignal(box);
    if (s && box.id === 'signal') signal = s;
  });

  // 4. The dot fields behind the Rings section and the closing section (from variation 4). Each leans toward the pointer; behind the ring phone
  // a ripple leaves the phone each time the sample ring rings. They draw only while something moves.
  function makeField(cv, base) {
    var host = cv && cv.parentNode;
    if (!cv || !cv.getContext) return null;
    var ctx = cv.getContext('2d');
    if (!ctx) return null;
    var w = 0, h = 0, gap = 28, dots = [], px = 0, py = 0, pull = 0, want = 0, waves = [], running = 0, seen = true;

    function size() {
      var r = host.getBoundingClientRect(), dpr = Math.min(window.devicePixelRatio || 1, 2);
      if (Math.abs(r.width - w) < 1 && Math.abs(r.height - h) < 1) return;
      w = r.width; h = r.height;
      gap = w < 700 ? 24 : 30;
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      dots = [];
      var ox = (w % gap) / 2, oy = (h % gap) / 2;
      for (var y = oy; y < h; y += gap) for (var x = ox; x < w; x += gap) dots.push(x, y);
      draw(now());
    }
    function draw(ts) {
      ctx.clearRect(0, 0, w, h);
      var live = [], i, k;
      for (k = 0; k < waves.length; k++) if (ts - waves[k].t < waves[k].life) live.push(waves[k]);
      waves = live;
      for (i = 0; i < dots.length; i += 2) {
        var x = dots[i], y = dots[i + 1], ox = 0, oy = 0, glow = 0;
        if (pull > 0.01) {
          var dx = px - x, dy = py - y, d2 = dx * dx + dy * dy;
          var f = Math.exp(-d2 / 36000) * pull;          // about 190 px reach
          ox += dx * 0.16 * f; oy += dy * 0.16 * f; glow = f;
        }
        for (k = 0; k < waves.length; k++) {
          var wv = waves[k], age = (ts - wv.t) / wv.life;
          var wx = x - wv.x, wy = y - wv.y, dist = Math.sqrt(wx * wx + wy * wy) || 1;
          var off = dist - age * wv.reach;
          var a = Math.exp(-(off * off) / 1800) * (1 - age);
          ox += (wx / dist) * 9 * a; oy += (wy / dist) * 9 * a;
          glow = Math.max(glow, a);
        }
        if (glow > 0.04) {
          ctx.fillStyle = 'rgba(25,214,242,' + Math.min(0.2 + glow * 0.8, 1).toFixed(2) + ')';
          ctx.fillRect(x + ox - 1, y + oy - 1, 2, 2);
        } else {
          ctx.fillStyle = 'rgba(255,255,255,' + base + ')';
          ctx.fillRect(x - 0.5, y - 0.5, 1, 1);
        }
      }
    }
    function tick() {
      running = 0;
      pull += (want - pull) * 0.12;
      if (Math.abs(want - pull) < 0.005) pull = want;
      draw(now());
      if (seen && !doc.hidden && (pull !== want || pull > 0 || waves.length)) running = raf(tick) || 1;
    }
    function wake() { if (!running && seen && !doc.hidden && !still) running = raf(tick) || 1; }
    function at(e) { var r = host.getBoundingClientRect(); px = e.clientX - r.left; py = e.clientY - r.top; }
    if (!still) {
      host.addEventListener('pointermove', function (e) { at(e); want = 1; wake(); }, { passive: true });
      host.addEventListener('pointerdown', function (e) { at(e); want = 1; wake(); }, { passive: true });
      ['pointerleave', 'pointerup', 'pointercancel'].forEach(function (n) {
        host.addEventListener(n, function (e) { if (n !== 'pointerup' || e.pointerType !== 'mouse') { want = 0; wake(); } }, { passive: true });
      });
      onShow.push(wake);
      watch(host, 0, function (on) { seen = on; if (on) wake(); });
    }
    onResize(host, size);
    size();
    return {
      /** One ripple, outward from the middle of `el`. Called by the sample ring, never by a timer here. */
      wave: function (el) {
        if (still || !seen || doc.hidden) return;
        var r = el.getBoundingClientRect(), hr = host.getBoundingClientRect();
        waves.push({ x: r.left + r.width / 2 - hr.left, y: r.top + r.height / 2 - hr.top, t: now(), life: 1500, reach: Math.max(w, h) * 0.9 });
        wake();
      }
    };
  }
  var field = makeField(byId('field'), 0.17);
  // The same dots, dimmer, behind the closing section. Pointing at or focusing the invite button
  // sends one ripple from it.
  (function () {
    var f = makeField(byId('fieldAccess'), 0.1), btn = byId('accessBtn');
    if (!f || !btn) return;
    var ripple = function () { f.wave(btn); };
    btn.addEventListener('pointerenter', ripple);
    btn.addEventListener('focus', ripple);
  })();

  // 5. The samples: a scripted call in the hero phone, a scripted ring in the second phone.
  (function () {
    var callPhone = byId('callPhone'), ringPhone = byId('ringPhone');
    if (!callPhone || !ringPhone || !window.Promise || !window.requestAnimationFrame) return;
    var RM = still;
    var PHONE_ICON = '<svg width="26" height="26" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h3.5l1.6 4.2-2.2 1.4a11 11 0 0 0 6.5 6.5l1.4-2.2L20 15.5V19a1.5 1.5 0 0 1-1.6 1.5A16.5 16.5 0 0 1 3.5 5.6 1.5 1.5 0 0 1 5 4z" fill="#001620"/></svg>';

    function $(s, p) { return (p || doc).querySelector(s); }
    function $$(s, p) { return Array.prototype.slice.call((p || doc).querySelectorAll(s)); }
    function el(tag, cls, text) {
      var n = doc.createElement(tag);
      if (cls) n.className = cls;
      if (text) n.textContent = text;
      if (tag === 'button') n.type = 'button';
      return n;
    }
    function toButton(span, label) {
      var b = el('button', span.className);
      b.innerHTML = span.innerHTML;
      if (label) b.setAttribute('aria-label', label);
      span.parentNode.replaceChild(b, span);
      return b;
    }

    /**
     * One phone's call screen. It keeps its own clock, which only runs while the phone is on screen
     * and the tab is visible, so a sample pauses where it is instead of playing to nobody.
     */
    function Stage(phone, onPlay) {
      var cv = $('.cv', phone), caps = $('.caps', cv), status = $('.cv-status', cv), time = $('.cv-time', cv);
      var hint = $('.cv-hint', cv), bars = $$('.wave i', cv);
      var clock = 0, last = 0, frameId = 0, timers = [], gen = 0, level = 0, target = 0, started = -1, shown = '', inView = true, flat = false;
      var shape = bars.map(function (_, i) { var x = (i - (bars.length - 1) / 2) / (bars.length / 2); return 0.3 + 0.7 * Math.cos(x * Math.PI / 2); });
      var S = { cv: cv, hint: hint, onLevel: null };

      cv.removeAttribute('data-talk');
      caps.setAttribute('role', 'log');
      caps.setAttribute('aria-live', 'polite');
      caps.setAttribute('aria-label', 'Call captions');

      var end = toButton($('[data-end]', cv), 'End the demo call');
      var go = el('button', 'call-go');
      go.innerHTML = '<i>' + PHONE_ICON + '</i><span></span>';
      $('.cv-ctl', cv).appendChild(go);
      S.end = end;
      S.go = go;

      function needs() { return timers.length > 0 || level > 0 || started >= 0; }
      function live() { return inView && !doc.hidden; }
      function kick() { if (!frameId && live() && needs()) { last = 0; frameId = window.requestAnimationFrame(frame); } }
      function draw(dt) {
        target *= Math.pow(0.5, dt / 220);
        level += (target - level) * Math.min(1, dt / 70);
        if (level < 0.01 && target < 0.01) level = 0;
        if (!RM && !(flat && level === 0)) {
          cv.style.setProperty('--lvl', level.toFixed(2));
          for (var i = 0; i < bars.length; i++) {
            var n = 0.55 + 0.45 * Math.sin(clock / 83 + i * 1.9) * Math.sin(clock / 47 + i * 0.7);
            bars[i].style.transform = 'scaleY(' + Math.max(0.07, level * shape[i] * n).toFixed(3) + ')';
          }
          flat = level === 0;
        }
        if (level > 0 && S.onLevel) S.onLevel();
        if (started >= 0) {
          var s = Math.floor((clock - started) / 1000), txt = '00:' + (s < 10 ? '0' : '') + s;
          if (txt !== shown) { shown = txt; time.textContent = txt; }
        }
      }
      function frame(ts) {
        frameId = 0;
        var dt = last ? Math.min(ts - last, 100) : 16;
        last = ts;
        clock += dt;
        var due = [], keep = [];
        timers.forEach(function (t) { (t.at <= clock ? due : keep).push(t); });
        timers = keep;
        due.forEach(function (t) { t.fn(); });
        draw(dt);
        if (live() && needs()) frameId = window.requestAnimationFrame(frame);
      }
      function add(li) {
        caps.appendChild(li);
        while (caps.children.length > 3) caps.removeChild(caps.firstChild);
      }

      /** The level the waveform is drawn from, and whose voice it is. Zero while the sample is paused. */
      S.voiceLevel = function () { return { level: live() ? level : 0, who: cv.getAttribute('data-voice') }; };
      /** Resolves after `ms` of on-screen time, or never if the sample was stopped meanwhile. */
      S.wait = function (ms) {
        var g = gen;
        return new Promise(function (res) {
          timers.push({ at: clock + ms, fn: function () { if (g === gen) res(); } });
          kick();
        });
      };
      S.stop = function () {
        gen++;
        timers = [];
        started = -1;
        target = 0;
        level = 0;
        cv.removeAttribute('data-talk');
        cv.classList.remove('cutflash');
        draw(0);
      };
      S.set = function (state, text) {
        cv.setAttribute('data-state', state);
        status.textContent = text;
        hint.hidden = state !== 'idle';
      };
      S.voice = function (who) { cv.setAttribute('data-voice', who); };
      S.clear = function () { caps.textContent = ''; };
      S.startTimer = function () { started = clock; shown = '00:00'; time.textContent = shown; kick(); };
      /** The audible stop: the level drops at once, it does not fade. */
      S.hush = function () { target = 0; level = 0; draw(0); };
      S.say = async function (who, label, text) {
        S.voice(who);
        var li = el('li', 'cap in ' + (who === 'you' ? 'u' : 'a')), p = el('p');
        li.appendChild(el('span', 'who', label));
        li.appendChild(p);
        var words = text.split(' ');
        var spans = words.map(function (w, i) {
          var s = el('span', RM ? 'on' : '', w);
          p.appendChild(s);
          if (i < words.length - 1) p.appendChild(doc.createTextNode(' '));
          return s;
        });
        add(li);
        if (RM) {
          cv.setAttribute('data-talk', '1');
          await S.wait(700 + words.length * 150);
          cv.removeAttribute('data-talk');
          return li;
        }
        for (var i = 0; i < spans.length; i++) {
          spans[i].classList.add('on');
          target = 0.55 + Math.random() * 0.45;
          await S.wait((who === 'you' ? 120 : 105) + words[i].length * 16 + (/[.?!,]$/.test(words[i]) ? 140 : 0));
        }
        return li;
      };
      /** A permission card with two real buttons. `choice` resolves with 'allow' or 'deny'. */
      S.ask = function (text, small) {
        var li = el('li', 'cap ask in'), bts = el('div', 'ask-bts'), y = el('button', 'y', 'Allow'), n = el('button', 'n', 'Deny');
        var choice = new Promise(function (res) {
          y.addEventListener('click', function () { res('allow'); });
          n.addEventListener('click', function () { res('deny'); });
        });
        bts.appendChild(y);
        bts.appendChild(n);
        li.appendChild(el('p', '', text));
        li.appendChild(bts);
        var sm = el('small', '', small);
        li.appendChild(sm);
        add(li);
        return {
          choice: choice,
          lock: function (which) {
            var had = doc.activeElement === y || doc.activeElement === n;
            y.disabled = n.disabled = true;
            li.classList.add('done');
            sm.textContent = which === 'allow' ? 'Allowed' : 'Denied';
            if (had) end.focus();
          },
        };
      };
      S.idle = function (label, hintNodes, disabled) {
        S.stop();
        S.clear();
        S.voice('agent');
        hint.textContent = '';
        hintNodes.forEach(function (n) { hint.appendChild(typeof n === 'string' ? doc.createTextNode(n) : n); });
        go.lastChild.textContent = label;
        go.disabled = !!disabled;
        S.set('idle', 'Demo call');
      };
      S.finish = function (label) {
        var had = cv.contains(doc.activeElement);
        S.stop();
        go.lastChild.textContent = label;
        go.disabled = false;
        S.set('ended', 'Call ended');
        if (had) go.focus();
      };
      /** Move focus from the control that is about to disappear to End, if it was in this phone. */
      S.holdFocus = function (had) { if (had) end.focus(); };

      go.addEventListener('click', function () { onPlay(S); });
      end.addEventListener('click', function () { S.finish(S.again); });
      watch(phone, 0.2, function (on) { inView = on; kick(); });
      onShow.push(kick);
      return S;
    }

    // The ring phone gets its own copy of the call screen, for after you answer.
    $('.screen', ringPhone).appendChild($('.cv', callPhone).cloneNode(true));

    var agent = { name: '', where: '', href: '', link: '', logo: '', ringOnly: false };
    var radios = $$('#agents input'), agentLink = byId('agentLink');
    var APPS = 'AI apps (Claude, ChatGPT and Grok Bot)';
    function texts(id) {
      var out = { list: [] };
      $$('#' + id + ' li').forEach(function (li) {
        var t = $('.t', li).textContent;
        out.list.push(t);
        if (li.getAttribute('data-k')) out[li.getAttribute('data-k')] = t;
      });
      return out;
    }

    // The sample call: calling, listening, working, speaking, an interruption, and a result.
    var C = Stage(callPhone, playCall);
    C.again = 'Play again';
    // The signal line reads the same level the phone's waveform is drawn from.
    if (signal) { signal.from(C.voiceLevel); C.onLevel = signal.wake; }
    async function playCall(S) {
      var L = texts('scriptCall').list, them = agent.name.toUpperCase(), had = S.cv.contains(doc.activeElement);
      S.stop();
      S.clear();
      S.voice('agent');
      S.set('calling', 'Calling ' + agent.name + '…');
      S.holdFocus(had);
      await S.wait(1900);
      S.startTimer();
      S.set('listening', 'Listening');
      await S.wait(450);
      await S.say('you', 'YOU', L[0]);
      S.set('working', 'Working…');
      await S.wait(1200);
      S.set('speaking', 'Speaking');
      var cut = await S.say('agent', them, L[1]);
      // You cut in: the agent's voice stops at once and the line ends where it was.
      S.hush();
      cut.classList.add('cut');
      S.cv.classList.add('cutflash');
      S.set('listening', 'Listening');
      await S.say('you', 'YOU', L[2]);
      S.cv.classList.remove('cutflash');
      await S.wait(300);
      S.set('speaking', 'Speaking');
      await S.say('agent', them, L[3]);
      await S.wait(500);
      S.set('listening', 'Listening');
      await S.say('you', 'YOU', L[4]);
      S.set('working', 'Working…');
      await S.wait(1000);
      S.set('speaking', 'Speaking');
      await S.say('agent', them, L[5]);
      await S.wait(1100);
      S.finish(S.again);
    }
    function resetCall() {
      if (agent.ringOnly) {
        // AI apps are in the other group: they ring and message, and there is no call to play.
        var a = el('a', '', 'See a ring');
        a.href = '#ring';
        C.idle('No live calls', [APPS + ' ring and message you. They do not take live calls. ', a], true);
      } else {
        C.idle('Play the call', ['A short call plays here. No sound, no microphone.'], false);
      }
    }

    // The sample ring: it arrives, rings, and is answered (by you, or by itself after four rings).
    var rv = $('.rv', ringPhone), note = $('.rv-note', rv), replies = $('.rv-replies', rv), playBtn = byId('playRing');
    var appsRing = byId('appsRing');
    var R = Stage(ringPhone, playRing);
    R.again = 'Play the ring again';
    var answerBtn = toButton($('[data-answer]', rv)), declineBtn = toButton($('[data-decline]', rv)), replyBtn = toButton($('[data-reply]', rv));
    note.setAttribute('role', 'status');
    ['Busy', 'Outside', "Let's text"].forEach(function (r) {
      var b = el('button', '', r);
      b.addEventListener('click', function () { decline(r); });
      replies.appendChild(b);
    });
    function ringIdle() {
      R.stop();
      ringPhone.setAttribute('data-view', 'ring');
      rv.setAttribute('data-state', 'idle');
      R.cv.classList.remove('enter');
      note.hidden = true;
      replies.hidden = true;
    }
    async function playRing() {
      var had = ringPhone.contains(doc.activeElement);
      ringIdle();
      rv.setAttribute('data-state', 'arriving');
      if (had) answerBtn.focus();
      await R.wait(650);
      rv.setAttribute('data-state', 'ringing');
      // Four rings on the sample's own clock. Each one sends a ripple through the dots behind the
      // phone. Answering, declining or leaving the screen stops the clock, and so the ripples.
      for (var i = 0; i < 4; i++) {
        if (field) field.wave(ringPhone);
        await R.wait(1500);
      }
      answer();
    }
    async function answer() {
      var L = texts('scriptRing'), them = agent.name.toUpperCase(), had = ringPhone.contains(doc.activeElement);
      R.stop();
      if (agent.ringOnly) {
        // An AI app does not hold a live call: say what really happens next, and stop there.
        rv.setAttribute('data-state', 'answered');
        note.textContent = 'Answered. ' + (appsRing ? appsRing.textContent : '') + ' There is no live call.';
        note.hidden = false;
        if (had && playBtn) playBtn.focus();
        return;
      }
      R.clear();
      ringPhone.setAttribute('data-view', 'call');
      R.cv.classList.add('enter');
      R.voice('agent');
      R.set('speaking', 'Speaking');
      R.startTimer();
      R.holdFocus(had);
      await R.wait(500);
      await R.say('agent', them, L.open);
      R.set('listening', 'Listening');
      var card = R.ask(L.ask, 'Say yes or no, or tap.');
      var pick = await Promise.race([card.choice, R.wait(4200).then(function () { return 'voice'; })]);
      if (pick === 'voice') {
        pick = 'allow';
        card.lock(pick);
        await R.say('you', 'YOU', L.yes);
      } else {
        card.lock(pick);
      }
      await R.wait(400);
      R.set('speaking', 'Speaking');
      await R.say('agent', them, pick === 'allow' ? L.done : L.deny);
      await R.wait(1100);
      R.finish(R.again);
    }
    function decline(reply) {
      var had = rv.contains(doc.activeElement);
      R.stop();
      rv.setAttribute('data-state', 'declined');
      replies.hidden = true;
      note.textContent = reply ? 'Declined with "' + reply + '". Your agent receives your reply.' : 'Declined.';
      note.hidden = false;
      if (had && playBtn) playBtn.focus();
    }
    answerBtn.addEventListener('click', answer);
    declineBtn.addEventListener('click', function () { decline(''); });
    replyBtn.addEventListener('click', function () {
      R.stop();
      rv.setAttribute('data-state', 'reply');
      replies.hidden = false;
      replies.firstChild.focus();
    });
    if (playBtn) playBtn.addEventListener('click', playRing);

    // The chooser: the same two samples, with the agent you picked.
    function applyAgent() {
      var r = radios.filter(function (x) { return x.checked; })[0] || radios[0];
      if (r) {
        agent = {
          name: r.getAttribute('data-name'),
          where: r.getAttribute('data-where'),
          href: r.getAttribute('data-href'),
          link: r.getAttribute('data-link'),
          logo: r.getAttribute('data-logo'),
          ringOnly: r.hasAttribute('data-ring-only'),
        };
      } else {
        agent.name = $('[data-agent]', callPhone).textContent;
      }
      $$('[data-agent]').forEach(function (n) {
        // The written scripts are live conversations, so they keep the name of an agent you can talk to.
        if (agent.ringOnly && n.closest('.script')) return;
        n.textContent = agent.name;
      });
      // The caller's picture on both phones: the agent's own logo.
      if (agent.logo) $$('[data-logo]').forEach(function (n) { n.src = agent.logo; });
      if (r) $$('[data-where]').forEach(function (n) { n.textContent = agent.where; });
      if (r && agentLink) { agentLink.href = agent.href; agentLink.textContent = agent.link; }
      resetCall();
      ringIdle();
    }
    radios.forEach(function (r) { r.addEventListener('change', applyAgent); });

    root.classList.add('js');
    applyAgent();
  })();

  // 6. The giant wordmark (from variation 4): fitted to the width, lit like a spotlight by the
  // pointer, or by the scroll position on touch screens.
  (function () {
    var g = byId('giant'), s = g && g.querySelector('span');
    if (!g || !s) return;
    function fit() {
      s.style.fontSize = '';
      var cs = window.getComputedStyle(g);
      var room = g.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      var wide = s.getBoundingClientRect().width;
      if (wide > 0 && room > 0) s.style.fontSize = (parseFloat(window.getComputedStyle(s).fontSize) * room / wide).toFixed(1) + 'px';
    }
    fit();
    if (doc.fonts && doc.fonts.ready) doc.fonts.ready.then(fit);
    onResize(null, fit);
    if (still) return;

    var seen = false, queued = 0, mx = 0, my = 0, byScroll = true;
    g.classList.add('live');
    function paint() {
      queued = 0;
      var r = s.getBoundingClientRect();
      if (byScroll) {
        // From entering the screen to the page end, the light crosses the word left to right.
        var vh = window.innerHeight, p = (vh - r.top) / (r.height + vh * 0.35);
        p = Math.max(0, Math.min(1, p));
        g.style.setProperty('--mx', (8 + p * 84).toFixed(1) + '%');
        g.style.setProperty('--my', '55%');
      } else {
        g.style.setProperty('--mx', (mx - r.left).toFixed(0) + 'px');
        g.style.setProperty('--my', (my - r.top).toFixed(0) + 'px');
      }
    }
    function ask() { if (seen && !doc.hidden && !queued) queued = raf(paint) || 1; }
    watch(g, 0, function (on) { seen = on; ask(); });
    onShow.push(ask);
    window.addEventListener('pointermove', function (e) {
      if (e.pointerType === 'mouse') { byScroll = false; mx = e.clientX; my = e.clientY; ask(); }
    }, { passive: true });
    window.addEventListener('scroll', ask, { passive: true });
  })();

  // 7. Small touches in "You stay in control." and the questions. Rules and diamonds marked
  // data-draw draw once when they come into view; without this they are simply shown.
  (function () {
    if (still) return;
    Array.prototype.forEach.call(doc.querySelectorAll('[data-draw]'), function (el) {
      el.classList.add('fx');
      var done = false;
      watch(el, 0.2, function (on) { if (on && !done) { done = true; el.classList.add('in'); } });
    });

    // The spotlight follows the mouse inside one item (the footer wordmark's technique).
    Array.prototype.forEach.call(doc.querySelectorAll('.trust > div'), function (item) {
      item.addEventListener('pointermove', function (e) {
        if (e.pointerType !== 'mouse') return;
        var r = item.getBoundingClientRect();
        item.style.setProperty('--mx', (e.clientX - r.left + 12).toFixed(0) + 'px');
        item.style.setProperty('--my', (e.clientY - r.top + 1).toFixed(0) + 'px');
        item.classList.add('lit');
      }, { passive: true });
      item.addEventListener('pointerleave', function () { item.classList.remove('lit'); });
    });

    // Questions open and close with a short height and fade. The page still uses <details>: the
    // keyboard, find-in-page and no-script behaviour are the browser's own.
    Array.prototype.forEach.call(doc.querySelectorAll('.faq details'), function (d) {
      var sum = d.querySelector('summary'), body = d.querySelector('summary + div'), anim = null;
      if (!sum || !body || !body.animate) return;
      function run(opening) {
        if (anim) anim.cancel();
        var full = body.scrollHeight + 'px';
        body.style.overflow = 'hidden';
        anim = body.animate(
          { height: opening ? ['0px', full] : [full, '0px'], opacity: opening ? [0, 1] : [1, 0] },
          { duration: opening ? 380 : 260, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' }
        );
        anim.onfinish = function () {
          anim = null;
          body.style.overflow = '';
          if (!opening) { d.open = false; d.classList.remove('closing'); }
        };
      }
      sum.addEventListener('click', function (e) {
        e.preventDefault();
        if (d.open && !d.classList.contains('closing')) {
          d.classList.add('closing');
          run(false);
        } else {
          d.classList.remove('closing');
          d.open = true;
          run(true);
        }
      });
    });
  })();
})();
