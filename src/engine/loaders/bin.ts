// The site's custom binary geometry format (.bin):
//
//   bytes [0..9]   : JSON header length, ASCII decimal
//   bytes [10..10+n] : JSON header, e.g. {"type":0,"attributes":[["position",7],...],"userData":{...}}
//   bytes [10+n..] : Draco-compressed geometry payload
//
// Type ids in the header map to TypedArray constructors (7 = Float32Array,
// 4 = Uint16Array, ...). Type 0 files are meshes, type 1 files are data
// geometries (bones, animation frames, instance patches, curves).

import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import type { BufferGeometry } from 'three';

/** TypedArray constructor names, the DRACOLoader worker resolves them via
 *  `self[name]`, and only strings survive postMessage. */
export const TYPED_ARRAYS = [
  'Int8Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'Int16Array',
  'Uint16Array',
  'Int32Array',
  'Uint32Array',
  'Float32Array',
  'Float64Array',
] as const;

export interface BinHeader {
  type: number;
  attributes: Array<[string, number]>;
  userData?: Record<string, unknown>;
}

export interface BinData {
  header: BinHeader;
  /** Draco-compressed payload bytes. */
  payload: ArrayBuffer;
}

const textDecoder = new TextDecoder();

export function parseBin(buffer: ArrayBuffer): BinData {
  const bytes = new Uint8Array(buffer);
  const headerLen = parseInt(textDecoder.decode(bytes.slice(0, 10)), 10);
  const header = JSON.parse(textDecoder.decode(bytes.slice(10, 10 + headerLen))) as BinHeader;
  const payload = bytes.slice(10 + headerLen).buffer as ArrayBuffer;
  return { header, payload };
}

export interface DecodeOptions {
  /** Attribute name → its array index in the header (useUniqueIDs semantics). */
  attributeIDs: Record<string, number>;
  attributeTypes: Record<string, TypedArrayName>;
}

export type TypedArrayName = (typeof TYPED_ARRAYS)[number];

export const decoder = new DRACOLoader().setDecoderPath('/assets/libs/draco/').preload();

export function decodeGeometry(buffer: ArrayBuffer, options: DecodeOptions): Promise<BufferGeometry> {
  const { attributeIDs, attributeTypes } = options;
  return (decoder as any).decodeGeometry(buffer, { attributeIDs, attributeTypes, useUniqueIDs: true });
}
