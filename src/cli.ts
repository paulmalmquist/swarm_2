/**
 * swarm2 command line. Every mutating command is a command envelope with an idempotency key,
 * so repeating a command is safe.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Coordinator } from './coordination/coordinator.ts';
import { applyUpstreamChange } from './coordination/changes.ts';
import { LocalChiefOfStaff, type RawRequest } from './cos/port.ts';
import { ensureBaseline, openRuntime } from './runtime.ts';
import { SwarmError } from './lib/util.ts';

const BOOLEAN_FLAGS = ['live', 'md', 'once', 'json', 'force', 'run'];
// Flags may come before the command (`swarm2 --home DIR status`); they are moved behind it.
const given = process.argv.slice(2);
const leading: string[] = [];
while (given.length && given[0]!.startsWith('--')) {
  const f = given.shift()!;
  leading.push(f);
  if (!BOOLEAN_FLAGS.includes(f.slice(2)) && given.length) leading.push(given.shift()!);
}
const argv = [...given, ...leading];
const cmd = argv[0] ?? 'help';

function flag(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}
function has(name: string): boolean {
  return argv.includes(`--${name}`);
}
function positional(n: number): string | undefined {
  const out: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    if (argv[i]!.startsWith('--')) {
      if (!BOOLEAN_FLAGS.includes(argv[i]!.slice(2))) i++;
      continue;
    }
    out.push(argv[i]!);
  }
  return out[n];
}
function print(value: unknown): void {
  process.stdout.write((typeof value === 'string' ? value : JSON.stringify(value, null, 2)) + '\n');
}
function key(prefix: string): string {
  return flag('key') ?? `${prefix}-${Date.now().toString(36)}`;
}

const HELP = `swarm2 — an organization of agent swarms beneath your chief of staff

  init                                   install the baseline release for this home
  ingest <requests.json>                 record requests and nominate overlaps
  proposals                              proposed missions from overlapping requests
  submit --title T --objective O [--scenario S] [--requests a,b] [--priority N] [--live]
  run [--mission ID] [--max-ms N]        run the coordinator until the work is idle
  status [--mission ID]                  progress and whose action is next
  attention                              decisions and drafts waiting for a person
  decide <decision_id> <option> --rationale "..."
  evidence <mission_id> [--md]           the review packet
  priority <mission_id> <n>              change a mission's priority
  cancel <mission_id> --reason "..."     cancel a mission and everything under it
  revise <mission_id> <artifact_key> <file> --reason "..."   apply an upstream change
  connectors                             what is connected, and what each real integration needs
  export [--dir D]                       analytical history as newline-delimited JSON
  stop | resume                          kill switch for all coordinators on this home
  serve [--port N] [--run]               review interface and API (--run also runs the coordinator)
  gate <subcommand>                      release gate (see docs/operator-guide.md)
  evolve <subcommand>                    improvement experiments

  --home DIR   state directory (default ./var, or SWARM2_HOME)
  Live model execution is off unless SWARM2_LIVE=1.`;

async function main(): Promise<void> {
  if (cmd === 'help' || has('help')) return print(HELP);
  if (cmd === 'serve') {
    const { serve } = await import('./api/server.ts');
    await serve({ home: flag('home'), port: Number(flag('port') ?? 4317), host: flag('host'), run: has('run') });
    return;
  }
  if (cmd === 'gate' || cmd === 'evolve') {
    const { gateCli } = await import('./gate/cli.ts');
    return gateCli(cmd, argv.slice(1), flag('home'));
  }
  const rt = openRuntime({ home: flag('home') });
  const cos = new LocalChiefOfStaff(rt);
  try {
    switch (cmd) {
      case 'init': {
        const m = ensureBaseline(rt);
        return print({ home: rt.paths.home, active_release: rt.registry.active(), manifest: m });
      }
      case 'ingest': {
        ensureBaseline(rt);
        const file = positional(0);
        if (!file) throw new SwarmError('usage', 'ingest needs a requests file');
        const requests = (JSON.parse(readFileSync(file, 'utf8')) as { requests: RawRequest[] }).requests;
        return print(cos.ingestRequests({ command: 'ingestRequests', actor: 'chief_of_staff', key: key('ingest'), data: { requests } }));
      }
      case 'proposals':
        return print(cos.proposals());
      case 'submit': {
        ensureBaseline(rt);
        const title = flag('title');
        const objective = flag('objective');
        if (!title || !objective) throw new SwarmError('usage', 'submit needs --title and --objective');
        return print(
          cos.submitMission({
            command: 'submitMission',
            actor: 'chief_of_staff',
            key: key('submit'),
            data: { title, objective, scenario: flag('scenario') ?? null, request_ids: flag('requests')?.split(',').filter(Boolean) ?? [], priority: Number(flag('priority') ?? 5), provider_mode: has('live') ? 'live' : 'fixture', data_class: has('live') && !flag('scenario') ? 'real' : 'synthetic' },
          }),
        );
      }
      case 'run': {
        ensureBaseline(rt);
        mkdirSync(rt.paths.home, { recursive: true });
        writeFileSync(join(rt.paths.home, 'coordinator.pid'), String(process.pid));
        const co = new Coordinator(rt, { log: (m) => process.stderr.write(`[coordinator] ${m}\n`) });
        const stop = (): void => {
          co.stop();
          process.exit(130);
        };
        process.on('SIGINT', stop);
        process.on('SIGTERM', stop);
        const recovery = co.recover();
        const state = await co.runUntilIdle({ mission_id: flag('mission'), max_ms: Number(flag('max-ms') ?? 300_000) });
        await co.drain();
        return print({ state, recovered: recovery.orphaned_attempts.length, missions: rt.store.missions.where('1=1').map((m) => ({ id: m.id, title: m.title, status: m.status })) });
      }
      case 'status':
        return print(cos.inspectProgress(flag('mission')));
      case 'attention':
        return print(cos.attention());
      case 'decide': {
        const id = positional(0);
        const option = positional(1);
        if (!id || !option) throw new SwarmError('usage', 'decide needs a decision id and an option');
        return print(cos.resolveDecision({ command: 'resolveDecision', actor: flag('actor') ?? 'paul', key: key('decide'), data: { decision_id: id, chosen: option, rationale: flag('rationale') ?? '' } }));
      }
      case 'evidence': {
        const id = positional(0);
        if (!id) throw new SwarmError('usage', 'evidence needs a mission id');
        const ev = cos.retrieveEvidence(id);
        return print(has('md') && ev.source !== 'unavailable' ? (ev.packet_markdown ?? '') : ev);
      }
      case 'priority': {
        const id = positional(0);
        const n = Number(positional(1));
        if (!id || !Number.isFinite(n)) throw new SwarmError('usage', 'priority needs a mission id and a number');
        return print(cos.changePriority({ command: 'changePriority', actor: 'chief_of_staff', key: key('priority'), data: { mission_id: id, priority: n } }));
      }
      case 'cancel': {
        const id = positional(0);
        if (!id) throw new SwarmError('usage', 'cancel needs a mission id');
        const res = cos.cancelMission({ command: 'cancelMission', actor: 'chief_of_staff', key: key('cancel'), data: { mission_id: id, reason: flag('reason') ?? 'cancelled by the operator' } });
        if (res.source !== 'unavailable') for (const pid of res.pids_to_stop) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
        return print(res);
      }
      case 'revise': {
        const [id, artifact, file] = [positional(0), positional(1), positional(2)];
        if (!id || !artifact || !file) throw new SwarmError('usage', 'revise needs a mission id, an artifact key and a file');
        const res = applyUpstreamChange(rt, { command: 'applyUpstreamChange', actor: 'chief_of_staff', key: key('revise'), data: { mission_id: id, key: artifact, content: readFileSync(file, 'utf8'), reason: flag('reason') ?? 'upstream change' } });
        for (const pid of res.pids_to_stop) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
        return print(res);
      }
      case 'connectors': {
        const { connectorStatus } = await import('./connectors/ports.ts');
        return print(connectorStatus());
      }
      case 'export': {
        const { LocalJsonlWarehouse, exportAnalytics } = await import('./connectors/ports.ts');
        const { Gate } = await import('./gate/gate.ts');
        const gate = new Gate(rt);
        try {
          return print(exportAnalytics(rt, gate, new LocalJsonlWarehouse(rt, flag('dir'))));
        } finally {
          gate.close();
        }
      }
      case 'stop': {
        writeFileSync(join(rt.paths.home, 'STOP'), `stopped at ${new Date().toISOString()}\n`);
        const pidFile = join(rt.paths.home, 'coordinator.pid');
        if (existsSync(pidFile)) try { process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGTERM'); } catch { /* not running */ }
        return print({ stopped: true, note: 'Nothing is dispatched while the STOP file exists. Run `swarm2 resume` to clear it.' });
      }
      case 'resume':
        rmSync(join(rt.paths.home, 'STOP'), { force: true });
        return print({ stopped: false });
      default:
        print(HELP);
        process.exitCode = 2;
    }
  } finally {
    rt.close();
  }
}

main().catch((err) => {
  if (err instanceof SwarmError) process.stderr.write(JSON.stringify({ error: err.code, message: err.message, details: err.details }, null, 2) + '\n');
  else process.stderr.write(String(err instanceof Error ? err.stack : err) + '\n');
  process.exit(1);
});
