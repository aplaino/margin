// Switch the theme gallery between light and dark, and copy the install command.
// Everything works without this script.

const row = document.querySelector('.theme-row');
for (const button of document.querySelectorAll('.switch button')) {
  button.addEventListener('click', () => {
    row.dataset.mode = button.dataset.mode;
    for (const other of document.querySelectorAll('.switch button'))
      other.classList.toggle('on', other === button);
  });
}

for (const button of document.querySelectorAll('[data-copy]')) {
  button.addEventListener('click', async () => {
    const text = document.getElementById(button.dataset.copy)?.textContent ?? '';
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = 'Copied';
      setTimeout(() => {
        button.textContent = 'Copy';
      }, 1600);
    } catch {
      getSelection()?.selectAllChildren(document.getElementById(button.dataset.copy));
    }
  });
}
