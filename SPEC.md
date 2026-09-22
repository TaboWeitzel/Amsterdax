# Amsterdax website

A public website where anyone can browse, filter and download open journal scores: Journal Network Share (JNS), Article Network Score (ANS) and ANS percentiles, computed from OpenAlex by the Amsterdax back-end. JNS and ANS follow the recursive citation-network method of Bergstrom, West and Wiseman (2008). The original names of these scores are trademarks of the University of Washington and are not used. No accounts, no payments; all data is open. Expected traffic is low (a few downloads a day).

The back-end is a separate project (currently run on a laptop, possibly Docker/cloud later). This project covers the website and the data layout the back-end delivers.

## Architecture

- Static website: plain HTML, CSS and JavaScript, no framework, no build step. Everything runs in the visitor's browser.
- Hosted free on GitHub Pages, later with a custom domain.
- Each data run is published as a GitHub Release of this repository. The releases are the permanent archive.
- A deploy workflow (GitHub Actions) runs on every new release and on demand. It checks the files, copies the 3 most recent runs into the site (older runs stay downloadable as releases) and pushes the finished site as a single commit to the `gh-pages` branch, which GitHub Pages serves. See `publishing-data.md`.
- No account or repository names in the code, because the repository will change owner.

## Data layout

One release per run. The tag is the run name, e.g. `2026-Q3`. Each release contains:

**`manifest.json`**

```json
{
  "run": "2026-Q3",
  "created": "2026-09-21",
  "dummy": false,
  "openalex_snapshot": "2026-06-26",
  "norwegian_register_snapshot": "2026-07-26",
  "years": [2022, 2023, 2024, 2025],
  "universes": {"n": "Norwegian Register", "oa": "OpenAlex"}
}
```

**`scores_<year>.parquet`**, one per score year: one row per journal that is in at least one universe that year. Missing values are nulls; a zero is a real zero.

| Column | Type | Meaning |
|---|---|---|
| `openalex_id` | text | OpenAlex source ID, e.g. `S117778295` |
| `title`, `publisher` | text | |
| `issn_l` | text | Linking ISSN |
| `issns` | text | All ISSNs, separated by `; ` |
| `oa_domain`, `oa_field` | text | OpenAlex primary domain and field |
| `norwegian_area`, `norwegian_field` | text | Norwegian Register area and field |
| `norwegian_level` | integer | 1 or 2 in this score year |
| `is_open_access` | boolean | |
| `score_year` | integer | Year t |
| `publications_raw` | integer | Articles and reviews published in t-5 to t-1 |
| `publications_filtered` | integer | Those with at least one recorded reference |
| `citations_raw`, `citations_filtered` | integer | Citations in year t to those publications, excluding journal self-citations |
| `reference_coverage_pct` | number | 100 × `publications_filtered` / `publications_raw` |
| `active_years` | integer | Years (of 5) with at least one publication |
| `in_<u>` | boolean | Journal is in universe `<u>` this year |
| `share_<u>_raw`, `share_<u>_filtered` | number | JNS in universe `<u>`; sums to 100 over the universe; null if not computed |
| `per_article_<u>_raw`, `per_article_<u>_filtered` | number | ANS in universe `<u>`; article-weighted mean 1; null if not computed |

`<u>` is each universe listed in the manifest. Adding a universe means new columns and a manifest entry, with no website changes.

## Website

Based on the existing demo prototype.

- Top bar: run (default: latest), score year, universe (Norwegian Register by default, or OpenAlex) and a Settings button. All other choices are in one collapsible settings panel.
- Table of all journals with the JNS and ANS of the selected universe. Search by title, ID, ISSN or publisher; filter by field, publisher, Norwegian level and open access; sort by any column; rows are shown a page at a time.
- Journals outside the selected universe stay in the table, listed last, with a link to switch to a universe that contains them. A setting hides them. "Not in this universe" is shown differently from "in this universe, but no score".
- Defaults: Filtered scores (a setting switches to Raw) and Norwegian fields as field classification.
- Percentiles are off by default. When switched on, they are computed in the browser within the selected universe, from the chosen indicator (JNS or ANS), field classification, minimum reference coverage, minimum active years and top % kept per field. An example preset fills these in. Ties get the highest shared rank.
- Journal detail view, with a link to OpenAlex.
- Downloads: the current view as CSV, a full year as CSV or Parquet, and every run's release files.
- Info page: what the scores mean, a method summary, data sources and attribution (Norwegian Register), how to cite, license.
- Dummy data runs show a clear banner.

## Repository layout

```
site/                  the website (data/ is filled in by the deploy workflow)
tests/                 tests for the ranking logic
tools/                 make_dummy_data.py, build_site_data.py (checks runs, copies them into site/data/)
.github/workflows/     deploy workflow
```

## Open points

- Score names: JNS and ANS are our own names. Permission or legal advice on the original names is still open.
- License for the code and for the data.
- Custom domain.
- Small-field pooling for percentiles: the report pools fields with fewer than 100 journals, the demo doesn't.
- First real run from the back-end, including the `in_<u>` flags.
