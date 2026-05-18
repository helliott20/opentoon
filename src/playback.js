/* OpenToon Studio - playback engine */
(function (OT) {
  'use strict';

  class Playback {
    constructor(app) {
      this.app = app;
      this.playing = false;
      this.loopMode = 'loop';   // 'loop' | 'pingpong' | 'once'
      this._dir = 1;
      this._raf = null;
      this._acc = 0;
      this._last = 0;
    }
    toggle() { this.playing ? this.stop() : this.play(); }
    // Playback range [lo,hi]; respects app.playIn / app.playOut if set.
    range() {
      const p = this.app.project, c = OT.util.clamp;
      const lo = this.app.playIn != null ? c(this.app.playIn, 0, p.frameCount - 1) : 0;
      let hi = this.app.playOut != null ? c(this.app.playOut, 0, p.frameCount - 1) : p.frameCount - 1;
      if (hi < lo) hi = lo;
      return { lo, hi };
    }
    play() {
      if (this.playing) return;
      const r = this.range();
      if (this.app.frame < r.lo || this.app.frame > r.hi ||
        (this.loopMode === 'once' && this.app.frame >= r.hi))
        this.app.setFrame(r.lo);
      this.app.tools.flush();
      this.playing = true;
      this._dir = 1;
      this._acc = 0;
      this._last = performance.now();
      this.app.playAudioFrom(this.app.frame);
      this.app.playVideosFrom(this.app.frame);
      this.app.emit('playbackstate');
      this._tick();
    }
    stop() {
      if (!this.playing) return;
      this.playing = false;
      if (this._raf) cancelAnimationFrame(this._raf);
      this._raf = null;
      this.app.stopAudio();
      this.app.pauseVideos();
      this.app.emit('playbackstate');
    }
    _tick() {
      if (!this.playing) return;
      const now = performance.now();
      let dt = now - this._last;
      this._last = now;
      if (dt > 250) dt = 250;
      const dur = 1000 / this.app.project.fps;
      this._acc += dt;
      while (this._acc >= dur && this.playing) {
        this._acc -= dur;
        this._advance();
      }
      this._raf = requestAnimationFrame(() => this._tick());
    }
    _advance() {
      const r = this.range();
      let f = this.app.frame + this._dir;
      if (this.loopMode === 'pingpong') {
        if (f > r.hi) { this._dir = -1; f = Math.max(r.lo, r.hi - 1); }
        else if (f < r.lo) { this._dir = 1; f = Math.min(r.hi, r.lo + 1); }
      } else if (f > r.hi) {
        if (this.loopMode === 'loop') {
          f = r.lo;
          this.app.playAudioFrom(r.lo);
          this.app.playVideosFrom(r.lo);
        }
        else { this.app.setFrame(r.hi, true); this.stop(); return; }
      } else if (f < r.lo) {
        f = r.lo;
      }
      this.app.setFrame(f, true);
    }
    step(d) {
      this.stop();
      const p = this.app.project;
      let f = (this.app.frame + d) % p.frameCount;
      if (f < 0) f += p.frameCount;
      this.app.setFrame(f);
    }
    gotoStart() { this.stop(); this.app.setFrame(0); }
    gotoEnd() { this.stop(); this.app.setFrame(this.app.project.frameCount - 1); }
  }

  OT.Playback = Playback;
})(window.OT);
