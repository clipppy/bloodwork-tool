# Bloodwork Analysis Tool — Local Web UI

A single-page local web app for generating a functional medicine Word report
from a lab PDF. It is a thin front end over the existing pipeline
(parse → match → flag → Word generator) — it does not reimplement any of that
logic, it imports it from `lib/`.

## Start it

```bash
npm run ui
```

Then open:

```
http://localhost:3000
```

(`npm run ui` runs `next dev` on the default port 3000. Stop it with Ctrl-C.)

## What it does

1. Drop or browse to a lab PDF in the upload zone.
2. Optionally type a patient name (defaults to "Patient") and pick a date
   (defaults to today).
3. Click **Generate Report**.
4. The generated `.docx` downloads to your browser's default download folder.

The output is identical to what the CLI produces
(`npm run cli -- <pdf> --generate-word <out.docx>`) for the same inputs.

## Runs entirely locally — no data leaves the machine

- No PDF or generated document is ever written to disk or persisted anywhere.
  The uploaded PDF is held in memory, processed, and the result is streamed
  straight back to the browser as a download.
- No database, no accounts, no history, no analytics, no telemetry.
- Nothing is sent to any external service. Everything runs on `localhost`.

## Notes

- Open the downloaded `.docx` in Microsoft Word or Google Docs — Apple Pages
  may not render all table content correctly.
- For development, use the test fixtures in `samples/` — do not upload real
  patient PDFs while developing.
