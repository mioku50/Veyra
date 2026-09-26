/** Copyright 2026 Veyra. SPDX-License-Identifier: Apache-2.0 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * What the migrations leave open to the Data API's client roles.
 *
 * Supabase's default privileges give anon and authenticated every right on
 * each new table and function in public, and PUBLIC may execute any function.
 * - A table is open until row-level security is enabled on it.
 * - A SECURITY DEFINER function runs as its owner, whatever the caller may do.
 *   It is open until it is revoked from PUBLIC, anon and authenticated alike.
 *
 * Five tables and eight such functions stayed open until 20260926140000,
 * because each migration had to remember this by hand. This replays the
 * migrations in order, as the database ran them, and names what is still open
 * at the end.
 */

export type Migration = { name: string; sql: string };
export type AccessGaps = { tablesWithoutRls: string[]; openDefinerFunctions: string[] };
export type Statement = { text: string; bodies: string[] };

const CLIENT_ROLES = ["public", "anon", "authenticated"];
/* $$ or $name$; $1 is a parameter, not a quote. */
const DOLLAR_TAG = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/;

export function readMigrations(directory: string): Migration[] {
  return readdirSync(directory)
    .filter((name) => /^\d+_[a-z0-9_]+\.sql$/i.test(name))
    .sort()
    .map((name) => ({ name, sql: readFileSync(resolve(directory, name), "utf8") }));
}

/**
 * Statements, one line each. Comments are dropped. Strings and dollar-quoted
 * bodies become placeholders, so a semicolon inside one does not end the
 * statement and words inside one are not clauses. The bodies themselves are
 * kept beside the statement: a DO block runs its body during the migration.
 */
export function sqlStatements(sql: string): Statement[] {
  const statements: Statement[] = [];
  let current = "";
  let bodies: string[] = [];
  const end = () => {
    const text = current.replace(/\s+/g, " ").trim();
    if (text) statements.push({ text, bodies });
    current = "";
    bodies = [];
  };
  let index = 0;
  while (index < sql.length) {
    const char = sql[index];
    if (char === "-" && sql[index + 1] === "-") {
      const newline = sql.indexOf("\n", index);
      index = newline === -1 ? sql.length : newline;
      current += " ";
    } else if (char === "/" && sql[index + 1] === "*") {
      const close = sql.indexOf("*/", index + 2);
      index = close === -1 ? sql.length : close + 2;
      current += " ";
    } else if (char === "'") {
      let close = index + 1;
      while (close < sql.length && !(sql[close] === "'" && sql[close + 1] !== "'")) close += sql[close] === "'" ? 2 : 1;
      index = close + 1;
      current += "''";
    } else if (char === "$" && DOLLAR_TAG.test(sql.slice(index, index + 64))) {
      const tag = DOLLAR_TAG.exec(sql.slice(index, index + 64))![0];
      const close = sql.indexOf(tag, index + tag.length);
      bodies.push(sql.slice(index + tag.length, close === -1 ? sql.length : close));
      index = close === -1 ? sql.length : close + tag.length;
      current += " $body$ ";
    } else if (char === ";") {
      end();
      index += 1;
    } else {
      current += char;
      index += 1;
    }
  }
  end();
  return statements;
}

/* public.x, "x" or x. Null for a name in another schema. */
function publicName(qualified: string): string | null {
  const parts = qualified.replace(/"/g, "").toLowerCase().split(".");
  if (parts.length === 1) return parts[0];
  return parts[0] === "public" ? parts[1] : null;
}

/* Functions named with their arguments, as ON FUNCTION and DROP FUNCTION list
   them: "a(text, numeric), public.b(uuid)". Arity is null when no arguments
   are given, which names every overload. OUT arguments are not part of a
   function's identity. */
function functionRefs(list: string): Array<{ name: string; arity: number | null }> {
  const refs: Array<{ name: string; arity: number | null }> = [];
  let index = 0;
  while (index < list.length) {
    const named = /^\s*,?\s*([\w."]+)\s*/.exec(list.slice(index));
    if (!named) break;
    index += named[0].length;
    const name = publicName(named[1]);
    let arity: number | null = null;
    if (list[index] === "(") {
      let depth = 0;
      let current = "";
      const args: string[] = [];
      for (; index < list.length; index += 1) {
        const char = list[index];
        if (char === "(" && depth++ === 0) continue;
        if (char === ")" && --depth === 0) break;
        if (char === "," && depth === 1) {
          args.push(current);
          current = "";
          continue;
        }
        current += char;
      }
      index += 1;
      args.push(current);
      arity = args.map((arg) => arg.trim()).filter((arg) => arg && !/^OUT\s/i.test(arg)).length;
    }
    if (name) refs.push({ name, arity });
  }
  return refs;
}

function grantees(list: string): string[] {
  return list
    .replace(/\s+(?:CASCADE|RESTRICT|WITH GRANT OPTION)\s*$/i, "")
    .split(",")
    .map((role) => role.trim().replace(/"/g, "").toLowerCase())
    .filter((role) => CLIENT_ROLES.includes(role));
}

export function accessGaps(migrations: Migration[]): AccessGaps {
  /* A public table, and whether row-level security is on. */
  const tables = new Map<string, boolean>();
  /* "name/arity", whether it is a definer, and which client roles may run it. */
  const functions = new Map<string, { definer: boolean; open: Set<string> }>();
  const matching = (ref: { name: string; arity: number | null }) =>
    Array.from(functions.keys()).filter((key) => ref.arity === null ? key.startsWith(`${ref.name}/`) : key === `${ref.name}/${ref.arity}`);

  for (const migration of migrations) {
    for (const { text: statement, bodies } of sqlStatements(migration.sql)) {
      let match: RegExpExecArray | null;
      if (/^DO\b/i.test(statement)) {
        /* Row-level security enabled from inside a block: by name, or by
           format() over a literal array of table names. */
        for (const body of bodies) {
          for (const named of body.matchAll(/ALTER TABLE (?:IF EXISTS )?(?:ONLY )?([\w."]+) ENABLE ROW LEVEL SECURITY/gi)) {
            const name = publicName(named[1]);
            if (name && tables.has(name)) tables.set(name, true);
          }
          if (!/format\(\s*'ALTER TABLE (?:public\.)?%I ENABLE ROW LEVEL SECURITY'/i.test(body)) continue;
          for (const list of body.matchAll(/\barray\s*\[([^\]]*)\]/gi)) {
            for (const quoted of list[1].matchAll(/'(\w+)'/g)) {
              const name = quoted[1].toLowerCase();
              if (tables.has(name)) tables.set(name, true);
            }
          }
        }
      } else if ((match = /^CREATE (?:UNLOGGED )?TABLE (?:IF NOT EXISTS )?([\w."]+)/i.exec(statement))) {
        const name = publicName(match[1]);
        if (name && !tables.has(name)) tables.set(name, false);
      } else if ((match = /^DROP TABLE (?:IF EXISTS )?(.+?)(?: CASCADE| RESTRICT)?$/i.exec(statement))) {
        for (const each of match[1].split(",")) {
          const name = publicName(each.trim());
          if (name) tables.delete(name);
        }
      } else if ((match = /^ALTER TABLE (?:IF EXISTS )?(?:ONLY )?([\w."]+) (.*)$/i.exec(statement))) {
        const name = publicName(match[1]);
        if (!name || !tables.has(name)) continue;
        if (/\bENABLE ROW LEVEL SECURITY\b/i.test(match[2])) tables.set(name, true);
        if (/\bDISABLE ROW LEVEL SECURITY\b/i.test(match[2])) tables.set(name, false);
        const renamed = /^RENAME TO ([\w"]+)$/i.exec(match[2]);
        if (renamed) {
          tables.set(publicName(renamed[1])!, tables.get(name)!);
          tables.delete(name);
        }
      } else if ((match = /^CREATE (?:OR REPLACE )?FUNCTION ([\w."]+\s*\(.*)$/i.exec(statement))) {
        const [ref] = functionRefs(match[1]);
        if (!ref) continue;
        const key = `${ref.name}/${ref.arity ?? 0}`;
        const definer = /\bSECURITY DEFINER\b/i.test(statement);
        /* Replacing a function keeps its grants; creating one starts from the defaults. */
        const existing = functions.get(key);
        if (existing) existing.definer = definer;
        else functions.set(key, { definer, open: new Set(CLIENT_ROLES) });
      } else if ((match = /^DROP FUNCTION (?:IF EXISTS )?(.+?)(?: CASCADE| RESTRICT)?$/i.exec(statement))) {
        for (const ref of functionRefs(match[1])) for (const key of matching(ref)) functions.delete(key);
      } else if ((match = /^ALTER FUNCTION (.+)$/i.exec(statement))) {
        const setting = /\bSECURITY (DEFINER|INVOKER)\b/i.exec(match[1]);
        const [ref] = functionRefs(match[1]);
        if (!setting || !ref) continue;
        for (const key of matching(ref)) functions.get(key)!.definer = setting[1].toUpperCase() === "DEFINER";
      } else if ((match = /^(REVOKE|GRANT) .+? ON FUNCTION (.+) (?:FROM|TO) (.+?)$/i.exec(statement))) {
        const revoke = match[1].toUpperCase() === "REVOKE";
        const roles = grantees(match[3]);
        for (const ref of functionRefs(match[2])) {
          for (const key of matching(ref)) {
            for (const role of roles) {
              if (revoke) functions.get(key)!.open.delete(role);
              else functions.get(key)!.open.add(role);
            }
          }
        }
      }
    }
  }

  return {
    tablesWithoutRls: Array.from(tables).filter(([, rls]) => !rls).map(([name]) => name).sort(),
    openDefinerFunctions: Array.from(functions)
      .filter(([, state]) => state.definer && state.open.size > 0)
      .map(([key, state]) => `${key.replace(/\/(\d+)$/, " ($1 arguments)")} to ${Array.from(state.open).join(", ")}`)
      .sort(),
  };
}
