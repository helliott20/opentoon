/* OpenToon Studio - animated GIF encoder (median-cut quantizer + LZW) */
(function (OT) {
  'use strict';

  /* ---- growable byte buffer ---- */
  class ByteArray {
    constructor() { this.buf = new Uint8Array(1 << 16); this.len = 0; }
    _grow(n) {
      if (this.len + n <= this.buf.length) return;
      let cap = this.buf.length;
      while (cap < this.len + n) cap *= 2;
      const nb = new Uint8Array(cap);
      nb.set(this.buf.subarray(0, this.len));
      this.buf = nb;
    }
    writeByte(b) { this._grow(1); this.buf[this.len++] = b & 0xff; }
    writeBytes(arr, off, len) {
      off = off || 0; len = (len == null) ? arr.length : len;
      this._grow(len);
      for (let i = 0; i < len; i++) this.buf[this.len++] = arr[off + i] & 0xff;
    }
    writeShort(v) { this.writeByte(v & 0xff); this.writeByte((v >> 8) & 0xff); }
    writeUTF(s) { for (let i = 0; i < s.length; i++) this.writeByte(s.charCodeAt(i)); }
    toUint8() { return this.buf.subarray(0, this.len); }
  }

  /* ---- Kevin Weiner LZW encoder (GIF variant) ---- */
  function LZWEncoder(width, height, pixels, colorDepth) {
    const EOF = -1;
    const imgW = width, imgH = height;
    const pixAry = pixels;
    const initCodeSize = Math.max(2, colorDepth);
    const BITS = 12, HSIZE = 5003;
    const maxbits = BITS, maxmaxcode = 1 << BITS;
    const masks = [0x0000, 0x0001, 0x0003, 0x0007, 0x000F, 0x001F, 0x003F, 0x007F,
      0x00FF, 0x01FF, 0x03FF, 0x07FF, 0x0FFF, 0x1FFF, 0x3FFF, 0x7FFF, 0xFFFF];
    const htab = new Int32Array(HSIZE), codetab = new Int32Array(HSIZE);
    const accum = new Uint8Array(256);
    let n_bits, maxcode, free_ent = 0, clear_flg = false, g_init_bits;
    let ClearCode, EOFCode, cur_accum = 0, cur_bits = 0, a_count = 0;
    let remaining, curPixel;

    function MAXCODE(nb) { return (1 << nb) - 1; }
    function cl_hash(h) { for (let i = 0; i < h; ++i) htab[i] = -1; }
    function char_out(c, outs) { accum[a_count++] = c; if (a_count >= 254) flush_char(outs); }
    function flush_char(outs) {
      if (a_count > 0) { outs.writeByte(a_count); outs.writeBytes(accum, 0, a_count); a_count = 0; }
    }
    function cl_block(outs) { cl_hash(HSIZE); free_ent = ClearCode + 2; clear_flg = true; output(ClearCode, outs); }
    function nextPixel() {
      if (remaining === 0) return EOF;
      --remaining;
      return pixAry[curPixel++] & 0xff;
    }
    function output(code, outs) {
      cur_accum &= masks[cur_bits];
      cur_accum = cur_bits > 0 ? (cur_accum | (code << cur_bits)) : code;
      cur_bits += n_bits;
      while (cur_bits >= 8) { char_out(cur_accum & 0xff, outs); cur_accum >>= 8; cur_bits -= 8; }
      if (free_ent > maxcode || clear_flg) {
        if (clear_flg) { maxcode = MAXCODE(n_bits = g_init_bits); clear_flg = false; }
        else { ++n_bits; maxcode = (n_bits === maxbits) ? maxmaxcode : MAXCODE(n_bits); }
      }
      if (code === EOFCode) {
        while (cur_bits > 0) { char_out(cur_accum & 0xff, outs); cur_accum >>= 8; cur_bits -= 8; }
        flush_char(outs);
      }
    }
    function compress(init_bits, outs) {
      let fcode, c, i, ent, disp, hshift = 0;
      g_init_bits = init_bits;
      clear_flg = false;
      n_bits = g_init_bits;
      maxcode = MAXCODE(n_bits);
      ClearCode = 1 << (init_bits - 1);
      EOFCode = ClearCode + 1;
      free_ent = ClearCode + 2;
      a_count = 0;
      ent = nextPixel();
      for (fcode = HSIZE; fcode < 65536; fcode *= 2) ++hshift;
      hshift = 8 - hshift;
      cl_hash(HSIZE);
      output(ClearCode, outs);
      outer:
      while ((c = nextPixel()) !== EOF) {
        fcode = (c << maxbits) + ent;
        i = (c << hshift) ^ ent;
        if (htab[i] === fcode) { ent = codetab[i]; continue; }
        else if (htab[i] >= 0) {
          disp = HSIZE - i;
          if (i === 0) disp = 1;
          do {
            if ((i -= disp) < 0) i += HSIZE;
            if (htab[i] === fcode) { ent = codetab[i]; continue outer; }
          } while (htab[i] >= 0);
        }
        output(ent, outs);
        ent = c;
        if (free_ent < maxmaxcode) { codetab[i] = free_ent++; htab[i] = fcode; }
        else cl_block(outs);
      }
      output(ent, outs);
      output(EOFCode, outs);
    }
    this.encode = function (outs) {
      outs.writeByte(initCodeSize);
      remaining = imgW * imgH;
      curPixel = 0;
      compress(initCodeSize + 1, outs);
      outs.writeByte(0);
    };
  }

  /* ---- median-cut quantizer ---- */
  function rangeOf(box) {
    let rmn = 255, rmx = 0, gmn = 255, gmx = 0, bmn = 255, bmx = 0;
    for (const c of box) {
      if (c.r < rmn) rmn = c.r; if (c.r > rmx) rmx = c.r;
      if (c.g < gmn) gmn = c.g; if (c.g > gmx) gmx = c.g;
      if (c.b < bmn) bmn = c.b; if (c.b > bmx) bmx = c.b;
    }
    const dr = rmx - rmn, dg = gmx - gmn, db = bmx - bmn;
    const m = Math.max(dr, dg, db);
    return { range: m, ch: m === dr ? 'r' : (m === dg ? 'g' : 'b') };
  }
  function quantize(data, maxColors) {
    const counts = new Map();
    for (let i = 0; i < data.length; i += 4) {
      const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    const colors = [];
    counts.forEach((cnt, key) => {
      colors.push({ r: (key >> 16) & 255, g: (key >> 8) & 255, b: key & 255, c: cnt });
    });
    if (colors.length <= maxColors) return colors.map(c => [c.r, c.g, c.b]);
    let boxes = [colors];
    while (boxes.length < maxColors) {
      let bi = -1, best = -1;
      for (let i = 0; i < boxes.length; i++) {
        if (boxes[i].length < 2) continue;
        const r = rangeOf(boxes[i]).range;
        if (r > best) { best = r; bi = i; }
      }
      if (bi < 0) break;
      const box = boxes[bi], info = rangeOf(box);
      box.sort((a, b) => a[info.ch] - b[info.ch]);
      let total = 0; for (const c of box) total += c.c;
      let acc = 0, idx = 0;
      for (; idx < box.length - 1; idx++) { acc += box[idx].c; if (acc >= total / 2) break; }
      boxes.splice(bi, 1, box.slice(0, idx + 1), box.slice(idx + 1));
    }
    return boxes.map(box => {
      let r = 0, g = 0, b = 0, t = 0;
      for (const c of box) { r += c.r * c.c; g += c.g * c.c; b += c.b * c.c; t += c.c; }
      return [Math.round(r / t), Math.round(g / t), Math.round(b / t)];
    });
  }
  function buildIndices(data, palette) {
    const n = data.length >> 2;
    const indices = new Uint8Array(n);
    const cache = new Map();
    for (let i = 0, p = 0; p < n; i += 4, p++) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const key = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2);
      let idx = cache.get(key);
      if (idx === undefined) {
        let bd = 1e9, bj = 0;
        for (let j = 0; j < palette.length; j++) {
          const pc = palette[j];
          const dr = r - pc[0], dg = g - pc[1], db = b - pc[2];
          const d = dr * dr + dg * dg + db * db;
          if (d < bd) { bd = d; bj = j; }
        }
        idx = bj; cache.set(key, idx);
      }
      indices[p] = idx;
    }
    return indices;
  }

  /* ---- GIF encoder ---- */
  class GIFEncoder {
    constructor(w, h, opts) {
      opts = opts || {};
      this.w = w; this.h = h;
      this.delayCS = Math.max(2, Math.round((opts.delay || 66) / 10));
      this.repeat = opts.repeat == null ? 0 : opts.repeat;
      this.out = new ByteArray();
      this.started = false;
    }
    _header() {
      const o = this.out;
      o.writeUTF('GIF89a');
      o.writeShort(this.w); o.writeShort(this.h);
      o.writeByte(0x00); o.writeByte(0); o.writeByte(0);
      o.writeByte(0x21); o.writeByte(0xFF); o.writeByte(0x0B);
      o.writeUTF('NETSCAPE2.0');
      o.writeByte(0x03); o.writeByte(0x01);
      o.writeShort(this.repeat);
      o.writeByte(0x00);
    }
    addFrame(imageData) {
      if (!this.started) { this._header(); this.started = true; }
      const o = this.out;
      const pal = quantize(imageData.data, 256);
      const indices = buildIndices(imageData.data, pal);
      let bits = 1; while ((1 << bits) < pal.length) bits++;
      const tableSize = 1 << bits;
      // graphic control extension
      o.writeByte(0x21); o.writeByte(0xF9); o.writeByte(0x04);
      o.writeByte(0x04); o.writeShort(this.delayCS); o.writeByte(0); o.writeByte(0);
      // image descriptor
      o.writeByte(0x2C);
      o.writeShort(0); o.writeShort(0);
      o.writeShort(this.w); o.writeShort(this.h);
      o.writeByte(0x80 | (bits - 1));
      for (let i = 0; i < tableSize; i++) {
        const c = pal[i] || [0, 0, 0];
        o.writeByte(c[0]); o.writeByte(c[1]); o.writeByte(c[2]);
      }
      new LZWEncoder(this.w, this.h, indices, bits).encode(o);
    }
    finish() {
      if (!this.started) this._header();
      this.out.writeByte(0x3B);
      return new Blob([this.out.toUint8()], { type: 'image/gif' });
    }
  }

  OT.GIFEncoder = GIFEncoder;
  OT.ByteArray = ByteArray;
})(window.OT);
