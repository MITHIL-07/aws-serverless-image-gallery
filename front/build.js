// Vercel build script
// Copies the static files into dist/ and generates dist/config.js
// from the API_URL environment variable (set in the Vercel project settings).
// This keeps your real API URL out of the Git repository.

const fs = require("fs");
const path = require("path");

const apiUrl = (process.env.API_URL || "").trim().replace(/\/+$/, "");

if (!apiUrl) {
  console.error("ERROR: API_URL environment variable is not set.");
  console.error("Add it in Vercel: Project Settings > Environment Variables.");
  process.exit(1);
}
if (!/^https:\/\//.test(apiUrl)) {
  console.error("ERROR: API_URL must start with https://");
  process.exit(1);
}

const outDir = path.join(__dirname, "dist");
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

for (const file of ["index.html", "style.css", "script.js"]) {
  fs.copyFileSync(path.join(__dirname, file), path.join(outDir, file));
}

const config = "window.GALLERY_CONFIG = " + JSON.stringify({ API_URL: apiUrl }) + ";\n";
fs.writeFileSync(path.join(outDir, "config.js"), config);

console.log("Build complete. Output written to dist/ with API_URL configured.");
