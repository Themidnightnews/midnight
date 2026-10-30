// The deployed runtime cannot resolve Node built-ins through a runtime require()
// (the MongoDB driver is CommonJS). Rewrite require("node:x") into static imports.
const staticNodeBuiltins = {
  name: "static-node-builtins",
  enforce: "post" as const,
  renderChunk(code: string) {
    const re = /__require\(\s*["'](node:[a-z_/]+)["']\s*\)/g;
    if (!re.test(code)) return null;
    const names = new Map<string, string>();
    const out = code.replace(re, (_m, mod: string) => {
      let id = names.get(mod);
      if (!id) {
        id = `__nb_${mod.slice(5).replace(/\W/g, "_")}`;
        names.set(mod, id);
      }
      return `(${id}.default ?? ${id})`;
    });
    const header = [...names].map(([mod, id]) => `import * as ${id} from "${mod}";`).join("\n");
    return { code: `${header}\n${out}`, map: null };
  },
};

export default {
  rolldownConfig: { plugins: [staticNodeBuiltins] },
  rollupConfig: { plugins: [staticNodeBuiltins] },
};
