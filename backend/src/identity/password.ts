import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

interface Argon2Module {
  readonly argon2id: number;
  hash(password: string, options: Argon2Options): Promise<string>;
  verify(hash: string, password: string, options: { type: number }): Promise<boolean>;
}

interface Argon2Options {
  readonly type: number;
  readonly memoryCost: number;
  readonly timeCost: number;
  readonly parallelism: number;
}

const parameters = {
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 1,
} as const;

function argon2(): Argon2Module {
  // Kept behind a narrow adapter so password policy is owned by identity and
  // native module loading happens only when hashing or verification is needed.
  return require('argon2') as Argon2Module;
}

export async function hashPassword(password: string): Promise<string> {
  const implementation = argon2();
  return implementation.hash(password, { type: implementation.argon2id, ...parameters });
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  const implementation = argon2();
  try {
    return await implementation.verify(hash, password, { type: implementation.argon2id });
  } catch {
    return false;
  }
}
