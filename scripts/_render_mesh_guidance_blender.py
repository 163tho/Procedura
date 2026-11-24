"""On-demand untextured GLB reference view; invoked only by incremental drafting.

blender --background --python scripts/_render_mesh_guidance_blender.py -- \
  --mesh reference.glb --request camera.json --out view.png --metadata camera-result.json
Camera coordinates: Blender Z-up after glTF import; bbox centred, longest side 2.
"""
import argparse
import json
import math
import sys
from pathlib import Path

import bpy
from mathutils import Matrix, Vector

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _render_ao_blender import (  # noqa: E402
    compute_bbox, make_ao_emission_material, setup_render, setup_world_flat,
)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mesh", required=True)
    parser.add_argument("--request", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--metadata", required=True)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
    request = json.loads(Path(args.request).read_text())
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(Path(args.mesh).resolve()))
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    if not meshes or not any(len(obj.data.polygons) for obj in meshes):
        raise ValueError("GLB contains no renderable mesh faces")
    low, high = compute_bbox(meshes)
    center = (low + high) * 0.5
    span = max(high - low)
    if not math.isfinite(span) or span <= 1e-12:
        raise ValueError("GLB has degenerate bounds")
    transform = Matrix.Scale(2.0 / span, 4) @ Matrix.Translation(-center)
    # Bake each object's imported world transform before removing the hierarchy.
    # Mesh datablocks may be shared by instances, so make them independent.
    worlds = [(obj, obj.matrix_world.copy()) for obj in meshes]
    for obj, world in worlds:
        obj.data = obj.data.copy()
        obj.parent = None
        obj.matrix_world = Matrix.Identity(4)
        obj.data.transform(transform @ world)
        obj.data.materials.clear()
        obj.data.materials.append(make_ao_emission_material(0.4, 16, (0.55, 0.55, 0.55)))
    for obj in list(bpy.context.scene.objects):
        if obj not in meshes:
            bpy.data.objects.remove(obj, do_unlink=True)
    bpy.context.view_layer.update()
    setup_render(768, 32, False)
    setup_world_flat(0.92)
    position = Vector(request["camera_position"])
    target = Vector(request["target"])
    camera_data = bpy.data.cameras.new("GuidanceCamera")
    camera_data.type = "ORTHO" if request["projection"] == "orthographic" else "PERSP"
    camera_data.ortho_scale = request["ortho_scale"]
    camera_data.lens_unit = "FOV"
    camera_data.angle = math.radians(request["fov_degrees"])
    camera_data.clip_start = 0.001
    camera_data.clip_end = 100.0
    camera = bpy.data.objects.new("GuidanceCamera", camera_data)
    bpy.context.collection.objects.link(camera)
    camera.location = position
    camera.rotation_euler = (target - position).to_track_quat("-Z", "Y").to_euler()
    scene = bpy.context.scene
    scene.camera = camera
    scene.render.filepath = str(Path(args.out).resolve())
    bpy.ops.render.render(write_still=True)
    metadata = {
        "camera": request,
        "frame": "Blender Z-up after standard glTF Y-up import; no front-axis alignment",
        "normalization": "bbox center = origin; longest bbox side = 2; arbitrary units",
        "normalized_bbox_size": list((high - low) * (2.0 / span)),
        "source_bbox_size": list(high - low),
        "mesh_objects": len(meshes),
        "vertices": sum(len(obj.data.vertices) for obj in meshes),
        "polygons": sum(len(obj.data.polygons) for obj in meshes),
        "textures_used": False,
        "warning": "Approximate Hunyuan3D inference, not ground truth or physical dimensions",
    }
    Path(args.metadata).write_text(json.dumps(metadata, indent=2) + "\n")


if __name__ == "__main__":
    main()
