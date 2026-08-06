export function safeJsonParse(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export function debounce(fn, wait) {
  let timeoutId = null;
  const debounced = (...args) => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    timeoutId = setTimeout(() => {
      timeoutId = null;
      fn(...args);
    }, wait);
  };
  debounced.flush = (...args) => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
      fn(...args);
    }
  };
  return debounced;
}

export async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index], index);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

export function text(value) {
  return typeof value === "string" ? value : "";
}

export function now() {
  return Date.now();
}
