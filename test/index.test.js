'use strict';

const mm = require('mm');
const path = require('path');
const osenv = require('osenv');
const assert = require('assert');
const httpclient = require('urllib');
const utils = require('../lib/utils');
const Message = require('../').Message;
const Consumer = require('../').Consumer;
const Producer = require('../').Producer;
const sleep = require('mz-modules/sleep');
const rimraf = require('mz-modules/rimraf');
const config = require('../example/config');
const MixAll = require('../lib/mix_all');

const TOPIC = config.topic;

const localOffsetStoreDir = path.join(osenv.home(), '.rocketmq_offsets_node');

describe('test/index.test.js', () => {
  describe('API', () => {
    let producer;
    let consumer;
    before(async () => {
      producer = new Producer(Object.assign({
        httpclient,
        retryAnotherBrokerWhenNotStoreOK: true,
        compressMsgBodyOverHowmuch: 10,
      }, config));
      await producer.ready();
      consumer = new Consumer(Object.assign({
        httpclient,
        rebalanceInterval: 1000,
        isBroadcast: true,
      }, config));
      await consumer.ready();

      consumer.subscribe(TOPIC, async msg => {
        console.log('message receive ------------> ', msg.body.toString());
      });
    });

    after(async () => {
      await producer.close();
      await consumer.close();
    });

    afterEach(mm.restore);

    // it.skip('it should create topic ok', function*() {
    //   yield producer.createTopic('TBW102', 'XXX', 8);
    // });

    it('should select another broker if one failed', async () => {
      mm(producer, 'sendKernelImpl', async () => {
        mm.restore();
        return {
          sendStatus: 'FLUSH_DISK_TIMEOUT',
        };
      });
      const msg = new Message(TOPIC, // topic
        'TagA', // tag
        'Hello TagA !!! ' // body
      );

      let sendResult = await producer.send(msg);
      assert(sendResult && sendResult.msgId);

      mm(producer, 'sendKernelImpl', async () => {
        mm.restore();
        const err = new Error('mock err');
        err.name = 'MQClientException';
        err.code = 205;
        throw err;
      });
      sendResult = await producer.send(msg);
      assert(sendResult && sendResult.msgId);
    });

    it('should tryToFindTopicPublishInfo if brokerAddr not found', async () => {
      const msg = new Message(TOPIC, // topic
        'TagA', // tag
        'Hello TagA !!! ' // body
      );

      let sendResult = await producer.send(msg);
      assert(sendResult && sendResult.msgId);

      mm(producer._mqClient, 'findBrokerAddressInPublish', () => {
        mm.restore();
        return null;
      });
      sendResult = await producer.send(msg);
      assert(sendResult && sendResult.msgId);

      mm(producer._mqClient, 'findBrokerAddressInPublish', () => {
        return null;
      });

      let isError = false;
      try {
        await producer.send(msg);
      } catch (err) {
        isError = true;
        assert(/The broker\[.+\] not exist/i.test(err.message));
        assert(err.name === 'MQClientException');
      }
      assert(isError);
      mm.restore();

      isError = false;
      try {
        await producer.send(new Message('%RETRY%' + TOPIC, // topic
          'TagA', // tag
          'Hello TagA !!! ' // body
        ));
      } catch (err) {
        isError = true;
        assert(err.name === 'MQClientException');
      }
      assert(isError);
    });

    it('should emit error if compress failed', done => {
      mm(utils, 'compress', function() {
        throw new Error('mock error');
      });

      const msg = new Message(TOPIC, // topic
        'TagA', // tag
        'Hello TagA !!!   sds' // body
      );
      producer.on('error', err => {
        assert(err.name === 'MetaQCompressError');
        done();
      });
      (async () => {
        try {
          const sendResult = await producer.send(msg);
          assert(sendResult && sendResult.msgId);
          console.log('over');
        } catch (err) {
          console.log(err);
        }
      })();
    });

    it('should updateProcessQueueTableInRebalance ok', async () => {
      mm(consumer, 'consumeOrderly', true);
      mm(consumer, 'messageModel', 'CLUSTERING');
      await sleep(3000);
      await consumer.rebalanceByTopic(TOPIC);
      const size = consumer.processQueueTable.size;
      assert(size > 0);

      const key = Array.from(consumer.processQueueTable.keys())[0];
      const obj = consumer.processQueueTable.get(key);
      const processQueue = obj.processQueue;
      processQueue.lastPullTimestamp = 10000;

      await consumer.rebalanceByTopic(TOPIC);
      assert(consumer.processQueueTable.size === size);

      await consumer.updateProcessQueueTableInRebalance(TOPIC, [], true);
      assert(consumer.processQueueTable.size === 0);
      await consumer.updateProcessQueueTableInRebalance(MixAll.getRetryTopic(consumer.consumerGroup), []);
      assert(consumer.processQueueTable.size === 0);
    });

    it('should computePullFromWhere ok', async () => {
      mm(consumer._offsetStore, 'readOffset', async () => {
        return -1;
      });
      mm(consumer, 'consumeFromWhere', 'CONSUME_FROM_LAST_OFFSET');

      let offset = await consumer.computePullFromWhere({
        topic: '%RETRY%__',
      });
      assert(offset === 0);

      mm(consumer, 'consumeFromWhere', 'CONSUME_FROM_TIMESTAMP');
      mm(consumer._mqClient, 'maxOffset', async () => {
        return 1000;
      });
      offset = await consumer.computePullFromWhere({
        topic: '%RETRY%__',
      });
      assert(offset === 1000);

      mm.error(consumer._mqClient, 'maxOffset');
      offset = await consumer.computePullFromWhere({
        topic: '%RETRY%__',
      });
      assert(offset === -1);

      mm(consumer._offsetStore, 'readOffset', async () => {
        return 100;
      });
      offset = await consumer.computePullFromWhere({
        topic: 'TP',
      });
      assert(offset === 100);

      mm(consumer, 'consumeFromWhere', 'CONSUME_FROM_FIRST_OFFSET');
      offset = await consumer.computePullFromWhere({
        topic: 'TP',
      });
      assert(offset === 100);

      mm(consumer, 'consumeFromWhere', 'NOT_EXISTS');
      offset = await consumer.computePullFromWhere({
        topic: 'TP',
      });
      assert(offset === -1);
    });

    it('should support namespace', () => {
      mm(producer, 'namespace', 'xxx');
      mm(consumer, 'namespace', 'xxx');

      assert(consumer.consumerGroup === `xxx%${config.consumerGroup}`);
      assert(producer.producerGroup === `xxx%${config.producerGroup}`);

      assert(consumer.formatTopic(`%RETRY%${consumer.consumerGroup}`) === `%RETRY%${consumer.consumerGroup}`);
      assert(producer.formatTopic('TEST_TOPIC') === 'xxx%TEST_TOPIC');
      assert(consumer.formatTopic('TEST_TOPIC') === 'xxx%TEST_TOPIC');
    });
  });

  // 广播消费
  describe('broadcast', () => {
    [
      'CONSUME_FROM_LAST_OFFSET_AND_FROM_MIN_WHEN_BOOT_FIRST',
      'CONSUME_FROM_MIN_OFFSET',
      'CONSUME_FROM_MAX_OFFSET',
      'CONSUME_FROM_LAST_OFFSET',
      'CONSUME_FROM_FIRST_OFFSET',
      'CONSUME_FROM_TIMESTAMP',
    ].forEach(consumeFromWhere => {
      let consumer;
      let producer;
      describe(`consumeFromWhere => ${consumeFromWhere}`, () => {
        before(() => {
          return rimraf(localOffsetStoreDir);
        });
        before(async () => {
          consumer = new Consumer(Object.assign({
            httpclient,
            consumeFromWhere,
            isBroadcast: true,
            persistent: true,
            rebalanceInterval: 2000,
          }, config));
          producer = new Producer(Object.assign({
            httpclient,
          }, config));

          await consumer.ready();
          await producer.ready();
        });

        after(async () => {
          await producer.close();
          const originFn = consumer._offsetStore.persistAll;
          mm(consumer._offsetStore, 'persistAll', async mqs => {
            assert(mqs && mqs.length);
            return await originFn.call(consumer._offsetStore, mqs);
          });
          await consumer.close();
        });

        afterEach(mm.restore);

        it('should subscribe message ok', async () => {
          let msgId;
          const received = new Set();
          consumer.subscribe(TOPIC, 'TagA', async msg => {
            console.log('message receive ------------> ', msg.msgId, msg.body.toString());
            assert(msg.tags !== 'TagB');
            received.add(msg.msgId);
            if (msgId && received.has(msgId)) {
              assert(msg.body.toString() === 'Hello MetaQ !!! ');
              consumer.emit('TagA');
            }
          });

          await sleep(5000);

          let msg = new Message(TOPIC, // topic
            'TagB', // tag
            'Hello MetaQ !!! ' // body
          );
          let sendResult = await producer.send(msg);
          assert(sendResult && sendResult.msgId);
          msg = new Message(TOPIC, // topic
            'TagA', // tag
            'Hello MetaQ !!! ' // body
          );
          sendResult = await producer.send(msg);
          assert(sendResult && sendResult.msgId);
          msgId = sendResult.msgId;
          console.log('send message success,', sendResult.msgId);

          if (!received.has(msgId)) {
            await consumer.await('TagA');
          }
        });

        it.skip('should viewMessage ok', async () => {
          const msg = new Message(TOPIC, // topic
            'TagA', // tag
            'Hello MetaQ !!! ' // body
          );
          const sendResult = await producer.send(msg);
          assert(sendResult && sendResult.msgId);

          await sleep(3000);

          const message = await consumer.viewMessage(sendResult.msgId);
          assert(message.body.toString() === 'Hello MetaQ !!! ');
        });
      });
    });
  });

  // 集群消费
  describe('cluster', () => {
    let consumer;
    let producer;
    before(async () => {
      consumer = new Consumer(Object.assign({
        httpclient,
        isBroadcast: false,
      }, config));
      await consumer.ready();
      producer = new Producer(Object.assign({
        httpclient,
      }, config));
      await producer.ready();
    });

    after(async () => {
      await consumer.close();
      await producer.close();
    });

    afterEach(mm.restore);

    it('should subscribe message ok', async () => {
      await sleep(3000);

      const msg = new Message(TOPIC, // topic
        'TagA', // tag
        'Hello MetaQ !!! ' // body
      );
      const sendResult = await producer.send(msg);
      assert(sendResult && sendResult.msgId);

      const msgId = sendResult.msgId;
      console.log(sendResult);

      await new Promise(r => {
        consumer.subscribe(TOPIC, '*', async msg => {
          if (msg.msgId === msgId) {
            assert(msg.body.toString() === 'Hello MetaQ !!! ');
            r();
          }
        });
      });
    });
  });

  describe('process exception', () => {
    let consumer;
    let producer;
    const logger = {
      info() {},
      warn() {},
      error(...args) {
        console.error(...args);
      },
      debug() {},
    };
    beforeEach(async () => {
      consumer = new Consumer(Object.assign({
        httpclient,
        logger,
        rebalanceInterval: 2000,
        maxReconsumeTimes: 2,
      }, config));
      producer = new Producer(Object.assign({
        httpclient,
        logger,
      }, config));
      await consumer.ready();
      await producer.ready();
    });

    afterEach(async () => {
      await producer.close();
      await consumer.close();
    });

    it('should not correctTags if process queue not empty', () => {
      let done = false;
      mm(consumer._offsetStore, 'updateOffset', () => {
        done = true;
      });
      consumer.correctTagsOffset({
        processQueue: {
          msgCount: 0,
        },
      });
      assert(done);
      done = true;
      mm.restore();
      mm(consumer._offsetStore, 'updateOffset', () => {
        done = false;
      });
      consumer.correctTagsOffset({
        processQueue: {
          msgCount: 1,
        },
      });
      assert(done);
      mm.restore();
    });

    it('should retry(consume later) if process failed', async () => {
      let msgId;
      consumer.subscribe(TOPIC, '*', async msg => {
        console.warn('message receive ------------> ', msg.body.toString());
        if (msg.msgId === msgId || msg.originMessageId === msgId) {
          assert(msg.body.toString() === 'Hello MetaQ !!! ');
          if (msg.reconsumeTimes === 0) {
            throw new Error('mock error');
          }
          consumer.emit('*');
        }
      });

      await sleep(5000);

      const msg = new Message(TOPIC, // topic
        'TagA', // tag
        'Hello MetaQ !!! ' // body
      );
      const sendResult = await producer.send(msg);
      assert(sendResult && sendResult.msgId);
      msgId = sendResult.msgId;
      await consumer.await('*');
    });

    it('broker should drop message if reconsumeTimes gt maxReconsumeTimes', async () => {
      let msgId;
      let reconsumeTimes = 0;

      const randomNumber = Math.floor(Math.random() * 100) + 1;

      const msgBody = 'Hello MetaQ !!!' + randomNumber;

      consumer.subscribe(TOPIC, '*', async msg => {
        console.warn('message receive ------------> ', msg.body.toString(), msg.reconsumeTimes);
        if (msg.msgId === msgId || msg.originMessageId && (msg.originMessageId === msgId)) {
          assert(msg.body.toString() === msgBody);
          reconsumeTimes = msg.reconsumeTimes;
          throw new Error('mock error');
        }
      });

      await sleep(5000);

      const msg = new Message(TOPIC, // topic
        'TagA', // tag
        msgBody // body
      );
      const sendResult = await producer.send(msg);
      assert(sendResult && sendResult.msgId);
      msgId = sendResult.msgId;

      await sleep(60000);

      assert(reconsumeTimes === 2);
    });

    it('should retry(retry message) if process failed', async () => {
      let msgId;
      mm(consumer._mqClient, 'consumerSendMessageBack', async () => {
        throw new Error('mock error');
      });
      consumer.subscribe(TOPIC, '*', async msg => {
        console.warn('message receive ------------> ', msg.msgId, msg.originMessageId, msg.body.toString());
        if (msg.msgId === msgId || msg.originMessageId === msgId) {
          assert(msg.body.toString() === 'Hello MetaQ !!! ');
          if (msg.reconsumeTimes === 0) {
            throw new Error('mock error');
          }
          consumer.emit('*');
        }
      });

      await sleep(5000);

      const msg = new Message(TOPIC, // topic
        'TagA', // tag
        'Hello MetaQ !!! ' // body
      );
      const sendResult = await producer.send(msg);
      assert(sendResult && sendResult.msgId);
      msgId = sendResult.msgId;

      console.log('msgId -->', msgId);
      await consumer.await('*');
    });

    it('should retry(fall to local) if process failed', async () => {
      let msgId;
      mm(consumer, 'sendMessageBack', async () => {
        throw new Error('mock error');
      });
      consumer.subscribe(TOPIC, '*', async msg => {
        console.warn('message receive ------------> ', msg.body.toString());
        if (msg.msgId === msgId) {
          assert(msg.body.toString() === 'Hello MetaQ !!! ');
          if (msg.reconsumeTimes === 0) {
            throw new Error('mock error');
          }
          consumer.emit('*');
        }
      });

      await sleep(5000);

      const msg = new Message(TOPIC, // topic
        'TagA', // tag
        'Hello MetaQ !!! ' // body
      );
      const sendResult = await producer.send(msg);
      assert(sendResult && sendResult.msgId);
      msgId = sendResult.msgId;
      await consumer.await('*');
    });
  });

  describe('flow control', () => {
    let consumer;
    let producer;
    before(async () => {
      await rimraf(localOffsetStoreDir);
      consumer = new Consumer(Object.assign({
        httpclient,
        isBroadcast: true,
        rebalanceInterval: 2000,
        pullThresholdForQueue: 1,
        consumeFromWhere: 'CONSUME_FROM_FIRST_OFFSET',
        pullTimeDelayMillsWhenFlowControl: 5000,
      }, config));
      producer = new Producer(Object.assign({
        httpclient,
      }, config));
      await consumer.ready();
      await producer.ready();
    });

    after(async () => {
      await producer.close();
      await consumer.close();
    });

    it('should retry if process failed', async () => {
      let count = 20;
      while (count--) {
        const msg = new Message(TOPIC, // topic
          'TagA', // tag
          'Hello MetaQ !!! ' // body
        );
        const sendResult = await producer.send(msg);
        assert(sendResult && sendResult.msgId);
      }

      consumer.subscribe(TOPIC, '*', async (msg, mq, pq) => {
        console.log('message receive ------------> ', msg.body.toString());

        const msgCount = pq.msgCount;
        await sleep(10000);

        // 不再拉取
        try {
          console.info('----------------> origin msgCount %d, current msgCount %d', msgCount, pq.msgCount);
          assert(msgCount === 1 || pq.msgCount === msgCount);
          consumer.emit('over');
        } catch (err) {
          consumer.emit('error', err);
        }
      });

      await Promise.race([
        consumer.await('over'),
        consumer.await('error'),
      ]);
    });
  });

  describe('delay consume message', () => {
    let producer;
    let consumer;
    let consumeTime = 0;
    // 允许的误差时间
    const deviationTime = 4000;

    before(async () => {
      producer = new Producer(Object.assign({
        httpclient,
      }, config));
      await producer.ready();
      consumer = new Consumer(Object.assign({
        httpclient,
      }, config));
      await consumer.ready();
    });

    after(async () => {
      await producer.close();
      await consumer.close();
    });

    it.skip('should receive message with specified time', async () => {
      const delayTime = 10000;

      const body = 'hello delay message at ' + Date.now();
      const msg = new Message(config.topic, 'TagDelay', body);
      const produceTime = Date.now();
      msg.setStartDeliverTime(produceTime + delayTime);
      const result = await producer.send(msg);
      console.log(result);

      consumer.subscribe(config.topic, 'TagDelay', async msg => {
        console.log('message receive ------------> ', msg.msgId, msg.body.toString());
        if (body === msg.body.toString()) {
          consumeTime = Date.now();
          consumer.emit('consumed');
        }
      });

      await consumer.await('consumed');
      assert(consumeTime - produceTime <= delayTime + deviationTime && consumeTime - produceTime >= delayTime - deviationTime);
    });
  });

  // 顺序消息
  describe('order message', () => {
    let consumer;
    let producer;
    beforeEach(async () => {
      consumer = new Consumer(Object.assign({
        httpclient,
        isBroadcast: false,
        consumeOrderly: true,
        maxReconsumeTimes: 2,
      }, config));
      await consumer.ready();
      producer = new Producer(Object.assign({
        httpclient,
      }, config));
      await producer.ready();
    });

    afterEach(async () => {
      await consumer.close();
      await producer.close();
      mm.restore();
    });

    it('msgs should be in same queue and follow order', async () => {
      await sleep(3000);

      const msg = new Message(TOPIC, // topic
        'TagC', // tag
        'Hello MetaQ !!! ' // body
      );
      const selector = Math.random().toString();
      const sendResult = await producer.send(msg, selector);
      assert(sendResult && sendResult.msgId);
      const sendResult_2 = await producer.send(msg, selector);
      assert(sendResult_2 && sendResult_2.msgId);
      assert(sendResult.messageQueue.key === sendResult_2.messageQueue.key);

      console.log(sendResult, sendResult_2, '2 results');
      let queueId = null;
      await new Promise(r => {
        consumer.subscribe(TOPIC, 'TagC', async msg => {
          if (queueId === null) { // first msg
            queueId = msg.queueId;
          }
          if (queueId !== null) { // 2nd msg
            console.log(msg.queueId);
            assert(msg.queueId === queueId); // 2 msgs have same queueId
            r();
          }
        });
      });
    });

    // 顺序消息消费失败
    it('failed msg should be dropped', async () => {
      await sleep(3000);

      const msg = new Message(TOPIC, // topic
        'TagC', // tag
        'Hello MetaQ !!! ' // body
      );
      const msg_2 = new Message(TOPIC, // topic
        'TagC', // tag
        'Hello MetaQ !!! 2nd' // body
      );
      const selector = Math.random().toString();
      const sendResult = await producer.send(msg, selector);
      assert(sendResult && sendResult.msgId);
      const sendResult_2 = await producer.send(msg_2, selector);
      assert(sendResult_2 && sendResult_2.msgId);

      console.log(sendResult, sendResult_2, '2 results');
      let queueId = null;
      await new Promise(r => {
        consumer.subscribe(TOPIC, 'TagC', async msg => {
          if (msg.body.toString() === 'Hello MetaQ !!! ') { // first msg
            queueId = msg.queueId;
            throw Error('msg processing failed');
          }
          if (queueId !== null) { // 2nd msg
            console.warn('message receive ------------> ', msg.body.toString());
            if (msg.msgId === sendResult_2.msgId) {
              assert(msg.body.toString() === 'Hello MetaQ !!! 2nd');
              r();
            }
          }
        });
      });
    });
  });

  // 顺序消息,锁失效逻辑
  describe('order message & lock expired', () => {
    let consumer;
    let producer;
    beforeEach(async () => {
      consumer = new Consumer(Object.assign({
        httpclient,
        isBroadcast: false,
        consumeOrderly: true,
      }, config));
      mm(consumer, 'lockAll', () => {
        return;
      });
      await consumer.ready();
      producer = new Producer(Object.assign({
        httpclient,
      }, config));
      await producer.ready();
    });

    afterEach(async () => {
      await consumer.close();
      await producer.close();
      mm.restore();
    });

    it('should relock when lock expired', async () => {
      await sleep(3000);

      const msg = new Message(TOPIC, // topic
        'TagD', // tag
        'Hello MetaQ !!! ' // body
      );
      const selector = Math.random().toString();
      const sendResult = await producer.send(msg, selector);
      assert(sendResult && sendResult.msgId);
      const sendResult_2 = await producer.send(msg, selector);
      assert(sendResult_2 && sendResult_2.msgId);

      console.log(sendResult, sendResult_2, '2 results');
      let queueId = null;
      await new Promise(r => {
        consumer.subscribe(TOPIC, 'TagD', async msg => {
          // parallelConsumeLimit为1的时候，第一条消息拖到锁失效
          if (queueId === null) { // first msg
            console.log('sleep until lock expired');
            await sleep(30000);
          }
          if (queueId !== null) {
            console.log(msg.queueId);
            assert(msg.queueId === queueId);
            r();
          }
          queueId = msg.queueId;
        });
      });
    });
  });
});
