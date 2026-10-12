import { afterEach, describe, expect, it, vi } from 'vitest';
import { HUGGING_FACE_BASE_URL, modelSourceFor } from '../src/models';

describe('modelSourceFor', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('recognises Hugging Face (with or without a trailing slash)', () => {
    expect(modelSourceFor(HUGGING_FACE_BASE_URL)).toEqual({ kind: 'huggingface', baseUrl: HUGGING_FACE_BASE_URL });
    expect(modelSourceFor(`${HUGGING_FACE_BASE_URL}/`)).toEqual({ kind: 'huggingface', baseUrl: HUGGING_FACE_BASE_URL });
  });

  it('resolves a path on this site against the page', () => {
    vi.stubGlobal('location', { href: 'https://app.example.com/chat/thread?x=1' });
    expect(modelSourceFor('/models/')).toEqual({ kind: 'mirror', baseUrl: 'https://app.example.com/models' });
  });

  it('keeps an absolute mirror URL, without the trailing slash', () => {
    expect(modelSourceFor('https://cdn.example.com/speech/')).toEqual({ kind: 'mirror', baseUrl: 'https://cdn.example.com/speech' });
  });

  it('rejects anything that is not http(s), e.g. a Windows path a shell put in place of /models', () => {
    vi.stubGlobal('location', { href: 'http://localhost:3000/' });
    expect(() => modelSourceFor('C:/Program Files/Git/models')).toThrow(/http\(s\) URL or a path on this site/);
    expect(() => modelSourceFor('file:///srv/models')).toThrow(/http\(s\) URL/);
  });
});
