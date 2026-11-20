// คำนวณปริมาณฝนเฉลี่ยในพื้นที่ (จังหวัด / ลุ่มน้ำหลัก / ลุ่มน้ำย่อย)
// - แผนที่ Ventusky (iframe) + เส้นขอบเขตวาดทับด้วย SVG แบบเดียวกับ trackflood/weather.html
// - ฝนรายวันจาก Open-Meteo ที่จุดกริดภายในขอบเขต แล้วเฉลี่ยเป็นฝนเชิงพื้นที่
(function () {
  'use strict';
  const B = window.BOUNDARIES;
  const $ = (id) => document.getElementById(id);
  const KIND_LABEL = { province: 'จังหวัด', main: 'ลุ่มน้ำหลัก', sub: 'ลุ่มน้ำย่อย' };
  const PALETTE = ['#e03131', '#1c7ed6', '#f08c00', '#2f9e44', '#ae3ec9', '#0ca678', '#d6336c', '#5c7cfa', '#e8590c', '#66a80f'];
  const TZ = 'Asia/Bangkok';
  const fmt = (v, d = 1) => (v == null || !isFinite(v) ? '–' : v.toLocaleString('th-TH', { minimumFractionDigits: d, maximumFractionDigits: d }));
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ---------- วันที่ (เวลาไทย) ----------
  const today = new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
  const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
  const dayDiff = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
  const thDate = (d, long) => new Date(d + 'T00:00:00Z').toLocaleDateString('th-TH', long ? { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' } : { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const FC_MAX = 15; // Open-Meteo พยากรณ์ได้ 16 วันรวมวันนี้
  const ARCHIVE_CUTOFF = addDays(today, -60); // เก่ากว่านี้ใช้ ERA5 (archive API)

  // ---------- เตรียมข้อมูลขอบเขต ----------
  function ringArea(r) { let s = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]); return s / 2; }
  const AREAS = [];
  const byId = new Map();
  for (const kind of ['province', 'main', 'sub']) {
    for (const f of B[kind]) {
      let x0 = 180, y0 = 90, x1 = -180, y1 = -90, big = null, bigA = 0, aDeg = 0;
      for (const poly of f.polys) {
        poly.forEach((ring, k) => {
          for (const [x, y] of ring) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
          const A = Math.abs(ringArea(ring));
          aDeg += k ? -A : A;
          if (!k && A > bigA) { bigA = A; big = ring; }
        });
      }
      const latc = (y0 + y1) / 2;
      const km2 = f.km2 || aDeg * 111.32 * 111.32 * Math.cos((latc * Math.PI) / 180);
      const a = { ...f, kind, km2, bbox: [x0, y0, x1, y1], label: labelPoint(big) };
      a.search = [a.name, a.en, a.code, a.parent, KIND_LABEL[kind]].filter(Boolean).join(' ').toLowerCase();
      AREAS.push(a); byId.set(a.id, a);
    }
  }
  // จุดวางชื่อ: กึ่งกลางแนวนอนของวงใหญ่สุด ที่ละติจูดกลาง (อยู่ในพื้นที่เสมอสำหรับรูปทรงทั่วไป)
  function labelPoint(ring) {
    let y0 = 90, y1 = -90; for (const [, y] of ring) { if (y < y0) y0 = y; if (y > y1) y1 = y; }
    const y = (y0 + y1) / 2, xs = [];
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y)) xs.push(xi + ((y - yi) / (yj - yi)) * (xj - xi));
    }
    xs.sort((a, b) => a - b);
    let best = 0, bx = ring[0][0];
    for (let i = 0; i + 1 < xs.length; i += 2) if (xs[i + 1] - xs[i] > best) { best = xs[i + 1] - xs[i]; bx = (xs[i] + xs[i + 1]) / 2; }
    return [bx, y];
  }
  function inside(a, x, y) {
    const [x0, y0, x1, y1] = a.bbox;
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
    let c = false;
    for (const poly of a.polys) for (const r of poly) {
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        const [xi, yi] = r[i], [xj, yj] = r[j];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
      }
    }
    return c;
  }
  // จุดกริดสม่ำเสมอภายในขอบเขต ระยะห่างปรับให้ได้ราว 60 จุด (ไม่ละเอียดกว่า 0.03° ไม่หยาบกว่า 0.25°)
  function gridPoints(a) {
    if (a.pts) return a.pts;
    const [x0, y0, x1, y1] = a.bbox;
    const aDeg = a.km2 / (111.32 * 111.32 * Math.cos((((y0 + y1) / 2) * Math.PI) / 180));
    let s = Math.min(0.25, Math.max(0.03, Math.sqrt(aDeg / 60)));
    let pts = [];
    for (let tries = 0; tries < 5; tries++, s /= 2) {
      pts = [];
      const nx = Math.max(1, Math.round((x1 - x0) / s)), ny = Math.max(1, Math.round((y1 - y0) / s));
      const sx = (x1 - x0) / nx, sy = (y1 - y0) / ny;
      for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
        const x = +(x0 + (i + 0.5) * sx).toFixed(3), y = +(y0 + (j + 0.5) * sy).toFixed(3);
        if (inside(a, x, y)) pts.push([x, y]);
      }
      if (pts.length >= 4) break;
    }
    if (!pts.length) pts = [a.label.map((v) => +v.toFixed(3))];
    a.spacing = s;
    return (a.pts = pts);
  }

  // ---------- สถานะ ----------
  const state = { kind: 'province', q: '', selected: [], active: null, view: null, ran: false };
  const colorOf = (id) => PALETTE[state.selected.indexOf(id) % PALETTE.length];
  const results = new Map(); // id -> { key, dates, avg, ptTotals, total, ... }
  const ptCache = new Map(); // "key|lat,lon" -> {date: mm}

  // ---------- แผนที่ Ventusky ----------
  const TILE = 512; // ซูม Ventusky ใหญ่กว่า Web Mercator มาตรฐาน 1 ระดับ
  const TIMEBAR = 78;
  const wrap = $('vt-wrap'), frame = $('vt-frame'), svg = $('vt-boundary'), shield = $('vt-shield'), tip = $('vt-tip');
  const layerSel = $('vt-layer'), vtDate = $('vt-date'), lockBtn = $('vt-lock');
  const VT_MAX = addDays(today, 14);
  vtDate.value = today; vtDate.max = VT_MAX;

  function project(lon, lat, z) {
    const s = TILE * 2 ** z, sin = Math.sin((lat * Math.PI) / 180);
    return [((lon + 180) / 360) * s, (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * s];
  }
  function unproject(x, y, z) {
    const s = TILE * 2 ** z;
    return [(x / s) * 360 - 180, (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / s))) * 180) / Math.PI];
  }
  // หาซูม (จำนวนเต็ม) ใหญ่สุดที่ขอบเขตทั้งหมดอยู่ในกรอบ โดยเว้นแถบเวลาด้านล่าง
  // pad = ระยะเว้นจากขอบกรอบ (px) เช่น แถบเวลาด้านล่าง ป้ายชั้นข้อมูล/โลโก้/แถบสีของ Ventusky
  const VIEW_PAD = { l: 24, r: 24, t: 20, b: TIMEBAR + 20 };
  function fitView(bbox, pad = VIEW_PAD) {
    const w = wrap.clientWidth || 900, h = wrap.clientHeight || 560;
    const aw = w - pad.l - pad.r, ah = h - pad.t - pad.b;
    let z = 4;
    for (let t = 11; t >= 4; t--) {
      const [ax, ay] = project(bbox[0], bbox[3], t), [bx, by] = project(bbox[2], bbox[1], t);
      if (bx - ax <= aw && by - ay <= ah) { z = t; break; }
    }
    const [ax, ay] = project(bbox[0], bbox[3], z), [bx, by] = project(bbox[2], bbox[1], z);
    // ให้กึ่งกลางพื้นที่อยู่กลางช่องว่างที่เหลือหลังหักขอบ (พื้นที่จะลอยขึ้นพ้นแถบเวลา)
    const offX = (pad.l + w - pad.r) / 2 - w / 2, offY = (pad.t + h - pad.b) / 2 - h / 2;
    const [lon, lat] = unproject((ax + bx) / 2 - offX, (ay + by) / 2 - offY, z);
    return { lat: +lat.toFixed(4), lon: +lon.toFixed(4), zoom: z };
  }
  const unionBBox = (ids) => ids.map((id) => byId.get(id).bbox).reduce((u, b) => [Math.min(u[0], b[0]), Math.min(u[1], b[1]), Math.max(u[2], b[2]), Math.max(u[3], b[3])]);
  const THAILAND = [97.35, 5.6, 105.64, 20.47];

  function frameSrc() {
    const v = state.view;
    let src = `https://embed.ventusky.com/?p=${v.lat};${v.lon};${v.zoom}&l=${encodeURIComponent(layerSel.value)}`;
    if (vtDate.value && vtDate.value !== today) src += `&t=${vtDate.value.replace(/-/g, '')}/0000`;
    return src;
  }
  const reload = () => { frame.src = frameSrc(); };
  function setView(bbox) {
    const v = fitView(bbox);
    const same = state.view && v.lat === state.view.lat && v.lon === state.view.lon && v.zoom === state.view.zoom;
    state.view = v; pathCache.clear();
    if (!same || !frame.src) reload();
    draw();
  }
  const fitSelection = () => setView(state.selected.length ? unionBBox(state.selected) : THAILAND);

  const pathCache = new Map();
  function toPx(lon, lat) {
    const w = wrap.clientWidth, h = wrap.clientHeight, v = state.view;
    const [cx, cy] = project(v.lon, v.lat, v.zoom), [x, y] = project(lon, lat, v.zoom);
    return [x - cx + w / 2, y - cy + h / 2];
  }
  function pathOf(a) {
    let d = pathCache.get(a.id);
    if (d) return d;
    const w = wrap.clientWidth, h = wrap.clientHeight, v = state.view;
    const [cx, cy] = project(v.lon, v.lat, v.zoom), ox = w / 2 - cx, oy = h / 2 - cy;
    d = a.polys.map((poly) => poly.map((ring) => {
      let s = '', px = NaN, py = NaN;
      for (let i = 0; i < ring.length; i++) {
        const [x, y] = project(ring[i][0], ring[i][1], v.zoom);
        const X = Math.round((x + ox) * 2) / 2, Y = Math.round((y + oy) * 2) / 2;
        if (X === px && Y === py) continue;
        s += (s ? 'L' : 'M') + X + ' ' + Y; px = X; py = Y;
      }
      return s + 'Z';
    }).join('')).join('');
    pathCache.set(a.id, d);
    return d;
  }
  const ctxOn = { province: true, main: false, sub: false };
  function rainColor(t) {
    const stops = [[0, [241, 243, 245]], [0.25, [165, 216, 255]], [0.5, [51, 154, 240]], [0.75, [95, 61, 196]], [1, [230, 73, 128]]];
    t = Math.max(0, Math.min(1, t));
    for (let i = 1; i < stops.length; i++) if (t <= stops[i][0]) {
      const [t0, c0] = stops[i - 1], [t1, c1] = stops[i], k = (t - t0) / (t1 - t0);
      return `rgb(${c0.map((c, j) => Math.round(c + (c1[j] - c) * k)).join(',')})`;
    }
    return 'rgb(230,73,128)';
  }
  function draw() {
    const w = wrap.clientWidth, h = wrap.clientHeight;
    if (!w || !h || !state.view) return;
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    let out = '';
    for (const kind of ['province', 'main', 'sub']) {
      if (!ctxOn[kind]) continue;
      out += `<g class="ctx ${kind}">${AREAS.filter((a) => a.kind === kind).map((a) => `<path d="${pathOf(a)}"/>`).join('')}</g>`;
    }
    const order = state.selected.filter((id) => id !== state.active).concat(state.active && state.selected.includes(state.active) ? [state.active] : []);
    for (const id of order) {
      const a = byId.get(id), c = colorOf(id), d = pathOf(a);
      out += `<g class="sel${id === state.active ? ' active' : ''}"><path d="${d}" class="halo"/><path d="${d}" class="line" stroke="${c}" fill="${c}" fill-rule="evenodd"/></g>`;
    }
    if ($('show-pts').checked && $('source').value === 'api') {
      const max = maxPtTotal();
      for (const id of state.selected) {
        const a = byId.get(id), pts = gridPoints(a);
        let r = results.get(id); if (r && r.method === 'image') r = null;
        const rr = pts.length > 150 ? 2.2 : 3;
        out += pts.map(([x, y], i) => {
          const [X, Y] = toPx(x, y);
          const fill = r && max > 0 ? rainColor(r.ptTotals[i] / max) : 'rgba(255,255,255,.75)';
          return `<circle cx="${X.toFixed(1)}" cy="${Y.toFixed(1)}" r="${rr}" fill="${fill}"/>`;
        }).join('');
      }
    }
    if ($('show-lbl').checked) {
      for (const id of state.selected) {
        const a = byId.get(id), r = results.get(id), [X, Y] = toPx(a.label[0], a.label[1]);
        out += `<text x="${X.toFixed(1)}" y="${Y.toFixed(1)}">${esc(a.name)}${r ? ` · ${fmt(r.total)} มม.` : ''}</text>`;
      }
    }
    svg.innerHTML = out;
  }
  function maxPtTotal() {
    let m = 0;
    for (const id of state.selected) { const r = results.get(id); if (r && r.method !== 'image') for (const v of r.ptTotals) if (v > m) m = v; }
    return m;
  }

  // คลิก/ชี้บนแผนที่ = เลือกพื้นที่ตามประเภทที่กรองอยู่ (ทั้งหมด = เลือกพื้นที่เล็กสุดที่ครอบจุด)
  function hitTest(ev) {
    const rect = wrap.getBoundingClientRect(), v = state.view;
    const [cx, cy] = project(v.lon, v.lat, v.zoom);
    const [lon, lat] = unproject(cx + ev.clientX - rect.left - rect.width / 2, cy + ev.clientY - rect.top - rect.height / 2, v.zoom);
    const hits = AREAS.filter((a) => (state.kind === 'all' || a.kind === state.kind) && inside(a, lon, lat));
    hits.sort((a, b) => a.km2 - b.km2);
    return { hit: hits[0], lon, lat };
  }
  shield.addEventListener('click', (ev) => {
    const { hit } = hitTest(ev);
    if (hit) toggle(hit.id, false);
  });
  let moveRaf = 0;
  shield.addEventListener('mousemove', (ev) => {
    cancelAnimationFrame(moveRaf);
    moveRaf = requestAnimationFrame(() => {
      const { hit, lon, lat } = hitTest(ev);
      const rect = wrap.getBoundingClientRect();
      tip.hidden = false;
      tip.style.left = ev.clientX - rect.left + 'px';
      tip.style.top = ev.clientY - rect.top + 'px';
      const r = hit && results.get(hit.id);
      tip.textContent = hit ? `${KIND_LABEL[hit.kind]} ${hit.name}${r ? ` · ${fmt(r.total)} มม.` : ''}` : `${lat.toFixed(3)}, ${lon.toFixed(3)}`;
    });
  });
  shield.addEventListener('mouseleave', () => { cancelAnimationFrame(moveRaf); tip.hidden = true; });

  layerSel.addEventListener('change', reload);
  vtDate.addEventListener('change', reload);
  vtDate.addEventListener('click', () => { try { vtDate.showPicker(); } catch {} });
  function setVtDate(d) { if (d > VT_MAX) return; vtDate.value = d; reload(); }
  $('vt-prev').addEventListener('click', () => setVtDate(addDays(vtDate.value || today, -1)));
  $('vt-next').addEventListener('click', () => setVtDate(addDays(vtDate.value || today, 1)));
  $('vt-fit').addEventListener('click', () => { if (wrap.classList.contains('unlocked')) lockBtn.click(); fitSelection(); });
  lockBtn.addEventListener('click', () => {
    const locked = wrap.classList.toggle('unlocked') === false;
    lockBtn.setAttribute('aria-pressed', String(locked));
    lockBtn.textContent = locked ? 'ปลดล็อกแผนที่' : 'ล็อกและแสดงขอบเขต';
    if (locked) reload();
  });
  document.querySelectorAll('input[data-ctx]').forEach((cb) => {
    ctxOn[cb.dataset.ctx] = cb.checked;
    cb.addEventListener('change', () => { ctxOn[cb.dataset.ctx] = cb.checked; draw(); });
  });
  $('show-pts').addEventListener('change', draw);
  $('show-lbl').addEventListener('change', draw);
  let rzT = 0;
  const onResize = () => { clearTimeout(rzT); rzT = setTimeout(() => { pathCache.clear(); draw(); renderChart(); }, 80); };
  window.addEventListener('resize', onResize);
  if ('ResizeObserver' in window) new ResizeObserver(onResize).observe(wrap);

  // ---------- รายการค้นหา/กรอง ----------
  const nl = $('nl'), qInp = $('nl-q'), kindSel = $('nl-kind'), searchBox = $('nl-search');
  function setKind(k) {
    state.kind = k; kindSel.value = k;
    searchBox.classList.toggle('on', k !== 'all');
    document.querySelectorAll('#kind-tabs button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.kind === k)));
    renderList();
  }
  kindSel.addEventListener('change', () => setKind(kindSel.value));
  document.querySelectorAll('#kind-tabs button').forEach((b) => b.addEventListener('click', () => setKind(b.dataset.kind)));
  qInp.addEventListener('input', () => { state.q = qInp.value.trim().toLowerCase(); renderList(); });
  qInp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { const first = nl.querySelector('.nl-row'); if (first) toggle(first.dataset.id, true); }
    if (e.key === 'ArrowDown') { e.preventDefault(); nl.querySelector('.nl-row')?.focus(); }
  });
  const collator = new Intl.Collator('th');
  function sortKey(a, b) {
    if (a.kind !== b.kind) return ['province', 'main', 'sub'].indexOf(a.kind) - ['province', 'main', 'sub'].indexOf(b.kind);
    return a.kind === 'province' ? collator.compare(a.name, b.name) : a.code.localeCompare(b.code, 'en', { numeric: true });
  }
  function hl(s) {
    if (!state.q) return esc(s);
    const i = s.toLowerCase().indexOf(state.q);
    return i < 0 ? esc(s) : esc(s.slice(0, i)) + '<mark>' + esc(s.slice(i, i + state.q.length)) + '</mark>' + esc(s.slice(i + state.q.length));
  }
  function renderList() {
    const terms = state.q.split(/\s+/).filter(Boolean);
    const list = AREAS.filter((a) => (state.kind === 'all' || a.kind === state.kind) && terms.every((t) => a.search.includes(t))).sort(sortKey);
    $('nl-count').textContent = `${list.length.toLocaleString('th-TH')} พื้นที่`;
    if (!list.length) { nl.innerHTML = '<div class="nl-empty">ไม่พบพื้นที่ที่ตรงกับคำค้น</div>'; return; }
    nl.innerHTML = list.map((a) => {
      const sel = state.selected.includes(a.id), r = results.get(a.id);
      const meta = a.kind === 'province' ? `จังหวัด · ${esc(a.en)}` : a.kind === 'main' ? `ลุ่มน้ำหลัก · รหัส ${esc(a.code)}` : `ลุ่มน้ำย่อย ${esc(a.code)} · ลุ่มน้ำ${hl(a.parent)}`;
      return `<div class="nl-row${sel ? ' sel' : ''}" role="option" tabindex="0" aria-selected="${sel}" data-id="${a.id}">
        <input type="checkbox" tabindex="-1" ${sel ? 'checked' : ''} aria-hidden="true">
        <span class="n">${hl(a.name)}</span>
        <span class="p">${r ? `<b style="color:var(--ink)">${fmt(r.total)}</b> มม.<br>` : ''}${fmt(a.km2, 0)} ตร.กม.</span>
        <span class="k">${meta}</span></div>`;
    }).join('');
  }
  nl.addEventListener('click', (e) => { const row = e.target.closest('.nl-row'); if (row) toggle(row.dataset.id, true); });
  nl.addEventListener('keydown', (e) => {
    const row = e.target.closest('.nl-row'); if (!row) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(row.dataset.id, true); }
    if (e.key === 'ArrowDown') { e.preventDefault(); row.nextElementSibling?.focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); (row.previousElementSibling || qInp).focus(); }
  });

  function toggle(id, fit) {
    const i = state.selected.indexOf(id);
    if (i >= 0) { state.selected.splice(i, 1); if (state.active === id) state.active = state.selected[state.selected.length - 1] || null; }
    else { state.selected.push(id); state.active = id; }
    const focused = document.activeElement?.dataset?.id;
    selectionChanged(fit);
    if (focused) nl.querySelector(`.nl-row[data-id="${focused}"]`)?.focus();
  }
  function setActive(id) { state.active = id; renderChips(); draw(); renderResults(); }
  function selectionChanged(fit) {
    renderList(); renderChips();
    if (fit) fitSelection(); else draw();
    renderResults();
    if (state.ran && isApi()) { clearTimeout(autoT); autoT = setTimeout(() => calc(true), 500); }
  }
  let autoT = 0;
  function renderChips() {
    const el = $('chips');
    if (!state.selected.length) { el.innerHTML = '<span class="none">ยังไม่ได้เลือก — ค้นหาจากรายการ หรือคลิกบนแผนที่</span>'; return; }
    el.innerHTML = state.selected.map((id) => {
      const a = byId.get(id);
      return `<span class="chip${id === state.active ? ' active' : ''}" data-id="${id}" title="${KIND_LABEL[a.kind]} ${esc(a.name)}"><i style="background:${colorOf(id)}"></i>${esc(a.name)}<button type="button" aria-label="นำ ${esc(a.name)} ออก" data-rm="${id}">×</button></span>`;
    }).join('');
  }
  $('chips').addEventListener('click', (e) => {
    const rm = e.target.closest('[data-rm]');
    if (rm) { toggle(rm.dataset.rm, false); return; }
    const chip = e.target.closest('.chip'); if (chip) setActive(chip.dataset.id);
  });
  $('sel-clear').addEventListener('click', () => { state.selected = []; state.active = null; selectionChanged(true); });

  // ---------- ดึงฝน Open-Meteo ----------
  const dStart = $('d-start'), dEnd = $('d-end'), modelSel = $('model'), statusEl = $('status');
  const MODE_LABEL = { '0707': '07–07 น.', '0024': '00–24 น.' };
  const dayMode = () => $('day-mode').value;
  // วันฝน 07–07 ของวัน D ต้องใช้ข้อมูลถึง 07:00 น. วัน D+1 จึงพยากรณ์ได้น้อยกว่า 1 วัน
  function applyModeLimits() {
    dEnd.max = addDays(today, dayMode() === '0707' ? FC_MAX - 1 : FC_MAX); dStart.max = dEnd.max;
    if (dEnd.value > dEnd.max) dEnd.value = dEnd.max;
    if (dStart.value > dEnd.value) dStart.value = dEnd.value;
  }
  // เวลาสิ้นสุดของวันฝน D (เวลาไทย, ms) และข้อความช่วงเวลา
  const periodEnd = (d, mode) => Date.parse(addDays(d, 1) + 'T00:00:00Z') + (mode === '0707' ? 7 * 3600e3 : 0);
  const isForecast = (d, mode) => periodEnd(d, mode) > Date.now() + 7 * 3600e3;
  const periodText = (d, mode) => mode === '0707' ? `07:00 น. ${thDate(d)} – 07:00 น. ${thDate(addDays(d, 1), true)}` : `00:00–24:00 น. ${thDate(d, true)}`;
  dStart.min = dEnd.min = '1940-01-01';
  dStart.value = addDays(today, -7); dEnd.value = today;
  applyModeLimits();
  $('presets').addEventListener('click', (e) => {
    const b = e.target.closest('[data-p]'); if (!b) return;
    const [s, n] = b.dataset.p.split(',').map(Number);
    dStart.value = addDays(today, s); dEnd.value = addDays(today, n);
    if (dEnd.value > dEnd.max) dEnd.value = dEnd.max;
    if (state.selected.length && isApi()) calc();
  });
  for (const el of [dStart, dEnd]) el.addEventListener('click', () => { try { el.showPicker(); } catch {} });

  function setStatus(msg, err) { statusEl.textContent = msg; statusEl.classList.toggle('err', !!err); }

  async function getJSON(url) {
    for (let attempt = 0; ; attempt++) {
      const r = await fetch(url);
      if (r.ok) return r.json();
      let reason = r.statusText;
      try { reason = (await r.json()).reason || reason; } catch {}
      if (r.status === 429 && attempt < 2) { await new Promise((ok) => setTimeout(ok, 4000 * (attempt + 1))); continue; }
      throw new Error(`Open-Meteo ${r.status}: ${reason}`);
    }
  }
  // ดึงฝนรายวันของชุดจุด แบ่งช่วง archive (ERA5) / forecast และแบ่งคำขอ
  // mode '0024' = ใช้ daily precipitation_sum ของ Open-Meteo (00:00–24:00 น. เวลาไทย)
  // mode '0707' = ดึงฝนรายชั่วโมงแล้วรวมเอง 07:00 น. วัน D ถึง 07:00 น. วัน D+1 (ตั้งชื่อตามวันเริ่ม D แบบ ventusky_rain.py)
  async function fetchPoints(points, start, end, model, mode, onProgress) {
    const hourly = mode === '0707';
    const want = { s: start, e: end };
    if (hourly) end = addDays(end, 1); // ต้องใช้ชั่วโมงถึง 07:00 น. ของวันถัดจากวันสุดท้าย
    const segs = [];
    if (start < ARCHIVE_CUTOFF) segs.push({ base: 'https://archive-api.open-meteo.com/v1/archive', s: start, e: end < ARCHIVE_CUTOFF ? end : addDays(ARCHIVE_CUTOFF, -1), model: null });
    if (end >= ARCHIVE_CUTOFF) segs.push({ base: 'https://api.open-meteo.com/v1/forecast', s: start > ARCHIVE_CUTOFF ? start : ARCHIVE_CUTOFF, e: end, model });
    const CH = hourly ? 50 : 100, jobs = [];
    for (const seg of segs) for (let i = 0; i < points.length; i += CH) jobs.push({ seg, pts: points.slice(i, i + CH) });
    const out = points.map(() => ({}));
    const index = new Map(points.map((p, i) => [p.join(','), i]));
    let done = 0, next = 0;
    async function worker() {
      while (next < jobs.length) {
        const { seg, pts } = jobs[next++];
        const q = new URLSearchParams({
          latitude: pts.map((p) => p[1]).join(','), longitude: pts.map((p) => p[0]).join(','),
          start_date: seg.s, end_date: seg.e, timezone: TZ,
        });
        q.set(hourly ? 'hourly' : 'daily', hourly ? 'precipitation' : 'precipitation_sum');
        if (seg.model && seg.model !== 'best_match') q.set('models', seg.model);
        let data = await getJSON(`${seg.base}?${q}`);
        if (!Array.isArray(data)) data = [data];
        data.forEach((d, k) => {
          const o = out[index.get(pts[k].join(','))];
          const blk = hourly ? d.hourly : d.daily, name = hourly ? 'precipitation' : 'precipitation_sum';
          const t = blk.time, v = blk[name] || blk[Object.keys(blk).find((x) => x.startsWith(name))];
          if (!hourly) { t.forEach((day, j) => { o[day] = v[j]; }); return; }
          // ค่ารายชั่วโมงที่เวลา T = ฝนสะสมช่วง (T−1 ชม., T] → อยู่ในวันฝน D เมื่อ T−8 ชม. ตกในวัน D
          const acc = o._acc || (o._acc = {});
          t.forEach((ts, j) => {
            const day = new Date(Date.parse(ts + ':00Z') - 8 * 3600e3).toISOString().slice(0, 10);
            if (day < want.s || day > want.e) return;
            const c = acc[day] || (acc[day] = { s: 0, n: 0, miss: 0 });
            if (v[j] == null) c.miss++; else { c.s += v[j]; c.n++; }
          });
        });
        onProgress(++done, jobs.length);
      }
    }
    await Promise.all([worker(), worker(), worker()]);
    if (hourly) for (const o of out) {
      // วันที่ไม่ครบ 24 ชั่วโมง (เช่น เกินขอบพยากรณ์) ถือว่าไม่มีข้อมูล
      for (const [day, c] of Object.entries(o._acc || {})) o[day] = c.n === 24 ? c.s : null;
      delete o._acc;
    }
    return out;
  }

  let calcSeq = 0;
  async function calc(auto) {
    const start = dStart.value, end = dEnd.value, model = modelSel.value, mode = dayMode();
    if (!state.selected.length) { setStatus('เลือกพื้นที่อย่างน้อย 1 พื้นที่ก่อน', true); return; }
    if (!start || !end || start > end) { setStatus('ช่วงวันที่ไม่ถูกต้อง', true); return; }
    if (end > dEnd.max) { setStatus(`พยากรณ์ได้ถึงวันฝน ${thDate(dEnd.max, true)}${mode === '0707' ? ' (07–07 น. ต้องใช้ข้อมูลถึงเช้าวันถัดไป)' : ''}`, true); return; }
    if (dayDiff(start, end) > 731) { setStatus('ช่วงวันที่ยาวเกิน 2 ปี กรุณาลดช่วง', true); return; }
    state.ran = true;
    const key = `${start}|${end}|${model}|${mode}`;
    const ids = state.selected.slice();
    const need = new Map();
    for (const id of ids) for (const p of gridPoints(byId.get(id))) { const k = p.join(','); if (!ptCache.has(key + '|' + k)) need.set(k, p); }
    const seq = ++calcSeq;
    const btn = $('calc'); btn.disabled = true;
    try {
      if (need.size) {
        setStatus(`กำลังดึงข้อมูลฝน ${need.size.toLocaleString('th-TH')} จุดกริด…`);
        const pts = [...need.values()];
        const vals = await fetchPoints(pts, start, end, model, mode, (d, n) => { if (seq === calcSeq) setStatus(`กำลังดึงข้อมูลฝน ${need.size.toLocaleString('th-TH')} จุดกริด… ${Math.round((d / n) * 100)}%`); });
        pts.forEach((p, i) => ptCache.set(key + '|' + p.join(','), vals[i]));
      }
      if (seq !== calcSeq) return;
      const dates = []; for (let d = start; d <= end; d = addDays(d, 1)) dates.push(d);
      for (const id of ids) {
        const a = byId.get(id), pts = gridPoints(a);
        const series = pts.map((p) => ptCache.get(key + '|' + p.join(',')) || {});
        const avg = dates.map((d) => {
          let s = 0, n = 0; for (const o of series) { const v = o[d]; if (v != null) { s += v; n++; } }
          return n ? s / n : null;
        });
        const ptTotals = series.map((o) => dates.reduce((s, d) => s + (o[d] || 0), 0));
        const valid = avg.filter((v) => v != null);
        let maxI = -1; avg.forEach((v, i) => { if (v != null && (maxI < 0 || v > avg[maxI])) maxI = i; });
        const total = valid.reduce((s, v) => s + v, 0);
        results.set(id, {
          key, model, mode, dates, avg, ptTotals, total, n: pts.length,
          mean: valid.length ? total / valid.length : null,
          max: maxI >= 0 ? avg[maxI] : null, maxDate: maxI >= 0 ? dates[maxI] : null,
          wet: valid.filter((v) => v >= 1).length, missing: avg.length - valid.length,
          ptMin: Math.min(...ptTotals), ptMax: Math.max(...ptTotals),
          volume: (total / 1000) * a.km2, // ล้าน ลบ.ม. (มม./1000 × ตร.กม. × 10^6 ÷ 10^6)
        });
      }
      const src = start < ARCHIVE_CUTOFF ? (end >= ARCHIVE_CUTOFF ? 'ERA5 + ' + modelSel.selectedOptions[0].text : 'ERA5 reanalysis') : modelSel.selectedOptions[0].text;
      setStatus(`คำนวณแล้ว ${ids.length} พื้นที่ · ${thDate(start, true)} – ${thDate(end, true)} · วันฝน ${MODE_LABEL[mode]} · ${src}`);
    } catch (err) {
      if (seq === calcSeq) setStatus(`ดึงข้อมูลไม่สำเร็จ: ${err.message}`, true);
    } finally {
      if (seq === calcSeq) btn.disabled = false;
    }
    renderList(); draw(); renderResults();
  }
  $('calc').addEventListener('click', () => (isApi() ? calc() : runImageCalc()));
  modelSel.addEventListener('change', () => { if (state.ran && isApi()) calc(); });
  $('day-mode').addEventListener('change', () => { applyModeLimits(); if (state.ran && isApi()) calc(); });

  // ---------- วิธีภาพ Ventusky (แบบเดียวกับ trackflood/scripts/ventusky_rain.py) ----------
  // จับภาพแท็บนี้ (Screen Capture API) ทีละช่วง 3 ชม. → เทียบสีกับแถบสีฝนของ Ventusky → มม. → median filter → เฉลี่ยในขอบเขต
  // "วัน" = 8 ภาพที่ 00,03,…,21 UTC ของวันนั้น (07:00, 10:00, …, 04:00 น. เวลาไทย) เหมือน ventusky_rain.py
  const isApi = () => $('source').value === 'api';
  const STOPS = [ // แถบสีฝนของ Ventusky (มม.) — ค่าเดียวกับ STOPS ใน ventusky_rain.py
    [0.1, [88, 84, 111]], [0.2, [89, 85, 135]], [0.5, [73, 102, 170]], [1, [68, 151, 169]],
    [2, [80, 181, 97]], [4, [142, 203, 73]], [6, [204, 216, 60]], [8, [217, 179, 61]],
    [10, [216, 155, 66]], [15, [215, 119, 75]], [20, [208, 94, 93]], [30, [177, 54, 101]],
    [40, [147, 23, 78]], [50, [84, 16, 41]],
  ];
  const ALPHA = 0.75; // ความทึบของชั้นฝนบนแผนที่พื้น (ค่าเดียวกับสคริปต์)
  const RAMP = (() => { // ไล่สีระหว่างจุดหยุด ช่วงละ 20 ขั้น (build_ramp ในสคริปต์)
    const v = [], c = [];
    for (let i = 0; i + 1 < STOPS.length; i++) {
      const [v0, c0] = STOPS[i], [v1, c1] = STOPS[i + 1];
      for (let k = 0; k < 20; k++) { const t = k / 20; v.push(v0 + (v1 - v0) * t); c.push(c0.map((x, j) => x + (c1[j] - x) * t)); }
    }
    v.push(STOPS[STOPS.length - 1][0]); c.push(STOPS[STOPS.length - 1][1]);
    return { v: Float32Array.from(v), c: c.flat() };
  })();
  // ตารางค้นสีใกล้สุดในแถบ (32 ระดับ/ช่องสี): argmin ‖o − (αC + (1−α)b)‖ = argmin ‖(o − (1−α)b)/α − C‖ จึงค้นจากสีที่ "ถอดพื้นออก" ได้เลย
  let LUT = null;
  function buildLut() {
    if (LUT) return LUT;
    LUT = new Uint16Array(32 * 32 * 32);
    const n = RAMP.v.length;
    for (let r = 0; r < 32; r++) for (let g = 0; g < 32; g++) for (let b = 0; b < 32; b++) {
      const R = r * 8 + 4, G = g * 8 + 4, B = b * 8 + 4;
      let best = 1e9, bi = 0;
      for (let i = 0; i < n; i++) {
        const dr = R - RAMP.c[i * 3], dg = G - RAMP.c[i * 3 + 1], db = B - RAMP.c[i * 3 + 2], d = dr * dr + dg * dg + db * db;
        if (d < best) { best = d; bi = i; }
      }
      LUT[(r << 10) | (g << 5) | b] = bi;
    }
    return LUT;
  }
  const CAP_PAD = { l: 24, r: 64, t: 60, b: TIMEBAR + 16 }; // เว้นป้าย Precipitation (ซ้ายบน) โลโก้/ปุ่มซูม/แถบสี (ขวา) แถบเวลา (ล่าง)
  const MAX_PX = 140000; // จำนวนพิกเซลต่อภาพที่เก็บไว้ (ย่อภาพถ้าใหญ่กว่านี้)
  const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
  const capStop = $('cap-stop');
  let capAbort = false;
  capStop.addEventListener('click', () => { capAbort = true; setStatus('กำลังหยุด…'); });

  function waitLoad(ms) {
    return new Promise((ok) => {
      const done = () => { clearTimeout(t); frame.removeEventListener('load', done); ok(); };
      const t = setTimeout(done, ms);
      frame.addEventListener('load', done);
    });
  }
  const nextVideoFrame = (video) => new Promise((ok) => {
    if (video.requestVideoFrameCallback) { const t = setTimeout(ok, 500); video.requestVideoFrameCallback(() => { clearTimeout(t); ok(); }); }
    else setTimeout(ok, 200);
  });

  async function runImageCalc() {
    const start = dStart.value, end = dEnd.value, ids = state.selected.slice();
    if (!ids.length) { setStatus('เลือกพื้นที่อย่างน้อย 1 พื้นที่ก่อน', true); return; }
    if (!start || !end || start > end) { setStatus('ช่วงวันที่ไม่ถูกต้อง', true); return; }
    if (end > VT_MAX) { setStatus(`Ventusky มีภาพถึง ${thDate(VT_MAX, true)}`, true); return; }
    if (dayDiff(start, end) > 30) { setStatus('วิธีภาพทำได้ครั้งละไม่เกิน 31 วัน (240 ภาพ) กรุณาลดช่วง', true); return; }
    if (!navigator.mediaDevices?.getDisplayMedia) { setStatus('เบราว์เซอร์นี้จับภาพหน้าจอไม่ได้ ใช้ Chrome หรือ Edge บนคอมพิวเตอร์', true); return; }
    const wait = Math.max(2, Math.min(30, +$('cap-wait').value || 6));
    const days = []; for (let d = start; d <= end; d = addDays(d, 1)) days.push(d);
    const times = days.flatMap((d) => [0, 3, 6, 9, 12, 15, 18, 21].map((h) => ({ day: d, t: `${d.replace(/-/g, '')}/${String(h).padStart(2, '0')}00`, h })));
    setStatus(`เลือกแท็บนี้ ("แท็บนี้"/"This tab") ในหน้าต่างแชร์หน้าจอ แล้วกดแชร์ · ${times.length} ภาพ ใช้เวลาราว ${Math.ceil((times.length * (wait + 2)) / 60)} นาที`);

    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: 'browser', cursor: 'never', frameRate: 5 }, audio: false,
        preferCurrentTab: true, selfBrowserSurface: 'include', surfaceSwitching: 'exclude',
      });
    } catch (err) { setStatus('ไม่ได้รับอนุญาตให้จับภาพแท็บ (ต้องกดแชร์ "แท็บนี้")', true); return; }
    const track = stream.getVideoTracks()[0];
    if (track.getSettings().displaySurface && track.getSettings().displaySurface !== 'browser') {
      stream.getTracks().forEach((t) => t.stop());
      setStatus('ต้องแชร์ "แท็บนี้" ไม่ใช่ทั้งหน้าจอหรือหน้าต่าง', true); return;
    }
    const video = document.createElement('video');
    video.muted = true; video.playsInline = true; video.srcObject = stream;
    await video.play();

    capAbort = false;
    track.addEventListener('ended', () => { capAbort = true; });
    const btn = $('calc'); btn.disabled = true; capStop.hidden = false;
    if (wrap.classList.contains('unlocked')) lockBtn.click();
    // โหมดจับภาพ: ขยายแผนที่เต็มความสูงจอ (ซูมได้ละเอียดขึ้น) ซ่อนเส้นขอบเขต/ป้ายของหน้าเว็บไม่ให้ติดในภาพ
    document.body.classList.add('capturing');
    const oldStyle = wrap.getAttribute('style') || '';
    wrap.style.cssText = `aspect-ratio:auto;max-height:none;height:${Math.max(420, innerHeight - 16)}px`;
    await sleep(100);
    const fitTop = () => window.scrollTo({ top: wrap.getBoundingClientRect().top + scrollY - 8, behavior: 'instant' });
    fitTop();
    const prevView = state.view, prevLayer = layerSel.value;
    const view = fitView(unionBBox(ids), CAP_PAD);
    state.view = view; pathCache.clear();

    // กรอบตัดภาพ = ขอบเขตรวมของพื้นที่ที่เลือก (px ในกรอบแผนที่)
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (const id of ids) {
      const [a0, b0, a1, b1] = byId.get(id).bbox, p = toPx(a0, b1), q = toPx(a1, b0);
      x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, q[0]); y1 = Math.max(y1, q[1]);
    }
    const W0 = wrap.clientWidth, H0 = wrap.clientHeight;
    const cx = Math.max(0, Math.floor(x0) - 3), cy = Math.max(0, Math.floor(y0) - 3);
    const cwCss = Math.min(W0, Math.ceil(x1) + 3) - cx, chCss = Math.min(H0, Math.ceil(y1) + 3) - cy;
    const ds = Math.max(1, Math.ceil(Math.sqrt((cwCss * chCss) / MAX_PX)));
    const cw = Math.max(1, Math.round(cwCss / ds)), ch = Math.max(1, Math.round(chCss / ds));
    const cvs = document.createElement('canvas'); cvs.width = cw; cvs.height = ch;
    const ctx = cvs.getContext('2d', { willReadFrequently: true });
    // หน้ากากของแต่ละพื้นที่ (ระบายรูป polygon แบบ even-odd ลงผืนเดียวกับภาพที่ตัด)
    const masks = new Map();
    for (const id of ids) {
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, cw, ch);
      ctx.setTransform(1 / ds, 0, 0, 1 / ds, -cx / ds, -cy / ds);
      ctx.fillStyle = '#000'; ctx.fill(new Path2D(pathOf(byId.get(id))), 'evenodd');
      const al = ctx.getImageData(0, 0, cw, ch).data, m = new Uint8Array(cw * ch);
      let n = 0; for (let i = 0; i < m.length; i++) if (al[i * 4 + 3] >= 128) { m[i] = 1; n++; }
      masks.set(id, { m, n });
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    const frames = []; // { day, h, rgb: Uint8Array }
    const t0 = Date.now();
    try {
      for (let i = 0; i < times.length && !capAbort; i++) {
        const { day, t, h } = times[i];
        const loaded = waitLoad(30000);
        frame.src = `https://embed.ventusky.com/?p=${view.lat};${view.lon};${view.zoom}&l=rain-3h&t=${t}`;
        await loaded;
        await sleep(wait * 1000);
        while (document.visibilityState !== 'visible' && !capAbort) { setStatus('แท็บถูกซ่อนอยู่ — กลับมาที่แท็บนี้เพื่อจับภาพต่อ', true); await sleep(1000); }
        let rect = frame.getBoundingClientRect();
        if (rect.top < 0 || rect.bottom > innerHeight + 1) { fitTop(); await sleep(400); rect = frame.getBoundingClientRect(); }
        await nextVideoFrame(video);
        const sx = video.videoWidth / innerWidth, sy = video.videoHeight / innerHeight;
        ctx.drawImage(video, (rect.left + cx) * sx, (rect.top + cy) * sy, cwCss * sx, chCss * sy, 0, 0, cw, ch);
        const px = ctx.getImageData(0, 0, cw, ch).data, rgb = new Uint8Array(cw * ch * 3);
        for (let k = 0, j = 0; k < px.length; k += 4) { rgb[j++] = px[k]; rgb[j++] = px[k + 1]; rgb[j++] = px[k + 2]; }
        frames.push({ day, h, rgb });
        const per = (Date.now() - t0) / (i + 1), left = Math.ceil(((times.length - i - 1) * per) / 60000);
        setStatus(`จับภาพ ${i + 1}/${times.length} · ${thDate(day)} ${String((h + 7) % 24).padStart(2, '0')}:00 น. · เหลือราว ${left} นาที (ห้ามเลื่อน/สลับแท็บระหว่างนี้)`);
      }
    } finally {
      stream.getTracks().forEach((tr) => tr.stop());
      document.body.classList.remove('capturing');
      wrap.setAttribute('style', oldStyle);
      capStop.hidden = true; btn.disabled = false;
      layerSel.value = prevLayer;
      state.view = prevView; pathCache.clear();
      setTimeout(() => { fitSelection(); reload(); }, 50);
    }
    if (frames.length < 2) { setStatus(capAbort ? 'หยุดจับภาพแล้ว (ภาพไม่พอคำนวณ)' : 'จับภาพไม่สำเร็จ', true); return; }

    // ---- แปลงสีเป็น มม. ----
    setStatus(`กำลังแปลงสีเป็นค่าฝน ${frames.length} ภาพ…`);
    await sleep(30);
    const N = cw * ch, lut = buildLut();
    // แผนที่พื้น (ไม่มีฝน): ทุกพิกเซลเลือกสีจากภาพที่ "จืด" ที่สุด (baseline ในสคริปต์)
    const base = new Uint8Array(N * 3), bestC = new Int16Array(N).fill(999);
    for (const f of frames) {
      const c = f.rgb;
      for (let i = 0, j = 0; i < N; i++, j += 3) {
        const r = c[j], g = c[j + 1], b = c[j + 2], chroma = Math.max(r, g, b) - Math.min(r, g, b);
        if (chroma < bestC[i]) { bestC[i] = chroma; base[j] = r; base[j + 1] = g; base[j + 2] = b; }
      }
    }
    const K = ds >= 2 ? 3 : 5; // median 5×5 ที่ความละเอียดเต็ม ≈ 3×3 เมื่อย่อภาพครึ่งหนึ่ง
    const raw = new Float32Array(N), val = new Float32Array(N), win = new Float32Array(K * K);
    const sum = new Map(ids.map((id) => [id, new Float32Array(N)]));
    const per3h = ids.map(() => []);
    for (let fi = 0; fi < frames.length; fi++) {
      const c = frames[fi].rgb;
      for (let i = 0, j = 0; i < N; i++, j += 3) {
        const r = c[j], g = c[j + 1], b = c[j + 2], br = base[j], bg = base[j + 1], bb = base[j + 2];
        const none = (r - br) ** 2 + (g - bg) ** 2 + (b - bb) ** 2; // ไม่มีฝน = 0 มม.
        if (none < 12) { raw[i] = 0; continue; }
        const er = (r - (1 - ALPHA) * br) / ALPHA, eg = (g - (1 - ALPHA) * bg) / ALPHA, eb = (b - (1 - ALPHA) * bb) / ALPHA;
        const q = (v) => (v <= 0 ? 0 : v >= 255 ? 31 : v >> 3);
        // ตารางค้นให้ตำแหน่งคร่าว ๆ แล้วหาใกล้สุดจริงในช่วง ±12 ขั้น (ผลตรงกับการค้นทั้งแถบแบบสคริปต์ 100% จากการทดสอบ)
        const k0 = lut[(q(er) << 10) | (q(eg) << 5) | q(eb)];
        let dBest = 1e9, k = k0;
        for (let kk = Math.max(0, k0 - 12), ke = Math.min(RAMP.v.length - 1, k0 + 12); kk <= ke; kk++) {
          const d = (er - RAMP.c[kk * 3]) ** 2 + (eg - RAMP.c[kk * 3 + 1]) ** 2 + (eb - RAMP.c[kk * 3 + 2]) ** 2;
          if (d < dBest) { dBest = d; k = kk; }
        }
        raw[i] = dBest * ALPHA * ALPHA < none ? RAMP.v[k] : 0; // ‖o − (αC+(1−α)b)‖² = α²‖e − C‖²
      }
      // median filter: ลบเส้นถนน/ตัวอักษร/ลูกศรลมบนแผนที่
      const hk = K >> 1;
      for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
        let n = 0, any = false;
        for (let dy = -hk; dy <= hk; dy++) {
          const yy = Math.min(ch - 1, Math.max(0, y + dy)) * cw;
          for (let dx = -hk; dx <= hk; dx++) { const v = raw[yy + Math.min(cw - 1, Math.max(0, x + dx))]; win[n++] = v; if (v) any = true; }
        }
        if (!any) { val[y * cw + x] = 0; continue; }
        win.sort(); val[y * cw + x] = win[(K * K) >> 1];
      }
      ids.forEach((id, a) => {
        const { m, n } = masks.get(id), s = sum.get(id);
        let tot = 0; for (let i = 0; i < N; i++) if (m[i]) { tot += val[i]; s[i] += val[i]; }
        per3h[a].push(n ? tot / n : 0);
      });
      if (fi % 8 === 7) { setStatus(`กำลังแปลงสีเป็นค่าฝน ${fi + 1}/${frames.length} ภาพ…`); await sleep(0); }
    }

    // ---- รวมรายวัน (8 ภาพ/วัน) ----
    const capDays = [...new Set(frames.map((f) => f.day))];
    const key = `${start}|${end}|image|0707`;
    ids.forEach((id, a) => {
      const area = byId.get(id), { m, n } = masks.get(id), s = sum.get(id);
      const avg = capDays.map((d) => { let v = 0, c = 0; frames.forEach((f, i) => { if (f.day === d) { v += per3h[a][i]; c++; } }); return c ? v : null; });
      const counts = capDays.map((d) => frames.filter((f) => f.day === d).length);
      const valid = avg.filter((v) => v != null), total = valid.reduce((x, v) => x + v, 0);
      let maxI = -1; avg.forEach((v, i) => { if (v != null && (maxI < 0 || v > avg[maxI])) maxI = i; });
      let pmin = Infinity, pmax = 0; for (let i = 0; i < N; i++) if (m[i]) { if (s[i] < pmin) pmin = s[i]; if (s[i] > pmax) pmax = s[i]; }
      results.set(id, {
        key, method: 'image', model: 'ventusky', mode: '0707', dates: capDays, avg, counts, ptTotals: [], total, n,
        frames3h: frames.map((f, i) => ({ day: f.day, h: f.h, v: per3h[a][i] })),
        mean: valid.length ? total / valid.length : null,
        max: maxI >= 0 ? avg[maxI] : null, maxDate: maxI >= 0 ? capDays[maxI] : null,
        wet: valid.filter((v) => v >= 1).length, missing: 0,
        ptMin: n ? pmin : null, ptMax: pmax, volume: (total / 1000) * area.km2,
        zoom: view.zoom, ds,
      });
    });
    state.ran = true;
    setStatus(`คำนวณจากภาพ Ventusky แล้ว ${ids.length} พื้นที่ · ${frames.length} ภาพ (${capDays.length} วัน) · ซูม ${view.zoom}${ds > 1 ? ` · ย่อภาพ 1/${ds}` : ''}${capAbort ? ' · หยุดก่อนครบ' : ''}`);
    renderList(); draw(); renderResults();
  }
  function applySource() {
    const img = !isApi();
    modelSel.disabled = img;
    $('day-mode').disabled = img;
    if (img) { $('day-mode').value = '0707'; applyModeLimits(); }
    $('wait-grp').hidden = !img;
    $('calc').textContent = img ? 'จับภาพและคำนวณ' : 'คำนวณฝนเฉลี่ย';
    $('method-api').hidden = img; $('method-img').hidden = !img;
    draw();
  }
  $('source').addEventListener('change', applySource);

  // ---------- แสดงผล ----------
  const currentKey = () => isApi() ? `${dStart.value}|${dEnd.value}|${modelSel.value}|${dayMode()}` : `${dStart.value}|${dEnd.value}|image|0707`;
  function renderResults() {
    const has = state.selected.filter((id) => results.has(id));
    $('csv').disabled = !has.length;
    const act = state.active && results.get(state.active);
    const a = state.active && byId.get(state.active);
    // KPI
    $('kpis').innerHTML = act ? [
      ['ฝนเฉลี่ยสะสม', `${fmt(act.total)}<small>มม.</small>`, `${esc(a.name)} · ${act.dates.length} วัน`],
      ['ฝนเฉลี่ยต่อวัน', `${fmt(act.mean)}<small>มม./วัน</small>`, `วันฝนตก (≥1 มม.) ${act.wet} วัน`],
      ['ฝนเฉลี่ยรายวันสูงสุด', `${fmt(act.max)}<small>มม.</small>`, act.maxDate ? periodText(act.maxDate, act.mode) : '–'],
      ['ปริมาตรน้ำฝน', `${fmt(act.volume, act.volume < 10 ? 2 : 0)}<small>ล้าน ลบ.ม.</small>`, `พื้นที่ ${fmt(a.km2, 0)} ตร.กม.`],
      act.method === 'image'
        ? ['ช่วงค่าฝนสะสมรายพิกเซล', `${fmt(act.ptMin, 0)}–${fmt(act.ptMax, 0)}<small>มม.</small>`, `ภาพ Ventusky ${act.frames3h.length} ภาพ · ${act.n.toLocaleString('th-TH')} พิกเซล (ซูม ${act.zoom})`]
        : ['ช่วงค่าฝนสะสมรายจุด', `${fmt(act.ptMin, 0)}–${fmt(act.ptMax, 0)}<small>มม.</small>`, `จากจุดกริด ${act.n} จุด (ห่าง ~${a.spacing.toFixed(2)}°)`],
    ].map(([l, v, n]) => `<div class="kpi" style="border-left-color:${colorOf(state.active)}"><span class="lbl">${l}</span><span class="val">${v}</span><span class="note">${n}</span></div>`).join('')
      : `<div class="kpi" style="grid-column:1/-1"><span class="lbl">${state.selected.length ? 'กด "คำนวณฝนเฉลี่ย" เพื่อดึงข้อมูลฝนของพื้นที่ที่เลือก' : 'เลือกพื้นที่จากแถบค้นหาด้านขวา หรือคลิกบนแผนที่ แล้วกด "คำนวณฝนเฉลี่ย"'}</span></div>`;
    renderChart();
    // ตาราง
    const tbl = $('summary');
    if (!state.selected.length) { tbl.innerHTML = ''; } else {
      tbl.innerHTML = `<thead><tr><th>พื้นที่</th><th>ประเภท</th><th class="num">พื้นที่ (ตร.กม.)</th><th class="num">จุดกริด/พิกเซล</th><th>แหล่งข้อมูล</th><th class="num">ฝนสะสม (มม.)</th><th class="num">เฉลี่ย/วัน (มม.)</th><th class="num">สูงสุดรายวัน (มม.)</th><th>วันที่สูงสุด</th><th class="num">ปริมาตร (ล้าน ลบ.ม.)</th></tr></thead><tbody>` +
        state.selected.map((id) => {
          const x = byId.get(id), r = results.get(id), stale = r && r.key !== currentKey();
          const sub = x.kind === 'sub' ? ` <span class="hint">(${esc(x.parent)})</span>` : '';
          return `<tr data-id="${id}" class="${id === state.active ? 'active' : ''}"><td><i style="background:${colorOf(id)}"></i>${esc(x.name)}${sub}</td><td>${KIND_LABEL[x.kind]}</td><td class="num">${fmt(x.km2, 0)}</td><td class="num">${r && r.method === 'image' ? r.n.toLocaleString('th-TH') : gridPoints(x).length}</td><td>${r ? (r.method === 'image' ? 'ภาพ Ventusky' : 'Open-Meteo') + ' · ' + MODE_LABEL[r.mode] : '–'}</td>` +
            (r ? `<td class="num"><b>${fmt(r.total)}</b>${stale ? ' <span class="hint" title="ค่าจากช่วงวันที่/แบบจำลองก่อนหน้า">*</span>' : ''}</td><td class="num">${fmt(r.mean)}</td><td class="num">${fmt(r.max)}</td><td>${r.maxDate ? thDate(r.maxDate, true) : '–'}</td><td class="num">${fmt(r.volume, r.volume < 10 ? 2 : 0)}</td>`
              : '<td class="num" colspan="5" style="color:var(--muted)">ยังไม่คำนวณ</td>') + '</tr>';
        }).join('') + '</tbody>';
    }
    const max = maxPtTotal();
    $('pt-scale').hidden = !has.length || !(max > 0);
    $('pt-grad').style.background = `linear-gradient(90deg, ${[0, .25, .5, .75, 1].map(rainColor).join(',')})`;
    $('pt-max').textContent = `0 – ${fmt(max, 0)} มม.`;
  }
  $('summary').addEventListener('click', (e) => { const tr = e.target.closest('tr[data-id]'); if (tr) setActive(tr.dataset.id); });

  const chartSvg = $('chart-svg'), chartTip = $('chart-tip');
  function renderChart() {
    const r = state.active && results.get(state.active);
    $('chart-legend').hidden = !r;
    chartSvg.style.display = r ? '' : 'none';
    if (!r) { chartSvg.innerHTML = ''; return; }
    const W = chartSvg.clientWidth || 800, H = 240, L = 40, R = 46, T = 14, Bm = 28;
    const n = r.dates.length, iw = W - L - R, ih = H - T - Bm;
    const ymax = niceMax(Math.max(1, ...r.avg.filter((v) => v != null)));
    const cmax = niceMax(Math.max(1, r.total));
    const bw = iw / n, gap = Math.min(4, bw * 0.2);
    const y = (v) => T + ih - (v / ymax) * ih, yc = (v) => T + ih - (v / cmax) * ih;
    let s = '<g class="axis">';
    for (let k = 0; k <= 4; k++) {
      const v = (ymax * k) / 4, Y = y(v);
      s += `<line x1="${L}" x2="${W - R}" y1="${Y}" y2="${Y}"/><text x="${L - 6}" y="${Y + 4}" text-anchor="end">${fmt(v, Number.isInteger(ymax / 4) ? 0 : 1)}</text><text x="${W - R + 6}" y="${Y + 4}">${fmt((cmax * k) / 4, 0)}</text>`;
    }
    const every = Math.ceil(n / Math.max(2, Math.floor(iw / 62)));
    r.dates.forEach((d, i) => { if (i % every === 0) s += `<text x="${L + bw * i + bw / 2}" y="${H - 8}" text-anchor="middle">${thDate(d)}</text>`; });
    s += `<text class="ttl" x="${L - 6}" y="${T - 4}" text-anchor="end">มม./วัน</text><text class="ttl" x="${W - R + 6}" y="${T - 4}">สะสม</text></g>`;
    r.dates.forEach((d, i) => {
      const v = r.avg[i], X = L + bw * i;
      s += `<g data-i="${i}"><rect class="hit" x="${X}" y="${T}" width="${bw}" height="${ih}"/>` +
        (v != null ? `<rect class="bar${isForecast(d, r.mode) ? ' fc' : ''}" x="${(X + gap / 2).toFixed(1)}" y="${y(v).toFixed(1)}" width="${Math.max(1, bw - gap).toFixed(1)}" height="${(T + ih - y(v)).toFixed(1)}" rx="1.5" pointer-events="none"/>` : '') + '</g>';
    });
    const ti = r.dates.findIndex((d) => isForecast(d, r.mode)); // วันฝนแรกที่ยังไม่จบ = เส้น "ตอนนี้"
    if (ti >= 0) s += `<line class="today" x1="${L + bw * ti}" x2="${L + bw * ti}" y1="${T}" y2="${T + ih}"/>`;
    let cum = 0;
    s += `<path class="cum" d="${r.avg.map((v, i) => { cum += v || 0; return `${i ? 'L' : 'M'}${(L + bw * i + bw / 2).toFixed(1)} ${yc(cum).toFixed(1)}`; }).join('')}"/>`;
    chartSvg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    chartSvg.innerHTML = s;
  }
  function niceMax(v) { const p = 10 ** Math.floor(Math.log10(v)); for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p; return 10 * p; }
  chartSvg.addEventListener('mousemove', (e) => {
    const g = e.target.closest('g[data-i]'), r = state.active && results.get(state.active);
    if (!g || !r) { chartTip.hidden = true; return; }
    const i = +g.dataset.i, d = r.dates[i];
    const cum = r.avg.slice(0, i + 1).reduce((s, v) => s + (v || 0), 0);
    chartTip.innerHTML = `<b>วันฝน ${thDate(d, true)}</b>${isForecast(d, r.mode) ? ' (มีส่วนที่เป็นพยากรณ์)' : ''}<br><span style="color:var(--muted)">${periodText(d, r.mode)}</span><br>ฝนเฉลี่ย ${fmt(r.avg[i])} มม. · สะสม ${fmt(cum)} มม.`;
    const box = $('chart').getBoundingClientRect();
    chartTip.hidden = false;
    const x = e.clientX - box.left;
    chartTip.style.left = Math.min(x + 12, box.width - chartTip.offsetWidth - 4) + 'px';
    chartTip.style.top = e.clientY - box.top - 50 + 'px';
  });
  chartSvg.addEventListener('mouseleave', () => { chartTip.hidden = true; });
  chartSvg.addEventListener('click', (e) => {
    const g = e.target.closest('g[data-i]'), r = state.active && results.get(state.active);
    if (!g || !r) return;
    const d = r.dates[+g.dataset.i];
    if (d > VT_MAX) { setStatus('Ventusky แสดงพยากรณ์ล่วงหน้าได้ไม่เกิน 14 วัน', true); return; }
    setVtDate(d);
    wrap.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });

  $('csv').addEventListener('click', () => {
    const ids = state.selected.filter((id) => results.has(id));
    if (!ids.length) return;
    const dates = [...new Set(ids.flatMap((id) => results.get(id).dates))].sort();
    const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
    const mode = results.get(ids[0]).mode;
    const span = (d) => mode === '0707' ? `${d} 07:00 - ${addDays(d, 1)} 07:00` : `${d} 00:00 - ${addDays(d, 1)} 00:00`;
    const rows = [['date', q('period (Thai time)'), ...ids.map((id) => q(`${KIND_LABEL[byId.get(id).kind]} ${byId.get(id).name} (mm)`))].join(',')];
    for (const d of dates) rows.push([d, span(d), ...ids.map((id) => { const r = results.get(id), i = r.dates.indexOf(d); return i >= 0 && r.avg[i] != null ? r.avg[i].toFixed(2) : ''; })].join(','));
    rows.push(['total', '', ...ids.map((id) => results.get(id).total.toFixed(2))].join(','));
    rows.push(['area_km2', '', ...ids.map((id) => byId.get(id).km2.toFixed(1))].join(','));
    rows.push(['grid_points', '', ...ids.map((id) => results.get(id).n)].join(','));
    rows.push(['rain_day', q(MODE_LABEL[mode]), ...ids.map(() => '')].join(','));
    rows.push(['source', '', ...ids.map((id) => q(results.get(id).method === 'image' ? 'Ventusky image (color matching)' : `Open-Meteo ${results.get(id).model}`))].join(','));
    // วิธีภาพ: แนบค่ารายภาพ 3 ชม. (เหมือน rain_3h_*.csv ของสคริปต์)
    const imgIds = ids.filter((id) => results.get(id).method === 'image');
    if (imgIds.length) {
      rows.push('', ['start (Thai)', 'end (Thai)', ...imgIds.map((id) => q(`${byId.get(id).name} 3h (mm)`))].join(','));
      const ref = results.get(imgIds[0]).frames3h;
      ref.forEach((f, i) => {
        const e = new Date(Date.parse(f.day + 'T00:00:00Z') + (f.h + 7) * 3600e3), s = new Date(e - 3 * 3600e3);
        const iso = (d) => d.toISOString().slice(0, 16).replace('T', ' ');
        rows.push([iso(s), iso(e), ...imgIds.map((id) => results.get(id).frames3h[i]?.v.toFixed(2) ?? '')].join(','));
      });
    }
    const blob = new Blob(['﻿' + rows.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = `areal_rain_${dStart.value}_${dEnd.value}_${mode}.csv`;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  // ---------- เริ่มต้น ----------
  setKind('province');
  applySource();
  renderChips();
  renderResults();
  requestAnimationFrame(() => setView(THAILAND));
})();
