// Keep exclusive storage ownership until both HTTP requests and accepted
// background deliveries have stopped. A failed drain must not release the lock.
function coordinateShutdown(server, stopScheduler, releaseDataLock, onError = console.error) {
  let httpClosed = false;
  let closing;
  let draining;

  function drain() {
    if (!draining) {
      draining = Promise.resolve().then(stopScheduler).then(releaseDataLock).catch(error => {
        draining = undefined;
        throw error;
      });
    }
    return draining;
  }

  server.once('close', () => {
    httpClosed = true;
    drain().catch(onError);
  });

  return async function shutdown() {
    if (!httpClosed) {
      if (!closing) {
        closing = new Promise((resolve, reject) => {
          server.close(error => error ? reject(error) : resolve());
        });
      }
      await closing;
    }
    await drain();
  };
}

// Keep the process alive on drain failure so the lock is retained and a later
// signal can retry. Never let a second signal bypass the current drain.
function installShutdownSignals(shutdown, processRef = process, onError = console.error) {
  let running;
  let keepAlive;
  const handle = () => {
    if (running) return;
    keepAlive ||= setInterval(() => {}, 1000);
    running = Promise.resolve().then(shutdown).then(() => {
      cleanup();
      processRef.exit(0);
    }).catch(error => {
      running = undefined;
      onError(error);
    });
  };
  function cleanup() {
    clearInterval(keepAlive);
    keepAlive = undefined;
    processRef.removeListener('SIGINT', handle);
    processRef.removeListener('SIGTERM', handle);
  }
  processRef.on('SIGINT', handle);
  processRef.on('SIGTERM', handle);
  return cleanup;
}

module.exports = { coordinateShutdown, installShutdownSignals };
