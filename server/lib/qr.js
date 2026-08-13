/* A small QR encoder: byte mode, error correction level M, versions 1-11.
   Every version here is verified to decode; higher ones are deliberately
   left out rather than shipped unproven.
   Written from the spec rather than pulled in as a dependency, so the
   subscription page keeps working when a CDN is unreachable. */

/* ---- GF(256) arithmetic, the field Reed-Solomon works in ---- */
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function buildTables() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;          // the QR primitive polynomial
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

const mul = (a, b) => (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]];

function generatorPoly(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];                 // the x term keeps the index
      next[j + 1] ^= mul(poly[j], EXP[i]); // the constant term shifts down
    }
    poly = next;
  }
  return poly;
}

function ecBytes(data, ecLen) {
  const gen = generatorPoly(ecLen);
  const out = new Array(data.length + ecLen).fill(0);
  data.forEach((b, i) => { out[i] = b; });
  for (let i = 0; i < data.length; i++) {
    const factor = out[i];
    if (factor === 0) continue;
    for (let j = 0; j < gen.length; j++) out[i + j] ^= mul(gen[j], factor);
  }
  return out.slice(data.length);
}

/* ---- per-version layout for EC level M ----
   [ total data codewords, ec codewords per block, blocks in group 1,
     data codewords in a group-1 block, blocks in group 2 ] */
const M_LAYOUT = {
  1:[16,10,1,16,0], 2:[28,16,1,28,0], 3:[44,26,1,44,0], 4:[64,18,2,32,0],
  5:[86,24,2,43,0], 6:[108,16,4,27,0], 7:[124,18,4,31,0], 8:[154,22,2,38,2],
  9:[182,22,3,36,2], 10:[216,26,4,43,1], 11:[254,30,1,50,4]
};

const ALIGN = {
  1:[], 2:[6,18], 3:[6,22], 4:[6,26], 5:[6,30], 6:[6,34], 7:[6,22,38],
  8:[6,24,42], 9:[6,26,46], 10:[6,28,50], 11:[6,30,54]
};

function pickVersion(byteLength) {
  for (let v = 1; v <= 11; v++) {
    const [totalData] = M_LAYOUT[v];
    const countBits = v <= 9 ? 8 : 16;
    const needed = Math.ceil((4 + countBits + byteLength * 8) / 8);
    if (needed <= totalData) return v;
  }
  throw new Error('content is too long to encode as a QR here');
}

function buildCodewords(bytes, version) {
  const [totalData, ecLen, g1Blocks, g1Size, g2Blocks] = M_LAYOUT[version];
  const countBits = version <= 9 ? 8 : 16;

  const bits = [];
  const push = (value, length) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >> i) & 1);
  };
  push(0b0100, 4);                       // byte mode
  push(bytes.length, countBits);
  bytes.forEach(b => push(b, 8));

  const capacity = totalData * 8;
  push(0, Math.min(4, capacity - bits.length));      // terminator
  while (bits.length % 8) bits.push(0);

  const data = [];
  for (let i = 0; i < bits.length; i += 8) {
    data.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  }
  const PAD = [0xEC, 0x11];
  let padIndex = 0;
  while (data.length < totalData) data.push(PAD[padIndex++ % 2]);

  // split into blocks, longer blocks last
  const g2Size = g1Size + 1;
  const blocks = [];
  let cursor = 0;
  for (let i = 0; i < g1Blocks; i++) { blocks.push(data.slice(cursor, cursor + g1Size)); cursor += g1Size; }
  for (let i = 0; i < g2Blocks; i++) { blocks.push(data.slice(cursor, cursor + g2Size)); cursor += g2Size; }

  const ecBlocks = blocks.map(b => ecBytes(b, ecLen));

  // interleave
  const out = [];
  const longest = Math.max(...blocks.map(b => b.length));
  for (let i = 0; i < longest; i++) {
    for (const block of blocks) if (i < block.length) out.push(block[i]);
  }
  for (let i = 0; i < ecLen; i++) {
    for (const block of ecBlocks) out.push(block[i]);
  }
  return { codewords: out, blocks, ecBlocks, ecLen };
}

/* ---- matrix ---- */
function emptyMatrix(size) {
  return Array.from({ length: size }, () => new Array(size).fill(null));
}

function placeFunctionPatterns(m, version) {
  const size = m.length;
  const finder = (row, col) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = row + r, cc = col + c;
        if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
        const outside = r < 0 || r > 6 || c < 0 || c > 6;   // the separator ring
        const edge = r === 0 || r === 6 || c === 0 || c === 6;
        const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        m[rr][cc] = (!outside && (edge || core)) ? 1 : 0;
      }
    }
  };
  finder(0, 0); finder(0, size - 7); finder(size - 7, 0);

  for (let i = 8; i < size - 8; i++) {
    const bit = i % 2 === 0 ? 1 : 0;
    m[6][i] = bit; m[i][6] = bit;
  }

  const centres = ALIGN[version];
  const last = centres[centres.length - 1];
  for (const r of centres) {
    for (const c of centres) {
      // Only the three that would sit on a finder are omitted. The ones that
      // cross the timing lines are drawn, and overwrite them.
      const onFinder = (r === 6 && c === 6) || (r === 6 && c === last) || (r === last && c === 6);
      if (onFinder) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const ring = Math.max(Math.abs(dr), Math.abs(dc));
          m[r + dr][c + dc] = (ring === 1) ? 0 : 1;
        }
      }
    }
  }

  m[size - 8][8] = 1;                              // the always-dark module

  // reserve format areas so data skips them
  for (let i = 0; i < 9; i++) {
    if (m[8][i] === null) m[8][i] = 0;
    if (m[i][8] === null) m[i][8] = 0;
  }
  for (let i = 0; i < 8; i++) {
    if (m[8][size - 1 - i] === null) m[8][size - 1 - i] = 0;
    if (m[size - 1 - i][8] === null) m[size - 1 - i][8] = 0;
  }
}

function reservedMask(version, size) {
  const probe = emptyMatrix(size);
  placeFunctionPatterns(probe, version);
  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      const r = Math.floor(i / 3), c = i % 3;
      probe[size - 11 + c][r] = 0;
      probe[r][size - 11 + c] = 0;
    }
  }
  return probe.map(row => row.map(cell => cell !== null));
}

function placeData(m, reserved, codewords) {
  const size = m.length;
  const bits = [];
  codewords.forEach(byte => {
    for (let i = 7; i >= 0; i--) bits.push((byte >> i) & 1);
  });

  let index = 0, upward = true;
  for (let right = size - 1; right > 0; right -= 2) {
    if (right === 6) right--;                      // the vertical timing column
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      for (const col of [right, right - 1]) {
        if (reserved[row][col]) continue;
        m[row][col] = index < bits.length ? bits[index] : 0;
        index++;
      }
    }
    upward = !upward;
  }
  return index;
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => (r * c) % 2 + (r * c) % 3 === 0,
  (r, c) => ((r * c) % 2 + (r * c) % 3) % 2 === 0,
  (r, c) => ((r + c) % 2 + (r * c) % 3) % 2 === 0
];

function penalty(m) {
  const size = m.length;
  let score = 0;

  const runScore = line => {
    let total = 0, run = 1;
    for (let i = 1; i < line.length; i++) {
      if (line[i] === line[i - 1]) { run++; }
      else { if (run >= 5) total += 3 + (run - 5); run = 1; }
    }
    if (run >= 5) total += 3 + (run - 5);
    return total;
  };
  for (let i = 0; i < size; i++) {
    score += runScore(m[i]);
    score += runScore(m.map(row => row[i]));
  }

  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = m[r][c];
      if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
    }
  }

  /* The 1:1:3:1:1 signature of a finder pattern, which must be penalised in
     both directions — miss the mirrored form and a mask that plants a
     decoy finder inside the data can win, and scanners then misread it. */
  const forward = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const backward = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  const matches = (line, at, pattern) => pattern.every((bit, i) => line[at + i] === bit);
  for (let i = 0; i < size; i++) {
    const row = m[i], col = m.map(r => r[i]);
    for (let j = 0; j + 11 <= size; j++) {
      if (matches(row, j, forward) || matches(row, j, backward)) score += 40;
      if (matches(col, j, forward) || matches(col, j, backward)) score += 40;
    }
  }

  const dark = m.flat().filter(v => v === 1).length;
  const ratio = dark * 100 / (size * size);
  score += Math.floor(Math.abs(ratio - 50) / 5) * 10;
  return score;
}

function placeFormat(m, maskIndex) {
  const size = m.length;
  const ecBitsForM = 0b00;                        // level M
  let value = (ecBitsForM << 3) | maskIndex;
  let rem = value << 10;
  for (let i = 4; i >= 0; i--) {
    if (rem & (1 << (i + 10))) rem ^= 0b10100110111 << i;
  }
  const format = ((value << 10) | rem) ^ 0b101010000010010;
  // Bit 14 is the most significant and sits first, at (8,0).
  const bit = i => (format >> (14 - i)) & 1;

  for (let i = 0; i <= 5; i++) m[8][i] = bit(i);
  m[8][7] = bit(6);
  m[8][8] = bit(7);
  m[7][8] = bit(8);
  for (let i = 9; i <= 14; i++) m[14 - i][8] = bit(i);

  // Second copy: seven bits up from the bottom-left finder, then eight
  // along row 8 beside the top-right one.
  for (let i = 0; i <= 6; i++) m[size - 1 - i][8] = bit(i);
  for (let i = 7; i <= 14; i++) m[8][size - 15 + i] = bit(i);
  m[size - 8][8] = 1;
}

function placeVersion(m, version) {
  if (version < 7) return;
  const size = m.length;
  let rem = version << 12;
  for (let i = 5; i >= 0; i--) {
    if (rem & (1 << (i + 12))) rem ^= 0b1111100100101 << i;
  }
  const value = (version << 12) | rem;
  for (let i = 0; i < 18; i++) {
    const bit = (value >> i) & 1;
    const r = Math.floor(i / 3), c = i % 3;
    m[size - 11 + c][r] = bit;
    m[r][size - 11 + c] = bit;
  }
}

export function encode(text, forceMask = null) {
  const bytes = [...Buffer.from(String(text), 'utf8')];
  const version = pickVersion(bytes.length);
  const size = version * 4 + 17;
  const { codewords, blocks, ecBlocks, ecLen } = buildCodewords(bytes, version);

  const reserved = reservedMask(version, size);
  let best = null;
  for (let maskIndex = 0; maskIndex < 8; maskIndex++) {
    if (forceMask !== null && maskIndex !== forceMask) continue;
    const m = emptyMatrix(size);
    placeFunctionPatterns(m, version);
    placeVersion(m, version);
    const written = placeData(m, reserved, codewords);
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (!reserved[r][c] && MASKS[maskIndex](r, c)) m[r][c] ^= 1;
      }
    }
    placeFormat(m, maskIndex);
    const score = penalty(m);
    if (!best || score < best.score) best = { matrix: m, score, maskIndex, written };
  }

  return { matrix: best.matrix, version, size, mask: best.maskIndex,
           written: best.written, blocks, ecBlocks, ecLen, codewords };
}

export function toSvg(text, { scale = 6, quiet = 4, dark = '#000', light = 'none' } = {}) {
  const { matrix, size } = encode(text);
  const dim = (size + quiet * 2) * scale;
  const parts = [];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (matrix[r][c] === 1) {
        parts.push(`M${(c + quiet) * scale} ${(r + quiet) * scale}h${scale}v${scale}h-${scale}z`);
      }
    }
  }
  const bg = light === 'none' ? '' : `<rect width="${dim}" height="${dim}" fill="${light}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" width="${dim}" height="${dim}" shape-rendering="crispEdges">${bg}<path fill="${dark}" d="${parts.join('')}"/></svg>`;
}

/* Exposed so the encoder can be checked without a reference implementation:
   a correct Reed-Solomon codeword has an all-zero syndrome. */
export function syndromeIsZero(dataBlock, ecBlock) {
  const full = [...dataBlock, ...ecBlock];
  for (let i = 0; i < ecBlock.length; i++) {
    let acc = 0;
    for (const byte of full) acc = mul(acc, EXP[i]) ^ byte;
    if (acc !== 0) return false;
  }
  return true;
}
