/**
 * Pause for a given number of milliseconds.
 * @param {number} ms
 * @returns {Promise<void>}
 */
export async function delay(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run tasks with a concurrency limit, preserving result order.
 * @param {Array<any>} items
 * @param {number} limit
 * @param {(item: any, index: number) => Promise<any>} worker
 * @returns {Promise<Array<any>>}
 */
export async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const concurrency = Math.max(1, Math.min(limit, items.length));

  const runners = Array.from({ length: concurrency }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });

  await Promise.all(runners);
  return results;
}
