/* Shared browser-check helper: records which dedicated Workers a page creates
 * and when each one is terminated, so a cancellation check can prove which
 * code path it exercised instead of inferring it from the status text alone.
 * Observation only; application behaviour is unchanged. */
'use strict';
function install() {
  const Native = window.Worker, log = window.__workerProbe = [];
  window.Worker = class extends Native {
    constructor(url, options) {
      super(url, options);
      const entry = {url: String(url), posted: 0, progress: 0, results: 0, terminated: false, progress_at_terminate: null, results_at_terminate: null, results_after_terminate: 0};
      this.__probe = entry; log.push(entry);
      this.addEventListener('message', event => {
        if (entry.terminated) entry.results_after_terminate++;
        if (event.data && event.data.progress) entry.progress++; else entry.results++;
      });
    }
    postMessage(...args) { this.__probe.posted++; return super.postMessage(...args); }
    terminate() {
      const entry = this.__probe;
      if (!entry.terminated) { entry.terminated = true; entry.progress_at_terminate = entry.progress; entry.results_at_terminate = entry.results; }
      return super.terminate();
    }
  };
}
const attach = page => page.addInitScript(install);
const count = page => page.evaluate(() => window.__workerProbe.length);
const since = (page, index, pattern) => page.evaluate(([i, p]) => window.__workerProbe.slice(i).filter(e => e.url.includes(p)), [index, pattern]);
/* Resolves once a matching Worker created after `index` has received its job
 * and, when `progress` is requested, has reported that it is actually running. */
const waitForRunning = (page, index, pattern, {progress = false, timeout = 60000} = {}) => page.waitForFunction(
  ([i, p, needProgress]) => window.__workerProbe.slice(i).some(e => e.url.includes(p) && e.posted > 0 && (!needProgress || e.progress > 0)),
  [index, pattern, progress], {timeout, polling: 5});
module.exports = {attach, count, since, waitForRunning};
