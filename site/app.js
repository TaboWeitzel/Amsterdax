// Amsterdax website: loads a data run and draws the journal table. The ranking logic is in engine.js.
import { asyncBufferFromUrl, parquetMetadataAsync, parquetReadObjects } from 'https://cdn.jsdelivr.net/npm/hyparquet@1.31.1/+esm';
import * as E from './engine.js';

const $ = id => document.getElementById(id);
const PAGE_SIZE = 25;
const LEVELS_URL = 'https://kanalregister.hkdir.no/en/informasjonsartikler/levels-and-changes-in-levels';
// The only place where the scores are named; the keys match the data columns (see SPEC.md).
const METRICS = {
  share: { short: 'JNS', name: 'Journal Network Share', note: 'share of citation-network prestige; sums to 100 over the universe', digits: 5 },
  per_article: { short: 'ANS', name: 'Article Network Score', note: 'network share per article; article-weighted mean 1', digits: 3 },
};
const DEFAULTS = {
  treatment: 'filtered', universe: 'n', metric: 'per_article', classification: 'norwegian_field',
  minCoverage: 20, minYears: 0, topPercent: 100, query: '', fieldFilter: '', publisher: '', level: '',
  onlyMembers: false, oaOnly: false, poolOnly: false, details: false, showPercentiles: false,
  sortKey: 'score:per_article', sortDirection: -1, page: 0,
};
const EXAMPLE_PRESET = {
  treatment: 'filtered', universe: 'n', metric: 'per_article', classification: 'oa_field', minCoverage: 20,
  minYears: 4, topPercent: 70, showPercentiles: true, poolOnly: true, query: '', fieldFilter: '', publisher: '',
  level: '', onlyMembers: false, oaOnly: false, page: 0,
};

let index;          // data/runs.json: the runs on this site, newest first
let run;            // the selected run
let manifest;       // its manifest.json
let year;           // the selected score year
let rows = [];      // journals of the selected run and year
let dataColumns = [];
let state = { ...DEFAULTS };
let ranks, ranksKey, visible, columns, memberCount;
const yearFiles = new Map(); // score files of other years, opened on demand for the journal details
let historyRequest = 0;

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
  if (!ids.includes(state.universe)) state.universe = ids[0];
  $('universe').innerHTML = '<legend>Universe</legend>' + ids.map(u =>
    `<label class="universe-chip"><input type="radio" name="universe" value="${escape(u)}"> ${escape(universeName(u))}</label>`).join('');
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
  for (const [metric, m] of Object.entries(METRICS)) cols.push(
    { key: `score:${metric}`, label: m.short, className: metric === 'share' ? 'group-start' : '', score: true, title: `${m.name} in the ${universeName(state.universe)} universe (${m.note})` });
  if (state.showPercentiles) cols.push(
    { key: 'fieldPct', label: 'Field pct.', className: 'group-start percentile-cell', title: 'Percentile within its field, after the coverage and history requirements' },
    { key: 'poolPct', label: `${METRICS[state.metric].short} pct.`, className: 'percentile-cell', title: 'Percentile among all retained journals; 100 is highest' });
  return cols;
}

function renderHead() {
  const profileColumns = columns.filter(c => !c.score && !c.key.endsWith('Pct')).length;
  const groups = `<th scope="colgroup" colspan="${profileColumns}" class="meta-group">Journal profile · ${year - 5}–${year - 1} publications · ${year} citations</th>` +
    `<th scope="colgroup" colspan="${Object.keys(METRICS).length}" class="score-group ${escape(state.universe)}">${escape(universeName(state.universe))}</th>` +
    (state.showPercentiles ? `<th scope="colgroup" colspan="2" class="percentile-group">Percentiles · ${METRICS[state.metric].short}</th>` : '');
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
  if (col.score) {
    const metric = col.key.split(':')[1];
    if (!row[`in_${state.universe}`]) {
      if (metric !== Object.keys(METRICS)[0]) return ''; // one note spans all score columns
      const other = universeIds().find(u => u !== state.universe && row[`in_${u}`]);
      const link = other ? ` <button type="button" class="text-button" data-universe="${escape(other)}">Show in ${escape(universeName(other))}</button>` : '';
      return `<td colspan="${Object.keys(METRICS).length}" class="not-member-cell group-start">Not in the ${escape(universeName(state.universe))} universe.${link}</td>`;
    }
    const classes = `metric-cell ${col.className || ''} ${metric === 'per_article' ? 'per-article-cell' : ''}`;
    return `<td class="${classes} ${value == null ? 'missing' : ''}" title="${value == null ? 'In this universe, but no score' : escape(value)}">${fmtScore(value, metric)}</td>`;
  }
  return `<td>${fmt(value)}</td>`;
}

function render() {
  // Percentiles only depend on the ranking settings, so they are recomputed only when those change.
  const key = JSON.stringify([state.treatment, state.universe, state.metric, state.classification, state.minCoverage, state.minYears, state.topPercent]);
  if (key !== ranksKey) { ranks = E.rank(rows, state); ranksKey = key; }
  columns = getColumns();
  if (!columns.some(col => col.key === state.sortKey)) Object.assign(state, { sortKey: 'title', sortDirection: 1 });
  visible = E.view(rows, state.showPercentiles ? state : { ...state, poolOnly: false }, ranks);
  memberCount = rows.filter(row => row[`in_${state.universe}`]).length;
  $('percentile-settings').hidden = !state.showPercentiles;
  drawPage();
}

// Draws the current page only; paging doesn't need to filter and sort again.
function drawPage() {
  state.page = Math.max(0, Math.min(state.page, Math.ceil(visible.length / PAGE_SIZE) - 1));
  const shown = visible.slice(state.page * PAGE_SIZE, (state.page + 1) * PAGE_SIZE);
  renderHead();
  $('table-body').innerHTML = shown.length ? shown.map(row => `<tr>${columns.map(col => cell(row, col)).join('')}</tr>`).join('')
    : `<tr><td colspan="${columns.length}" class="empty-cell">No journals match these choices. Try a broader search or reset the filters.</td></tr>`;
  $('result-count').textContent = `${count(visible.length)} journals shown · ${count(memberCount)} of ${count(rows.length)} are in the ${universeName(state.universe)} universe`;
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

const SELECTS = { metric: 'metric', classification: 'classification', coverage: 'minCoverage', 'min-years': 'minYears',
  'field-filter': 'fieldFilter', publisher: 'publisher', level: 'level' };
const NUMERIC = new Set(['minCoverage', 'minYears']);
const CHECKBOXES = { 'only-members': 'onlyMembers', 'oa-only': 'oaOnly', 'details-columns': 'details',
  'show-percentiles': 'showPercentiles', 'pool-only': 'poolOnly' };

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
  $('universe').querySelectorAll('input').forEach(radio => { radio.checked = radio.value === state.universe; });
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
    [`Norwegian level ${year}`, row.norwegian_level == null ? 'Not in the register'
      : `<a href="${LEVELS_URL}" target="_blank" rel="noopener noreferrer">Level ${escape(row.norwegian_level)} ↗ (what levels mean)</a>`],
    ['Open access journal', row.is_open_access == null ? 'Unknown' : row.is_open_access ? 'Yes' : 'No'],
    ['Publication years', `${fmt(row.active_years)} of 5 with eligible output`],
    ['Reference coverage', E.isNumber(row.reference_coverage_pct) ? `${fmt(row.reference_coverage_pct, 2)}%` : 'Unavailable'],
  ];
  if (state.showPercentiles) details.push(['Final percentile', ranks.poolRanks.has(id)
    ? `${fmt(ranks.poolRanks.get(id), 1)} · among ${count(ranks.retained)} journals` : escape(ranks.reasons.get(id) || 'Not eligible')]);
  $('dialog-content').innerHTML = `<p class="dialog-label">JOURNAL DETAILS · ${year} · ${state.treatment.toUpperCase()}</p><h2 id="dialog-title">${escape(row.title)}</h2>` +
    `<dl>${details.map(([key, value]) => `<dt>${key}</dt><dd>${value}</dd>`).join('')}</dl>` +
    `<h3>Scores by year · ${escape(universeName(state.universe))} universe · ${state.treatment === 'raw' ? 'Raw' : 'Filtered'}</h3><div id="history"></div>` +
    `<p>Publications: ${fmt(E.columnValue(row, state, ranks, 'publications'))} eligible articles and reviews from ${year - 5}–${year - 1}. ` +
    `Citations in ${year}: ${fmt(E.columnValue(row, state, ranks, 'citations'))}, excluding journal self-citations.</p>`;
  $('journal-dialog').showModal();
  showHistory(id);
}

function yearFile(y) {
  const url = `data/${run.run}/scores_${y}.parquet`;
  if (!yearFiles.has(url)) yearFiles.set(url, (async () => {
    const file = await asyncBufferFromUrl({ url });
    return { file, metadata: await parquetMetadataAsync(file, { initialFetchSize: 1 << 17 }) }; // index is ~100 KB
  })());
  return yearFiles.get(url);
}

// The journal's row in every score year of the run. The site's files are sorted by journal in small
// row groups (see tools/build_site_data.py), so only a small part of each file is downloaded.
async function journalHistory(id) {
  const u = state.universe, t = state.treatment;
  const columns = ['openalex_id', 'norwegian_level', `publications_${t}`, 'reference_coverage_pct', `in_${u}`,
    ...Object.keys(METRICS).map(metric => `${metric}_${u}_${t}`)];
  return Promise.all([...manifest.years].sort((a, b) => b - a).map(async y => {
    if (y === year) return [y, rows.find(r => r.openalex_id === id)];
    const { file, metadata } = await yearFile(y);
    const [found] = await parquetReadObjects({ file, metadata, columns, filter: { openalex_id: { $eq: id } } });
    return [y, found ? E.toNumbers(found) : null];
  }));
}

async function showHistory(id) {
  const request = ++historyRequest; // ignore late answers for a journal that is no longer shown
  const u = state.universe, metrics = Object.keys(METRICS);
  $('history').innerHTML = '<p>Loading the other years…</p>';
  try {
    const history = await journalHistory(id);
    if (request !== historyRequest) return;
    const cells = r => !r ? `<td colspan="${4 + metrics.length}" class="missing">Not in the data for this year</td>`
      : `<td>${r[`in_${u}`] ? 'Yes' : 'No'}</td><td>${escape(r.norwegian_level ?? '—')}</td>` +
        `<td>${fmt(r[`publications_${state.treatment}`])}</td><td>${E.isNumber(r.reference_coverage_pct) ? `${fmt(r.reference_coverage_pct, 1)}%` : '—'}</td>` +
        metrics.map(metric => `<td>${r[`in_${u}`] ? fmtScore(E.score(r, state, u, metric), metric) : '—'}</td>`).join('');
    $('history').innerHTML = '<table><thead><tr><th scope="col" class="align-left">Score year</th><th scope="col">In universe</th>' +
      '<th scope="col">Level</th><th scope="col">Publications</th><th scope="col">Ref. coverage</th>' +
      `${Object.values(METRICS).map(m => `<th scope="col">${m.short}</th>`).join('')}</tr></thead><tbody>` +
      history.map(([y, r]) => `<tr class="${y === year ? 'current-year' : ''}"><th scope="row" class="align-left">${y}</th>${cells(r)}</tr>`).join('') +
      '</tbody></table>';
  } catch (error) {
    if (request === historyRequest) $('history').textContent = `The other years could not be loaded (${error.message}).`;
  }
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
  if (key.startsWith('score:')) return `${key.split(':')[1]}_${state.universe}_${state.treatment}`;
  return key;
}

function downloadView() {
  const settings = { run: run.run, score_year: year, universe: state.universe, treatment: state.treatment, classification: state.classification };
  if (state.showPercentiles) Object.assign(settings, {
    ranking_indicator: state.metric, coverage_strictly_above_pct: state.minCoverage < 0 ? 'none' : state.minCoverage,
    minimum_output_years: state.minYears, retained_top_pct_per_field: state.topPercent, final_pool_size: ranks.retained,
  });
  const reason = row => (state.showPercentiles ? [ranks.reasons.get(row.openalex_id) || ''] : []);
  const header = ['openalex_id', `in_${state.universe}`, ...columns.map(c => csvHeader(c.key)),
    ...(state.showPercentiles ? ['percentile_exclusion_reason'] : []), ...Object.keys(settings)];
  const lines = visible.map(row => [row.openalex_id, row[`in_${state.universe}`],
    ...columns.map(c => E.columnValue(row, state, ranks, c.key)), ...reason(row), ...Object.values(settings)]);
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
$('universe').addEventListener('change', event => update({ universe: event.target.value }));
$('settings-toggle').addEventListener('click', () => {
  const open = $('settings').hidden;
  $('settings').hidden = !open;
  $('settings-toggle').setAttribute('aria-expanded', String(open));
  $('settings-toggle').textContent = open ? 'Settings −' : 'Settings +';
});
$('table-head').addEventListener('click', event => {
  const key = event.target.closest('[data-sort]')?.dataset.sort;
  if (!key) return;
  const textColumn = ['title', 'field', 'publisher', 'issns'].includes(key);
  update({ sortKey: key, sortDirection: state.sortKey === key ? -state.sortDirection : textColumn ? 1 : -1 });
  $('table-head').querySelector(`[data-sort="${key}"]`)?.focus({ preventScroll: true });
});
$('table-body').addEventListener('click', event => {
  const universe = event.target.closest('[data-universe]')?.dataset.universe;
  if (universe) { update({ universe }); syncControls(); return; }
  const id = event.target.closest('[data-journal]')?.dataset.journal;
  if (id) showJournal(id);
});
$('previous').addEventListener('click', () => { state.page--; drawPage(); });
$('next').addEventListener('click', () => { state.page++; drawPage(); });
$('download-view').addEventListener('click', downloadView);
$('download-year').addEventListener('click', event => { if (event.target.id === 'download-year-csv') downloadYear(); });
$('close-dialog').addEventListener('click', () => $('journal-dialog').close());
$('example-preset').addEventListener('click', () => {
  Object.assign(state, EXAMPLE_PRESET);
  fillFilters(); syncControls(); render();
});
$('reset').addEventListener('click', () => {
  state = { ...DEFAULTS };
  if (!universeIds().includes(state.universe)) state.universe = universeIds()[0];
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
