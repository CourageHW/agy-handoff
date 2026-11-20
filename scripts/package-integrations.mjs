import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.resolve(process.argv[2] ?? path.join(root, "dist", "handoff-plugins"));
const { version } = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

for (const host of ["claude", "codex"]) {
  const name = `${host}-handoff`;
  const source = `./plugins/${name}`;
  const target = path.join(output, source);
  fs.cpSync(path.join(root, "integrations", host), target, { recursive: true });
  for (const component of ["src", "skills", "LICENSE"]) {
    fs.cpSync(path.join(root, component), path.join(target, component), { recursive: true });
  }

  const manifestPath = path.join(target, host === "claude" ? ".claude-plugin/plugin.json" : "plugin.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  writeJson(manifestPath, { ...manifest, version });

  const marketplace = { name: "agy-handoff" };
  if (host === "claude") {
    marketplace.owner = { name: "yonggi.hw" };
    marketplace.description = "Local multi-harness reviews, planning, and task delegation.";
    marketplace.plugins = [{ name: manifest.name, source, description: manifest.description }];
    writeJson(path.join(output, ".claude-plugin", "marketplace.json"), marketplace);
  } else {
    marketplace.interface = { displayName: "Handoff integrations" };
    marketplace.plugins = [{ name, source: { source: "local", path: source } }];
    writeJson(path.join(output, ".agents", "plugins", "marketplace.json"), marketplace);
  }
}

console.log(output);
