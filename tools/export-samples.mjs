// Regenerate examples/*.json from js/samples.js:  node tools/export-samples.mjs
import { writeFileSync } from 'node:fs';
import { SAMPLES } from '../js/samples.js';
for (const S of SAMPLES) {
  const file = new URL(`../examples/sample-${S.id}.json`, import.meta.url);
  writeFileSync(file, JSON.stringify(S.build(), null, 2) + '\n');
  console.log('wrote', file.pathname);
}
