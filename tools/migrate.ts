import {readFile,readdir} from 'node:fs/promises';
import {Pool} from 'pg';

const pool=new Pool({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:5000,statement_timeout:30000});
try {
  // Apply the initial idempotent schema as a single transaction.
  if(!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const directory=new URL('../ebs/migrations/',import.meta.url);
  for(const file of (await readdir(directory)).filter(name=>/^\d+_.*\.sql$/.test(name)).sort())await pool.query(await readFile(new URL(file,directory),'utf8'));
  console.info('Database migration completed');
} catch(error) {console.error('Database migration failed:',error instanceof Error?error.message:'Unknown error');process.exitCode=1;}
finally {await pool.end();}
