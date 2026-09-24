# Amsterdax website

Website for browsing and downloading open journal scores (Journal Network Share and Article Network Score) computed from OpenAlex.

- `SPEC.md`: what the website does and the data layout.
- `publishing-data.md`: how to publish a new data run.
- `site/`: the website. `engine.js` holds the ranking logic, `app.js` the page.

## Preview locally

Needs Python with numpy, pandas and pyarrow.

```
python tools/make_dummy_data.py                       # made-up run in export/2026-Q3-dummy/
python tools/make_dummy_data.py 2027-Q1-dummy         # a second run, to try out frozen score years
python tools/build_site_data.py export 2027-Q1-dummy  # checks the runs and assembles site/data/ from the named latest run
python -m http.server --directory site                # then open http://localhost:8000
```

`score-years.json` decides which score years are frozen to which run; everything else comes from the latest run.

Tests for the ranking logic: `node tests/engine.test.mjs` (also run on every deploy).
