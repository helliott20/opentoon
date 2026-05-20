/* OpenToon Studio - UI shell: menus, toolbar, panels, dialogs */
(function (OT) {
  'use strict';
  const U = OT.util;
  const el = U.el;

  const TOOL_ICON = {
    select: '<path d="M5 3l15 8-7 1.6L11 20z"/>',
    lasso: '<path d="M7 22a5 5 0 0 1-2-4"/><path d="M3.3 14A6.8 6.8 0 0 1 2 10c0-4.4 4.5-8 10-8s10 3.6 10 8-4.5 8-10 8a12 12 0 0 1-5-1"/><circle cx="5" cy="16" r="2"/>',
    transform: '<rect x="6" y="6" width="12" height="12"/><circle cx="6" cy="6" r="2.2"/><circle cx="18" cy="6" r="2.2"/><circle cx="6" cy="18" r="2.2"/><circle cx="18" cy="18" r="2.2"/>',
    brush: '<path d="M4 21c3.2 0 5-1.8 5-5l-3-3c-3.2 0-5 1.8-5 5z"/><path d="M8 13L19 2.2a2 2 0 0 1 3 3L11 16z"/>',
    pencil: '<path d="M4 20l4-1L19 8l-3-3L5 16z"/><path d="M14 6l3 3"/>',
    eraser: '<path d="M7 21l-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M21 21H7"/><path d="M5 11l9 9"/>',
    fill: '<path d="M11 3l8 8-7.5 7.5L4 11z"/><path d="M9 5l-5 6"/><path d="M20 13c0 0 2.4 3 2.4 4.8a2.4 2.4 0 1 1-4.8 0c0-1.8 2.4-4.8 2.4-4.8z"/>',
    eyedropper: '<path d="M3 21l2-5 9-9 3 3-9 9z"/><path d="M14 4.5l5 5"/><circle cx="18" cy="6" r="2.6"/>',
    rect: '<rect x="4" y="6" width="16" height="12" rx="1"/>',
    ellipse: '<ellipse cx="12" cy="12" rx="9" ry="6.6"/>',
    line: '<path d="M5 19L19 5"/>',
    hand: '<path d="M8 12V5.5a1.6 1.6 0 0 1 3.2 0V11m0-1V4a1.6 1.6 0 0 1 3.2 0v7m0-2V6a1.6 1.6 0 0 1 3.2 0v8.5c0 4-3 6.5-7 6.5-2.6 0-4.6-1.4-6-3.6l-2.4-4a1.7 1.7 0 0 1 2.9-1.8L8 13"/>',
    zoom: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-5.5-5.5M11 8v6M8 11h6"/>'
  };
  const TOOL_LIST = [
    ['select', 'V'], ['lasso', 'Q'], ['transform', 'A'],
    ['sep'], ['brush', 'B'], ['pencil', 'N'], ['eraser', 'E'],
    ['sep'], ['fill', 'G'], ['eyedropper', 'I'],
    ['sep'], ['rect', 'R'], ['ellipse', 'O'], ['line', 'L'],
    ['sep'], ['hand', 'H'], ['zoom', 'Z']
  ];
  const TOOL_NAME = {
    select: 'Select Pixels', lasso: 'Lasso Select', transform: 'Transform Layer (Cut-out)',
    brush: 'Brush', pencil: 'Pencil', eraser: 'Eraser',
    fill: 'Paint Bucket', eyedropper: 'Eyedropper', rect: 'Rectangle',
    ellipse: 'Ellipse', line: 'Line', hand: 'Pan', zoom: 'Zoom'
  };

  class UI {
    constructor(app) {
      this.app = app;
      this._buildMenu();
      this._buildToolbar();
      this._buildToolOpts();
      this._buildLayers();
      this._buildViewbar();
      this._buildStatus();
      this._installSidebarResize();
      this._installPanelCollapse();

      app.on('toolchange', () => { this._refreshTool(); this._buildToolOpts(); });
      app.on('layerschange', () => this._refreshLayers());
      app.on('layerselect', () => { this._refreshLayers(); this._buildToolOpts(); });
      app.on('celchange', () => this._refreshLayers());
      app.on('framechange', () => this._refreshLayers());
      app.on('render', () => this._refreshViewbar());
      app.on('projectchange', () => {
        this._refreshViewbar();
        if (this.app.tools.active.name === 'transform') this._buildToolOpts();
      });
    }

    /* ============================ menu bar ============================ */
    _fileMenu() {
      const a = this.app;
      const rows = [
        { label: 'New Project…', sc: 'Ctrl+N', fn: () => this.newProjectDialog() },
        { label: 'Open Project…', sc: 'Ctrl+O', fn: () => a.openProject() },
        { label: 'Save Project', sc: 'Ctrl+S', fn: () => a.saveProject() },
        { label: 'Save Project As…', sc: 'Ctrl+Shift+S', fn: () => a.saveProject(true) }
      ];
      // Recent files only make sense on desktop, where projects have real paths.
      if (window.OpenToonDesktop) {
        rows.push({ label: 'Save Incremental Copy', fn: () => a.saveIncrement() });
        rows.push({ label: 'Revert to Saved', fn: () => a.revertProject(), enabled: !!a.projectPath });
        rows.push({ sep: 1 });
        const recent = a.recentFiles || [];
        if (recent.length) {
          recent.slice(0, 6).forEach(p => {
            const base = p.split(/[\\/]/).pop();
            rows.push({
              label: base.length > 34 ? base.slice(0, 33) + '…' : base,
              title: p, fn: () => a.openRecent(p)
            });
          });
          rows.push({ label: 'Clear Recent Files', fn: () => a.clearRecent() });
        } else {
          rows.push({ label: 'No Recent Files', enabled: false });
        }
      }
      rows.push(
        { sep: 1 },
        { label: 'Import Image as Layer…', fn: () => a.importImage() },
        { label: 'Import Video…', fn: () => a._pickFile('video/*', f => a.importVideo(f)) },
        { label: 'Import Audio…', fn: () => a._pickFile('audio/*', f => a.importAudio(f)) },
        { label: 'Remove Audio Track', fn: () => a.removeAudio() },
        { sep: 1 },
        { label: 'Export Animated GIF…', fn: () => this.exportDialog('gif') },
        { label: 'Export Video (MP4)…', fn: () => this.exportDialog('mp4') },
        { label: 'Export Video (WebM)…', fn: () => this.exportDialog('webm') },
        { label: 'Export PNG Sequence…', fn: () => this.exportDialog('sequence') },
        { label: 'Export Current Frame…', fn: () => this.exportDialog('frame') }
      );
      return rows;
    }
    _menuData() {
      const a = this.app;
      return [
        ['File', this._fileMenu()],
        ['Edit', [
          { label: 'Undo', sc: 'Ctrl+Z', fn: () => a.undo(), enabled: a.history.canUndo() },
          { label: 'Redo', sc: 'Ctrl+Y', fn: () => a.redo(), enabled: a.history.canRedo() },
          { sep: 1 },
          { label: 'Copy Drawing', sc: 'Ctrl+C', fn: () => a.copyDrawing() },
          { label: 'Cut Drawing', sc: 'Ctrl+X', fn: () => a.cutDrawing() },
          { label: 'Paste Drawing', sc: 'Ctrl+V', fn: () => a.pasteDrawing() },
          { sep: 1 },
          { label: 'Clear Drawing', sc: 'Del', fn: () => a.clearDrawing() },
          { label: 'Select All', sc: 'Ctrl+A', fn: () => a.selectAll() },
          { sep: 1 },
          { label: 'Project Settings…', fn: () => this.projectSettings() },
          { label: 'Pen Pressure…', fn: () => this.penDialog() }
        ]],
        ['View', [
          { label: 'Fit to Camera', sc: 'F', fn: () => a.stage.fitToCamera() },
          { label: 'Zoom In', sc: '+', fn: () => a.stage.zoomAt(innerWidth / 2, innerHeight / 2, 1.25) },
          { label: 'Zoom Out', sc: '-', fn: () => a.stage.zoomAt(innerWidth / 2, innerHeight / 2, 0.8) },
          { label: 'Reset Zoom 100%', fn: () => this._zoom100() },
          { sep: 1 },
          { label: 'Rotate Canvas Left 15°', fn: () => a.rotateView(-15) },
          { label: 'Rotate Canvas Right 15°', fn: () => a.rotateView(15) },
          { label: 'Reset Rotation', fn: () => a.resetRotation() },
          { sep: 1 },
          { label: (a.cleanView ? '✓ ' : '') + 'Clean Canvas (hide panels)', sc: 'Tab', fn: () => a.toggleCleanView() },
          { sep: 1 },
          { label: 'Layout: Drawing', fn: () => a.applyWorkspace('drawing') },
          { label: 'Layout: Animation', fn: () => a.applyWorkspace('animation') },
          { label: 'Layout: Compact', fn: () => a.applyWorkspace('compact') },
          { label: 'Reset Layout', fn: () => a.applyWorkspace('reset') },
          { sep: 1 },
          {
            label: 'Drawing Window (Pen Display)…',
            fn: () => { if (a.penCast) a.penCast.open(); },
            enabled: !!(a.penCast && a.penCast.available())
          },
          { sep: 1 },
          { label: (a.showCamera ? '✓ ' : '') + 'Camera Guide', fn: () => a.toggleCamera() },
          { label: (a.onion.on ? '✓ ' : '') + 'Onion Skin', fn: () => a.toggleOnion() },
          { label: 'Onion Skin Settings…', fn: () => this.onionDialog() },
          { sep: 1 },
          { label: (a.stage && a.stage.flipH ? '✓ ' : '') + 'Flip View Horizontal', sc: 'M', fn: () => a.toggleFlipH() },
          { label: (a.stage && a.stage.flipV ? '✓ ' : '') + 'Flip View Vertical', fn: () => a.toggleFlipV() },
          { label: (a.grid && a.grid.on ? '✓ ' : '') + 'Grid', fn: () => a.toggleGrid() },
          { label: (a.symmetry && a.symmetry.on ? '✓ ' : '') + 'Symmetry / Mirror Drawing', fn: () => a.toggleSymmetry() },
          { label: 'Grid, Guides & Symmetry…', fn: () => this.gridDialog() }
        ]],
        ['Animation', [
          { label: 'Play / Stop', sc: 'Enter', fn: () => a.playback.toggle() },
          { label: 'Next Frame', sc: '.', fn: () => a.playback.step(1) },
          { label: 'Previous Frame', sc: ',', fn: () => a.playback.step(-1) },
          { sep: 1 },
          { label: 'Set Playback In Point', fn: () => a.setPlayIn() },
          { label: 'Set Playback Out Point', fn: () => a.setPlayOut() },
          { label: 'Clear Playback Range', fn: () => a.clearPlayRange() },
          { sep: 1 },
          { label: 'New Drawing', fn: () => a.newDrawing() },
          { label: 'Duplicate Drawing', fn: () => a.duplicateDrawing() },
          { label: 'Extend Exposure', fn: () => a.extendExposure() },
          { label: 'Clear Exposure', fn: () => a.clearExposure() },
          { sep: 1 },
          { label: 'Insert Frame', fn: () => a.insertFrame() },
          { label: 'Remove Frame', fn: () => a.removeFrame() }
        ]],
        ['Layer', [
          { label: 'Add Vector Layer', fn: () => a.addLayer('vector') },
          { label: 'Add Bitmap Layer', fn: () => a.addLayer('drawing') },
          { label: 'Duplicate Layer', fn: () => a.duplicateLayer(a.activeLayer()) },
          { label: 'Delete Layer', fn: () => a.deleteLayer(a.activeLayer()) },
          { sep: 1 },
          { label: 'Move Layer Up', fn: () => a.moveLayer(a.activeLayer(), 1) },
          { label: 'Move Layer Down', fn: () => a.moveLayer(a.activeLayer(), -1) },
          { label: 'Merge Down', fn: () => a.mergeDown(a.activeLayer()) },
          { sep: 1 },
          { label: 'Set Transform Keyframe', fn: () => a.setLayerKeyHere() },
          { label: 'Reset Layer Transform', fn: () => a.resetLayerTransform(a.activeLayer()) },
          { sep: 1 },
          { label: 'Auto-Shade Layer (Light & Shade)…', fn: () => this.shadeDialog() }
        ]],
        ['Camera', [
          { label: 'Add / Update Camera Keyframe', fn: () => a.addCameraKey() },
          { label: 'Camera Editor…', fn: () => this.cameraDialog() },
          { label: 'Clear Camera Keyframes', fn: () => a.clearCameraKeys() }
        ]],
        ['Help', [
          { label: 'Keyboard Shortcuts…', fn: () => this.shortcutsDialog() },
          { label: 'Scripting Console…', fn: () => this.scriptConsole() },
          { label: 'About OpenToon', fn: () => this.aboutDialog() }
        ]]
      ];
    }
    _buildMenu() {
      const bar = document.getElementById('menubar');
      bar.innerHTML = '';
      // brand cell: 3-ring mark + wordmark; the centre ring uses currentColor
      // so it follows the .menu-title { color: var(--cream) } rule
      bar.appendChild(el('div', {
        class: 'menu-title', 'aria-label': 'OpenToon',
        html:
          '<svg class="menu-title-mark" viewBox="0 0 200 200" fill="none" aria-hidden="true">' +
          '<circle cx="85" cy="100" r="68" stroke="#DD5038" stroke-width="17" stroke-linecap="round" opacity="0.55"/>' +
          '<circle cx="115" cy="100" r="68" stroke="#54B06A" stroke-width="17" stroke-linecap="round" opacity="0.55"/>' +
          '<circle cx="100" cy="100" r="68" stroke="currentColor" stroke-width="17" stroke-linecap="round"/>' +
          '</svg>' +
          '<span class="menu-title-text"><span class="open">Open</span><span class="toon">Toon</span></span>'
      }));
      this._menuData().forEach(([name]) => {
        const item = el('div', { class: 'menu-item' }, [name]);
        item.addEventListener('click', e => {
          e.stopPropagation();
          if (item.classList.contains('open')) { this._closeMenus(); return; }
          this._openMenu(item, name);
        });
        item.addEventListener('mouseenter', () => {
          if (bar.querySelector('.menu-item.open') && !item.classList.contains('open'))
            this._openMenu(item, name);
        });
        bar.appendChild(item);
      });
      // hooked once -- _buildMenu re-runs whenever the recent-files list changes
      if (!this._menuClickHooked) {
        this._menuClickHooked = true;
        document.addEventListener('click', () => this._closeMenus());
      }
    }
    _closeMenus() {
      document.querySelectorAll('.menu-item.open').forEach(m => m.classList.remove('open'));
      document.querySelectorAll('.menu-pop').forEach(p => p.remove());
    }
    _openMenu(item, name) {
      this._closeMenus();
      item.classList.add('open');
      const data = this._menuData().find(m => m[0] === name)[1];
      const pop = el('div', { class: 'menu-pop' });
      data.forEach(row => {
        if (row.sep) { pop.appendChild(el('div', { class: 'menu-sep' })); return; }
        const r = el('div', {
          class: 'menu-row' + (row.enabled === false ? ' disabled' : '')
        }, [el('span', {}, [row.label]), el('span', { class: 'sc' }, [row.sc || ''])]);
        if (row.title) r.title = row.title;
        r.addEventListener('click', e => {
          e.stopPropagation(); this._closeMenus();
          try { row.fn(); } catch (err) { console.error(err); this.status('Error: ' + err.message); }
        });
        pop.appendChild(r);
      });
      item.appendChild(pop);
    }

    /* ============================ toolbar ============================ */
    _buildToolbar() {
      const tb = document.getElementById('toolbar');
      tb.innerHTML = '';
      this.toolBtns = {};
      TOOL_LIST.forEach(([name, key]) => {
        if (name === 'sep') { tb.appendChild(el('div', { class: 'tool-sep' })); return; }
        const b = el('button', {
          class: 'tool-btn',
          title: TOOL_NAME[name] + '  (' + key + ')',
          html: U.svg(TOOL_ICON[name])
        });
        b.addEventListener('click', () => this.app.tools.select(name));
        this.toolBtns[name] = b;
        tb.appendChild(b);
      });
      this._refreshTool();
    }
    _refreshTool() {
      const active = this.app.tools.active.name;
      for (const n in this.toolBtns) this.toolBtns[n].classList.toggle('active', n === active);
    }

    /* ============================ tool options ============================ */
    _row(label, control) {
      return el('div', { class: 'opt-row' }, [el('label', {}, [label]), control]);
    }
    _slider(min, max, step, val, onInput) {
      const wrap = el('div', { class: 'opt-row' });
      const valEl = el('span', { class: 'val', text: U.round(val, 2) });
      const range = el('input', { type: 'range', min, max, step, value: val });
      range.addEventListener('input', () => {
        const v = parseFloat(range.value);
        valEl.textContent = U.round(v, 2);
        onInput(v);
      });
      wrap._range = range; wrap._val = valEl;
      return { wrap, range, valEl };
    }
    _sliderRow(label, min, max, step, val, onInput) {
      const s = this._slider(min, max, step, val, onInput);
      return el('div', { class: 'opt-row' }, [
        el('label', {}, [label]), s.range, s.valEl
      ]);
    }
    _check(label, val, onChange) {
      const cb = el('input', { type: 'checkbox' });
      cb.checked = val;
      cb.addEventListener('change', () => onChange(cb.checked));
      const row = el('label', { class: 'chk-row' }, [cb, label]);
      return row;
    }
    _buildToolOpts() {
      const p = document.getElementById('toolopts');
      const a = this.app, s = a.settings, t = a.tools.active.name;
      p.innerHTML = '';
      p.appendChild(el('div', { class: 'panel-head' }, [TOOL_NAME[t] || t]));
      const body = el('div', { class: 'panel-body' });
      p.appendChild(body);

      const isVec = a.activeLayer() && a.activeLayer().type === 'vector';
      if (t === 'brush') {
        body.appendChild(this._sliderRow('Size', 1, 250, 1, s.brushSize, v => s.brushSize = v));
        body.appendChild(this._sliderRow('Opacity', 0.05, 1, 0.01, s.brushOpacity, v => s.brushOpacity = v));
        body.appendChild(this._sliderRow('Smoothing', 0, 1, 0.01, s.smoothing, v => s.smoothing = v));
        if (isVec) {
          body.appendChild(this._sliderRow('Connect', 0, 50, 1, s.snapDist, v => s.snapDist = v));
          body.appendChild(this._check('Mirror (symmetry)', a.symmetry.on,
            v => { a.symmetry.on = v; a.emit('render'); }));
        }
      } else if (t === 'pencil') {
        body.appendChild(this._sliderRow('Size', 1, 60, 1, s.pencilSize, v => s.pencilSize = v));
        body.appendChild(this._sliderRow('Opacity', 0.05, 1, 0.01, s.pencilOpacity, v => s.pencilOpacity = v));
        body.appendChild(this._sliderRow('Smoothing', 0, 1, 0.01, s.smoothing, v => s.smoothing = v));
        if (isVec) {
          body.appendChild(this._sliderRow('Connect', 0, 50, 1, s.snapDist, v => s.snapDist = v));
          body.appendChild(this._check('Mirror (symmetry)', a.symmetry.on,
            v => { a.symmetry.on = v; a.emit('render'); }));
        }
      } else if (t === 'eraser') {
        body.appendChild(this._sliderRow('Size', 1, 300, 1, s.eraserSize, v => s.eraserSize = v));
        body.appendChild(this._sliderRow('Opacity', 0.05, 1, 0.01, s.eraserOpacity, v => s.eraserOpacity = v));
      } else if (t === 'fill') {
        if (isVec) {
          body.appendChild(this._sliderRow('Gap Closing', 0, 30, 1, s.fillGap, v => s.fillGap = v));
          body.appendChild(el('div', { class: 'chk-row', text: 'Hover to highlight the enclosed area, click to fill it.' }));
        } else {
          body.appendChild(this._sliderRow('Tolerance', 0, 120, 1, s.fillTolerance, v => s.fillTolerance = v));
          body.appendChild(this._check('Contiguous (connected area)', s.fillContiguous, v => s.fillContiguous = v));
        }
      } else if (t === 'rect' || t === 'ellipse') {
        body.appendChild(this._check('Fill', s.shapeFill, v => s.shapeFill = v));
        body.appendChild(this._check('Stroke', s.shapeStroke, v => s.shapeStroke = v));
        body.appendChild(this._sliderRow('Line', 1, 60, 1, s.shapeStrokeWidth, v => s.shapeStrokeWidth = v));
      } else if (t === 'line') {
        body.appendChild(this._sliderRow('Line', 1, 60, 1, s.shapeStrokeWidth, v => s.shapeStrokeWidth = v));
      } else if (t === 'select') {
        const mk = (lbl, fn) => {
          const b = el('button', { class: 'btn', text: lbl, style: { padding: '5px 8px' } });
          b.addEventListener('click', fn);
          return b;
        };
        body.appendChild(el('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } }, [
          mk('Flip H', () => a.flipSelection('h')),
          mk('Flip V', () => a.flipSelection('v')),
          mk('Delete', () => a.deleteSelection())
        ]));
        body.appendChild(el('div', { class: 'chk-row', text: 'Drag a box, then move / scale / rotate.' }));
      } else if (t === 'lasso') {
        const del = el('button', { class: 'btn', text: 'Delete Selection', style: { padding: '5px 8px' } });
        del.addEventListener('click', () => a.deleteSelection());
        body.appendChild(el('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } }, [del]));
        body.appendChild(el('div', { class: 'chk-row', text: 'Draw a freeform loop to grab strokes or a pixel region, then drag it. Esc drops it.' }));
      } else if (t === 'transform') {
        const mk = (lbl, fn) => {
          const b = el('button', { class: 'btn', text: lbl, style: { padding: '5px 8px' } });
          b.addEventListener('click', fn);
          return b;
        };
        body.appendChild(el('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } }, [
          mk('Set Keyframe', () => a.setLayerKeyHere()),
          mk('Reset Layer', () => a.resetLayerTransform(a.activeLayer()))
        ]));
        const layer = a.activeLayer();
        const kc = layer && layer.transform ? layer.transform.keyframes.length : 0;
        body.appendChild(el('div', { class: 'chk-row', text: kc + ' transform keyframe' + (kc === 1 ? '' : 's') }));
        body.appendChild(el('div', { class: 'chk-row', text: 'Drag the layer to animate position / scale / rotation.' }));
      } else {
        body.appendChild(el('div', { class: 'chk-row', text: 'Drag in the canvas to use this tool.' }));
      }
      if (t === 'brush' || t === 'pencil' || t === 'eraser')
        body.appendChild(this._brushPresetsUI());
    }

    // Saved brush presets — chips that apply a named tool configuration.
    _brushPresetsUI() {
      const a = this.app;
      const wrap = el('div', {
        style: { display: 'flex', flexDirection: 'column', gap: '5px', marginTop: '4px' }
      });
      wrap.appendChild(el('div', { class: 'panel-subhead', text: 'Brushes' }));
      const chips = el('div', { class: 'preset-row' });
      (a.brushPresets || []).forEach(p => {
        const chip = el('button', {
          class: 'preset-chip', text: p.name,
          title: p.name + ' — ' + p.tool + ' · ' + U.round(p.size, 0) + 'px'
        });
        chip.addEventListener('click', () => a.applyBrushPreset(p.id));
        chip.addEventListener('contextmenu', e => {
          e.preventDefault();
          this.contextMenu(e.clientX, e.clientY, [
            { label: 'Delete "' + p.name + '"', fn: () => a.deleteBrushPreset(p.id) },
            { sep: 1 },
            { label: 'Reset Brushes to Defaults', fn: () => a.resetBrushPresets() }
          ]);
        });
        chips.appendChild(chip);
      });
      const add = el('button', {
        class: 'preset-chip add', text: '+ Save',
        title: 'Save the current tool settings as a brush'
      });
      add.addEventListener('click', () => this._saveBrushDialog());
      chips.appendChild(add);
      wrap.appendChild(chips);
      return wrap;
    }
    _saveBrushDialog() {
      const input = el('input', { type: 'text', value: 'My Brush' });
      const body = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '9px' } }, [
        el('div', {
          class: 'chk-row',
          text: 'Save the current ' + this.app.tools.active.name +
            ' size, opacity and smoothing as a reusable brush.'
        }),
        this._field('Brush name', input)
      ]);
      this.modal('Save Brush', body, [
        { label: 'Cancel' },
        { label: 'Save', primary: true, fn: () => this.app.saveBrushPreset(input.value) }
      ]);
    }

    /* ============================ layers ============================ */
    _buildLayers() {
      const p = document.getElementById('layerpanel');
      p.innerHTML = '';
      const addBtn = el('button', { class: 'icon-btn', title: 'Add layer', html: U.svg('<path d="M12 5v14M5 12h14"/>') });
      addBtn.addEventListener('click', () => this.app.addLayer());
      const head = el('div', { class: 'panel-head' }, [el('span', {}, ['Layers']), addBtn]);
      p.appendChild(head);
      this.layerBody = el('div', { class: 'panel-body' });
      p.appendChild(this.layerBody);
      this._refreshLayers();
    }
    _refreshLayers() {
      if (!this.layerBody) return;
      const a = this.app, L = a.project.layers;
      this.layerBody.innerHTML = '';
      for (let i = L.length - 1; i >= 0; i--) {
        const layer = L[i];
        const sel = layer === a.activeLayer();
        const item = el('div', { class: 'layer-item' + (sel ? ' sel' : '') });

        const eye = el('button', {
          class: 'icon-btn ' + (layer.visible ? 'on' : 'off'),
          title: 'Visibility',
          html: U.svg(layer.visible
            ? '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>'
            : '<path d="M4 4l16 16"/><path d="M2 12s4-7 10-7c2 0 3.6.6 5 1.4M22 12s-4 7-10 7c-2 0-3.7-.6-5-1.5"/>')
        });
        eye.addEventListener('click', e => {
          e.stopPropagation(); layer.visible = !layer.visible;
          a.emit('layerschange'); a.emit('render');
        });

        const lock = el('button', {
          class: 'icon-btn ' + (layer.locked ? 'on' : 'off'),
          title: 'Lock',
          html: U.svg(layer.locked
            ? '<rect x="5" y="11" width="14" height="9" rx="1.5"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>'
            : '<rect x="5" y="11" width="14" height="9" rx="1.5"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/>')
        });
        lock.addEventListener('click', e => {
          e.stopPropagation(); layer.locked = !layer.locked; a.emit('layerschange');
        });

        const thumb = el('canvas', { class: 'layer-thumb' });
        thumb.width = 60; thumb.height = 44;
        const tx = thumb.getContext('2d');
        tx.fillStyle = a.project.bg; tx.fillRect(0, 0, 60, 44);
        const cel = layer.celAt(a.frame);
        if (cel) tx.drawImage(cel.canvas, 0, 0, 60, 44);
        else if (layer.type === 'video' && layer.videoEl && layer.videoEl.readyState >= 2)
          try { tx.drawImage(layer.videoEl, 0, 0, 60, 44); } catch (e) {}

        const name = el('input', { class: 'lname', value: layer.name });
        name.addEventListener('change', () => { layer.name = name.value || 'Layer'; a.emit('layerschange'); });
        name.addEventListener('click', e => e.stopPropagation());

        const ltype = layer.type === 'vector' ? 'VEC' : layer.type === 'video' ? 'VID' : 'BMP';
        const tag = el('div', {
          class: 'ltype', text: ltype,
          title: ltype === 'VEC' ? 'Vector layer' : ltype === 'VID' ? 'Video layer' : 'Bitmap layer'
        });
        item.appendChild(eye);
        item.appendChild(lock);
        item.appendChild(thumb);
        item.appendChild(name);
        item.appendChild(tag);
        item.addEventListener('click', () => a.selectLayer(layer));
        item.addEventListener('contextmenu', e => {
          e.preventDefault();
          this.contextMenu(e.clientX, e.clientY, [
            { label: 'Duplicate Layer', fn: () => a.duplicateLayer(layer) },
            { label: 'Delete Layer', fn: () => a.deleteLayer(layer) },
            { sep: 1 },
            { label: 'Move Up', fn: () => a.moveLayer(layer, 1) },
            { label: 'Move Down', fn: () => a.moveLayer(layer, -1) },
            { label: 'Merge Down', fn: () => a.mergeDown(layer) }
          ]);
        });
        this.layerBody.appendChild(item);

        if (sel) {
          const op = this._slider(0, 1, 0.01, layer.opacity, v => {
            layer.opacity = v; a.emit('render');
          });
          this.layerBody.appendChild(el('div', { class: 'opt-row', style: { marginBottom: '4px' } }, [
            el('label', { style: { flex: '0 0 48px' } }, ['Opacity']), op.range, op.valEl
          ]));
        }
      }
    }

    /* ============================ viewbar ============================ */
    _buildViewbar() {
      const vb = document.getElementById('viewbar');
      vb.innerHTML = '';
      const a = this.app;
      const mk = (txt, fn, title) => {
        const b = el('button', { class: 'vb-btn', title: title || txt }, [txt]);
        b.addEventListener('click', fn);
        return b;
      };
      vb.appendChild(mk('−', () => a.stage.zoomAt(innerWidth / 2, innerHeight / 2, 0.8), 'Zoom out'));
      this.zoomLabel = el('span', { style: { minWidth: '46px', textAlign: 'center', color: '#d6d9de' } }, ['100%']);
      vb.appendChild(this.zoomLabel);
      vb.appendChild(mk('+', () => a.stage.zoomAt(innerWidth / 2, innerHeight / 2, 1.25), 'Zoom in'));
      vb.appendChild(mk('Fit', () => a.stage.fitToCamera(), 'Fit to camera (F)'));
      vb.appendChild(mk('100%', () => this._zoom100(), 'Reset zoom'));
      vb.appendChild(mk('⟲', () => a.rotateView(-15), 'Rotate canvas left'));
      this.rotLabel = mk('0°', () => a.resetRotation(), 'Reset canvas rotation');
      this.rotLabel.style.minWidth = '38px';
      vb.appendChild(this.rotLabel);
      vb.appendChild(mk('⟳', () => a.rotateView(15), 'Rotate canvas right'));
      vb.appendChild(el('div', { class: 'sp' }));
      this.camBtn = mk('Camera', () => a.toggleCamera(), 'Toggle camera guide');
      this.onionVB = mk('Onion', () => a.toggleOnion(), 'Toggle onion skin');
      this.gridBtn = mk('Grid', () => a.toggleGrid(), 'Toggle grid');
      this.flipHBtn = mk('Flip H', () => a.toggleFlipH(), 'Flip view horizontally (M)');
      this.flipVBtn = mk('Flip V', () => a.toggleFlipV(), 'Flip view vertically');
      vb.appendChild(this.camBtn);
      vb.appendChild(this.onionVB);
      vb.appendChild(this.gridBtn);
      vb.appendChild(this.flipHBtn);
      vb.appendChild(this.flipVBtn);
      this._refreshViewbar();
    }
    _zoom100() {
      const st = this.app.stage;
      st.zoomAt(innerWidth / 2, innerHeight / 2, 1 / st.view.zoom);
    }
    _refreshViewbar() {
      if (!this.zoomLabel || !this.app.stage) return;
      this.zoomLabel.textContent = Math.round(this.app.stage.view.zoom * 100) + '%';
      if (this.rotLabel)
        this.rotLabel.textContent = Math.round(this.app.stage.view.rot || 0) + '°';
      this.camBtn.classList.toggle('on', this.app.showCamera);
      this.onionVB.classList.toggle('on', this.app.onion.on);
      this.flipHBtn.classList.toggle('on', this.app.stage.flipH);
      this.flipVBtn.classList.toggle('on', this.app.stage.flipV);
      if (this.gridBtn) this.gridBtn.classList.toggle('on', this.app.grid && this.app.grid.on);
      if (this.coordEl) {
        this.zoomStat.textContent = Math.round(this.app.stage.view.zoom * 100) + '%';
      }
    }

    /* ============================ status bar ============================ */
    _buildStatus() {
      const sb = document.getElementById('statusbar');
      sb.innerHTML = '';
      this.msgEl = el('div', { class: 'st-msg', text: 'Ready' });
      this.coordEl = el('div', {}, ['0, 0']);
      this.zoomStat = el('div', {}, ['100%']);
      this.projEl = el('div', {});
      sb.appendChild(this.msgEl);
      sb.appendChild(el('div', {}, ['Pos: ', this.coordEl]));
      sb.appendChild(el('div', {}, ['Zoom: ', this.zoomStat]));
      sb.appendChild(this.projEl);
      this.refreshProjectInfo();
    }
    refreshProjectInfo() {
      const p = this.app.project;
      this.projEl.innerHTML = '<b>' + p.width + '×' + p.height + '</b> @ ' + p.fps + 'fps';
    }
    status(msg) {
      if (this.msgEl) this.msgEl.textContent = msg;
      clearTimeout(this._stTimer);
      this._stTimer = setTimeout(() => { if (this.msgEl) this.msgEl.textContent = 'Ready'; }, 4200);
    }
    setCoord(pt) {
      if (this.coordEl && pt) this.coordEl.textContent = Math.round(pt.x) + ', ' + Math.round(pt.y);
    }

    /* ============================ sidebar resize ============================ */
    // Drag the divider between the canvas and the panels to resize the sidebar.
    applySidebarWidth(w) {
      const sb = document.getElementById('sidebar');
      if (!sb) return;
      w = U.clamp(Math.round(w), 210, 480);
      sb.style.flex = '0 0 ' + w + 'px';
      sb.style.width = w + 'px';
      this.app.sidebarWidth = w;
    }
    applyPanelCollapse() {
      const ids = this.app.collapsedPanels || [];
      ['colorpanel', 'toolopts', 'layerpanel'].forEach(id => {
        const p = document.getElementById(id);
        if (p) p.classList.toggle('collapsed', ids.indexOf(id) >= 0);
      });
    }
    _installSidebarResize() {
      const res = document.getElementById('sidebar-resizer');
      const sb = document.getElementById('sidebar');
      if (!res || !sb) return;
      const a = this.app;
      if (a.sidebarWidth) this.applySidebarWidth(a.sidebarWidth);
      let drag = null;
      res.addEventListener('pointerdown', e => {
        drag = { x: e.clientX, w: sb.getBoundingClientRect().width };
        try { res.setPointerCapture(e.pointerId); } catch (_) {}
        e.preventDefault();
      });
      res.addEventListener('pointermove', e => {
        if (!drag) return;
        this.applySidebarWidth(drag.w + (drag.x - e.clientX));   // drag toward the canvas = wider
        if (a.stage) a.stage.resize();
      });
      const stop = () => { if (drag) { drag = null; a._savePrefs(); } };
      res.addEventListener('pointerup', stop);
      res.addEventListener('pointercancel', stop);
    }

    // Click a panel header to collapse it to just the header; state persists.
    _installPanelCollapse() {
      const sb = document.getElementById('sidebar');
      if (!sb) return;
      const a = this.app;
      this.applyPanelCollapse();
      sb.addEventListener('click', e => {
        const head = e.target.closest('.panel-head');
        if (!head || !sb.contains(head)) return;
        if (e.target.closest('button,input')) return;   // header controls aren't collapse hits
        const panel = head.closest('.panel');
        // only the panel's own top header collapses it -- not a sub-heading
        if (!panel || !panel.id || head.parentElement !== panel) return;
        panel.classList.toggle('collapsed');
        const set = {};
        (a.collapsedPanels || []).forEach(id => { set[id] = 1; });
        if (panel.classList.contains('collapsed')) set[panel.id] = 1;
        else delete set[panel.id];
        a.collapsedPanels = Object.keys(set);
        a._savePrefs();
      });
    }

    /* ============================ modal / context ============================ */
    contextMenu(x, y, items) {
      this._closeContext();
      const pop = el('div', { class: 'menu-pop', style: { left: x + 'px', top: y + 'px', position: 'fixed' } });
      items.forEach(it => {
        if (it.sep) { pop.appendChild(el('div', { class: 'menu-sep' })); return; }
        const r = el('div', { class: 'menu-row' }, [el('span', {}, [it.label])]);
        r.addEventListener('click', () => { this._closeContext(); it.fn(); });
        pop.appendChild(r);
      });
      const root = document.getElementById('modal-root');
      root.style.pointerEvents = 'auto';
      root.appendChild(pop);
      this._ctxPop = pop;
      // Close on a click outside the menu. This must ignore pointer-downs
      // *inside* the menu -- otherwise the menu is torn down on pointerdown
      // and the row's own click handler never gets to run.
      this._ctxClose = e => { if (!pop.contains(e.target)) this._closeContext(); };
      setTimeout(() => document.addEventListener('pointerdown', this._ctxClose), 0);
      const r = pop.getBoundingClientRect();
      if (r.right > innerWidth) pop.style.left = (innerWidth - r.width - 4) + 'px';
      if (r.bottom > innerHeight) pop.style.top = (innerHeight - r.height - 4) + 'px';
    }
    _closeContext() {
      if (this._ctxPop) { this._ctxPop.remove(); this._ctxPop = null; }
      if (this._ctxClose) {
        document.removeEventListener('pointerdown', this._ctxClose);
        this._ctxClose = null;
      }
      document.getElementById('modal-root').style.pointerEvents = 'none';
    }

    modal(title, bodyEl, buttons) {
      const root = document.getElementById('modal-root');
      root.style.pointerEvents = 'auto';
      const box = el('div', { class: 'modal' });
      // header with title + an X close button (right-aligned via flex)
      const closeBtn = el('button', {
        class: 'icon-btn modal-close', title: 'Close (Esc)',
        html: U.svg('<path d="M6 6l12 12M18 6L6 18"/>')
      });
      const head = el('div', { class: 'modal-head' }, [
        el('span', { class: 'modal-title' }, [title]),
        closeBtn
      ]);
      box.appendChild(head);
      const body = el('div', { class: 'modal-body' });
      body.appendChild(bodyEl);
      box.appendChild(body);
      const foot = el('div', { class: 'modal-foot' });
      const bg = el('div', { class: 'modal-bg' }, [box]);
      // remember whatever was focused so we can restore it on close
      const prevFocus = document.activeElement;
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        window.removeEventListener('keydown', onKey, true);
        bg.remove();
        if (!root.children.length) root.style.pointerEvents = 'none';
        // restore previous focus if it still exists
        if (prevFocus && typeof prevFocus.focus === 'function' && document.body.contains(prevFocus)) {
          try { prevFocus.focus(); } catch (_) {}
        }
      };
      closeBtn.addEventListener('click', e => { e.stopPropagation(); close(); });
      (buttons || [{ label: 'Close', primary: true }]).forEach(b => {
        const btn = el('button', { class: 'btn' + (b.primary ? ' primary' : '') + (b.danger ? ' danger' : '') }, [b.label]);
        btn.addEventListener('click', () => {
          if (b.fn && b.fn() === false) return;
          close();
        });
        foot.appendChild(btn);
      });
      box.appendChild(foot);
      bg.addEventListener('pointerdown', e => { if (e.target === bg) close(); });

      // Esc closes; Enter triggers the primary button; Tab is trapped inside the modal.
      const onKey = ev => {
        if (ev.key === 'Escape') {
          ev.preventDefault(); ev.stopPropagation();
          close();
          return;
        }
        if (ev.key === 'Enter') {
          // don't hijack Enter from textareas or buttons (let them handle it)
          const t = ev.target;
          const tag = t && t.tagName;
          if (tag === 'TEXTAREA') return;
          if (tag === 'BUTTON') return;
          const primary = foot.querySelector('.btn.primary');
          if (primary) {
            ev.preventDefault(); ev.stopPropagation();
            primary.click();
          }
          return;
        }
        if (ev.key === 'Tab') {
          // trap focus inside the modal box
          const focusables = box.querySelectorAll(
            'a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),' +
            'select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'
          );
          if (!focusables.length) return;
          const first = focusables[0], last = focusables[focusables.length - 1];
          const a = document.activeElement;
          if (ev.shiftKey && (a === first || !box.contains(a))) {
            ev.preventDefault(); last.focus();
          } else if (!ev.shiftKey && (a === last || !box.contains(a))) {
            ev.preventDefault(); first.focus();
          }
        }
      };
      window.addEventListener('keydown', onKey, true);

      root.appendChild(bg);
      // Focus the first input/textarea/select inside the body, deferred a frame
      // so the browser has actually laid the modal out.
      requestAnimationFrame(() => {
        const f = body.querySelector('input,textarea,select');
        if (f) { try { f.focus(); if (f.select) f.select(); } catch (_) {} }
        else closeBtn.focus();
      });
      return { close, box };
    }
    progress(title) {
      const bar = el('div');
      bar.style.width = '0%';
      const label = el('div', { class: 'chk-row', text: 'Working…' });
      const body = el('div', {
        style: { display: 'flex', flexDirection: 'column', gap: '10px', minWidth: '300px' }
      }, [label, el('div', { class: 'progress' }, [bar])]);
      const m = this.modal(title, body, []);
      return {
        update: (p, lbl) => {
          bar.style.width = Math.round(U.clamp(p, 0, 1) * 100) + '%';
          if (lbl) label.textContent = lbl;
        },
        close: m.close
      };
    }
    _field(label, input) {
      return el('div', { class: 'field-row' }, [el('label', {}, [label]), input]);
    }

    /* ============================ dialogs ============================ */
    newProjectDialog() {
      // full project templates -- resolution, frame rate, length and background
      const templates = {
        'HD 1080p · 24 fps': { w: 1920, h: 1080, fps: 24, frames: 48, bg: '#ffffff' },
        'HD 720p · 24 fps': { w: 1280, h: 720, fps: 24, frames: 48, bg: '#ffffff' },
        'Square 1080 · Social': { w: 1080, h: 1080, fps: 24, frames: 36, bg: '#ffffff' },
        'Vertical 9:16 · Social': { w: 1080, h: 1920, fps: 24, frames: 36, bg: '#ffffff' },
        'Storyboard 16:9 · 12 fps': { w: 1280, h: 720, fps: 12, frames: 24, bg: '#ffffff' },
        'Film 2K Scope · 24 fps': { w: 2048, h: 858, fps: 24, frames: 48, bg: '#000000' },
        'Retro / Pixel · 12 fps': { w: 640, h: 360, fps: 12, frames: 24, bg: '#ffffff' }
      };
      const name = el('input', { type: 'text', value: 'Untitled' });
      const w = el('input', { type: 'number', value: 1920, min: 16, max: 8000 });
      const h = el('input', { type: 'number', value: 1080, min: 16, max: 8000 });
      const fps = el('input', { type: 'number', value: 24, min: 1, max: 120 });
      const fc = el('input', { type: 'number', value: 48, min: 1, max: 4000 });
      const bg = el('input', { type: 'color', value: '#ffffff' });
      const preset = el('select');
      Object.keys(templates).forEach(k => preset.appendChild(el('option', { value: k }, [k])));
      preset.addEventListener('change', () => {
        const d = templates[preset.value];
        if (!d) return;
        w.value = d.w; h.value = d.h; fps.value = d.fps; fc.value = d.frames; bg.value = d.bg;
      });
      const body = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '9px' } }, [
        this._field('Name', name),
        this._field('Template', preset),
        this._field('Width', w),
        this._field('Height', h),
        this._field('Frame rate (fps)', fps),
        this._field('Frames', fc),
        this._field('Background', bg)
      ]);
      this.modal('New Project', body, [
        { label: 'Cancel' },
        {
          label: 'Create', primary: true, fn: () => {
            this.app.newProject({
              name: name.value || 'Untitled',
              width: U.clamp(parseInt(w.value) || 1920, 16, 8000),
              height: U.clamp(parseInt(h.value) || 1080, 16, 8000),
              fps: U.clamp(parseInt(fps.value) || 24, 1, 120),
              frameCount: U.clamp(parseInt(fc.value) || 48, 1, 4000),
              bg: bg.value
            });
          }
        }
      ]);
    }

    projectSettings() {
      const p = this.app.project;
      const name = el('input', { type: 'text', value: p.name });
      const w = el('input', { type: 'number', value: p.width, min: 16, max: 8000 });
      const h = el('input', { type: 'number', value: p.height, min: 16, max: 8000 });
      const rmode = el('select');
      [['Scale artwork to fit', 'scale'], ['Crop / extend (centered)', 'crop']]
        .forEach(o => rmode.appendChild(el('option', { value: o[1] }, [o[0]])));
      const fps = el('input', { type: 'number', value: p.fps, min: 1, max: 120 });
      const fc = el('input', { type: 'number', value: p.frameCount, min: 1, max: 4000 });
      const bg = el('input', { type: 'color', value: p.bg });
      const body = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '9px' } }, [
        this._field('Name', name),
        this._field('Width', w),
        this._field('Height', h),
        this._field('On resize', rmode),
        el('div', { class: 'chk-row', text: 'Changing width / height resizes the existing artwork.' }),
        this._field('Frame rate (fps)', fps),
        this._field('Frames', fc),
        this._field('Background', bg)
      ]);
      this.modal('Project Settings', body, [
        { label: 'Cancel' },
        {
          label: 'Apply', primary: true, fn: () => {
            p.name = name.value || 'Untitled';
            p.fps = U.clamp(parseInt(fps.value) || 24, 1, 120);
            p.frameCount = Math.max(1, parseInt(fc.value) || p.frameCount);
            p.bg = bg.value;
            const nw = U.clamp(parseInt(w.value) || p.width, 16, 8000);
            const nh = U.clamp(parseInt(h.value) || p.height, 16, 8000);
            if (nw !== p.width || nh !== p.height) {
              this.app.resizeCanvas(nw, nh, rmode.value);
            } else {
              this.refreshProjectInfo();
              this.app.emit('projectchange'); this.app.emit('render');
            }
          }
        }
      ]);
    }

    onionDialog() {
      const o = this.app.onion;
      const prev = el('input', { type: 'number', value: o.prev, min: 0, max: 12 });
      const next = el('input', { type: 'number', value: o.next, min: 0, max: 12 });
      const pc = el('input', { type: 'color', value: o.prevColor });
      const nc = el('input', { type: 'color', value: o.nextColor });
      const maxA = el('input', { type: 'range', min: 0.05, max: 0.9, step: 0.05, value: o.maxAlpha });
      const body = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '9px' } }, [
        this._field('Previous frames', prev),
        this._field('Next frames', next),
        this._field('Previous tint', pc),
        this._field('Next tint', nc),
        this._field('Max opacity', maxA)
      ]);
      this.modal('Onion Skin Settings', body, [
        { label: 'Close' },
        {
          label: 'Apply', primary: true, fn: () => {
            o.prev = U.clamp(parseInt(prev.value) || 0, 0, 12);
            o.next = U.clamp(parseInt(next.value) || 0, 0, 12);
            o.prevColor = pc.value; o.nextColor = nc.value;
            o.maxAlpha = parseFloat(maxA.value);
            o.on = true;
            this.app.emit('onionchange'); this.app.emit('render');
          }
        }
      ]);
    }

    gridDialog() {
      const a = this.app, g = a.grid, sym = a.symmetry;
      const gon = el('input', { type: 'checkbox' }); gon.checked = g.on;
      const size = el('input', { type: 'number', value: g.size, min: 8, max: 400 });
      const guides = el('input', { type: 'checkbox' }); guides.checked = g.guides;
      const symSel = el('select');
      [['Off', 'off'], ['Vertical', 'v'], ['Horizontal', 'h']].forEach(o =>
        symSel.appendChild(el('option', { value: o[1] }, [o[0]])));
      symSel.value = sym.on ? sym.axis : 'off';
      const body = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '9px' } }, [
        this._field('Show grid', gon),
        this._field('Grid size (px)', size),
        this._field('Rule-of-thirds guides', guides),
        this._field('Symmetry / mirror', symSel)
      ]);
      this.modal('Grid, Guides & Symmetry', body, [
        { label: 'Close' },
        {
          label: 'Apply', primary: true, fn: () => {
            g.on = gon.checked;
            g.size = U.clamp(parseInt(size.value) || 64, 8, 400);
            g.guides = guides.checked;
            sym.on = symSel.value !== 'off';
            if (sym.on) sym.axis = symSel.value;
            a.emit('render');
          }
        }
      ]);
    }

    penDialog() {
      const pen = this.app.pen;
      const gamma = el('input', { type: 'range', min: 0.3, max: 3, step: 0.05, value: pen.gamma });
      const gVal = el('span', { style: { color: 'var(--text)' } });
      const minP = el('input', { type: 'range', min: 0, max: 1, step: 0.02, value: pen.min });
      const maxP = el('input', { type: 'range', min: 0, max: 1, step: 0.02, value: pen.max });
      const refresh = () => {
        const g = parseFloat(gamma.value);
        gVal.textContent = (g < 0.85 ? 'Light touch' : g > 1.2 ? 'Firm touch' : 'Linear') +
          '  ·  ' + g.toFixed(2);
      };
      refresh();
      gamma.addEventListener('input', refresh);
      const body = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '9px' } }, [
        el('div', { class: 'chk-row', text: 'Tune how pen pressure drives brush size and opacity.' }),
        this._field('Pressure curve', gamma),
        this._field('Feel', gVal),
        this._field('Minimum pressure', minP),
        this._field('Maximum pressure', maxP),
        el('div', { class: 'chk-row', text: 'A lower curve makes a light touch register sooner.' })
      ]);
      this.modal('Pen Pressure', body, [
        { label: 'Reset', fn: () => { gamma.value = 1; minP.value = 0; maxP.value = 1; refresh(); return false; } },
        { label: 'Close' },
        {
          label: 'Apply', primary: true, fn: () => {
            const g = parseFloat(gamma.value), mn = parseFloat(minP.value), mx = parseFloat(maxP.value);
            pen.gamma = isNaN(g) ? 1 : U.clamp(g, 0.3, 3);
            pen.min = isNaN(mn) ? 0 : U.clamp(mn, 0, 1);
            pen.max = isNaN(mx) ? 1 : U.clamp(mx, 0, 1);
            if (pen.max < pen.min) pen.max = pen.min;
            this.app._savePrefs();
            this.status('Pen pressure settings saved');
          }
        }
      ]);
    }

    savePaletteDialog() {
      const a = this.app;
      const input = el('input', { type: 'text', value: a.project.name || 'My Palette' });
      const body = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '9px' } }, [
        el('div', {
          class: 'chk-row',
          text: 'Save the current ' + a.palette.swatches.length +
            '-colour palette to your library so other projects can reuse it.'
        }),
        this._field('Palette name', input)
      ]);
      this.modal('Save Palette', body, [
        { label: 'Cancel' },
        { label: 'Save', primary: true, fn: () => a.savePaletteToLibrary(input.value) }
      ]);
    }
    loadPaletteDialog() {
      const a = this.app;
      let m;
      const list = el('div', {
        style: {
          display: 'flex', flexDirection: 'column', gap: '6px',
          maxHeight: '300px', overflow: 'auto', minWidth: '330px'
        }
      });
      const refresh = () => {
        list.innerHTML = '';
        if (!a.paletteLibrary.length) {
          list.appendChild(el('div', {
            class: 'chk-row', text: 'No saved palettes yet — use “Save Palette to Library”.'
          }));
          return;
        }
        a.paletteLibrary.forEach(p => {
          const sw = el('div', { style: { display: 'flex', gap: '2px', flexWrap: 'wrap' } });
          (p.colors || []).slice(0, 18).forEach(c => sw.appendChild(el('div', {
            style: {
              width: '13px', height: '13px', borderRadius: '2px',
              background: c, border: '1px solid #0007'
            }
          })));
          const load = el('button', { class: 'btn', text: 'Load', style: { padding: '4px 12px' } });
          load.addEventListener('click', () => { a.loadPaletteFromLibrary(p.name); if (m) m.close(); });
          const del = el('button', {
            class: 'icon-btn', title: 'Delete this palette',
            html: U.svg('<path d="M6 6l12 12M18 6L6 18"/>')
          });
          del.addEventListener('click', () => { a.deletePaletteFromLibrary(p.name); refresh(); });
          list.appendChild(el('div', { class: 'field-row', style: { alignItems: 'flex-start' } }, [
            el('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } }, [
              el('span', {}, [p.name + '  ·  ' + (p.colors || []).length + ' colours']), sw
            ]),
            el('div', { style: { display: 'flex', gap: '5px', alignItems: 'center' } }, [load, del])
          ]));
        });
      };
      refresh();
      m = this.modal('Palette Library', list, [{ label: 'Close', primary: true }]);
    }

    // Auto-shading: pick a light direction, generate a soft shade layer.
    shadeDialog() {
      const a = this.app;
      const layer = a.activeLayer();
      const prev = (layer && layer.shadeOpts) || {};
      let angle = prev.angle != null ? prev.angle : 225;

      const norm = d => ((Math.round(d) % 360) + 360) % 360;
      // 8-way light-direction picker -- the arrow points toward the light
      const DIRS = [
        [-1, -1, '↖'], [0, -1, '↑'], [1, -1, '↗'],
        [-1, 0, '←'], null, [1, 0, '→'],
        [-1, 1, '↙'], [0, 1, '↓'], [1, 1, '↘']
      ];
      const cells = [];
      const grid = el('div', {
        style: { display: 'grid', gridTemplateColumns: 'repeat(3,42px)', gap: '4px', flex: '0 0 auto' }
      });
      const markSel = () => cells.forEach(b => b.classList.toggle('primary', b._angle === norm(angle)));
      DIRS.forEach(d => {
        if (!d) {
          grid.appendChild(el('div', {
            style: {
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: 'var(--accent2)', fontSize: '17px'
            }
          }, ['☀']));
          return;
        }
        const btn = el('button', { class: 'btn', text: d[2], style: { padding: '7px 0', fontSize: '15px' } });
        btn._angle = norm(Math.atan2(d[1], d[0]) * 180 / Math.PI);
        btn.addEventListener('click', () => { angle = btn._angle; markSel(); });
        cells.push(btn);
        grid.appendChild(btn);
      });
      markSel();

      const shadow = el('input', {
        type: 'range', min: 0, max: 1, step: 0.05,
        value: prev.shadow != null ? prev.shadow : 0.55
      });
      const highlight = el('input', {
        type: 'range', min: 0, max: 1, step: 0.05,
        value: prev.highlight != null ? prev.highlight : 0.4
      });
      const softness = el('input', {
        type: 'range', min: 2, max: 40, step: 1,
        value: prev.softness != null ? prev.softness : 12
      });
      const body = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } }, [
        el('div', {
          class: 'chk-row',
          text: 'Generates a soft shading layer above "' + (layer ? layer.name : '—') +
            '" — one shade drawing per cel, across the whole animation.'
        }),
        el('div', { style: { display: 'flex', gap: '14px', alignItems: 'center' } }, [
          grid,
          el('div', { class: 'chk-row', text: 'Click the direction the light comes from.' })
        ]),
        this._field('Shadow strength', shadow),
        this._field('Highlight strength', highlight),
        this._field('Softness', softness)
      ]);
      this.modal('Auto-Shade — Light & Shade', body, [
        { label: 'Cancel' },
        {
          label: 'Generate', primary: true, fn: () => a.generateShading({
            angle: angle,
            shadow: parseFloat(shadow.value),
            highlight: parseFloat(highlight.value),
            softness: parseFloat(softness.value)
          })
        }
      ]);
    }

    cameraDialog() {
      const a = this.app, p = a.project;
      const cur = p.cameraAt(a.frame);
      const x = el('input', { type: 'number', value: U.round(cur.x, 1), step: 10 });
      const y = el('input', { type: 'number', value: U.round(cur.y, 1), step: 10 });
      const zoom = el('input', { type: 'number', value: U.round(cur.zoom, 3), step: 0.1, min: 0.05 });
      const rot = el('input', { type: 'number', value: U.round(cur.rot, 1), step: 5 });
      const list = el('div', { style: { maxHeight: '160px', overflow: 'auto', display: 'flex', flexDirection: 'column', gap: '4px' } });
      const refresh = () => {
        list.innerHTML = '';
        const ks = p.camera.keyframes.slice().sort((m, n) => m.frame - n.frame);
        if (!ks.length) list.appendChild(el('div', { class: 'chk-row', text: 'No camera keyframes.' }));
        ks.forEach(k => {
          const del = el('button', { class: 'icon-btn', html: U.svg('<path d="M6 6l12 12M18 6L6 18"/>') });
          del.addEventListener('click', () => {
            p.camera.keyframes = p.camera.keyframes.filter(kk => kk !== k);
            refresh(); a.emit('render');
          });
          list.appendChild(el('div', { class: 'field-row' }, [
            el('span', {}, ['Frame ' + (k.frame + 1) + ' — pos ' + U.round(k.x, 0) + ',' + U.round(k.y, 0) +
              '  zoom ' + U.round(k.zoom, 2) + '  rot ' + U.round(k.rot, 0) + '°']),
            del
          ]));
        });
      };
      refresh();
      const body = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '9px' } }, [
        el('div', { class: 'chk-row', text: 'Keyframe for frame ' + (a.frame + 1) + ':' }),
        this._field('Pan X', x), this._field('Pan Y', y),
        this._field('Zoom', zoom), this._field('Rotation°', rot),
        el('div', { class: 'menu-sep' }),
        el('div', { class: 'chk-row', text: 'Keyframes:' }),
        list
      ]);
      this.modal('Camera Editor', body, [
        { label: 'Close' },
        {
          label: 'Set Keyframe', primary: true, fn: () => {
            a.setCameraKey(a.frame, {
              x: parseFloat(x.value) || 0, y: parseFloat(y.value) || 0,
              zoom: Math.max(0.05, parseFloat(zoom.value) || 1),
              rot: parseFloat(rot.value) || 0
            });
            refresh();
            return false;
          }
        }
      ]);
    }

    exportDialog(kind) {
      const a = this.app, p = a.project;
      const titles = { gif: 'Export Animated GIF', mp4: 'Export Video (MP4)', webm: 'Export Video (WebM)', sequence: 'Export PNG Sequence', frame: 'Export Current Frame' };
      const scale = el('select');
      [['100%', 1], ['75%', 0.75], ['50%', 0.5], ['25%', 0.25]].forEach(([l, v]) =>
        scale.appendChild(el('option', { value: v }, [l])));
      if (kind === 'gif') scale.value = '0.5';
      const from = el('input', { type: 'number', value: 1, min: 1, max: p.frameCount });
      const to = el('input', { type: 'number', value: p.frameCount, min: 1, max: p.frameCount });
      const rows = [this._field('Scale', scale)];
      if (kind !== 'frame') { rows.push(this._field('From frame', from)); rows.push(this._field('To frame', to)); }
      let audioChk = null;
      if ((kind === 'mp4' || kind === 'webm') && a.audioBuffer) {
        audioChk = el('input', { type: 'checkbox' });
        audioChk.checked = true;
        rows.push(el('label', { class: 'chk-row' }, [audioChk, 'Include audio track']));
      }
      const note = el('div', { class: 'chk-row' });
      if (kind === 'gif') note.textContent = 'Tip: 50% scale keeps GIF size reasonable.';
      if (kind === 'webm') note.textContent = 'WebM records in real time at ' + p.fps + ' fps.';
      if (kind === 'mp4') note.textContent = 'MP4 (H.264) records in real time at ' + p.fps + ' fps.';
      rows.push(note);
      const body = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '9px' } }, rows);
      this.modal(titles[kind], body, [
        { label: 'Cancel' },
        {
          label: 'Export', primary: true, fn: () => {
            const sc = parseFloat(scale.value);
            const opts = {
              outW: Math.max(2, Math.round(p.width * sc)),
              outH: Math.max(2, Math.round(p.height * sc)),
              from: kind === 'frame' ? a.frame : U.clamp((parseInt(from.value) || 1) - 1, 0, p.frameCount - 1),
              to: kind === 'frame' ? a.frame : U.clamp((parseInt(to.value) || p.frameCount) - 1, 0, p.frameCount - 1),
              audio: !!(audioChk && audioChk.checked)
            };
            this._runExport(kind, opts);
          }
        }
      ]);
    }

    async _runExport(kind, opts) {
      const a = this.app;
      a.playback.stop();
      const name = (a.project.name || 'animation').replace(/[^\w\-]+/g, '_');
      if (kind === 'frame') {
        const cv = OT.IO.renderFrame(a, opts.from, opts.outW, opts.outH);
        cv.toBlob(b => U.download(name + '_f' + (opts.from + 1) + '.png', b), 'image/png');
        this.status('Exported frame ' + (opts.from + 1));
        return;
      }
      const bar = el('div'); bar.style.width = '0%';
      const label = el('div', { class: 'chk-row', text: 'Preparing…' });
      const body = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px', minWidth: '300px' } }, [
        label, el('div', { class: 'progress' }, [bar])
      ]);
      const m = this.modal('Exporting…', body, []);
      const onProgress = (pr, lbl) => {
        bar.style.width = Math.round(pr * 100) + '%';
        if (lbl) label.textContent = lbl;
      };
      try {
        let blob, ext;
        if (kind === 'gif') { blob = await OT.IO.Export.gif(a, opts, onProgress); ext = 'gif'; }
        else if (kind === 'mp4') { blob = await OT.IO.Export.mp4(a, opts, onProgress); ext = 'mp4'; }
        else if (kind === 'webm') { blob = await OT.IO.Export.webm(a, opts, onProgress); ext = 'webm'; }
        else { blob = await OT.IO.Export.sequence(a, opts, onProgress); ext = 'zip'; }
        m.close();
        U.download(name + '.' + ext, blob);
        this.status('Exported ' + name + '.' + ext);
      } catch (err) {
        console.error(err);
        m.close();
        this.status('Export failed: ' + err.message);
      }
    }

    // Interactive keyboard-shortcut editor: click a key, press the new one.
    shortcutsDialog() {
      const a = this.app;
      const cmds = OT.KEY_COMMANDS || [];
      const KEYNAMES = { ' ': 'Space', arrowleft: '←', arrowright: '→', arrowup: '↑', arrowdown: '↓' };
      const fmtKey = k => {
        if (!k) return '—';
        if (KEYNAMES[k]) return KEYNAMES[k];
        return k.length === 1 ? k.toUpperCase() : (k.charAt(0).toUpperCase() + k.slice(1));
      };
      let capturing = null;
      const body = el('div', {
        style: { display: 'flex', flexDirection: 'column', gap: '3px', minWidth: '380px' }
      });

      const rebuild = () => {
        body.innerHTML = '';
        const resolved = a._resolvedKeymap();
        ['Tools', 'Animation', 'View'].forEach(cat => {
          body.appendChild(el('div', { class: 'panel-head', style: { margin: '7px 0 2px' } }, [cat]));
          cmds.filter(c => c.cat === cat).forEach(c => {
            const key = (a.keymap && a.keymap[c.id]) || c.def;
            const clash = resolved[key] && resolved[key] !== c.id;
            const keyBtn = el('button', {
              class: 'btn', style: { padding: '3px 10px', minWidth: '78px' }
            }, [capturing === c.id ? 'Press a key…' : fmtKey(key)]);
            if (clash && capturing !== c.id) keyBtn.style.borderColor = 'var(--hot)';
            keyBtn.addEventListener('click', () => {
              capturing = (capturing === c.id) ? null : c.id;
              rebuild();
            });
            body.appendChild(el('div', { class: 'field-row' }, [
              el('span', {
                style: { color: capturing === c.id ? 'var(--accent)' : 'var(--text-dim)' }
              }, [c.label]),
              keyBtn
            ]));
          });
        });
        body.appendChild(el('div', { class: 'menu-sep', style: { margin: '8px 0 5px' } }));
        body.appendChild(el('div', {
          class: 'chk-row', style: { lineHeight: '1.6' },
          text: 'Fixed: Ctrl+Z / Y undo·redo · Ctrl+S / O / N · Ctrl+C / X / V · Ctrl+A select all · '
            + 'Space play · Esc cancel · [ ] brush size · + − zoom · middle-drag pan · Alt+click pick colour.'
        }));
      };

      // capture phase, so a captured key never reaches the normal handler
      const onCapture = ev => {
        if (!document.body.contains(body)) { window.removeEventListener('keydown', onCapture, true); return; }
        if (!capturing) return;
        ev.preventDefault(); ev.stopPropagation();
        const k = ev.key.toLowerCase();
        if (['shift', 'control', 'alt', 'meta'].indexOf(k) >= 0) return;
        if (k !== 'escape') {
          const cmd = cmds.find(c => c.id === capturing);
          if (cmd) {
            if (k === cmd.def) delete a.keymap[capturing];
            else a.keymap[capturing] = k;
            a._savePrefs();
          }
        }
        capturing = null;
        rebuild();
      };

      rebuild();
      window.addEventListener('keydown', onCapture, true);
      this.modal('Keyboard Shortcuts', body, [
        {
          label: 'Reset to Defaults',
          fn: () => { a.keymap = {}; a._savePrefs(); capturing = null; rebuild(); return false; }
        },
        {
          label: 'Close', primary: true,
          fn: () => { window.removeEventListener('keydown', onCapture, true); }
        }
      ]);
    }
    // A small JavaScript console for automating the app (`app` / `OT` in scope).
    scriptConsole() {
      const a = this.app;
      let last = '';
      try { last = localStorage.getItem('opentoon.script') || ''; } catch (e) { /* ignore */ }
      const input = el('textarea', { spellcheck: 'false' });
      input.value = last ||
        '// `app` and `OT` are in scope. Use return to show a value.\n' +
        '// e.g. add a layer:  app.addLayer(\'vector\')\n' +
        'return app.project.layers.length + \' layers, \' + app.project.frameCount + \' frames\';';
      Object.assign(input.style, {
        width: '470px', height: '170px', background: 'var(--panel3)', color: 'var(--text)',
        border: '1px solid var(--edge)', borderRadius: '4px', padding: '8px',
        fontFamily: '"JetBrains Mono",ui-monospace,Consolas,monospace', fontSize: '12px',
        resize: 'vertical', lineHeight: '1.5'
      });
      const output = el('pre', {});
      Object.assign(output.style, {
        minHeight: '52px', maxHeight: '150px', overflow: 'auto', margin: '0',
        background: 'var(--bg)', border: '1px solid var(--edge)', borderRadius: '4px',
        padding: '8px', fontFamily: '"JetBrains Mono",ui-monospace,Consolas,monospace',
        fontSize: '12px', whiteSpace: 'pre-wrap', color: 'var(--text-dim)'
      });
      output.textContent = 'Output appears here.';
      const run = () => {
        let res, ok = true;
        try {
          res = (new Function('app', 'OT', input.value))(a, OT);
          if (res === undefined) res = 'OK (no return value)';
          else if (res && typeof res === 'object') {
            try { res = JSON.stringify(res, null, 2); } catch (e) { res = String(res); }
          }
        } catch (e) { res = e.name + ': ' + e.message; ok = false; }
        output.textContent = String(res);
        output.style.color = ok ? 'var(--ok)' : 'var(--hot)';
        try { localStorage.setItem('opentoon.script', input.value); } catch (e) { /* ignore */ }
        a.emitAll();
      };
      input.addEventListener('keydown', e => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); run(); }
      });
      const body = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } }, [
        el('div', { class: 'chk-row', text: 'Run JavaScript against the app — Ctrl+Enter also runs.' }),
        input,
        el('div', { class: 'chk-row', text: 'Output' }),
        output
      ]);
      this.modal('Scripting Console', body, [
        { label: 'Run', primary: true, fn: () => { run(); return false; } },
        { label: 'Close' }
      ]);
    }
    aboutDialog() {
      const desktop = window.OpenToonDesktop;
      const mark =
        '<svg class="about-mark" viewBox="0 0 200 200" fill="none" aria-hidden="true">' +
        '<circle cx="85" cy="100" r="68" stroke="#DD5038" stroke-width="17" stroke-linecap="round" opacity="0.55"/>' +
        '<circle cx="115" cy="100" r="68" stroke="#54B06A" stroke-width="17" stroke-linecap="round" opacity="0.55"/>' +
        '<circle cx="100" cy="100" r="68" stroke="#F7F1E5" stroke-width="17" stroke-linecap="round"/>' +
        '</svg>';
      const verLine = el('div', { class: 'about-version brand-mono', text: 'checking version…' });
      const status = el('div', { class: 'about-status' });
      const body = el('div', { class: 'about-body' }, [
        el('div', { html: mark }),
        el('div', { class: 'brand-wordmark', html: '<span class="open">Open</span><span class="toon">Toon</span>' }),
        verLine,
        el('div', { class: 'about-sep' }),
        el('div', { class: 'about-blurb',
          html: 'An open-source 2D animation studio, inspired by Toon Boom Harmony.<br>Frame by frame, the slow way.' }),
        el('div', { class: 'about-link brand-mono',
          html: 'MIT License · <a href="https://github.com/helliott20/opentoon" target="_blank" rel="noopener">github.com/helliott20/opentoon</a>' }),
        status
      ]);
      const buttons = [{ label: 'Close', primary: true }];
      if (desktop && desktop.checkForUpdates) {
        buttons.unshift({
          label: 'Check for Updates',
          fn: () => { this._checkUpdates(status); return false; }
        });
      }
      const m = this.modal('About', body, buttons);
      m.box.classList.add('about-modal');
      if (desktop && desktop.getVersion) {
        desktop.getVersion()
          .then(v => { verLine.textContent = 'v ' + v + ' · desktop'; })
          .catch(() => { verLine.textContent = 'desktop'; });
      } else {
        verLine.textContent = 'web · runs offline in your browser';
      }
    }
    _checkUpdates(statusEl) {
      const d = window.OpenToonDesktop;
      if (!d || !d.checkForUpdates) return;
      this._updStatusEl = statusEl;
      statusEl.textContent = 'Checking for updates…';
      if (!this._updateHooked && d.onUpdateStatus) {
        this._updateHooked = true;
        d.onUpdateStatus(s => {
          const e = this._updStatusEl;
          if (!e || !e.isConnected) return;
          const msg = {
            checking: 'Checking for updates…',
            available: 'Update ' + (s.version || '') + ' found — downloading…',
            downloading: 'Downloading update… ' + (s.percent || 0) + '%',
            downloaded: 'Update ready — restart OpenToon to install it.',
            uptodate: 'You have the latest version.',
            disabled: 'Updates are disabled in development mode.',
            error: 'Update check failed: ' + (s.message || 'offline')
          };
          e.textContent = msg[s.state] || '';
        });
      }
      d.checkForUpdates().then(r => {
        const e = this._updStatusEl;
        if (e && e.isConnected && r && r.state === 'disabled')
          e.textContent = 'Updates are disabled in this build.';
      }).catch(() => {});
    }
  }

  OT.UI = UI;
})(window.OT);
