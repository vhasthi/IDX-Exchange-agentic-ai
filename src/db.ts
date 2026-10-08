import "dotenv/config";
import mysql from "mysql2/promise";

export function createPool() {
  const { MYSQL_HOST, MYSQL_USER, MYSQL_PASSWORD, MYSQL_DATABASE } = process.env;
  if (!MYSQL_USER || !MYSQL_DATABASE) {
    throw new Error("Missing MySQL settings. Copy .env.example to .env and fill it in.");
  }
  return mysql.createPool({
    host: MYSQL_HOST ?? "localhost",
    user: MYSQL_USER,
    password: MYSQL_PASSWORD,
    database: MYSQL_DATABASE,
    connectionLimit: 5,
  });
}
