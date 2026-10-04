/** Human-readable message for anything thrown or rejected (keeps DOMException names such as NotAllowedError). */
export function errorMessage(e: unknown): string {
  if (e instanceof Error || (typeof DOMException !== 'undefined' && e instanceof DOMException)) {
    const { name, message } = e as Error;
    if (!message) return name || 'Unknown error';
    return name && name !== 'Error' ? `${name}: ${message}` : message;
  }
  if (typeof e === 'string') return e;
  try {
    return JSON.stringify(e) ?? String(e);
  } catch {
    return String(e);
  }
}
