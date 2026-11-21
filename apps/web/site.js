// Fade sections in as they scroll into view, count the token total up once, and switch
// the theme gallery between light and dark. Everything works without this script.

const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
document.documentElement.classList.add('js');

const shown = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add('shown');
      shown.unobserve(entry.target);
      if (entry.target.dataset.count) countUp(entry.target);
    }
  },
  { threshold: 0.15 },
);
for (const element of document.querySelectorAll('.reveal')) shown.observe(element);

function countUp(element) {
  const target = Number(element.dataset.count);
  const format = (n) => `${(Math.floor(n / 100_000) / 10).toFixed(1)}M`;
  if (reduced) return;
  const start = performance.now();
  const duration = 1400;
  const step = (now) => {
    const t = Math.min(1, (now - start) / duration);
    element.textContent = format(target * (1 - (1 - t) ** 3));
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

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
