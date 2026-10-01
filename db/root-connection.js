// @ts-check
import mysql from 'mysql2/promise';

/**
 * Creates a connection to the root database using credentials from .env.
 * @returns {Promise<import('mysql2/promise').Connection>}
 */
export async function getRootDbConnection() {
  return mysql.createConnection({
    host: process.env.ROOT_DB_HOST,
    port: Number(process.env.ROOT_DB_PORT),
    database: process.env.ROOT_DB_DATABASE,
    user: process.env.ROOT_DB_USERNAME,
    password: process.env.ROOT_DB_PASSWORD,
  });
}
