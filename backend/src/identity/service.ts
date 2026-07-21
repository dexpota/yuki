import { hashPassword, verifyPassword } from './password.js';
import type { ActiveSession, IdentityOwner, IdentityStore, IssuedSession } from './store.js';

export class InvalidCredentialsError extends Error {
  override readonly name = 'InvalidCredentialsError';
}

export class IdentityService {
  public constructor(private readonly store: IdentityStore) {}

  public isSetupRequired(): Promise<boolean> {
    return this.store.isSetupRequired();
  }

  public async setup(username: string, password: string): Promise<IssuedSession> {
    validatePassword(password);
    const passwordHash = await hashPassword(password);
    const owner = await this.store.createFirstUser(username, passwordHash);
    return this.store.issueSession(owner);
  }

  public async login(username: string, password: string): Promise<IssuedSession> {
    const user = await this.store.findUserForLogin(username);
    if (user === undefined || !(await verifyPassword(user.passwordHash, password))) {
      throw new InvalidCredentialsError();
    }
    return this.store.issueSession({ id: user.id, username: user.username });
  }

  public authenticate(token: string): Promise<ActiveSession | undefined> {
    return this.store.authenticate(token);
  }

  public revoke(token: string): Promise<void> {
    return this.store.revoke(token);
  }

  public rotate(token: string): Promise<IssuedSession | undefined> {
    return this.store.rotate(token);
  }
}

export interface OwnerContext {
  readonly owner: IdentityOwner;
  readonly sessionId: string;
}

function validatePassword(password: string): void {
  if (password.length < 12 || password.length > 1024) {
    throw new TypeError('Password must contain between 12 and 1024 characters');
  }
}
