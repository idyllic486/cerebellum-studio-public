'use strict';
importScripts('./methods_core.js', './sensitivity_core.js', './benchmark_core.js');
self.onmessage = ({data}) => {
  try {
    const result = data.mode === 'sensitivity' ? SensitivityCore.run(data.study, data.options)
      : data.mode === 'strategies' ? BenchmarkCore.strategies(data.study, data.options)
      : data.mode === 'synthetic' ? BenchmarkCore.synthetic(data.options)
      : (() => { throw Error('Unsupported experiment.'); })();
    self.postMessage({result});
  } catch (e) { self.postMessage({error: e.message}); }
};
