import { createApp, lakebase, server } from '@databricks/appkit';
import { setupVerdictRoutes } from './routes/lakebase/verdict-routes';

createApp({
  plugins: [
    server({ autoStart: false }),
    lakebase(),
  ],
})
  .then(async (appkit) => {
    await setupVerdictRoutes(appkit);
    await appkit.server.start();
  })
  .catch(console.error);
