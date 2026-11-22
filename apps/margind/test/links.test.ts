import { describe, expect, test } from 'bun:test';
import { linkIn, safePreview } from '../src/daemon';

describe('link previews', () => {
  const url = 'https://open.spotify.com/track/0UqKPaKqC3tWU4o8BB7owl';

  test('the preview address must be a whole link in the text', () => {
    expect(linkIn(`listen ${url}`, url)).toBe(true);
    expect(linkIn(`${url}?si=3c4b`, `${url}?si=3c4b`)).toBe(true);
    expect(linkIn(`have you heard this (${url}).`, url)).toBe(true);
    expect(linkIn(`"${url}"`, url)).toBe(true);
    // The start of a longer address, or inside another word, doesn't count.
    expect(linkIn('https://evil.com.attacker.net/x', 'https://evil.com')).toBe(false);
    expect(linkIn('https://evil.com/path', 'https://evil.com')).toBe(false);
    expect(linkIn('xhttps://evil.com', 'https://evil.com')).toBe(false);
    expect(linkIn('nothing here', url)).toBe(false);
    // A user name or password in the address is refused outright.
    const tricked = 'https://open.spotify.com@evil.com/';
    expect(linkIn(`see ${tricked}`, tricked)).toBe(false);
  });

  test('a picture that is not a JPEG is dropped, and the rest of the preview kept', () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]).toString('base64');
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]).toString('base64');
    expect(safePreview({ url, title: 'Song', image: jpeg }).image).toBe(jpeg);
    expect(safePreview({ url, title: 'Song', image: png })).toEqual({ url, title: 'Song' });
  });
});
