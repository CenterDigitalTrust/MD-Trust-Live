import {Pool} from 'pg';
import {anchorOnce} from '../ebs/src/anchor.ts';
const pool=new Pool({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:5000});
try {
  // Run one bounded anchor operation for deployment validation or manual recovery.
  console.info(JSON.stringify(await anchorOnce(pool)));
} catch(error){console.error('Anchor failed:',error instanceof Error?error.message:'Unknown error');process.exitCode=1;}
finally{await pool.end();}
