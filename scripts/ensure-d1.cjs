#!/usr/bin/env node
/**
 * Resolve the D1 `database_id` at deploy time instead of committing it.
 *
 * Wrangler references a D1 database by account-scoped `database_id`, not by
 * name. Keeping that id in a public repository leaks account topology and makes
 * every upstream merge conflict on `wrangler.kv.toml`. This script looks the id
 * up from the account the deploy is already authenticated against, then pins it
 * into the config for the duration of the build.
 */
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const CONFIG = path.resolve(__dirname, '..', 'wrangler.kv.toml');
const BINDING = 'DB';

const wrangler = (args) =>
  execSync(`npx wrangler ${args}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

function bindingBlock(toml) {
  const blocks = toml.match(/\[\[d1_databases\]\][^[]*/g) || [];
  return blocks.find((entry) => new RegExp(`binding\\s*=\\s*"${BINDING}"`).test(entry));
}

function expectedName(block) {
  const name = (block.match(/database_name\s*=\s*"([^"]+)"/) || [])[1];
  if (!name) throw new Error(`[ensure-d1] no database_name in the ${BINDING} binding`);
  return name;
}

function resolveId(name) {
  const list = JSON.parse(wrangler('d1 list --json'));
  const hit = list.find((db) => db.name === name);
  if (!hit) {
    const known = list.map((db) => db.name).join(', ') || '(none)';
    throw new Error(`[ensure-d1] no D1 database named "${name}" on this account; found: ${known}`);
  }
  console.log(`[ensure-d1] resolved "${name}" to ${hit.uuid}`);
  return hit.uuid;
}

function main() {
  const toml = fs.readFileSync(CONFIG, 'utf8');
  const block = bindingBlock(toml);
  if (!block) throw new Error(`[ensure-d1] no [[d1_databases]] block bound as ${BINDING}`);
  if (/^\s*database_id\s*=/m.test(block)) {
    console.log(`[ensure-d1] ${BINDING} already pinned in wrangler.kv.toml; nothing to do`);
    return;
  }

  const id = resolveId(expectedName(block));
  fs.writeFileSync(
    CONFIG,
    toml.replace(block, `${block.trimEnd()}\ndatabase_id = "${id}"\n\n`)
  );
  console.log('[ensure-d1] pinned database_id into wrangler.kv.toml for this build');
}

main();
