/* OpenToon Studio - color palette + color panel UI */
(function (OT) {
  'use strict';
  const U = OT.util;

  /* ============================== Palette ============================== */
  const DEFAULT_SWATCHES = [
    '#000000', '#ffffff', '#7f7f7f', '#c0c0c0',
    '#e0533d', '#f0a93d', '#f5d33d', '#8fc740',
    '#52b669', '#3dc9b0', '#3d9be0', '#5566d8',
    '#9a5cd0', '#d05ca8', '#7a4a32', '#f2c8a0'
  ];

  class Palette {
    constructor(colors) {
      this.swatches = (colors || DEFAULT_SWATCHES).map((c, i) => ({
        name: 'Color ' + (i + 1), color: c
      }));
    }
    add(color) {
      this.swatches.push({ name: 'Color ' + (this.swatches.length + 1), color: color || '#ffffff' });
    }
    removeAt(i) { this.swatches.splice(i, 1); }
    serialize() { return this.swatches.map(s => ({ name: s.name, color: s.color })); }
    static load(arr) {
      const p = new Palette([]);
      p.swatches = (arr || []).map(s => ({ name: s.name || 'Color', color: s.color }));
      if (!p.swatches.length) return new Palette();
      return p;
    }
  }
  // Normalise any hex string ('#abc', 'AABBCC', ...) to '#rrggbb' lowercase.
  function normHex(c) {
    c = String(c || '').trim();
    if (c[0] !== '#') c = '#' + c;
    const rgb = U.hexToRgb(c);
    return U.rgbToHex(rgb.r, rgb.g, rgb.b);
  }
  // Parse palette text from a .gpl / .json / plain hex-list file -> [hex,...].
  Palette.parseText = function (text) {
    text = String(text || '');
    const out = [], seen = {};
    const push = h => { if (h && !seen[h]) { seen[h] = 1; out.push(h); } };
    const t = text.trim();
    // JSON: ["#rrggbb",...] | [{color}] | {colors:[...]}
    if (t[0] === '[' || t[0] === '{') {
      try {
        let j = JSON.parse(t);
        if (j && !Array.isArray(j) && j.colors) j = j.colors;
        if (Array.isArray(j)) {
          for (const e of j) {
            const c = typeof e === 'string' ? e : (e && e.color);
            if (c && /^#?[0-9a-f]{3}([0-9a-f]{3})?$/i.test(String(c).trim())) push(normHex(c));
          }
        }
        if (out.length) return out;
      } catch (e) { /* not JSON -- scan as text */ }
    }
    // GIMP .gpl: "R G B<TAB>name"
    if (/GIMP Palette/i.test(text)) {
      text.split(/\r?\n/).forEach(line => {
        const m = line.match(/^\s*(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})/);
        if (m) push(U.rgbToHex(+m[1], +m[2], +m[3]));
      });
      if (out.length) return out;
    }
    // plain hex, one per line (.txt / .hex)
    text.split(/\r?\n/).forEach(line => {
      if (/^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(line.trim())) push(normHex(line.trim()));
    });
    // any remaining #rrggbb / #rgb tokens embedded in the text
    (text.match(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g) || []).forEach(h => push(normHex(h)));
    return out;
  };
  // Serialise a palette to a GIMP .gpl file (importable by most paint apps).
  Palette.toGPL = function (swatches, name) {
    let s = 'GIMP Palette\nName: ' + (name || 'OpenToon') + '\nColumns: 8\n#\n';
    (swatches || []).forEach((sw, i) => {
      const rgb = U.hexToRgb(sw.color);
      const p = n => String(U.clamp(Math.round(n), 0, 255)).padStart(3, ' ');
      s += p(rgb.r) + ' ' + p(rgb.g) + ' ' + p(rgb.b) + '\t' + (sw.name || ('Color ' + (i + 1))) + '\n';
    });
    return s;
  };
  Palette.DEFAULTS = DEFAULT_SWATCHES.slice();
  OT.Palette = Palette;

  /* ============================== ColorPanel ============================== */
  class ColorPanel {
    constructor(app, root) {
      this.app = app;
      this.root = root;
      this.h = 0; this.s = 1; this.v = 1;
      this.selIndex = -1;
      this._build();
      this.setFromHex(app.color, true);
      app.on('colorchange', hex => { if (hex !== this._lastEmit) this.setFromHex(hex, true); });
      app.on('palettechange', () => this._renderSwatches());
    }

    _build() {
      const r = this.root;
      r.innerHTML = '';
      r.appendChild(U.el('div', { class: 'panel-head' }, ['Colour']));
      const body = U.el('div', { class: 'panel-body' });
      r.appendChild(body);

      // SV box
      this.sv = U.el('div', { class: 'sv-box' });
      this.svCursor = U.el('div', { class: 'sv-cursor' });
      this.sv.appendChild(this.svCursor);
      body.appendChild(this.sv);

      // Hue bar
      this.hue = U.el('div', { class: 'hue-bar' });
      this.hueCursor = U.el('div', { class: 'hue-cursor' });
      this.hue.appendChild(this.hueCursor);
      body.appendChild(this.hue);

      // chip + hex
      this.chipInner = U.el('div');
      const chip = U.el('div', { class: 'color-chip' }, [this.chipInner]);
      this.hexIn = U.el('input', { class: 'hex-input', type: 'text', spellcheck: 'false' });
      this.hexIn.addEventListener('change', () => {
        const v = this.hexIn.value.trim();
        if (/^#?[0-9a-fA-F]{3}$|^#?[0-9a-fA-F]{6}$/.test(v)) {
          this.setFromHex(v[0] === '#' ? v : '#' + v);
          this._commit();
        } else this._syncHex();
      });
      body.appendChild(U.el('div', { class: 'color-row' }, [chip, this.hexIn]));

      // swatches
      const palMenu = U.el('button', {
        class: 'icon-btn', title: 'Palette options — import / export / library',
        html: U.svg('<circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/>')
      });
      palMenu.addEventListener('click', e => { e.stopPropagation(); this._paletteMenu(e); });
      body.appendChild(U.el('div', { class: 'panel-subhead palette-head' }, [
        U.el('span', {}, ['Palette']), palMenu
      ]));
      this.swWrap = U.el('div', { class: 'swatches' });
      body.appendChild(this.swWrap);
      this._renderSwatches();

      this._bindDrag(this.sv, (x, y) => {
        this.s = U.clamp(x, 0, 1);
        this.v = 1 - U.clamp(y, 0, 1);
        this._apply(); this._commit();
      });
      this._bindDrag(this.hue, (x) => {
        this.h = U.clamp(x, 0, 1) * 360;
        this._apply(); this._commit();
      });
    }

    _bindDrag(elem, fn) {
      const move = e => {
        const rc = elem.getBoundingClientRect();
        fn((e.clientX - rc.left) / rc.width, (e.clientY - rc.top) / rc.height);
      };
      elem.addEventListener('pointerdown', e => {
        elem.setPointerCapture(e.pointerId);
        move(e);
        const mv = ev => move(ev);
        const up = ev => {
          elem.releasePointerCapture(e.pointerId);
          elem.removeEventListener('pointermove', mv);
          elem.removeEventListener('pointerup', up);
        };
        elem.addEventListener('pointermove', mv);
        elem.addEventListener('pointerup', up);
      });
    }

    _renderSwatches() {
      const p = this.app.palette;
      this.swWrap.innerHTML = '';
      p.swatches.forEach((s, i) => {
        const el = U.el('div', {
          class: 'swatch' + (i === this.selIndex ? ' sel' : ''),
          title: s.name + '  ' + s.color,
          style: { background: s.color }
        });
        el.addEventListener('click', () => {
          this.selIndex = i;
          this.setFromHex(s.color);
          this._commit();
          this._renderSwatches();
        });
        el.addEventListener('contextmenu', e => {
          e.preventDefault();
          if (p.swatches.length > 1) { p.removeAt(i); this.app.emit('palettechange'); }
        });
        this.swWrap.appendChild(el);
      });
      const add = U.el('div', { class: 'swatch add', title: 'Add current colour' }, ['+']);
      add.addEventListener('click', () => {
        p.add(this.app.color);
        this.app.emit('palettechange');
      });
      this.swWrap.appendChild(add);
    }

    _paletteMenu(e) {
      const a = this.app;
      a.ui.contextMenu(e.clientX, e.clientY, [
        {
          label: 'Import Palette File…',
          fn: () => a._pickFile('.gpl,.txt,.json,.otpal,.hex,.css', f => a.importPaletteFile(f))
        },
        { label: 'Export Palette (.gpl)…', fn: () => a.exportPalette() },
        { sep: 1 },
        { label: 'Save Palette to Library…', fn: () => a.ui.savePaletteDialog() },
        { label: 'Load Palette from Library…', fn: () => a.ui.loadPaletteDialog() },
        { sep: 1 },
        { label: 'Reset to Default Palette', fn: () => a.replacePalette(OT.Palette.DEFAULTS.slice()) }
      ]);
    }

    setFromHex(hex, silent) {
      const rgb = U.hexToRgb(hex);
      const hsv = U.rgbToHsv(rgb.r, rgb.g, rgb.b);
      // keep hue stable for grays
      if (hsv.s > 0.001) this.h = hsv.h;
      this.s = hsv.s; this.v = hsv.v;
      this._apply(silent);
    }

    _apply(silent) {
      const rgb = U.hsvToRgb(this.h, this.s, this.v);
      const hex = U.rgbToHex(rgb.r, rgb.g, rgb.b);
      this.sv.style.background =
        'linear-gradient(to top,#000,transparent),' +
        'linear-gradient(to right,#fff,hsl(' + this.h + ',100%,50%))';
      this.svCursor.style.left = (this.s * 100) + '%';
      this.svCursor.style.top = ((1 - this.v) * 100) + '%';
      this.hueCursor.style.left = (this.h / 360 * 100) + '%';
      this.chipInner.style.background = hex;
      this.hexIn.value = hex;
      this._current = hex;
      if (!silent) this._commit();
    }
    _syncHex() { this.hexIn.value = this._current; }
    _commit() {
      this._lastEmit = this._current;
      this.app.setColor(this._current);
    }
  }
  OT.ColorPanel = ColorPanel;

})(window.OT);
