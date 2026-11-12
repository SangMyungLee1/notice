#!/usr/bin/env node
/**
 * Remove optional, malformed category hub cards introduced by the daily
 * synchronizer after 2026-09-27. Never change post HTML or listing data.
 * Usage: node scripts/sanitize-board-indexes.mjs --fix | --check
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const boards = ['moving', 'internet', 'water', 'rentcar'];
const args = process.argv.slice(2);
if (args.length !== 1 || !['--fix', '--check'].includes(args[0])) {
  throw new Error('Usage: node scripts/sanitize-board-indexes.mjs --fix | --check');
}
const fix = args[0] === '--fix';
const hubRe = /<section\b(?=[^>]*\bdata-hub-update\s*=)[^>]*>[\s\S]*?<\/section>/g;

for (const board of boards) {
  const file = path.join(root, board, 'index.html');
  const before = await fs.readFile(file, 'utf8');
  const matches = [...before.matchAll(hubRe)];
  if (matches.length > 1) throw new Error(`${board}: unexpected number of hub cards (${matches.length})`);
  if (matches.length && !fix) throw new Error(`${board}: unexpected data-hub-update card`);

  const after = fix ? before.replace(hubRe, '') : before;
  const required = [
    '<form id="boardSearchForm"',
    '<div id="boardList"',
    '<div id="boardPagination"',
    'window.NOTICE_BOARD_FILTER = ',
    `<link rel="canonical" href="https://notice.life-helper.co.kr/${board}/"`,
    '</html>'
  ];
  for (const token of required) {
    if (!after.includes(token)) throw new Error(`${board}: missing required page structure: ${token}`);
  }
  if (!/\b(?:window\.)?NOTICE_POSTS\s*=/.test(after)) throw new Error(`${board}: missing posts data`);
  if (after.includes('data-hub-update') || /<h2[^>]*>\s*&lt;\s*<\/h2>\s*<p>\s*[ps]\s*<\/p>/i.test(after)) {
    throw new Error(`${board}: malformed hub card remains`);
  }
  if (matches.length) {
    const restored = after.slice(0, matches[0].index) + matches[0][0] + after.slice(matches[0].index);
    if (restored !== before) throw new Error(`${board}: unexpected change outside optional hub card`);
    await fs.writeFile(file, after, 'utf8');
  }
  console.log(`${board}: ${matches.length ? 'removed optional hub card' : 'OK'}`);
}
