import {
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
  USERNAME_PATTERN,
  normaliseUsername,
  trimUsername,
} from './username';

describe('normaliseUsername', () => {
  it('lowercases, so signing up as Ada lets you log in as ada', () => {
    expect(normaliseUsername('Ada')).toBe('ada');
    expect(normaliseUsername('ADA')).toBe('ada');
  });

  it('strips surrounding whitespace a copy-paste drags along', () => {
    expect(normaliseUsername('  ada  ')).toBe('ada');
    expect(normaliseUsername('\tada\n')).toBe('ada');
  });

  // The DTO's @IsString() has to be the thing that rejects a non-string, so the
  // transform must hand non-strings through untouched rather than stringifying
  // them — String(null) would otherwise sail past validation as "null".
  it('passes non-strings through for the validator to reject', () => {
    expect(normaliseUsername(null)).toBeNull();
    expect(normaliseUsername(undefined)).toBeUndefined();
    expect(normaliseUsername(42)).toBe(42);
    expect(normaliseUsername({})).toEqual({});
  });

  it('is idempotent', () => {
    expect(normaliseUsername(normaliseUsername('  Ada  '))).toBe('ada');
  });
});

describe('trimUsername', () => {
  // Redemption keeps the casing as typed for displayName, so this trims only.
  it('trims without touching case', () => {
    expect(trimUsername('  Ada  ')).toBe('Ada');
    expect(trimUsername('\tAda.Lovelace\n')).toBe('Ada.Lovelace');
    expect(trimUsername('ADA')).toBe('ADA');
  });

  it('passes non-strings through', () => {
    expect(trimUsername(null)).toBeNull();
  });
});

describe('USERNAME_PATTERN', () => {
  const accepts = (value: string) => expect(USERNAME_PATTERN.test(value)).toBe(true);
  const rejects = (value: string) => expect(USERNAME_PATTERN.test(value)).toBe(false);

  it('accepts plain names', () => {
    accepts('ada');
    accepts('ada2');
    accepts('a1b');
  });

  it('accepts inner dots, underscores and hyphens', () => {
    accepts('ada.lovelace');
    accepts('ada_lovelace');
    accepts('ada-lovelace');
    accepts('a.b_c-d');
  });

  // Validation runs before normalisation on redemption, because displayName
  // keeps the casing the user typed.
  it('accepts uppercase, which normalisation folds away afterwards', () => {
    accepts('Ada');
    accepts('ADA');
  });

  it('rejects separators at either end, which read as typos', () => {
    rejects('.ada');
    rejects('ada.');
    rejects('-ada');
    rejects('ada-');
    rejects('_ada');
    rejects('ada_');
  });

  it('rejects whitespace and characters that would need escaping in a URL', () => {
    rejects('ada lovelace');
    rejects('ada/lovelace');
    rejects('ada@lovelace');
    rejects('ada#1');
    rejects('adá');
  });

  it('rejects the empty string', () => {
    rejects('');
  });

  // A single character is a legal shape; length is bounded separately so the
  // DTO can report "too short" instead of a pattern error.
  it('leaves length to the length rules', () => {
    accepts('a');
    accepts('a'.repeat(100));
  });

  it('is stateless — a global flag would make alternate calls fail', () => {
    accepts('ada');
    accepts('ada');
    accepts('ada');
  });
});

describe('length bounds', () => {
  it('are the ones the rules text advertises', () => {
    expect(USERNAME_MIN_LENGTH).toBe(3);
    expect(USERNAME_MAX_LENGTH).toBe(32);
  });
});
