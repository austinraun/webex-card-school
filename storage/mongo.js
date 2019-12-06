/*
 * mogo.js
 * 
 * This module implments a storage interface for bots built using
 * the webex-node-botkit-framework.  Data is stored in a mongo
 * database, but also stored locally in the bot object for fast
 * syncronous lookups.  Writes lazily update the database
 * 
 * TODO Look at adding this officially to the framework itself
 */
const when = require('when');
var _ = require('lodash');

var mongo_client = require('mongodb').MongoClient;
var mConfig = {};
if ((process.env.MONGO_USER) && (process.env.MONGO_PW) &&
  (process.env.MONGO_URL) && (process.env.MONGO_DB)) {
  mConfig.mongoUser = process.env.MONGO_USER;
  mConfig.mongoPass = process.env.MONGO_PW;
  mConfig.mongoUrl = process.env.MONGO_URL;
  mConfig.mongoDb = process.env.MONGO_DB;
  mConfig.mongoCollectionName = process.env.MONGO_BOT_STORE;
}
var mongoUri = 'mongodb://' + mConfig.mongoUser + ':' + mConfig.mongoPass + '@' + mConfig.mongoUrl + mConfig.mongoDb + '?ssl=true&replicaSet=Cluster0-shard-0&authSource=admin';
// Incomplete attempt to add new mongo account  -- TODO someday
//const uri = "mongodb+srv://cardSchool_db:<password>@cluster0-atcmc.mongodb.net/test?retryWrites=true&w=majority";
//var mongoUri = 'mongodb+srv://' + mConfig.mongoUser + ':' + mConfig.mongoPass + '@' + mConfig.mongoUrl + mConfig.mongoDb + '?ssl=true&replicaSet=Cluster0-shard-0&authSource=admin';


class MongoStore {
  constructor(logger, defaultConfig) {
    this.botStoreCollection = {};
    this.logger = logger;
    this.defaultConfig = defaultConfig;
    // TODO -- latest mongo version syntax has changed.   Figure out how/if to upgrade
    mongo_client.connect(mongoUri)
      .then((db) => {
        this.db = db;
        return db.collection(mConfig.mongoCollectionName);
      })
      .then((collection) => {
        this.botStoreCollection = collection;
      })
      .catch((e) => this.logger.error('Error connecting to Mongo ' + e.message));
  }

  /**
   * Called when a bot is spawned, this function reads in the exisitng
   * bot configuration from the DB or creates the default one
   *
   *
   * @function
   * @param {object} bot - bot that is storing the data
   * @param {boolean} frameworkInitialized - false during framework startup
   * @param {array} metricsCollections - an array of collection names that could be used in subsequent storeMetrics calls
   * @returns {(Promise.<Object>} - bot's stored config data
   */
  async onSpawn(bot, frameworkInitialized, metricsCollections) {
    let spaceId = bot.room.id;
    let spaceName = bot.room.title;
    // Make sure any requested metrics collections (db tables) are available
    if ((typeof metricsCollections === 'object') && (metricsCollections.length)) {
      for (let collectionName of metricsCollections) {
        if (!this[collectionName]) {
          // promise .then is throwing an error  Trying a callback
          // this.db.collection(collectionName)
          //   .then((collection) => {
          //     this[collectionName] = collection;
          //   })
          //   .catch((e) => this.logger.error(`Failed initializing metrics DB Table: ${collectionName}: ${e.message}\n.  No metrics will be stored!`));
          let that = this;
          this.db.collection(collectionName, {}, function (err, collection) {
            if (err) {
              that.logger.error(`Failed initializing metrics DB Table: ${collectionName}: ${e.message}\n.  No metrics will be stored!`);
            } else {
              that[collectionName] = collection;
            }
          });
        }
      }
    }
    if (this.botStoreCollection) {
      if (!frameworkInitialized) {
        // Look for an existing storeConfig in the DB
        return this.botStoreCollection.findOne({ '_id': spaceId })
          .then((reply) => {
            if (reply !== null) {
              this.logger.verbose(`Found storeConfig for existing space: "${spaceName}"`);
              bot.storeConfig = reply;
              return when(reply);
            } else {
              this.logger.warn(`Did not find storeConfig for existing space: "${spaceName}", will create one`);
              return this.createDefaultConfig(bot);
            }
          })
          .catch((e) => {
            this.logger.error(`Failed to contact DB on bot spawn for space "${spaceName}": ${e.message}.  Using default config`);
            return this.createDefaultConfig(bot);
          });
      } else {
        // Start with the default config when our bot is added to a new space
        return this.createDefaultConfig(bot);
      }
    } else {
      this.logger.warn(`No DB will use default config for "${spaceName}".  Settings will not persist across restarts.`);
      bot.storeConfig = this.defaultConfig;
      return when(this.defaultConfig);
    }
  };

  createDefaultConfig(bot) {
    let defaultConfig = JSON.parse(JSON.stringify(this.defaultConfig));
    defaultConfig._id = bot.room.id;
    bot.storeConfig = defaultConfig;
    return this.botStoreCollection.update(defaultConfig, { upsert: true, w: 1 })
      .catch((e) => {
        this.logger.error(`Failed to store default config for space "${bot.room.title}": ${e.message}`);
        return when(defaultConfig);
      });
  };

  /**
   * Store key/value data.
   *
   * This method is exposed as mongoStore.store(bot, key, value);
   *
   * @function
   * @param {object} bot - bot that is storing the data
   * @param {String} key - Key under id object
   * @param {(String|Number|Boolean|Array|Object)} value - Value of key
   * @returns {(Promise.<String>|Promise.<Number>|Promise.<Boolean>|Promise.<Array>|Promise.<Object>)}
   */
  store(bot, key, value) {
    if ((!bot) || (!('storeConfig' in bot))) {
      let msg = `Failed to store {${key}: ${value}}.  Invalid bot object.`;
      this.logger.error(msg);
      return when.reject(new Error(msg));
    }
    if (key) {
      if ((typeof value === 'number') || (value)) {
        bot.storeConfig[key] = value;
      } else {
        bot.storeConfig[key] = '';
      }
      return this.botStoreCollection.updateOne(
        { _id: bot.storeConfig._id }, bot.storeConfig, { upsert: true, w: 1 })
        .catch((e) => {
          this.logger.error(`Failed DB storeConfig update "${bot.room.title}": ${e.message}`);
          return when(bot.storeConfig);
        });
    }
    return when.reject(new Error('invalid args'));
  };

  /**
 * Recall value of data stored by 'key'.
 *
 * This method is exposed as mongoStore.recall(bot, key);
 * It returns syncronously and does not return a promise.
 *
 * @function
 * @param {Object} bot - Bot to get key for
 * @param {String} [key] - Key under id object (optional). If key is not passed, all keys for id are returned as an object.
 * @returns {(String|Number|Boolean|Array|Object)}
 */
  recall(bot, key) {
    if ((typeof bot !== 'object') || (!('storeConfig' in bot))) {
      let msg = `Failed to store {${key}: ${value}}.  Invalid bot object.`;
      this.logger.error(msg);
      return null;
    }
    if (key) {
      if (key in bot.storeConfig) {
        return (bot.storeConfig[key]);
      } else {
        this.logger.warn(`Failed to find ${key} in recall() for space "${bot.room.title}"`);
        return null;
      }
    } else {
      return bot.storeConfig;
    }
  };

  /**
   * Forget a key or entire store.
   *
   * This method is exposed as mongoStore.forget(bot, key);
   *
   * @function
   * @param {Object} bot - Bot to remove key from
   * @param {String} [key] - Key to forget (optional). If key is not passed, all stored configs are removed.
   * @returns {(Promise.<String>|Promise.<Number>|Promise.<Boolean>|Promise.<Array>|Promise.<Object>)}
   */
  forget(bot, key) {
    if ((!bot) || (!('storeConfig' in bot))) {
      let msg = `Failed to forget ${key}.  Invalid bot object.`;
      this.logger.error(msg);
      return when.reject(new Error(msg));
    }
    if (key) {
      if (key in bot.storeConfig) {
        delete bot.storeConfig[key];
      } else {
        this.logger.warn(`Failed to find ${key} in forget() for space "${bot.room.title}"`);
        return when(null);
      }
    } else {
      bot.storeConfig = {};
      bot.storeConfig._id = bot.room.id;
    }
    return this.botStoreCollection.updateOne(
      { _id: bot.storeConfig._id }, bot.storeConfig, { upsert: true, w: 1 })
      .catch((e) => {
        this.logger.error(`Failed DB storeConfig update "${bot.room.title}": ${e.message}`);
        return when(bot.storeConfig);
      });
  };

  /**
   * Write a metrics object to the database
   *
   * This method is exposed as mongoStore.writeMetric(table, object);
   *
   * @function
   * @param {string} table - name of metrics table to write to
   * @param {string} event - value for the event field
   * @param {object} bot - bot that is writing the metric
   * @param {object|string} actor - user that triggered the metric activity
   * @param {object|string} card - card object (only if event is cardRendered)
   * @param {object|string} trigger - trigger (only if event is cardRendered)
   * @returns {(Promise.<Object>}
   */
  async writeMetric(table, event, bot, actor, card, trigger) {
    if (!this[table]) {
      this.logger.error(`Unable to access metrics table:${table}.  Metric data for ${event} is lost.`);
      return when({});
    }
    if ((typeof bot !== 'object') || (!('room' in bot))) {
      this.logger.error(`Invalid bot object passed to writeMetric() call.  Metric data for ${event} is lost.`);
      this.logger.verbose(event);
    }
    // May want to add switch of validation logic based on known event types
    // botAddedToSpace
    // botRemovedFromSpace

    //TODO do I want to add any indices to this?
    let data = {
      event: event,
      botName: bot.person.displayName,
      spaceId: bot.room.id,
      spaceName: bot.room.title,
      spaceType: bot.room.type,
      date: new Date().toISOString(),
    };
    data._id = `${bot.room.id}_${data.date}`;


    // If we have actor info add that to the data
    let actorPerson = null;
    if (actor) {
      try {
        if (typeof actor === 'string') {
          actorPerson = await bot.webex.people.get(actor);
        } else {
          actorPerson = actor;
        }
        data.actorEmail = actorPerson.emails[0];
        data.actorDisplayName = actorPerson.displayName;
        data.actorDomain = _.split(_.toLower(data.actorEmail), '@', 2)[1];
        data.actorOrgId = actorPerson.orgId;
      } catch (e) {
        this.logger.warn(`Unable to get actor info for ${event}: ${e.message}.  Will write metric without it.`);
      }
    }

    // If this is a cardRender, capture card details
    if ((event === 'cardRendered') || (event === 'feedbackProvided')) {
      if (card) {
        try {
          data.cardName = card.lessonInfo.title;
          data.cardIndex = card.lessonInfo.index;
          data.previousLesson = card.lessons[parseInt(bot.framework.mongoStore.recall(bot, 'previousLessonIndex'))].title;
          if (trigger) {
            if (event === 'cardRendered') {
              if (trigger.type != 'attachmentAction') {
                data.requestedVia = `Message to Bot: ${trigger.message.text}`;
              } else {
                let inputs = trigger.attachmentAction.inputs;
                if (inputs.nextLesson) {
                  data.requestedVia = 'Next Lesson Button';
                } else if (inputs.pickAnotherLesson) {
                  data.requestedVia = 'Pick Another Lesson Button';
                } else {
                  data.requestedVia = 'Unknown';
                }
              }
            }
          } else {
            this.logger.warn(`Unable to get trigger info for ${event}.  Will write metric without it.`);
          }
          // If this is a feedbakcProvided, capture feedback
          if (event === 'feedbackProvided') {
            data.feedback = trigger.attachmentAction.inputs.feedback;
          }
        } catch (e) {
          this.logger.warn(`Error getting card info for ${event}: ${e.message}.  Will write metric with what we have.`);

        }
      } else {
        this.logger.warn(`Unable to get card info for ${event}.  Will write metric without it.`);
      }
    }

    return this[table].insertOne(data)
      .catch((e) => {
        this.logger.error(`Failed writing metric to table:${table}: ${e.message}.  Metric data is lost`);
        this.logger.verbose(JSON.stringify(data));
        return when({});
      });
  };

};

module.exports = MongoStore;
