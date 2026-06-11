import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import express from 'express';

console.log('Step 1: imports ok');
console.log('DATABASE_URL:', process.env.DATABASE_URL ? 'SET' : 'NOT SET');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
console.log('Step 2: pool created');

const db = drizzle(pool);
console.log('Step 3: drizzle created');

// Test actual DB connection
try {
  const client = await pool.connect();
  console.log('Step 4: DB connected');
  client.release();
} catch (e) {
  console.error('Step 4 FAILED:', e.message);
}

const app = express();
const PORT = Number(process.env.PORT ?? 3000);

app.get('/api/healthz', (_req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log('Step 5: Server listening on port', PORT);
});
