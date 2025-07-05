const Redis = require('ioredis');
const logger = require('./logger'); // Assuming logger.js is in the same directory or proper path

const redisConfig = {
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: parseInt(process.env.REDIS_PORT, 10) || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
  db: parseInt(process.env.REDIS_DB, 10) || 0,
  maxRetriesPerRequest: process.env.REDIS_MAX_RETRIES ? parseInt(process.env.REDIS_MAX_RETRIES, 10) : 3,
  retryStrategy(times) {
    const delay = Math.min(times * 50, 2000); // Exponential backoff
    logger.warn({ attempt: times, delay }, 'Redis: Reconnecting...');
    return delay;
  },
};

let client;
let subscriberClient; // Separate client for blocking operations like XREAD

async function connect() {
  if (client && client.status === 'ready') {
    return client;
  }
  if (client && client.status === 'connecting') {
    // If already connecting, wait for it to complete
    return new Promise((resolve, reject) => {
      client.once('ready', () => resolve(client));
      client.once('error', (err) => reject(err)); // Error during this specific connection attempt
    });
  }

  logger.info(redisConfig, 'Redis: Attempting to connect with config.');
  client = new Redis(redisConfig);

  return new Promise((resolve, reject) => {
    client.once('ready', () => {
      logger.info('Redis: Main client connected successfully.');
      resolve(client);
    });
    client.on('error', (err) => { // General error handler for the client's lifetime
      logger.error({ err }, 'Redis: Main client connection error.');
      // For initial connection, reject the promise. For ongoing errors, it will attempt to reconnect.
      if (client && client.status !== 'ready') { // Check if it's an initial connection error
          reject(err);
      }
    });
    client.on('close', () => logger.info('Redis: Main client connection closed.'));
    // 'reconnecting' is handled by retryStrategy
  });
}

async function getSubscriberClient() {
    if (subscriberClient && subscriberClient.status === 'ready') {
        return subscriberClient;
    }
    if (subscriberClient && subscriberClient.status === 'connecting') {
        return new Promise((resolve, reject) => {
            subscriberClient.once('ready', () => resolve(subscriberClient));
            subscriberClient.once('error', (err) => reject(err));
        });
    }
    logger.info(redisConfig, 'Redis: Attempting to connect subscriber client.');
    subscriberClient = new Redis(redisConfig); // Uses the same config

    return new Promise((resolve, reject) => {
        subscriberClient.once('ready', () => {
            logger.info('Redis: Subscriber client connected successfully.');
            resolve(subscriberClient);
        });
        subscriberClient.on('error', (err) => {
            logger.error({ err }, 'Redis: Subscriber client connection error.');
             if (subscriberClient && subscriberClient.status !== 'ready') {
                reject(err);
            }
        });
        subscriberClient.on('close', () => logger.info('Redis: Subscriber client connection closed.'));
    });
}


async function get(key) {
  if (!client || client.status !== 'ready') await connect();
  return client.get(key);
}

async function set(key, value, mode, duration) {
  if (!client || client.status !== 'ready') await connect();
  if (mode && duration) {
    return client.set(key, value, mode, duration);
  }
  return client.set(key, value);
}

async function del(key) {
  if (!client || client.status !== 'ready') await connect();
  return client.del(key);
}

async function lpush(key, value) {
    if (!client || client.status !== 'ready') await connect();
    return client.lpush(key, value);
}

async function rpop(key) {
    if (!client || client.status !== 'ready') await connect();
    return client.rpop(key);
}

async function xadd(streamKey, id, ...args) {
    if (!client || client.status !== 'ready') await connect();
    // args should be field-value pairs, e.g., ['field1', 'value1', 'field2', 'value2']
    return client.xadd(streamKey, id, ...args);
}

async function xreadgroup(groupName, consumerName, streams, blockMs = 0, count = 1) {
    const subClient = await getSubscriberClient(); // Use separate client for blocking
    const commandArgs = ['GROUP', groupName, consumerName, 'COUNT', count];
    if (blockMs > 0) {
        commandArgs.push('BLOCK', blockMs);
    }
    commandArgs.push('STREAMS', ...streams); // streams is an array like [streamKey, idToReadFrom]
    // Example: streams = ['mystream', '>'] for new messages
    // Example: streams = ['mystream', '0'] for all pending messages for this consumer if group exists
    return subClient.xreadgroup(...commandArgs);
}

async function xack(streamKey, groupName, ...messageIds) {
    if (!client || client.status !== 'ready') await connect();
    return client.xack(streamKey, groupName, ...messageIds);
}

async function xgroupCreate(streamKey, groupName, id = '$', mkstream = false) {
    if (!client || client.status !== 'ready') await connect();
    const args = [streamKey, groupName, id];
    if (mkstream) {
        args.push('MKSTREAM');
    }
    try {
        await client.xgroup('CREATE', ...args);
        logger.info({ streamKey, groupName }, `Redis: Consumer group created (or already exists and $ was used).`);
        return true;
    } catch (error) {
        if (error.message.includes('BUSYGROUP')) {
            logger.warn({ streamKey, groupName }, `Redis: Consumer group already exists.`);
            return true; // Group already exists, which is fine.
        }
        logger.error({ err: error, streamKey, groupName }, `Redis: Error creating consumer group.`);
        throw error;
    }
}


async function quit() {
  if (client) {
    try {
      await client.quit();
      logger.info('Redis: Main client disconnected.');
    } catch(e) {
      logger.error({err: e}, "Redis: Error quitting main client");
    }
    client = null;
  }
  if (subscriberClient) {
    try {
      await subscriberClient.quit();
      logger.info('Redis: Subscriber client disconnected.');
    } catch(e) {
      logger.error({err: e}, "Redis: Error quitting subscriber client");
    }
    subscriberClient = null;
  }
}

module.exports = {
  connect,
  getSubscriberClient, // For direct use if needed elsewhere for subscriptions
  get,
  set,
  del,
  lpush,
  rpop,
  xadd,
  xreadgroup,
  xack,
  xgroupCreate,
  quit,
  getClient: () => client,
};
