# Use auxiliary mesh views during incremental part generation

Run these commands from the Procedura checkout. Supply the original reference
PNG separately from the auxiliary PNG renders of a generated mesh. Replace the
brief and original-image paths below with your files.

The original image and text define the target. The auxiliary images are renders
of a Hunyuan mesh generated from that original image. Each part-generation
request identifies this provenance and instructs the model to use the mesh views
only for uncertain or occluded regions. Visible areas always follow the original
reference image, even if the mesh views disagree.

Auxiliary views are attached only to incremental per-part generation and its
retries. Part planning, plan review, and next-part selection in no-plan mode
use the original reference image without auxiliary guidance. Refinement, paint,
and motion keep their existing reference inputs; auxiliary images are not added
to those stages. Current-build feedback remains separate from the target views.

## API CLI

Load every view in a directory:

```bash
bun run scripts/procedura.ts \
  -o outputs/buggy_multiview_12 \
  --prompt-file /path/to/brief.txt \
  --image /path/to/original_reference.png \
  --aux-views-dir ../additional_renders_test/renders/02_assault_buggy \
  --3d-feedback
```

Select particular perspectives by repeating `--aux-image`. Their order is
preserved:

```bash
bun run scripts/procedura.ts \
  -o outputs/buggy_multiview_selected \
  --prompt-file /path/to/brief.txt \
  --image /path/to/original_reference.png \
  --aux-image ../additional_renders_test/renders/02_assault_buggy/03_front.png \
  --aux-image ../additional_renders_test/renders/02_assault_buggy/05_left.png \
  --aux-image ../additional_renders_test/renders/02_assault_buggy/07_top_oblique_000.png \
  --3d-feedback
```

`--3d-feedback` is optional: it adds views of the growing procedural model.
The auxiliary references are attached to per-part generation whether or not that
flag is enabled.
These API CLI commands use your configured model endpoint.

## Selection and reproducibility

- Choose either `--aux-views-dir` or repeated `--aux-image`.
- An explicit primary image (`--image`) is required. Auxiliary inputs are incompatible with text-only, one-shot, and
  motion-only drafting.
- Auxiliary files must be PNGs. With `cameras.json`, directory loading follows
  its `views` order and retains view names, source axes, and camera metadata.
  Without it, PNG filenames are sorted naturally. Contact sheets and cached
  `.rNNN.png` resize derivatives are excluded from automatic directory loading.
- Selected individual files also acquire camera metadata from a sibling
  `cameras.json` when their filenames are listed there.
- Draft requests retain the existing 16-image budget. At most 15 auxiliary
  references fit beside the primary image; 12 auxiliaries leave three slots for
  current-build feedback. The first configured feedback views are attached.
  Excess references are rejected rather than silently dropped.
- Drafting saves exact image copies under `_aux_refs/` and records their order,
  labels, metadata, and hashes in `auxiliary_references.json`. API draft resume
  reuses that snapshot when auxiliary flags are omitted. Keep supplying the
  primary `--image` when resuming; changing the auxiliary set requires a new
  output directory or `--redo`. Use separate output directories
  for comparisons between camera layouts.

Source axes in your renders can differ from Procedura's construction frame.
For example, the supplied renderer uses Y-up and +X-front by default, while
Procedura constructs with Z-up and -Y-front. Camera captions retain the source
frame so the agent can interpret the views without assuming identical axes.
