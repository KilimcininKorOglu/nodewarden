#!/usr/bin/env node
'use strict';

/**
 * Re-applies this fork's local changes on top of whatever upstream currently
 * ships. Every patch is idempotent: running it on an already patched tree
 * changes nothing and exits 0.
 *
 * The sync workflow runs this after every upstream merge, so a merge that
 * takes upstream's copy of a file wholesale still ends up with the fork's
 * changes in place. That removes the merge conflict as a class of failure.
 *
 * A patch whose anchor is gone is a hard failure, never a silent skip: the
 * fork change would otherwise disappear and the vault would deploy without it.
 *
 * Usage:
 *   node scripts/apply-fork-patches.cjs           write the patches
 *   node scripts/apply-fork-patches.cjs --check   exit 1 if anything is missing
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CHECK_ONLY = process.argv.includes('--check');

/** Packages whose postinstall binaries the build and the deploy need. */
const INSTALL_SCRIPT_ALLOWLIST = ['esbuild', 'workerd', 'fsevents'];

const results = [];

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function write(rel, text) {
  fs.writeFileSync(path.join(ROOT, rel), text);
}

function fail(name, message) {
  const error = new Error(`[apply-fork-patches] ${name}: ${message}`);
  error.patchName = name;
  throw error;
}

/**
 * Records the outcome of one patch and writes the file when it changed.
 */
function settle(name, rel, before, after) {
  if (before === after) {
    results.push({ name, state: 'already' });
    return;
  }
  if (!CHECK_ONLY) write(rel, after);
  results.push({ name, state: CHECK_ONLY ? 'missing' : 'applied' });
}

/**
 * Reads the resolved version of a package from package-lock.json.
 */
function lockedVersion(lock, name) {
  const key = `node_modules/${name}`;
  const entry = (lock.packages || {})[key];
  return entry && entry.version ? entry.version : null;
}

/**
 * Restores the postinstall allowlist that npm 12 requires. The versions come
 * from the lockfile, so an upstream dependency bump does not leave a stale pin
 * behind and deny the build its binaries.
 */
function patchPackageJson() {
  const rel = 'package.json';
  const before = read(rel);
  const pkg = JSON.parse(before);
  const lock = JSON.parse(read('package-lock.json'));

  const allow = {};
  for (const name of INSTALL_SCRIPT_ALLOWLIST) {
    const version = lockedVersion(lock, name);
    if (!version) fail('package.json', `${name} is not in package-lock.json`);
    allow[`${name}@${version}`] = true;
  }
  // Rewriting the file unconditionally would reformat whatever upstream ships
  // and turn a one-field difference into a whole-file one.
  if (JSON.stringify(pkg.allowScripts) === JSON.stringify(allow)) {
    return settle('package.json', rel, before, before);
  }

  pkg.allowScripts = allow;
  settle('package.json', rel, before, `${JSON.stringify(pkg, null, 2)}\n`);
}

/**
 * Keeps the workers.dev route closed. That route bypasses the zone, and with
 * it the mTLS rule in front of the custom domain.
 */
function patchWranglerConfig() {
  const rel = 'wrangler.kv.toml';
  const before = read(rel);

  if (/^workers_dev\s*=/m.test(before)) {
    const after = before.replace(/^workers_dev\s*=.*$/m, 'workers_dev = false');
    return settle('wrangler.kv.toml', rel, before, after);
  }

  const anchor = before.match(/^compatibility_date\s*=.*$/m) || before.match(/^main\s*=.*$/m);
  if (!anchor) fail('wrangler.kv.toml', 'no compatibility_date or main line to anchor on');

  const block = [
    anchor[0],
    '',
    '# workers.dev bypasses the zone, and with it the mTLS rule in front of the',
    '# custom domain. Leaving it on would expose the vault without a certificate.',
    'workers_dev = false',
  ].join('\n');
  settle('wrangler.kv.toml', rel, before, before.replace(anchor[0], block));
}

/**
 * Keeps the mutual-tls feature flag. The Android client hides its client
 * certificate screen when the server does not publish it.
 */
function patchConfigResponse() {
  const rel = 'src/config-response.ts';
  const before = read(rel);
  if (/['"]mutual-tls['"]\s*:\s*true/.test(before)) {
    return settle('config-response', rel, before, before);
  }

  const open = before.match(/featureStates\s*:\s*\{/);
  if (!open) fail('src/config-response.ts', 'the featureStates object is gone');

  const cut = open.index + open[0].length;
  const indent = (before.slice(cut).match(/\n(\s+)\S/) || [null, '      '])[1];
  const at = alphabeticalInsertPoint(before, cut, 'mutual-tls');
  const line = at === cut ? `\n${indent}'mutual-tls': true,` : `${indent}'mutual-tls': true,\n`;
  settle('config-response', rel, before, `${before.slice(0, at)}${line}${before.slice(at)}`);
}

/**
 * Finds the offset of the first key in the object that sorts after `key`, so
 * the inserted flag keeps the list alphabetical and the repo diff stays small.
 * Falls back to the offset right after the opening brace.
 */
function alphabeticalInsertPoint(text, openBrace, key) {
  const close = text.indexOf('\n    }', openBrace);
  const body = text.slice(openBrace, close === -1 ? text.length : close);
  const entry = /^[ \t]*'([^']+)'\s*:/gm;
  let match;
  while ((match = entry.exec(body)) !== null) {
    if (match[1] > key) return openBrace + match.index;
  }
  return openBrace;
}

function main() {
  const patches = [patchPackageJson, patchWranglerConfig, patchConfigResponse];
  for (const patch of patches) patch();

  for (const r of results) console.log(`[apply-fork-patches] ${r.name}: ${r.state}`);

  const missing = results.filter((r) => r.state === 'missing');
  if (missing.length > 0) {
    console.error(
      `[apply-fork-patches] ${missing.length} fork patch(es) are not applied: ` +
        missing.map((r) => r.name).join(', ')
    );
    process.exit(1);
  }
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
