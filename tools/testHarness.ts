/**
 * The self test's runner (tools/selftest.ts registers its sections here).
 *
 *   npm test                         every section, spread over worker processes (one per core)
 *   npm test -- --serial             every section, one after the other in this process
 *   npm test -- --only sewer,deep    sections whose name contains one of the words
 *   npm run test:quick               only the sections that (transitively) import a file changed
 *                                    against origin/main (committed or not), plus the guards that
 *                                    scan the source tree and any section whose own lines changed
 *   npm test -- --list               the sections with their last run times
 *
 * Sections are independent: each builds its own cities and state, so they run in any order and in
 * any process. Times of the last full run go to .cache/selftest-times.json (the slow ones start
 * first, so the workers finish together); tools/selftest-times.json is the baseline for a fresh
 * checkout (`npm test -- --save-times` rewrites it).
 */
import { fork, execSync, type ChildProcess } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format } from 'node:util';

type Body = () => unknown | Promise<unknown>;
interface Section { name: string; fn: Body }
interface Result { name: string; ms: number; failures: number; out: string[] }

const sections: Section[] = [];
let failures = 0;

/** One test assertion: counts and prints a failure, never throws. */
export const check = (ok: boolean, msg: string) => {
  if (!ok) { failures++; console.error('  FAIL', msg); }
};

/** Registers a self-contained block of checks (runs later, maybe in another process). */
export function section(name: string, fn: Body): void {
  if (sections.some((s) => s.name === name)) throw new Error(`selftest: two sections named "${name}"`);
  sections.push({ name, fn });
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(ROOT, '.cache', 'selftest-times.json');
const BASELINE = join(ROOT, 'tools', 'selftest-times.json');
const readTimes = (): Record<string, number> => {
  for (const f of [CACHE, BASELINE]) {
    try { if (existsSync(f)) return JSON.parse(readFileSync(f, 'utf8')); } catch { /* unreadable: next */ }
  }
  return {};
};

/** Runs one section here, its console output captured. */
async function runOne(s: Section): Promise<Result> {
  const out: string[] = [];
  const keep = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  console.log = console.info = (...a: unknown[]) => { out.push(format(...a)); };
  console.error = console.warn = (...a: unknown[]) => { out.push(format(...a)); };
  const f0 = failures, t0 = performance.now();
  try { await s.fn(); } catch (e) {
    failures++;
    out.push(`  FAIL ${s.name}: threw ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  } finally { Object.assign(console, keep); }
  return { name: s.name, ms: performance.now() - t0, failures: failures - f0, out };
}

const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const printResult = (r: Result) => {
  console.log(`${r.failures ? '✗' : '✓'} ${r.name} (${secs(r.ms)}${r.failures ? `, ${r.failures} failed` : ''})`);
  for (const l of r.out) (r.failures && l.includes('FAIL') ? console.error : console.log)(`    ${l.replace(/\n/g, '\n    ')}`);
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
}

/** Call once at the end of tools/selftest.ts, after every section() is registered. */
export async function runSections(selfUrl: string): Promise<void> {
  const self = fileURLToPath(selfUrl);
  const argv = process.argv;

  // A worker: run the sections the parent sends, one at a time, and report each.
  if (argv.includes('--worker')) {
    process.on('message', async (m: { run?: string; quit?: boolean }) => {
      if (m.quit) process.exit(0);
      const s = sections.find((x) => x.name === m.run)!;
      process.send!(await runOne(s));
    });
    process.send!({ ready: true });
    return;
  }

  const times = readTimes();
  if (argv.includes('--list')) {
    for (const s of sections) console.log(`${(s.name in times ? times[s.name].toFixed(1) + " s" : "-").padStart(9)}  ${s.name}`);
    return;
  }

  let pick = sections;
  const only = arg('--only');
  if (only) {
    const words = only.toLowerCase().split(',').map((w) => w.trim()).filter(Boolean);
    pick = sections.filter((s) => words.some((w) => s.name.toLowerCase().includes(w)));
  }
  if (argv.includes('--changed')) {
    const base = arg('--base') ?? 'origin/main';
    const want = changedSections(self, base);
    if (want === 'all') console.log(`quick: the test harness or the shared helpers changed against ${base}: every section`);
    else {
      pick = pick.filter((s) => want.has(s.name));
      console.log(`quick: ${pick.length} of ${sections.length} sections touch what changed against ${base}`);
      for (const s of pick) console.log(`  ${s.name} — ${want.get(s.name)}`);
    }
  }
  if (!pick.length) { console.log('no section to run'); return; }

  const full = pick.length === sections.length;
  const jobs = argv.includes('--serial') ? 1 : Math.max(1, Math.min(Number(arg('--jobs') ?? cpus().length), pick.length));
  const t0 = performance.now();
  const results: Result[] = [];
  if (jobs === 1) {
    for (const s of pick) { const r = await runOne(s); printResult(r); results.push(r); }
  } else {
    // Longest first (by the last run), so the workers finish at about the same time.
    const queue = pick.map((s) => s.name).sort((a, b) => (times[b] ?? 30) - (times[a] ?? 30));
    await new Promise<void>((done) => {
      let live = 0;
      const start = () => {
        live++;
        const w: ChildProcess = fork(self, ['--worker'], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
        let busy: string | null = null;
        const next = () => {
          busy = queue.shift() ?? null;
          if (busy) w.send({ run: busy }); else w.send({ quit: true });
        };
        w.on('message', (m: Result | { ready: true }) => {
          if ('name' in m) { printResult(m); results.push(m); }
          next();
        });
        w.on('exit', (code) => {
          live--;
          if (busy) {
            // The worker died inside a section: that section fails; carry on with a fresh worker.
            const r = { name: busy, ms: 0, failures: 1, out: [`  FAIL ${busy}: worker exited with code ${code}`] };
            printResult(r); results.push(r);
            busy = null;
            if (queue.length) start();
          }
          if (!live) done();
        });
      };
      for (let k = 0; k < jobs; k++) start();
    });
  }

  const wall = performance.now() - t0, total = results.reduce((n, r) => n + r.ms, 0);
  const failed = results.filter((r) => r.failures);
  const slow = [...results].sort((a, b) => b.ms - a.ms).slice(0, 5).map((r) => `${r.name} ${secs(r.ms)}`).join(', ');
  console.log(`\n${results.length} sections in ${secs(wall)} (${secs(total)} of work on ${jobs} ${jobs === 1 ? 'process' : 'workers'}); slowest: ${slow}`);
  if (full && !failed.length) {
    const t: Record<string, number> = {};
    for (const r of results) t[r.name] = Math.round(r.ms / 100) / 10;
    try { mkdirSync(dirname(CACHE), { recursive: true }); writeFileSync(CACHE, JSON.stringify(t, null, 1) + '\n'); } catch { /* read-only checkout */ }
    if (argv.includes('--save-times')) writeFileSync(BASELINE, JSON.stringify(t, null, 1) + '\n');
  }
  if (failed.length) {
    const n = failed.reduce((k, r) => k + r.failures, 0);
    console.error(`${n} check(s) failed in ${failed.map((r) => r.name).join(', ')}`);
    process.exit(1);
  }
  console.log(full ? 'all checks passed' : `all checks passed (${results.length} of ${sections.length} sections; run the full \`npm test\` before merging)`);
  process.exit(0);
}

// ------------------------------------------------------------------ targeted runs (--changed)

const CODE = /\.(ts|tsx|js|mjs|cjs)$/;
const SPEC = /(?:from\s*|import\s*\(\s*|import\s+)['"](\.{1,2}\/[^'"]+)['"]/g;

/** Relative import specifiers of a file (static, dynamic, side-effect), resolved to repo paths. */
function importsOf(file: string, src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(SPEC)) {
    const r = resolveSpec(file, m[1]);
    if (r) out.push(r);
  }
  return out;
}
function resolveSpec(from: string, spec: string): string | null {
  const p = resolve(dirname(join(ROOT, from)), spec.replace(/\?.*$/, ''));
  for (const c of [p, `${p}.ts`, `${p}.tsx`, `${p}.js`, `${p}.mjs`, join(p, 'index.ts')]) {
    if (existsSync(c) && statSync(c).isFile()) return relative(ROOT, c);
  }
  return null;
}
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out); } else if (CODE.test(e.name)) out.push(p);
  }
  return out;
}

/**
 * Which sections a change can affect: section name → why, or 'all'. A section counts when it
 * imports (through any chain of relative imports) a changed file, when it reads files itself
 * (the guards scanning src/: they see every file), or when its own lines in selftest.ts changed.
 */
function changedSections(self: string, base: string): Map<string, string> | 'all' {
  const git = (c: string) => execSync(`git ${c}`, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  let mb: string;
  try { mb = git(`merge-base HEAD ${base}`).trim(); } catch { mb = 'HEAD'; }
  const changed = new Set(
    [...git(`diff --name-only ${mb}`).split('\n'), ...git('ls-files --others --exclude-standard').split('\n')].filter(Boolean),
  );
  const selfRel = relative(ROOT, self);
  const harnessRel = relative(ROOT, fileURLToPath(import.meta.url));
  if (changed.has(harnessRel) || changed.has('package.json') || changed.has('package-lock.json') || changed.has('tsconfig.json')) return 'all';

  // Lines of selftest.ts that changed (new numbering).
  const touched = new Set<number>();
  if (changed.has(selfRel)) {
    for (const m of git(`diff -U0 ${mb} -- ${selfRel}`).matchAll(/^@@ [^+]*\+(\d+)(?:,(\d+))? @@/gm)) {
      const a = Number(m[1]), n = m[2] === undefined ? 1 : Number(m[2]);
      if (n) for (let k = a; k < a + n; k++) touched.add(k);
      else touched.add(a).add(a + 1); // a deletion after line a
    }
  }

  // Import graph of src/ and tools/, closed transitively.
  const graph = new Map<string, string[]>();
  for (const f of [...walk('src'), ...walk('tools')]) graph.set(f, importsOf(f, readFileSync(join(ROOT, f), 'utf8')));
  const reach = (start: string[]): Set<string> => {
    const seen = new Set<string>(), stack = [...start];
    while (stack.length) {
      const f = stack.pop()!;
      if (seen.has(f)) continue;
      seen.add(f);
      for (const g of graph.get(f) ?? []) stack.push(g);
    }
    return seen;
  };

  // The selftest file: its import table, its helpers, its sections.
  const text = readFileSync(self, 'utf8'), lines = text.split('\n');
  const idents = new Map<string, string>(); // imported name -> file
  for (const m of text.matchAll(/^import\s+(?:type\s+)?([\s\S]*?)\s+from\s+['"](\.{1,2}\/[^'"]+)['"]/gm)) {
    const file = resolveSpec(selfRel, m[2]);
    if (!file) continue;
    const names = m[1].replace(/[{}]/g, ' ').split(/[\s,]+/).filter(Boolean);
    for (let i = 0; i < names.length; i++) {
      if (names[i] === 'type' || names[i] === '*') continue;
      if (names[i] === 'as') { idents.set(names[i + 1], file); i++; continue; }
      if (names[i + 1] !== 'as') idents.set(names[i], file);
    }
  }
  const starts: { name: string; line: number }[] = [];
  lines.forEach((l, i) => { const m = /^section\('((?:[^'\\]|\\.)*)'/.exec(l); if (m) starts.push({ name: m[1].replace(/\\'/g, "'"), line: i + 1 }); });
  const preambleEnd = starts.length ? starts[0].line - 1 : lines.length;
  const preamble = lines.slice(0, preambleEnd);
  if ([...touched].some((k) => k <= preambleEnd && !/^import /.test(lines[k - 1] ?? ''))) return 'all';

  // Helper functions in the preamble and the imports each one uses.
  const helpers = new Map<string, string>();
  preamble.forEach((l, i) => {
    const m = /^function (\w+)/.exec(l);
    if (!m) return;
    let j = i + 1;
    while (j < preamble.length && preamble[j] !== '}') j++;
    helpers.set(m[1], preamble.slice(i, j + 1).join('\n'));
  });
  const uses = (body: string, seen = new Set<string>()): string[] => {
    const deps: string[] = [];
    for (const [id, file] of idents) if (new RegExp(`\\b${id}\\b`).test(body)) deps.push(file);
    for (const m of body.matchAll(/import\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) { const r = resolveSpec(selfRel, m[1]); if (r) deps.push(r); }
    for (const [h, src] of helpers) if (!seen.has(h) && new RegExp(`\\b${h}\\(`).test(body)) { seen.add(h); deps.push(...uses(src, seen)); }
    return deps;
  };

  const want = new Map<string, string>();
  starts.forEach((s, k) => {
    const end = k + 1 < starts.length ? starts[k + 1].line - 1 : lines.length;
    const body = lines.slice(s.line - 1, end).join('\n');
    for (let n = s.line; n <= end; n++) if (touched.has(n)) { want.set(s.name, 'its checks changed'); return; }
    if (/\b(readFileSync|readdirSync|existsSync|statSync)\b/.test(body)) { want.set(s.name, 'reads the source tree'); return; }
    const hit = [...reach(uses(body))].find((f) => changed.has(f));
    if (hit) want.set(s.name, `imports ${hit}`);
  });
  return want;
}
