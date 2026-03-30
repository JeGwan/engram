import type { IEmbedder } from '@engram/core';

let llamaModule: typeof import('node-llama-cpp') | null = null;

async function getLlamaModule() {
  if (!llamaModule) {
    llamaModule = await import('node-llama-cpp');
  }
  return llamaModule;
}

/**
 * node-llama-cpp based embedder — runs GGUF models in-process.
 * No external daemon required.
 */
export class LlamaEmbedder implements IEmbedder {
  private modelPath: string;
  private context: any = null; // LlamaEmbeddingContext
  private initPromise: Promise<void> | null = null;

  constructor(modelPath: string) {
    this.modelPath = modelPath;
  }

  private async init(): Promise<void> {
    if (this.context) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      const { getLlama } = await getLlamaModule();
      const llama = await getLlama();
      console.error(`[engram] Loading embedding model: ${this.modelPath}`);
      const model = await llama.loadModel({ modelPath: this.modelPath });
      this.context = await model.createEmbeddingContext();
      console.error(`[engram] Embedding model loaded`);
    })();

    return this.initPromise;
  }

  async embed(text: string): Promise<number[]> {
    await this.init();
    const embedding = await this.context.getEmbeddingFor(text);
    return Array.from(embedding.vector as Float32Array);
  }

  async isReady(): Promise<boolean> {
    try {
      await this.init();
      return true;
    } catch (err) {
      console.error(`[engram] Embedding model not ready: ${err}`);
      return false;
    }
  }
}
