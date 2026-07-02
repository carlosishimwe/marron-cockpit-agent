import { accessSync } from "node:fs";

const required = [
  "index.html",
  "netlify.toml",
  "netlify/functions/agent.mjs",
];

for (const file of required) {
  accessSync(file);
}

console.log("build ok");
