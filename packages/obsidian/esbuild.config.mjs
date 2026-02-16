import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";
import { copyFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { createRequire } from "module";

const prod = process.argv[2] === "production";

function copyWasmPlugin() {
  return {
    name: "copy-wasm",
    setup(build) {
      build.onEnd(() => {
        // Resolve through Node module resolution to handle hoisted deps
        const require = createRequire(import.meta.url);
        const sqlJsPath = dirname(require.resolve("sql.js-fts5/package.json"));
        const wasmSrc = join(sqlJsPath, "dist", "sql-wasm.wasm");
        const outfile = build.initialOptions.outfile;
        const wasmDest = join(dirname(outfile), "sql-wasm.wasm");
        if (existsSync(wasmSrc)) {
          mkdirSync(dirname(wasmDest), { recursive: true });
          copyFileSync(wasmSrc, wasmDest);
          console.log(`Copied sql-wasm.wasm → ${wasmDest}`);
        } else {
          console.warn(`sql-wasm.wasm not found at ${wasmSrc}`);
        }
      });
    },
  };
}

const context = await esbuild.context({
  banner: { js: "/* Engram Obsidian Plugin — bundled by esbuild */" },
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...builtins,
    // @engram/core is NOT externalized — it gets bundled in
  ],
  format: "cjs",
  target: "es2022",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  plugins: [copyWasmPlugin()],
  define: {
    "process.env.NODE_ENV": prod ? '"production"' : '"development"',
  },
});

if (prod) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}
