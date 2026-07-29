import { PasswordService } from './password.service';

describe('PasswordService', () => {
  const service = new PasswordService();

  // argon2 is deliberately slow; these are well within the default timeout but
  // not instant.
  jest.setTimeout(20_000);

  it('produces an argon2id digest, not the plaintext', async () => {
    const digest = await service.hash('correct horse battery staple');

    expect(digest).toMatch(/^\$argon2id\$/);
    expect(digest).not.toContain('correct horse battery staple');
  });

  it('verifies the right password', async () => {
    const digest = await service.hash('correct horse battery staple');

    await expect(service.verify(digest, 'correct horse battery staple')).resolves.toBe(true);
  });

  it('rejects the wrong password', async () => {
    const digest = await service.hash('correct horse battery staple');

    await expect(service.verify(digest, 'Correct horse battery staple')).resolves.toBe(false);
    await expect(service.verify(digest, '')).resolves.toBe(false);
  });

  it('salts — the same password hashes differently every time', async () => {
    const [a, b] = await Promise.all([service.hash('same'), service.hash('same')]);

    expect(a).not.toEqual(b);
    await expect(service.verify(a, 'same')).resolves.toBe(true);
    await expect(service.verify(b, 'same')).resolves.toBe(true);
  });

  it('treats a malformed stored hash as a failed login rather than throwing', async () => {
    await expect(service.verify('not-a-hash', 'anything')).resolves.toBe(false);
    await expect(service.verify('', 'anything')).resolves.toBe(false);
  });
});
