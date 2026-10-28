import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Optional semantic search. The package is installed outside the repo (in
// RAVNIR_VAULT_EMBED_DIR) so the server has no hard dependency on it.

export async function loadEmbedder({ dir = process.env.RAVNIR_VAULT_EMBED_DIR, model = "Xenova/multilingual-e5-small" } = {}) {
  if (!dir) return { embedder: null, reason: "RAVNIR_VAULT_EMBED_DIR is not set" };
  let mod;
  try {
    const require = createRequire(path.join(dir, "package.json"));
    mod = await import(pathToFileURL(require.resolve("@huggingface/transformers")).href);
  } catch (error) {
    return { embedder: null, reason: `@huggingface/transformers not found in ${dir}: ${error.message}` };
  }
  try {
    const extractor = await mod.pipeline("feature-extraction", model, { dtype: "q8" });
    const options = { pooling: "mean", normalize: true };
    const run = async (texts) => {
      const out = await extractor(texts, options);
      const dim = out.dims[out.dims.length - 1];
      return texts.map((_, i) => Float32Array.from(out.data.subarray(i * dim, (i + 1) * dim)));
    };
    const [probe] = await run(["passage: probe"]);
    return {
      embedder: {
        dim: probe.length,
        async embed(texts, kind = "passage") {
          const prefix = kind === "query" ? "query: " : "passage: ";
          return run(texts.map((text) => prefix + text));
        },
      },
    };
  } catch (error) {
    return { embedder: null, reason: `embedding model failed to load: ${error.message}` };
  }
}
