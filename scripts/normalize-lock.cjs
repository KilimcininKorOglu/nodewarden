#!/usr/bin/env node
/**
 * Point every locked tarball at the public npm registry.
 *
 * Upstream ships `package-lock.json` with `resolved` URLs on
 * registry.npmmirror.com. npm refuses those as remote tarballs with
 * `EALLOWREMOTE`, so both a local install and a CI `npm ci` fail. Only the host
 * is rewritten; every `integrity` hash stays untouched, so the contents are
 * still verified against what upstream locked.
 */
const fs = require('node:fs');
const path = require('node:path');

const LOCK = path.resolve(__dirname, '..', 'package-lock.json');
const MIRROR = 'https://registry.npmmirror.com/';
const PUBLIC = 'https://registry.npmjs.org/';

function main() {
  const before = fs.readFileSync(LOCK, 'utf8');
  const count = (before.match(new RegExp(MIRROR, 'g')) || []).length;
  if (count === 0) {
    console.log('[normalize-lock] no mirror URLs in package-lock.json; nothing to do');
    return;
  }

  fs.writeFileSync(LOCK, before.split(MIRROR).join(PUBLIC));
  console.log(`[normalize-lock] rewrote ${count} tarball URLs to ${PUBLIC}`);
}

main();
