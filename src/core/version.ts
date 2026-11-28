// The build an inbox runs, as GET /v1/info and the usage reports name it. The core imports nothing outside itself, so
// each platform reads its build where it can and hands it in: the Node build from its package and its checkout
// (src/node/build.ts), the Worker from the package it bundled and the commit its deploy set (src/cloudflare/build.ts).

export interface Build {
  /** The release the package declares, such as 0.1.1. */
  version: string;
  /** The commit the code came from, when the platform knows it. */
  commit?: string;
}

/** What an inbox reports when its platform handed it no build, such as in a test. No release has this version, and
 * the usage collector refuses a report that carries it. */
export const UNKNOWN_BUILD: Build = { version: 'unknown' };
