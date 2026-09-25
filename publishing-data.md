# Publishing a new data run

Each pipeline run is published as a GitHub Release. The website then updates itself, but only for the score years that are **live**: years that are **frozen** keep coming from the run they are frozen to. See "Freezing a score year" below.

## One-time setup (repository owner)

**Settings → Pages**: under *Build and deployment*, set **Source** to **Deploy from a branch**, then choose the branch **gh-pages** and the folder **/ (root)**, and click **Save**. The `gh-pages` branch appears after the deploy workflow has run once; it holds the finished website and is overwritten on every deploy.

## Steps

1. Run the pipeline. It writes one CSV with all score years.
2. Turn that CSV into the files for the release:

   ```
   python tools/import_run.py <the csv file> 2026-Q3
   ```

   `2026-Q3` is the name of the run; use the quarter the data was made in. This writes `export/2026-Q3/`, with a `scores_<year>.parquet` per score year and a `manifest.json` (exact contents: see `SPEC.md`). The command prints how many journals each score year has, per universe; stop and check the CSV if those numbers look wrong.
3. On GitHub, open the repository and click **Releases** (right-hand side), then **Draft a new release**.
4. Under **Choose a tag**, type the run name exactly as in `manifest.json` (e.g. `2026-Q3`) and select **Create new tag on publish**. Use the same name as the title. This name is also what `score-years.json` refers to.
5. Drag all files from the export folder into the upload box. Wait until every upload has finished.
6. Click **Publish release**.

The live score years show the new run within a few minutes; frozen years stay as they are. The website shows per score year whether it is frozen or live, with the OpenAlex snapshot date from `manifest.json`. To follow progress, open the **Actions** tab. Two runs appear one after the other: **Deploy website** checks the data and builds the site, then **pages build and deployment** puts it online.

- Green check on both: the new run is online. A *cancelled* **pages build and deployment** can be ignored: a newer one replaced it.
- Red cross on **pages build and deployment**: usually a temporary problem at GitHub. Open the run and click **Re-run failed jobs**.
- Red cross on **Deploy website**: the files failed a check and nothing was published. The previous version stays online, and GitHub sends you an email with the reason.

## Freezing a score year

A score year that should no longer change is listed in `score-years.json`, with the run it comes from:

```json
{
  "2024": "2026-Q2",
  "2025": "2026-Q2"
}
```

- Edit the file on GitHub (pencil icon) and merge the change. The deploy starts by itself, and from then on that score year is always published from that run; new runs no longer change it.
- A score year that is not listed follows the newest run.
- Remove a line to let a year follow the newest run again, or change the run name to move it to a different run.

The deploy stops with a clear message if the named run does not exist or does not contain that score year.

## Fixing mistakes

- **Wrong or missing file:** open the release, click the pencil icon, remove or add files and click **Update release**.
- **Remove a run:** open the release and delete it. First check `score-years.json`: if a score year is frozen to that run, remove or change that line in the same go, otherwise the deploy stops with an error.

After either fix, open **Actions**, select **Deploy website** and click **Run workflow**.
