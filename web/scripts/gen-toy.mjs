#!/usr/bin/env node
// Generates a toy-language program from the same builder spec the dashboard uses (web/shared).
//
//   node web/scripts/gen-toy.mjs --objects 200 --cycle-share 60 --chain-length 3-8 \
//        --cycle-length 2-5 --extra-links 0-2 --locality 10 --keep-roots 30 --rounds 3 --seed 7 > p.gc
//   node web/scripts/gen-toy.mjs --spec spec.json            (a JSON object with the same fields)
//   node web/scripts/gen-toy.mjs ... --expected              (print the predicted outcome as JSON instead)
//   node web/scripts/gen-toy.mjs ... --stats                 (print counts and size on stderr)
//
// Then run it like any hand-written program:  build/gcd_runner --source p.gc --result r.json
import { readFileSync } from "node:fs";
import { generate, parseRange } from "../shared/dist/index.js";

const args = process.argv.slice(2);
const spec = {};
let printExpected = false;
let printStats = false;
const ranges = { "--chain-length": "chainLength", "--cycle-length": "cycleLength", "--extra-links": "extraLinks" };
const numbers = { "--objects": "objects", "--seed": "seed", "--cycle-share": "cycleShare", "--locality": "locality", "--keep-roots": "keepRoots", "--rounds": "rounds" };

function fail(message) {
  console.error(`gen-toy: ${message}`);
  process.exit(2);
}

for (let i = 0; i < args.length; i++) {
  const flag = args[i];
  if (flag === "--expected") { printExpected = true; continue; }
  if (flag === "--stats") { printStats = true; continue; }
  const value = args[++i];
  if (value === undefined) fail(`${flag} needs a value`);
  if (flag === "--spec") Object.assign(spec, JSON.parse(readFileSync(value, "utf8")));
  else if (flag in numbers) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) fail(`${flag} expects a number, got "${value}"`);
    spec[numbers[flag]] = parsed;
  } else if (flag in ranges) {
    const range = parseRange(value);
    if (!range) fail(`${flag} expects N or N-M, got "${value}"`);
    spec[ranges[flag]] = range;
  } else if (flag === "--collect-first") spec.collectFirst = ["yes", "true", "1"].includes(value);
  else fail(`unknown flag ${flag}`);
}

const generated = generate(spec);
if (printStats) console.error(JSON.stringify({ spec: generated.spec, stats: generated.stats }, null, 2));
if (!generated.stats.fits) fail(`the program is ${generated.stats.bytes} bytes; the limit is 65536. Use fewer objects or extra links.`);
process.stdout.write(printExpected ? `${JSON.stringify(generated.expected, null, 2)}\n` : generated.source);
