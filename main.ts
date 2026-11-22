// Tiny stack VM for make.fun's tiny stack ISA v1. Deterministic, no clock.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
// [pops, pushes] per opcode for the stack-needs check (trap 2, then 3).
const NEED: Record<number, [number, number]> = {
  1: [0, 1], 2: [0, 1], 0x52: [0, 1],
  3: [1, 0], 0x31: [1, 0], 0x32: [1, 0], 0x50: [1, 0], 0x51: [1, 0], 0x53: [1, 0],
  4: [1, 2], 0x17: [1, 1], 0x1b: [1, 1], 0x40: [1, 1],
  5: [2, 2], 6: [2, 3], 7: [3, 3], 0x41: [2, 0],
};
function run(p: Buffer, inp: Buffer) {
  const st: number[] = [], cs: number[] = [], mem = new Int32Array(256), out: number[] = [];
  let pc = 0, steps = 0, ip = 0, ex = -1;
  while (ex < 0) {
    if (steps >= 1_000_000) { ex = 10; break; }
    if (pc < 0 || pc >= p.length) { ex = 9; break; }
    const op = p[pc];
    const ok = op <= 7 || (op >= 0x10 && op <= 0x1e) || (op >= 0x20 && op <= 0x22)
      || (op >= 0x30 && op <= 0x34) || op === 0x40 || op === 0x41 || (op >= 0x50 && op <= 0x53);
    if (!ok) { ex = 5; break; }
    const il = op === 1 ? 1 : op === 2 ? 4 : op >= 0x30 && op <= 0x33 ? 2 : 0;
    if (pc + 1 + il > p.length) { ex = 9; break; }
    const nx = pc + 1 + il;
    steps++;
    if (op === 0) { ex = 0; break; }
    if (op === 0x30) { pc = nx + p.readInt16LE(pc + 1); continue; }
    if (op === 0x33) {
      if (cs.length >= 64) { ex = 7; break; }
      cs.push(nx); pc = p.readUInt16LE(pc + 1); continue;
    }
    if (op === 0x34) {
      if (!cs.length) { ex = 8; break; }
      pc = cs.pop()!; continue;
    }
    const [pops, pushes] = NEED[op] ?? [2, 1];
    if (st.length < pops) { ex = 2; break; }
    if (st.length - pops + pushes > 256) { ex = 3; break; }
    const b = st[st.length - 1], a = st[st.length - 2];
    switch (op) {
      case 1: st.push(p.readInt8(pc + 1)); break;
      case 2: st.push(p.readInt32LE(pc + 1)); break;
      case 3: st.pop(); break;
      case 4: st.push(b); break;
      case 5: st[st.length - 2] = b; st[st.length - 1] = a; break;
      case 6: st.push(a); break;
      case 7: { const c = b; st[st.length - 1] = st[st.length - 3]; st[st.length - 3] = a; st[st.length - 2] = c; break; }
      case 0x10: st.pop(); st[st.length - 1] = (a + b) | 0; break;
      case 0x11: st.pop(); st[st.length - 1] = (a - b) | 0; break;
      case 0x12: st.pop(); st[st.length - 1] = Math.imul(a, b); break;
      case 0x13: if (!b) { ex = 4; break; } st.pop(); st[st.length - 1] = Math.trunc(a / b) | 0; break;
      case 0x14: if (!b) { ex = 4; break; } st.pop(); st[st.length - 1] = (a % b) | 0; break;
      case 0x15: if (!b) { ex = 4; break; } st.pop(); st[st.length - 1] = Number(BigInt(a >>> 0) / BigInt(b >>> 0)) | 0; break;
      case 0x16: if (!b) { ex = 4; break; } st.pop(); st[st.length - 1] = ((a >>> 0) % (b >>> 0)) | 0; break;
      case 0x17: st[st.length - 1] = (-b) | 0; break;
      case 0x18: st.pop(); st[st.length - 1] = a & b; break;
      case 0x19: st.pop(); st[st.length - 1] = a | b; break;
      case 0x1a: st.pop(); st[st.length - 1] = a ^ b; break;
      case 0x1b: st[st.length - 1] = ~b; break;
      case 0x1c: st.pop(); st[st.length - 1] = a << (b & 31); break;
      case 0x1d: st.pop(); st[st.length - 1] = a >> (b & 31); break;
      case 0x1e: st.pop(); st[st.length - 1] = (a >>> (b & 31)) | 0; break;
      case 0x20: st.pop(); st[st.length - 1] = a === b ? 1 : 0; break;
      case 0x21: st.pop(); st[st.length - 1] = a < b ? 1 : 0; break;
      case 0x22: st.pop(); st[st.length - 1] = (a >>> 0) < (b >>> 0) ? 1 : 0; break;
      case 0x31: st.pop(); pc = b === 0 ? nx + p.readInt16LE(pc + 1) : nx; continue;
      case 0x32: st.pop(); pc = b !== 0 ? nx + p.readInt16LE(pc + 1) : nx; continue;
      case 0x40: if (b < 0 || b > 255) { ex = 6; break; } st[st.length - 1] = mem[b]; break;
      case 0x41: if (b < 0 || b > 255) { ex = 6; break; } mem[b] = a; st.pop(); st.pop(); break;
      case 0x50: {
        const s = String(b);
        if (out.length + s.length > 65_536) { ex = 11; break; }
        for (const ch of s) out.push(ch.charCodeAt(0));
        st.pop(); break;
      }
      case 0x51: if (out.length >= 65_536) { ex = 11; break; } out.push(b & 255); st.pop(); break;
      case 0x52: st.push(ip < inp.length ? inp[ip++] : -1); break;
      case 0x53: ex = b & 255; break;
    }
    pc = nx;
  }
  return { out: Buffer.from(out), ex };
}
for (const id of readdirSync(I).sort()) {
  const r = run(readFileSync(join(I, id, 'program.bin')), readFileSync(join(I, id, 'input.bin')));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'stdout.bin'), r.out);
  writeFileSync(join(O, id, 'exit.txt'), r.ex + '\n');
}
