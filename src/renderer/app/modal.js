export function showModal({ title, message, buttons }) {
  const modal = document.getElementById('permModal');
  document.getElementById('permTitle').textContent = title;
  document.getElementById('permMessage').textContent = message;
  const buttonContainer = document.getElementById('permBtns');
  buttonContainer.innerHTML = '';
  for (const { label, secondary, onClick } of buttons) {
    const button = document.createElement('button');
    button.textContent = label;
    if (secondary) button.classList.add('secondary');
    button.addEventListener('click', () => {
      modal.close();
      if (onClick) onClick();
    });
    buttonContainer.appendChild(button);
  }
  modal.showModal();
}
