// EtherCAT status card for Fluidd.
// Injected into Fluidd's index.html by the installer. Adds a native-looking
// dashboard card that polls the klipper "ethercat" extra via Moonraker.
(function () {
  if (window.__ecatPanelLoaded) return;
  window.__ecatPanelLoaded = true;

  var MOON = location.protocol + '//' + location.hostname + ':7125';
  var STORAGE_KEY = 'ecatCardCollapsed';

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  var css = el('style');
  css.textContent = [
    '.ecat-col .v-card__text .ecat-row{display:flex;justify-content:space-between;padding:3px 0;',
      'border-bottom:1px solid rgba(128,128,128,.15);}',
    '.ecat-col .ecat-l{opacity:.7;}',
    '.ecat-col .ecat-err{color:#ff5252;}'
  ].join('');
  document.head.appendChild(css);

  var cardWrap = null, dot = null, stateLbl = null, rows = {}, servoBody = null, body = null, chev = null;

  var svgPlug = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20" fill="currentColor" style="vertical-align:middle;margin-right:8px;opacity:.85;"><path d="M16,7V3H14V7H10V3H8V7H8A2,2 0 0,0 6,9V14A5,5 0 0,0 11,19V22H13V19A5,5 0 0,0 18,14V9A2,2 0 0,0 16,7Z"/></svg>';
  var svgChev = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="22" height="22" fill="currentColor" style="transition:transform .2s;"><path d="M7.41,15.41L12,10.83L16.59,15.41L18,14L12,8L6,14L7.41,15.41Z"/></svg>';

  function row(label) {
    var r = el('div', 'ecat-row');
    var l = el('span', 'ecat-l caption', label);
    var v = el('span', 'body-2', '--');
    r.appendChild(l); r.appendChild(v);
    body.appendChild(r);
    return v;
  }

  function buildCard() {
    var wrap = el('div', 'col col-12 col-sm-6 col-md-4 ecat-col');
    var card = el('div', 'v-card v-sheet theme--dark collapsable-card');
    var title = el('div', 'v-card__title collapsable-card-title card-heading py-2 px-4');
    var hrow = el('div', 'row no-gutters flex-nowrap');
    var colL = el('div', 'col align-self-center text-no-wrap');
    var icon = el('span'); icon.style.cssText = 'display:inline-flex;vertical-align:middle;';
    icon.innerHTML = svgPlug;
    colL.appendChild(icon); colL.appendChild(el('span', 'font-weight-light', 'EtherCAT'));
    var colR = el('div', 'col col-auto align-self-center d-flex align-center');
    dot = el('span');
    dot.style.cssText = 'width:10px;height:10px;border-radius:50%;display:inline-block;background:#888;margin-right:4px;';
    stateLbl = el('span', 'caption', 'offline');
    var btn = el('button', 'v-btn v-btn--icon v-btn--round v-size--default theme--dark');
    btn.style.cssText = 'width:32px;height:32px;margin-left:6px;';
    var bc = el('span', 'v-btn__content'); chev = el('span');
    chev.style.cssText = 'display:inline-flex;'; chev.innerHTML = svgChev;
    bc.appendChild(chev); btn.appendChild(bc);
    colR.appendChild(dot); colR.appendChild(stateLbl); colR.appendChild(btn);
    hrow.appendChild(colL); hrow.appendChild(colR);
    title.appendChild(hrow); card.appendChild(title);

    body = el('div', 'v-card__text py-2 px-4 overflow-hidden');
    rows.iface = row('Interface');
    rows.cycle = row('Cycle');
    rows.cycles = row('Cycles');
    rows.jitter = row('Jitter max');
    rows.slaves = row('Slaves');
    card.appendChild(body);

    servoBody = el('div', 'v-card__text py-2 px-4 overflow-hidden');
    card.appendChild(servoBody);

    btn.addEventListener('click', function () {
      var collapsed = body.style.display === 'none';
      body.style.display = collapsed ? '' : 'none';
      servoBody.style.display = collapsed ? '' : 'none';
      chev.style.transform = collapsed ? '' : 'rotate(180deg)';
      card.classList.toggle('collapsed', !collapsed);
      try { localStorage.setItem(STORAGE_KEY, collapsed ? '0' : '1'); } catch (e) {}
    });
    var c0 = '0';
    try { c0 = localStorage.getItem(STORAGE_KEY) || '0'; } catch (e) {}
    if (c0 === '1') {
      body.style.display = 'none'; servoBody.style.display = 'none';
      chev.style.transform = 'rotate(180deg)'; card.classList.add('collapsed');
    }
    wrap.appendChild(card);
    return wrap;
  }

  function poll() {
    fetch(MOON + '/printer/objects/query?ethercat', { mode: 'cors' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var st = (j.result && j.result.status && j.result.status.ethercat) || null;
        if (!st) throw new Error('no data');
        if (dot) dot.style.background = (st.state === 'op' || st.state.indexOf('scanning') === 0) ? '#4caf50' : '#ff9800';
        if (stateLbl) stateLbl.textContent = st.state;
        if (rows.iface) rows.iface.textContent = st.interface || '--';
        if (rows.cycle) rows.cycle.textContent = st.cycle_time ? (st.cycle_time * 1000).toFixed(2) + ' ms' : '--';
        if (rows.cycles) rows.cycles.textContent = st.cycles != null ? String(st.cycles) : '--';
        if (rows.jitter) rows.jitter.textContent = st.jitter_max_ms != null ? st.jitter_max_ms.toFixed(2) + ' ms' : '--';
        if (rows.slaves) rows.slaves.textContent = String(st.slave_count != null ? st.slave_count : '--');
        if (servoBody) {
          servoBody.innerHTML = '';
          var servos = st.servos || {};
          var names = Object.keys(servos);
          if (!names.length) {
            var n = el('div', 'caption', 'no servo drives configured');
            n.style.opacity = '.6';
            servoBody.appendChild(n);
          }
          names.forEach(function (n2) {
            var sv = servos[n2];
            var r = el('div', 'ecat-row');
            var l = el('span', 'ecat-l body-2', n2);
            var v = el('span', 'body-2', (sv.enabled ? '[on] ' : '[off] ') + sv.drive_state +
                       ' pos=' + sv.position + (sv.error ? ' ERR' : ''));
            if (sv.error) v.classList.add('ecat-err');
            r.appendChild(l); r.appendChild(v);
            servoBody.appendChild(r);
          });
        }
      })
      .catch(function () {
        if (dot) dot.style.background = '#888';
        if (stateLbl) stateLbl.textContent = 'offline';
      });
  }

  function tryMount() {
    if (cardWrap && cardWrap.isConnected) return;
    var main = document.querySelector('.v-main .container');
    if (!main) return;
    // preferred: right below the ODrive card, else below temperature, else top
    var anchor = null, cards = main.querySelectorAll('.v-card'), i, h;
    for (i = 0; i < cards.length; i++) {
      h = cards[i].querySelector('.card-heading');
      if (h && /odrive/i.test(h.textContent)) { anchor = cards[i]; break; }
    }
    if (!anchor) for (i = 0; i < cards.length; i++) {
      h = cards[i].querySelector('.card-heading');
      if (h && /温度|temperature/i.test(h.textContent)) { anchor = cards[i]; break; }
    }
    if (!cardWrap) cardWrap = buildCard();
    if (anchor) {
      anchor.insertAdjacentElement('afterend', cardWrap);
      cardWrap.className = 'ecat-col'; cardWrap.style.width = '100%';
    } else {
      var row = main.querySelector('.row');
      if (!row) return;
      cardWrap.className = 'col col-12 col-sm-6 col-md-4';
      cardWrap.style.width = '';
      row.insertBefore(cardWrap, row.firstChild);
    }
  }

  setInterval(tryMount, 1500);
  setInterval(poll, 1000);
})();
