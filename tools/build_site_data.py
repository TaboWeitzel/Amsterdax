"""Check data runs and copy them into the website (site/data/), with a runs.json index.

Usage: python tools/build_site_data.py <runs_folder> [releases_url]
<runs_folder> holds one subfolder per run (manifest.json + scores_<year>.parquet, see SPEC.md).
The deploy workflow runs this on the downloaded releases; locally, run it on export/ to preview the site.
Stops with an error if a run doesn't match the layout, so nothing broken gets published. Needs pyarrow.
"""
import json
import shutil
import sys
from pathlib import Path

import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq

SITE_DATA = Path(__file__).resolve().parent.parent / "site" / "data"
COLUMNS = ["openalex_id", "title", "publisher", "issn_l", "issns", "oa_domain", "oa_field", "norwegian_area",
           "norwegian_field", "norwegian_level", "is_open_access", "score_year", "publications_raw",
           "publications_filtered", "citations_raw", "citations_filtered", "reference_coverage_pct", "active_years"]


def check_run(folder):
    manifest_file = folder / "manifest.json"
    if not manifest_file.exists():
        sys.exit(f"{folder.name}: manifest.json is missing")
    manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
    for key in ("run", "created", "years", "universes"):
        if key not in manifest:
            sys.exit(f"{folder.name}: manifest.json has no '{key}'")
    if manifest["run"] != folder.name:
        sys.exit(f"{folder.name}: manifest.json says run '{manifest['run']}', but the release is called '{folder.name}'")
    universes = manifest["universes"]
    expected = COLUMNS + [f"in_{u}" for u in universes] + [
        f"{metric}_{u}_{treatment}" for u in universes for metric in ("share", "per_article") for treatment in ("raw", "filtered")]
    for year in manifest["years"]:
        path = folder / f"scores_{year}.parquet"
        if not path.exists():
            sys.exit(f"{folder.name}: {path.name} is missing")
        missing = [c for c in expected if c not in pq.read_schema(path).names]
        if missing:
            sys.exit(f"{folder.name}/{path.name}: missing columns {missing}")
    return manifest


def copy_run(folder, manifest):
    """Copy a run into the site and add the history files used by the journal details."""
    target = SITE_DATA / folder.name
    shutil.copytree(folder, target)
    write_history(target, manifest)


def write_history(target, manifest):
    """Split the scores of all years into 100 small files by the last two digits of the journal ID.

    The journal details then download one small file instead of every year's full file. (GitHub Pages
    compresses Parquet files, so the browser cannot download just the part of a file it needs.)
    """
    columns = ["openalex_id", "score_year", "norwegian_level", "publications_raw", "publications_filtered",
               "reference_coverage_pct"]
    for u in manifest["universes"]:
        columns += [f"in_{u}", f"share_{u}_raw", f"share_{u}_filtered", f"per_article_{u}_raw", f"per_article_{u}_filtered"]
    history = pa.concat_tables(pq.read_table(target / f"scores_{year}.parquet", columns=columns)
                               for year in manifest["years"])
    group = pc.utf8_slice_codeunits(history["openalex_id"], -2)
    (target / "history").mkdir()
    for key in pc.unique(group).to_pylist():
        pq.write_table(history.filter(pc.equal(group, key)), target / "history" / f"{key}.parquet")


def main(runs_folder, releases_url=None):
    shutil.rmtree(SITE_DATA, ignore_errors=True)
    SITE_DATA.mkdir(parents=True)
    runs = []
    for folder in sorted(p for p in Path(runs_folder).iterdir() if p.is_dir()):
        manifest = check_run(folder)
        copy_run(folder, manifest)
        runs.append({"run": folder.name, "created": manifest["created"], "dummy": manifest.get("dummy", False),
                     "release_url": f"{releases_url}/tag/{folder.name}" if releases_url else None})
    runs.sort(key=lambda r: r["created"], reverse=True)
    index = {"releases_url": releases_url, "runs": runs}
    (SITE_DATA / "runs.json").write_text(json.dumps(index, indent=2), encoding="utf-8")
    print(f"Checked {len(runs)} run(s) and copied them to {SITE_DATA}")


if __name__ == "__main__":
    main(*sys.argv[1:])
