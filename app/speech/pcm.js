// SPDX-License-Identifier: GPL-3.0-or-later

/** Whatever the bridge hands over, as one ArrayBuffer of its own. */
function toArrayBuffer(data) {
  if (data instanceof ArrayBuffer) return data;
  if (ArrayBuffer.isView(data)) return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  if (Array.isArray(data)) return new Uint8Array(data).buffer;
  throw new TypeError('not the sound of a sentence');
}

/**
 * The sound of a sentence as `tts::pack` lays it out: `[u32 LE header length][header JSON][0-3 zero bytes][f32 LE samples]`.
 * @returns {{id: string, sampleRate: number, from: number, rate: number,
 *   words: {start: number, end: number, from: number, to: number}[], samples: Float32Array}}
 */
export function decodePcm(data) {
  const buffer = toArrayBuffer(data);
  const view = new DataView(buffer);
  const length = view.getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, length)));
  const start = Math.ceil((4 + length) / 4) * 4;
  const count = Math.floor((buffer.byteLength - start) / 4);
  const samples = new Float32Array(count);
  for (let i = 0; i < count; i += 1) samples[i] = view.getFloat32(start + i * 4, true);
  return { ...header, words: header.words ?? [], samples };
}
