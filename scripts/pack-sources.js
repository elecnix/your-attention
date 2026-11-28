#!/usr/bin/env node
// Emit the JavaScript a published tarball needs.
//
// Node runs the TypeScript sources directly in a checkout, and the project keeps no build
// step there. A package installed from npm is different: Node refuses to strip types in
// anything under `node_modules`, so the published tarball carries the same code compiled
// once, at pack time, with Node's own stripper.
//
// `npm pack` and `npm publish` run this through `prepack`. It needs no dependency beyond the
// Node that already runs the project.
import * as fs from "node:fs";
import * as path from "node:path";
import { nodeBuild } from "../src/node/build.ts";
import { stripTypeScriptTypes } from "node:module";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const SRC = path.join(ROOT, "src");
const OUT = path.join(ROOT, "dist");

/** Every TypeScript file that becomes JavaScript. A `.d.ts` describes types only, and stays out. */
function sources(dir) {
	const out = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...sources(full));
		else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) out.push(full);
	}
	return out;
}

/** The sources import each other with their `.ts` extension, which a `.js` file cannot resolve. */
function toJavaScript(typescript) {
	const stripped = stripTypeScriptTypes(typescript);
	return stripped.replace(/(["'])(\.{1,2}\/[^"']*?)\.ts\1/g, "$1$2.js$1");
}

fs.rmSync(OUT, { recursive: true, force: true });
let files = 0;
for (const file of sources(SRC)) {
	const target = path.join(OUT, path.relative(ROOT, file)).replace(/\.ts$/, ".js");
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, toJavaScript(fs.readFileSync(file, "utf8")));
	files++;
}

// The page's own files stay where the server looks for them, two levels up from `src/node/`,
// which becomes `dist/node/` in a package. They are plain JavaScript already, and the server
// serves them as they are.
const WEB = path.join(ROOT, "web");
let copied = 0;
for (const entry of fs.readdirSync(WEB, { recursive: true, withFileTypes: true })) {
	if (!entry.isFile()) continue;
	if (entry.name.endsWith(".d.ts")) continue;
	const from = path.join(entry.parentPath, entry.name);
	const target = path.join(OUT, path.relative(ROOT, from));
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, fs.readFileSync(from));
	copied++;
}
// The build the package runs, which src/node/build.ts reads in place of a checkout's package.json and git. It reads
// them here the same way: the version package.json declares, and the commit of this checkout, never of a project the
// folder sits inside, or else the commit a release archive wrote into COMMIT. Without either, a workflow's GITHUB_SHA.
const built = nodeBuild(ROOT);
const version = built.version;
const commit = built.commit ?? process.env.GITHUB_SHA;
fs.writeFileSync(path.join(OUT, "build.json"), `${JSON.stringify({ version, ...(commit ? { commit } : {}) })}\n`);
console.log(`compiled ${files} source file(s) and copied ${copied} page file(s) into dist/, built from ${version}${commit ? ` at ${commit}` : ""}`);
