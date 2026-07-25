export function prettyJson(value: unknown) {
  try {
    return JSON.stringify(value ?? null, null, 2);
  } catch (error) {
    return JSON.stringify(
      { error: error instanceof Error ? error.message : String(error) },
      null,
      2,
    );
  }
}
