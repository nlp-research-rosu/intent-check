'use strict';

const boot = JSON.parse(document.getElementById('data').textContent);
const refreshInterval = 10_000;
let data = boot.snapshot;
let connected = true;
const initialState = { view: 'overview', review: null, reviewTab: 'VERDICT.md', scan: null, scanTab: 'report', proof: null, proofTab: 'report', file: null, filter: '' };
const state = { ...initialState };
const page = document.getElementById('page');
const reviewFiles = ['INTENT.md', 'SPEC.k', 'VERIFICATION.k', 'SEMANTICS.k', 'REASONING.md', 'VERDICT.md', 'meta.json'];
const terminal = new Set(['completed', 'done', 'failed', 'cancelled', 'canceled', 'timed_out', 'superseded']);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const human = value => String(value ?? 'unknown').replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');
const date = value => value ? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—';
const badge = (text, tone = '') => `<span class="badge ${tone}">${escape(text)}</span>`;
function status(value) {
  const tone = ['proved', 'success', 'valid', 'saved', 'no_concerns'].includes(value) ? 'success'
    : ['concerns', 'expired', 'unavailable', 'not_proved'].includes(value) ? 'warning'
    : ['failed', 'error', 'invalid', 'timed_out'].includes(value) ? 'danger'
    : ['queued', 'submitted', 'running', 'pending'].includes(value) ? 'running' : '';
  return badge(human(value), tone);
}
function json(path) {
  try { return JSON.parse(data.files[path]); } catch { return null; }
}
function serviceLink(address) {
  try {
    const url = new URL(address);
    if (!['https:', 'http:'].includes(url.protocol)) return '';
    return `<a class="btn" href="${escape(url.href)}" target="_blank" rel="noopener noreferrer nofollow">Open service ↗</a>`;
  } catch { return ''; }
}
const fileButton = (path, label = 'View file') => `<button class="btn" data-file="${escape(path)}">${escape(label)}</button>`;
const empty = (title, description) => `<div class="card empty"><h2>${escape(title)}</h2><p>${escape(description)}</p></div>`;
function heading(title, description, action = '') {
  return `<div class="page-head"><div><h1>${escape(title)}</h1><p>${escape(description)}</p></div><div class="row">${action}</div></div>`;
}
function inline(text) {
  return escape(text).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}
function code(text) {
  const tokens = /(\/\/[^\n]*|#[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b(?:claim|requires|ensures|module|endmodule|imports|syntax|rule|configuration|def|if|else|return|raise|True|False|null|true|false)\b|\b\d+\b|<\/?[A-Za-z][A-Za-z0-9-]*>)/g;
  let output = '', last = 0;
  for (const match of text.matchAll(tokens)) {
    output += escape(text.slice(last, match.index));
    const token = match[0];
    const cls = token.startsWith('//') || token.startsWith('#') ? 'comment' : /^['"]/.test(token) ? 'str' : /^\d/.test(token) ? 'num' : token.startsWith('<') ? 'tag' : 'kw';
    output += `<span class="${cls}">${escape(token)}</span>`;
    last = match.index + token.length;
  }
  return output + escape(text.slice(last));
}
function markdown(text) {
  const lines = text.split('\n');
  let output = '', paragraph = [], list = false;
  const flush = () => {
    if (paragraph.length) { output += `<p>${inline(paragraph.join('\n'))}</p>`; paragraph = []; }
    if (list) { output += '</ul>'; list = false; }
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('```')) {
      flush();
      const block = [];
      while (++i < lines.length && !lines[i].startsWith('```')) block.push(lines[i]);
      output += `<pre>${code(block.join('\n'))}</pre>`;
    } else if (/^#{1,6} /.test(line)) {
      flush();
      const n = Math.min(line.match(/^#+/)[0].length, 3);
      output += `<h${n}>${inline(line.replace(/^#+\s*/, ''))}</h${n}>`;
    } else if (line.includes('|') && /^[\s:|\-]+$/.test(lines[i + 1] || '') && lines[i + 1].includes('---')) {
      flush();
      const cells = s => s.trim().replace(/^\||\|$/g, '').split('|').map(s => s.trim());
      output += `<div class="table-wrap"><table><thead><tr>${cells(line).map(s => `<th>${inline(s)}</th>`).join('')}</tr></thead><tbody>`;
      i++;
      while (i + 1 < lines.length && lines[i + 1].includes('|')) output += `<tr>${cells(lines[++i]).map(s => `<td>${inline(s)}</td>`).join('')}</tr>`;
      output += '</tbody></table></div>';
    } else if (/^\s*[-*]\s/.test(line)) {
      if (paragraph.length) { output += `<p>${inline(paragraph.join('\n'))}</p>`; paragraph = []; }
      if (!list) { output += '<ul>'; list = true; }
      output += `<li>${inline(line.replace(/^\s*[-*]\s+/, ''))}</li>`;
    } else if (!line.trim()) {
      flush();
    } else {
      if (list) { output += '</ul>'; list = false; }
      paragraph.push(line);
    }
  }
  flush();
  return output;
}
function fileView(path) {
  if (!Object.hasOwn(data.files, path)) return '<div class="empty">No local artifact at this path.</div>';
  const text = data.files[path], bytes = new TextEncoder().encode(text).length;
  const size = bytes > 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;
  return `<div class="file-tools"><span class="mono">.intent/${escape(path)}</span><div class="row"><span>${size}</span><button class="btn" data-copy="${escape(path)}">Copy</button><button class="btn" data-download="${escape(path)}">Download</button></div></div>`
    + (path.endsWith('.md') ? `<article class="document">${markdown(text)}</article>`
      : `<div class="code-view">${text.split('\n').map((line, i) => `<span class="code-line"><span class="ln">${i + 1}</span>${code(line)}</span>`).join('')}</div>`);
}
function records() {
  const paths = Object.keys(data.files).sort();
  const reviews = paths.filter(p => p.endsWith('/meta.json') && !p.startsWith('prove/') && !p.startsWith('deepscan/'))
    .map(p => ({ path: p.slice(0, -10), meta: json(p) })).filter(r => r.meta?.review_id);
  const scans = paths.filter(p => /^deepscan\/[^/]+\/meta.json$/.test(p))
    .map(p => ({ path: p, meta: json(p), report: json(p.replace(/meta.json$/, 'report.json')) })).filter(s => s.meta);
  for (const scan of scans) scan.progress = data.scanStates[scan.meta.task_id] || { status: scan.meta.task?.status || scan.meta.status };
  const operations = paths.filter(p => /^prove\/sessions\/[^/]+\/[^/]+\/result.json$/.test(p))
    .map(p => ({ path: p, evidence: json(p) })).filter(o => o.evidence?.task);
  const targets = [...new Set(paths.filter(p => /^prove\/(?!sessions\/)/.test(p) && /\/(PROOF|SCOPE)\.md$/.test(p)).map(p => p.slice(0, p.lastIndexOf('/') + 1)))];
  const active = [...data.active];
  for (const s of scans) {
    if (!terminal.has(s.progress.status)) active.push({ id: s.meta.task_id, kind: 'DeepScan', status: s.progress.status, paths: [s.meta.scope || 'Whole repository'], url: s.meta.url, submittedAt: s.meta.created_at });
  }
  for (const o of operations) {
    const task = o.evidence.task;
    if (!terminal.has(task.status)) active.push({ id: task.id, kind: human(task.kind), status: task.status, paths: [], submittedAt: task.createdAt });
  }
  const artifacts = paths.filter(p => !p.startsWith('prove/sessions/'));
  return { paths, artifacts, reviews, scans, operations, targets, active };
}
function navigation(r) {
  const tabs = [['overview', 'Overview', ''], ['reviews', 'File reviews', r.reviews.length], ['scans', 'DeepScan', r.scans.length], ['proofs', 'Proofs', r.targets.length], ['artifacts', 'All artifacts', r.artifacts.length]];
  document.getElementById('nav').innerHTML = tabs.map(([id, label, count]) => `<button data-view="${id}" class="${state.view === id ? 'active' : ''}" ${state.view === id ? 'aria-current="page"' : ''}><span>${label}</span><span class="count">${count}</span></button>`).join('');
}
function activeChecks(r) {
  if (!r.active.length) return '';
  return `<section><div class="section-heading"><h2>Active checks</h2>${badge(r.active.length, 'running')}</div><div class="card table-wrap"><table><thead><tr><th>Check</th><th>Target</th><th>Last local state</th><th>Submitted</th><th></th></tr></thead><tbody>${r.active.map(a => `<tr><td>${escape(a.kind)}<span class="subline mono">${escape(a.id.slice(0, 8))}</span></td><td>${(a.paths || []).map(escape).join('<br>') || '—'}</td><td>${status(a.status)}</td><td class="muted small">${date(a.submittedAt)}</td><td>${serviceLink(a.url)}</td></tr>`).join('')}</tbody></table></div></section>`;
}
function scanOutcome(s) {
  const count = (s.report?.cards?.length || 0) + (s.report?.one_liners?.length || 0);
  return s.report ? badge(`${count} findings`, count ? 'warning' : '') : status(s.meta.report?.status || s.meta.status);
}
function overview(r) {
  const rows = r.reviews.map(r => `<tr><td><button class="link-button mono" data-review="${escape(r.path)}">${escape(r.path)}</button><span class="subline">File review · last saved result</span></td><td>${status(r.meta.verdict)}</td><td class="mono small muted">${escape(r.meta.review_id.slice(0, 8))}</td><td class="small muted">${date(r.meta.reviewed_at)}</td></tr>`);
  rows.push(...r.scans.map(s => `<tr><td><button class="link-button" data-scan="${escape(s.path)}">${escape(s.meta.scope || 'Whole repository')}</button><span class="subline">DeepScan · ${escape(s.meta.depth)}</span></td><td>${scanOutcome(s)}</td><td class="mono small muted">${escape(s.meta.task_id?.slice(0, 8))}</td><td class="small muted">${date(s.meta.created_at)}</td></tr>`));
  rows.push(...r.operations.filter(o => o.evidence.task.kind === 'proof').map(o => `<tr><td><button class="link-button" data-file="${escape(o.path)}">Proof attempt</button><span class="subline">${escape(o.path.split('/').at(-2))}</span></td><td>${status(o.evidence.task.result || o.evidence.task.status)}</td><td class="mono small muted">${escape(o.evidence.task.id.slice(0, 8))}</td><td class="small muted">${date(o.evidence.task.finishedAt || o.evidence.task.createdAt)}</td></tr>`));
  return heading(data.name, 'Reviews, scans and proof results for this repository.')
    + `<div class="stack"><div class="metrics">${[[r.active.length, 'Active checks'], [r.reviews.length, 'Files reviewed'], [r.scans.length, 'DeepScans'], [r.paths.length, 'Local artifacts']].map(([n, label]) => `<div class="card metric"><div class="label">${label}</div><div class="value">${n}</div></div>`).join('')}</div>`
    + activeChecks(r)
    + (rows.length ? `<section><div class="section-heading"><h2>Saved results</h2></div><div class="card table-wrap"><table><thead><tr><th>Target</th><th>Result</th><th>Task</th><th>Recorded</th></tr></thead><tbody>${rows.join('')}</tbody></table></div></section>` : empty('No saved results yet', 'Run Intent Check in this repository.'))
    + '</div>';
}
function reviewFindings(review) {
  const verdict = data.files[`${review.path}/VERDICT.md`];
  if (!verdict) return '<span class="muted">No verdict saved</span>';
  const findings = [...verdict.replace(/\r\n/g, '\n').matchAll(/^\d+\.\s+([^\n]+)\n\s*\n([\s\S]*?)(?=\n\s*\n|$)/gm)];
  if (!findings.length) return markdown(verdict);
  return `<ul class="review-findings">${findings.map(([, title, description]) => `<li>${inline(description)}<span class="subline">${inline(title)}</span></li>`).join('')}</ul>`;
}
function reviewsPage(r) {
  const active = activeChecks({ active: r.active.filter(a => ['File review', 'Live check'].includes(a.kind)) });
  const review = r.reviews.find(x => x.path === state.review);
  if (!review) {
    return heading('File reviews', 'Files and findings.') + `<div class="stack">${active}`
      + (r.reviews.length ? `<div class="card table-wrap"><table><thead><tr><th>File</th><th>Findings</th><th>Reviewed</th></tr></thead><tbody>${r.reviews.map(review => `<tr><td><button class="link-button mono" data-review="${escape(review.path)}">${escape(review.path)}</button><span class="subline">${status(review.meta.verdict)}</span></td><td>${reviewFindings(review)}</td><td class="small muted">${date(review.meta.reviewed_at)}</td></tr>`).join('')}</tbody></table></div>` : empty('No completed file reviews', 'Run Intent Check in this repository.'))
      + '</div>';
  }
  const files = reviewFiles.filter(f => Object.hasOwn(data.files, `${review.path}/${f}`));
  const tab = files.includes(state.reviewTab) ? state.reviewTab : files[0];
  return heading(review.path, 'Last completed review saved for this source path.', status(review.meta.verdict) + serviceLink(review.meta.url))
    + `<div class="stack">${active}<div class="row small muted"><span>Reviewed ${date(review.meta.reviewed_at)}</span><span class="mono">SHA-256 ${escape(review.meta.source_sha256)}</span></div><div class="card"><div class="file-tabs" aria-label="Review artifacts">${files.map(f => `<button data-review-tab="${f}" class="${tab === f ? 'active' : ''}">${f}</button>`).join('')}</div>${fileView(`${review.path}/${tab}`)}</div></div>`;
}
function finding(card) {
  const level = String(card.severity || '').toLowerCase();
  return `<article class="card card-body"><div class="row">${badge(level, ['high', 'critical'].includes(level) ? 'danger' : 'warning')}<span class="mono small muted">${escape(card.id)}</span></div><h3 style="margin-top:10px">${inline(card.title)}</h3><div class="finding-fields"><div><span class="field-label">What should hold</span>${inline(card.expected_behavior)}</div><div><span class="field-label">Potential failure</span>${inline(card.failure_scenario)}</div></div><p class="refs mono">${(card.source_references || []).map(ref => `${escape(ref.path)}:${escape(ref.line)}`).join(', ')}</p><details><summary>Evidence and validation</summary><div><span class="field-label">Validation scenario</span><p class="small">${inline(card.validation_scenario)}</p><p class="small muted" style="margin-top:12px">Novelty: ${escape(human(card.novelty?.status))}</p>${card.details_path ? `<p class="small muted" style="margin-top:8px">Supporting detail is remote, not embedded: <code>${escape(card.details_path)}</code></p>` : ''}</div></details></article>`;
}
function scansPage(r) {
  const scan = r.scans.find(s => s.path === state.scan) || r.scans.at(-1);
  if (!scan) return heading('DeepScan', 'Whole-repository and scoped scan reports.') + empty('No local scans', 'Start a DeepScan with the installed plugin.');
  state.scan = scan.path;
  const { meta, report } = scan, source = meta.source || {};
  const select = r.scans.length > 1 ? `<div class="select-row"><label class="small muted">Scan <select id="scan-select">${r.scans.map(s => `<option value="${escape(s.path)}" ${s.path === scan.path ? 'selected' : ''}>${escape(s.meta.task_id)}</option>`).join('')}</select></label></div>` : '';
  let body;
  if (state.scanTab === 'metadata') body = `<div class="card card-body"><h2>Scan details</h2><dl class="kv"><dt>Task state</dt><dd>${status(scan.progress.status)}${scan.progress.stage ? ' · ' + escape(human(scan.progress.stage)) : ''}</dd><dt>Created</dt><dd>${date(meta.created_at)}</dd><dt>Report saved</dt><dd>${date(meta.report?.saved_at)}</dd><dt>Report SHA-256</dt><dd class="mono">${escape(meta.report?.sha256 || '—')}</dd>${meta.report?.reason ? `<dt>Collection error</dt><dd>${escape(meta.report.reason)}</dd>` : ''}</dl></div>`
    + `<div class="card card-body"><h2>Scanned source</h2><dl class="kv"><dt>Branch / commit</dt><dd class="mono">${escape(source.branch || '—')} · ${escape(source.head_sha || 'No pinned commit')}</dd><dt>Working tree</dt><dd>${source.dirty ? 'Uncommitted source included' : 'Clean at snapshot time'}</dd><dt>Snapshot SHA-256</dt><dd class="mono">${escape(source.snapshot_sha256 || '—')}</dd><dt>Files</dt><dd>${(source.files || []).map(f => `<div class="small mono">${escape(f.path)} <span class="muted">${escape(f.source_sha256)}</span></div>`).join('')}</dd><dt>Omitted paths</dt><dd>${(source.trimmed || []).map(f => `${escape(f.path)}: ${escape(f.reason)}`).join('<br>') || 'None recorded'}</dd></dl></div>`;
  else if (!report) body = empty('Final report not saved yet', `Task: ${scan.progress.status}${scan.progress.stage ? ' · ' + scan.progress.stage : ''}. Collection: ${meta.report?.status || 'unknown'}. ${meta.report?.reason || ''}`);
  else {
    const coverage = report.coverage || {};
    const list = items => `<ul>${(items || []).map(item => `<li>${escape(item)}</li>`).join('')}</ul>`;
    body = (report.cards || []).map(finding).join('')
      + ((report.one_liners || []).length ? `<div class="card card-body"><h2>Other findings</h2>${report.one_liners.map(c => `<p style="margin-top:12px">${status(c.severity)} ${inline(c.title)} <code>${escape(c.path)}:${escape(c.line)}</code></p>`).join('')}</div>` : '')
      + ((report.excluded_findings || []).length ? `<div class="card card-body"><h2>Excluded findings</h2>${report.excluded_findings.map(c => `<p style="margin-top:12px"><strong>${escape(c.title)}</strong> — ${escape(c.reason)}</p>`).join('')}</div>` : '')
      + `<div class="card card-body"><h2>Coverage</h2><dl class="kv"><dt>Files / bytes</dt><dd>${escape(coverage.file_count)} files · ${escape(coverage.bytes)} bytes</dd><dt>Checked</dt><dd>${list(coverage.checked)}</dd><dt>Not checked</dt><dd>${list(coverage.not_checked)}</dd><dt>Limitations</dt><dd>${list(coverage.notes)}</dd></dl></div>`;
  }
  return heading('DeepScan', `${human(meta.depth)} review · ${meta.scope || 'whole repository'}`, scanOutcome(scan) + serviceLink(meta.url)) + select
    + `<div class="row small mono muted" style="margin-bottom:15px">${escape(meta.task_id)} ${status(meta.report?.status)}</div><div class="tabs"><button data-scan-tab="report" class="${state.scanTab === 'report' ? 'active' : ''}">Report</button><button data-scan-tab="metadata" class="${state.scanTab === 'metadata' ? 'active' : ''}">Scan metadata</button></div><div class="stack">${body}</div>`;
}
function operationsView(r) {
  const files = r.paths.filter(p => p.startsWith('prove/sessions/') && !r.operations.some(o => o.path === p));
  if (!r.operations.length && !files.length) return empty('No verification runs', 'Run, validation and proof results appear here.');
  return `<div class="stack">${r.operations.map(o => {
    const task = o.evidence.task;
    return `<div class="card card-body"><div class="row between"><div><h3>${escape(human(task.kind))} · ${escape(o.path.split('/').at(-2))}</h3><p class="small mono muted">${escape(task.id)}</p></div><div class="row">${status(task.status)}${task.result ? status(task.result) : ''}</div></div><p class="small muted" style="margin-top:13px">${(task.toolRuns || []).map(run => `${escape(run.tool)}: exit ${escape(run.exitCode ?? 'not provided')}`).join(' · ') || 'No tool runs recorded'}</p><details ${state.file === o.path ? 'open' : ''}><summary>Result JSON</summary>${fileView(o.path)}</details></div>`;
  }).join('')}${files.length ? `<div class="card card-body"><h2>Verification files</h2>${files.map(path => `<details ${state.file === path ? 'open' : ''}><summary class="mono">${escape(path.slice('prove/sessions/'.length))}</summary>${fileView(path)}</details>`).join('')}</div>` : ''}</div>`;
}
function proofsPage(r) {
  const target = r.targets.includes(state.proof) ? state.proof : r.targets[0];
  state.proof = target;
  let select = '';
  if (r.targets.length > 1) select = `<div class="select-row"><label class="small muted">Target <select id="proof-select">${r.targets.map(t => `<option value="${escape(t)}" ${t === target ? 'selected' : ''}>${escape(t.slice(6, -1))}</option>`).join('')}</select></label></div>`;
  const available = target ? [['report', 'Proof report', 'PROOF.md'], ['scope', 'Scope', 'SCOPE.md']].filter(([, , file]) => Object.hasOwn(data.files, target + file)) : [];
  available.push(['operations', 'Verification runs']);
  if (!available.some(([id]) => id === state.proofTab)) state.proofTab = available[0][0];
  const tab = available.find(([id]) => id === state.proofTab);
  const body = state.proofTab === 'operations' ? operationsView(r) : `<div class="card">${fileView(target + tab[2])}</div>`;
  return heading(target ? target.slice(6, -1) : 'Proofs', 'Proof reports, scope and verification runs.') + select
    + `<div class="tabs">${available.map(([id, label]) => `<button data-proof-tab="${id}" class="${id === state.proofTab ? 'active' : ''}">${label}</button>`).join('')}</div>${body}`
    + (target ? `<div class="row" style="margin-top:16px">${r.paths.filter(p => p.startsWith(target) && !p.slice(target.length).includes('/') && !['PROOF.md', 'SCOPE.md'].includes(p.slice(target.length))).map(p => fileButton(p, p.slice(target.length))).join('')}</div>` : '');
}
function artifactsPage(r) {
  if (!r.artifacts.length) return heading('All artifacts', 'Local evidence files.') + empty('No artifacts saved yet', 'Run Intent Check in this repository.');
  if (!r.artifacts.includes(state.file)) state.file = r.artifacts[0];
  const groups = new Map();
  for (const path of r.artifacts) {
    const group = path.startsWith('prove/') ? 'Formal proof' : path.startsWith('deepscan/') ? 'DeepScan' : path.includes('/') ? 'File reviews' : 'Workspace';
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(path);
  }
  return heading('All artifacts', 'Browse local evidence files.')
    + `<div class="artifact-grid"><div class="card"><div style="padding:12px 12px 4px"><input class="filter" id="file-search" placeholder="Filter paths…" aria-label="Filter artifact paths" value="${escape(state.filter)}"></div><div class="artifact-tree">${[...groups].map(([name, paths]) => `<div class="tree-group"><div class="group">${name}</div>${paths.map(p => `<button data-artifact="${escape(p)}" class="mono ${p === state.file ? 'active' : ''}">${escape(p)}</button>`).join('')}</div>`).join('')}</div></div><div class="card" id="artifact-content">${fileView(state.file)}</div></div>`;
}
function filterArtifacts() {
  const query = state.filter.toLowerCase();
  document.querySelectorAll('[data-artifact]').forEach(button => { button.hidden = !button.dataset.artifact.toLowerCase().includes(query); });
  document.querySelectorAll('.tree-group').forEach(group => { group.hidden = ![...group.querySelectorAll('[data-artifact]')].some(b => !b.hidden); });
}
function connection() {
  const label = document.getElementById('connection');
  label.textContent = !boot.dataUrl ? 'Offline snapshot' : connected ? `Live · refreshes every ${refreshInterval / 1000}s` : 'Disconnected · last local snapshot';
  label.className = 'badge' + (boot.dataUrl ? connected ? ' success' : ' warning' : '');
  document.getElementById('updated').textContent = (boot.dataUrl ? 'Last read ' : 'Exported ') + date(data.generated);
}
function render() {
  const r = records();
  document.getElementById('repo-name').textContent = data.name;
  document.getElementById('breadcrumb').textContent = data.name;
  document.title = `${data.name} · Intent Check`;
  navigation(r);
  document.getElementById('warnings').innerHTML = data.warnings.length ? `<div class="callout"><strong>Some artifacts could not be included</strong>${data.warnings.map(escape).join('<br>')}</div>` : '';
  page.innerHTML = ({ overview, reviews: reviewsPage, scans: scansPage, proofs: proofsPage, artifacts: artifactsPage })[state.view](r);
  filterArtifacts();
  connection();
}
function readLocation() {
  const params = new URLSearchParams(location.hash.slice(1));
  for (const [key, value] of Object.entries(initialState)) state[key] = params.get(key) ?? value;
  if (!['overview', 'reviews', 'scans', 'proofs', 'artifacts'].includes(state.view)) state.view = 'overview';
}
function navigate() {
  render();
  const params = new URLSearchParams(Object.entries(state).filter(([key, value]) => value != null && value !== initialState[key]));
  const hash = params.toString();
  if (location.hash.slice(1) !== hash) location.hash = hash;
}
window.addEventListener('hashchange', () => { readLocation(); render(); });
document.addEventListener('click', async event => {
  const button = event.target.closest('[data-view],[data-review],[data-review-tab],[data-scan],[data-scan-tab],[data-proof-tab],[data-file],[data-artifact],[data-copy],[data-download]');
  if (!button) return;
  const d = button.dataset;
  if (d.copy) {
    try { await navigator.clipboard.writeText(data.files[d.copy]); button.textContent = 'Copied'; }
    catch { button.textContent = 'Use Download'; }
    return;
  }
  if (d.download) {
    const blob = new Blob([data.files[d.download]], { type: 'text/plain;charset=utf-8' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.href = url; link.download = d.download.split('/').at(-1); link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return;
  }
  if (d.artifact) {
    state.file = d.artifact;
    navigate();
    return;
  }
  if (d.view) { state.view = d.view; if (d.view === 'reviews') state.review = null; }
  if (d.review) { state.view = 'reviews'; state.review = d.review; state.reviewTab = 'VERDICT.md'; }
  if (d.reviewTab) state.reviewTab = d.reviewTab;
  if (d.scan) { state.view = 'scans'; state.scan = d.scan; state.scanTab = 'report'; }
  if (d.scanTab) state.scanTab = d.scanTab;
  if (d.proofTab) state.proofTab = d.proofTab;
  if (d.file) {
    state.file = d.file;
    state.view = d.file.startsWith('prove/sessions/') ? 'proofs' : 'artifacts';
    if (state.view === 'proofs') state.proofTab = 'operations';
  }
  navigate();
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('menu').setAttribute('aria-expanded', 'false');
});
document.addEventListener('input', event => {
  if (event.target.id === 'file-search') { state.filter = event.target.value; filterArtifacts(); }
});
document.addEventListener('change', event => {
  if (event.target.id === 'scan-select') { state.scan = event.target.value; navigate(); }
  if (event.target.id === 'proof-select') { state.proof = event.target.value; navigate(); }
});
document.getElementById('menu').onclick = () => {
  const open = document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('menu').setAttribute('aria-expanded', String(open));
};
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') { document.getElementById('sidebar').classList.remove('open'); document.getElementById('menu').setAttribute('aria-expanded', 'false'); }
});
readLocation();
render();

// Refresh only local data, never the service. An export has no dataUrl and no timer.
function signature(snapshot) {
  return JSON.stringify([snapshot.name, snapshot.files, snapshot.active, snapshot.scanStates, snapshot.warnings]);
}
async function refresh() {
  try {
    const response = await fetch(boot.dataUrl, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('Local viewer unavailable');
    const next = await response.json();
    const changed = signature(next) !== signature(data);
    data = next;
    connected = true;
    if (changed) {
      const position = window.scrollY;
      const focus = document.activeElement?.id;
      render();
      if (focus) document.getElementById(focus)?.focus({ preventScroll: true });
      window.scrollTo(0, position);
    } else connection();
  } catch {
    connected = false;
    connection();
  }
  setTimeout(refresh, refreshInterval);
}
if (boot.dataUrl) setTimeout(refresh, refreshInterval);
