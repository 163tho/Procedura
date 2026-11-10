# Run tracking

The unified `runProcedura` pipeline records API usage, estimated costs, inputs,
timing and reproducibility metadata. Tracking is automatic for the API CLI,
batch and Studio callers of this pipeline.

Two files are written directly beside the model outputs:

| File | Contents |
| --- | --- |
| `run.json` | Invocation history, input summaries, API accounting and execution metadata |
| `api_calls.jsonl` | Append-only events for individual physical API requests |

The journal supports detailed analysis and recovery after interruption. It
records HTTP model requests made by the pipeline; externally performed work is
outside its accounting scope.

## Experiment labels and invocations

~~~bash
bun run scripts/procedura.ts -o outputs/baseline/rover/rep01 \
  --prompt-file ../experiment-data/prompts/rover.txt \
  --image ../experiment-data/images/rover.png \
  --experiment single_rgb --dataset-id rover --repetition 1
~~~

| Option | Meaning |
| --- | --- |
| `--experiment NAME` | Experimental condition or other grouping label |
| `--dataset-id ID` | Dataset item or object identifier |
| `--repetition N` | Positive integer identifying a repetition |

These labels are stored in each invocation's `experiment` object. They describe
the experiment; input-loading options determine which files are actually used.

Each pipeline launch creates one entry in `attempts`. A resume or `--redo` in
the same output folder retains `run_id` and adds a new `attempt_id` linked by
`previous_attempt_id`. Entries are ordered newest first, so `attempts[0]` is the
latest invocation. API retries belong to that invocation's request accounting.

Separate output folders keep independent experiments and repetitions distinct.
Earlier artifact hashes remain in the history even when a later invocation
replaces output files. `prior_untracked_work` flags existing artifacts whose
earlier costs and timing cannot be reconstructed.

## Record structure

The current `run.json` format has `schema_version: 3`. This versions the data
format independently of the source-code commit. The root also identifies the
run, output directory, latest invocation and journal through `run_id`,
`output_directory`, `latest_attempt_id` and `api_calls_file`.

Each entry in `attempts` contains:

| Field | Contents |
| --- | --- |
| `experiment`, `input_summary` | Labels, input mode, reference counts and guidance by stage |
| `status`, `started_at`, `ended_at`, `duration_ms` | Execution state, UTC timestamps and elapsed wall time |
| `api` | Request/token counts, estimated costs, coverage and accounting breakdowns |
| `source` | Git commit, branch, dirty status and source fingerprint |
| `inputs` | Prompt, reference-file metadata and content hashes |
| `configuration`, `pricing` | Requested/effective settings, environment overrides, endpoints and saved rates |
| `environment` | OS/runtime, CPU/RAM, tool versions and available GPU information |
| `phases`, `timings` | Executed/skipped phases, local timers and retry waits |
| `outcome`, `error` | Stage results, stopping reasons and failure information |
| `input_artifacts`, `output_artifacts` | Artifact paths, sizes and hashes |

`completed` indicates a successful return with satisfied stage checks.
`needs_review` indicates a stage problem or an exhausted refinement budget.
These statuses are not perceptual quality scores. External evaluations can be
associated with `run_id`, `attempt_id` and output hashes.

## API accounting

Each invocation has one `api` section. Frequently used fields are:

| Field | Meaning |
| --- | --- |
| `requests`, `completed_requests`, `failed_requests` | Physical HTTP request counts, including retries |
| `input_tokens`, `output_tokens` | Totals from requests with complete usage |
| `usage_complete` | Whether usage is complete for every recorded request |
| `usage_complete_requests`, `usage_incomplete_requests` | Exact usage coverage counts |
| `estimated_cost_usd`, `cost_complete` | Total estimated USD cost and pricing completeness |
| `priced_requests`, `unpriced_requests` | Exact pricing coverage counts |
| `known_estimated_cost_usd` | Known subtotal, present only when the total estimate is incomplete |
| `request_time_seconds_sum` | Sum of API request durations in seconds |
| `models`, `pricing_assumptions` | Observed/requested model IDs and distinct pricing assumptions |
| `by_phase`, `by_stage` | Major-phase and detailed-stage views of the same requests |

`by_phase` groups recorded phases such as `draft` and `refine`. `by_stage`
preserves every stage label, including `draft.plan`, `draft.plan_review`,
`draft.part.<part_name>`, `llm.critic` and `llm.patch`. The number of groups
depends on the run. Multiple requests for one part remain grouped under its
stage label.

The following accounting excerpt illustrates the relationship between the
overall total and the breakdowns; other fields are omitted:

~~~json
{
  "requests": 2,
  "input_tokens": 3000,
  "output_tokens": 600,
  "estimated_cost_usd": 0.012,
  "cost_complete": true,
  "by_phase": {
    "draft": { "requests": 2, "estimated_cost_usd": 0.012 }
  },
  "by_stage": {
    "draft.plan": { "requests": 1, "estimated_cost_usd": 0.004 },
    "draft.part.wheel": { "requests": 1, "estimated_cost_usd": 0.008 }
  }
}
~~~

Either breakdown partitions the invocation total. Adding overall, phase and
stage costs together would count the same requests repeatedly. A skipped phase
has an execution record in `phases` and no API group if it made no requests.

Usage is normalized for Anthropic Messages, OpenAI-compatible Chat Completions
and Gemini. Input totals include cached input. `reported_reasoning_tokens` and
`reported_cache_read_tokens` are subsets of output/input respectively and are
not added again. Zero in these reported aggregates can also indicate that the
provider supplied no breakdown. Partial raw usage remains in the journal.

If any request is unpriced, `estimated_cost_usd` is `null`, `cost_complete` is
`false` and `known_estimated_cost_usd` contains the priced subtotal. Missing
usage or pricing is not treated as a free request. Each phase/stage group has
its own completeness flags.

`api.models` uses returned model IDs, falling back to requested IDs when a
response supplies none. Per-model accounting can be calculated from the journal.
Aggregate cost formatting suppresses binary floating-point noise to 15
significant digits; raw request estimates remain in the journal.

## Inputs and paths

`input_summary` identifies `single_image`, `multi_view_images` or `text_only`,
reference counts and the guidance used by each stage. Counts reflect the
reference sets loaded for the stage, excluding failed extra-view generation and
current-build feedback renders. Repeated requests do not increase input counts.
Mesh-rendered images remain image guidance rather than direct mesh input.

`used_by_stage` and `reference_counts_by_stage` describe stage-specific guidance.
`not_run` and `skipped` identify stages without observed requests.
`resolution` distinguishes observed references from pending or declared/reused
inputs before loading.

The current pipeline tracks single-image/text-only input and generated extra
views. It does not infer depth or segmentation semantics from filenames;
experiment labels alone do not establish those input types. Representation and
viewpoint metadata require an input loader that explicitly declares them.

`input_paths_relative_to: "procedura_repository_root"` establishes the base for
source paths. For example, a sibling data repository can be represented as:

~~~json
{
  "source_path": "../experiment-data/images/rover.png",
  "run_copy": "image.png",
  "origin": "supplied"
}
~~~

`run_copy` and artifact `path` fields are relative to the output folder containing
`run.json`. Generated images have `source_path: null`. Input records also retain
file sizes and SHA-256 hashes; original source paths are preserved on reuse.
Portable paths depend on retaining the same relative directory layout.

The source fingerprint detects code changes; a recorded clean commit identifies
a reproducible source revision.

## Pricing configuration

Costs are estimates, not invoices or remaining credit balances. The saved
`pricing` object records the rate source, date, basis and model rates.
Bundled rates and endpoint restrictions are defined in
[pricing.ts](../src/tracking/pricing.ts).

`--pricing-file PATH` or `PROCEDURA_PRICING_FILE` supplies custom rates. Every
model requires all five nonnegative rates in USD per million tokens:

~~~json
{
  "currency": "USD",
  "basis": "configured_rate_estimate",
  "source": "Configured rate sheet",
  "as_of": "2026-11-01",
  "models": {
    "example-model": {
      "input": 1.0,
      "output": 5.0,
      "cache_read": 0.1,
      "cache_write_5m": 1.25,
      "cache_write_1h": 2.0
    }
  }
}
~~~

These example rates illustrate the file format. The configuration is saved with
the invocation so later rate changes cannot alter its recorded estimate.

Unavailable model/endpoint rates, unsupported pricing modifiers, incomplete
usage and additional server-tool charges produce an unknown estimate.
OpenAI-compatible responses without cache breakdowns use the base input rate
and record that assumption.

## Timing and persistence

`duration_ms` measures invocation wall time, including pipeline execution and
recording overhead. CLI staging copy/synchronization is outside that duration.
API durations include network, provider queueing and response streaming rather
than measuring GPU inference alone. Local timers and concurrent/nested requests
can overlap and must not be summed into wall time.

`run.json` is atomically replaced after request and phase events. The journal
is appended first. Started and finished events share `call_id`; they are merged
as one request when accounting is rebuilt. Credentials, headers and model
text/image payloads are not copied into the journal; request hashes and selected
parameters are retained.

Normal completion, errors, process exit and SIGINT/SIGTERM finalize the record.
A subsequent invocation recovers after an unclean exit, marks unfinished work
interrupted and counts malformed journal lines explicitly. A transient
`.run.lock` prevents concurrent invocations from writing the same output folder;
a foreign-host lock is not automatically cleared.

If a journal is missing or truncated, saved accounting is retained with
`ledger_complete: false` and `ledger_requests`. Unavailable accounting values
remain `null` rather than being replaced with zero.

With local staging, tracking files stay live in the final output directory.
Artifact synchronization excludes those files to preserve current accounting.

## Inspecting records

Latest invocation and detailed accounting:

~~~bash
jq '.attempts[0] | {input_summary, status, duration_ms, api, outcome}' run.json
jq '.attempts[0].api.by_stage' run.json
~~~

Combined estimated cost across invocations, returning null if any is incomplete:

~~~bash
jq 'if all(.attempts[]; .api.cost_complete == true) then [.attempts[].api.estimated_cost_usd] | add else null end' run.json
~~~

## Development checks

~~~bash
bun run test:tracking
bun run typecheck
~~~

The tracking suite uses mocked model requests and covers accounting,
input provenance, incomplete journals, retries, staging,
concurrency and interruption recovery.
