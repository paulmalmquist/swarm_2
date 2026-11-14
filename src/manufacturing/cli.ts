import { openRuntime } from '../runtime.ts';
import { assert } from '../lib/util.ts';
import { LocalManufacturingExport, readManufacturingJson } from '../connectors/manufacturing.ts';
import { ManufacturingInvestigations, packetMarkdown } from './investigation.ts';
import type { PacketReview } from './investigation.ts';
import { parsePrincipal } from './schema.ts';

export function manufacturingCli(argv: string[], home?: string): void {
  const flag = (name: string): string | undefined => { const i = argv.indexOf(`--${name}`); return i < 0 ? undefined : argv[i + 1]; };
  const required = (name: string): string => { const v = flag(name); assert(v && !v.startsWith('--'), 'usage', `manufacturing needs --${name}`); return v; };
  const cmd = argv[0], value = argv[1];
  const principal = parsePrincipal(readManufacturingJson(required('principal')));
  const policy = readManufacturingJson(required('policy'));
  const rt = openRuntime({ home });
  try {
    const m = new ManufacturingInvestigations(rt.store, policy);
    assert(value && !value.startsWith('--'), 'usage', 'manufacturing requires an input file or packet id');
    let result: unknown;
    switch (cmd) {
      case 'ingest': result = m.repository.ingest(new LocalManufacturingExport().read(value), principal); break;
      case 'investigate': {
        const state = m.investigate(readManufacturingJson(value), principal);
        result = argv.includes('--md') ? packetMarkdown(state) : state; break;
      }
      case 'packet': { const state = m.packet(value, principal); result = argv.includes('--md') ? packetMarkdown(state) : state; break; }
      case 'sources': result = m.sourceBundle(value, principal); break;
      case 'review': result = m.review(value, required('hash'), required('outcome') as PacketReview['outcome'], required('rationale'), principal); break;
      default: throw new Error('manufacturing commands: ingest, investigate, packet, sources, review');
    }
    process.stdout.write((typeof result === 'string' ? result : JSON.stringify(result, null, 2)) + '\n');
  } finally { rt.close(); }
}
