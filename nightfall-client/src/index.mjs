import config from 'config';
import logger from 'common-files/utils/logger.mjs';
import mongo from 'common-files/utils/mongo.mjs';
import { queueManager } from 'common-files/utils/event-queue.mjs';
import app from './app.mjs';
import rabbitmq from './utils/rabbitmq.mjs';
import queues from './queues/index.mjs';
import { initialClientSync } from './services/state-sync.mjs';
import { startEventQueue, eventHandlers } from './event-handlers/index.mjs';

const main = async () => {
  try {
    if (process.env.ENABLE_QUEUE) {
      await rabbitmq.connect();
      queues();
    }
    await initialClientSync();
    await startEventQueue(queueManager, eventHandlers);

    app.get('/healthcheck', (req, res) => res.sendStatus(200));

    await mongo.connection(config.MONGO_URL); // get a db connection
    app.listen(80);
  } catch (err) {
    logger.error(err);
    process.exit(1);
  }
};

main();
