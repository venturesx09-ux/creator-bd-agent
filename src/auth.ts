import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { Pool } from "pg";

const scrypt = promisify(scryptCallback);
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export type UserRole = "owner" | "admin" | "member";

export type AuthenticatedUser = {
  id: string;
  workspaceId: string;
  workspaceName: string;
  email: string;
  displayName: string;
  role: UserRole;
};

export type TeamMember = Pick<AuthenticatedUser, "id" | "email" | "displayName" | "role"> & {
  enabled: boolean;
  createdAt: Date;
};

type Logger = Pick<Console, "error">;

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function passwordHash(password: string, salt: Buffer): Promise<Buffer> {
  return (await scrypt(password, salt, 64)) as Buffer;
}

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string
  ) {
    super(message);
  }
}

export class AuthRepository {
  private readonly pool: Pool;

  constructor(database: { url: string; ssl: boolean }, logger: Logger = console) {
    this.pool = new Pool({
      connectionString: database.url,
      max: 3,
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
      ...(database.ssl ? { ssl: { rejectUnauthorized: true } } : {})
    });
    this.pool.on("error", () => {
      logger.error(JSON.stringify({ event: "auth_database_pool_error", message: "Database error" }));
    });
  }

  async initialize(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS workspaces (
        id UUID PRIMARY KEY,
        name VARCHAR(120) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS app_users (
        id UUID PRIMARY KEY,
        email VARCHAR(254) NOT NULL,
        display_name VARCHAR(100) NOT NULL,
        password_salt TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS app_users_email_lower_idx
      ON app_users (LOWER(email))
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS workspace_members (
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
        role VARCHAR(20) NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (workspace_id, user_id)
      )
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS user_sessions (
        token_hash CHAR(64) PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS user_sessions_expiry_idx ON user_sessions (expires_at)
    `);
    await this.pool.query(`
      ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS owner_user_id UUID
        REFERENCES app_users(id) ON DELETE RESTRICT
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS mailboxes_owner_created_idx
      ON mailboxes (owner_user_id, created_at)
    `);
    await this.pool.query("DELETE FROM user_sessions WHERE expires_at <= NOW()");
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async hasUsers(): Promise<boolean> {
    const result = await this.pool.query<{ exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM app_users) AS exists"
    );
    return result.rows[0]?.exists ?? false;
  }

  async bootstrapOwner(input: {
    email: string;
    displayName: string;
    password: string;
  }): Promise<AuthenticatedUser> {
    const email = normalizeEmail(input.email);
    if (!email || email.length > 254 || !email.includes("@")) {
      throw new AuthError("请输入有效邮箱", 400, "INVALID_EMAIL");
    }
    if (input.displayName.trim().length < 1 || input.displayName.trim().length > 100) {
      throw new AuthError("姓名长度应为1至100个字符", 400, "INVALID_DISPLAY_NAME");
    }
    if (input.password.length < 12 || input.password.length > 200) {
      throw new AuthError("密码至少需要12个字符", 400, "WEAK_PASSWORD");
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query("SELECT 1 FROM app_users LIMIT 1 FOR UPDATE");
      if (existing.rowCount) {
        throw new AuthError("团队管理员已经初始化", 409, "ALREADY_INITIALIZED");
      }
      const workspaceId = randomUUID();
      const userId = randomUUID();
      const salt = randomBytes(16);
      const hash = await passwordHash(input.password, salt);
      await client.query("INSERT INTO workspaces (id, name) VALUES ($1, $2)", [workspaceId, "Flourish Culture"]);
      await client.query(
        `INSERT INTO app_users (id, email, display_name, password_salt, password_hash)
         VALUES ($1, $2, $3, $4, $5)`,
        [userId, email, input.displayName.trim(), salt.toString("base64"), hash.toString("base64")]
      );
      await client.query(
        "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')",
        [workspaceId, userId]
      );
      await client.query("UPDATE mailboxes SET owner_user_id = $1 WHERE owner_user_id IS NULL", [userId]);
      await client.query("COMMIT");
      return {
        id: userId,
        workspaceId,
        workspaceName: "Flourish Culture",
        email,
        displayName: input.displayName.trim(),
        role: "owner"
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async login(emailInput: string, password: string): Promise<{ token: string; user: AuthenticatedUser }> {
    const email = normalizeEmail(emailInput);
    const result = await this.pool.query<{
      id: string; email: string; display_name: string; password_salt: string; password_hash: string;
      enabled: boolean; workspace_id: string; workspace_name: string; role: UserRole;
    }>(
      `SELECT u.id, u.email, u.display_name, u.password_salt, u.password_hash, u.enabled,
              w.id AS workspace_id, w.name AS workspace_name, m.role
       FROM app_users u
       JOIN workspace_members m ON m.user_id = u.id
       JOIN workspaces w ON w.id = m.workspace_id
       WHERE LOWER(u.email) = $1
       LIMIT 1`,
      [email]
    );
    const row = result.rows[0];
    if (!row || !row.enabled) {
      throw new AuthError("邮箱或密码错误", 401, "INVALID_CREDENTIALS");
    }
    const actual = await passwordHash(password, Buffer.from(row.password_salt, "base64"));
    const expected = Buffer.from(row.password_hash, "base64");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new AuthError("邮箱或密码错误", 401, "INVALID_CREDENTIALS");
    }
    const token = randomBytes(32).toString("base64url");
    await this.pool.query(
      `INSERT INTO user_sessions (token_hash, user_id, expires_at)
       VALUES ($1, $2, $3)`,
      [tokenHash(token), row.id, new Date(Date.now() + SESSION_TTL_MS)]
    );
    return {
      token,
      user: {
        id: row.id,
        workspaceId: row.workspace_id,
        workspaceName: row.workspace_name,
        email: row.email,
        displayName: row.display_name,
        role: row.role
      }
    };
  }

  async authenticate(token: string): Promise<AuthenticatedUser | undefined> {
    const result = await this.pool.query<{
      id: string; email: string; display_name: string; workspace_id: string;
      workspace_name: string; role: UserRole;
    }>(
      `SELECT u.id, u.email, u.display_name, w.id AS workspace_id,
              w.name AS workspace_name, m.role
       FROM user_sessions s
       JOIN app_users u ON u.id = s.user_id AND u.enabled = TRUE
       JOIN workspace_members m ON m.user_id = u.id
       JOIN workspaces w ON w.id = m.workspace_id
       WHERE s.token_hash = $1 AND s.expires_at > NOW()
       LIMIT 1`,
      [tokenHash(token)]
    );
    const row = result.rows[0];
    if (!row) return undefined;
    void this.pool.query("UPDATE user_sessions SET last_seen_at = NOW() WHERE token_hash = $1", [tokenHash(token)]);
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      workspaceName: row.workspace_name,
      email: row.email,
      displayName: row.display_name,
      role: row.role
    };
  }

  async logout(token: string): Promise<void> {
    await this.pool.query("DELETE FROM user_sessions WHERE token_hash = $1", [tokenHash(token)]);
  }

  async listMembers(actor: AuthenticatedUser): Promise<TeamMember[]> {
    if (actor.role === "member") throw new AuthError("没有成员管理权限", 403, "FORBIDDEN");
    const result = await this.pool.query<{
      id: string; email: string; display_name: string; role: UserRole; enabled: boolean; created_at: Date;
    }>(
      `SELECT u.id, u.email, u.display_name, m.role, u.enabled, u.created_at
       FROM workspace_members m JOIN app_users u ON u.id = m.user_id
       WHERE m.workspace_id = $1 ORDER BY u.created_at ASC`,
      [actor.workspaceId]
    );
    return result.rows.map((row) => ({
      id: row.id, email: row.email, displayName: row.display_name,
      role: row.role, enabled: row.enabled, createdAt: row.created_at
    }));
  }

  async createMember(actor: AuthenticatedUser, input: {
    email: string; displayName: string; password: string; role: Exclude<UserRole, "owner">;
  }): Promise<TeamMember> {
    if (actor.role === "member") throw new AuthError("没有成员管理权限", 403, "FORBIDDEN");
    const email = normalizeEmail(input.email);
    if (!email || email.length > 254 || !email.includes("@")) throw new AuthError("请输入有效邮箱", 400, "INVALID_EMAIL");
    if (!input.displayName.trim() || input.displayName.trim().length > 100) throw new AuthError("请输入成员姓名", 400, "INVALID_DISPLAY_NAME");
    if (input.password.length < 12 || input.password.length > 200) throw new AuthError("初始密码至少需要12个字符", 400, "WEAK_PASSWORD");
    if (input.role !== "admin" && input.role !== "member") throw new AuthError("成员角色无效", 400, "INVALID_ROLE");
    const id = randomUUID();
    const salt = randomBytes(16);
    const hash = await passwordHash(input.password, salt);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO app_users (id, email, display_name, password_salt, password_hash)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, email, input.displayName.trim(), salt.toString("base64"), hash.toString("base64")]
      );
      await client.query(
        "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)",
        [actor.workspaceId, id, input.role]
      );
      await client.query("COMMIT");
      return { id, email, displayName: input.displayName.trim(), role: input.role, enabled: true, createdAt: new Date() };
    } catch (error) {
      await client.query("ROLLBACK");
      const candidate = error as { code?: unknown };
      if (candidate.code === "23505") throw new AuthError("该邮箱已经存在", 409, "EMAIL_EXISTS");
      throw error;
    } finally { client.release(); }
  }

  async setMemberEnabled(actor: AuthenticatedUser, userId: string, enabled: boolean): Promise<void> {
    if (actor.role === "member") throw new AuthError("没有成员管理权限", 403, "FORBIDDEN");
    if (userId === actor.id && !enabled) throw new AuthError("不能停用当前账号", 409, "CANNOT_DISABLE_SELF");
    const result = await this.pool.query(
      `UPDATE app_users u SET enabled = $3, updated_at = NOW()
       FROM workspace_members m
       WHERE u.id = $2 AND m.user_id = u.id AND m.workspace_id = $1 AND m.role <> 'owner'`,
      [actor.workspaceId, userId, enabled]
    );
    if (!result.rowCount) throw new AuthError("成员不存在或不可修改", 404, "MEMBER_NOT_FOUND");
    if (!enabled) await this.pool.query("DELETE FROM user_sessions WHERE user_id = $1", [userId]);
  }

  async assignMailbox(actor: AuthenticatedUser, mailboxId: string, userId: string): Promise<void> {
    if (actor.role === "member") throw new AuthError("没有邮箱分配权限", 403, "FORBIDDEN");
    const result = await this.pool.query(
      `UPDATE mailboxes mb SET owner_user_id = $3, updated_at = NOW()
       WHERE mb.id = $2
         AND EXISTS (
           SELECT 1 FROM workspace_members target
           JOIN app_users u ON u.id = target.user_id AND u.enabled = TRUE
           WHERE target.workspace_id = $1 AND target.user_id = $3
         )
         AND (
           mb.owner_user_id IS NULL OR EXISTS (
             SELECT 1 FROM workspace_members current_owner
             WHERE current_owner.workspace_id = $1
               AND current_owner.user_id = mb.owner_user_id
           )
         )`,
      [actor.workspaceId, mailboxId, userId]
    );
    if (!result.rowCount) throw new AuthError("邮箱或目标成员不存在", 404, "MAILBOX_ASSIGNMENT_NOT_FOUND");
  }
}
