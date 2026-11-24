import { writeFileSync } from "node:fs";

// A GLB with one actual indexed triangle, sufficient for the real Blender smoke test.
export function triangleGlb(path: string) {
  const json = Buffer.from(JSON.stringify({ asset: { version: "2.0" },
    buffers: [{ byteLength: 44 }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 6 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [-1, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5123, count: 3, type: "SCALAR" }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }], nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }], scene: 0,
  }));
  const padded = Buffer.concat([json, Buffer.alloc((4 - json.length % 4) % 4, 32)]);
  const binary = Buffer.alloc(44);
  [-1, 0, 0, 1, 0, 0, 0, 1, 0].forEach((n, i) => binary.writeFloatLE(n, i * 4));
  [0, 1, 2].forEach((n, i) => binary.writeUInt16LE(n, 36 + i * 2));
  const result = Buffer.alloc(12 + 8 + padded.length + 8 + binary.length);
  result.write("glTF"); result.writeUInt32LE(2, 4); result.writeUInt32LE(result.length, 8);
  result.writeUInt32LE(padded.length, 12); result.writeUInt32LE(0x4e4f534a, 16); padded.copy(result, 20);
  result.writeUInt32LE(binary.length, 20 + padded.length); result.writeUInt32LE(0x004e4942, 24 + padded.length); binary.copy(result, 28 + padded.length);
  writeFileSync(path, result);
}
