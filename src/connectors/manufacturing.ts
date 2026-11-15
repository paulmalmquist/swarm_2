import { readFileSync, statSync } from 'node:fs';
import { assert } from '../lib/util.ts';
import { parseBatch } from '../manufacturing/schema.ts';
import type { SourceBatch } from '../manufacturing/schema.ts';

/** An operator-provided export, not a live MES/PLM/QMS connection. No source-system writes. */
export class LocalManufacturingExport {
  read(file: string): SourceBatch { return parseBatch(readManufacturingJson(file)); }
}
export function readManufacturingJson(file: string): unknown {
  assert(statSync(file).size <= 8 * 1024 * 1024, 'manufacturing_size', 'Input exceeds 8 MiB');
  const content = readFileSync(file, 'utf8');
  assert(Buffer.byteLength(content) <= 8 * 1024 * 1024, 'manufacturing_size', 'Input exceeds 8 MiB');
  return JSON.parse(content) as unknown;
}
