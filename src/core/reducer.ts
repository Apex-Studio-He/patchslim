export interface ReductionResult<T> {
  kept: T[];
  evaluations: number;
}

export async function ddmin<T>(
  values: readonly T[],
  predicate: (candidate: readonly T[]) => Promise<boolean>,
  deadline: number,
): Promise<ReductionResult<T>> {
  let current = [...values];
  let granularity = 2;
  let evaluations = 0;

  if (current.length === 0) {
    return { kept: current, evaluations };
  }

  while (current.length >= 2 && Date.now() < deadline) {
    const chunks = partition(current, granularity);
    let reduced = false;

    for (const chunk of chunks) {
      if (Date.now() >= deadline) {
        break;
      }

      const removed = new Set(chunk);
      const candidate = current.filter((value) => !removed.has(value));
      evaluations += 1;
      if (await predicate(candidate)) {
        current = candidate;
        granularity = Math.max(2, granularity - 1);
        reduced = true;
        break;
      }
    }

    if (reduced) {
      continue;
    }

    if (granularity >= current.length) {
      break;
    }
    granularity = Math.min(current.length, granularity * 2);
  }

  for (const value of [...current]) {
    if (Date.now() >= deadline) {
      break;
    }

    const candidate = current.filter((item) => item !== value);
    evaluations += 1;
    if (await predicate(candidate)) {
      current = candidate;
    }
  }

  return { kept: current, evaluations };
}

function partition<T>(values: readonly T[], count: number): T[][] {
  const chunks: T[][] = [];
  const chunkSize = Math.ceil(values.length / count);

  for (let index = 0; index < values.length; index += chunkSize) {
    chunks.push(values.slice(index, index + chunkSize));
  }

  return chunks;
}
