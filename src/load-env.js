import path from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';

// Real environment variables win, then ./.env, then the .env one folder above
// the project, so a single shared .env can sit next to the cloned folder.
const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(projectRoot, '.env'), quiet: true });
dotenv.config({ path: path.join(projectRoot, '..', '.env'), quiet: true });
