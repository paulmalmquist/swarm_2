// swarm_2 review interface. No build step, no dependencies.
// Everything shown is read from the API, which reads persisted events and state.
// An unmeasured value is shown as a dash and an unavailable source shows its reason: never a zero.

const BASE = '/v1/os/swarm';
const TOKEN = document.querySelector('meta[name="swarm2-token"]').content;
const $ = (sel, root = document) => root.querySelector(sel);
const main = $('#main');
let view = localStorageGet('view');
let lastSeq = -1;
let overview = null;
let inlineDecisions = new Set();

function localStorageGet(k) {
  try { return localStorage.getItem(`swarm2:${k}`); } catch { return null; }
}
function localStorageSet(k, v) {
  try { localStorage.setItem(`swarm2:${k}`, v); } catch { /* preview or private window */ }
}

// ───────── helpers ─────────

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
const dash = (v) => (v === null || v === undefined || (typeof v === 'number' && Number.isNaN(v)) ? '—' : v);
const num = (v, d = 0) => (v === null || v === undefined ? '—' : Number(v).toLocaleString(undefined, { maximumFractionDigits: d }));
const short = (id) => (id ? String(id).slice(0, 14) : '—');
const ms = (v) => (v === null || v === undefined ? '—' : v < 1000 ? `${Math.round(v)} ms` : `${(v / 1000).toFixed(1)} s`);
const when = (iso) => (iso ? new Date(iso).toLocaleTimeString() : '—');
const ago = (iso) => {
  if (!iso) return '—';
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  return s < 90 ? `${Math.round(s)} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`;
};

// Where the data of the view on screen came from. The header shows this, not a label for the
// whole state directory: a screen of fixture experiments must not read as live work.
let viewSource = null;
async function api(path) {
  const r = await fetch(BASE + path, { cache: 'no-store' });
  const body = await r.json();
  if (['/planning', '/doing', '/reviewing', '/evolution'].includes(path)) viewSource = body.source ?? null;
  return body;
}
async function command(name, data, key) {
  const r = await fetch(`${BASE}/commands`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-swarm2-token': TOKEN }, body: JSON.stringify({ command: name, data, actor: 'paul', key }) });
  const body = await r.json();
  if (!r.ok) throw new Error(body.detail ?? body.code ?? 'the command was refused');
  return body;
}

const SOURCE_LABEL = { live: 'LIVE MODEL EXECUTION', fixture: 'DETERMINISTIC FIXTURE', simulation: 'SIMULATION', replay: 'REPLAY OF A RECORDED RUN', unavailable: 'UNAVAILABLE' };
function provenance(env) {
  return h('span', { class: `chip ${env.source === 'unavailable' ? 'warn' : ''}`, title: 'Where this data came from' }, 'source ', h('b', {}, SOURCE_LABEL[env.source] ?? env.source));
}
function unavailable(env) {
  return h('div', { class: 'banner' }, h('span', { class: 'st warn' }, 'Unavailable'), h('p', { class: 'sec' }, env.reason));
}

function statusOf(t) {
  const person = t.next_action && ['human', 'chief_of_staff', 'operator'].includes(t.next_action.owner_kind);
  if (t.status === 'failed') return ['stop', 'failed'];
  if (t.status === 'blocked') return [person ? 'person' : 'warn', `blocked: ${t.blocked_reason ?? 'waiting'}`];
  if (t.status === 'leased') return ['run', 'working'];
  if (t.status === 'verifying' || t.status === 'submitted') return ['run', 'being verified'];
  if (t.status === 'accepted') return ['done', t.currency === 'current' ? 'accepted' : 'accepted, needs revalidation'];
  if (t.status === 'not_selected') return ['done', 'not selected'];
  if (t.status === 'cancelled') return ['done', 'cancelled'];
  if (t.status === 'active') return ['wait', 'team active'];
  if (t.status === 'ready') return ['wait', 'ready to start'];
  if (t.currency === 'needs_revalidation') return ['warn', 'to be redone'];
  return ['wait', 'waiting on prerequisites'];
}
const st = (cls, text) => h('span', { class: `st ${cls === 'wait' ? '' : cls}` }, text);

function meter(label, used, limit, fmt = num) {
  const pct = limit > 0 ? Math.min(100, (100 * used) / limit) : 0;
  return h('div', { class: 'meter' }, h('span', { class: 'sec', style: 'min-width:150px' }, label), h('div', { class: 'track', role: 'img', 'aria-label': `${label}: ${fmt(used)} of ${fmt(limit)}` }, h('div', { class: 'fill', style: `width:${pct}%` })), h('span', { class: 'num' }, `${fmt(used)} of ${fmt(limit)}`));
}

function cold(a, b) {
  return h('div', { class: 'cold' }, h('p', {}, a), h('p', {}, b));
}

// ───────── decisions ─────────

function decisionBox(item, onDone) {
  const box = h('div', { class: 'need' });
  const form = h('div', {});
  const pick = (opt) => {
    form.replaceChildren(
      h('p', { class: 'small sec', style: 'margin-top:10px' }, `You chose “${opt.label}”. This is recorded with your reason. `, opt.consequences.join(' ')),
      h('textarea', { 'aria-label': 'Reason for this decision', placeholder: 'Why (kept with the decision)' }),
      h('div', { class: 'row', style: 'margin-top:8px' },
        h('button', { class: 'primary', onclick: async (e) => {
          const reason = $('textarea', form).value.trim();
          e.target.disabled = true;
          try {
            if (item.kind === 'draft') await command('reviewDraft', { draft_id: item.id, approve: opt.id === 'approve', note: reason }, `ui-draft-${item.id}-${opt.id}`);
            else await command('resolveDecision', { decision_id: item.id, chosen: opt.id, rationale: reason }, `ui-decide-${item.id}-${opt.id}`);
            onDone();
          } catch (err) {
            form.append(h('p', { class: 'small', role: 'alert' }, h('span', { class: 'st warn' }, String(err.message))));
            e.target.disabled = false;
          }
        } }, 'Record decision'),
        h('button', { class: 'quiet', onclick: () => form.replaceChildren() }, 'Back')),
    );
  };
  box.append(
    h('div', { class: 'who' }, h('span', { class: 'st person' }, `Needs ${item.owner_id === 'chief_of_staff' ? 'you, through the chief of staff' : item.owner_id}`), ` · waiting ${ago(item.created_at)}`),
    h('div', { class: 'q' }, item.title),
    h('p', { class: 'sec small' }, item.what), h('p', { class: 'sec small' }, item.action),
    h('div', { class: 'opts' }, item.options.map((o) => h('button', { onclick: () => pick(o), title: o.consequences.join(' ') }, o.label))),
    h('details', {}, h('summary', { class: 'small sec' }, 'What each option changes'), h('ul', { class: 'conseq' }, item.options.map((o) => h('li', {}, h('b', {}, o.label), ': ', o.consequences.join(' '))))),
    form,
  );
  return box;
}

// ───────── drill-down drawer ─────────

const drawer = $('#drawer');
$('#drawer-close').addEventListener('click', () => drawer.close());
function openDrawer(title, nodes) {
  $('#drawer-title').textContent = title;
  $('#drawer-body').replaceChildren(...nodes.flat().filter(Boolean));
  if (!drawer.open) drawer.showModal();
}
const kv = (pairs) => h('dl', { class: 'kv' }, pairs.filter((p) => p).flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]));

async function showArtifact(versionId) {
  const env = await api(`/artifacts/${encodeURIComponent(versionId)}`);
  if (env.source === 'unavailable') return openDrawer('Artifact', [unavailable(env)]);
  const v = env.version;
  openDrawer(`${v.key} · version ${v.version_no}`, [
    h('div', { class: 'row' }, provenance(env), h('span', { class: 'chip' }, 'currency ', h('b', {}, v.currency.replace(/_/g, ' ')))),
    kv([['Content hash', h('code', {}, v.content_hash)], ['Produced', when(v.created_at)], ['Built from', v.input_manifest.length ? v.input_manifest.map((i) => `${i.artifact_key} (${short(i.version_id)})`).join(', ') : 'no pinned inputs'], ['Supersedes', v.supersedes ? short(v.supersedes) : '—']]),
    env.content === null ? h('p', { class: 'sec' }, env.note) : h('pre', {}, env.content),
  ]);
}

async function showTask(id) {
  const env = await api(`/tasks/${encodeURIComponent(id)}`);
  if (env.source === 'unavailable') return openDrawer('Task', [unavailable(env)]);
  const t = env.task;
  const c = env.contract;
  const [cls, text] = statusOf(t);
  openDrawer(t.title, [
    h('div', { class: 'row' }, st(cls, text), provenance(env), h('span', { class: 'chip' }, 'layer ', h('b', {}, t.depth)), h('span', { class: 'chip' }, 'token ', h('b', {}, `g${t.generation}a${t.attempt}`))),
    t.next_action ? h('p', {}, h('b', {}, 'Next action: '), `${t.next_action.owner_label ?? t.next_action.owner_id} — ${t.next_action.action} (for ${ago(t.next_action.since)})`) : null,
    h('div', { class: 'card' }, h('h4', {}, 'Delegation contract'),
      kv([['Owner', t.owner_label], ['Accountable person', c.accountable_human], ['Objective', c.objective], ['Depends on', env.dependencies.join(', ') || '—'], env.verifies.length ? ['Verifies', env.verifies.join(', ')] : null,
        ['Pinned inputs', c.inputs.length ? c.inputs.map((i) => `${i.artifact_key} @ ${short(i.version_id)}`).join(', ') : '—'], ['May write', c.authority.write_scope.join(', ') || 'nothing'], ['May not', c.authority.forbidden_actions.join(', ')],
        ['Reservation', `${c.resources.reservation.worker_invocations} worker invocations, ${num(c.resources.reservation.tokens)} tokens, ${ms(c.resources.reservation.wall_ms)}`], ['Spent', `${env.budget.spent.worker_invocations} invocations, ${num(env.budget.spent.tokens)} tokens, ${ms(env.budget.spent.wall_ms)}`],
        ['Stops when', c.resources.stopping_conditions.join('; ') || '—'], ['Escalates to', env.escalation_labels.join(' → ')]])),
    h('div', { class: 'card' }, h('h4', {}, 'Acceptance criteria and verification'),
      c.acceptance_criteria.length === 0 ? h('p', { class: 'muted' }, 'None: this task is accepted when its work completes.') : h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, ['Criterion', 'For', 'Verdict', 'Independent', 'Method'].map((x) => h('th', {}, x)))), h('tbody', {}, c.acceptance_criteria.map((cr) => {
        const v = env.verifications.filter((x) => x.criterion_id === cr.criterion_id && x.generation === t.generation).at(-1);
        return h('tr', {}, h('td', {}, h('b', {}, cr.criterion_id), ' ', cr.description, cr.mandatory ? '' : ' (optional)'), h('td', {}, dash(cr.stakeholder)), h('td', {}, v ? st(v.verdict === 'pass' ? 'done' : 'warn', v.verdict) : st('wait', 'not verified')), h('td', {}, v ? (v.independent ? 'yes' : 'no') : '—'), h('td', {}, v ? v.method : cr.verification_kind));
      }))))),
    h('div', { class: 'card' }, h('h4', {}, 'Attempts'), env.attempts.length === 0 ? h('p', { class: 'muted' }, 'Not started.') : h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, ['#', 'Status', 'Provider', 'Model asked / served', 'Process', 'Time', 'Usage'].map((x) => h('th', {}, x)))), h('tbody', {}, env.attempts.map((a) => h('tr', {}, h('td', { class: 'num' }, a.attempt_no), h('td', {}, a.status + (a.error ? ` (${a.error.code})` : '')), h('td', {}, `${a.provider} · ${a.provider_mode}`), h('td', {}, `${dash(a.model_requested)} / ${dash(a.model_actual)}`), h('td', { class: 'num' }, dash(a.pid)), h('td', { class: 'num' }, a.usage ? ms(a.usage.wall_ms) : '—'), h('td', {}, a.usage ? `${dash(a.usage.input_units)} in, ${dash(a.usage.output_units)} out; cost ${a.usage.reported_cost === null ? 'not measured' : `${a.usage.reported_cost} ${a.usage.currency} (${a.usage.cost_basis.replace(/_/g, ' ')})`}` : '—'))))))),
    h('div', { class: 'card' }, h('h4', {}, 'Artifacts'), env.artifacts.length === 0 ? h('p', { class: 'muted' }, 'None.') : h('ul', { class: 'plain' }, env.artifacts.map((a) => h('li', {}, h('a', { tabindex: 0, onclick: () => showArtifact(a.id) }, `${a.key} v${a.version_no}`), ' ', h('span', { class: 'muted small' }, `${a.currency.replace(/_/g, ' ')} · ${a.content_hash.slice(0, 12)}`))))),
    h('details', {}, h('summary', { class: 'sec' }, `Trace (${env.events.length} events)`), h('pre', {}, env.events.map((e) => `#${e.seq} ${when(e.ts)} ${e.type} ${JSON.stringify(e.payload)}`).join('\n'))),
  ]);
}

async function showMission(id) {
  const env = await api(`/missions/${encodeURIComponent(id)}`);
  if (env.source === 'unavailable') return openDrawer('Mission', [unavailable(env)]);
  const m = env.mission;
  openDrawer(m.title, [
    h('div', { class: 'row' }, provenance(env), h('span', { class: 'chip' }, 'release ', h('b', {}, m.release_id)), h('span', { class: 'chip' }, 'data ', h('b', {}, m.data_class))),
    h('p', { class: 'sec' }, m.objective),
    h('div', { class: 'card' }, h('h4', {}, 'Swarms'), h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, ['Swarm', 'Purpose', 'Deliverable', 'Stops when', 'Layer', 'State'].map((x) => h('th', {}, x)))), h('tbody', {}, env.swarms.map((s) => h('tr', {}, h('td', {}, s.archetype + (s.temporary ? ' (temporary team)' : '')), h('td', {}, s.purpose), h('td', {}, s.deliverable), h('td', {}, s.stopping_condition), h('td', { class: 'num' }, s.depth), h('td', {}, s.status))))))),
    h('div', { class: 'card' }, h('h4', {}, 'Tasks'), h('ul', { class: 'plain' }, env.lineage.tasks.map((t) => h('li', {}, h('a', { tabindex: 0, onclick: () => showTaskByKey(m.id, t.key) }, t.key), ' ', h('span', { class: 'muted small' }, `${t.status} · ${t.artifacts.length} artifacts · ${t.verifications.filter((v) => v.verdict === 'pass').length}/${t.verifications.length} verifications passed`))))),
    env.needs.length ? h('div', { class: 'card' }, h('h4', {}, 'Stakeholder needs'), h('ul', { class: 'plain' }, env.needs.map((n) => h('li', {}, h('b', {}, n.stakeholder), `: ${n.need} → ${dash(n.criterion_id)} `, st(n.status === 'satisfied' ? 'done' : 'wait', n.status))))) : null,
    h('div', { class: 'card' }, h('h4', {}, 'Coordination cost'), kv([['Messages', num(env.communication.messages)], ['Message bytes', num(env.communication.bytes)], ['Handoffs', `${env.handoffs.length} (${env.handoffs.filter((x) => x.status === 'accepted').length} accepted)`], ['Integration merges', `${env.integration.filter((i) => i.status === 'merged').length} merged, ${env.integration.filter((i) => ['rejected', 'conflict'].includes(i.status)).length} failed`]])),
  ]);
}
async function showTaskByKey(missionId, key) {
  const env = await api(`/ownership?mission=${encodeURIComponent(missionId)}`);
  const node = env.missions?.[0]?.nodes.find((n) => n.key === key);
  if (node) showTask(node.id);
}

// ───────── ownership graph ─────────

function ownershipGraph(mission) {
  const nodes = mission.nodes;
  const byParent = new Map();
  for (const n of nodes) byParent.set(n.parent_task_id ?? '', [...(byParent.get(n.parent_task_id ?? '') ?? []), n]);
  const W = 208, H = 34, GX = 26, GY = 8;
  const placed = [];
  let row = 0;
  const walk = (n, depth) => {
    const kids = byParent.get(n.id) ?? [];
    const start = row;
    if (kids.length === 0) row++;
    else kids.forEach((k) => walk(k, depth + 1));
    const y = kids.length === 0 ? start : (start + row - 1) / 2;
    placed.push({ n, depth, y });
  };
  const roots = byParent.get('') ?? [];
  roots.forEach((r) => walk(r, 1));
  const rootY = roots.length ? (row - 1) / 2 : 0;
  const maxDepth = Math.max(1, ...placed.map((p) => p.depth));
  const width = (maxDepth + 1) * (W + GX);
  const height = Math.max(1, row) * (H + GY) + 4;
  const NS = 'http://www.w3.org/2000/svg';
  const s = (tag, attrs, ...kids) => {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    el.append(...kids);
    return el;
  };
  const svg = s('svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': `Ownership graph for ${mission.title}` });
  const pos = new Map(placed.map((p) => [p.n.id, { x: p.depth * (W + GX), y: p.y * (H + GY) + 2 }]));
  const rootPos = { x: 0, y: rootY * (H + GY) + 2 };
  for (const p of placed) {
    const a = p.n.parent_task_id ? pos.get(p.n.parent_task_id) : rootPos;
    const b = pos.get(p.n.id);
    if (!a) continue;
    const mx = a.x + W + GX / 2;
    svg.append(s('path', { class: 'edge', d: `M${a.x + W},${a.y + H / 2} H${mx} V${b.y + H / 2} H${b.x}` }));
  }
  const person = mission.human_actions.length > 0;
  const drawNode = (x, y, cls, label, sub, tip, onclick) => {
    const g = s('g', { class: `node ${cls}`, transform: `translate(${x},${y})`, tabindex: 0, role: 'button' });
    const t = s('title', {});
    t.textContent = tip;
    const mark = cls === 'person' ? s('rect', { class: 'm-person', x: 9, y: 12, width: 9, height: 9, transform: 'rotate(45 13.5 16.5)' }) : cls === 'warn' ? s('path', { class: 'm-warn', d: 'M8,22 L14,11 L20,22 Z' }) : cls === 'stop' ? s('rect', { class: 'm-stop', x: 9, y: 12, width: 10, height: 10 }) : s('circle', { class: cls === 'run' ? 'm-run pulse' : cls === 'done' ? 'm-done' : 'm-wait', cx: 14, cy: 17, r: 4.5 });
    const t1 = s('text', { x: 26, y: 15 });
    t1.textContent = label.length > 27 ? label.slice(0, 26) + '…' : label;
    const t2 = s('text', { class: 'o', x: 26, y: 27 });
    t2.textContent = sub.length > 34 ? sub.slice(0, 33) + '…' : sub;
    g.append(t, s('rect', { width: W, height: H }), mark, t1, t2);
    g.addEventListener('click', onclick);
    g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onclick(); } });
    svg.append(g);
  };
  drawNode(rootPos.x, rootPos.y, person ? 'person' : mission.status === 'blocked' ? 'warn' : 'wait', mission.title, person ? `needs ${mission.accountable_human}: a decision` : `accountable: ${mission.accountable_human}`, person ? mission.human_actions.map((a) => a.question).join(' / ') : `Mission is ${mission.status}`, () => showMission(mission.id));
  for (const p of placed) {
    const [cls, text] = statusOf(p.n);
    const { x, y } = pos.get(p.n.id);
    const leaf = p.n.key.split('.').slice(-1)[0];
    const label = p.n.executor === 'container' ? `${p.n.archetype} swarm` + (p.depth > 1 ? `: ${leaf}` : '') : p.n.key.split('.').slice(-2).join('.');
    const sub = p.n.next_action && !['accepted', 'cancelled', 'not_selected'].includes(p.n.status) ? `${text} · ${p.n.next_action.owner_kind === 'agent' ? p.n.owner_label : p.n.next_action.owner_id}` : `${text} · ${p.n.owner_label}`;
    drawNode(x, y, cls, label, sub, `${p.n.title}\n${text}\nOwner: ${p.n.owner_label}${p.n.next_action ? `\nNext: ${p.n.next_action.owner_id} — ${p.n.next_action.action}` : ''}`, () => showTask(p.n.id));
  }
  return h('div', {}, h('div', { class: 'graph' }, svg), h('div', { class: 'legend' }, st('person', 'needs a person'), st('run', 'being worked on or verified'), st('warn', 'blocked or to be redone'), st('stop', 'failed'), st('done', 'accepted'), st('wait', 'waiting')));
}

// ───────── views ─────────

async function renderPlanning() {
  const env = await api('/planning');
  if (env.source === 'unavailable') return [unavailable(env)];
  const live = overview?.limits?.live_execution_enabled && overview?.providers?.live?.ok;
  return [
    cold('This screen shows what could be worked on next and what is waiting to start.', 'Submitting a proposed mission reserves budget and starts work. A mission can be cancelled; its artifacts are kept.'),
    h('div', { class: 'grid two' },
      h('div', { class: 'card' }, h('h3', {}, 'Proposed missions'),
        env.proposals.length === 0 ? h('p', { class: 'empty' }, `No overlapping requests are waiting. ${env.requests_total} requests have been received.`) : env.proposals.map((p) => h('div', {},
          h('p', {}, h('b', {}, p.title)), h('p', { class: 'small sec' }, p.basis),
          h('ul', { class: 'plain' }, p.requests.map((r) => h('li', {}, h('span', { class: 'label' }, `${r.team} · ${r.source}${r.data_class === 'synthetic' ? ' · synthetic' : ''}`), h('p', { class: 'small' }, r.text)))),
          h('div', { class: 'row', style: 'margin-top:10px' },
            h('button', { class: 'primary', onclick: async (e) => { e.target.disabled = true; try { await command('submitMission', { title: 'Shared dataset-health capability', objective: 'Give every team one policy-driven way to see which datasets are stale, drifting or unmeasured, and who owns them.', request_ids: p.request_ids, scenario: 'shared-capability', priority: 2 }, `ui-submit-${p.cluster_id}`); refresh(true); } catch (err) { alert(err.message); e.target.disabled = false; } } }, 'Submit as a mission'),
            h('span', { class: 'small muted' }, live ? 'Runs on the fixture provider. Use the command line for a live run.' : 'Runs on the deterministic fixture provider. Live model execution is off.'))))),
      h('div', { class: 'card' }, h('h3', {}, 'Waiting to start'),
        env.missions.length === 0 ? h('p', { class: 'empty' }, 'Nothing is queued.') : h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, ['Priority', 'Mission', 'Release', 'Budget'].map((x) => h('th', {}, x)))), h('tbody', {}, env.missions.map((m) => h('tr', {}, h('td', {}, h('input', { type: 'number', value: m.priority, style: 'width:64px', 'aria-label': `Priority of ${m.title}`, onchange: async (e) => { try { await command('changePriority', { mission_id: m.id, priority: Number(e.target.value) }, `ui-priority-${m.id}-${e.target.value}-${m.revision}`); refresh(true); } catch (err) { alert(err.message); } } })), h('td', {}, h('a', { tabindex: 0, onclick: () => showMission(m.id) }, m.title), h('div', { class: 'small muted' }, `${m.status} · ${m.provider_mode} · ${m.data_class} data`)), h('td', {}, m.release_id), h('td', { class: 'num' }, `${m.budget.worker_invocations} invocations`)))))),
        h('h4', {}, 'Requests not yet grouped'), env.unassigned_requests.length === 0 ? h('p', { class: 'muted small' }, 'None.') : h('ul', { class: 'plain' }, env.unassigned_requests.map((r) => h('li', {}, h('span', { class: 'label' }, `${r.team} · ${r.source}`), h('p', { class: 'small' }, r.text))))),
    ),
    env.decisions.length ? h('div', { class: 'card', style: 'margin-top:14px' }, h('h3', {}, 'Decisions that shape what happens next'), h('ul', { class: 'plain' }, env.decisions.map((d) => h('li', {}, st('person', d.kind.replace(/_/g, ' ')), ' ', d.question)))) : null,
  ];
}

async function renderDoing() {
  const [env, own] = await Promise.all([api('/doing'), api('/ownership')]);
  if (env.source === 'unavailable') return [unavailable(env)];
  const out = [cold('This screen shows work in progress and whose move is next.', 'Nothing here needs you unless a row is marked “needs a person”. Select any box to see its contract, attempts and evidence.')];
  if (env.missions.length === 0 && own.missions.length === 0) out.push(h('p', { class: 'empty' }, 'No mission is active. Nothing is running, and nothing is animated to suggest otherwise.'));
  const idle = own.missions.filter((m) => m.nodes.length === 0);
  for (const m of own.missions.filter((x) => x.nodes.length > 0)) {
    const d = env.missions.find((x) => x.id === m.id);
    out.push(h('div', { class: 'card', style: 'margin-bottom:14px' },
      h('div', { class: 'row spread' }, h('h3', {}, h('a', { tabindex: 0, onclick: () => showMission(m.id) }, m.title)), h('div', { class: 'row' }, h('span', { class: 'chip' }, 'status ', h('b', {}, m.status.replace(/_/g, ' '))), d ? h('span', { class: 'chip' }, 'release ', h('b', {}, d.release_id)) : null, d ? h('span', { class: 'chip' }, h('b', {}, `${d.provider_mode} · ${d.data_class} data`)) : null)),
      d?.migration?.required ? h('div', { class: 'banner', style: 'margin-top:10px' }, st('warn', 'Migration decision needed'), h('p', { class: 'small sec' }, d.migration.reason)) : null,
      d ? h('div', { class: 'grid two', style: 'margin:12px 0' },
        h('div', {}, h('p', {}, h('b', {}, 'Next action: '), d.next_action ? `${d.next_action.owner_label ?? d.next_action.owner_id} — ${d.next_action.action}` : 'none pending'), h('p', { class: 'small sec' }, `Accountable: ${d.accountable_human}. ${d.progress.accepted} of ${d.progress.total} tasks accepted.`),
          d.blockers.length ? h('ul', { class: 'plain' }, d.blockers.map((b) => h('li', {}, st(b.owner_kind === 'agent' ? 'warn' : 'person', `blocked: ${b.reason}`), ` ${b.title} — waiting on ${dash(b.owner_label ?? b.owner_id)}`))) : h('p', { class: 'small muted' }, 'No blockers.'),
          h('p', { class: 'small sec' }, 'Critical path: ', d.critical_path.keys.length ? d.critical_path.keys.join(' → ') : '—', d.critical_path.wait_ms === null ? '' : ` (waited ${ms(d.critical_path.wait_ms)} for an owner)`)),
        h('div', {}, meter('Worker invocations', d.spent.worker_invocations, d.budget.worker_invocations), meter('Worker time', d.spent.wall_ms, d.budget.wall_ms, ms), meter('Tokens', d.spent.tokens, d.budget.tokens),
          h('p', { class: 'small muted' }, d.spent.cost_usd_est > 0 ? `Cost estimate ${d.spent.cost_usd_est.toFixed(4)} USD at list prices; not a bill.` : d.provider_mode === 'live' ? 'No cost reported yet.' : 'Cost not measured: the fixture provider makes no model calls.'),
          d.unreported_usage_attempts ? h('p', { class: 'small sec' }, st('warn', 'Lower bound'), ` ${d.unreported_usage_attempts} model attempt${d.unreported_usage_attempts === 1 ? '' : 's'} ended without reporting usage, so tokens and cost are at least what is shown.`) : null)) : null,
      h('h4', {}, 'Ownership'), ownershipGraph(m),
      d && d.artifacts.length ? h('details', { style: 'margin-top:10px' }, h('summary', { class: 'sec' }, `Current artifacts (${d.artifacts.length})`), h('ul', { class: 'plain' }, d.artifacts.map((a) => h('li', {}, h('a', { tabindex: 0, onclick: () => showArtifact(a.id) }, `${a.key} v${a.version_no}`), ' ', h('span', { class: 'muted small' }, `${a.kind}${a.produced_by ? ` · from ${a.produced_by}` : ''}`))))) : null,
      h('details', { style: 'margin-top:6px' }, h('summary', { class: 'sec' }, 'Same information as a table'), h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, ['Task', 'State', 'Owner', 'Next action'].map((x) => h('th', {}, x)))), h('tbody', {}, m.nodes.map((n) => { const [cls, text] = statusOf(n); return h('tr', {}, h('td', {}, h('a', { tabindex: 0, onclick: () => showTask(n.id) }, n.key)), h('td', {}, st(cls, text)), h('td', {}, n.owner_label), h('td', {}, n.next_action ? `${n.next_action.owner_id}: ${n.next_action.action}` : '—')); }))))),
    ));
  }
  if (idle.length) {
    out.push(h('div', { class: 'card' }, h('h3', {}, 'Submitted, no work started'), h('p', { class: 'small sec' }, 'These missions are waiting for a coordinator to pick them up. Nothing is running for them.'),
      h('ul', { class: 'plain' }, idle.map((m) => { const d = env.missions.find((x) => x.id === m.id); return h('li', {}, m.human_actions.length ? st('person', `needs ${m.accountable_human}`) : st('wait', 'waiting'), ' ', h('a', { tabindex: 0, onclick: () => showMission(m.id) }, m.title), ' ', h('span', { class: 'muted small' }, d ? `release ${d.release_id} · priority ${d.priority}` : ''), d?.migration?.required ? h('div', { class: 'small sec' }, d.migration.reason) : ''); }))));
  }
  return out;
}

async function renderReviewing() {
  const env = await api('/reviewing');
  if (env.source === 'unavailable') return [unavailable(env)];
  const out = [cold('This screen shows finished work waiting for your decision.', 'Approving records your decision and marks the draft approved. Nothing is merged or sent by the system.')];
  inlineDecisions = new Set(env.ready.map((r) => r.decision?.id).filter(Boolean));
  if (env.ready.length === 0) out.push(h('p', { class: 'empty' }, 'Nothing is waiting for review.'));
  for (const r of env.ready) {
    const p = r.packet;
    if (!p) { out.push(h('div', { class: 'card' }, h('h3', {}, r.title), unavailable({ reason: r.packet_unavailable }))); continue; }
    out.push(h('div', { class: 'card', style: 'margin-bottom:14px' },
      h('div', { class: 'row spread' }, h('h3', {}, h('a', { tabindex: 0, onclick: () => showMission(r.id) }, p.title)), h('div', { class: 'row' }, h('span', { class: 'chip' }, h('b', {}, p.provider_mode === 'fixture' ? 'DETERMINISTIC FIXTURE RUN' : 'LIVE MODEL EXECUTION')), h('span', { class: 'chip' }, h('b', {}, `${p.data_class} data`)), h('span', { class: 'chip' }, 'release ', h('b', {}, p.release_id)))),
      h('p', { style: 'margin-top:8px' }, p.cold_read[0]), h('p', { class: 'sec' }, p.cold_read[1]),
      h('h4', {}, 'Context'), h('p', { class: 'sec' }, p.context),
      p.requests.length ? [h('h4', {}, 'Each stakeholder\u2019s need, kept distinct'), h('ul', { class: 'plain' }, p.overlap.distinct_needs.map((n) => { const out = n.status === 'deferred' || n.status === 'open'; return h('li', {}, out ? st('warn', 'not covered') : '', out ? ' ' : '', h('b', {}, n.stakeholder), `: ${n.need} `, h('span', { class: 'muted small' }, out ? 'This result does not address it.' : `→ ${dash(n.criterion_id)} · ${n.status}`)); }))] : null,
      h('h4', {}, 'Exact changes'), p.exact_changes ? [h('p', { class: 'small sec' }, `Integration branch, ${short(p.exact_changes.base_commit)} → ${short(p.exact_changes.head_commit)}`), h('ul', { class: 'plain' }, p.exact_changes.files.map((f) => h('li', { class: 'small mono' }, `${f.status}  ${f.path}`)))] : h('p', { class: 'muted' }, 'No code changes.'),
      h('h4', {}, 'Acceptance evidence'), h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, ['Criterion', 'For', 'Verdict', 'Independent'].map((x) => h('th', {}, x)))), h('tbody', {}, p.acceptance.map((a) => h('tr', {}, h('td', {}, h('b', {}, a.criterion_id), ' ', a.description), h('td', {}, dash(a.stakeholder)), h('td', {}, st(a.verdict === 'pass' ? 'done' : 'warn', a.verdict)), h('td', {}, a.independent ? 'yes' : 'no')))))),
      h('h4', {}, 'Remaining concerns'), concernsBlock(p.remaining_concerns),
      h('h4', {}, 'Resource use'), h('p', { class: 'small sec' }, `${p.resource_use.worker_invocations} worker invocations, ${p.resource_use.model_calls} model calls, ${num(p.resource_use.tokens)} tokens, ${ms(p.resource_use.wall_ms)} of worker time. Cost: ${p.resource_use.cost_basis === 'none' ? 'not measured' : `${p.resource_use.cost_usd_est} USD (list-price estimate, not billing)`}.${p.resource_use.unreported_attempts ? ` ${p.resource_use.unreported_attempts} model attempt(s) ended without reporting usage: tokens and cost are lower bounds.` : ''}`),
      r.draft ? h('details', {}, h('summary', { class: 'sec' }, `Draft in final form: ${r.draft.title} (${r.draft.status.replace(/_/g, ' ')})`), h('p', { class: 'small muted' }, `For ${r.draft.audience}. Kind: ${r.draft.kind}. Supporting context: ${r.draft.context_refs.join(', ')}`), h('pre', {}, r.draft.body)) : null,
      r.decision && ['open', 'escalated'].includes(r.decision.status) ? decisionBox({ kind: 'decision', id: r.decision.id, title: r.decision.question, what: 'This is the decision the packet asks for.', action: 'Choose one option. It is recorded with your reason.', options: r.decision.options, owner_id: 'chief_of_staff', created_at: p.generated_at }, () => refresh(true)) : null,
    ));
  }
  out.push(h('div', { class: 'card' }, h('h3', {}, 'Closed'), env.history.length === 0 ? h('p', { class: 'empty' }, 'No mission has closed yet.') : h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, ['Mission', 'Outcome', 'Verified + approved', 'Rework', 'Recovery events', 'Time', 'Release'].map((x) => h('th', {}, x)))), h('tbody', {}, env.history.map((m) => h('tr', {}, h('td', {}, h('a', { tabindex: 0, onclick: () => showMission(m.id) }, m.title)), h('td', {}, m.status + (m.cancel_reason ? `: ${m.cancel_reason}` : '')), h('td', {}, m.outcome ? (m.outcome.verified_success ? 'yes' : 'no') : '—'), h('td', { class: 'num' }, dash(m.outcome?.rework_count)), h('td', { class: 'num' }, dash(m.outcome?.recovery_events)), h('td', { class: 'num' }, m.outcome ? ms(m.outcome.elapsed_ms) : '—'), h('td', {}, m.release_id))))))));
  return out;
}

function intervalPlot(comparisons) {
  const rows = comparisons.filter((c) => c.diff_vs_incumbent !== null);
  const NS = 'http://www.w3.org/2000/svg';
  const out = h('div', { class: 'ivl', role: 'group', 'aria-label': 'Difference between candidate and incumbent, with 95% interval, one metric per row' });
  for (const c of rows) {
    const lo = c.ci95_vs_incumbent ? c.ci95_vs_incumbent[0] : c.diff_vs_incumbent;
    const hi = c.ci95_vs_incumbent ? c.ci95_vs_incumbent[1] : c.diff_vs_incumbent;
    const span = Math.max(Math.abs(lo), Math.abs(hi), 1e-9) * 1.25;
    const x = (v) => 50 + (v / span) * 46;
    const better = c.higher_is_better ? lo > 0 : hi < 0;
    const worse = c.higher_is_better ? hi < 0 : lo > 0;
    const verdict = !c.ci95_vs_incumbent ? 'no interval' : lo === hi ? (lo === 0 ? 'no change' : better ? 'better' : 'worse') : better ? 'better' : worse ? 'worse' : 'not demonstrated';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 100 26');
    svg.setAttribute('preserveAspectRatio', 'none');
    const line = (cls, x1, y1, x2, y2) => { const l = document.createElementNS(NS, 'line'); l.setAttribute('class', cls); l.setAttribute('x1', x1); l.setAttribute('y1', y1); l.setAttribute('x2', x2); l.setAttribute('y2', y2); l.setAttribute('vector-effect', 'non-scaling-stroke'); return l; };
    svg.append(line('base', 2, 13, 98, 13), line('zero', 50, 3, 50, 23), line('bar', x(lo), 13, x(hi), 13));
    const dotWrap = h('div', { style: `position:absolute;left:${x(c.diff_vs_incumbent)}%;top:50%;width:10px;height:10px;margin:-5px 0 0 -5px;border-radius:50%;background:var(--progress);box-shadow:0 0 0 2px var(--surface)` });
    const axis = h('div', { class: 'axis', title: `${c.metric}: difference ${c.diff_vs_incumbent}${c.ci95_vs_incumbent ? `, 95% interval ${lo} to ${hi}` : ''}. ${c.method}` }, svg, dotWrap);
    out.append(h('div', {}, h('b', {}, c.metric.replace(/_/g, ' ')), h('div', { class: 'small muted' }, `${c.higher_is_better ? 'higher' : 'lower'} is better`)), axis, h('div', { class: 'num small' }, `${c.diff_vs_incumbent > 0 ? '+' : ''}${c.diff_vs_incumbent}`, c.ci95_vs_incumbent && lo !== hi ? ` (${lo} to ${hi})` : '', h('div', { class: 'sec' }, verdict)));
  }
  return h('div', {}, out, h('p', { class: 'small muted', style: 'margin-top:8px' }, 'Each row has its own scale. The vertical line is “no difference”; the bar is the 95% interval of candidate minus incumbent.'));
}

async function showReceipt(id) {
  const env = await api(`/receipts/${encodeURIComponent(id)}`);
  if (env.source === 'unavailable') return openDrawer('Receipt', [unavailable(env)]);
  const r = env.receipt;
  openDrawer(`Improvement receipt · ${r.decision}`, [
    h('div', { class: 'row' }, provenance(env), h('span', { class: 'chip' }, 'level ', h('b', {}, r.level)), h('span', { class: `chip ${r.isolation.mode === 'enforced' ? '' : 'warn'}` }, 'isolation ', h('b', {}, r.isolation.mode)), h('span', { class: 'chip' }, 'held-out set ', h('b', {}, r.evaluation.holdout_set))),
    h('p', {}, h('b', {}, r.decision.toUpperCase() + ': '), r.justification),
    h('div', { class: 'card' }, h('h4', {}, 'Problem'), h('p', { class: 'sec' }, r.problem.statement), h('p', { class: 'small muted' }, `${r.problem.observed_failure_count} verified failure observations cited.`), h('h4', {}, 'Hypothesis'), h('p', { class: 'sec' }, r.hypothesis), h('h4', {}, 'Regressions it said were possible'), h('ul', { class: 'conseq' }, r.possible_regressions.map((x) => h('li', {}, x)))),
    h('div', { class: 'card' }, h('h4', {}, 'Before and after'), h('p', { class: 'sec small' }, `${r.parent.component} v${r.parent.version} → candidate. ${r.change.summary}`), h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, ['File', 'Before', 'After'].map((x) => h('th', {}, x)))), h('tbody', {}, r.change.files.map((f) => h('tr', {}, h('td', { class: 'mono' }, f.path), h('td', { class: 'mono' }, f.before_hash ? f.before_hash.slice(0, 12) : 'new'), h('td', { class: 'mono' }, f.after_hash ? f.after_hash.slice(0, 12) : 'removed'))))))),
    h('div', { class: 'card' }, h('h4', {}, 'Candidate against incumbent'), r.comparisons.length ? intervalPlot(r.comparisons) : h('p', { class: 'muted' }, 'Not measured: the candidate was not executed on held-out cases.'),
      r.comparisons.length ? h('details', { style: 'margin-top:8px' }, h('summary', { class: 'sec' }, 'Values as a table'), h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, ['Metric', 'Candidate', 'Incumbent', 'Original baseline', 'Difference', '95% interval', 'n'].map((x) => h('th', {}, x)))), h('tbody', {}, r.comparisons.map((c) => h('tr', {}, h('td', {}, c.metric.replace(/_/g, ' '), h('div', { class: 'small muted' }, c.unit)), h('td', { class: 'num' }, dash(c.candidate)), h('td', { class: 'num' }, dash(c.incumbent)), h('td', { class: 'num' }, dash(c.baseline)), h('td', { class: 'num' }, dash(c.diff_vs_incumbent)), h('td', { class: 'num' }, c.ci95_vs_incumbent ? `${c.ci95_vs_incumbent[0]} to ${c.ci95_vs_incumbent[1]}` : '—'), h('td', { class: 'num' }, c.n))))))) : null),
    h('div', { class: 'card' }, h('h4', {}, 'Gates'), h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, ['Gate', 'Kind', 'Verdict', 'Meaning'].map((x) => h('th', {}, x)))), h('tbody', {}, r.gates.map((g) => h('tr', {}, h('td', {}, g.name), h('td', {}, g.kind === 'HARD_GATE' ? 'hard' : `weighted ${g.weight}`), h('td', {}, st(g.verdict === 'PASSED' ? 'done' : g.verdict === 'FAILED' ? (g.kind === 'HARD_GATE' ? 'stop' : 'warn') : 'wait', g.verdict.toLowerCase())), h('td', { class: 'small sec' }, g.meaning))))))),
    h('div', { class: 'card' }, h('h4', {}, 'Known regressions'), r.known_regressions.length ? h('ul', { class: 'conseq' }, r.known_regressions.map((x) => h('li', {}, x))) : h('p', { class: 'muted' }, 'None observed.'), h('h4', {}, 'Limitations'), h('ul', { class: 'conseq' }, r.limitations.map((x) => h('li', {}, x))), h('h4', {}, 'Attempts'), h('ul', { class: 'conseq' }, r.attempts.map((a) => h('li', {}, `${a.kind}: ${a.cases} cases — ${a.note}`))), h('h4', {}, 'Isolation'), h('ul', { class: 'conseq' }, [`Protected store intact before and after: ${r.isolation.intact ? 'yes' : 'no'}`, ...r.isolation.notes].map((x) => h('li', {}, x)))),
    r.release_manifest ? h('div', { class: 'card' }, h('h4', {}, 'Release manifest'), kv([['Release', `${r.release_manifest.release_id} (${r.release_manifest.status.replace(/_/g, ' ')})`], ['Execution', `v${r.release_manifest.components.execution.version}`], ['Coordination', `v${r.release_manifest.components.coordination.version}`], ['Evolution', `v${r.release_manifest.components.evolution.version}`], ['Rollback target', r.rollback_target], ['Evidence basis', r.release_manifest.evidence_basis]])) : h('p', { class: 'muted' }, 'No release was created. The candidate and this result are kept.'),
    h('p', { class: 'small muted mono' }, `receipt ${r.receipt_id} · hash ${r.receipt_hash.slice(0, 24)}`),
  ]);
}

// What a reviewer must not miss comes first; what workers said they were unsure of is one click away.
function concernsBlock(all) {
  if (!all.length) return h('p', { class: 'muted' }, 'None recorded.');
  const stated = all.filter((c) => c.startsWith('Stated by the worker on '));
  const first = all.filter((c) => !c.startsWith('Stated by the worker on '));
  // Packets written before concerns were labeled carry no prefix: show the first few and fold the rest.
  const lead = stated.length ? first : all.slice(0, 6);
  const rest = stated.length ? stated : all.slice(6);
  return h('div', {},
    lead.length ? h('ul', { class: 'conseq' }, lead.map((c) => h('li', {}, c))) : h('p', { class: 'muted small' }, 'No unmet need and no open question.'),
    rest.length ? h('details', {}, h('summary', {}, stated.length ? `What the workers said they were unsure of (${rest.length})` : `${rest.length} more`), h('ul', { class: 'conseq' }, rest.map((c) => h('li', {}, c.replace(/^Stated by the worker on ([^:]+): /, '$1 — '))))) : '');
}

function portfolioCard(env) {
  const pf = env.portfolio;
  const ex = env.exploration;
  if (!pf) return '';
  const mark = (s) => (s === 'accepted' ? st('run', 'accepted') : s === 'rejected' ? st('stop', 'rejected') : s === 'inconclusive' ? st('warn', 'inconclusive') : s === 'dropped' ? st('done', 'dropped') : s === 'proposed' ? st('wait', 'proposed') : st('person', s));
  const open = pf.problems.filter((p) => !p.resolved);
  const used = Number.isFinite(ex.budget) ? `${ex.spent.toLocaleString('en-US')} of ${ex.budget.toLocaleString('en-US')} experiment units used at the release gate` : `${ex.spent.toLocaleString('en-US')} experiment units used at the release gate`;
  return h('div', { class: 'card', style: 'margin-top:14px' }, h('h3', {}, 'Improvement work in hand'),
    h('p', { class: 'small sec' }, `Decided by the improvement policy of ${pf.policy.release_id} (evolution version ${pf.policy.evolution_version}${pf.policy.canary_id ? ', in a canary' : ''}): ${pf.policy.prioritization} ${used}.`),
    h('div', { class: 'grid two' },
      h('div', {}, h('h4', {}, 'Open problems'),
        open.length === 0 ? h('p', { class: 'empty' }, 'No failures are recorded under the release in force. Observing comes first: `swarm2 evolve observe`.') : h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Failure class'), h('th', { class: 'num' }, 'Verified'), h('th', { class: 'num' }, 'Unverified reports'), h('th', { class: 'num' }, 'Severity'))), h('tbody', {}, open.map((p) => h('tr', {}, h('td', {}, p.id.replace(/_/g, ' ')), h('td', { class: 'num' }, p.verified_count), h('td', { class: 'num' }, p.observed_count - p.verified_count), h('td', { class: 'num' }, p.verified_count ? Math.round(p.severity * 10) / 10 : '—'))))))),
      h('div', {}, h('h4', {}, 'Hypotheses'),
        h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Candidate fix'), h('th', {}, 'State'), h('th', {}, 'Pilot'), h('th', { class: 'num' }, 'Units'), h('th', {}, ''))), h('tbody', {}, pf.hypotheses.map((x) => h('tr', {}, h('td', {}, h('b', {}, x.id.replace(/_/g, ' ')), h('div', { class: 'small muted' }, x.problem_ids.join(', ').replace(/_/g, ' '))), h('td', {}, mark(x.status)), h('td', { class: 'small' }, x.pilot ? `fixed ${x.pilot.fixed} of ${x.pilot.attempted}, broke ${x.pilot.broke}` : '—'), h('td', { class: 'num' }, x.cost_so_far), h('td', {}, x.receipt_id ? h('button', { onclick: () => showReceipt(x.receipt_id) }, 'Receipt') : ''))))))),
    ),
    pf.steps.length ? h('details', { style: 'margin-top:10px' }, h('summary', {}, `${pf.steps.length} decisions taken by the policy`), h('ol', { class: 'small' }, pf.steps.map((x) => h('li', {}, h('b', {}, `${x.action.type}${x.action.candidate_id ? ' ' + x.action.candidate_id.replace(/_/g, ' ') : ''}`), ` — ${x.outcome} `, h('span', { class: 'muted' }, `(${x.cost} units, policy ${x.policy.id})`))))) : h('p', { class: 'small muted' }, 'The policy has taken no decision yet. `swarm2 evolve step` asks it for one.'),
    h('p', { class: 'small muted' }, pf.limitation));
}

async function renderEvolution() {
  const env = await api('/evolution');
  if (env.source === 'unavailable') return [unavailable(env)];
  const o = env.organization;
  const verdictMark = (d) => (d === 'accept' ? st('run', 'accepted') : d === 'reject' ? st('stop', 'rejected') : d === 'inconclusive' ? st('warn', 'inconclusive') : st('wait', 'not decided'));
  const lineageOf = (e) => (e.revises ? `revises ${env.experiments.find((x) => x.id === e.revises)?.candidate?.candidate_id ?? short(e.revises)}` : 'new line of work');
  return [
    cold('This screen shows how the organization is changing itself, and on what evidence.', 'A change reaches future work only if the release gate accepts it and a bounded canary survives. Nothing here is changed by viewing it.'),
    h('div', { class: 'grid two' },
      h('div', { class: 'card' }, h('h3', {}, 'Current organization'),
        kv([['Active release', h('b', {}, o.active_release)], ['Execution', `version ${o.components.execution.version}`], ['Coordination', `version ${o.components.coordination.version}`], ['Evolution', `version ${o.components.evolution.version}`], ['Original baseline', o.baseline_release],
          ['Separation', h('span', {}, st(o.isolation.mode === 'enforced' ? 'done' : 'warn', o.isolation.mode), ' ', h('span', { class: 'small sec' }, o.isolation.notes.join(' ')))],
          ['Rules and records', st(o.integrity.ok && o.ledger.ok ? 'done' : 'stop', o.integrity.ok && o.ledger.ok ? `intact (${o.ledger.count} ledger entries)` : 'changed outside the authorized path')]]),
        h('h4', {}, 'Swarm capabilities'), h('ul', { class: 'plain' }, o.archetypes.map((a) => h('li', {}, h('b', {}, a.name), h('div', { class: 'small sec' }, a.responsibility))))),
      h('div', { class: 'card' }, h('h3', {}, 'Releases'),
        h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, ['Release', 'State', 'Exec', 'Coord', 'Evo', 'Evidence', 'Missions pinned'].map((x) => h('th', {}, x)))), h('tbody', {}, env.releases.map((m) => h('tr', {}, h('td', {}, h('b', {}, m.release_id), m.parent_release_id ? h('div', { class: 'small muted' }, `from ${m.parent_release_id}`) : ''), h('td', {}, st(m.status === 'active' ? 'run' : m.status === 'rolled_back' ? 'warn' : m.status === 'canary' ? 'person' : 'done', m.status.replace(/_/g, ' '))), h('td', { class: 'num' }, `v${m.components.execution.version}`), h('td', { class: 'num' }, `v${m.components.coordination.version}`), h('td', { class: 'num' }, `v${m.components.evolution.version}`), h('td', {}, m.evidence_basis), h('td', { class: 'num' }, m.missions_pinned)))))),
        h('h4', {}, 'Canaries and rollbacks'), env.canaries.length === 0 ? h('p', { class: 'muted small' }, 'No canary has run.') : h('ul', { class: 'plain' }, env.canaries.map((c) => h('li', {}, st(c.status === 'running' ? 'run' : c.status === 'rolled_back' ? 'warn' : 'done', c.status.replace(/_/g, ' ')), ` ${c.release_id}: ${c.missions.length} of ${c.scope.max_missions} missions`, c.reason ? h('div', { class: 'small sec' }, c.reason) : '',
          h('div', { class: 'small muted' }, c.observations.map((x) => `${x.metric.replace(/_/g, ' ')} ${dash(x.value)} (limit ${x.threshold})${x.breached ? ' — breached' : ''}${x.injected ? ' [injected]' : ''}`).join(' · ')))))),
    ),
    h('div', { class: 'card', style: 'margin-top:14px' }, h('h3', {}, 'Experiments'),
      env.experiments.length === 0 ? h('p', { class: 'empty' }, 'No experiment has been opened. Run `swarm2 evolve run <candidate>`.') : h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, ['Candidate', 'Level', 'Lineage', 'Stage', 'Decision', 'Held-out set', 'Primary difference', ''].map((x) => h('th', {}, x)))), h('tbody', {}, env.experiments.map((e) => {
        const rc = env.receipts.find((r) => r.experiment_id === e.id);
        const p = rc?.primary;
        return h('tr', {}, h('td', {}, h('b', {}, e.candidate?.candidate_id ?? '—'), h('div', { class: 'small sec' }, e.title), e.authorship?.kind === 'model' ? h('div', { class: 'small muted' }, `written by a model (${e.authorship.model ?? 'not recorded'}); judged on ${e.source === 'live' ? 'live work' : 'synthetic held-out cases'}`) : ''), h('td', {}, e.level), h('td', { class: 'small' }, lineageOf(e)), h('td', {}, e.stage.replace(/_/g, ' ')), h('td', {}, verdictMark(e.decision)), h('td', {}, dash(e.holdout_set)), h('td', { class: 'num small' }, p && p.diff_vs_incumbent !== null ? `${p.metric.replace(/_/g, ' ')} ${p.diff_vs_incumbent > 0 ? '+' : ''}${p.diff_vs_incumbent}${p.ci95_vs_incumbent ? ` (${p.ci95_vs_incumbent[0]} to ${p.ci95_vs_incumbent[1]})` : ''}` : '—'), h('td', {}, rc ? h('button', { onclick: () => showReceipt(rc.receipt_id) }, 'Receipt') : ''));
      }))))),
    portfolioCard(env),
    h('div', { class: 'grid two', style: 'margin-top:14px' },
      h('div', { class: 'card' }, h('h3', {}, 'What has been observed'), env.observations.length === 0 ? h('p', { class: 'empty' }, 'No failures have been observed.') : h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Observation'), h('th', { class: 'num' }, 'Count'))), h('tbody', {}, env.observations.map((x) => h('tr', {}, h('td', {}, x.signature.replace(/_/g, ' ').replace(':', ': ')), h('td', { class: 'num' }, x.count))))))),
      h('div', { class: 'card' }, h('h3', {}, 'Proposed changes to the rules'), env.rule_change_proposals.length === 0 ? h('p', { class: 'empty' }, 'None. A proposal to change the promotion rules is a decision for you; no candidate can change the rules it is judged by.') : h('ul', { class: 'plain' }, env.rule_change_proposals.map((d) => h('li', {}, st(d.status === 'resolved' ? 'done' : 'person', d.status), ' ', d.question)))),
    ),
  ];
}

const RENDER = { planning: renderPlanning, doing: renderDoing, reviewing: renderReviewing, evolution: renderEvolution };

async function refresh(force = false) {
  let o;
  try {
    o = await api('/overview');
  } catch {
    $('#updated').textContent = 'The review interface cannot reach its server.';
    return;
  }
  overview = o;
  if (o.source === 'unavailable') {
    $('#chips').replaceChildren(provenance(o));
    main.replaceChildren(unavailable(o));
    return;
  }
  $('#chips').replaceChildren(...[
    provenance({ source: viewSource ?? o.source }),
    h('span', { class: 'chip' }, 'release ', h('b', {}, o.active_release)),
    h('span', { class: `chip ${o.isolation.mode === 'enforced' ? '' : 'warn'}` }, 'separation ', h('b', {}, o.isolation.mode)),
    h('span', { class: 'chip' }, 'model calls in flight ', h('b', {}, `${o.active_calls} of ${o.limits.max_concurrent_model_calls}`)),
    h('span', { class: 'chip' }, 'live execution ', h('b', {}, o.limits.live_execution_enabled ? (o.providers.live.ok ? 'on' : 'on, unavailable') : 'off')),
    o.stopped ? h('span', { class: 'chip stop' }, h('b', {}, 'STOPPED by the operator')) : null,
    o.integrity ? null : h('span', { class: 'chip stop' }, h('b', {}, 'rules changed outside the authorized path')),
  ].filter(Boolean));
  for (const k of ['planning', 'doing', 'reviewing']) $(`#count-${k}`).textContent = o.counts[k] ? String(o.counts[k]) : '';
  if (!view) view = o.counts.reviewing ? 'reviewing' : o.counts.doing ? 'doing' : 'planning';
  for (const b of document.querySelectorAll('.rail button')) b.toggleAttribute('aria-current', b.dataset.view === view), b.dataset.view === view ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current');
  const changed = o.last_event_seq !== lastSeq;
  if (!force && !changed) {
    $('#updated').textContent = `Up to date as of ${new Date().toLocaleTimeString()} · event ${o.last_event_seq}`;
    return;
  }
  // Do not redraw underneath someone who is typing or reading a detail.
  const typing = document.activeElement && ['TEXTAREA', 'INPUT'].includes(document.activeElement.tagName);
  if (!force && (typing || drawer.open)) return;
  lastSeq = o.last_event_seq;
  const att = $('#attention');
  try {
    if (view !== 'reviewing') inlineDecisions = new Set();
    const nodes = await RENDER[view]();
    att.replaceChildren(...o.attention.filter((i) => i.kind === 'decision' && !inlineDecisions.has(i.id)).map((i) => decisionBox(i, () => refresh(true))));
    main.replaceChildren(...nodes.flat().filter(Boolean));
    if (viewSource && $('#chips').firstChild) $('#chips').firstChild.replaceWith(provenance({ source: viewSource }));
  } catch (err) {
    main.replaceChildren(h('div', { class: 'banner' }, st('warn', 'This view could not be drawn'), h('p', { class: 'sec' }, String(err.message ?? err))));
  }
  $('#updated').textContent = `Updated ${new Date().toLocaleTimeString()} · event ${o.last_event_seq}`;
}

for (const b of document.querySelectorAll('.rail button')) {
  b.addEventListener('click', () => {
    view = b.dataset.view;
    viewSource = null;
    localStorageSet('view', view);
    refresh(true);
  });
}
refresh(true);
setInterval(() => refresh(false), 2000);
