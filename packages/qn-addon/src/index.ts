import { config } from './config';
import { createApp } from './app';
import { initDatabase } from './db/database';

const app = createApp();

initDatabase();

app.listen(config.port, () => {
  console.log(`Fabrknt Data QN Add-On running at http://localhost:${config.port}`);
});
