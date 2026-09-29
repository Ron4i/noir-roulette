export const $ = (id) => document.getElementById(id);

export function setIcon(el, name) {
  const use = el?.querySelector('use');
  if (use) use.setAttribute('href', `#i-${name}`);
}

let toastSeq = 0;

/** Короткое всплывающее уведомление в правом верхнем углу. */
export function toast(text, { tone = 'info', ms = 3600 } = {}) {
  const host = $('toasts');
  if (!host) return;
  const id = `toast-${(toastSeq += 1)}`;
  const node = document.createElement('div');
  node.className = `toast toast-${tone}`;
  node.id = id;
  node.setAttribute('role', 'status');
  node.textContent = text;
  host.append(node);
  setTimeout(() => {
    node.classList.add('toast-out');
    setTimeout(() => node.remove(), 260);
  }, ms);
}
