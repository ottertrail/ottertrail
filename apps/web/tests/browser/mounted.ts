/** Apps a test rendered; the shared afterEach (setup.ts) unmounts them. */
const unmounts: (() => void)[] = [];

export function trackMounted(unmount: () => void) {
  unmounts.push(unmount);
}

export function unmountAll() {
  for (const unmount of unmounts.splice(0)) {
    unmount();
  }
}
