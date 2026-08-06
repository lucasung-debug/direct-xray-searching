import { copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = resolve(projectRoot, "dist");

await rm(distRoot, { recursive: true, force: true });
await mkdir(resolve(distRoot, "server"), { recursive: true });
await mkdir(resolve(distRoot, ".openai"), { recursive: true });
await copyFile(resolve(projectRoot, "worker", "index.js"), resolve(distRoot, "server", "index.js"));
await copyFile(resolve(projectRoot, ".openai", "hosting.json"), resolve(distRoot, ".openai", "hosting.json"));

console.log("Built " + distRoot);
