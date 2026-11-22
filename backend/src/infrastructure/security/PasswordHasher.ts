import bcrypt from 'bcrypt';

export interface PasswordHasher {
  hash(plain: string): Promise<string>;
  verify(plain: string, hash: string): Promise<boolean>;
  /** Burns the same CPU time as a real verify (prevents user enumeration by timing). */
  verifyDummy(plain: string): Promise<void>;
}

export class BcryptPasswordHasher implements PasswordHasher {
  private dummyHash?: Promise<string>;

  constructor(private readonly rounds: number) {}

  hash(plain: string): Promise<string> {
    return bcrypt.hash(plain, this.rounds);
  }

  verify(plain: string, hash: string): Promise<boolean> {
    return bcrypt.compare(plain, hash);
  }

  async verifyDummy(plain: string): Promise<void> {
    this.dummyHash ??= bcrypt.hash('timing-equaliser-not-a-password', this.rounds);
    await bcrypt.compare(plain, await this.dummyHash);
  }
}
