# cursor-sidecar

Standalone cursor telemetry logger for Magic AutoPass v4 (creatorgrowth
editor). Run it alongside an OBS screen recording; attach the resulting
`.ndjson` to the clip via **Auto Magic → chevron → Attach cursor log…** in the
editor. Auto Magic then knows exactly where the mouse settled and clicked, and
places its zooms on those targets.

Adapted from [OpenScreen](https://github.com/siddharthvaddem/openscreen) (MIT)
— their macOS cursor helper, with position emission added (the original only
logged clicks + element type), file output, and the cursor-bitmap capture
dropped.

## Build

```bash
./build.sh        # → ./cursor-sidecar
```

## Use with OBS (the intended flow)

Install once: OBS → **Tools → Scripts → "+"** → pick `obs/cursor-sidecar.lua`.
From then on every recording start launches the logger and every stop drops a
matching telemetry file next to the recording:

```
~/Documents/OBS Folder/2026-06-11 21-00-00.mkv
~/Documents/OBS Folder/2026-06-11 21-00-00.cursor.ndjson
```

Drag the `.cursor.ndjson` anywhere into the creatorgrowth editor (or use
Auto Magic → chevron → Attach cursor log…) and run Auto Magic.

OBS-launched processes get their Accessibility permission attributed to OBS —
grant **OBS** in System Settings → Privacy & Security → Accessibility for
click/element data. Positions log regardless.

## Manual use

```bash
./cursor-sidecar                          # logs to ~/Movies/cursor-logs/<epoch>.ndjson
./cursor-sidecar --out /tmp/take1.ndjson  # explicit path
./cursor-sidecar --interval-ms 16         # ~60 Hz (default 33 ≈ 30 Hz)
```

Start it right before (or after) hitting record, stop with **Ctrl-C** when the
recording stops. Manual start is fine — alignment tolerance is wide (see below).

## Output format

NDJSON, one JSON object per line:

```
{"type":"header","version":1,"startEpochMs":1718123456789,"sampleIntervalMs":33,"displayWidth":2056,"displayHeight":1329,"accessibilityTrusted":true,"mouseTapReady":true}
{"type":"sample","timeMs":0,"cx":0.4213,"cy":0.6118,"leftButtonDown":false,"leftButtonPressed":false,"cursorType":null}
{"type":"sample","timeMs":33,"cx":0.4213,"cy":0.6118,"leftButtonDown":true,"leftButtonPressed":true,"cursorType":"pointer"}
```

- `timeMs` — milliseconds since `startEpochMs`
- `cx`/`cy` — cursor position normalized 0–1 against the primary display,
  top-left origin (the OpenScreen telemetry contract)
- `leftButtonPressed` — a left-click landed in this sample window
- `cursorType` — `"pointer"` over a button/link/menu, `"text"` over a text
  input, `null` otherwise (requires Accessibility trust)

## macOS permissions (TCC)

The CGEvent click tap and the AX element classification need **Accessibility**
trust. First run prompts; grant the **binary itself** (or the launching
terminal) in System Settings → Privacy & Security → Accessibility.

Without the grant the tool still logs positions — `cursorType` stays `null`
and clicks fall back to button-state polling (still accurate at the dwell
timescale).

Known pitfalls on this Mac (see Claude memory):

- **Re-signing/rebuilding a binary wipes its TCC grants** — re-grant after a
  rebuild.
- **A daemonized tmux server can hold a stale denied TCC context** — if the
  tool can't tap from inside tmux, `tmux kill-server` and respawn from a
  Terminal that has the grant.

## Aligning with an OBS recording

The header's `startEpochMs` is the absolute wall-clock start. OBS stamps the
recording file's creation time at record start:

```bash
stat -f %B ~/Movies/recording.mkv        # birth time, epoch seconds
# offsetMs = startEpochMs - (birthTime * 1000)
# a cursor sample at timeMs T sits at video time (T + offsetMs) / 1000 seconds
```

Pixel-perfect sync is NOT required: dwell windows are 450 ms+, so ±100 ms is
fine. If the filesystem birth time is unreliable (some recording formats
rewrite the file at stop), start the sidecar first and note that OBS's
"Recording started" toast lags the actual file start by under a second.

If a dwell looks systematically offset in the editor, trim/cut differences are
the more likely cause — the editor maps media time through the timeline cuts,
so the log must correspond to the **original recording**, not a re-encode that
changed the start.
