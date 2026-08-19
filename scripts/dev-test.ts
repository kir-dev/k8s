#!/usr/bin/env bun
/**
 * Test local changes before opening a PR.
 *
 * Usage:
 *   bun scripts/dev-test.ts                    # full: validate + sync current branch into ArgoCD
 *   bun scripts/dev-test.ts --app <dir>        # only test/sync one app
 *   bun scripts/dev-test.ts --validate         # synth + kubectl dry-run only (no git plumbing)
 *   bun scripts/dev-test.ts --down             # stop git daemon, remove test ApplicationSet
 *
 * Full mode mirrors the prod ArgoCD ApplicationSet but points it at a local
 * `git daemon` served from a bare repo of the current branch, so the real
 * cdk8s Config Management Plugin runs against your uncommitted work.
 */
import { readdirSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

const GIT_BASE = '/tmp/k8s-git-test';        // parent dir for the bare repo + daemon files
const BARE_REPO = join(GIT_BASE, 'k8s.git');
const DAEMON_PID = join(GIT_BASE, 'daemon.pid');
const APPSET_FILE = '.dev/application-set-test.yaml';
const GIT_PORT = Number(process.env.DEV_GIT_PORT ?? 9418);
const GIT_HOST = process.env.DEV_GIT_HOST ?? 'host.k3d.internal';

const args = process.argv.slice(2);
const appArg = (() => {
  const i = args.indexOf('--app');
  return i >= 0 ? args[i + 1] : undefined;
})();
const validateOnly = args.includes('--validate');
const down = args.includes('--down');

function sh(cmd: string, argsList: string[], opts: { stdio?: 'inherit' | 'pipe' } = {}): { ok: boolean; out: string } {
  const r = spawnSync(cmd, argsList, { stdio: opts.stdio ?? 'pipe', encoding: 'utf-8' });
  return { ok: r.status === 0, out: (r.stdout ?? '') + (r.stderr ?? '') };
}

function kubectlReady(): boolean {
  return sh('kubectl', ['cluster-info']).ok;
}

// --- git plumbing helpers -------------------------------------------------

function bareRepoReady(): boolean {
  return existsSync(join(BARE_REPO, 'HEAD')) && existsSync(join(BARE_REPO, 'objects'));
}

function setupBareRepo(): void {
  if (!existsSync(GIT_BASE)) mkdirSync(GIT_BASE, { recursive: true });
  if (!bareRepoReady()) {
    sh('git', ['init', '--bare', BARE_REPO], { stdio: 'inherit' });
  }
}

function pushBranch(branch: string): void {
  const r = sh('git', ['push', BARE_REPO, `HEAD:${branch}`], { stdio: 'inherit' });
  if (!r.ok) {
    // first push from a fresh bare repo may need an upstream set; retry explicitly
    const r2 = sh('git', ['push', BARE_REPO, `refs/heads/${branch}`], { stdio: 'inherit' });
    if (!r2.ok) {
      console.error(`✗ failed to push ${branch} to ${BARE_REPO}`);
      process.exit(1);
    }
  }
}

function daemonRunning(): boolean {
  if (!existsSync(DAEMON_PID)) return false;
  const pid = Number(readFileSync(DAEMON_PID, 'utf-8').trim());
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function startDaemon(): void {
  if (daemonRunning()) {
    console.log(`✓ git daemon already running (pid ${readFileSync(DAEMON_PID, 'utf-8').trim()})`);
    return;
  }
  const r = sh(
    'git',
    [
      'daemon', '--reuseaddr', '--export-all',
      '--base-path=' + GIT_BASE,
      '--listen=0.0.0.0', `--port=${GIT_PORT}`,
      `--pid-file=${DAEMON_PID}`,
      '--detach',
    ],
    { stdio: 'inherit' },
  );
  if (!r.ok || !daemonRunning()) {
    console.error(`✗ failed to start git daemon (port ${GIT_PORT}). Try: sudo git daemon ... or DEV_GIT_PORT=<highport>`);
    process.exit(1);
  }
  console.log(`✓ git daemon listening on 0.0.0.0:${GIT_PORT}`);
}

function stopDaemon(): void {
  if (!existsSync(DAEMON_PID)) return;
  const pid = Number(readFileSync(DAEMON_PID, 'utf-8').trim());
  try {
    process.kill(pid, 'SIGTERM');
    console.log(`✓ stopped git daemon (pid ${pid})`);
  } catch {
    console.log('git daemon already stopped');
  }
  rmSync(DAEMON_PID, { force: true });
}

// --- ApplicationSet -------------------------------------------------------

function dirsToTest(): string[] {
  const all = readdirSync('.').filter((d) => !d.startsWith('.') && statSync(d).isDirectory());
  return appArg ? all.filter((d) => d === appArg) : all;
}

function appKind(dir: string): 'cdk8s' | 'kustomize' | 'raw' {
  if (existsSync(join(dir, 'app.ts'))) return 'cdk8s';
  if (existsSync(join(dir, 'kustomization.yaml')) || existsSync(join(dir, 'kustomization.yml'))) return 'kustomize';
  return 'raw';
}

function writeAppSet(branch: string): void {
  const genDirs = appArg ? `        - path: "${appArg}"` : `        - path: "*"`;
  const yaml = `kind: ApplicationSet
apiVersion: argoproj.io/v1alpha1
metadata:
  name: apps-test
  namespace: argocd
spec:
  goTemplate: true
  goTemplateOptions: [ "missingkey=error" ]
  generators:
    - git:
        repoURL: git://${GIT_HOST}:${GIT_PORT}/k8s
        revision: ${branch}
        directories:
${genDirs}
  template:
    metadata:
      name: "{{.path.basename}}"
      finalizers:
        - resources-finalizer.argocd.argoproj.io
    spec:
      project: default
      source:
        repoURL: git://${GIT_HOST}:${GIT_PORT}/k8s
        path: "{{.path.path}}"
      destination:
        name: in-cluster
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
        syncOptions:
          - ServerSideApply=true
`;
  rmSync(APPSET_FILE, { force: true });
  // ensure .dev exists
  if (!existsSync('.dev')) mkdirSync('.dev');
  // node:fs has no writeFileSync import above; use fs module directly
  const { writeFileSync } = require('node:fs');
  writeFileSync(APPSET_FILE, yaml);
  console.log(`✓ wrote ${APPSET_FILE}`);
}

function applyAppSet(): void {
  const r = sh('kubectl', ['apply', '-f', APPSET_FILE], { stdio: 'inherit' });
  if (!r.ok) process.exit(1);
}

function deleteAppSet(): void {
  const r = sh('kubectl', ['delete', '-f', APPSET_FILE, '--ignore-not-found'], { stdio: 'inherit' });
  rmSync(APPSET_FILE, { force: true });
}

// --- validation -----------------------------------------------------------

async function synthApp(dir: string): Promise<string[]> {
  const outDir = `dist/${basename(dir)}`;
  const r = sh('bun', ['run', 'import'], { stdio: 'inherit' });
  if (!r.ok) process.exit(1);
  const synth = sh('bun', ['run', 'synth', '--app', `bun ${join(dir, 'app.ts')}`, '--output', outDir], { stdio: 'inherit' });
  if (!synth.ok) process.exit(1);
  return readdirSync(outDir).filter((f) => f.endsWith('.k8s.yaml')).map((f) => join(outDir, f));
}

async function validateDir(dir: string): Promise<void> {
  const kind = appKind(dir);
  console.log(`\n── ${dir} (${kind}) ──`);
  let files: string[] = [];
  if (kind === 'cdk8s') {
    files = await synthApp(dir);
  } else if (kind === 'kustomize') {
    const r = sh('kubectl', ['kustomize', '--enable-helm', dir], { stdio: 'inherit' });
    if (!r.ok) process.exit(1);
  } else {
    files = readdirSync(dir).filter((f) => f.endsWith('.yaml')).map((f) => join(dir, f));
  }
  if (files.length === 0) return;
  // try server-side dry-run (needs CRDs present), fall back to client-side
  const server = sh('kubectl', ['apply', '--dry-run=server', '-f', ...files], { stdio: 'inherit' });
  if (!server.ok) {
    console.log('⚠ server dry-run failed (CRDs missing?) — falling back to client dry-run');
    sh('kubectl', ['apply', '--dry-run=client', '-f', ...files], { stdio: 'inherit' });
  }
}

// --- main ----------------------------------------------------------------

const branch = sh('git', ['rev-parse', '--abbrev-ref', 'HEAD']).out.trim();

if (down) {
  stopDaemon();
  deleteAppSet();
  console.log('✓ torn down local test setup');
  process.exit(0);
}

if (validateOnly) {
  for (const dir of dirsToTest()) await validateDir(dir);
  console.log('\n✓ validation done');
  process.exit(0);
}

// full mode
if (!kubectlReady()) {
  console.error('✗ no Kubernetes cluster reachable. Start k3d + vClusters first (see README).');
  process.exit(1);
}

// 1. local validation of the app(s) under test
for (const dir of dirsToTest()) await validateDir(dir);

// 2. serve the current branch from a local bare repo + git daemon
setupBareRepo();
pushBranch(branch);
startDaemon();

// 3. point a test ApplicationSet at it
writeAppSet(branch);
applyAppSet();

console.log(`
──────────────────────────────────────────────
Local test setup ready.
  branch:      ${branch}
  repo:        git://${GIT_HOST}:${GIT_PORT}/k8s
  ApplicationSet: ${APPSET_FILE}

Watch sync:   kubectl -n argocd get applications -w
Portals:      kubectl -n argocd port-forward svc/argocd-server 8080:443
Teardown:     bun scripts/dev-test.ts --down
──────────────────────────────────────────────`);
