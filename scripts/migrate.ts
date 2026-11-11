import { readFileSync } from "node:fs";
import { crearSql } from "../src/store/postgres.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("Falta DATABASE_URL");
const sql = crearSql(url);
await sql.unsafe(readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8"));
console.log("Esquema aplicado.");
await sql.end();
