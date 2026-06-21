export function parseIntOption(value: string, flagName: string, min = 0): number {
  const normalized = value.trim();

  if (!/^-?\d+$/.test(normalized)) {
    throw new Error(`Invalid value for ${flagName}: '${value}' is not an integer`);
  }

  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Invalid value for ${flagName}: '${value}' is not a safe integer`);
  }

  if (parsed < min) {
    throw new Error(`Invalid value for ${flagName}: expected >= ${min}, got ${parsed}`);
  }

  return parsed;
}
