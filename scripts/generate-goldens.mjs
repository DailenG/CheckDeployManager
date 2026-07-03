// Regenerates the golden artifact files from the Harborview sample input.
// Run after intentional generator changes: node scripts/generate-goldens.mjs
// Review the diff carefully; goldens are the contract with design section 5.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildArtifactBundle } from "../src/lib/artifacts.ts";
import { HARBORVIEW_ARTIFACT_INPUT } from "../test/harborview-sample.ts";

const goldenDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "test",
  "golden",
);
fs.mkdirSync(goldenDir, { recursive: true });

const bundle = buildArtifactBundle(HARBORVIEW_ARTIFACT_INPUT);

function writeGolden(name, content) {
  fs.writeFileSync(path.join(goldenDir, name), content);
  console.log(`wrote ${name}`);
}

writeGolden(
  "managed-storage.json",
  JSON.stringify(bundle.chrome_managed_storage, null, 2) + "\n",
);
writeGolden(
  "firefox-fragment.json",
  JSON.stringify(bundle.firefox_fragment, null, 2) + "\n",
);
writeGolden(
  "firefox-policies-full.json",
  JSON.stringify(bundle.firefox_policies_full, null, 2) + "\n",
);
writeGolden("chrome.reg", bundle.reg_chrome);
writeGolden("edge.reg", bundle.reg_edge);
writeGolden("gpo-script.ps1", bundle.gpo_script);
writeGolden("intune-variables.ps1", bundle.intune_variables);
writeGolden("cipp-fields.json", JSON.stringify(bundle.cipp_fields, null, 2) + "\n");
