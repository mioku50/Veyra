/** Copyright 2026 Veyra. SPDX-License-Identifier: Apache-2.0 */
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { accessGaps, readMigrations, sqlStatements } from "./migration-access.mts";

const gaps = (...sql: string[]) => accessGaps(sql.map((text, index) => ({ name: `${index}_test.sql`, sql: text })));

/* ---- statements ---- */

{
  const statements = sqlStatements([
    "-- a comment; with the owner's quote",
    "SELECT 1; /* ; */ SELECT 'a;b''c';",
    "CREATE FUNCTION f() RETURNS int AS $fn$ BEGIN RETURN 1; END $fn$ LANGUAGE plpgsql;",
    "SELECT $1; SELECT 2",
  ].join("\n"));
  assert.deepEqual(statements.map((statement) => statement.text), [
    "SELECT 1",
    "SELECT ''",
    "CREATE FUNCTION f() RETURNS int AS $body$ LANGUAGE plpgsql",
    "SELECT $1",
    "SELECT 2",
  ], "Comments, strings and bodies do not end a statement; $1 is not a quote");
  assert.deepEqual(statements[2].bodies, [" BEGIN RETURN 1; END "], "A body is kept beside its statement");
}

/* ---- tables ---- */

assert.deepEqual(gaps("CREATE TABLE public.a (id int);").tablesWithoutRls, ["a"], "A new table is open");
assert.deepEqual(gaps("CREATE TABLE a (id int); ALTER TABLE public.a ENABLE ROW LEVEL SECURITY;").tablesWithoutRls, [],
  "Unqualified is public");
assert.deepEqual(gaps("CREATE TABLE IF NOT EXISTS public.a (id int);", "alter table if exists only public.a enable row level security;").tablesWithoutRls, [],
  "Across migrations, in any case");
assert.deepEqual(gaps("CREATE TABLE private.a (id int);").tablesWithoutRls, [], "Another schema is not the Data API's");
assert.deepEqual(gaps("CREATE TABLE public.a (id int);", "DROP TABLE IF EXISTS public.a CASCADE;").tablesWithoutRls, [], "A dropped table is gone");
assert.deepEqual(gaps(
  "CREATE TABLE public.a (id int); ALTER TABLE public.a ENABLE ROW LEVEL SECURITY;",
  "CREATE TABLE IF NOT EXISTS public.a (id int);",
).tablesWithoutRls, [], "Creating an existing table if not exists changes nothing");
assert.deepEqual(gaps(
  "CREATE TABLE public.a (id int); ALTER TABLE public.a ENABLE ROW LEVEL SECURITY;",
  "ALTER TABLE public.a DISABLE ROW LEVEL SECURITY;",
).tablesWithoutRls, ["a"], "Disabling reopens");
assert.deepEqual(gaps(
  "CREATE TABLE public.a (id int); CREATE TABLE public.b (id int); CREATE TABLE public.c (id int);",
  "DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['a', 'b'] LOOP EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t); END LOOP; END $$;",
).tablesWithoutRls, ["c"], "A loop by format() over named tables, as p55 and phase28 do");
assert.deepEqual(gaps(
  "CREATE TABLE public.a (id int);",
  "DO $$ BEGIN ALTER TABLE public.a ENABLE ROW LEVEL SECURITY; END $$;",
).tablesWithoutRls, [], "Enabled by name inside a block");
assert.deepEqual(gaps(
  "CREATE TABLE public.a (id int);",
  "CREATE FUNCTION f() RETURNS void AS $$ BEGIN ALTER TABLE public.a ENABLE ROW LEVEL SECURITY; END $$ LANGUAGE plpgsql;",
).tablesWithoutRls, ["a"], "A function's body runs when called, not during the migration");

/* ---- definer functions ---- */

const DEFINER = "CREATE OR REPLACE FUNCTION public.spend(p_id TEXT, p_at TIMESTAMPTZ) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$ BEGIN RETURN '{}'; END $$;";
const CLOSE = "REVOKE ALL ON FUNCTION public.spend(text, timestamp with time zone)\n  FROM PUBLIC, anon, authenticated;";

assert.deepEqual(gaps(DEFINER).openDefinerFunctions, ["spend (2 arguments) to public, anon, authenticated"], "A new definer is open to every client role");
assert.deepEqual(gaps(DEFINER, "REVOKE ALL ON FUNCTION public.spend(TEXT, TIMESTAMPTZ) FROM PUBLIC;").openDefinerFunctions,
  ["spend (2 arguments) to anon, authenticated"], "Revoking from PUBLIC leaves the grants anon and authenticated hold, as p70 did");
assert.deepEqual(gaps(DEFINER, CLOSE).openDefinerFunctions, [], "Closed, however its types are spelled");
assert.deepEqual(gaps(DEFINER, CLOSE, "GRANT EXECUTE ON FUNCTION public.spend(TEXT, TIMESTAMPTZ) TO service_role;").openDefinerFunctions, [],
  "The service role is not a client role");
assert.deepEqual(gaps(DEFINER, CLOSE, DEFINER).openDefinerFunctions, [], "Replacing keeps the grants");
assert.deepEqual(gaps(DEFINER, CLOSE, "DROP FUNCTION IF EXISTS public.spend(TEXT, TIMESTAMPTZ);", DEFINER).openDefinerFunctions,
  ["spend (2 arguments) to public, anon, authenticated"], "Dropped and created again starts from the defaults");
assert.deepEqual(gaps(DEFINER, CLOSE, "GRANT EXECUTE ON FUNCTION public.spend(TEXT, TIMESTAMPTZ) TO anon;").openDefinerFunctions,
  ["spend (2 arguments) to anon"], "A grant reopens");
assert.deepEqual(gaps(DEFINER.replace("SECURITY DEFINER", "SECURITY INVOKER")).openDefinerFunctions, [],
  "An invoker runs with the caller's own rights");
assert.deepEqual(gaps(DEFINER.replace("SECURITY DEFINER", ""), "ALTER FUNCTION public.spend(TEXT, TIMESTAMPTZ) SECURITY DEFINER;").openDefinerFunctions,
  ["spend (2 arguments) to public, anon, authenticated"], "Made a definer afterwards");
assert.deepEqual(gaps(
  DEFINER.replace("p_at TIMESTAMPTZ", "p_cap NUMERIC(20, 6)"),
  "ALTER FUNCTION public.spend(TEXT, NUMERIC(20, 6)) SECURITY INVOKER;",
).openDefinerFunctions, [], "Made an invoker afterwards, with a type that has its own parentheses");
assert.deepEqual(gaps(
  "CREATE FUNCTION public.g(p TEXT, OUT r INT) LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$;",
  "REVOKE ALL ON FUNCTION public.g(TEXT) FROM PUBLIC, anon, authenticated;",
).openDefinerFunctions, [], "OUT arguments are not part of the identity");
assert.deepEqual(gaps(
  DEFINER,
  DEFINER.replace("p_at TIMESTAMPTZ", "p_at TIMESTAMPTZ, p_cap NUMERIC(20, 6) DEFAULT 0"),
  CLOSE,
).openDefinerFunctions, ["spend (3 arguments) to public, anon, authenticated"], "An overload is its own function");
assert.deepEqual(gaps(
  DEFINER,
  DEFINER.replace("p_at TIMESTAMPTZ", "p_at TIMESTAMPTZ, p_cap NUMERIC"),
  "REVOKE ALL ON FUNCTION public.spend FROM PUBLIC, anon, authenticated;",
).openDefinerFunctions, [], "No arguments names every overload");

/* ---- this repository ---- */

{
  const migrations = readMigrations(resolve(import.meta.dirname, "../supabase/migrations"));
  const before = accessGaps(migrations.filter((migration) => migration.name < "20260926140000"));
  assert.deepEqual(before.tablesWithoutRls, ["execution_attempts", "execution_mandate_usage", "execution_mandates", "x402_quotes", "x402_selections"],
    "What production had open on 26 September, found from the migrations alone");
  assert.equal(before.openDefinerFunctions.length, 8);
  const now = accessGaps(migrations);
  assert.deepEqual(now, { tablesWithoutRls: [], openDefinerFunctions: [] },
    `The migrations leave something open to the Data API's client roles:\n${JSON.stringify(now, null, 2)}\n` +
    "Enable row-level security on a new table, and revoke a SECURITY DEFINER function from PUBLIC, anon and authenticated.");
}

console.log("migration access: all assertions passed");
