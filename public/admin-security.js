(() => {
  document.addEventListener('submit', (event) => {
    const form = event.target.closest('form[data-confirm]');
    if (!form) return;
    const english = document.documentElement.lang === 'en';
    const name = form.dataset.confirmName || '';
    const message = form.dataset.confirm === 'member'
      ? (english ? `Delete ${name}? Payment history will remain.` : `Ștergi pe ${name}? Istoricul platilor ramane.`)
      : (english ? `Delete service ${name}?` : `Ștergi serviciul ${name}?`);
    if (!window.confirm(message)) event.preventDefault();
  });
})();
