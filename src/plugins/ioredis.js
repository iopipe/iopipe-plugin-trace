import { debuglog } from 'util';
import shimmer from 'shimmer';
import Redis from 'ioredis';
import Perf from 'performance-node';
import uuid from 'uuid/v4';

const debug = debuglog('@iopipe/trace');

/*eslint-disable babel/no-invalid-this*/
/*eslint-disable func-name-matching */
/*eslint-disable prefer-rest-params */

const createId = () => `redis-${uuid()}`;

const filterRequest = (command, context) => {
  const { name, args } = command;
  let hostname, port, connectionName;
  if (context && context.options) {
    hostname = context.options.host;
    port = context.options.port;
    connectionName = context.options.connectionName;
  }

  return {
    command: name,
    key: args[0] ? args[0] : null,
    hostname,
    port,
    connectionName
  };
};

function wrap({ timeline, data = {} } = {}) {
  if (!(timeline instanceof Perf)) {
    debug(
      'Timeline passed to shimmerRedis.wrap not an instance of performance-node. Skipping.'
    );
    return false;
  }

  if (!Redis.__iopipeShimmer) {
    //Redis.Command &&
    shimmer.wrap(
      Redis.Command.prototype,
      'initPromise',
      wrapPromise
    );
    shimmer.wrap(Redis.prototype, 'sendCommand', wrapSendCommand);

    Redis.__iopipeShimmer = true;
  }

  return true;

  function wrapPromise(original) {
    return function wrappedPromise() {
      const command = this;
      const cb = this.callback;
      const id = createId();
      const { name } = command;
      data[id] = {
        name,
        dbType: 'Redis',
        request: filterRequest(command)
      };

      if (typeof cb === 'function' && !cb.__iopipeTraceId) {
        timeline.mark(`start:${id}`);
        this.callback = function wrappedCallback(err, response) {

          if (err) {
            data[id].error = err.message;
            data[id].errorStack = err.stack;
          }

          timeline.mark(`end:${id}`);
          return cb.apply(this, arguments);
        };
        this.callback.__iopipeTraceId = id;
      }
      return original.apply(this, arguments);
    };
  }
  function wrapSendCommand(original) {
    return function wrappedSendCommand(command) {
      const context = this;
      const id = createId();
      const { name } = command;

      data[id] = {
        name,
        dbType: 'Redis',
        request: filterRequest(command, context)
      };

      timeline.mark(`start:${id}`);

      if (typeof command.resolve === 'function') {
        this.resolve = function wrapResolve(response) {
          data[id].response = response;
          return command.resolve;
        };
        this.resolve.__iopipeTraceId = id;
      }
      if (typeof command.reject === 'function') {
        this.reject = function wrapReject(err) {
          data[id].error = err.message;
          data[id].errorStack = err.stack;
          return command.reject;
        };
        this.reject.__iopipeTraceId = id;
      }
      if (command.promise) {
        const endMark = () => {
          timeline.mark(`end:${id}`);
        };

        this.promise = command.promise;
        this.promise.__iopipeTraceId = id;

        if (typeof command.promise.finally === 'function') {
          // Bluebird and Node.js 10+
          this.promise.finally(endMark);
        } else if (typeof command.promise.then === 'function') {
          this.promise.then(endMark).catch(endMark);
        }
      }

      return original.apply(this, arguments);
    };
  }
}

function unwrap() {
  shimmer.unwrap(Redis.Command.prototype, 'initPromise');
  shimmer.unwrap(Redis.prototype, 'sendCommand');
  delete Redis.__iopipeShimmer;
}

export { unwrap, wrap };
