export async function embed(text: string, ollamaUrl: string, ollamaModel: string): Promise<number[]> {
  const res = await fetch(`${ollamaUrl}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: ollamaModel, prompt: text }),
  });

  if (!res.ok) {
    throw new Error(`Ollama embedding failed: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as { embedding: number[] };
  return data.embedding;
}

export async function isOllamaRunning(ollamaUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${ollamaUrl}/api/tags`);
    return res.ok;
  } catch {
    return false;
  }
}
