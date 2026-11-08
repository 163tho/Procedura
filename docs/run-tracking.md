# Run tracking

Every invocation of the unified Procedura pipeline writes two files directly
beside its model outputs:

- **run.json**: experiment metadata, invocation history, totals, timing and outcome.
- **api_calls.jsonl**: an append-only journal of model-request attempts.

This applies to the API CLI, batch and Studio calls to runProcedura.
No billing login or extra generation request is needed.

## Running and reading a record

Existing commands work unchanged. Optional labels help group thesis experiments:

~~~bash
bun run scripts/procedura.ts -o outputs/buggy_trial_01 \
  --prompt-file /path/to/prompt.txt --image /path/to/reference.png \
  --experiment baseline --dataset-id assault_buggy --repetition 1
~~~

During and after execution, inspect the latest invocation:

~~~bash
jq '.attempts[-1] | {status, duration_ms, usage, outcome}' outputs/buggy_trial_01/run.json
~~~

For totals across all invocations in that folder:

~~~bash
jq '.totals' outputs/buggy_trial_01/run.json
~~~

Use a new output folder for a new experiment. Resuming or using --redo in an
existing folder preserves its run_id, appends an invocation with a new
attempt_id, and retains the previous invocations. Totals count each physical
request once. Existing outputs created before tracking are flagged as prior untracked\nwork; their historical costs cannot be reconstructed. Earlier artifact hashes remain in history even if files are
replaced by a subsequent invocation.

## Summary contents

The schema_version field versions the format. Each entry in attempts contains:

- UTC start/end timestamps, elapsed milliseconds, status and error/stopping reason.
- Optional experiment name, dataset ID and repetition index.
- Full Git commit and branch (null for detached HEAD), dirty status, source and
  prompt hashes, tracked source diff and untracked source contents. This captures
  the actual implementation rather than assuming a commit describes local edits.
- Prompt and input-file hashes, requested options, relevant environment overrides,
  resolved default model choices and a snapshot of pricing.
- OS/runtime versions, CPU/RAM information and available Python/OpenSCAD/Blender
  versions and GPU model/driver. Missing tools or unavailable Git information are
  recorded as null.
- Phase execution/skips, API and local processing timing, retry wait time, model
  results, generated/failed part counts, refinement verdict and available
  motion/paint validation results.
- Input/output artifact hashes. Reused artifacts are distinguished from newly
  executed phases.

The root status describes the latest invocation. A completed status means the
pipeline returned successfully with its stage checks satisfied. A needs_review
status means it returned but a stage reported a problem or refinement exhausted
its budget. This is not a perceptual quality score. Dataset-specific evaluation
can be recorded separately and linked through run_id and output hashes.

Actual request parameters and returned model identifiers are saved in the API
journal, so model overrides and provider defaults do not have to be inferred.

## Usage and cost

Each physical HTTP attempt is observed, including transport retries, stream
continuations, image-generation requests and replies with no usable text. Headers
and credentials are not saved. Request bodies are represented by hashes and
small parameter summaries; model text/image payloads are not copied into the
API journal.

The journal contains started and finished events with the same call_id.
**Use the last event for each call; do not sum every line.** The summary already
deduplicates these records.

Usage is normalized for Anthropic Messages, OpenAI-compatible Chat Completions,
and Gemini. Input totals include cached input. Reasoning counts are subsets of
output and are not added a second time. Native Anthropic start-event counts are
merged with cumulative final output counts. Usage can be complete, partial or
unknown; missing usage is not represented as a free request. Accounting covers
HTTP model requests made by the pipeline; work performed externally is not metered.

Token totals sum calls with complete usage and include a coverage flag. For a
partial call, any available raw usage remains in the journal. Cost fields are:

- **known_estimated_usd**: subtotal of requests with a complete estimate.
- **estimated_usd**: null if any request lacks an estimate.
- **billed_usd**: null; this logger does not query organization billing or balance.

Built-in rates cover **Claude Sonnet 5.5**, model ID claude-sonnet-5-5, served
directly by api.anthropic.com. The saved list-price snapshot was checked on
**2026-11-06**, in USD per million tokens:

| Uncached input | Output | Cache read | 5-minute cache write | 1-hour cache write |
| --- | --- | --- | --- | --- |
| 2.00 | 10.00 | 0.10 | 2.50 | 4.00 |

Source: [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing).

These are **estimates at published list prices**, not confirmation of your
organization's contract or how grant credits are applied. OpenAI-compatible
responses that omit cache breakdowns are priced at the base input rate and carry
an explicit assumption. Unknown models/endpoints, unsupported pricing modifiers,
incomplete usage and additional server-tool charges produce an unknown cost.

Override rates using --pricing-file PATH or PROCEDURA_PRICING_FILE.
Every model entry requires all five nonnegative rates. The file is snapshotted
into the invocation so later pricing changes cannot alter old estimates:

~~~json
{
  "currency": "USD",
  "basis": "configured_rate_estimate",
  "source": "Organization rate sheet, confirmed by account owner",
  "as_of": "2026-11-06",
  "models": {
    "claude-sonnet-5-5": {
      "input": 2.0,
      "output": 10.0,
      "cache_read": 0.1,
      "cache_write_5m": 2.5,
      "cache_write_1h": 4.0
    }
  }
}
~~~

## Timing, failures and recovery

API-request time is measured from sending a request until its response stream
ends, including network and provider queuing. It is not a measurement of
server-side GPU inference alone. The run duration covers pipeline execution
and recording overhead; CLI staging copy/sync time is outside that duration.
Nested and concurrent stage durations overlap and must not be summed into
wall-clock time.

Summaries are atomically replaced after phase and request events. The journal
is appended before the summary is refreshed. Errors, normal process exit and
SIGINT/SIGTERM finalize the record. SIGKILL, machine failure and power loss
cannot run cleanup: a later invocation recognizes the stale same-host process
lock, marks an unfinished invocation interrupted and rebuilds usage totals from
the journal. Truncated journal lines are retained and counted explicitly.

A transient .run.lock prevents concurrent invocations writing the same folder.
Separate output folders support concurrent experiments. A foreign-host lock is
not automatically cleared.

When local staging is enabled, logs remain live in the final output directory.
Existing artifacts seed the working directory, and synchronization excludes the
accounting files so an older staged copy cannot replace the current history.

## Tests

Run the API tracking regression suite without sending model requests:

~~~bash
bun run test:tracking
~~~
