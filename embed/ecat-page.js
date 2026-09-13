// EtherCAT control page for Fluidd.
// Injected into Fluidd's index.html. Adds a navigation item below "Settings"
// in the Fluidd drawer and a full-page EtherCAT control panel:
//   - master status (state, interface, cycle, cycles, jitter, slaves)
//   - per-servo controls: enable/disable, target position, velocity,
//     acceleration, move, live position/status/error readouts
// Commands are sent over the Moonraker websocket (JSON-RPC); status is polled
// over HTTP (/printer/objects/query?ethercat).
(function () {
  if (window.__ecatPageLoaded) return;
  window.__ecatPageLoaded = true;

  var MOON = location.protocol + '//' + location.hostname + ':7125';
  var WS = 'ws://' + location.hostname + ':7125/websocket';

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  var css = el('style');
  css.textContent = [
    '#ecat-page{position:fixed;inset:0;z-index:900;background:#1e1e1e;color:#eee;',
      'display:none;overflow:auto;font-size:14px;}',
    '#ecat-page.open{display:block;}',
    '#ecat-page .ecat-top{display:flex;align-items:center;gap:12px;padding:10px 18px;',
      'background:rgba(128,128,128,.12);position:sticky;top:0;z-index:2;}',
    '#ecat-page .ecat-top h2{margin:0;font-size:18px;font-weight:400;flex:1;}',
    '#ecat-page .ecat-wrap{max-width:1080px;margin:0 auto;padding:16px;}',
    '#ecat-page .ecat-card{background:rgba(128,128,128,.08);border:1px solid rgba(128,128,128,.25);',
      'border-radius:8px;padding:12px 16px;margin-bottom:16px;}',
    '#ecat-page h3{margin:4px 0 10px;font-weight:500;font-size:15px;}',
    '#ecat-page .ecat-row{display:flex;justify-content:space-between;padding:4px 0;',
      'border-bottom:1px solid rgba(128,128,128,.15);}',
    '#ecat-page .ecat-l{opacity:.7;}',
    '#ecat-page input{background:rgba(128,128,128,.15);border:1px solid rgba(128,128,128,.35);',
      'color:inherit;border-radius:4px;padding:4px 8px;width:110px;}',
    '#ecat-page button.ecat-btn{background:#1976d2;color:#fff;border:0;border-radius:4px;',
      'padding:6px 14px;cursor:pointer;margin-left:6px;}',
    '#ecat-page button.ecat-btn.warn{background:#d32f2f;}',
    '#ecat-page button.ecat-btn.gray{background:#555;}',
    '#ecat-page button.ecat-btn:disabled{opacity:.4;cursor:default;}',
    '#ecat-page .ecat-dot{width:10px;height:10px;border-radius:50%;display:inline-block;margin-right:6px;}',
    '#ecat-page .ecat-servo{border:1px solid rgba(128,128,128,.25);border-radius:8px;',
      'padding:10px 14px;margin-bottom:12px;}',
    '#ecat-page .ecat-note{opacity:.6;font-size:12px;}'
  ].join('');
  document.head.appendChild(css);

  var page = null, ws = null, wsReady = false, klippyState = '?';
  var stateLbl = null, dot = null, rows = {}, servoBox = null;
  var lastStatus = null;

  // ---- websocket (commands) --------------------------------------------

  function wsSend(method, params) {
    try {
      if (!ws || ws.readyState !== 1) connectWs();
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ jsonrpc: '2.0', method: method, params: params || {} }));
        return true;
      }
    } catch (e) {}
    return false;
  }

  function connectWs() {
    try {
      ws = new WebSocket(WS);
      ws.onopen = function () { wsReady = true; refresh(); };
      ws.onmessage = function (ev) {
        try {
          var m = JSON.parse(ev.data);
          if (m.error && m.id !== undefined) console.warn('ecat ws', m.error);
        } catch (e) {}
      };
      ws.onclose = function () { wsReady = false; };
    } catch (e) {}
  }

  function gcode(script) {
    var ok = wsSend('printer.gcode.script', { script: script });
    if (!ok) {
      // fallback: fire-and-forget HTTP POST (moonraker may close it, but the
      // command still executes)
      fetch(MOON + '/printer/gcode/script', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ script: script })
      }).catch(function () {});
    }
  }

  // ---- status polling ---------------------------------------------------

  function poll() {
    if (!page.classList.contains('open')) return;
    fetch(MOON + '/server/info', { mode: 'cors' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        klippyState = (j.result && j.result.klippy_state) || '?';
        updateKlippyChip();
      })
      .catch(function () { klippyState = '?'; });
    fetch(MOON + '/printer/objects/query?ethercat', { mode: 'cors' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var st = (j.result && j.result.status && j.result.status.ethercat) || null;
        if (!st) throw new Error('no data');
        lastStatus = st;
        render(st);
      })
      .catch(function () {
        if (dot) dot.style.background = '#888';
        if (stateLbl) stateLbl.textContent = 'klippy offline';
      });
  }

  function updateKlippyChip() {
    var ready = (klippyState === 'ready');
    var c = document.getElementById('ecat-klippy-chip');
    if (!c) {
      c = el('span', 'ecat-note');
      c.id = 'ecat-klippy-chip';
      var t = page.querySelector('.ecat-top');
      if (t) t.appendChild(c);
    }
    c.textContent = 'klippy: ' + klippyState + (ready ? '' : ' (控制命令需要 klippy ready)');
    setBtnStates(ready);
  }

  function setBtnStates(ready) {
    page.querySelectorAll('button.ecat-btn[data-needs-klippy]').forEach(function (b) {
      b.disabled = !ready;
    });
  }

  function render(st) {
    var ok = (st.state === 'op' || st.state.indexOf('scanning') === 0);
    if (dot) dot.style.background = ok ? '#4caf50' : '#ff9800';
    if (stateLbl) stateLbl.textContent = st.state;
    if (rows.state) rows.state.textContent = st.state;
    if (rows.iface) rows.iface.textContent = st.interface;
    if (rows.cycle) rows.cycle.textContent = (st.cycle_time * 1000).toFixed(2) + ' ms';
    if (rows.cycles) rows.cycles.textContent = st.cycles;
    if (rows.jitter) rows.jitter.textContent = (st.jitter_max_ms || 0).toFixed(2) + ' ms';
    if (rows.slaves) rows.slaves.textContent = (st.slaves || []).join(', ') || '(none)';
    renderServos(st);
  }

  var servoInputs = {};

  function renderServos(st) {
    var servos = st.servos || {};
    var names = Object.keys(servos);
    servoBody.innerHTML = '';
    if (!names.length) {
      var n = el('div', 'ecat-note',
        'no servo drives configured — add an [ethercat_servo <name>] section to printer.cfg');
      servoBody.appendChild(n);
      return;
    }
    names.forEach(function (n2) {
      var sv = servos[n2];
      var card = el('div', 'ecat-servo');
      var head = el('div');
      head.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:8px;';
      var d = el('span', 'ecat-dot');
      d.style.background = sv.enabled ? '#4caf50' : '#888';
      head.appendChild(d);
      head.appendChild(el('b', null, n2));
      head.appendChild(el('span', 'ecat-note', sv.drive_state + (sv.error ? ' ⚠fault' : '')));
      var sp = el('span'); sp.style.flex = '1';
      head.appendChild(sp);
      var bEn = el('button', 'ecat-btn', sv.enabled ? 'DISABLE' : 'ENABLE');
      bEn.setAttribute('data-needs-klippy', '1');
      bEn.addEventListener('click', function () {
        gcode(sv.enabled ? 'ETHERCAT_DISABLE NAME=' + n2 : 'ETHERCAT_ENABLE NAME=' + n2);
      });
      head.appendChild(bEn);
      card.appendChild(head);

      var r1 = el('div'); r1.style.cssText = 'display:flex;gap:10px;flex-wrap:wrap;align-items:end;padding:6px 0;';
      function field(label, id, value) {
        var f = el('div');
        f.appendChild(el('div', 'ecat-note', label));
        var inp = el('input'); inp.id = id; inp.value = value;
        f.appendChild(inp);
        r1.appendChild(f);
      }
      var prev = servoInputs[n2] || {};
      field('目标位置 target', 'ecat-in-pos-' + n2, prev.pos != null ? prev.pos : sv.target);
      field('速度 velocity', 'ecat-in-vel-' + n2, prev.vel != null ? prev.vel : '');
      field('加速度 accel', 'ecat-in-acc-' + n2, prev.acc != null ? prev.acc : '');
      var bMove = el('button', 'ecat-btn', 'MOVE');
      bMove.setAttribute('data-needs-klippy', '1');
      bMove.style.marginBottom = '2px';
      bMove.addEventListener('click', function () {
        var pos = document.getElementById('ecat-in-pos-' + n2).value;
        var vel = document.getElementById('ecat-in-vel-' + n2).value;
        var acc = document.getElementById('ecat-in-acc-' + n2).value;
        var cmd = 'ETHERCAT_MOVE NAME=' + n2 + ' POS=' + pos;
        if (vel) cmd += ' VEL=' + vel;
        if (acc) cmd += ' ACCEL=' + acc;
        gcode(cmd);
        servoInputs[n2] = { pos: pos, vel: vel, acc: acc };
      });
      r1.appendChild(bMove);
      var bStop = el('button', 'ecat-btn gray', 'HOLD');
      bStop.style.marginBottom = '2px';
      bStop.addEventListener('click', function () { gcode('ETHERCAT_MOVE NAME=' + n2 + ' POS=' + (sv.position)); });
      r1.appendChild(bStop);
      card.appendChild(r1);

      var r2 = el('div', 'ecat-row');
      r2.appendChild(el('span', 'ecat-l', 'position / target'));
      r2.appendChild(el('span', 'body-2', sv.position + ' / ' + sv.target));
      card.appendChild(r2);
      var r3 = el('div', 'ecat-row');
      r3.appendChild(el('span', 'ecat-l', 'status word'));
      var swv = el('span', 'body-2', '0x' + (sv.status_word >>> 0).toString(16) + ' — ' + sv.drive_state);
      if (sv.error) swv.classList.add('ecat-err');
      r3.appendChild(swv);
      card.appendChild(r3);
      servoBody.appendChild(card);
    });
  }

  // ---- page ---------------------------------------------------------------

  function buildPage() {
    page = el('div'); page.id = 'ecat-page';

    var top = el('div', 'ecat-top');
    var back = el('button', 'ecat-btn gray', '← 返回 Fluidd');
    back.addEventListener('click', function () { page.classList.remove('open'); });
    top.appendChild(back);
    top.appendChild(el('h2', null, 'EtherCAT 总线控制'));
    dot = el('span', 'ecat-dot');
    stateLbl = el('span', 'ecat-note', 'connecting...');
    top.appendChild(dot); top.appendChild(stateLbl);
    page.appendChild(top);

    var wrap = el('div', 'ecat-wrap');

    var c1 = el('div', 'ecat-card');
    c1.appendChild(el('h3', null, '主站 Master'));
    body = el('div');
    rows.state = row('State');
    rows.iface = row('Interface');
    rows.cycle = row('Cycle');
    rows.cycles = row('Cycles');
    rows.jitter = row('Jitter max');
    rows.slaves = row('Slaves');
    c1.appendChild(body);
    wrap.appendChild(c1);

    var c2 = el('div', 'ecat-card');
    c2.appendChild(el('h3', null, '伺服 Servos'));
    c2.appendChild(el('div', 'ecat-note',
      '使能后用 MOVE 移动;单位由 printer.cfg 中 [ethercat_servo] 的 scale 决定。HOLD 立即停在当前位置。'));
    servoBody = el('div');
    c2.appendChild(servoBody);
    wrap.appendChild(c2);

    page.appendChild(wrap);
    document.body.appendChild(page);

    connectWs();
    poll();
    setInterval(poll, 700);
  }

  function row(label) {
    var r = el('div', 'ecat-row');
    var l = el('span', 'ecat-l', label);
    var v = el('span', null, '--');
    r.appendChild(l); r.appendChild(v);
    body.appendChild(r);
    return v;
  }

  // ---- nav item -----------------------------------------------------------

  var navItem = null;

  function buildNavItem(sample) {
    var li = el('div', sample.className || '');
    li.setAttribute('data-ecat-nav', '1');
    li.style.cursor = 'pointer';
    li.innerHTML = '';
    var inner = el('div');
    inner.style.cssText = 'display:flex;align-items:center;gap:14px;padding:0 16px;height:48px;';
    inner.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M16.56,5.44L15.11,6.89C16.84,7.94 18,9.83 18,12A6,6 0 0,1 12,18A6,6 0 0,1 6,12C6,9.83 7.16,7.94 8.88,6.88L7.44,5.44C5.36,6.88 4,9.28 4,12A8,8 0 0,0 12,20A8,8 0 0,0 20,12C20,9.28 18.64,6.88 16.56,5.44M11,14H13V2H11V14Z"/></svg>';
    inner.appendChild(el('span', null, 'EtherCAT'));
    li.appendChild(inner);
    li.addEventListener('click', function (e) {
      e.stopPropagation();
      page.classList.add('open');
    });
    return li;
  }

  function tryMountNav() {
    if (navItem && navItem.isConnected) return;
    var settings = null, hostDrawer = null;
    document.querySelectorAll('.v-navigation-drawer').forEach(function (drawer) {
      if (settings) return;
      drawer.querySelectorAll('.v-list-item, .v-list-item--link, a, .nav-item').forEach(function (it) {
        if (settings) return;
        var txt = (it.textContent || '').trim();
        var isCog = (it.innerHTML || '').indexOf('M19.14,12.94') !== -1;
        if ((/设置|Settings/i.test(txt) && txt.length < 24) || isCog) {
          settings = it; hostDrawer = drawer;
        }
      });
    });
    if (!settings) return;
    if (!page) buildPage();
    navItem = buildNavItem(settings);
    settings.insertAdjacentElement('afterend', navItem);
    hostDrawer.addEventListener('click', function (e) {
      if (!e.target.closest('[data-ecat-nav]')) page.classList.remove('open');
    });
  }

  setInterval(tryMountNav, 1200);
  setInterval(function () { if (page && page.classList.contains('open')) poll(); }, 700);
  tryMountNav();
  setInterval(poll, 2000);
})();
