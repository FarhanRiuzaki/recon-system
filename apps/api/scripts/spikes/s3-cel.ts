// S3: batas aman CEL untuk input konfigurator. Jalankan: bun scripts/spikes/s3-cel.ts
import { Environment } from '@marcbachmann/cel-js'

export const LIMITS = { maxAstNodes: 200, maxDepth: 20, maxListElements: 100, maxMapEntries: 100, maxCallArguments: 8 }
export const MAX_EXPR_LENGTH = 1000
// Pustaka tidak bisa melepas fungsi bawaan (matches, bytes.*, dll), jadi allowlist ditegakkan lewat AST.
export const ALLOWED_FUNCTIONS = new Set([
  'int', 'double', 'string', 'bool', 'size', 'has', 'dyn',
  'startsWith', 'endsWith', 'contains', 'lowerAscii', 'upperAscii', 'trim',
  'indexOf', 'lastIndexOf', 'substring', 'split', 'join',
])

const env = new Environment({ limits: LIMITS }).registerVariable('row', 'map').registerVariable('amount', 'int')

function calledFunctions(node: any, out = new Set<string>()): Set<string> {
  if (Array.isArray(node)) node.forEach((n) => calledFunctions(n, out))
  else if (node && typeof node === 'object') {
    if (node.op === 'call' || node.op === 'rcall') out.add(node.args[0])
    calledFunctions(node.args, out)
  }
  return out
}

/** Validasi ekspresi konfigurator; kembalikan alasan penolakan atau null. */
export function validate(expr: string): string | null {
  if (expr.length > MAX_EXPR_LENGTH) return `panjang > ${MAX_EXPR_LENGTH}`
  let parsed: any
  try { parsed = env.parse(expr) } catch (e) { return `parse: ${(e as Error).message}` }
  for (const f of calledFunctions(parsed.ast)) if (!ALLOWED_FUNCTIONS.has(f)) return `fungsi tidak diizinkan: ${f}`
  const c = env.check(expr)
  return c.valid ? null : `tipe: ${c.error.message}`
}

function assert(cond: unknown, msg: string) {
  if (!cond) { console.error('GAGAL:', msg); process.exit(1) }
}
const first = (m: string) => m.split('\n')[0]
const ms = (f: () => void) => { const t = performance.now(); f(); return performance.now() - t }

// 1. check() menolak tipe tidak cocok tanpa evaluasi
const bad = env.check('amount + "x"')
assert(!bad.valid, 'check harus menolak amount + "x"')
console.log('check amount + "x":', first((bad as any).error.message))

// 2. 10.000 node ditolak oleh limit parse (pohon seimbang supaya bukan maxDepth yang kena)
const tree = (n: number): string => (n <= 1 ? '1' : `(${tree(n >> 1)}+${tree(n - (n >> 1))})`)
const big = tree(5000) // ~10.000 node
let bigMsg = ''
let t = ms(() => { try { env.parse(big) } catch (e) { bigMsg = (e as Error).message } })
assert(bigMsg, '10.000 node harus ditolak')
assert(/node/i.test(bigMsg), `penolakan harus karena maxAstNodes, dapat: ${first(bigMsg)}`)
console.log(`10.000 node (${big.length} char) ditolak dalam ${t.toFixed(1)} ms: ${first(bigMsg)}`)
// rantai dalam ditolak oleh maxDepth
let deepMsg = ''
try { env.parse('1' + '+1'.repeat(100)) } catch (e) { deepMsg = (e as Error).message }
console.log('rantai 100 operand:', first(deepMsg) || 'lolos parse')
let depthMsg = ''
try { env.parse('('.repeat(30) + '1' + ')'.repeat(30)) } catch (e) { depthMsg = (e as Error).message }
assert(/depth/i.test(depthMsg), `kurung 30 tingkat harus ditolak maxDepth, dapat: ${depthMsg}`)
console.log('kurung 30 tingkat:', first(depthMsg))
assert(validate('x'.repeat(MAX_EXPR_LENGTH + 1)) !== null, 'panjang ekspresi harus dibatasi')
assert(validate('row.ref.matches("a")')?.includes('matches'), 'matches harus ditolak allowlist')
for (const e of ['[1].all(x, x > 0)', '[1].exists(x, x > 0)', '[1].map(x, x * 2)', '[1].filter(x, x > 0)', 'bytes("a")', 'timestamp("2026-01-01T00:00:00Z")'])
  assert(validate(e) !== null, `harus ditolak: ${e}`)
assert(validate('int(row.amount) * 100') === null, 'ekspresi normal harus lolos')

// 3. Throughput 1.000.000 evaluasi
const N = 1_000_000
const ctx = { row: { amount: '12345' } }
t = ms(() => { for (let i = 0; i < N; i++) env.evaluate('int(row.amount) * 100', ctx) })
console.log(`throughput: ${N} evaluasi dalam ${t.toFixed(0)} ms = ${Math.round(N / (t / 1000))}/detik`)
assert(env.evaluate('int(row.amount) * 100', ctx) === 1234500n, 'hasil evaluasi salah')
const compiled: any = env.parse('int(row.amount) * 100')
t = ms(() => { for (let i = 0; i < N; i++) compiled(ctx) })
console.log(`throughput (parse sekali): ${N} evaluasi dalam ${t.toFixed(0)} ms = ${Math.round(N / (t / 1000))}/detik`)

// 4. Regex catastrophic backtracking
const evil = { row: { ref: 'a'.repeat(30) + '!' } }
let r: unknown
t = ms(() => { r = env.evaluate("row.ref.matches('(a+)+$')", evil) })
console.log(`matches('(a+)+$') atas 30x"a"+"!": ${t.toFixed(0)} ms, hasil ${r}`)
console.log(t > 100 ? 'VERDICT: > 100 ms, matches() tidak diizinkan' : 'VERDICT: <= 100 ms')

// 5. Limit cost runtime
console.log('limit cost runtime di library: tidak ada (limits hanya struktural, parse time)')
