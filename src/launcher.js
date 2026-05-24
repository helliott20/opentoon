/* OpenToon Studio - Start Screen / Launcher
 * Editorial production-slate overlay shown on every launch. Lets the artist
 * pick from recent projects, open a file, create a new project from a
 * template, or restore an autosave. Mounts as a viewport overlay above the
 * main app and self-removes when the artist makes a choice. */
(function (OT) {
  'use strict';
  const U = OT.util;
  const el = U.el;

  /* HD 1080p · 24 fps -> w/h/fps/frames/bg, mirrors ui.js#newProjectDialog */
  const TEMPLATES = [
    { name: 'HD 1080p',      ratio: '16:9', w: 1920, h: 1080, fps: 24, frames: 48, bg: '#ffffff' },
    { name: 'HD 720p',       ratio: '16:9', w: 1280, h: 720,  fps: 24, frames: 48, bg: '#ffffff' },
    { name: 'Square Social', ratio: '1:1',  w: 1080, h: 1080, fps: 24, frames: 36, bg: '#ffffff' },
    { name: 'Vertical 9:16', ratio: '9:16', w: 1080, h: 1920, fps: 24, frames: 36, bg: '#ffffff' },
    { name: 'Storyboard',    ratio: '16:9', w: 1280, h: 720,  fps: 12, frames: 24, bg: '#ffffff' },
    { name: 'Film 2K Scope', ratio: '2.39', w: 2048, h: 858,  fps: 24, frames: 48, bg: '#000000' },
    { name: 'Retro Pixel',   ratio: '16:9', w: 640,  h: 360,  fps: 12, frames: 24, bg: '#ffffff' }
  ];

  /* "2 days ago" / "yesterday" / "just now" – tight, mono, uppercase */
  function relTime(ms) {
    if (!ms) return '';
    const diff = Date.now() - ms;
    if (diff < 0) return 'just now';
    const m = Math.floor(diff / 60000);
    if (m < 1)  return 'just now';
    if (m < 60) return m + ' min ago';
    const h = Math.floor(m / 60);
    if (h < 24) return h + (h === 1 ? ' hour ago' : ' hours ago');
    const d = Math.floor(h / 24);
    if (d === 1) return 'yesterday';
    if (d < 30) return d + ' days ago';
    const mo = Math.floor(d / 30);
    if (mo < 12) return mo + (mo === 1 ? ' month ago' : ' months ago');
    return Math.floor(mo / 12) + ' yr ago';
  }

  /* MARK SVG — same geometry as assets/brand/opentoon-mark.svg */
  const MARK_SVG =
    '<svg viewBox="0 0 200 200" fill="none" aria-hidden="true">' +
      '<circle cx="85"  cy="100" r="68" stroke="#DD5038" stroke-width="17" stroke-linecap="round" opacity="0.55"/>' +
      '<circle cx="115" cy="100" r="68" stroke="#54B06A" stroke-width="17" stroke-linecap="round" opacity="0.55"/>' +
      '<circle cx="100" cy="100" r="68" stroke="#F7F1E5" stroke-width="17" stroke-linecap="round"/>' +
    '</svg>';

  class Launcher {
    constructor(app) {
      this.app = app;
      this.root = null;
      this.autosaveInfo = null;     // { project, palette, time, ... } if present
      this._closeRequested = false;
    }

    /* Public entrypoint. Promise resolves once the artist makes a choice
     * (or skips). The app's start() awaits this so the workspace stays
     * hidden behind the overlay until the artist commits. */
    show() {
      if (this.root) return Promise.resolve();
      // Autosave runs first so _collectRecents knows whether to reserve a
      // slot in the grid for the recovery card.
      return this._collectAutosave()
        .then(() => this._collectRecents())
        .then(recents => {
          this._render(recents);
          requestAnimationFrame(() => this.root.classList.add('is-ready'));
        });
    }

    /* ---- data ---- */
    _collectRecents() {
      const desk = window.OpenToonDesktop;
      // 6 fits the 2-column grid at the default 950px viewport without
      // clipping; the autosave (if any) takes one of those six slots.
      const cap = this.autosaveInfo ? 5 : 6;
      const recents = (this.app.recentFiles || []).slice(0, cap);
      if (!desk || !desk.fs || !desk.fs.statFile) {
        // web mode: no path stats, just basenames in fallback order
        return Promise.resolve(recents.map(p => ({ path: p, mtimeMs: 0 })));
      }
      return Promise.all(recents.map(p =>
        desk.fs.statFile(p)
          .then(s => ({ path: p, mtimeMs: (s && s.ok) ? s.mtimeMs : 0, missing: !s || !s.ok }))
          .catch(() => ({ path: p, mtimeMs: 0, missing: true }))
      ));
    }

    _collectAutosave() {
      const desk = window.OpenToonDesktop;
      if (!desk || !desk.fs || !desk.fs.autosaveRead) {
        // browser autosave path (sync)
        try {
          if (OT.IO && OT.IO.readAutosave) {
            return OT.IO.readAutosave().then(info => { this.autosaveInfo = info || null; });
          }
        } catch (_) {}
        return Promise.resolve();
      }
      return (OT.IO && OT.IO.readAutosave ? OT.IO.readAutosave() : Promise.resolve(null))
        .then(info => { this.autosaveInfo = info || null; })
        .catch(() => {});
    }

    /* ---- render ---- */
    _render(recents) {
      const ver = el('div', { class: 'launcher-ver brand-mono', text: 'v0.0.0' });
      if (window.OpenToonDesktop && window.OpenToonDesktop.getVersion) {
        window.OpenToonDesktop.getVersion()
          .then(v => { ver.textContent = 'v' + v; })
          .catch(() => { ver.textContent = 'desktop'; });
      } else ver.textContent = 'web preview';

      const header = el('header', { class: 'launcher-head' }, [
        el('div', { class: 'launcher-slate' }, [
          el('div', { class: 'launcher-mark', html: MARK_SVG }),
          el('div', { class: 'launcher-slate__type' }, [
            el('div', { class: 'launcher-eyebrow brand-mono', text: 'Open · Source · Studio' }),
            el('div', {
              class: 'launcher-wordmark',
              html: '<span class="open">Open</span><span class="toon">Toon</span>'
            }),
            el('div', { class: 'launcher-tag', text: 'Frame by frame, the slow way.' })
          ])
        ]),
        el('div', { class: 'launcher-meta' }, [
          el('div', { class: 'launcher-take brand-mono', text: 'TAKE / ' + new Date().getFullYear() }),
          ver
        ])
      ]);

      const recentCol = el('section', { class: 'launcher-col launcher-col--recent' }, [
        this._sectionHead('01', 'Recent'),
        this._recentList(recents)
      ]);

      const actionsCol = el('section', { class: 'launcher-col launcher-col--actions' }, [
        this._sectionHead('02', 'Start'),
        this._actionsBlock(),
        this._sectionHead('03', 'Templates', 'launcher-sec--tight'),
        this._templatesList()
      ]);

      const main = el('main', { class: 'launcher-main' }, [recentCol, actionsCol]);

      const footer = el('footer', { class: 'launcher-foot' }, [
        el('div', { class: 'launcher-foot__left brand-mono' }, [
          'MIT LICENSE · ',
          el('a', {
            href: 'https://github.com/helliott20/opentoon',
            target: '_blank',
            rel: 'noopener',
            text: 'github.com/helliott20/opentoon'
          })
        ]),
        el('button', {
          class: 'launcher-skip brand-mono', type: 'button',
          onclick: () => this._skip()
        }, ['Skip · Continue with blank scene →'])
      ]);

      this.root = el('div', { class: 'launcher', role: 'dialog', 'aria-label': 'OpenToon start' }, [
        el('div', { class: 'launcher-grain', 'aria-hidden': 'true' }),
        el('div', { class: 'launcher-stripe', 'aria-hidden': 'true' }),
        el('div', { class: 'launcher-frame' }, [header, main, footer])
      ]);
      document.body.appendChild(this.root);

      // ESC -> skip (only while launcher is mounted; one-shot listener)
      this._onKey = (ev) => {
        if (ev.key === 'Escape') { ev.preventDefault(); this._skip(); }
      };
      document.addEventListener('keydown', this._onKey, true);
    }

    _sectionHead(num, title, extraClass) {
      return el('div', { class: 'launcher-sec ' + (extraClass || '') }, [
        el('span', { class: 'launcher-sec__num brand-mono', text: num }),
        el('span', { class: 'launcher-sec__slash brand-mono', text: '/' }),
        el('span', { class: 'launcher-sec__title', text: title }),
        el('span', { class: 'launcher-sec__rule', 'aria-hidden': 'true' })
      ]);
    }

    /* ---- 01 / Recent ---- */
    _recentList(recents) {
      const wrap = el('div', { class: 'launcher-recents' });

      // Autosave card first (if present) — bright accent border so it reads
      // as a recovery, not just another recent.
      if (this.autosaveInfo) {
        wrap.appendChild(this._autosaveCard(this.autosaveInfo));
      }

      if (!recents || recents.length === 0) {
        if (!this.autosaveInfo) {
          wrap.appendChild(el('div', { class: 'launcher-empty' }, [
            el('div', { class: 'launcher-empty__title', text: 'No recent projects yet' }),
            el('div', { class: 'launcher-empty__sub brand-mono',
              text: 'Make one — or open a .otoon file' })
          ]));
        }
        return wrap;
      }

      recents.forEach((r, idx) => {
        wrap.appendChild(this._recentCard(r, idx));
      });
      return wrap;
    }

    _recentCard(r, idx) {
      const base = (r.path || '').split(/[\\/]/).pop() || 'project';
      const stem = base.replace(/\.otoon$/i, '');
      const dir = (r.path || '').slice(0, -base.length).replace(/[\\/]+$/, '');
      const card = el('button', {
        class: 'launcher-card' + (r.missing ? ' is-missing' : ''),
        type: 'button',
        title: r.path,
        onclick: () => {
          if (r.missing) return;
          this._dismissThen(() => this.app.openRecent(r.path));
        }
      });
      card.innerHTML =
        '<div class="launcher-card__art" aria-hidden="true">' + MARK_SVG + '</div>' +
        '<div class="launcher-card__body">' +
          '<div class="launcher-card__name"></div>' +
          '<div class="launcher-card__path brand-mono"></div>' +
          '<div class="launcher-card__foot">' +
            '<span class="launcher-card__chip brand-mono">.OTOON</span>' +
            '<span class="launcher-card__date brand-mono"></span>' +
          '</div>' +
        '</div>';
      card.querySelector('.launcher-card__name').textContent = stem;
      card.querySelector('.launcher-card__path').textContent =
        r.missing ? 'FILE NOT FOUND' : (dir || base);
      card.querySelector('.launcher-card__date').textContent =
        r.missing ? '—' : (relTime(r.mtimeMs) || 'previously').toUpperCase();
      card.style.setProperty('--i', idx);
      return card;
    }

    _autosaveCard(info) {
      const card = el('button', {
        class: 'launcher-card launcher-card--autosave',
        type: 'button',
        onclick: () => this._dismissThen(() => {
          this.app.loadProjectData({ project: info.project, palette: info.palette });
        })
      });
      const when = info.time ? relTime(info.time.getTime ? info.time.getTime() : info.time) : '';
      card.innerHTML =
        '<div class="launcher-card__art launcher-card__art--auto" aria-hidden="true">' +
          '<svg viewBox="0 0 24 24" width="44" height="44" fill="none" stroke="currentColor" ' +
               'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
            '<path d="M3 12a9 9 0 1 0 3-6.7"/>' +
            '<path d="M3 4v5h5"/>' +
          '</svg>' +
        '</div>' +
        '<div class="launcher-card__body">' +
          '<div class="launcher-card__name">Restore Autosave</div>' +
          '<div class="launcher-card__path brand-mono">Crash-safe snapshot</div>' +
          '<div class="launcher-card__foot">' +
            '<span class="launcher-card__chip launcher-card__chip--hot brand-mono">RECOVERY</span>' +
            '<span class="launcher-card__date brand-mono">' + (when || 'AVAILABLE').toUpperCase() + '</span>' +
          '</div>' +
        '</div>';
      card.style.setProperty('--i', -1);
      return card;
    }

    /* ---- 02 / Start ---- */
    _actionsBlock() {
      const newBtn = el('button', {
        class: 'launcher-action launcher-action--primary',
        type: 'button',
        onclick: () => this._dismissThen(() => this.app.ui.newProjectDialog())
      });
      newBtn.innerHTML =
        '<div class="launcher-action__glyph" aria-hidden="true">' +
          '<svg viewBox="0 0 28 28" width="22" height="22" fill="none" stroke="currentColor" ' +
               'stroke-width="1.7" stroke-linecap="round">' +
            '<path d="M14 6v16M6 14h16"/>' +
          '</svg>' +
        '</div>' +
        '<div class="launcher-action__body">' +
          '<div class="launcher-action__title">New Project</div>' +
          '<div class="launcher-action__sub brand-mono">Start a fresh scene · Ctrl + N</div>' +
        '</div>' +
        '<div class="launcher-action__arrow brand-mono" aria-hidden="true">→</div>';

      const openBtn = el('button', {
        class: 'launcher-action',
        type: 'button',
        onclick: () => this._openProject()
      });
      openBtn.innerHTML =
        '<div class="launcher-action__glyph" aria-hidden="true">' +
          '<svg viewBox="0 0 28 28" width="22" height="22" fill="none" stroke="currentColor" ' +
               'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' +
            '<path d="M4 9V7a2 2 0 0 1 2-2h4l2 2h10a2 2 0 0 1 2 2v3"/>' +
            '<path d="M4 9h20l-3 11a2 2 0 0 1-2 1.5H6.4A2 2 0 0 1 4.5 20L4 9z"/>' +
          '</svg>' +
        '</div>' +
        '<div class="launcher-action__body">' +
          '<div class="launcher-action__title">Open Project…</div>' +
          '<div class="launcher-action__sub brand-mono">Browse for a .otoon file · Ctrl + O</div>' +
        '</div>' +
        '<div class="launcher-action__arrow brand-mono" aria-hidden="true">→</div>';

      return el('div', { class: 'launcher-actions' }, [newBtn, openBtn]);
    }

    /* ---- 03 / Templates ---- */
    _templatesList() {
      const list = el('div', { class: 'launcher-templates' });
      TEMPLATES.forEach((t, i) => {
        const row = el('button', {
          class: 'launcher-template', type: 'button',
          onclick: () => this._dismissThen(() => {
            this.app.newProject({
              name: t.name,
              width: t.w, height: t.h, fps: t.fps,
              frameCount: t.frames, bg: t.bg
            });
          })
        });
        row.style.setProperty('--i', i);
        // Aspect tile sized to the template ratio, capped on either axis.
        const tileW = 36, tileH = Math.round(36 * (t.h / t.w));
        const cappedW = tileH > 36 ? Math.round(36 * (t.w / t.h)) : tileW;
        const cappedH = tileH > 36 ? 36 : tileH;
        row.innerHTML =
          '<div class="launcher-template__tile" style="width:' + cappedW + 'px;height:' + cappedH + 'px;' +
            'background:' + t.bg + '"></div>' +
          '<div class="launcher-template__type">' +
            '<div class="launcher-template__name">' + t.name + '</div>' +
            '<div class="launcher-template__sub brand-mono">' +
              t.ratio + ' · ' + t.fps + ' FPS' +
            '</div>' +
          '</div>' +
          '<div class="launcher-template__dim brand-mono">' + t.w + ' × ' + t.h + '</div>';
        list.appendChild(row);
      });
      return list;
    }

    /* ---- transitions ---- */
    // Used by any card / action that triggers a follow-up dialog. Removes
    // the overlay instantly so the next modal isn't visually trapped behind
    // a fading element with higher z-index. The skip path uses close()
    // instead, which plays the elegant fade-out.
    _dismissThen(fn) {
      this._teardown();
      requestAnimationFrame(fn);
    }

    // Open Project keeps the launcher visible behind the native file picker
    // so that cancelling the picker leaves the artist back where they were
    // instead of dropping them into an empty default scene.
    _openProject() {
      const fsd = window.OpenToonDesktop && window.OpenToonDesktop.fs;
      if (!fsd || !fsd.openDialog) {
        // Web fallback: there's no native picker we can hold the overlay
        // behind, so just hand off to the app's existing flow.
        this._dismissThen(() => this.app.openProject());
        return;
      }
      fsd.openDialog().then(path => {
        if (!path) return;          // canceled — launcher stays
        this._dismissThen(() => this.app._openPath(path));
      }).catch(() => { /* dialog failure — stay put */ });
    }

    _skip() {
      // Default project was already created during app.start(); just dismiss.
      this.close();
    }

    _teardown() {
      if (this._onKey) {
        document.removeEventListener('keydown', this._onKey, true);
        this._onKey = null;
      }
      if (this.root && this.root.parentNode) this.root.parentNode.removeChild(this.root);
      this.root = null;
      this._closeRequested = true;
    }

    /* ---- cleanup ---- */
    close() {
      if (!this.root || this._closeRequested) return;
      this._closeRequested = true;
      this.root.classList.add('is-leaving');
      if (this._onKey) {
        document.removeEventListener('keydown', this._onKey, true);
        this._onKey = null;
      }
      const r = this.root;
      this.root = null;
      setTimeout(() => {
        if (r && r.parentNode) r.parentNode.removeChild(r);
      }, 260);
    }
  }

  OT.Launcher = Launcher;
})(window.OT);
