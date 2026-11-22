/**
 * jsdom does not implement the Fetch API classes that React Router's data
 * router uses for navigations. Expose Node's native implementations.
 */
const { TestEnvironment } = require('jest-environment-jsdom');

class JsdomWithFetch extends TestEnvironment {
  async setup() {
    await super.setup();
    for (const name of [
      'Request',
      'Response',
      'Headers',
      'FormData',
      'TextEncoder',
      'TextDecoder',
      'ReadableStream',
    ]) {
      if (this.global[name] === undefined && globalThis[name] !== undefined)
        this.global[name] = globalThis[name];
    }
    // Node's Request only accepts Node's AbortSignal, so both must come from the same realm.
    this.global.AbortController = globalThis.AbortController;
    this.global.AbortSignal = globalThis.AbortSignal;
  }
}

module.exports = JsdomWithFetch;
