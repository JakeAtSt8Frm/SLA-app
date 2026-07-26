import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EXTERNAL_SOURCES,
  type ExternalSourceName,
  type ProjectionSnapshot,
} from '../src/lib/projections';

/** Where a source's snapshot lives, from the same registry the app reads. */
export function snapshotPath(source: ExternalSourceName): string {
  return resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../public/data',
    EXTERNAL_SOURCES[source].file,
  );
}

/** The season a refresh run should be importing. */
export function targetSeason(): string {
  return String(new Date().getUTCFullYear());
}

export async function writeSnapshot(snapshot: ProjectionSnapshot): Promise<void> {
  const path = snapshotPath(snapshot.source);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(snapshot)}\n`, 'utf8');
  console.log(
    `Wrote ${snapshot.projections.length} ${snapshot.source} projections for ${snapshot.season} (${snapshot.updatedAt})`,
  );
}

/** Fetches a page as text, with a caller-identifying agent and a hard timeout. */
export async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      'User-Agent':
        'SLA-app projection importer (+https://github.com/JakeAtSt8Frm/SLA-app)',
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`Request failed (${response.status}) for ${url}`);
  }
  return response.text();
}
