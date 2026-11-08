(function () {
  'use strict';
  var dlg = document.getElementById('lightbox');
  if (!dlg || typeof dlg.showModal !== 'function') return; // no <dialog>: links open the original image

  var img = dlg.querySelector('.lb-img');
  var stage = dlg.querySelector('[data-lb-stage]');
  var msg = dlg.querySelector('[data-lb-msg]');
  var msgLink = msg.querySelector('a');
  var count = dlg.querySelector('[data-lb-count]');
  var prev = dlg.querySelector('[data-lb-prev]');
  var next = dlg.querySelector('[data-lb-next]');
  var detail = dlg.querySelector('[data-lb-detail]');
  var items = [];
  var cur = 0;
  var opener = null;

  function collect(group) {
    var map = {};
    var nodes = document.querySelectorAll('a[data-lb-group]');
    for (var i = 0; i < nodes.length; i++) {
      var a = nodes[i];
      if (a.getAttribute('data-lb-group') !== group) continue;
      var idx = Number(a.getAttribute('data-lb-index')) || 0;
      if (!map[idx]) {
        var t = a.querySelector('img');
        map[idx] = { src: a.href, alt: a.getAttribute('data-lb-alt') || (t && t.alt) || '' };
      }
    }
    return Object.keys(map).map(Number).sort(function (x, y) { return x - y; }).map(function (k) { return map[k]; });
  }

  function preload(i) {
    if (items.length < 2) return;
    var n = items[(i + items.length) % items.length];
    new Image().src = n.src;
  }

  function show(i) {
    cur = (i + items.length) % items.length;
    var it = items[cur];
    msg.hidden = true;
    img.hidden = false;
    img.classList.add('is-loading');
    img.alt = it.alt || 'Fotografie ' + (cur + 1);
    img.src = it.src;
    msgLink.href = it.src;
    count.textContent = items.length > 1 ? (cur + 1) + ' / ' + items.length : '';
    preload(cur + 1);
    preload(cur - 1);
  }

  img.addEventListener('load', function () { img.classList.remove('is-loading'); });
  img.addEventListener('error', function () {
    img.classList.remove('is-loading');
    img.hidden = true;
    msg.hidden = false;
  });

  function step(d) { if (items.length > 1) show(cur + d); }

  function open(a) {
    items = collect(a.getAttribute('data-lb-group'));
    if (!items.length) return;
    var idx = Number(a.getAttribute('data-lb-index')) || 0;
    var many = items.length > 1;
    prev.hidden = next.hidden = !many;
    var d = a.getAttribute('data-lb-detail');
    detail.hidden = !d;
    if (d) detail.href = d;
    opener = a;
    show(Math.min(idx, items.length - 1));
    dlg.showModal();
  }

  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target.closest && e.target.closest('a[data-lb-group]');
    if (!a) return;
    e.preventDefault();
    open(a);
  });

  dlg.addEventListener('click', function (e) {
    var t = e.target;
    if (t === dlg || t === stage) dlg.close();
    else if (t.closest('[data-lb-close]')) dlg.close();
    else if (t.closest('[data-lb-prev]')) step(-1);
    else if (t.closest('[data-lb-next]')) step(1);
  });

  dlg.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
  });

  dlg.addEventListener('close', function () {
    img.removeAttribute('src');
    if (opener && document.contains(opener)) opener.focus();
    opener = null;
  });

  // Touch swipe
  var sx = 0, sy = 0, tracking = false;
  stage.addEventListener('touchstart', function (e) {
    if (e.touches.length !== 1) { tracking = false; return; }
    tracking = true; sx = e.touches[0].clientX; sy = e.touches[0].clientY;
  }, { passive: true });
  stage.addEventListener('touchend', function (e) {
    if (!tracking) return;
    tracking = false;
    var t = e.changedTouches[0];
    var dx = t.clientX - sx, dy = t.clientY - sy;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx < 0 ? 1 : -1);
  }, { passive: true });
})();
