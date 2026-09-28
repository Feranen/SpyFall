// gif.js - Self-contained GIF tools (no DOM, no libraries).
//   parseGif()          strict/lenient structural parser (also used to vet incoming avatars)
//   decodeGifFrames()   LZW decode + frame compositing (disposal methods, transparency, interlace)
//   resampleRGBA()      crop + resize RGBA pixels (box filter down, bilinear up)
//   gifToAvatarGif()    full pipeline: decode -> crop region -> 512x512 -> quantize -> re-encode
//
// The uploaded file's bytes are NEVER kept: the avatar is always rebuilt from decoded
// pixels, so anything hidden in the original (comments, appended data, scripts) is dropped.

const GIF_STRICT_MAX_FRAMES = 200;        // most frames a peer will accept in a received avatar
const GIF_KEPT_FRAMES = 60;               // frames kept when re-encoding an upload
const GIF_MAX_CANVAS_PIXELS = 100000000;  // decode safety limit (~400 MB working buffer)
const GIF_MAX_WORK = 1500000000;          // decode safety limit (total pixels touched)

const gifTick = () => new Promise(r => setTimeout(r, 0));

// ---------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------
// strict = true  : only the blocks our own encoder writes are allowed (no comments,
//                  text, or foreign application extensions) and nothing may follow
//                  the trailer. Used on avatars received from other peers.
// strict = false : tolerant of ordinary GIFs from the wild (unknown extensions skipped).
function parseGif(b, strict) {
    const len = b.length;
    const fail = (m) => { throw new Error(m); };
    if (len < 14) fail('GIF too short');
    const sig = String.fromCharCode(b[0], b[1], b[2], b[3], b[4], b[5]);
    if (sig !== 'GIF87a' && sig !== 'GIF89a') fail('Not a GIF');
    const width = b[6] | (b[7] << 8), height = b[8] | (b[9] << 8);
    if (!width || !height) fail('Empty GIF canvas');
    const flags = b[10];
    let p = 13, gct = null;
    if (flags & 0x80) {
        const n = 3 << ((flags & 7) + 1);
        if (p + n > len) fail('Truncated palette');
        gct = b.subarray(p, p + n); p += n;
    }

    const skipSubBlocks = () => {
        while (true) {
            if (p >= len) fail('Truncated block');
            const s = b[p++];
            if (s === 0) return;
            p += s;
            if (p > len) fail('Truncated block');
        }
    };

    const frames = [];
    let gce = null;
    while (true) {
        if (p >= len) fail('Missing GIF trailer');
        const t = b[p++];
        if (t === 0x3B) {
            if (strict && p !== len) fail('Data after GIF trailer');
            break;
        }
        if (t === 0x21) {
            const label = b[p++];
            if (label === 0xF9) {
                if (b[p] !== 4 || p + 6 > len || b[p + 5] !== 0) fail('Bad graphic control block');
                const pk = b[p + 1];
                gce = { disposal: (pk >> 2) & 7, delay: b[p + 2] | (b[p + 3] << 8), trans: (pk & 1) ? b[p + 4] : -1 };
                p += 6;
                continue;
            }
            if (strict) {
                if (label !== 0xFF || b[p] !== 11 || p + 12 > len) fail('Disallowed GIF extension');
                if (String.fromCharCode.apply(null, b.subarray(p + 1, p + 12)) !== 'NETSCAPE2.0') fail('Disallowed GIF extension');
            }
            skipSubBlocks();
            continue;
        }
        if (t === 0x2C) {
            if (p + 9 > len) fail('Truncated image descriptor');
            const f = { x: b[p] | (b[p + 1] << 8), y: b[p + 2] | (b[p + 3] << 8), w: b[p + 4] | (b[p + 5] << 8), h: b[p + 6] | (b[p + 7] << 8) };
            const pk = b[p + 8]; p += 9;
            f.interlaced = !!(pk & 0x40);
            f.palette = gct;
            if (pk & 0x80) {
                const n = 3 << ((pk & 7) + 1);
                if (p + n > len) fail('Truncated palette');
                f.palette = b.subarray(p, p + n); p += n;
            }
            if (!f.palette) fail('Frame has no palette');
            if (!f.w || !f.h) fail('Empty frame');
            if (f.x + f.w > width || f.y + f.h > height) {
                if (strict) fail('Frame outside canvas');
            }
            f.minCode = b[p++];
            if (!(f.minCode >= 2 && f.minCode <= 8)) fail('Bad LZW code size');
            f.blocks = [];
            while (true) {
                if (p >= len) fail('Truncated image data');
                const s = b[p++];
                if (s === 0) break;
                if (p + s > len) fail('Truncated image data');
                f.blocks.push([p, s]);
                p += s;
            }
            f.delay = gce ? gce.delay : 0;
            f.disposal = gce ? gce.disposal : 0;
            f.trans = gce ? gce.trans : -1;
            gce = null;
            frames.push(f);
            if (strict && frames.length > GIF_STRICT_MAX_FRAMES) fail('Too many frames');
            continue;
        }
        fail('Unknown GIF block');
    }
    if (frames.length === 0) fail('GIF has no frames');
    return { width, height, frames };
}

// ---------------------------------------------------------------------
// LZW decode
// ---------------------------------------------------------------------
function gifLzwDecode(b, blocks, minCode, npix) {
    const out = new Uint8Array(npix);
    let total = 0;
    for (const bl of blocks) total += bl[1];
    const data = new Uint8Array(total);
    let o = 0;
    for (const bl of blocks) { data.set(b.subarray(bl[0], bl[0] + bl[1]), o); o += bl[1]; }

    const clear = 1 << minCode, eoi = clear + 1;
    const prefix = new Uint16Array(4096), suffix = new Uint8Array(4096), stack = new Uint8Array(4097);
    for (let i = 0; i < clear; i++) suffix[i] = i;
    let codeSize = minCode + 1, nextCode = eoi + 1, prev = -1, first = 0;
    let bitBuf = 0, bitCnt = 0, pos = 0, op = 0;

    while (op < npix) {
        while (bitCnt < codeSize) {
            if (pos >= data.length) return out;           // truncated: keep what we have
            bitBuf |= data[pos++] << bitCnt; bitCnt += 8;
        }
        let code = bitBuf & ((1 << codeSize) - 1);
        bitBuf >>>= codeSize; bitCnt -= codeSize;

        if (code === clear) { codeSize = minCode + 1; nextCode = eoi + 1; prev = -1; continue; }
        if (code === eoi) break;
        if (prev === -1) {
            if (code >= clear) return out;                // corrupt
            out[op++] = code; prev = code; first = code;
            continue;
        }
        const inCode = code;
        let sp = 0;
        if (code > nextCode) return out;                  // corrupt
        if (code === nextCode) { stack[sp++] = first; code = prev; }
        while (code >= clear) { stack[sp++] = suffix[code]; code = prefix[code]; }
        stack[sp++] = suffix[code];
        first = stack[sp - 1];
        while (sp > 0 && op < npix) out[op++] = stack[--sp];
        if (nextCode < 4096) {
            prefix[nextCode] = prev; suffix[nextCode] = first; nextCode++;
            if (nextCode === (1 << codeSize) && codeSize < 12) codeSize++;
        }
        prev = inCode;
    }
    return out;
}

// ---------------------------------------------------------------------
// Frame decode + compositing
// onFrame(rgbaCanvasBuffer, frameIndex, frame) may be async; return false to stop early.
// The buffer passed to onFrame is reused - copy/resample it before returning.
// ---------------------------------------------------------------------
const GIF_INTERLACE_PASSES = [[0, 8], [4, 8], [2, 4], [1, 2]];

async function decodeGifFrames(b, g, onFrame) {
    const W = g.width, H = g.height;
    const buf = new Uint8ClampedArray(W * H * 4);        // may throw RangeError if too big
    let saved = null, prev = null;

    for (let i = 0; i < g.frames.length; i++) {
        const f = g.frames[i];

        if (prev) {                                       // dispose the previous frame
            if (prev.disposal === 2) {
                for (let y = prev.y; y < Math.min(H, prev.y + prev.h); y++) {
                    const s = (y * W + prev.x) * 4, e = (y * W + Math.min(W, prev.x + prev.w)) * 4;
                    if (e > s) buf.fill(0, s, e);
                }
            } else if (prev.disposal === 3 && saved) {
                buf.set(saved);
            }
        }
        if (f.disposal === 3) {
            if (!saved) saved = new Uint8ClampedArray(buf.length);
            saved.set(buf);
        }

        const idx = gifLzwDecode(b, f.blocks, f.minCode, f.w * f.h);
        const pal = f.palette, palN = pal.length;
        let rowOrder = null;
        if (f.interlaced) {
            rowOrder = [];
            for (const [start, step] of GIF_INTERLACE_PASSES) for (let r = start; r < f.h; r += step) rowOrder.push(r);
        }
        for (let row = 0; row < f.h; row++) {
            const y = f.y + (rowOrder ? rowOrder[row] : row);
            if (y >= H) continue;
            for (let col = 0; col < f.w; col++) {
                const x = f.x + col;
                if (x >= W) break;
                const c = idx[row * f.w + col];
                if (c === f.trans) continue;
                const pi = c * 3;
                if (pi + 2 >= palN) continue;
                const d = (y * W + x) * 4;
                buf[d] = pal[pi]; buf[d + 1] = pal[pi + 1]; buf[d + 2] = pal[pi + 2]; buf[d + 3] = 255;
            }
        }

        const r = await onFrame(buf, i, f);
        if (r === false) break;
        prev = f;
    }
}

// ---------------------------------------------------------------------
// Resample a source rectangle (rx,ry,rw,rh) of an RGBA image to ow x oh.
// Alpha-weighted, so transparent pixels don't bleed black into edges.
// ---------------------------------------------------------------------
function resampleRGBA(src, W, H, rx, ry, rw, rh, ow, oh) {
    const out = new Uint8ClampedArray(ow * oh * 4);
    const sx = rw / ow, sy = rh / oh;

    if (sx <= 1 && sy <= 1) {                             // enlarging: bilinear
        for (let oy = 0; oy < oh; oy++) {
            let fy = ry + (oy + 0.5) * sy - 0.5;
            let y0 = Math.floor(fy); const ty = fy - y0;
            let y1 = y0 + 1;
            y0 = Math.max(0, Math.min(H - 1, y0)); y1 = Math.max(0, Math.min(H - 1, y1));
            for (let ox = 0; ox < ow; ox++) {
                let fx = rx + (ox + 0.5) * sx - 0.5;
                let x0 = Math.floor(fx); const tx = fx - x0;
                let x1 = x0 + 1;
                x0 = Math.max(0, Math.min(W - 1, x0)); x1 = Math.max(0, Math.min(W - 1, x1));
                const taps = [
                    [(y0 * W + x0) * 4, (1 - tx) * (1 - ty)], [(y0 * W + x1) * 4, tx * (1 - ty)],
                    [(y1 * W + x0) * 4, (1 - tx) * ty], [(y1 * W + x1) * 4, tx * ty]
                ];
                let sr = 0, sg = 0, sb = 0, sa = 0;
                for (let k = 0; k < 4; k++) {
                    const i = taps[k][0], w = taps[k][1], wa = w * src[i + 3];
                    sr += src[i] * wa; sg += src[i + 1] * wa; sb += src[i + 2] * wa; sa += wa;
                }
                const d = (oy * ow + ox) * 4;
                if (sa > 0) { out[d] = sr / sa; out[d + 1] = sg / sa; out[d + 2] = sb / sa; }
                out[d + 3] = sa;
            }
        }
        return out;
    }

    // shrinking: exact box filter with fractional edge coverage
    for (let oy = 0; oy < oh; oy++) {
        const y0 = ry + oy * sy, y1 = y0 + sy;
        const iy0 = Math.max(0, Math.floor(y0)), iy1 = Math.min(H, Math.ceil(y1));
        for (let ox = 0; ox < ow; ox++) {
            const x0 = rx + ox * sx, x1 = x0 + sx;
            const ix0 = Math.max(0, Math.floor(x0)), ix1 = Math.min(W, Math.ceil(x1));
            let sr = 0, sg = 0, sb = 0, sa = 0, sw = 0;
            for (let iy = iy0; iy < iy1; iy++) {
                const wy = Math.min(y1, iy + 1) - Math.max(y0, iy);
                if (wy <= 0) continue;
                let i = (iy * W + ix0) * 4;
                for (let ix = ix0; ix < ix1; ix++, i += 4) {
                    const wx = Math.min(x1, ix + 1) - Math.max(x0, ix);
                    if (wx <= 0) continue;
                    const w = wy * wx, a = src[i + 3], wa = w * a;
                    sr += src[i] * wa; sg += src[i + 1] * wa; sb += src[i + 2] * wa;
                    sa += wa; sw += w;
                }
            }
            const d = (oy * ow + ox) * 4;
            if (sa > 0) { out[d] = sr / sa; out[d + 1] = sg / sa; out[d + 2] = sb / sa; }
            out[d + 3] = sw > 0 ? sa / sw : 0;
        }
    }
    return out;
}

// ---------------------------------------------------------------------
// Colour quantizer (median cut over a 15-bit histogram shared by all frames)
// Palette index 0 is always reserved for "transparent".
// ---------------------------------------------------------------------
function gifBuildHistogram(frames) {
    const hist = new Float64Array(32768), sr = new Float64Array(32768),
        sg = new Float64Array(32768), sb = new Float64Array(32768);
    let hasAlpha = false;
    for (const fr of frames) {
        const d = fr.rgba;
        for (let i = 0; i < d.length; i += 4) {
            if (d[i + 3] < 128) { hasAlpha = true; continue; }
            const k = ((d[i] >> 3) << 10) | ((d[i + 1] >> 3) << 5) | (d[i + 2] >> 3);
            hist[k]++; sr[k] += d[i]; sg[k] += d[i + 1]; sb[k] += d[i + 2];
        }
    }
    return { hist, sr, sg, sb, hasAlpha };
}

function gifBuildPalette(H, maxColors) {
    const { hist, sr, sg, sb } = H;
    const bins = [];
    for (let k = 0; k < 32768; k++) if (hist[k] > 0) bins.push(k);

    let boxes;
    if (bins.length <= maxColors) {
        boxes = bins.map(k => [k]);                       // few enough colours: one palette entry per bin
    } else {
        boxes = [bins];
        const pop = (bx) => { let s = 0; for (const k of bx) s += hist[k]; return s; };
        const pops = [pop(bins)];
        while (boxes.length < maxColors) {
            let bi = -1, best = -1;
            for (let i = 0; i < boxes.length; i++) if (boxes[i].length > 1 && pops[i] > best) { best = pops[i]; bi = i; }
            if (bi < 0) break;
            const bx = boxes[bi];
            let rmin = 31, rmax = 0, gmin = 31, gmax = 0, bmin = 31, bmax = 0;
            for (const k of bx) {
                const r = k >> 10, g = (k >> 5) & 31, bl = k & 31;
                if (r < rmin) rmin = r; if (r > rmax) rmax = r;
                if (g < gmin) gmin = g; if (g > gmax) gmax = g;
                if (bl < bmin) bmin = bl; if (bl > bmax) bmax = bl;
            }
            const rr = rmax - rmin, gr = gmax - gmin, br = bmax - bmin;
            const shift = (rr >= gr && rr >= br) ? 10 : (gr >= br ? 5 : 0);
            bx.sort((a, c) => ((a >> shift) & 31) - ((c >> shift) & 31));
            let acc = 0, cut = 1;
            const half = pops[bi] / 2;
            for (let i = 0; i < bx.length - 1; i++) { acc += hist[bx[i]]; cut = i + 1; if (acc >= half) break; }
            const a = bx.slice(0, cut), c = bx.slice(cut);
            boxes[bi] = a; pops[bi] = pop(a);
            boxes.push(c); pops.push(pop(c));
        }
    }

    const pal = new Uint8Array(256 * 3);                  // entry 0 = transparent (black)
    const n = boxes.length;
    for (let i = 0; i < n; i++) {
        let w = 0, r = 0, g = 0, b = 0;
        for (const k of boxes[i]) { w += hist[k]; r += sr[k]; g += sg[k]; b += sb[k]; }
        pal[(i + 1) * 3] = Math.round(r / w); pal[(i + 1) * 3 + 1] = Math.round(g / w); pal[(i + 1) * 3 + 2] = Math.round(b / w);
    }
    const lut = new Uint8Array(32768);
    for (const k of bins) {
        const r = sr[k] / hist[k], g = sg[k] / hist[k], b = sb[k] / hist[k];
        let bestI = 1, bestD = Infinity;
        for (let i = 1; i <= n; i++) {
            const dr = r - pal[i * 3], dg = g - pal[i * 3 + 1], db = b - pal[i * 3 + 2];
            const dd = dr * dr * 2 + dg * dg * 4 + db * db * 3;
            if (dd < bestD) { bestD = dd; bestI = i; }
        }
        lut[k] = bestI;
    }
    return { pal, lut };
}

function gifToIndices(rgba, lut) {
    const n = rgba.length >> 2, idx = new Uint8Array(n);
    for (let p = 0, i = 0; p < n; p++, i += 4) {
        if (rgba[i + 3] < 128) { idx[p] = 0; continue; }
        idx[p] = lut[((rgba[i] >> 3) << 10) | ((rgba[i + 1] >> 3) << 5) | (rgba[i + 2] >> 3)];
    }
    return idx;
}

// ---------------------------------------------------------------------
// LZW encode + GIF writer
// ---------------------------------------------------------------------
class GifBytes {
    constructor(cap) { this.a = new Uint8Array(cap || 65536); this.n = 0; }
    _grow(extra) {
        if (this.n + extra <= this.a.length) return;
        let c = this.a.length * 2; while (c < this.n + extra) c *= 2;
        const na = new Uint8Array(c); na.set(this.a.subarray(0, this.n)); this.a = na;
    }
    u8(v) { this._grow(1); this.a[this.n++] = v; }
    u16(v) { this.u8(v & 255); this.u8((v >> 8) & 255); }
    str(s) { for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i)); }
    bytes(arr, len) { len = len === undefined ? arr.length : len; this._grow(len); this.a.set(arr.subarray(0, len), this.n); this.n += len; }
    result() { return this.a.subarray(0, this.n); }
}

function gifLzwEncode(pixels, minCode) {
    const out = new GifBytes(pixels.length / 2 + 1024);
    const clear = 1 << minCode, eoi = clear + 1;
    const first = new Int16Array(4096), next = new Int16Array(4096), ch = new Uint8Array(4096);
    let codeSize = minCode + 1, nextCode = eoi + 1;
    let cur = 0, curBits = 0;

    const emit = (code) => {
        cur |= code << curBits; curBits += codeSize;
        while (curBits >= 8) { out.u8(cur & 255); cur >>>= 8; curBits -= 8; }
    };
    const reset = () => { first.fill(-1); codeSize = minCode + 1; nextCode = eoi + 1; };

    reset();
    emit(clear);
    let prefix = pixels[0];
    for (let i = 1; i < pixels.length; i++) {
        const px = pixels[i];
        let c = first[prefix];
        while (c !== -1 && ch[c] !== px) c = next[c];
        if (c !== -1) { prefix = c; continue; }

        emit(prefix);
        if (nextCode === (1 << codeSize) && codeSize < 12) codeSize++;
        if (nextCode < 4096) {
            ch[nextCode] = px; first[nextCode] = -1; next[nextCode] = first[prefix]; first[prefix] = nextCode;
            nextCode++;
        } else {
            emit(clear);
            reset();
        }
        prefix = px;
    }
    emit(prefix);
    emit(eoi);
    if (curBits > 0) out.u8(cur & 255);
    return out.result();
}

// frames: [{ idx: Uint8Array(size*size), delay: centiseconds }]
function gifWrite(frames, size, pal, hasAlpha) {
    const w = new GifBytes(1 << 20);
    w.str('GIF89a');
    w.u16(size); w.u16(size);
    w.u8(0xF7); w.u8(0); w.u8(0);                         // 256-colour global table
    w.bytes(pal, 768);
    w.u8(0x21); w.u8(0xFF); w.u8(11); w.str('NETSCAPE2.0'); w.u8(3); w.u8(1); w.u16(0); w.u8(0);   // loop forever

    let prev = null;
    for (const f of frames) {
        let x = 0, y = 0, fw = size, fh = size, data = f.idx;
        if (!hasAlpha && prev) {
            // Only store the rectangle that changed; untouched pixels become transparent.
            let minX = size, minY = size, maxX = -1, maxY = -1;
            for (let py = 0; py < size; py++) {
                const row = py * size;
                for (let px = 0; px < size; px++) {
                    if (f.idx[row + px] !== prev[row + px]) {
                        if (px < minX) minX = px; if (px > maxX) maxX = px;
                        if (py < minY) minY = py; if (py > maxY) maxY = py;
                    }
                }
            }
            if (maxX < 0) { x = 0; y = 0; fw = 1; fh = 1; data = new Uint8Array(1); }     // identical frame: 1 transparent pixel keeps the timing
            else {
                x = minX; y = minY; fw = maxX - minX + 1; fh = maxY - minY + 1;
                data = new Uint8Array(fw * fh);
                for (let ry = 0; ry < fh; ry++) for (let rx = 0; rx < fw; rx++) {
                    const s = (y + ry) * size + x + rx;
                    data[ry * fw + rx] = f.idx[s] !== prev[s] ? f.idx[s] : 0;
                }
            }
        }
        const disposal = hasAlpha ? 2 : 1;
        w.u8(0x21); w.u8(0xF9); w.u8(4); w.u8((disposal << 2) | 1); w.u16(Math.max(2, Math.min(65535, f.delay))); w.u8(0); w.u8(0);
        w.u8(0x2C); w.u16(x); w.u16(y); w.u16(fw); w.u16(fh); w.u8(0);
        w.u8(8);
        const lzw = gifLzwEncode(data, 8);
        for (let p = 0; p < lzw.length; p += 255) {
            const n = Math.min(255, lzw.length - p);
            w.u8(n); w.bytes(lzw.subarray(p, p + n), n);
        }
        w.u8(0);
        prev = f.idx;
    }
    w.u8(0x3B);
    return w.result();
}

// Re-encodes RGBA frames as one GIF, shrinking (fewer colours / fewer frames) until it fits `budget` bytes.
// frames: [{ rgba: Uint8ClampedArray(size*size*4), delay: centiseconds }]
async function gifEncodeWithinBudget(frames, size, budget, onProgress) {
    const H = gifBuildHistogram(frames);
    let colors = 255, list = frames;
    for (let round = 0; round < 10; round++) {
        if (onProgress) onProgress('Encoding GIF (pass ' + (round + 1) + ')...', 0.85);
        await gifTick();
        const { pal, lut } = gifBuildPalette(H, colors);
        const enc = list.map(f => ({ idx: gifToIndices(f.rgba, lut), delay: f.delay }));
        const bytes = gifWrite(enc, size, pal, H.hasAlpha);
        if (bytes.length <= budget) return bytes;

        if (round % 2 === 0 && list.length > 4) {         // drop every other frame, merging their time
            const merged = [];
            for (let i = 0; i < list.length; i += 2) {
                merged.push({ rgba: list[i].rgba, delay: list[i].delay + (list[i + 1] ? list[i + 1].delay : 0) });
            }
            list = merged;
        } else if (colors > 32) {
            colors = colors >> 1;
        } else if (list.length > 4) {
            const merged = [];
            for (let i = 0; i < list.length; i += 2) {
                merged.push({ rgba: list[i].rgba, delay: list[i].delay + (list[i + 1] ? list[i + 1].delay : 0) });
            }
            list = merged;
        } else break;
    }
    throw new Error('This GIF is too complex to fit the avatar size limit even after reducing it.');
}

// ---------------------------------------------------------------------
// Full pipeline for an uploaded GIF.
// region = { x, y, size } in the GIF's own pixel coordinates (from the region picker).
// Returns a Uint8Array containing a brand-new outSize x outSize GIF.
// ---------------------------------------------------------------------
async function gifToAvatarGif(bytes, region, outSize, budget, onProgress) {
    const g = parseGif(bytes, false);
    const W = g.width, H = g.height, N = g.frames.length;
    if (W * H > GIF_MAX_CANVAS_PIXELS) throw new Error('This GIF is too large to process in the browser (' + W + 'x' + H + ').');

    const step = Math.ceil(N / GIF_KEPT_FRAMES);
    const keptCount = Math.ceil(N / step);
    let work = 0;
    for (const f of g.frames) work += f.w * f.h;
    work += keptCount * region.size * region.size;
    if (work > GIF_MAX_WORK) throw new Error('This GIF is too complex to process in the browser.');

    const delayCs = (f) => (f.delay <= 1 ? 10 : f.delay);
    const rx = Math.max(0, Math.min(W - 1, region.x)), ry = Math.max(0, Math.min(H - 1, region.y));
    const rs = Math.max(1, Math.min(region.size, W - rx, H - ry));

    const kept = [];
    await decodeGifFrames(bytes, g, async (buf, i) => {
        if (i % step === 0) {
            let d = 0;
            for (let j = i; j < Math.min(N, i + step); j++) d += delayCs(g.frames[j]);
            kept.push({ rgba: resampleRGBA(buf, W, H, rx, ry, rs, rs, outSize, outSize), delay: d });
        }
        if (onProgress) onProgress('Processing frame ' + (i + 1) + ' / ' + N + '...', 0.8 * (i + 1) / N);
        if (i % 3 === 2) await gifTick();
    });
    if (kept.length === 0) throw new Error('Could not read any frames from that GIF.');
    return gifEncodeWithinBudget(kept, outSize, budget, onProgress);
}

// Decode just the first frame (for the region picker preview).
async function gifFirstFrame(bytes, g) {
    let rgba = null;
    await decodeGifFrames(bytes, g, (buf) => { rgba = new Uint8ClampedArray(buf); return false; });
    return rgba;
}
