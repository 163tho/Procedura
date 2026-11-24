# On-demand GLB guidance during incremental reconstruction

Implemented on `experiment/direct-mesh` in `Procedura-mesh`.

The original reference image and brief define the reconstruction target. An
optional untextured Hunyuan3D GLB supplies approximate views when the incremental
generator is uncertain about proportions, depth, dimensions, placement, or
occluded regions. The GLB is an inference from the original image; its geometry
is never treated as ground truth, a fitting objective, or a physical scale.

## Running it

Run from the `Procedura-mesh` checkout with your existing model endpoint:

```bash
bun run scripts/procedura.ts \
  -o outputs/assault_buggy_glb_guidance \
  --prompt-file /path/to/brief.txt \
  --image /path/to/original_reference.png \
  --guidance-mesh /path/to/hunyuan_reconstruction.glb \
  --3d-feedback \
  --experiment glb_on_demand \
  --dataset-id assault_buggy \
  --repetition 1
```

`--3d-feedback` is optional and continues to mean views of the procedural build
so far. It is independent of GLB guidance. Refinement still runs normally unless
you explicitly pass `--no-refine`.

The TypeScript API accepts `guidanceMesh` on `RunProceduraOpts` and
`IncrementalDraftOpts`. Supply `incremental: true`, `inputImage`, the brief and
the output directory. The commented [JSONC example](mesh-guidance.example.jsonc)
shows those options and the new tracking fields. It is documentation, not a
new configuration-file format accepted by the CLI.

A GLB must be a self-contained glTF 2 binary with mesh primitives. External
buffer/image files are rejected so the frozen GLB copy is sufficient to
reproduce a view. Imported materials/textures are replaced by a uniform grey
ambient-occlusion material; no texture evidence is used.

## When guidance is available

| Stage | GLB tool or GLB-derived views |
| --- | --- |
| Initial part plan | Excluded |
| Plan review | Excluded |
| Next-part selection with `--no-plan` | Excluded |
| Incremental part generation | Tool available on every call; optional use |
| Part retries, including compile/connectivity failures | Tool available again |
| Whole-model refinement, paint, motion | Excluded |

The normal empty procedural scaffold remains the starting point. No GLB import,
conversion, or approximate mesh is inserted into the generated SCAD. Existing
compile and geometry gates continue to validate the generated procedural mesh.
Downstream stages naturally see the procedural reconstruction produced by
drafting; they do not receive the reference GLB or its rendering tool.

Without `--guidance-mesh`, generation keeps the existing one-shot-per-part LLM
path. Guidance requires an image-based incremental reconstruction and is
rejected for text-only, one-shot and motion-only invocations.

## How the LLM requests a view

The per-part generator now has one narrow native tool, `render_mesh_guidance`.
It chooses the camera position, target, projection and zoom, rather than
receiving a fixed multiview set. For example:

```json
{
  "camera_position": [3, -4, 3],
  "target": [0, 0, 0],
  "projection": "perspective",
  "fov_degrees": 45,
  "reason": "The rear body depth is ambiguous in the original image."
}
```

For a close-up, the generator can aim `target` at a region, move the camera
closer, or use `projection: "orthographic"` with a smaller `ortho_scale`.
Default target is `[0,0,0]`, FOV is 45 degrees and orthographic scale is 2.5.
Camera coordinates are bounded to ±10; targets to ±1; orthographic scale to
0.05–8; FOV to 15–100 degrees. Position and target must differ.

The tool executes `scripts/_render_mesh_guidance_blender.py` through Blender
with structured arguments. It returns a 768×768 PNG, camera metadata, approximate
bounding-box ratios, and a reminder that the original image takes precedence.
The LLM then continues generating the same part. It has no general shell or
permission to edit the GLB through this tool.

Blender performs standard glTF Y-up to Z-up conversion. The renderer centers
the imported bounding box and scales its longest side to 2. Camera coordinates
therefore describe a temporary normalized reference frame, with bounds within
`[-1,1]`. Front-axis alignment to the original image is **not assumed**.
These coordinates are not the procedural model's millimeters. The model must
interpret orientation against the primary image and use proportions cautiously.

The original image remains attached throughout a part conversation. One image
slot is reserved for the tool; current-build feedback uses the remaining slots.
The conversation keeps at most 16 images in total by dropping the oldest tool
image attachments when necessary, while retaining their camera/result text.
The tool remains available on subsequent turns. Views are requested again on a
retry if needed; GLB images are not automatically carried between parts.

Each generation attempt permits up to 8 tool calls to bound runaway inspection;
exceeding that budget fails the attempt rather than silently removing access.
Each Blender render has a 180-second timeout and supports cancellation.
Invalid cameras or render failures return an explicit tool error so the model
can correct the request or proceed from the original image and brief.

The uncertainty-only rule is communicated in the part system/user prompts and
requires a stated `reason` for each request. There is no numeric confidence
detector: the program cannot prove that a model was genuinely uncertain or
guarantee perceptual quality. Stage exclusion and the empty initialization are
enforced in code.

## Reproducibility and resume

The first draft saves byte-for-byte GLB input to
`_mesh_guidance/reference.glb` and writes `mesh_guidance.json` with its source
path, SHA-256, size, provenance, permitted stages and `initialization: false`.

A partial-draft resume reuses and verifies that copy, including when
`--guidance-mesh` is omitted. You can keep supplying `--image`; an existing
`image.png` is also reused for a partial resume. Changing or adding guidance to
an existing draft is rejected. Use a fresh output directory or `--redo` with the
primary image and desired GLB. `--redo` without a GLB disables previous guidance.
Resupplying a GLB during completed-draft reuse verifies the saved copy and
rejects changes. Without a GLB option, refinement-only reuse does not load or
require the guidance mesh. Existing `run.json` invocation history is preserved.

Each requested view has its own UUID directory under `_mesh_guidance/views/`.
Successful renders contain `request.json`, `camera.json`, `view.png`,
`blender.log` and `result.json`. Invalid requests still save `result.json` with
the failure. These are evidence of guidance inspection, not deliverable meshes.

## Tracking changes

The existing `run.json` / `api_calls.jsonl` invocation structure is retained.
The example inspected for this work was
`procedura-trellis-thesis/experiments/inputs/mv/outputs/assault_buggy/run.json`.

Each invocation now records:

- `configuration.requested.guidanceMesh` and effective guidance policy/settings.
- `inputs.primary_image`, `auxiliary_images`, and `reference_meshes`, with
  source paths relative to the checkout, run-relative copies, hashes, sizes and
  provenance. Existing schema-1 `inputs.image` is retained for compatibility.
- `input_summary.used_by_stage` and reference counts, separating planning,
  review, next-part selection, part generation and refinement. Stage counts
  reflect the maximum observed reference set in that stage during this invocation.
- `mesh_guidance.available_by_stage`, showing how many part-generation attempts
  had the tool available, even if it was never called.
- `mesh_guidance.requests`, including request/tool IDs, part name, generation
  attempt, requested/validated camera, uncertainty reason, mesh hash, timestamps,
  render duration, status, errors, image hash/size and run-relative image path.
- `mesh_guidance.image_deliveries`, identifying the view tool-call IDs attached
  to each LLM continuation. This records request construction, not proof of the
  model's internal attention. `reference_mesh_used` means a view was attached;
  it remains false if the tool was merely available or every render failed.
- `mesh_guidance.render` local-processing timing, plus manifest and input-copy
  hashes in output artifacts. Render-request and attachment events also appear
  in the trajectory.

Each LLM continuation still passes through the existing request/usage ledger,
under the part's stage label. Local Blender calls do not count as model API
calls. Frozen copies and render results are included when local staging syncs
the output directory. View files use run-relative paths so staging paths do
not become the only way to locate them.

This feature is exposed through the API CLI and TypeScript pipeline. The Studio
has no new upload control. The separately frozen MCP session workflow currently
rejects native pipeline tool-use requests and has no GLB input option; use the
API CLI for this experiment.

## Implementation and validation

The changes are concentrated in:

- `src/pipeline/mesh-guidance.ts`: GLB validation/snapshots, camera validation,
  tool definition, rendering and request evidence.
- `scripts/_render_mesh_guidance_blender.py`: arbitrary-position untextured
  rendering with normalized camera coordinates.
- `src/llm/generate.ts`: a bounded native tool/result/image conversation loop.
- The native Gemini adapter and canonical tool-call types preserve returned
  function-call thought signatures on continuation, following
  [Google's function-calling guidance](https://ai.google.dev/gemini-api/docs/generate-content/function-calling).
- `src/pipeline/draft-incremental.ts`: tool access only at part-generation call
  sites, including retries; planning retains its ordinary generation path.
- CLI/unified pipeline options and tracking modules: validation, forwarding,
  source/input artifacts, per-stage reference tracking and inspection records.

Validation uses no paid model requests:

```bash
bun run typecheck
bun test tests/mesh-guidance.test.ts tests/run-tracking.test.ts
# Optional real Blender smoke test; leaves temporary images for visual review:
bun run tests/fixtures/mesh-guidance-render-smoke.ts
```

The tests cover GLB snapshots and tamper detection; input/camera validation;
successful/failed tools; image limits and adapter image serialization; tracking;
and an isolated offline incremental run proving that planning, review and
next-part selection lack guidance while generation and compile-fix retries keep
it. The real Blender smoke test renders both projections and was visually
checked. A paid Hunyuan reconstruction experiment was not run.
