// Amsterdax website: loads a data run and draws the journal table. The ranking logic is in engine.js.
import { parquetReadObjects } from 'https://cdn.jsdelivr.net/npm/hyparquet@1.31.1/+esm';
import * as E from './engine.js';

const $ = id => document.getElementById(id);
const PAGE_SIZE = 25;
// The only place where the scores are named; the keys match the data columns (see SPEC.md).
const METRICS = {
  share: { short: 'JNS', name: 'Journal Network Share', note: 'share of citation-network prestige; sums to 100 over the universe', digits: 5 },
  per_article: { short: 'ANS', name: 'Article Network Score', note: 'network share per article; article-weighted mean 1', digits: 3 },
};
const DEFAULTS = {
  treatment: 'raw', universes: [], rankUniverse: 'n', metric: 'per_article', classification: 'oa_field',
  minCoverage: 20, minYears: 0, topPercent: 100, query: '', fieldFilter: '', publisher: '', level: '',
  member: '', oaOnly: false, poolOnly: false, details: false, sortKey: 'score:n:per_article', sortDirection: -1, page: 0,
};
const SBE_PRESET = {
  treatment: 'filtered', rankUniverse: 'n', metric: 'per_article', classification: 'oa_field', minCoverage: 20,
  minYears: 4, topPercent: 70, poolOnly: true, query: '', fieldFilter: '', publisher: '', level: '', member: '',
  oaOnly: false, page: 0,
};

let index;          // data/runs.json: the runs on this site, newest first
let run;            // the selected run
let manifest;       // its manifest.json
let year;           // the selected score year
let rows = [];      // journals of the selected run and year
let dataColumns = [];
let state = { ...DEFAULTS };
let ranks, ranksKey, visible, columns;

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const option = (value, label) => `<option value="${escape(value)}">${escape(label)}</option>`;
const count = n => n.toLocaleString('en-US');
const fmt = (value, digits = 0) => E.isNumber(value)
  ? value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }) : '—';
// Very small positive scores use scientific notation so they don't round to zero.
const fmtScore = (value, metric) => E.isNumber(value) && value > 0 && value < 10 ** -METRICS[metric].digits
  ? value.toExponential(2) : fmt(value, METRICS[metric].digits);
const universeIds = () => Object.keys(manifest.universes);
const universeName = u => manifest.universes[u] ?? u.toUpperCase();
const openAlexUrl = row => `https://openalex.org/${encodeURIComponent(row.openalex_id)}`;

async function fetchOk(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response;
}

function showError(error) {
  $('notice').className = 'notice error';
  $('notice').textContent = `The data could not be loaded (${error.message}).`;
}

// ---- Loading data ----

async function loadRun(name) {
  run = index.runs.find(r => r.run === name);
  manifest = await (await fetchOk(`data/${run.run}/manifest.json`)).json();
  const ids = universeIds();
  state.universes = ids;
  if (!ids.includes(state.rankUniverse)) state.rankUniverse = ids[0];
  if (!ids.includes(state.member)) state.member = '';
  $('universes').innerHTML = '<legend>Show score columns</legend>' + ids.map(u =>
    `<label class="universe-chip"><input type="checkbox" value="${escape(u)}" checked><span class="letter ${escape(u)}">${escape(u.toUpperCase())}</span> ${escape(universeName(u))}</label>`).join('');
  $('rank-universe').innerHTML = ids.map(u => option(u, `${universeName(u)} · ${u.toUpperCase()}`)).join('');
  $('member').innerHTML = option('', 'Any universe') + ids.map(u => option(u, `In ${universeName(u)}`)).join('');
  $('year').innerHTML = [...manifest.years].sort((a, b) => b - a).map(y => option(y, y)).join('');
  await loadYear(Math.max(...manifest.years));
}

async function loadYear(newYear) {
  $('notice').className = 'notice';
  $('notice').textContent = `Loading score year ${newYear}…`;
  const buffer = await (await fetchOk(`data/${run.run}/scores_${newYear}.parquet`)).arrayBuffer();
  const data = await parquetReadObjects({ file: buffer });
  dataColumns = data.length ? Object.keys(data[0]) : [];
  year = newYear;
  rows = E.prepareRows(data);
  ranksKey = null;
  state.page = 0;
  fillFilters();
  syncControls();
  render();
  showRunInfo();
  showDownloads();
}

function showRunInfo() {
  const notice = $('notice');
  notice.className = manifest.dummy ? 'notice dummy' : 'notice';
  notice.textContent = manifest.dummy
    ? `Dummy data: every journal and number in run ${run.run} is made up, for testing the website only.`
    : `Run ${run.run} · OpenAlex snapshot ${manifest.openalex_snapshot} · Norwegian Register snapshot ${manifest.norwegian_register_snapshot}`;
  $('provenance').textContent = `Run ${run.run} was created on ${manifest.created}. Norwegian fields and levels come from the ` +
    'Norwegian Register for Scientific Journals, Series and Publishers; journal metadata and citations from OpenAlex.';
}

function showDownloads() {
  const file = `data/${run.run}/scores_${year}.parquet`;
  $('download-year').innerHTML = `Score year ${year} of run ${escape(run.run)}, all ${count(rows.length)} journals: ` +
    `<a href="${escape(file)}" download>Parquet</a> · <button type="button" class="text-button" id="download-year-csv">CSV</button>`;
  $('download-runs').innerHTML = index.runs.map(r => `<li>Run ${escape(r.run)}${r.dummy ? ' (dummy data)' : ''}, created ${escape(r.created)}: ` +
    (r.release_url ? `<a href="${escape(r.release_url)}">all files</a>` : 'files not published') + '</li>').join('') +
    (index.releases_url ? `<li>Older runs: <a href="${escape(index.releases_url)}">all releases</a></li>` : '');
}

// ---- Table ----

function getColumns() {
  const cols = [
    { key: 'title', label: 'Journal', className: 'journal-column align-left', title: 'Click the title for details; click the ID to open OpenAlex' },
    { key: 'field', label: 'Field', className: 'align-left', title: 'Classification used for within-field ranking' },
  ];
  if (state.details) cols.push(
    { key: 'issns', label: 'ISSNs', className: 'align-left' },
    { key: 'publisher', label: 'Publisher', className: 'align-left' },
    { key: 'norwegian_level', label: 'N level', title: `Norwegian Register level in ${year}` },
    { key: 'active_years', label: 'Years / 5', title: 'Years with at least one eligible article or review' });
  cols.push(
    { key: 'publications', label: 'Publications', title: `Articles and reviews ${year - 5}–${year - 1}${state.treatment === 'raw' ? '' : ' with at least one linked reference'}` },
    { key: 'citations', label: 'Citations', title: `Citations in ${year} to those publications, excluding journal self-citations` },
    { key: 'reference_coverage_pct', label: 'Ref. coverage', title: 'Share of publications with at least one linked OpenAlex reference' });
  for (const u of state.universes) for (const [metric, m] of Object.entries(METRICS)) cols.push(
    { key: `score:${u}:${metric}`, label: m.short, className: metric === 'share' ? 'group-start' : '', universe: u, title: `${universeName(u)} ${m.name} (${m.note})` });
  cols.push(
    { key: 'fieldPct', label: 'Field pct.', className: 'group-start percentile-cell', title: 'Percentile within its field, after the coverage and history requirements' },
    { key: 'poolPct', label: `${METRICS[state.metric].short} pct.`, className: 'percentile-cell', title: 'Percentile among all retained journals; 100 is highest' });
  return cols;
}

function renderHead() {
  const profileColumns = columns.filter(c => !c.universe && !c.key.endsWith('Pct')).length;
  const groups = `<th scope="colgroup" colspan="${profileColumns}" class="meta-group">Journal profile · ${year - 5}–${year - 1} publications · ${year} citations</th>` +
    state.universes.map(u => `<th scope="colgroup" colspan="2" class="score-group ${escape(u)}">${escape(universeName(u))} · ${escape(u.toUpperCase())}</th>`).join('') +
    `<th scope="colgroup" colspan="2" class="percentile-group">Ranking · ${escape(state.rankUniverse.toUpperCase())} ${METRICS[state.metric].short}</th>`;
  const headers = columns.map(col => {
    const sorted = state.sortKey === col.key;
    const direction = state.sortDirection === 1 ? 'ascending' : 'descending';
    const arrow = sorted ? (state.sortDirection === 1 ? '↑' : '↓') : '↕';
    return `<th scope="col" class="${col.className || ''} ${sorted ? 'sorted' : ''}" aria-sort="${sorted ? direction : 'none'}" title="${escape(col.title || col.label)}">` +
      `<button type="button" class="sort-button" data-sort="${col.key}">${col.label}<span class="sort-indicator" aria-hidden="true">${arrow}</span></button></th>`;
  }).join('');
  $('table-head').innerHTML = `<tr class="group-row">${groups}</tr><tr>${headers}</tr>`;
}

function cell(row, col) {
  const value = E.columnValue(row, state, ranks, col.key);
  const id = row.openalex_id;
  if (col.key === 'title') return `<td class="journal-column"><button class="journal-title" type="button" data-journal="${escape(id)}">${escape(row.title)}</button>` +
    `<a class="journal-id" href="${openAlexUrl(row)}" target="_blank" rel="noopener noreferrer" aria-label="Open ${escape(row.title)} in OpenAlex, new tab">${escape(id)} ↗</a>` +
    `<span class="journal-id"> · ${escape(row.issn_l || 'no ISSN')}</span></td>`;
  if (col.key === 'field') return `<td class="field-cell">${escape(value)}</td>`;
  if (col.key === 'publisher' || col.key === 'issns') return `<td class="publisher-cell">${escape(value || '—')}</td>`;
  if (col.key === 'norwegian_level') return `<td>${escape(value ?? '—')}</td>`;
  if (col.key === 'reference_coverage_pct') {
    const low = E.isNumber(value) && state.minCoverage >= 0 && value <= state.minCoverage;
    const bar = E.isNumber(value) ? `<div class="coverage-track" aria-hidden="true"><div class="coverage-fill" style="width:${Math.max(0, Math.min(100, value))}%"></div></div>` : '';
    return `<td class="coverage-cell ${low ? 'coverage-low' : ''}"><span class="coverage-value">${fmt(value, 1)}${E.isNumber(value) ? '%' : ''}</span>${bar}</td>`;
  }
  if (col.key === 'fieldPct' || col.key === 'poolPct') {
    const note = !E.isNumber(value) ? ranks.reasons.get(id) || 'Not eligible'
      : col.key === 'fieldPct' ? `Compared with ${count(ranks.fieldCounts.get(id))} journals in this field` : `Compared with ${count(ranks.retained)} retained journals`;
    return `<td class="${col.className} ${value == null ? 'missing' : ''}" title="${escape(note)}">${fmt(value, 1)}</td>`;
  }
  if (col.universe) {
    const metric = col.key.split(':')[2];
    const classes = `metric-cell ${col.className || ''} ${metric === 'per_article' ? 'per-article-cell' : ''}`;
    if (!row[`in_${col.universe}`]) return `<td class="${classes} not-member" title="Not in the ${escape(universeName(col.universe))} universe">·</td>`;
    return `<td class="${classes} ${value == null ? 'missing' : ''}" title="${value == null ? 'In this universe, but no score' : escape(value)}">${fmtScore(value, metric)}</td>`;
  }
  return `<td>${fmt(value)}</td>`;
}

function render() {
  // Percentiles only depend on the ranking settings, so they are recomputed only when those change.
  const key = JSON.stringify([state.treatment, state.rankUniverse, state.metric, state.classification, state.minCoverage, state.minYears, state.topPercent]);
  if (key !== ranksKey) { ranks = E.rank(rows, state); ranksKey = key; }
  columns = getColumns();
  if (!columns.some(col => col.key === state.sortKey)) Object.assign(state, { sortKey: 'title', sortDirection: 1 });
  visible = E.view(rows, state, ranks);
  drawPage();
}

// Draws the current page only; paging doesn't need to filter and sort again.
function drawPage() {
  state.page = Math.max(0, Math.min(state.page, Math.ceil(visible.length / PAGE_SIZE) - 1));
  const shown = visible.slice(state.page * PAGE_SIZE, (state.page + 1) * PAGE_SIZE);
  renderHead();
  $('table-body').innerHTML = shown.length ? shown.map(row => `<tr>${columns.map(col => cell(row, col)).join('')}</tr>`).join('')
    : `<tr><td colspan="${columns.length}" class="empty-cell">No journals match these choices. Try a broader search or reset the filters.</td></tr>`;
  $('result-count').textContent = `${count(visible.length)} of ${count(rows.length)} journals`;
  $('sort-status').textContent = `Sorted by ${columns.find(c => c.key === state.sortKey)?.label || 'journal'} ${state.sortDirection === 1 ? '↑' : '↓'}`;
  $('pool-summary').innerHTML = `<strong>${count(ranks.qualified)}</strong> meet the requirements · <strong>${count(ranks.groups)}</strong> fields · ` +
    `<strong>${count(ranks.retained)}</strong> retained for the final percentile${ranks.retained ? '' : ' — broaden the requirements to define percentiles'}`;
  $('page-status').textContent = visible.length ? `${count(state.page * PAGE_SIZE + 1)}–${count(state.page * PAGE_SIZE + shown.length)} of ${count(visible.length)} journals` : '0 journals';
  $('previous').disabled = state.page === 0;
  $('next').disabled = (state.page + 1) * PAGE_SIZE >= visible.length;
  $('treatment-note').textContent = state.treatment === 'raw'
    ? 'Raw scores · all eligible articles and reviews' : 'Filtered scores · eligible articles and reviews with linked references';
}

// ---- Controls ----

const SELECTS = { 'rank-universe': 'rankUniverse', metric: 'metric', classification: 'classification', coverage: 'minCoverage',
  'min-years': 'minYears', 'field-filter': 'fieldFilter', publisher: 'publisher', level: 'level', member: 'member' };
const NUMERIC = new Set(['minCoverage', 'minYears']);
const CHECKBOXES = { 'oa-only': 'oaOnly', 'pool-only': 'poolOnly', 'details-columns': 'details' };

function setChoices(id, values, label) {
  const unique = [...new Set(values.filter(v => v != null && v !== ''))].sort((a, b) => E.compareText(String(a), String(b)));
  $(id).innerHTML = option('', label) + unique.map(v => option(v, v)).join('');
  if (!unique.map(String).includes(String(state[SELECTS[id]]))) state[SELECTS[id]] = '';
}

function fillFilters() {
  setChoices('field-filter', rows.map(row => E.field(row, state)), 'All fields');
  setChoices('publisher', rows.map(row => row.publisher), 'All publishers');
  setChoices('level', rows.map(row => row.norwegian_level), 'All levels');
}

function syncControls() {
  for (const [id, key] of Object.entries(SELECTS)) $(id).value = state[key];
  for (const [id, key] of Object.entries(CHECKBOXES)) $(id).checked = state[key];
  $('run').value = run.run;
  $('year').value = year;
  $('search').value = state.query;
  $('top-percent').value = state.topPercent;
  $('include-zero').checked = state.treatment === 'raw';
  $('universes').querySelectorAll('input').forEach(box => { box.checked = state.universes.includes(box.value); });
}

function showJournal(id) {
  const row = rows.find(r => r.openalex_id === id);
  if (!row) return;
  const details = [
    ['OpenAlex ID', `<a href="${openAlexUrl(row)}" target="_blank" rel="noopener noreferrer">${escape(id)} ↗ (new tab)</a>`],
    ['ISSNs', escape(row.issns || 'Unavailable')],
    ['Publisher', escape(row.publisher || 'Unavailable')],
    ['OpenAlex domain / field', escape([row.oa_domain, row.oa_field].filter(Boolean).join(' / ') || 'Unclassified')],
    ['Norwegian area / field', escape([row.norwegian_area, row.norwegian_field].filter(Boolean).join(' / ') || 'Unclassified')],
    [`Norwegian level ${year}`, escape(row.norwegian_level ?? 'Not in the register')],
    ['Open access journal', row.is_open_access == null ? 'Unknown' : row.is_open_access ? 'Yes' : 'No'],
    ['Publication years', `${fmt(row.active_years)} of 5 with eligible output`],
    ['Reference coverage', E.isNumber(row.reference_coverage_pct) ? `${fmt(row.reference_coverage_pct, 2)}%` : 'Unavailable'],
    ['Final percentile', ranks.poolRanks.has(id) ? `${fmt(ranks.poolRanks.get(id), 1)} · among ${count(ranks.retained)} journals` : escape(ranks.reasons.get(id) || 'Not eligible')],
  ];
  const scoreRow = u => row[`in_${u}`]
    ? Object.keys(METRICS).map(metric => `<td>${fmtScore(E.score(row, state, u, metric), metric)}</td>`).join('')
    : '<td colspan="2" class="not-member">Not in this universe</td>';
  $('dialog-content').innerHTML = `<p class="dialog-label">JOURNAL DETAILS · ${year} · ${state.treatment.toUpperCase()}</p><h2 id="dialog-title">${escape(row.title)}</h2>` +
    `<dl>${details.map(([key, value]) => `<dt>${key}</dt><dd>${value}</dd>`).join('')}</dl>` +
    `<table><thead><tr><th scope="col" class="align-left">Universe</th>${Object.values(METRICS).map(m => `<th scope="col">${m.short}</th>`).join('')}</tr></thead><tbody>` +
    universeIds().map(u => `<tr><th scope="row" class="align-left">${escape(universeName(u))}</th>${scoreRow(u)}</tr>`).join('') + '</tbody></table>' +
    `<p>Publications: ${fmt(E.columnValue(row, state, ranks, 'publications'))} eligible articles and reviews from ${year - 5}–${year - 1}. ` +
    `Citations in ${year}: ${fmt(E.columnValue(row, state, ranks, 'citations'))}, excluding journal self-citations.</p>`;
  $('journal-dialog').showModal();
}

// ---- Downloads ----

function saveCsv(filename, header, lines) {
  const cell = value => {
    let text = value == null ? '' : String(value);
    if (typeof value === 'string' && /^[=+@\-\t\r]/.test(text)) text = "'" + text; // keep spreadsheet formulas as plain text
    return '"' + text.replace(/"/g, '""') + '"';
  };
  const csv = '﻿' + [header, ...lines].map(line => line.map(cell).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function csvHeader(key) {
  if (key === 'field') return state.classification;
  if (key === 'fieldPct') return 'field_percentile';
  if (key === 'poolPct') return 'pool_percentile';
  if (key === 'publications' || key === 'citations') return `${key}_${state.treatment}`;
  if (key.startsWith('score:')) { const [, u, metric] = key.split(':'); return `${metric}_${u}_${state.treatment}`; }
  return key;
}

function downloadView() {
  const settings = {
    run: run.run, score_year: year, treatment: state.treatment, ranking_universe: state.rankUniverse, ranking_indicator: state.metric,
    classification: state.classification, coverage_strictly_above_pct: state.minCoverage < 0 ? 'none' : state.minCoverage,
    minimum_output_years: state.minYears, retained_top_pct_per_field: state.topPercent, final_pool_size: ranks.retained,
  };
  const header = ['openalex_id', ...columns.map(c => csvHeader(c.key)), 'percentile_exclusion_reason', ...Object.keys(settings)];
  const lines = visible.map(row => [row.openalex_id, ...columns.map(c => E.columnValue(row, state, ranks, c.key)),
    ranks.reasons.get(row.openalex_id) || '', ...Object.values(settings)]);
  saveCsv(`amsterdax-${run.run}-${year}-${state.treatment}-view.csv`, header, lines);
}

function downloadYear() {
  saveCsv(`amsterdax-${run.run}-${year}.csv`, dataColumns, rows.map(row => dataColumns.map(key => row[key])));
}

// ---- Events ----

const update = changes => { Object.assign(state, changes, { page: 0 }); render(); };

for (const [id, key] of Object.entries(SELECTS)) $(id).addEventListener('change', event => {
  const value = NUMERIC.has(key) ? Number(event.target.value) : event.target.value;
  if (key === 'classification') { state.classification = value; state.fieldFilter = ''; fillFilters(); }
  update({ [key]: value });
});
for (const [id, key] of Object.entries(CHECKBOXES)) $(id).addEventListener('change', event => update({ [key]: event.target.checked }));
$('run').addEventListener('change', event => loadRun(event.target.value).catch(showError));
$('year').addEventListener('change', event => loadYear(Number(event.target.value)).catch(showError));
$('search').addEventListener('input', event => update({ query: event.target.value }));
$('include-zero').addEventListener('change', event => update({ treatment: event.target.checked ? 'raw' : 'filtered' }));
$('top-percent').addEventListener('change', event => {
  const value = Number(event.target.value);
  const topPercent = Number.isFinite(value) ? Math.min(100, Math.max(1, Math.round(value))) : 100;
  event.target.value = topPercent;
  update({ topPercent });
});
$('universes').addEventListener('change', () => {
  const checked = [...$('universes').querySelectorAll('input:checked')].map(box => box.value);
  update({ universes: universeIds().filter(u => checked.includes(u)) });
});
$('more-filters').addEventListener('click', () => {
  const open = $('extra-filters').hidden;
  $('extra-filters').hidden = !open;
  $('more-filters').setAttribute('aria-expanded', String(open));
  $('more-filters').textContent = open ? 'Fewer filters −' : 'More filters +';
});
$('table-head').addEventListener('click', event => {
  const key = event.target.closest('[data-sort]')?.dataset.sort;
  if (!key) return;
  const textColumn = ['title', 'field', 'publisher', 'issns'].includes(key);
  update({ sortKey: key, sortDirection: state.sortKey === key ? -state.sortDirection : textColumn ? 1 : -1 });
  $('table-head').querySelector(`[data-sort="${key}"]`)?.focus({ preventScroll: true });
});
$('table-body').addEventListener('click', event => {
  const id = event.target.closest('[data-journal]')?.dataset.journal;
  if (id) showJournal(id);
});
$('previous').addEventListener('click', () => { state.page--; drawPage(); });
$('next').addEventListener('click', () => { state.page++; drawPage(); });
$('download-view').addEventListener('click', downloadView);
$('download-year').addEventListener('click', event => { if (event.target.id === 'download-year-csv') downloadYear(); });
$('close-dialog').addEventListener('click', () => $('journal-dialog').close());
$('sbe-preset').addEventListener('click', () => {
  Object.assign(state, SBE_PRESET);
  fillFilters(); syncControls(); render();
});
$('reset').addEventListener('click', () => {
  state = { ...DEFAULTS, universes: universeIds(), rankUniverse: universeIds().includes('n') ? 'n' : universeIds()[0] };
  fillFilters(); syncControls(); render();
});

// ---- Start ----

$('metric').innerHTML = Object.entries(METRICS).map(([metric, m]) => option(metric, `${m.short} · ${m.name}`)).join('');
try {
  index = await (await fetchOk('data/runs.json')).json();
  if (!index.runs.length) throw new Error('no data runs published yet');
  $('run').innerHTML = index.runs.map(r => option(r.run, r.run + (r.dummy ? ' (dummy)' : ''))).join('');
  await loadRun(index.runs[0].run);
} catch (error) {
  showError(error);
}
