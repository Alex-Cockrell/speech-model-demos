/**
 * The text of a session's segments, in order: each segment's final text, or its latest partial until the final
 * arrives. Used by the benchmark recording and by dictation.
 */
export class SegmentTexts {
  private readonly segments: { id: string; partial: string; final: string | null }[] = [];

  start(id: string): void {
    this.segments.push({ id, partial: '', final: null });
  }

  partial(id: string, text: string): void {
    const segment = this.find(id);
    if (segment && segment.final === null) segment.partial = text;
  }

  final(id: string, text: string): void {
    const segment = this.find(id);
    if (segment) segment.final = text;
  }

  /** What is shown while listening: finals plus the open segments' latest partials. */
  get visible(): string {
    return joinTexts(this.segments.map((segment) => segment.final ?? segment.partial));
  }

  /** The concatenated final texts. */
  get finals(): string {
    return joinTexts(this.segments.map((segment) => segment.final ?? ''));
  }

  private find(id: string): { id: string; partial: string; final: string | null } | undefined {
    for (let i = this.segments.length - 1; i >= 0; i--) if (this.segments[i].id === id) return this.segments[i];
    return undefined;
  }
}

function joinTexts(texts: readonly string[]): string {
  return texts
    .map((text) => text.trim())
    .filter((text) => text !== '')
    .join(' ');
}
