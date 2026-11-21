import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { configureProviders } from './providers.ts';
import { research } from './research.ts';
import { exportAnalysis, simulate } from './engine.ts';
import { requestSchema } from './schema.ts';

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const { positionals, values } = parseArgs({
    args, allowPositionals: true,
    options: {
      source: { type: 'string', multiple: true }, sources: { type: 'string' },
      out: { type: 'string' }, scenario: { type: 'string' }, horizon: { type: 'string' },
    },
  });
  if (positionals.length !== 1 || !['research', 'simulate'].includes(command)) {
    throw new Error('Usage: npm run research -- "历史问题" [--source URL] [--sources FILE] [--out FILE] or npm run simulate -- FILE [--scenario ID] [--horizon N]');
  }
  let result: unknown;
  if (command === 'research') {
    const imported: unknown = values.sources ? JSON.parse(await readFile(values.sources, 'utf8')) : [];
    if (!Array.isArray(imported)) throw new Error('--sources expects a JSON array');
    const sources = [...imported, ...(values.source ?? []).map((url) => ({ url }))];
    result = exportAnalysis(await research(requestSchema.parse({ question: positionals[0], sources }), configureProviders()));
  } else {
    result = simulate(JSON.parse(await readFile(positionals[0], 'utf8')), {
      scenario: values.scenario,
      horizon: values.horizon === undefined ? undefined : Number(values.horizon),
    });
  }
  const json = JSON.stringify(result, null, 2) + '\n';
  if (values.out) await writeFile(values.out, json, 'utf8');
  else process.stdout.write(json);
}

main().catch((error: unknown) => {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n');
  process.exitCode = 1;
});
