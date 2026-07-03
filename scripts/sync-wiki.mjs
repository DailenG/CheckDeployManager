// Mirrors the GitNexus-generated code wiki (.gitnexus/wiki, git-ignored) into
// the tracked docs/wiki/ folder so it is visible on GitHub.
//
// Refresh sequence after code changes:
//   node .gitnexus/run.cjs analyze   (rebuild the knowledge graph)
//   node .gitnexus/run.cjs wiki      (regenerate .gitnexus/wiki)
//   npm run docs:wiki                (this script: mirror into docs/wiki)
//
// Only the overview and the top-level module pages are mirrored; the
// "Other" catch-all pages (per-config-file stubs) are skipped. Transforms
// applied per page: drop the duplicated leading H1, unwrap links to skipped
// pages, replace em dashes per CONTRIBUTING rule 3, and stamp provenance.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = path.join(repoRoot, ".gitnexus", "wiki");
const targetDir = path.join(repoRoot, "docs", "wiki");
const metaPath = path.join(sourceDir, "meta.json");

if (!fs.existsSync(metaPath)) {
  console.error(
    "No generated wiki found at .gitnexus/wiki. Run: node .gitnexus/run.cjs wiki",
  );
  process.exit(1);
}

const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
const sourceCommit = (meta.fromCommit ?? "unknown").slice(0, 7);

// Top-level modules from the graph, minus the "Other" catch-all subtree.
const moduleSlugs = (meta.moduleTree ?? [])
  .filter((entry) => entry.slug !== "other")
  .map((entry) => entry.slug);

const moduleNames = new Map(
  (meta.moduleTree ?? [])
    .filter((entry) => entry.slug !== "other")
    .map((entry) => [entry.slug, entry.name]),
);

const includedTargets = new Set([
  "README.md",
  ...moduleSlugs.map((slug) => `${slug}.md`),
]);

const banner = [
  "<!-- GENERATED FILE, do not edit by hand.",
  `     Mirrored from .gitnexus/wiki (GitNexus knowledge graph wiki), source commit ${sourceCommit}.`,
  "     Regenerate: node .gitnexus/run.cjs wiki, then: npm run docs:wiki -->",
  "",
].join("\n");

function transform(markdown, { isIndex }) {
  let lines = markdown.replace(/\r\n/g, "\n").split("\n");

  // The generator emits a title H1 followed by the page's own H1; keep the
  // page's own (often more specific) heading.
  const firstText = lines.findIndex((line) => line.trim() !== "");
  if (firstText !== -1 && lines[firstText].startsWith("# ")) {
    const nextText = lines.findIndex(
      (line, i) => i > firstText && line.trim() !== "",
    );
    if (nextText !== -1 && lines[nextText].startsWith("# ")) {
      lines = lines.filter((_, i) => i !== firstText);
    }
  }

  let text = lines.join("\n");

  // On the index, drop paragraphs whose only purpose is to point at skipped
  // pages (e.g. the "grouped under Other" closer).
  if (isIndex) {
    text = text
      .split("\n\n")
      .filter((paragraph) => {
        const links = [...paragraph.matchAll(/\]\(([a-z0-9-]+\.md)/g)];
        return (
          links.length === 0 ||
          links.some((m) => includedTargets.has(m[1]) || m[1] === "overview.md")
        );
      })
      .join("\n\n");
  }

  // Point links at the mirrored filenames and unwrap links to skipped pages.
  text = text.replace(/\]\(overview\.md(#[^)]*)?\)/g, "](README.md$1)");
  text = text.replace(
    /\[([^\]]+)\]\(([a-z0-9-]+\.md)(#[^)]*)?\)/g,
    (match, label, target) => (includedTargets.has(target) ? match : label),
  );

  // CONTRIBUTING rule 3: no em dashes (U+2014) anywhere in the repo. The
  // character is spelled via charCode so this file stays em dash free itself.
  text = text.split(String.fromCharCode(0x2014)).join("-");

  const provenance = isIndex
    ? [
        "",
        `> Generated from the GitNexus code knowledge graph at commit \`${sourceCommit}\`.`,
        "> Do not edit these pages by hand. To refresh after code changes, run",
        "> `node .gitnexus/run.cjs analyze`, `node .gitnexus/run.cjs wiki`, then `npm run docs:wiki`.",
        "",
      ].join("\n")
    : "";

  // Insert the visible provenance note right after the H1 on the index page.
  if (provenance) {
    const headingEnd = text.indexOf("\n", text.indexOf("# "));
    text =
      text.slice(0, headingEnd) + "\n" + provenance + text.slice(headingEnd);
  }

  // Script-owned navigation footer on the index page.
  if (isIndex) {
    const toc = moduleSlugs
      .map((slug) => `- [${moduleNames.get(slug)}](${slug}.md)`)
      .join("\n");
    text =
      text.trimEnd() +
      [
        "",
        "",
        "## Module pages",
        "",
        toc,
        "",
        "## Hand-written documentation",
        "",
        "- [Architecture, data model, and threat model](../architecture.md)",
        "- [Post-deploy and operations runbook](../runbook.md)",
        "- [Contributing guide](../../CONTRIBUTING.md)",
        "",
      ].join("\n");
  }

  return banner + text.trimEnd() + "\n";
}

fs.mkdirSync(targetDir, { recursive: true });
for (const stale of fs.readdirSync(targetDir)) {
  if (stale.endsWith(".md")) fs.unlinkSync(path.join(targetDir, stale));
}

const pages = [
  { source: "overview.md", target: "README.md", isIndex: true },
  ...moduleSlugs.map((slug) => ({
    source: `${slug}.md`,
    target: `${slug}.md`,
    isIndex: false,
  })),
];

for (const page of pages) {
  const sourcePath = path.join(sourceDir, page.source);
  if (!fs.existsSync(sourcePath)) {
    console.warn(`skipped ${page.source} (not found in .gitnexus/wiki)`);
    continue;
  }
  const markdown = fs.readFileSync(sourcePath, "utf8");
  fs.writeFileSync(
    path.join(targetDir, page.target),
    transform(markdown, { isIndex: page.isIndex }),
  );
  console.log(`wrote docs/wiki/${page.target}`);
}

// Fail loudly if a mirrored page still links to a file we did not mirror.
let brokenLinks = 0;
for (const file of fs.readdirSync(targetDir)) {
  if (!file.endsWith(".md")) continue;
  const text = fs.readFileSync(path.join(targetDir, file), "utf8");
  for (const match of text.matchAll(/\]\(([a-z0-9-]+\.md)(#[^)]*)?\)/gi)) {
    if (!fs.existsSync(path.join(targetDir, match[1]))) {
      console.error(`broken link in ${file}: ${match[0]}`);
      brokenLinks++;
    }
  }
}
if (brokenLinks > 0) process.exit(1);
console.log(`mirrored ${pages.length} pages from source commit ${sourceCommit}`);
