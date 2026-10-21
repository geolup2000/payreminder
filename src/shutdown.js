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

module.exports = { coordinateShutdown };
